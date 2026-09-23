// End-to-end check that a board full of embedded documents neither blanks out
// nor drops frames while it is panned and zoomed.
//
//   node scripts/run.cjs build && node scripts/e2e-embeds.mjs [outDir]
//
// An `html` card is a sandboxed srcdoc iframe. Chromium renders sandboxed frames
// out of process unless told otherwise, and a board of forty of them runs out of
// the budget for those: the ones that lose paint nothing. The app turns that
// isolation off, and on top of it each card covers itself with a still for the
// length of a gesture — this measures the result of both.
//
// Every card is painted one saturated colour on purpose, and what is counted is
// cards, not pixels: for each card wholly on screen, a patch of it is compared
// against that colour. A card that does not match has lost its content, whatever
// it lost it to — the iframe's white background, the board's dark surface behind
// a still that does not cover it, or a still cropped from the wrong place.
//
// Counting white pixels, which is what this did first, could only see one of
// those three and went quiet the moment the blank turned dark.
//
// Knobs for comparing strategies from outside the build:
//   ZMTKI_EMBED_ARGS   extra Chromium switches, e.g.
//                      --enable-features=IsolateSandboxedIframes
//   ZMTKI_EMBED_CSS    stylesheet injected before the board is filled
//   ZMTKI_EMBED_SHOTS  keep a screenshot of every sample
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || mkdtempSync(join(tmpdir(), 'zmtki-embeds-'));
mkdirSync(outDir, { recursive: true });

const CARDS = 42;
/** How many more are added later, having never been on screen. */
const FRESH = 12;
const CARD_CSS = '#c0392b';
const CARD_RGB = [192, 57, 43];

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, ZMTKI_E2E: '1', ZMTKI_DATA_DIR: mkdtempSync(join(tmpdir(), 'zmtki-embeds-data-')) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;

const extraArgs = (process.env.ZMTKI_EMBED_ARGS ?? '').split(' ').filter(Boolean);
const app = await _electron.launch({ executablePath: require('electron'), args: [appDir, ...extraArgs], env, cwd: appDir });
const page = await app.firstWindow();
page.on('crash', () => console.log('RENDERER CRASHED'));
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
await page.waitForSelector('.board-viewport', { timeout: 20000 });
await sleep(800);
const shot = (name) => page.screenshot({ path: join(outDir, name + '.png') });

if (process.env.ZMTKI_EMBED_CSS) await page.addStyleTag({ content: process.env.ZMTKI_EMBED_CSS });

const boardId = await page.evaluate(async () => (await window.zmtki.boards.list())[0].id);

/** A card as an agent writes one: a fragment, with no page of its own. */
const fragment = (label) =>
  '<div style="width:100%;height:100%;box-sizing:border-box;background:' +
  CARD_CSS +
  ';color:#fff;font:600 20px system-ui;display:flex;align-items:center;justify-content:center">' +
  label +
  '</div>';

const addCards = (count, atX, label) =>
  page.evaluate(
    async ({ id, count: n, atX: x0, markups }) => {
      for (let i = 0; i < n; i += 1) {
        await window.zmtki.artifacts.create(id, {
          type: 'html',
          x: x0 + (i % (x0 === 0 ? 7 : 3)) * 320,
          y: Math.floor(i / (x0 === 0 ? 7 : 3)) * 260,
          width: 290,
          height: 230,
          props: { html: markups[i] },
        });
      }
    },
    { id: boardId, count, atX, markups: Array.from({ length: count }, (_, i) => fragment(label + ' ' + (i + 1))) },
  );

await addCards(CARDS, 0, '#');
await page.waitForFunction((n) => document.querySelectorAll('.artifact.type-html').length >= n, CARDS, { timeout: 30000 });
check('the board holds every embedded document', (await page.locator('.artifact.type-html').count()) === CARDS);

await page.keyboard.press('f');
// Documents load, then the stills are taken once the board has been still.
await sleep(3500);
await shot('01-rest');

const box = await page.locator('.board-viewport').boundingBox();
const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

/**
 * Every card wholly on screen, checked against the colour it is supposed to be.
 *
 * The capture goes through the app's own screen channel, so these are the
 * composited pixels the user is looking at rather than anything the renderer
 * believes it drew. Cards hanging off an edge are skipped — they are clipped,
 * not blank — and so is anything under the zoom controls.
 */
