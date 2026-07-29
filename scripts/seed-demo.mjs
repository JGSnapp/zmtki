import os from 'node:os';
import path from 'node:path';
import { createArtifactNode, DEFAULT_ARTIFACT_SIZE } from '../packages/board-schema/dist/index.js';
import { Workspace } from '../packages/core/dist/index.js';

/**
 * Fills a demo board so the app has something to show on first launch.
 *
 * Writes through the same Workspace the desktop app uses, into the same
 * ~/.zmtki app database, so the board is simply "already open" next time the
 * app starts. Run with the app closed.
 */

const boardPath = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'demo-board'));
const ws = new Workspace(path.join(os.homedir(), '.zmtki'));
await ws.init();

const created = await ws.submit({
  id: 's1',
  op: { type: 'workspace.createBoard', path: boardPath, name: 'Демо: витрина артефактов' }
});
if (!created.ok) {
  console.error(created.error);
  process.exit(1);
}
const boardId = created.value.boardId;

const backend = (
  await ws.submit({
    id: 's2',
    op: {
      type: 'agent.create',
      boardId,
      name: 'Бэкенд',
      persona: 'Пишет API на Node, отвечает за схему базы и миграции.'
    }
  })
).value.agent;

const design = (
  await ws.submit({
    id: 's3',
    op: {
      type: 'agent.create',
      boardId,
      name: 'Дизайн',
      persona: 'Собирает интерфейс, следит за типографикой и состояниями пустых экранов.'
    }
  })
).value.agent;

const session = ws.session(boardId);

/** Places an artifact inside the given agent's frame, same path the tools use. */
function artifact(agentId, spec) {
  const size = DEFAULT_ARTIFACT_SIZE[spec.kind];
  const position = session.board.placeForAgent(agentId, size);
  const node = createArtifactNode({ artifact: spec, position, size, createdBy: agentId });
  session.board.apply({ origin: agentId, ops: [{ op: 'addNode', node }] });
  return node.id;
}

artifact(backend.id, {
  kind: 'kanban',
  title: 'План работ',
  tone: 'running',
  columns: [
    {
      id: 'c1',
      title: 'В работе',
      cards: [{ id: 'k1', title: 'Схема БД', body: 'Пользователи, доски, артефакты', tone: 'running' }]
    },
    {
      id: 'c2',
      title: 'Готово',
      cards: [{ id: 'k2', title: 'Каркас API', body: 'Роуты и валидация', tone: 'success' }]
    }
  ]
});

artifact(backend.id, {
  kind: 'status',
  title: 'Текущее состояние',
  tone: 'running',
  headline: 'Пишу миграции',
  detail: 'Три таблицы из пяти готовы, дальше индексы.',
  progress: 0.6,
  fields: [
    { label: 'Тесты', value: '18 / 18' },
    { label: 'Покрытие', value: '84%' }
  ]
});

artifact(backend.id, {
  kind: 'mermaid',
  title: 'Схема данных',
  tone: 'idle',
  source: 'graph LR\n  U[Пользователь] --> B[Доска]\n  B --> A[Артефакт]\n  B --> AG[Агент]\n  AG --> A'
});

artifact(design.id, {
  kind: 'markdown',
  title: 'Правила интерфейса',
  tone: 'idle',
  text: '## Тон\n\nТёмная тема по умолчанию.\n\n- Заголовки без точки\n- Пустые экраны объясняют следующий шаг\n- Статусы честные: `running`, `success`, `error`'
});

artifact(design.id, {
  kind: 'table',
  title: 'Состояния кнопки',
  tone: 'success',
  columns: ['Состояние', 'Фон', 'Текст'],
  rows: [
    ['Обычная', '#1b1f2a', '#e6e9ef'],
    ['Наведение', '#232936', '#ffffff'],
    ['Выключена', '#151821', '#5c6472']
  ]
});

artifact(design.id, {
  kind: 'todo',
  title: 'Осталось',
  tone: 'running',
  items: [
    { id: 't1', text: 'Пустое состояние доски', done: true },
    { id: 't2', text: 'Скелетоны загрузки', done: false },
    { id: 't3', text: 'Фокус-стили для клавиатуры', done: false }
  ]
});

await ws.submit({ id: 's9', op: { type: 'workspace.setActive', boardId } });
await ws.shutdown();

console.log(`Доска готова: ${boardPath}`);
console.log(`Агенты: ${backend.name}, ${design.name}. Артефактов: 6.`);
