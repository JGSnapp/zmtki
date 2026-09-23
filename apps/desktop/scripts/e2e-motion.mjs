// End-to-end check of iteration 2 in the real Electron app.
//
//   node scripts/run.cjs build && node scripts/e2e-motion.mjs [outDir]
//
// Drives the window the way a user does (drag from the menu, fling the board)
// and acts as an agent through the real MCP server (move near, move far,
// delete), sampling the DOM mid-animation and saving screenshots of each step.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || mkdtempSync(join(tmpdir(), 'zmtki-e2e-'));
mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const env = { ...process.env, ZMTKI_E2E: '1', ZMTKI_DATA_DIR: mkdtempSync(join(tmpdir(), 'zmtki-e2e-data-')) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;

const app = await _electron.launch({ executablePath: require('electron'), args: [appDir], env, cwd: appDir });
const page = await app.firstWindow();
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('[renderer error] ' + msg.text());
});
await page.setViewportSize({ width: 1500, height: 900 }).catch(() => undefined);
await page.waitForSelector('.board-viewport', { timeout: 20000 });
await sleep(800);
const shot = (name) => page.screenshot({ path: join(outDir, name + '.png') });

const viewportBox = await page.locator('.board-viewport').boundingBox();
const center = { x: viewportBox.x + viewportBox.width / 2, y: viewportBox.y + viewportBox.height / 2 };
const count = () => page.locator('.board-scene > .artifact:not(.artifact-ghost)').count();

// --- 1. Drag a block out of the menu -----------------------------------------
await shot('01-empty-board');
await page.click('text=+ Блок');
await sleep(250);
const item = page.locator('.menu-item--block', { hasText: 'Заметка' }).first();
const itemBox = await item.boundingBox();
await page.mouse.move(itemBox.x + 20, itemBox.y + 10);
await page.mouse.down();
for (let i = 1; i <= 12; i += 1) {
  await page.mouse.move(itemBox.x + 20 + ((center.x - itemBox.x - 20) * i) / 12, itemBox.y + 10 + ((center.y - itemBox.y - 10) * i) / 12);
  await sleep(16);
}
await sleep(120);
check('drag from menu shows where the block will land', (await page.locator('.placement-ghost').count()) === 1);
await shot('02-dragging-block');
await page.mouse.up();
await sleep(120);
check('drop creates the block', (await count()) === 1);
check('dropped block plays its appear animation', (await page.locator('.artifact.is-entering').count()) === 1);
await sleep(500);

// A second drop onto the first must not overlap it.
await page.click('text=+ Блок');
await sleep(200);
const item2 = await page.locator('.menu-item--block', { hasText: 'Заметка' }).first().boundingBox();
await page.mouse.move(item2.x + 20, item2.y + 10);
await page.mouse.down();
await page.mouse.move(center.x - 100, center.y);
await page.mouse.move(center.x, center.y, { steps: 6 });
await sleep(100);
await page.mouse.up();
await sleep(600);
const rects = await page.$$eval('.board-scene > .artifact:not(.artifact-ghost)', (els) =>
  els.map((el) => {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform);
    return { x: Number(m[1]), y: Number(m[2]), w: el.offsetWidth, h: el.offsetHeight };
  }),
);
const overlap =
  rects.length === 2 &&
  rects[0].x < rects[1].x + rects[1].w &&
  rects[0].x + rects[0].w > rects[1].x &&
  rects[0].y < rects[1].y + rects[1].h &&
  rects[0].y + rects[0].h > rects[1].y;
check('second block dropped onto the first lands beside it', rects.length === 2 && !overlap, JSON.stringify(rects));
await shot('03-two-blocks');

// --- 2. Act as an agent over MCP ---------------------------------------------
const boardId = await page.evaluate(async () => (await window.zmtki.boards.list())[0].id);
const endpoint = await app.evaluate((_electron, id) => globalThis.__zmtki.mcp.bind('e2e-agent', id), boardId);
const client = new Client({ name: 'e2e-agent', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(result.content[0].text);
};
const region = await call('board_get_region', {});
const [a, b] = region.artifacts;
await call('arrow_create', { fromId: a.id, toId: b.id });
await sleep(500);
await shot('04-agent-arrow');

const positionOf = (id) =>
  page.$eval('[data-artifact-id="' + id + '"]', (el) => {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform);
    return { x: Number(m[1]), y: Number(m[2]) };
  });