let sampleSeq = 0;
let blankSeq = 0;
const sample = async () => {
  sampleSeq += 1;
  if (process.env.ZMTKI_EMBED_SHOTS) await shot('sample-' + String(sampleSeq).padStart(2, '0'));
  const result = await page.evaluate(async (rgb) => {
    const viewport = document.querySelector('.board-viewport');
    const scene = document.querySelector('.board-scene');
    const b = viewport.getBoundingClientRect();
    const rect = { x: b.left, y: b.top, width: b.width, height: b.height };
    // A capture is a round trip through the main process, and the board keeps
    // moving during it. If the transform changed, the pixels and the card
    // positions read afterwards describe two different moments, and every card
    // would look blank because the sample landed next to it. Such a sample is
    // thrown away rather than counted.
    const before = scene.style.transform;
    const url = await window.zmtki.screen.capture(rect);
    // Read here, not at the end: picking the pixels apart takes longer than the
    // gesture's own tail, and asking afterwards would report every sample as
    // taken at rest even when the capture caught the board mid-gesture.
    const moving = viewport.classList.contains('is-moving');
    if (!url) return null;
    if (scene.style.transform !== before) return { skipped: true };
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const scale = image.width / rect.width;
    const hud = document.querySelector('.hud')?.getBoundingClientRect();

    let visible = 0;
    const blank = [];
    for (const card of document.querySelectorAll('.artifact.type-html')) {
      const r = card.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) continue;
      if (r.left < rect.x || r.top < rect.y || r.right > rect.x + rect.width || r.bottom > rect.y + rect.height) continue;
      if (hud && r.left < hud.right && r.right > hud.left && r.top < hud.bottom && r.bottom > hud.top) continue;
      visible += 1;
      // A patch away from the middle, where these cards put their label.
      const px = Math.round((r.left + r.width * 0.22 - rect.x) * scale);
      const py = Math.round((r.top + r.height * 0.22 - rect.y) * scale);
      const size = Math.max(4, Math.round(8 * scale));
      const data = context.getImageData(px, py, size, size).data;
      let match = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i] - rgb[0]) < 45 && Math.abs(data[i + 1] - rgb[1]) < 45 && Math.abs(data[i + 2] - rgb[2]) < 45) {
          match += 1;
        }
      }
      if (match < (data.length / 4) * 0.6) {
        const middle = context.getImageData(px + (size >> 1), py + (size >> 1), 1, 1).data;
        // What was actually on top of that card at that moment: which layer is
        // showing decides whether this is a still that does not cover, an
        // iframe that has not painted, or a card drawn reduced.
        const surface = card.querySelector('.artifact-html-surface');
        const frame = card.querySelector('.artifact-frame');
        const still = card.querySelector('.embed-still');
        blank.push(
          card.getAttribute('data-artifact-id') +
            ' rgb(' + middle[0] + ',' + middle[1] + ',' + middle[2] + ')' +
            ' still=' + (surface?.classList.contains('has-still') ? still?.width + 'x' + still?.height : 'none') +
            ' stillOpacity=' + (still ? getComputedStyle(still).opacity : '-') +
            ' frame=' + (frame ? getComputedStyle(frame).visibility : 'absent') +
            ' reduced=' + card.classList.contains('is-reduced') +
            ' cardSize=' + Math.round(r.width) + 'x' + Math.round(r.height),
        );
      }
    }
    if (scene.style.transform !== before) return { skipped: true };
    return {
      visible,
      blank,
      moving,
      stills: document.querySelectorAll('.artifact-html-surface.has-still').length,
      surfaces: document.querySelectorAll('.artifact-html-surface').length,
      detail: viewport.querySelector('.hud-info')?.textContent?.trim() ?? '',
    };
  }, CARD_RGB);
  // The frame a blank was seen in is worth far more than the number: it says
  // which cards, at what zoom, and whether the board was in overview.
  if (process.env.ZMTKI_EMBED_SHOTS && result && !result.skipped) {
    console.log(
      '  [sample ' + sampleSeq + '] stills ' + result.stills + '/' + result.surfaces +
        ', blank ' + result.blank.length + '/' + result.visible + ', ' + result.detail,
    );
  }
  if (result && result.blank && result.blank.length > 0) {
    await shot('blank-' + String(++blankSeq).padStart(2, '0'));
    console.log('  [blank] sample ' + sampleSeq + ': ' + result.blank.length + ' of ' + result.visible + ' — ' + result.detail);
  }
  return result;
};

