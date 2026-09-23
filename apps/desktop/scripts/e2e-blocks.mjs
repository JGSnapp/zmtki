// End-to-end check of the blocks in the real Electron app.
//
//   node scripts/run.cjs build && node scripts/e2e-blocks.mjs [outDir]
//
// Chrome card: frames arrive, the address bar navigates, the card remembers
// the page, and dragging the card moves it by the pointer — not to a corner.
// App stream: a window is picked and plays. Editors: a file on disk is shown,
// edited and saved. Media and file cards read from disk.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || mkdtempSync(join(tmpdir(), 'zmtki-blocks-'));
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'zmtki-blocks-files-'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 20000, step = 250) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // keep waiting
    }
    await sleep(step);
  }
  return null;
};

const env = { ...process.env, ZMTKI_E2E: '1', ZMTKI_DATA_DIR: mkdtempSync(join(tmpdir(), 'zmtki-blocks-data-')) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;

const app = await _electron.launch({ executablePath: require('electron'), args: [appDir], env, cwd: appDir });
app.process().stdout.on('data', (d) => {
  const text = String(d);
  if (/\[renderer\]|gone|crash/i.test(text)) process.stdout.write('[main] ' + text);
});
const page = await app.firstWindow();
page.on('crash', () => console.log('RENDERER CRASHED'));
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
page.on('console', (msg) => {
  if (msg.type() === 'error' && !/ERR_FILE_NOT_FOUND|logo\.png/.test(msg.text())) console.log('[renderer error] ' + msg.text());
});
await page.waitForSelector('.board-viewport', { timeout: 20000 });
await sleep(800);
const shot = (name) => page.screenshot({ path: join(outDir, name + '.png') });
const vp = await page.locator('.board-viewport').boundingBox();
const center = { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 };

const boardId = await page.evaluate(async () => (await window.zmtki.boards.list())[0].id);
const board = () => page.evaluate(async (id) => window.zmtki.boards.get(id), boardId);

const dragFromMenu = async (label, to) => {
  await page.click('text=+ Блок');
  await sleep(250);
  const item = await page.locator('.menu-item--block', { hasText: label }).first().boundingBox();
  await page.mouse.move(item.x + 20, item.y + 10);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await sleep(120);
  await page.mouse.up();
  await sleep(400);
};

// --- 1. Google Chrome ---------------------------------------------------------
await page.keyboard.press('0');
await dragFromMenu('Браузер', { x: center.x - 120, y: center.y });
const browserCard = page.locator('.artifact.type-browser').first();
check('browser card created', (await browserCard.count()) === 1);
const firstFrame = await waitFor(() => page.locator('.browser-loading').count().then((n) => n === 0), 30000);
check('Chrome frames arrive in the card', !!firstFrame);
const address = await waitFor(() => page.$eval('.browser-address input', (el) => (el.value.includes('google') ? el.value : '')), 15000);
check('the tab opens Google', !!address, address || '');
await sleep(1500);
await shot('01-chrome-google');

const pixels = await page.$eval('.browser-surface', (canvas) => {
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let nonWhite = 0;
  for (let i = 0; i < data.length; i += 400) if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) nonWhite += 1;
  return { w: canvas.width, h: canvas.height, nonWhite };
});
check('the frame shows a rendered page', pixels.w > 200 && pixels.nonWhite > 20, JSON.stringify(pixels));

// Navigate through the address bar.
await page.locator('.browser-address input').click();
await page.keyboard.type('example.com');
await page.keyboard.press('Enter');
const navigated = await waitFor(() => page.$eval('.browser-address input', (el) => el.value.includes('example.com')), 20000);
check('address bar navigates the tab', !!navigated);
const persisted = await waitFor(async () => {
  const b = await board();
  const card = b.state.artifacts.find((a) => a.type === 'browser');
  return card && String(card.props.url).includes('example.com');
}, 10000);
check('the card remembers the page it is on', !!persisted);
await sleep(1200);
await shot('02-chrome-example');

// Clicking a link inside the page (example.com has one) is input going through.
const cardBox = await browserCard.boundingBox();
await page.mouse.click(cardBox.x + cardBox.width / 2, cardBox.y + 40 + (cardBox.height - 40) / 2);
await sleep(200);
const surface = await page.locator('.browser-surface').boundingBox();
// Link on example.com sits under the paragraph; click around the lower middle of the text block.
const clicked = await page.evaluate(() => document.activeElement?.classList.contains('browser-surface'));
check('clicking the page focuses the Chrome surface', !!clicked);

