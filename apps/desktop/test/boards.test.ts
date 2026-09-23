import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addBend,
  createArrow,
  createArtifact,
  deleteArtifact,
  moveBend,
  queryRegion,
  removeBend,
  updateArtifact,
} from '../src/main/boards/operations.js';
import { makeEnv, type TestEnv } from './helpers.js';

describe('boards', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(async () => {
    await env.dispose();
  });

  it('creates empty boards with a default title and model', () => {
    const board = env.ctx.boards.create();
    expect(board.title).toBe('Доска 1');
    expect(board.state.artifacts).toHaveLength(0);
    expect(board.rootDir).toBe('');
  });

  it('deletes only the requested board', () => {
    const first = env.ctx.boards.create({ title: 'Первая' });
    const second = env.ctx.boards.create({ title: 'Вторая' });

    env.ctx.boards.remove(first.id);

    expect(env.ctx.boards.list().map((board) => board.id)).toEqual([second.id]);
    expect(() => env.ctx.boards.get(first.id)).toThrow(/not found/);
    expect(env.ctx.boards.get(second.id).title).toBe('Вторая');
  });

  it('applies blueprint defaults when size and props are omitted', () => {
    const board = env.ctx.boards.create();
    const artifact = env.ctx.boards.mutate(board.id, (state) =>
      createArtifact(state, { type: 'note', x: 10, y: 20 }),
    );
    expect(artifact).toMatchObject({ type: 'note', x: 10, y: 20, width: 240, height: 180 });
    expect(artifact.props).toMatchObject({ color: 'yellow' });
  });

  it('undoes and redoes one mutation at a time', () => {
    const board = env.ctx.boards.create();
    env.ctx.boards.mutate(board.id, (state) => createArtifact(state, { type: 'note', x: 0, y: 0 }));
    env.ctx.boards.mutate(board.id, (state) => createArtifact(state, { type: 'text', x: 300, y: 0 }));
    expect(env.ctx.boards.get(board.id).state.artifacts).toHaveLength(2);

    env.ctx.boards.undo(board.id);
    expect(env.ctx.boards.get(board.id).state.artifacts).toHaveLength(1);
    env.ctx.boards.undo(board.id);
    expect(env.ctx.boards.get(board.id).state.artifacts).toHaveLength(0);
    expect(env.ctx.boards.history(board.id).canUndo).toBe(false);

    env.ctx.boards.redo(board.id);
    expect(env.ctx.boards.get(board.id).state.artifacts).toHaveLength(1);
  });

  it('rolls back a failed mutation instead of leaving partial state', () => {
    const board = env.ctx.boards.create();
    expect(() =>
      env.ctx.boards.mutate(board.id, (state) => {
        createArtifact(state, { type: 'note', x: 0, y: 0 });
        updateArtifact(state, 'art_missing', { x: 1 });
      }),
    ).toThrow(/not found/);
    expect(env.ctx.boards.get(board.id).state.artifacts).toHaveLength(0);
    expect(env.ctx.boards.history(board.id).canUndo).toBe(false);
  });

  it('restores artifacts and arrows from one complete checkpoint', () => {
    const board = env.ctx.boards.create();
    env.ctx.boards.mutate(board.id, (state) => {
      const a = createArtifact(state, { type: 'note', x: 0, y: 0 });
      const b = createArtifact(state, { type: 'note', x: 400, y: 0 });
      createArrow(state, { fromId: a.id, toId: b.id, fromSide: 'right', toSide: 'left' });
    });
    const checkpoint = env.ctx.boards.snapshot(board.id);
    env.ctx.boards.mutate(board.id, (state) => deleteArtifact(state, state.artifacts[1].id));

    env.ctx.boards.restoreState(board.id, checkpoint);

    expect(env.ctx.boards.get(board.id).state.artifacts).toHaveLength(2);
    expect(env.ctx.boards.get(board.id).state.arrows).toHaveLength(1);
    env.ctx.boards.undo(board.id);
    expect(env.ctx.boards.get(board.id).state.arrows).toHaveLength(0);
  });

  it('removes attached arrows together with the artifact', () => {
    const board = env.ctx.boards.create();
    const { a, b } = env.ctx.boards.mutate(board.id, (state) => ({
      a: createArtifact(state, { type: 'note', x: 0, y: 0 }),
      b: createArtifact(state, { type: 'note', x: 400, y: 0 }),
    }));
    env.ctx.boards.mutate(board.id, (state) =>
      createArrow(state, { fromId: a.id, toId: b.id, fromSide: 'right', toSide: 'left' }),
    );
    expect(env.ctx.boards.get(board.id).state.arrows).toHaveLength(1);

    const result = env.ctx.boards.mutate(board.id, (state) => deleteArtifact(state, b.id));
    expect(result.arrowsRemoved).toBe(1);
    expect(env.ctx.boards.get(board.id).state.arrows).toHaveLength(0);
  });

  it('adds, moves and removes arrow bend points', () => {
    const board = env.ctx.boards.create();
    const { arrow } = env.ctx.boards.mutate(board.id, (state) => {
      const a = createArtifact(state, { type: 'note', x: 0, y: 0 });
      const b = createArtifact(state, { type: 'note', x: 600, y: 400 });
      return { arrow: createArrow(state, { fromId: a.id, toId: b.id }) };
    });

    env.ctx.boards.mutate(board.id, (state) => addBend(state, arrow.id, { x: 300, y: 0 }));
    env.ctx.boards.mutate(board.id, (state) => addBend(state, arrow.id, { x: 300, y: 400 }));
    expect(env.ctx.boards.get(board.id).state.arrows[0].bends).toEqual([
      { x: 300, y: 0 },
      { x: 300, y: 400 },
    ]);

    env.ctx.boards.mutate(board.id, (state) => moveBend(state, arrow.id, 0, { x: 320, y: 10 }));
    expect(env.ctx.boards.get(board.id).state.arrows[0].bends[0]).toEqual({ x: 320, y: 10 });

    expect(() =>
      env.ctx.boards.mutate(board.id, (state) => moveBend(state, arrow.id, 9, { x: 0, y: 0 })),
    ).toThrow(/out of range/);

    env.ctx.boards.mutate(board.id, (state) => removeBend(state, arrow.id, 0));
    expect(env.ctx.boards.get(board.id).state.arrows[0].bends).toHaveLength(1);
  });

  it('queries only artifacts intersecting the region', () => {
    const board = env.ctx.boards.create();
    env.ctx.boards.mutate(board.id, (state) => {
      createArtifact(state, { type: 'note', x: 0, y: 0, width: 100, height: 100 });
      createArtifact(state, { type: 'note', x: 5000, y: 5000, width: 100, height: 100 });
    });
    const result = env.ctx.boards.read(board.id, (state) =>
      queryRegion(state, { x: -50, y: -50, width: 400, height: 400 }),
    );
    expect(result.artifacts).toHaveLength(1);
    expect(result.totalArtifacts).toBe(2);
  });
});
