// Regression check: local HTML cards cover themselves with their last painted
// image for every frame of a camera gesture instead of exposing Chromium's
// blank iframe frame, and hand the live document back once the board settles.
//
// This is the structural half of the guarantee — which elements are shown and
// hidden, and whether the stills actually have a picture in them. The pixel
// half, which counts how much of the board goes white mid-gesture and what that
// costs in frames, is scripts/e2e-embeds.mjs.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, ZMTKI_E2E: '1', ZMTKI_DATA_DIR: mkdtempSync(join(tmpdir(), 'zmtki-html-freeze-')) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;

const app = await _electron.launch({ executablePath: require('electron'), args: [appDir], env, cwd: appDir });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.board-viewport', { timeout: 20_000 });
  const artifacts = await page.evaluate(async () => {
    const boardId = (await window.zmtki.boards.list())[0].id;
    return Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        window.zmtki.artifacts.create(boardId, {
          type: 'html',
          x: (index % 6) * 560,
          y: Math.floor(index / 6) * 380,
          width: 480,
          height: 300,
          props: {
            html: `<!doctype html><style>html,body{margin:0;height:100%;background:hsl(${index * 31} 60% 28%);color:#fff;font:700 52px sans-serif;display:grid;place-items:center}body{border:28px solid hsl(${index * 31 + 80} 78% 55%);box-sizing:border-box}</style><body>FROZEN ${index + 1}</body>`,
          },
        }),
      ),
    );
  });
  await page.waitForFunction((count) => document.querySelectorAll('.artifact-html-surface').length === count, artifacts.length);
  await page.keyboard.press('f');

  // A still is taken once the board has been still long enough for the
  // documents to have painted; the surface is marked when one has been drawn.
  await page.waitForFunction(
    (count) => document.querySelectorAll('.artifact-html-surface.has-still').length === count,
    artifacts.length,
    { timeout: 25_000 },
  );

  const stills = page.locator('.artifact-html-surface .embed-still');
  const primedAtRest = await stills.evaluateAll((canvases) =>
    canvases.every((canvas) => {
      const style = getComputedStyle(canvas);
      const frame = canvas.closest('.artifact-html-surface').querySelector('.artifact-frame');
      // Kept in the paint tree and transparent, so the frame it is needed in is
      // not the frame its layer has to be allocated in.
      return (
        style.display === 'block' &&
        Number.parseFloat(style.opacity) < 0.01 &&
        canvas.width > 0 &&
        getComputedStyle(frame).visibility === 'visible'
      );
    }),
  );
  if (!primedAtRest) throw new Error('HTML stills were not kept primed while the board was at rest');

  /** Every still has a picture in it rather than a blank rectangle. */
  const coloured = await stills.evaluateAll((canvases) =>
    canvases.map((canvas) => {
      const context = canvas.getContext('2d');
      const width = Math.min(48, canvas.width);
      const height = Math.min(48, canvas.height);
      const pixels = context.getImageData((canvas.width - width) >> 1, (canvas.height - height) >> 1, width, height).data;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] > 0 && (pixels[i] < 235 || pixels[i + 1] < 235 || pixels[i + 2] < 235)) count += 1;
      }
      return count;
    }),
  );
  if (coloured.some((count) => count < 100)) throw new Error(`Blank HTML stills: ${JSON.stringify(coloured)}`);

  const covered = () =>
    stills.evaluateAll((canvases) =>
      canvases.every((canvas) => {
        const surface = canvas.closest('.artifact-html-surface');
        return (
          Number.parseFloat(getComputedStyle(canvas).opacity) > 0.99 &&
          getComputedStyle(surface.querySelector('.artifact-frame')).visibility === 'hidden'
        );
      }),
    );

  const viewport = page.locator('.board-viewport');
  const box = await viewport.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -500);
  await page.waitForSelector('.board-viewport.is-moving');
  if (!(await covered())) throw new Error('HTML cards were not covered during a zoom');

  // Once the board stops, the cover is handed back to the live document: the
  // hold and the fade are a CSS transition, so this is simply a matter of time.
  await page.waitForFunction(() => !document.querySelector('.board-viewport.is-moving'), null, { timeout: 5000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.artifact-html-surface .embed-still')].every(
        (canvas) => Number.parseFloat(getComputedStyle(canvas).opacity) < 0.01,
      ),
    null,
    { timeout: 5000 },
  );
  const liveAgain = await stills.evaluateAll((canvases) =>
    canvases.every(
      (canvas) =>
        getComputedStyle(canvas.closest('.artifact-html-surface').querySelector('.artifact-frame')).visibility === 'visible',
    ),
  );
  if (!liveAgain) throw new Error('Live iframes were not handed back after the board settled');

  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(box.x + 150, box.y + 100, { steps: 4 });
  await page.waitForSelector('.board-viewport.is-moving');
  const frozenDuringPan = await covered();
  await page.mouse.up({ button: 'middle' });
  if (!frozenDuringPan) throw new Error('HTML stills were not held throughout panning');

  console.log(`PASS all ${artifacts.length} HTML cards keep rendered stills throughout zoom and pan`);
} finally {
  await app.close();
}
