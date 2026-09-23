// End-to-end check that the window keeps answering while an agent works.
//
//   node scripts/run.cjs build && node scripts/e2e-load.mjs
//
// The board is driven the way an agent building a wiki drives it: thirty nodes,
// forty arrows, a layout, then edits. The layout is the dangerous part — it is
// seconds of unbroken CPU, and when it ran on the main thread the window went
// "not responding" and the agent's own call timed out after a minute. What is
// measured here is the renderer's worst frame gap during each phase and whether
// the window still answers at the end.
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const env = { ...process.env, ZMTKI_E2E: '1', ZMTKI_DATA_DIR: mkdtempSync(join(tmpdir(), 'zmtki-load-')) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/** A frame gap this long is a stutter a person sees; ten times it is a freeze. */
const FRAME_LIMIT_MS = 400;

const app = await _electron.launch({ executablePath: require('electron'), args: ['.'], env, cwd: process.cwd() });
const page = await app.firstWindow();
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
await page.waitForSelector('.board-viewport', { timeout: 20000 });
await sleep(600);

// Longest frame gap seen by the renderer: how long its thread was blocked.
await page.evaluate(() => {
  const state = { worst: 0, last: performance.now(), frames: 0 };
  window.__load = state;
  const tick = () => {
    const now = performance.now();
    const gap = now - state.last;
    if (gap > state.worst) state.worst = gap;
    state.last = now;
    state.frames += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const boardId = await page.evaluate(async () => (await window.zmtki.boards.list())[0].id);
const endpoint = await app.evaluate((_e, id) => globalThis.__zmtki.mcp.bind('load-agent', id), boardId);
const client = new Client({ name: 'load', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

const call = async (name, args) => {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((p) => p.text ?? '').join('\n');
  return { ms: Date.now() - started, text, data: safeJson(text) };
};
const safeJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const reset = () => page.evaluate(() => {
  window.__load.worst = 0;
  window.__load.frames = 0;
});
const worst = () => page.evaluate(() => ({ worst: Math.round(window.__load.worst), frames: window.__load.frames }));

const NODES = 30;
const ids = [];
console.log('--- creating ' + NODES + ' nodes');
await reset();
let slowest = 0;
for (let i = 0; i < NODES; i += 1) {
  const r = await call('artifact_create', {
    type: 'note',
    x: (i % 6) * 320,
    y: Math.floor(i / 6) * 240,
    width: 240,
    height: 180,
    props: { text: 'Узел ' + (i + 1) + ': какой-то текст про покемонов, достаточно длинный, чтобы карточка была не пустой.' },
  });
  slowest = Math.max(slowest, r.ms);
  if (r.data?.id) ids.push(r.data.id);
}
let frames = await worst();
check('thirty nodes created', ids.length === NODES, 'slowest call ' + slowest + ' ms');
check('the window keeps painting while they are created', frames.worst < FRAME_LIMIT_MS, 'worst frame ' + frames.worst + ' ms');

console.log('--- connecting them');
await reset();
slowest = 0;
for (let i = 1; i < ids.length; i += 1) {
  const r = await call('arrow_create', { fromId: ids[i - 1], toId: ids[i] });
  slowest = Math.max(slowest, r.ms);
}
for (let i = 3; i < ids.length; i += 3) {
  const r = await call('arrow_create', { fromId: ids[0], toId: ids[i] });
  slowest = Math.max(slowest, r.ms);
}
frames = await worst();
check('the window keeps painting while arrows are drawn', frames.worst < FRAME_LIMIT_MS, 'worst frame ' + frames.worst + ' ms');

console.log('--- arranging');
await reset();
const arranged = await call('board_arrange_graph', {});
frames = await worst();
check('the layout answers the agent in time', arranged.ms < 30000 && !/timed out/i.test(arranged.text), arranged.ms + ' ms');
// The point of the worker thread: the search runs, and the window still draws.
check('the window keeps painting during the layout', frames.worst < FRAME_LIMIT_MS && frames.frames > 60,
  'worst frame ' + frames.worst + ' ms over ' + frames.frames + ' frames');

console.log('--- editing props');
await reset();
slowest = 0;
for (let i = 0; i < 20; i += 1) {
  const r = await call('artifact_update', { id: ids[i], props: { text: 'Обновлённый текст узла ' + (i + 1) + '.' } });
  slowest = Math.max(slowest, r.ms);
}
frames = await worst();
check('edits stay quick afterwards', slowest < 1000, 'slowest call ' + slowest + ' ms');
check('the window keeps painting during edits', frames.worst < FRAME_LIMIT_MS, 'worst frame ' + frames.worst + ' ms');

console.log('--- routing the arrows once more, as the skill tells an agent to');
await reset();
const routed = await call('board_route_arrows', {});
frames = await worst();
check('routing answers in time', routed.ms < 60000, routed.ms + ' ms');
check('the window keeps painting while arrows are routed', frames.worst < FRAME_LIMIT_MS, 'worst frame ' + frames.worst + ' ms');

const ping = Date.now();
const alive = await page.evaluate(() => document.querySelectorAll('.artifact').length).catch(() => null);
check('the window answers at the end', alive !== null && Date.now() - ping < 1000, (Date.now() - ping) + ' ms');

await client.close();
await app.close();

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
process.exit(failed.length === 0 ? 0 : 1);