// Drag the selected browser card by its bar: it must follow the pointer.
const before = await browserCard.evaluate((el) => el.style.transform);
const bar = await page.locator('.browser-card .chrome-badge').boundingBox();
await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
await page.mouse.down();
await page.mouse.move(bar.x + bar.width / 2 + 160, bar.y + bar.height / 2 + 90, { steps: 15 });
await sleep(80);
await page.mouse.up();
await sleep(500);
const after = await browserCard.evaluate((el) => el.style.transform);
const parse = (t) => {
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(t);
  return { x: Number(m[1]), y: Number(m[2]) };
};
const moved = { x: parse(after).x - parse(before).x, y: parse(after).y - parse(before).y };
check('dragged browser card follows the pointer', Math.abs(moved.x - 160) <= 20 && Math.abs(moved.y - 90) <= 20, JSON.stringify(moved));
void surface;

// --- 2. App stream -----------------------------------------------------------
await page.keyboard.press('Escape');
await dragFromMenu('Стрим приложения', { x: center.x + 380, y: center.y - 200 });
const tiles = await waitFor(() => page.locator('.source-tile').count(), 15000);
check('app stream lists windows and screens', tiles > 0, tiles + ' sources');
{
  const b = await board();
  const stream = b.state.artifacts.find((a) => a.type === 'app-stream');
  await page.evaluate((r) => window.dispatchEvent(new CustomEvent('zmtki:focus-rect', { detail: { x: r.x, y: r.y, width: r.width, height: r.height } })), stream);
  await sleep(1000);
}
await shot('03-stream-picker');
const screenTile = page.locator('.source-tile', { hasText: '🖥' }).first();
await ((await screenTile.count()) ? screenTile : page.locator('.source-tile').first()).click();
const playing = await waitFor(() => page.$eval('.stream-video', (v) => v.videoWidth > 0 && !v.paused), 15000);
check('picked source plays live in the card', !!playing);
await sleep(800);
await shot('04-stream-live');
console.log('health after stream: toolbar=' + (await page.locator('.toolbar').count()));

