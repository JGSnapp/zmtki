import type { Board, BoardState } from '@zmtki/shared';
import { applyStateChange } from '@zmtki/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardEvent } from '../src/main/boards/boards.service.js';
import {
  addBend,
  createArrow,
  createArtifact,
  createZone,
  deleteArtifact,
  moveBend,
  updateArrow,
  updateArtifact,
} from '../src/main/boards/operations.js';
import { makeEnv, type TestEnv } from './helpers.js';

/**
 * The renderer never sees the board again after opening it: it keeps a copy
 * and applies deltas. These tests replay the deltas the service emits onto a
 * copy taken at the start and require it to end up identical to the service's
 * own state — through edits, in-place arrow writes, deletes, undo and redo.
 */
describe('board deltas and patch history', () => {
  let env: TestEnv;
  let replica: { board: Board; version: number } | null;
  let events: BoardEvent[];

  const plain = (state: BoardState) => JSON.parse(JSON.stringify(state)) as BoardState;

  beforeEach(() => {
    env = makeEnv();
    replica = null;
    events = [];
    env.ctx.boards.onUpdate((event) => {
      events.push(event);
      if (event.type === 'board_reset') {
        replica = { board: structuredClone(event.board), version: event.board.version };
        return;
      }
      if (!replica || replica.board.id !== event.boardId) return;
      expect(event.version).toBe(replica.version + 1);
      replica.board = { ...replica.board, state: applyStateChange(replica.board.state, event.change, true) };
      replica.version = event.version;
    });
  });

  afterEach(async () => {
    await env.dispose();
  });

  const expectInSync = (boardId: string) => {
    expect(replica).not.toBeNull();
    expect(plain(replica!.board.state)).toEqual(plain(env.ctx.boards.snapshot(boardId)));
  };

  it('replays to the same state through creates, in-place arrow writes and deletes', () => {
    const board = env.ctx.boards.create();
    const [a, b, c] = env.ctx.boards.mutate(board.id, (state) => [
      createArtifact(state, { type: 'note', x: 0, y: 0 }),
      createArtifact(state, { type: 'note', x: 400, y: 0 }),
      createArtifact(state, { type: 'code', x: 0, y: 400 }),
    ]);
    const arrow = env.ctx.boards.mutate(board.id, (state) => createArrow(state, { fromId: a.id, toId: b.id }));
    env.ctx.boards.mutate(board.id, (state) => updateArrow(state, arrow.id, { fromSide: 'bottom', fromOffset: 0.3 }));
    env.ctx.boards.mutate(board.id, (state) => addBend(state, arrow.id, { x: 200, y: 120 }));
    env.ctx.boards.mutate(board.id, (state) => moveBend(state, arrow.id, 0, { x: 220, y: 140 }));
    env.ctx.boards.mutate(board.id, (state) => updateArtifact(state, c.id, { x: 800, props: { code: 'x' } }));
    env.ctx.boards.mutate(board.id, (state) => createZone(state, { title: 'z', rects: [{ x: 0, y: 0, width: 10, height: 10 }] }));
    env.ctx.boards.mutate(board.id, (state) => deleteArtifact(state, a.id));
    expectInSync(board.id);
  });

  it('sends only what a transaction touched', () => {
    const board = env.ctx.boards.create();
    env.ctx.boards.mutate(board.id, (state) => {
      for (let i = 0; i < 50; i += 1) createArtifact(state, { type: 'note', x: i * 300, y: 0 });
    });
    const target = env.ctx.boards.snapshot(board.id).artifacts[7];
    events = [];
    env.ctx.boards.mutate(board.id, (state) => updateArtifact(state, target.id, { x: 5000 }));
    const delta = events[0];
    expect(delta.type).toBe('board_delta');
    if (delta.type !== 'board_delta') return;
    expect(delta.change.artifacts.upsert.map((u) => u.entity.id)).toEqual([target.id]);
    expect(delta.change.artifacts.remove).toEqual([]);
  });

  it('undoes and redoes through patches, keeping the replica in step', () => {
    const board = env.ctx.boards.create();
    const a = env.ctx.boards.mutate(board.id, (state) => createArtifact(state, { type: 'note', x: 0, y: 0 }));
    const b = env.ctx.boards.mutate(board.id, (state) => createArtifact(state, { type: 'note', x: 400, y: 0 }));
    const arrow = env.ctx.boards.mutate(board.id, (state) => createArrow(state, { fromId: a.id, toId: b.id }));
    env.ctx.boards.mutate(board.id, (state) => updateArrow(state, arrow.id, { toSide: 'top' }));
    const afterEdits = plain(env.ctx.boards.snapshot(board.id));

    env.ctx.boards.mutate(board.id, (state) => deleteArtifact(state, b.id));
    expect(env.ctx.boards.snapshot(board.id).arrows).toHaveLength(0);

    env.ctx.boards.undo(board.id);
    expect(plain(env.ctx.boards.snapshot(board.id))).toEqual(afterEdits);
    expectInSync(board.id);

    env.ctx.boards.redo(board.id);
    expect(env.ctx.boards.snapshot(board.id).artifacts).toHaveLength(1);
    expectInSync(board.id);

    for (let i = 0; i < 5; i += 1) env.ctx.boards.undo(board.id);
    expect(env.ctx.boards.snapshot(board.id).artifacts).toHaveLength(0);
    expectInSync(board.id);
    for (let i = 0; i < 5; i += 1) env.ctx.boards.redo(board.id);
    expectInSync(board.id);
  });

  it('keeps history entries intact when the live entities are written again later', () => {
    const board = env.ctx.boards.create();
    const a = env.ctx.boards.mutate(board.id, (state) => createArtifact(state, { type: 'note', x: 0, y: 0 }));
    const b = env.ctx.boards.mutate(board.id, (state) => createArtifact(state, { type: 'note', x: 400, y: 0 }));
    const arrow = env.ctx.boards.mutate(board.id, (state) => createArrow(state, { fromId: a.id, toId: b.id }));
    env.ctx.boards.mutate(board.id, (state) => updateArrow(state, arrow.id, { fromSide: 'left' }));
    env.ctx.boards.mutate(board.id, (state) => updateArrow(state, arrow.id, { fromSide: 'bottom' }));
    env.ctx.boards.undo(board.id);
    expect(env.ctx.boards.snapshot(board.id).arrows[0].from.side).toBe('left');
    env.ctx.boards.undo(board.id);
    expect(env.ctx.boards.snapshot(board.id).arrows[0].from.side).toBe('auto');
    expectInSync(board.id);
  });

  it('rolls a failed mutation back and sends nothing', () => {
    const board = env.ctx.boards.create();
    const a = env.ctx.boards.mutate(board.id, (state) => createArtifact(state, { type: 'note', x: 0, y: 0 }));
    const before = plain(env.ctx.boards.snapshot(board.id));
    const count = events.length;
    expect(() =>
      env.ctx.boards.mutate(board.id, (state) => {
        updateArtifact(state, a.id, { x: 999 });
        createArtifact(state, { type: 'note', x: 50, y: 50 });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(plain(env.ctx.boards.snapshot(board.id))).toEqual(before);
    expect(events.length).toBe(count);
    expect(env.ctx.boards.history(board.id).canUndo).toBe(true);
  });
});