/** Worst moment over a set of samples: how many cards were blank at once. */
const worst = (samples) => {
  const taken = samples.filter((s) => s && !s.skipped);
  const skipped = samples.length - taken.length;
  if (taken.length === 0) return { blank: -1, visible: 0, usable: 0, detail: 'no usable sample of ' + samples.length };
  const bad = taken.reduce((a, b) => (b.blank.length > a.blank.length ? b : a));
  const moving = taken.filter((s) => s.moving).length;
  return {
    blank: bad.blank.length,
    visible: bad.visible,
    usable: taken.length,
    detail:
      bad.blank.length +
      ' of ' +
      bad.visible +
      ' cards blank' +
      (bad.blank.length ? ': ' + bad.blank.slice(0, 4).join(', ') : '') +
      ' [' +
      taken.length +
      ' usable samples, ' +
      moving +
      ' mid-gesture, ' +
      skipped +
      ' discarded]',
  };
};

const atRest = worst([await sample()]);
check('every document on screen is painted when the board is still', atRest.blank === 0 && atRest.visible > 10, atRest.detail);

// --- Blanks, then frame gaps, over the same gestures --------------------------

/** Longest gap between animation frames, i.e. how long the thread was blocked. */
const watchFrames = () =>
  page.evaluate(() => {
    window.__gaps = { worst: 0, over32: 0, frames: 0 };
    let last = performance.now();
    const tick = (t) => {
      const gap = t - last;
      last = t;
      window.__gaps.frames += 1;
      if (gap > window.__gaps.worst) window.__gaps.worst = gap;
      if (gap > 32) window.__gaps.over32 += 1;
      window.__raf = requestAnimationFrame(tick);
    };
    window.__raf = requestAnimationFrame(tick);
  });
const stopFrames = () =>
  page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    return window.__gaps;
  });

const zoom = async (sampling) => {
  const samples = [];
  await page.mouse.move(centre.x, centre.y);
  await page.keyboard.down('Control');
  for (let i = 0; i < 10; i += 1) {
    // Two sizes of step, because the board treats them differently. A wheel
    // notch is eased in over about a tenth of a second, so a sample taken
    // during one can never line up with the pixels and is always discarded;
    // a trackpad-sized step is applied on the next frame and then holds still,
    // which is the only way to look at the board while a gesture is on.
    const step = sampling ? 20 : 120;
    await page.mouse.wheel(0, i < 5 ? step : -step);
    if (sampling) {
      await sleep(25);
      samples.push(await sample());
    } else {
      await sleep(40);
    }
  }
  await page.keyboard.up('Control');
  if (sampling) samples.push(await sample());
  return samples;
};

const pan = async (sampling, steps = 12, step = 34) => {
  const samples = [];
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(centre.x - i * step, centre.y - i * 12);
    if (sampling && i % 3 === 0) samples.push(await sample());
  }
  await page.mouse.up();
  if (sampling) samples.push(await sample());
  return samples;
};

// Reading a megapixel of image data per sample costs more main-thread time than
// anything being measured, so the blanks and the frame gaps are collected over
// separate passes of the same gesture rather than one polluted pass.
const zoomBlanks = worst(await zoom(true));
await shot('02-zoom');
await sleep(1600);
await watchFrames();
await zoom(false);
const zoomGaps = await stopFrames();
await sleep(1600);

check('zooming never blanks a document', zoomBlanks.blank === 0, zoomBlanks.detail);
check(
  'zooming keeps the frame rate',
  zoomGaps.worst < 200 && zoomGaps.over32 * 4 < zoomGaps.frames,
  'worst frame ' + Math.round(zoomGaps.worst) + ' ms, ' + zoomGaps.over32 + ' of ' + zoomGaps.frames + ' frames over 32 ms',
);

const panBlanks = worst(await pan(true));
await shot('03-pan');
await sleep(1600);
await watchFrames();
await pan(false);
const panGaps = await stopFrames();
await sleep(1600);

