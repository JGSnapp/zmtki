import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../packages/core/dist/index.js';

/**
 * Resets the demo board to a blank slate with a single example agent.
 *
 * Writes through the same Workspace the desktop app uses, into the same
 * ~/.zmtki app database, so the board is simply "already open" next time the
 * app starts. Run with the app closed.
 */

const boardPath = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'demo-board'));
const appDir = path.join(os.homedir(), '.zmtki');

await fs.rm(boardPath, { recursive: true, force: true });
await fs.mkdir(boardPath, { recursive: true });

const ws = new Workspace(appDir);
await ws.init();

// Drop anything currently open so the demo is the only board.
for (const board of ws.state().boards) {
  await ws.submit({ id: `close-${board.id}`, op: { type: 'workspace.closeBoard', boardId: board.id } });
}

const created = await ws.submit({
  id: 's1',
  op: { type: 'workspace.createBoard', path: boardPath, name: 'Демо' }
});
if (!created.ok) {
  console.error(created.error);
  process.exit(1);
}
const boardId = created.value.boardId;

const agentResult = await ws.submit({
  id: 's2',
  op: {
    type: 'agent.create',
    boardId,
    name: 'Агент',
    persona: 'Универсальный помощник на доске. Помогает с кодом, артефактами и задачами.'
  }
});
if (!agentResult.ok) {
  console.error(agentResult.error);
  process.exit(1);
}

// Keep the agent in the rail, but leave the canvas empty.
const detach = await ws.submit({
  id: 's3',
  op: { type: 'agent.detachFrame', agentId: agentResult.value.agent.id }
});
if (!detach.ok) {
  console.error(detach.error);
  process.exit(1);
}

await ws.submit({ id: 's4', op: { type: 'workspace.setActive', boardId } });
await ws.shutdown();

console.log(`Доска сброшена: ${boardPath}`);
console.log(`Агент: ${agentResult.value.agent.name}. Холст пустой.`);