// Short move: slides, and its arrow goes with it.
const startPos = await positionOf(b.id);
const arrowPath = () => page.$eval('.arrow path:nth-of-type(2)', (el) => el.getAttribute('d'));
const pathBefore = await arrowPath();
const moved = await call('artifact_move', { id: b.id, x: b.x - 200, y: b.y - 140 });
if (moved.status === 'refused' || moved.refused) console.log('move refused: ' + JSON.stringify(moved).slice(0, 300));
const samples = [];
for (let i = 0; i < 8; i += 1) {
  await sleep(45);
  samples.push(await positionOf(b.id));
}
const intermediate = samples.filter((p) => p.x < startPos.x - 2 && p.x > b.x - 198);
check('agent short move slides through intermediate positions', intermediate.length >= 2, JSON.stringify(samples.map((p) => Math.round(p.x))));
await page.waitForTimeout(80);
await shot('05-agent-sliding');
await sleep(700);
const pathAfter = await arrowPath();
check('arrow followed the slide', pathAfter !== pathBefore);
const endPos = await positionOf(b.id);
check('slide ends exactly on the new position', Math.abs(endPos.x - (b.x - 200)) < 1 && Math.abs(endPos.y - (b.y - 140)) < 1, JSON.stringify(endPos));

// Long move: fades out here, appears there.
await call('artifact_move', { id: a.id, x: a.x + 9000, y: a.y + 4000 });
await sleep(60);
check('agent long move leaves a fading ghost behind', (await page.locator('.artifact-ghost.ghost-teleport').count()) === 1);
await shot('06-agent-teleport');
await sleep(600);
check('teleport ghost is cleaned up', (await page.locator('.artifact-ghost').count()) === 0);

// Delete: shrinks away with a ring. F right after toolbar clicks: shortcuts must not be swallowed by a focused button.
const zoomBeforeFit = await page.$eval('.board-scene', (el) => el.style.transform);
await page.keyboard.press('f');
await sleep(700);
check('F fits the board even after a toolbar button was clicked', (await page.$eval('.board-scene', (el) => el.style.transform)) !== zoomBeforeFit);
const victim = (await call('board_get_region', {})).artifacts.find((x) => x.id === b.id);
await call('artifact_delete', { id: victim.id });
await sleep(140);
const exiting = await page.locator('.artifact-ghost.ghost-exit').count();
check('agent delete plays an exit animation', exiting === 1);
check('exit animation has its ring', (await page.locator('.artifact-ghost .poof').count()) === 1);
await shot('07-agent-delete');
await sleep(700);
check('exit ghost is gone after the animation', (await page.locator('.artifact-ghost').count()) === 0);

// Off-screen change while the user looks elsewhere: applied, not animated.
await call('artifact_create', { type: 'note', x: 60000, y: 60000 });
await sleep(60);
check('change outside the view is not animated', (await page.locator('.artifact.is-entering').count()) === 0);

// --- 3. Fling the board -------------------------------------------------------
const sceneX = () =>
  page.$eval('.board-scene', (el) => Number(/translate\(([-\d.]+)px/.exec(el.style.transform)[1]));
await page.keyboard.press('Escape');
const flingY = viewportBox.y + 60;
await page.mouse.move(viewportBox.x + 200, flingY);
await page.mouse.down();
const moveTimes = [];
for (let i = 1; i <= 8; i += 1) {
  const t0 = Date.now();
  await page.mouse.move(viewportBox.x + 200 + i * 45, flingY);
  moveTimes.push(Date.now() - t0);
}
const panning = await page.locator('.board-viewport.is-panning').count();
const tUp = Date.now();
await page.mouse.up();
console.log('mouse.move latency ms: ' + moveTimes.join(',') + '; up ' + (Date.now() - tUp) + '; panning=' + panning);
const atRelease = await sceneX();
await sleep(250);
const afterGlide = await sceneX();
check('released pan keeps gliding with inertia', afterGlide - atRelease > 30, 'glided ' + Math.round(afterGlide - atRelease) + 'px');
await sleep(1400);
const settled = await sceneX();
await sleep(200);
check('inertia comes to rest', Math.abs((await sceneX()) - settled) < 1);

// --- 4. User drag settles onto the grid smoothly, undo animates ---------------
for (const art of (await call('board_get_region', {})).artifacts) {
  if (art.x > 5000) await call('artifact_delete', { id: art.id });
}
await call('artifact_create', { type: 'note', x: 0, y: 0, props: { text: 'Перетащи меня' } });
await sleep(300);
await page.keyboard.press('f');
await sleep(800);
const card = page.locator('.board-scene > .artifact:not(.artifact-ghost)').first();
const cardId = await card.getAttribute('data-artifact-id');
const cardBox = await card.boundingBox();
await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
await page.mouse.down();
await page.mouse.move(cardBox.x + cardBox.width / 2 + 23, cardBox.y + cardBox.height / 2 + 17, { steps: 5 });
await sleep(60);
check('held card lifts while dragged', (await page.locator('.artifact.is-dragging').count()) === 1);
await page.mouse.up();
const snapSamples = [];
for (let i = 0; i < 6; i += 1) {
  snapSamples.push(await positionOf(cardId));
  await sleep(40);
}
await sleep(400);
const snapped = await positionOf(cardId);
check('dropped card ends on the 20px grid', snapped.x % 20 === 0 && snapped.y % 20 === 0, JSON.stringify(snapped));
const distinct = new Set(snapSamples.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1))).size;
check('drop eases onto the grid instead of jumping', distinct >= 2 || (snapSamples[0].x === snapped.x && snapSamples[0].y === snapped.y), JSON.stringify(snapSamples));