check('panning never blanks a document', panBlanks.blank === 0, panBlanks.detail);
check(
  'panning keeps the frame rate',
  panGaps.worst < 200 && panGaps.over32 * 4 < panGaps.frames,
  'worst frame ' + Math.round(panGaps.worst) + ' ms, ' + panGaps.over32 + ' of ' + panGaps.frames + ' frames over 32 ms',
);

// --- Cards the board has never shown before ------------------------------------

// The cards above were all on screen when the stills were taken, which is the
// easy half. What a person actually does is pan onto part of the board they have
// not looked at yet: those cards have no still, because a still is cropped out
// of a picture of the window and they were never in it.
// Fitted first, so where the board sits is known, and the new cards are put
// just beyond its right edge: on the board, never yet on screen.
await page.keyboard.press('f');
await sleep(2500);
await addCards(FRESH, 2900, 'fresh');
await sleep(2500);

const freshBlanks = worst(await pan(true, 18, 55));
await shot('04-fresh');
await sleep(1800);
check(
  'panning onto cards never shown before does not blank them',
  freshBlanks.blank === 0 && freshBlanks.visible > 3,
  freshBlanks.detail,
);

// --- And everything is live again once it stops --------------------------------

await page.keyboard.press('f');
await sleep(2600);
const after = worst([await sample()]);
check('the documents are live again once the board settles', after.blank === 0 && after.visible > 3, after.detail);
check(
  'every document is still mounted and none was rebuilt',
  (await page.locator('.artifact.type-html').count()) === CARDS + FRESH,
);
// --- A card that rounds itself more than the board rounds its cards ------------

// Nothing of the board may show in the gap. A sandboxed frame has an opaque
// origin and Chromium composites one over a white base background of its own,
// so a page left transparent showed pure white there; the board's own plate and
// border showed as a pale edge in the same place.
await page.evaluate(async (id) => {
  await window.zmtki.artifacts.create(id, {
    type: 'html',
    x: -900,
    y: 0,
    width: 420,
    height: 320,
    props: {
      html:
        '<div style="box-sizing:border-box;width:100%;height:100%;overflow:hidden;border-radius:24px;' +
        'background:#0b1020;color:#fff;border:2px solid #ff5b6455"><div style="padding:16px">rounded</div></div>',
    },
  });
}, boardId);
// Flown to rather than fitted: fitting a board this wide leaves the card a few
// pixels across, and a corner is not a thing you can measure on that.
await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent('zmtki:focus-rect', { detail: { x: -900, y: 0, width: 420, height: 320 } }));
});
await sleep(3000);

const corner = await page.evaluate(async () => {
  const viewport = document.querySelector('.board-viewport');
  const b = viewport.getBoundingClientRect();
  const rect = { x: b.left, y: b.top, width: b.width, height: b.height };
  const url = await window.zmtki.screen.capture(rect);
  if (!url) return null;
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const scale = image.width / rect.width;
  const card = [...document.querySelectorAll('.artifact.type-html')].find((el) =>
    (el.querySelector('.artifact-frame')?.getAttribute('srcdoc') ?? '').includes('rounded'),
  );
  if (!card) return null;
  const r = card.getBoundingClientRect();
  if (r.width < 200 || r.left < rect.x || r.top < rect.y) return { tooSmall: Math.round(r.width) };
  const at = (dx, dy) => {
    const d = context.getImageData(Math.round((r.left + dx - rect.x) * scale), Math.round((r.top + dy - rect.y) * scale), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const board = getComputedStyle(viewport).backgroundColor.match(/\d+/g).map(Number);
  return { corner: at(4, 4), board: board.slice(0, 3) };
});

check(
  'a card that rounds itself shows the board in the gap, not a plate',
  corner !== null && corner.corner != null && corner.corner.every((v, i) => Math.abs(v - corner.board[i]) < 8),
  corner?.corner
    ? 'corner rgb(' + corner.corner.join(',') + ') vs board rgb(' + corner.board.join(',') + ')'
    : 'card too small to measure: ' + JSON.stringify(corner),
);

await shot('05-final');

await app.close();
const failed = results.filter((r) => !r.ok).length;
console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
console.log('Screenshots: ' + outDir);
process.exit(failed ? 1 : 0);