// --- 3. Files, editors, media over MCP ---------------------------------------
const endpoint = await app.evaluate((_e, id) => globalThis.__zmtki.mcp.bind('e2e-blocks', id), boardId);
const client = new Client({ name: 'e2e-blocks', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const codePath = join(work, 'hello.ts');
writeFileSync(codePath, 'export const greet = (name: string) => `hi ${name}`;\n', 'utf8');
const editor = await call('artifact_create', { type: 'code-editor', x: -900, y: 500, props: { path: codePath } });
const focusOn = async (a) => {
  await page.evaluate((r) => window.dispatchEvent(new CustomEvent('zmtki:focus-rect', { detail: { x: r.x, y: r.y, width: r.width, height: r.height } })), a);
  await sleep(1000);
};

// A native guest surface is unstable below a continuously transformed parent.
// Its decoded still must cover motion, while the guest itself stays mounted and
// visible: hiding a guest for the length of a gesture makes Chromium let go of
// the surface it would then have to build again, which is the white frame the
// still exists to prevent.
const webview = await call('artifact_create', { type: 'webview', x: -200, y: 600, props: { url: 'https://example.com' } });
await page.keyboard.press('Escape');
await focusOn(webview);
const buffered = await waitFor(
  () => page.locator('[data-artifact-id="' + webview.id + '"] .artifact-webview-surface .embed-still').count(),
  20000,
);
check('WebView prepares a stable frame before motion', !!buffered);
if (buffered) {
  await page.$eval('[data-artifact-id="' + webview.id + '"] webview', (el) => { el.dataset.e2eIdentity = 'kept'; });
  // By what it does, not by where it sits: the HUD has gained buttons before.
  await page.locator('.hud .hud-btn[title^="Вписать"]').first().click();
  await sleep(40);
  const duringMotion = await page.$eval('[data-artifact-id="' + webview.id + '"]', (card) => ({
    moving: !!card.closest('.board-viewport.is-moving'),
    guestVisibility: getComputedStyle(card.querySelector('webview')).visibility,
    stillOpacity: Number(getComputedStyle(card.querySelector('.embed-still')).opacity),
  }));
  check(
    'WebView is covered by its buffered frame during camera motion',
    duringMotion.moving && duringMotion.guestVisibility === 'visible' && duringMotion.stillOpacity === 1,
    JSON.stringify(duringMotion),
  );
  await waitFor(
    () => page.$eval('[data-artifact-id="' + webview.id + '"] .embed-still', (still) => Number(getComputedStyle(still).opacity) === 0),
    4000,
    100,
  );
  const afterMotion = await page.$eval('[data-artifact-id="' + webview.id + '"]', (card) => ({
    identity: card.querySelector('webview').dataset.e2eIdentity,
    guestVisibility: getComputedStyle(card.querySelector('webview')).visibility,
    stillOpacity: Number(getComputedStyle(card.querySelector('.embed-still')).opacity),
  }));
  // A site in a card is a window onto a page, not a page squeezed into a box:
  // the guest is laid out at a desktop width and the result scaled into the
  // card, so the page shows the layout it was written for.
  const layout = await page.evaluate(async (id) => {
    const card = document.querySelector('[data-artifact-id="' + id + '"]');
    const view = card.querySelector('webview');
    const rect = view.getBoundingClientRect();
    const surface = card.querySelector('.artifact-webview-surface').getBoundingClientRect();
    let sees = null;
    try {
      sees = await view.executeJavaScript('[window.innerWidth, document.documentElement.scrollWidth]');
    } catch {
      sees = null;
    }
    return { element: view.offsetWidth, sees, onScreen: Math.round(rect.width), card: Math.round(surface.width) };
  }, webview.id);
  check(
    'WebView lays the page out at a desktop width, not at the card width',
    layout.element >= 1280 && layout.sees != null && layout.sees[0] >= 1280 && layout.sees[1] <= layout.sees[0] + 2,
    JSON.stringify(layout),
  );
  check(
    'and the result still covers exactly the card',
    Math.abs(layout.onScreen - layout.card) <= 2,
    JSON.stringify(layout),
  );

  check(
    'WebView returns live without being remounted',
    afterMotion.identity === 'kept' && afterMotion.guestVisibility === 'visible' && afterMotion.stillOpacity === 0,
    JSON.stringify(afterMotion),
  );
}

await page.keyboard.press('Escape');
await focusOn(editor);
const shown = await waitFor(() => page.$eval('[data-artifact-id="' + editor.id + '"] .cm-content', (el) => el.textContent.includes('greet')), 10000);
check('code editor shows the file from disk', !!shown);

const edBox = await page.locator('[data-artifact-id="' + editor.id + '"]').boundingBox();
await page.mouse.click(edBox.x + edBox.width / 2, edBox.y + 12);
await sleep(200);
await page.locator('[data-artifact-id="' + editor.id + '"] .cm-content').click();
await page.keyboard.press('Control+End');
await page.keyboard.type('// saved from the board');
await page.keyboard.press('Control+s');
const saved = await waitFor(() => readFileSync(codePath, 'utf8').includes('saved from the board'), 5000);
check('Ctrl+S writes the edit to the file', !!saved);
await shot('05-code-editor');
console.log('health after editor: toolbar=' + (await page.locator('.toolbar').count()));

const imagePath = join(appDir, 'resources', 'icon-512.png');
const image = await call('artifact_create', { type: 'image', x: 400, y: 1300, props: { src: imagePath } });
const fileCard = await call('artifact_create', { type: 'file', x: 900, y: 1300, props: { path: codePath } });
await page.keyboard.press('Escape');
await focusOn({ x: image.x, y: image.y, width: 900, height: image.height });
const loaded = await waitFor(() => page.$eval('[data-artifact-id="' + image.id + '"] img', (img) => img.naturalWidth > 0), 10000);
check('image card loads a local file', !!loaded);
const statText = await waitFor(() => page.$eval('[data-artifact-id="' + fileCard.id + '"] .file-path', (el) => (/Б|КБ/.test(el.textContent) ? el.textContent : '')), 10000);
check('file card shows size and date from disk', !!statText, statText || '');
await shot('06-files');

await client.close();
await app.close();
const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed. Screenshots: ' + outDir);
process.exit(failed.length ? 1 : 0);
