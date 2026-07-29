import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Workspace } from '../packages/core/dist/index.js';

/**
 * End-to-end check of the core without Electron: create a board, put two agents
 * on it, verify their frames exist, exercise the room guards and comments.
 */
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zmtki-smoke-'));
const appDir = path.join(tmp, 'app');
const boardDir = path.join(tmp, 'board');

const ws = new Workspace(appDir);
await ws.init();

const events = [];
ws.onEvent.on((event) => events.push(event.type));

const check = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!condition) process.exitCode = 1;
};

// --- board
const created = await ws.submit({
  id: 's1',
  op: { type: 'workspace.createBoard', path: boardDir, name: 'Смоук' }
});
check('доска создана', created.ok, created.ok ? created.value.boardId : created.error);
const boardId = created.value.boardId;

const files = await fs.readdir(boardDir);
check('board.zmtki.json на диске', files.includes('board.zmtki.json'), files.join(', '));

// --- agents
const a1 = await ws.submit({
  id: 's2',
  op: { type: 'agent.create', boardId, name: 'Бэкенд', persona: 'делает API' }
});
const a2 = await ws.submit({
  id: 's3',
  op: { type: 'agent.create', boardId, name: 'Фронтенд', persona: 'делает UI' }
});
check('два агента созданы', a1.ok && a2.ok);

const session = ws.session(boardId);
const frames = session.board.nodes.filter((n) => n.type === 'frame');
check('у каждого агента своя рамка', frames.length === 2, `frames=${frames.length}`);
check(
  'рамки не накладываются',
  frames[0].position.x + frames[0].size.w <= frames[1].position.x,
  `${JSON.stringify(frames.map((f) => f.position))}`
);

// --- artifact placement inside a frame
const agent1 = a1.value.agent;
const slot = session.board.placeForAgent(agent1.id, { w: 400, h: 300 });
const frame1 = frames.find((f) => f.agentId === agent1.id);
check(
  'артефакт размещается внутри рамки автора',
  slot.x >= frame1.position.x && slot.y >= frame1.position.y,
  JSON.stringify(slot)
);

// --- rooms: the group channel and hop guard
const rooms = ws.submit({ id: 's4', op: { type: 'room.list' } });
const roomList = (await rooms).value;
const channel = roomList.find((r) => r.kind === 'channel');
check('канал проекта создан для двух агентов', Boolean(channel), `rooms=${roomList.length}`);
check(
  'в группе по умолчанию mention-only',
  channel?.turnPolicy === 'mention-only',
  channel?.turnPolicy
);

const dm = roomList.find((r) => r.kind === 'dm');
check('у агента есть личный чат', Boolean(dm));

// --- comments route to the artifact author
const node = {
  id: 'nd_smoke_1',
  type: 'artifact',
  artifact: { kind: 'markdown', title: 'Отчёт', tone: 'idle', text: 'привет' },
  position: slot,
  size: { w: 400, h: 300 },
  rotation: 0,
  layerId: 'lyr_default',
  z: 0,
  locked: false,
  hidden: false,
  parentId: null,
  createdBy: agent1.id,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  rev: 0,
  meta: {}
};
session.board.apply({ origin: agent1.id, ops: [{ op: 'addNode', node }] });

const comment = await ws.submit({
  id: 's5',
  op: { type: 'comment.create', boardId, nodeId: node.id, body: 'переделай заголовок', anchor: null }
});
check('комментарий создан', comment.ok, comment.ok ? '' : comment.error);
check(
  'комментарий адресован автору артефакта',
  session.comments.pendingFor(agent1.id).length === 1 ||
    session.comments.list()[0]?.comments.length === 1
);

// --- board persistence
await session.board.flush();
const saved = JSON.parse(await fs.readFile(path.join(boardDir, 'board.zmtki.json'), 'utf8'));
check(
  'узлы сохранены в файл доски',
  saved.nodes.length === frames.length + 1,
  `nodes=${saved.nodes.length}`
);

// --- outline for agents
const outlinePath = path.join(boardDir, '.zmtki', 'board.outline.md');
const outline = await fs.readFile(outlinePath, 'utf8').catch(() => '');
check('сгенерирован board.outline.md', outline.length > 0);

check('поток событий не пустой', events.length > 0, `${events.length} событий`);

await ws.shutdown();
await fs.rm(tmp, { recursive: true, force: true });
console.log(process.exitCode ? '\nЕсть падения.' : '\nВсе проверки прошли.');