// A cancelled pointer mid-drag (Chromium taking the gesture for a native drag,
// a page stealing the capture) reports (0, 0): the card must stay where it was
// carried, not jump to the window's corner.
{
  const box = await card.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 6 });
  await sleep(60);
  await page.dispatchEvent('.board-viewport', 'pointercancel', { clientX: 0, clientY: 0, pointerId: 1, bubbles: true });
  await page.mouse.up();
  await sleep(500);
  const at = await positionOf(cardId);
  const zoomNow = await page.$eval('.board-scene', (el) => Number(/scale\(([-\d.]+)\)/.exec(el.style.transform)[1]));
  const expected = { x: snapped.x + 60 / zoomNow, y: snapped.y + 40 / zoomNow };
  check('pointercancel mid-drag keeps the card where it was carried', Math.abs(at.x - expected.x) < 30 && Math.abs(at.y - expected.y) < 30, JSON.stringify({ at, expected }));
}

await page.keyboard.press('Delete');
await sleep(100);
check('user delete also plays the exit animation', (await page.locator('.artifact-ghost.ghost-exit').count()) === 1);
await sleep(700);
await page.keyboard.press('Control+z');
await sleep(80);
check('undo brings the card back with its appear animation', (await page.locator('.artifact.is-entering').count()) === 1);
await sleep(500);

// --- 5. Terminal stays crisp and exact at 200% ---------------------------------
const panel = await page.locator('.harness[data-harness="shell"]').first().boundingBox();
await page.mouse.move(panel.x + 30, panel.y + 15);
await page.mouse.down();
await page.mouse.move(center.x, center.y + 150, { steps: 10 });
await sleep(80);
await page.mouse.up();
await page.waitForSelector('.terminal-scaled .xterm', { timeout: 10000 });
await sleep(1500);
const termEl = page.locator('.artifact.type-terminal').first();
const termId = await termEl.getAttribute('data-artifact-id');
const termRect = await page.evaluate(async (id) => {
  const boards = await window.zmtki.boards.list();
  const board = await window.zmtki.boards.get(boards[0].id);
  const t = board.state.artifacts.find((a) => a.id === id);
  return { x: t.x, y: t.y, width: t.width, height: t.height };
}, termId);
await page.evaluate((rect) => window.dispatchEvent(new CustomEvent('zmtki:focus-rect', { detail: rect })), termRect);
await sleep(800);
const tb = await termEl.boundingBox();
await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
await page.keyboard.type('echo zmtki: crisp text at any zoom');
await page.keyboard.press('Enter');
await sleep(600);
const termFontBefore = await page.$eval('.terminal-scaled', (el) =>
  getComputedStyle(el.querySelector('.xterm-rows') ?? el).fontSize,
);
await page.mouse.move(tb.x + 60, tb.y + 80);
await page.keyboard.down('Control');
for (let i = 0; i < 4; i += 1) {
  await page.mouse.wheel(0, -100);
  await sleep(90);
}
await page.keyboard.up('Control');
await sleep(900);
const sceneZoom = await page.$eval('.board-scene', (el) => Number(/scale\(([-\d.]+)\)/.exec(el.style.transform)[1]));
// A zoom must leave the terminal alone: the board scales it like any card, and
// nothing inside is re-laid — that blink and change of size is what the card
// used to do after every gesture.
const termAfter = await page.$eval('.terminal-scaled', (el) => ({
  transform: el.style.transform,
  font: getComputedStyle(el.querySelector('.xterm-rows') ?? el).fontSize,
}));
check(
  'zoom does not re-lay the terminal',
  termAfter.transform === '' && termAfter.font === termFontBefore,
  'zoom ' + sceneZoom.toFixed(2) + ', font ' + termFontBefore + ' → ' + termAfter.font,
);
await shot('08-terminal-zoomed');

await page.keyboard.press('f');
await sleep(900);
await shot('09-final');
await client.close();
await app.close();

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed. Screenshots: ' + outDir);
process.exit(failed.length ? 1 : 0);
