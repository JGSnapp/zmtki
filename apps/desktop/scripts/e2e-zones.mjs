// End-to-end check of zones, agent markers and the permission flow, in the
// real Electron app.
//
//   node scripts/run.cjs build && node scripts/e2e-zones.mjs [outDir]
//
// Zones: swept by hand, grown, cut with Shift, renamed and recoloured. Agents:
// a zone asked for over MCP arrives pending and is accepted on the board, and
// a subagent request shows up as a banner the user answers.
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
const outDir = process.argv[2] || mkdtempSync(join(tmpdir(), 'zmtki-zones-'));
mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 15000, step = 200) => {
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

const env = { ...process.env, ZMTKI_E2E: '1', ZMTKI_DATA_DIR: mkdtempSync(join(tmpdir(), 'zmtki-zones-data-')) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;

const app = await _electron.launch({ executablePath: require('electron'), args: [appDir], env, cwd: appDir });
const page = await app.firstWindow();
page.on('crash', () => console.log('RENDERER CRASHED'));
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
page.on('console', (msg) => {
  if (msg.type() === 'error' && !/ERR_FILE_NOT_FOUND|logo\.png/.test(msg.text())) console.log('[renderer error] ' + msg.text());
});
await page.waitForSelector('.board-viewport', { timeout: 20000 });
await sleep(800);
const shot = (name) => page.screenshot({ path: join(outDir, name + '.png') });

const boardId = await page.evaluate(async () => (await window.zmtki.boards.list())[0].id);
const board = () => page.evaluate(async (id) => window.zmtki.boards.get(id), boardId);
const zones = async () => (await board()).state.zones;

await page.keyboard.press('0');
const vp = await page.locator('.board-viewport').boundingBox();
const at = (dx, dy) => ({ x: vp.x + vp.width / 2 + dx, y: vp.y + vp.height / 2 + dy });

/** Sweeps a rectangle on the board, the way a zone is drawn by hand. */
const sweep = async (from, to, modifier) => {
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
  await sleep(350);
};

// --- 1. Drawing a zone by hand -------------------------------------------------

await page.click('.tb-btn:has-text("Зоны")');
check('zone mode turns on', (await page.locator('.tb-btn.is-on:has-text("Зоны")').count()) === 1);

await sweep(at(-380, -200), at(-40, 40));
let list = await zones();
check('a swept rectangle becomes a zone', list.length === 1, JSON.stringify(list.map((z) => z.rects)));
check('the zone is drawn with an outline', (await page.locator('.zone-outline line').count()) > 0);
check('the zone shows its name on the board', (await page.locator('.zone-title').count()) === 1);
await shot('01-zone-drawn');

// --- 2. Growing and cutting ----------------------------------------------------

const before = list[0];
await sweep(at(-40, -200), at(260, 40));
list = await zones();
check('a second sweep grows the same zone', list.length === 1 && list[0].rects.length >= 1 && list[0].id === before.id);
const width = Math.max(...list[0].rects.map((r) => r.x + r.width)) - Math.min(...list[0].rects.map((r) => r.x));
check('the zone reaches across both sweeps', width > 500, 'width=' + Math.round(width));
// Two rectangles that merged are outlined as one shape, not as two boxes.
check('the union is outlined once', (await page.locator('.zone-outline line').count()) <= 8);
await shot('02-zone-grown');

const areaOf = (zone) => zone.rects.reduce((sum, r) => sum + r.width * r.height, 0);
const areaBefore = areaOf(list[0]);
await sweep(at(-200, -140), at(-60, -20), 'Shift');
list = await zones();
check('a Shift sweep cuts a hole out of the zone', list.length === 1 && areaOf(list[0]) < areaBefore, Math.round(areaOf(list[0])) + ' < ' + Math.round(areaBefore));
await shot('03-zone-carved');

// --- 3. Renaming and recolouring ----------------------------------------------

await page.locator('.zone-title').first().click();
await sleep(200);
await page.locator('.zone-title .chip[title="Переименовать"]').first().click();
await page.locator('.zone-rename').fill('Исследование');
await page.keyboard.press('Enter');
const renamed = await waitFor(async () => (await zones())[0].title === 'Исследование');
check('a zone can be renamed on the board', !!renamed);

const colorBefore = (await zones())[0].color;
await page.locator('.zone-swatch').nth(2).click();
const recoloured = await waitFor(async () => (await zones())[0].color !== colorBefore);
check('a zone can be recoloured', !!recoloured);
await shot('04-zone-named');

await page.keyboard.press('Escape');

// --- 4. An agent asks for a zone ----------------------------------------------

const endpoint = await app.evaluate((_e, id) => globalThis.__zmtki.mcp.bind('e2e-agent', id), boardId);
const client = new Client({ name: 'e2e-zones', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

await client.callTool({
  name: 'zone_request',
  arguments: { title: 'Разбор логов', reason: 'Сложить туда выжимки', x: 600, y: -300, width: 700, height: 500 },
});
const pending = await waitFor(async () => (await zones()).find((z) => z.pending));
check('the zone an agent asks for arrives pending', !!pending);
check('the board offers to accept or reject it', (await page.locator('.zone-title--pending .chip--ok').count()) === 1);
await shot('05-zone-requested');

await page.locator('.zone-title--pending .chip--ok').first().click();
const accepted = await waitFor(async () => (await zones()).every((z) => !z.pending));
check('accepting the request turns it into a zone', !!accepted);

// --- 5. What the agent sees of the zones --------------------------------------
//
// Binding an agent to a zone needs an agent with a terminal behind it, which
// this run has no CLI to start; that the guard undoes work outside the zone is
// checked in test/agents.test.ts against the same server. What is checked here
// is the picture the agent is given of the board's territory.

const listed = await client.callTool({ name: 'zone_list', arguments: {} });
const zoneView = JSON.parse((listed.content ?? []).map((part) => part.text ?? '').join('\n'));
check('the agent sees both zones with their borders', zoneView.zones.length === 2, JSON.stringify(zoneView.zones.map((z) => z.title)));
check('none of them is left pending after the answer', zoneView.zones.every((z) => !z.pending));

const asked = (await zones()).find((z) => z.title === 'Разбор логов');
const inside = await client.callTool({ name: 'artifact_create', arguments: { type: 'note', x: asked.rects[0].x + 40, y: asked.rects[0].y + 40 } });
check('the agent works inside the zone it was given', !inside.isError);
const placed = await waitFor(async () => (await board()).state.artifacts.length === 1);
check('its block is on the board', !!placed);
await shot('06-agent-in-zone');

// --- 6. A subagent the user must allow ----------------------------------------

await app.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows()[0];
  window.webContents.send('agent:event', {
    type: 'spawn_requested',
    request: {
      id: 'e2e-request-1',
      parentId: 'e2e-agent',
      parentLabel: 'Claude на доске',
      boardId: globalThis.__zmtki.boards.list()[0].id,
      harnessId: 'claude',
      purpose: 'Прочитать логи и выписать ошибки',
      cwd: '',
      createdAt: Date.now(),
    },
  });
});
const banner = await waitFor(() => page.locator('.ask').count().then((n) => n === 1));
check('a subagent request shows up as a banner', !!banner);
check('the banner says what the subagent is for', (await page.locator('.ask-body').first().innerText()).includes('логи'));
await shot('07-subagent-ask');

await page.locator('.ask .chip--ok').first().click();
const cleared = await waitFor(() => page.locator('.ask').count().then((n) => n === 0));
check('answering the banner clears it', !!cleared);

// --- Done ----------------------------------------------------------------------

await client.close();
await app.close();

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
console.log('Screenshots: ' + outDir);
process.exit(failed.length === 0 ? 0 : 1);
