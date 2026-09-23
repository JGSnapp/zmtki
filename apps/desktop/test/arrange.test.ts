import {
  arrangeGraph,
  boardQuality,
  checkIntersections,
  layoutGraph,
  type Arrow,
  type Artifact,
} from '@zmtki/shared';
import { describe, expect, it } from 'vitest';
import { ArrangeService } from '../src/main/layout/arrange.service.js';
import { ToolRegistry } from '../src/main/mcp/tools/index.js';
import { createArrow, createArtifact } from '../src/main/boards/operations.js';
import { makeEnv, type TestEnv } from './helpers.js';

// Without a built worker beside it the service runs the engine here, which is
// what these small graphs want anyway.
const arrange = new ArrangeService();

const toolContext = (env: TestEnv, boardId: string) => ({
  boardId,
  agentId: '',
  boards: env.ctx.boards,
  skills: env.ctx.skills,
  arrange,
});

const node = (id: string, x: number, y: number): Artifact => ({
  id,
  type: 'note',
  x,
  y,
  width: 200,
  height: 120,
  z: 1,
  rotation: 0,
  props: {},
  createdAt: 0,
  updatedAt: 0,
});

const edge = (id: string, from: string, to: string): Arrow => ({
  id,
  from: { artifactId: from, side: 'auto' },
  to: { artifactId: to, side: 'auto' },
  bends: [],
  routing: 'orthogonal',
  style: {},
  createdAt: 0,
  updatedAt: 0,
});

describe('layoutGraph', () => {
  it('puts a chain into consecutive layers', () => {
    const artifacts = [node('a', 0, 0), node('b', 0, 0), node('c', 0, 0)];
    const arrows = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')];
    const result = layoutGraph(artifacts, arrows, { direction: 'LR' });

    expect(result.layers.map((layer) => layer.length)).toEqual([1, 1, 1]);
    const at = new Map(result.nodes.map((n) => [n.id, n]));
    expect(at.get('a')!.x).toBeLessThan(at.get('b')!.x);
    expect(at.get('b')!.x).toBeLessThan(at.get('c')!.x);
  });

  it('breaks a cycle instead of looping forever', () => {
    const artifacts = [node('a', 0, 0), node('b', 0, 0), node('c', 0, 0)];
    const arrows = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'a')];
    const result = layoutGraph(artifacts, arrows);

    expect(result.reversedEdges.length).toBe(1);
    expect(result.nodes).toHaveLength(3);
  });

  it('reduces crossings by reordering a layer', () => {
    const artifacts = [node('a', 0, 0), node('b', 0, 200), node('c', 400, 0), node('d', 400, 200)];
    const arrows = [edge('e1', 'a', 'd'), edge('e2', 'b', 'c')];
    const result = layoutGraph(artifacts, arrows, { direction: 'LR' });

    expect(result.crossings).toBe(0);
  });

  it('never overlaps two nodes', () => {
    const artifacts = ['a', 'b', 'c', 'd', 'e'].map((id) => node(id, 0, 0));
    const arrows = [
      edge('e1', 'a', 'b'),
      edge('e2', 'a', 'c'),
      edge('e3', 'a', 'd'),
      edge('e4', 'a', 'e'),
    ];
    const result = layoutGraph(artifacts, arrows, { direction: 'LR' });

    const placed = result.nodes.map((n) => ({ ...n, width: 200, height: 120 }));
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const overlap =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
  });

  it('keeps a locked node exactly where it was', () => {
    const artifacts = [node('a', 500, 700), node('b', 0, 0), node('c', 0, 0)];
    const arrows = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')];
    const result = layoutGraph(artifacts, arrows, { lockIds: ['a'] });

    const a = result.nodes.find((n) => n.id === 'a')!;
    expect(a.x).toBe(500);
    expect(a.y).toBe(700);
  });
});

describe('arrangeGraph', () => {
  it('beats a hand placement that funnels every arrow through one gap', () => {
    const artifacts = [
      node('s1', 0, 0),
      node('s2', 0, 200),
      node('s3', 0, 400),
      node('s4', 0, 600),
      node('s5', 0, 800),
      node('t1', 600, 0),
      node('t2', 600, 400),
      node('t3', 600, 800),
    ];
    const arrows = [
      edge('e1', 's1', 't3'),
      edge('e2', 's2', 't1'),
      edge('e3', 's3', 't2'),
      edge('e4', 's4', 't1'),
      edge('e5', 's5', 't2'),
      edge('e6', 't1', 't3'),
    ];

    const before = boardQuality(artifacts, arrows);
    const result = arrangeGraph(artifacts, arrows);

    expect(result.qualityAfter.cost).toBeLessThan(before.cost);
    expect(result.layout.crossings).toBeLessThanOrEqual(result.layout.crossingsBefore);
  });

  it('tries both directions and keeps the cheapest candidate', () => {
    const artifacts = [node('a', 0, 0), node('b', 0, 0), node('c', 0, 0)];
    const arrows = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')];
    const result = arrangeGraph(artifacts, arrows, { direction: 'auto' });

    expect(new Set(result.candidates.map((c) => c.direction))).toEqual(new Set(['LR', 'TB']));
    expect(result.chosen.quality.cost).toBeLessThanOrEqual(
      Math.min(...result.candidates.map((c) => c.quality.cost)) + 1e-6,
    );
  });
});

describe('board_arrange_graph', () => {
  it('moves nodes, routes arrows and does not leave overlaps', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      env.ctx.boards.mutate(board.id, (state) => {
        const made = ['a', 'b', 'c', 'd'].map((_, index) =>
          createArtifact(state, { type: 'note', x: 0, y: index * 320 }),
        );
        createArrow(state, { fromId: made[0].id, toId: made[3].id });
        createArrow(state, { fromId: made[1].id, toId: made[2].id });
        createArrow(state, { fromId: made[2].id, toId: made[3].id });
        return null;
      });

      const before = env.ctx.boards.read(board.id, (state) =>
        boardQuality(state.artifacts, state.arrows),
      );
      const result = await new ToolRegistry()
        .get('board_arrange_graph')!
        .run({}, toolContext(env, board.id));
      const data = result.data as Record<string, unknown>;

      expect(data.applied).toBe(true);
      expect(result.mutated).toBe(true);
      const after = env.ctx.boards.read(board.id, (state) =>
        boardQuality(state.artifacts, state.arrows),
      );
      expect(after.cost).toBeLessThanOrEqual(before.cost);
      expect(after.counts.artifactArtifact).toBe(0);
    } finally {
      await env.dispose();
    }
  });

  it('leaves the board untouched on dryRun', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      env.ctx.boards.mutate(board.id, (state) => {
        const a = createArtifact(state, { type: 'note', x: 0, y: 0 });
        const b = createArtifact(state, { type: 'note', x: 40, y: 400 });
        createArrow(state, { fromId: a.id, toId: b.id });
        return null;
      });
      const snapshot = JSON.stringify(env.ctx.boards.snapshot(board.id));

      const result = await new ToolRegistry()
        .get('board_arrange_graph')!
        .run({ dryRun: true }, toolContext(env, board.id));

      expect((result.data as Record<string, unknown>).applied).toBe(false);
      expect(result.mutated).toBe(false);
      expect(JSON.stringify(env.ctx.boards.snapshot(board.id))).toBe(snapshot);
    } finally {
      await env.dispose();
    }
  });

  it('refuses on a board without arrows instead of shuffling cards', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      env.ctx.boards.mutate(board.id, (state) => {
        createArtifact(state, { type: 'note', x: 0, y: 0 });
        return null;
      });

      const result = await new ToolRegistry()
        .get('board_arrange_graph')!
        .run({}, toolContext(env, board.id));

      expect((result.data as Record<string, unknown>).refused).toBe(true);
      expect(result.mutated).toBe(false);
    } finally {
      await env.dispose();
    }
  });
});

describe('пользователь главнее автоматики', () => {
  it('exact=true оставляет плоское крепление как задано и только предупреждает', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      const ids = env.ctx.boards.mutate(board.id, (state) => {
        const a = createArtifact(state, { type: 'note', x: 0, y: 0 });
        const b = createArtifact(state, { type: 'note', x: 300, y: 200 });
        return { a: a.id, b: b.id };
      });
      const registry = new ToolRegistry();

      const created = await registry.get('arrow_create')!.run(
        { fromId: ids.a, toId: ids.b, fromSide: 'right', toSide: 'left', exact: true },
        toolContext(env, board.id),
      );
      const data = created.data as { warnings?: string[]; adjustments?: string[]; exact?: boolean };

      expect(created.mutated).toBe(true);
      expect(data.exact).toBe(true);
      expect(data.warnings?.join(' ')).toMatch(/плашмя/);
      expect(data.adjustments).toBeUndefined();
      // Nothing was silently added: the polyline is exactly what was asked for.
      expect(env.ctx.boards.read(board.id, (s) => s.arrows[0].bends)).toEqual([]);
      expect(env.ctx.boards.read(board.id, (s) => s.arrows[0].from.side)).toBe('right');
      expect(env.ctx.boards.read(board.id, (s) => s.arrows[0].to.side)).toBe('left');
    } finally {
      await env.dispose();
    }
  });

  it('без exact тот же вызов чинится сам', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      const ids = env.ctx.boards.mutate(board.id, (state) => {
        const a = createArtifact(state, { type: 'note', x: 0, y: 0 });
        const b = createArtifact(state, { type: 'note', x: 300, y: 200 });
        return { a: a.id, b: b.id };
      });

      const created = await new ToolRegistry().get('arrow_create')!.run(
        { fromId: ids.a, toId: ids.b, fromSide: 'right', toSide: 'left' },
        toolContext(env, board.id),
      );

      expect((created.data as { adjustments?: string[] }).adjustments?.length).toBeGreaterThan(0);
      expect(env.ctx.boards.read(board.id, (s) => s.arrows[0].bends.length)).toBeGreaterThan(0);
    } finally {
      await env.dispose();
    }
  });

  it('lockIds удерживает узлы, которые пользователь расставил сам', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      const ids = env.ctx.boards.mutate(board.id, (state) => {
        const pinned = createArtifact(state, { type: 'note', x: 1200, y: 800 });
        const b = createArtifact(state, { type: 'note', x: 0, y: 0 });
        const c = createArtifact(state, { type: 'note', x: 0, y: 400 });
        createArrow(state, { fromId: pinned.id, toId: b.id });
        createArrow(state, { fromId: b.id, toId: c.id });
        return { pinned: pinned.id };
      });

      await new ToolRegistry()
        .get('board_arrange_graph')!
        .run({ lockIds: [ids.pinned] }, toolContext(env, board.id));

      const pinned = env.ctx.boards.read(board.id, (s) =>
        s.artifacts.find((a) => a.id === ids.pinned),
      );
      expect(pinned).toMatchObject({ x: 1200, y: 800 });
    } finally {
      await env.dispose();
    }
  });
});

describe('бюджет пересечений', () => {
  const chain = (count: number) => {
    const artifacts = Array.from({ length: count }, (_, i) => node(`n${i}`, i * 400, 0));
    const arrows = Array.from({ length: count - 1 }, (_, i) => edge(`e${i}`, `n${i}`, `n${i + 1}`));
    return { artifacts, arrows };
  };

  it('дерево получает нулевой бюджет — пересечение на нём остаётся дефектом', () => {
    const { artifacts, arrows } = chain(4);
    const report = checkIntersections(artifacts, arrows);
    expect(report.crossingBudget).toBe(0);
  });

  it('плотный граф получает бюджет по цикломатическому числу', () => {
    const { artifacts, arrows } = chain(4);
    // Три обратных ребра превращают цепочку в плотный граф.
    arrows.push(edge('x1', 'n3', 'n0'), edge('x2', 'n3', 'n1'), edge('x3', 'n2', 'n0'));
    const report = checkIntersections(artifacts, arrows);
    expect(report.crossingBudget).toBe(arrows.length - artifacts.length + 1);
    expect(report.crossingBudget).toBeGreaterThan(0);
  });

  it('бюджет не делает ok слепым к настоящим дефектам', () => {
    const artifacts = [node('a', 0, 0), node('b', 40, 40)];
    const arrows = [edge('e1', 'a', 'b')];
    const report = checkIntersections(artifacts, arrows);
    expect(report.counts.artifactArtifact).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });
});

describe('намеренное перекрытие', () => {
  it('acceptOverlap помечает блок, и метрика перестаёт считать это дефектом', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      const registry = new ToolRegistry();
      const ctx = toolContext(env, board.id);

      await registry.get('artifact_create')!.run({ type: 'note', x: 0, y: 0 }, ctx);
      const refused = await registry
        .get('artifact_create')!
        .run({ type: 'note', x: 60, y: 40 }, ctx);
      expect((refused.data as { refused?: boolean }).refused).toBe(true);

      const created = await registry
        .get('artifact_create')!
        .run({ type: 'note', x: 60, y: 40, acceptOverlap: true }, ctx);
      expect(created.mutated).toBe(true);

      const state = env.ctx.boards.snapshot(board.id);
      expect(state.artifacts[1].allowOverlap).toBe(true);
      // The blocks really do overlap, and that is no longer a defect.
      expect(state.artifacts[0].x).toBeLessThan(state.artifacts[1].x + state.artifacts[1].width);
      const report = checkIntersections(state.artifacts, state.arrows);
      expect(report.counts.artifactArtifact).toBe(0);
      expect(boardQuality(state.artifacts, state.arrows).score).toBe(100);
    } finally {
      await env.dispose();
    }
  });

  it('случайное наложение по-прежнему дефект', () => {
    const artifacts = [node('a', 0, 0), node('b', 60, 40)];
    const report = checkIntersections(artifacts, []);
    expect(report.counts.artifactArtifact).toBe(1);
  });

  it('у намеренно близких блоков не считается и теснота', () => {
    // A stack of photos was left with the whole penalty as "too close" once
    // the overlap itself stopped counting.
    const stack = [node('a', 0, 0), node('b', 60, 40), node('c', 120, 80)].map((a) => ({
      ...a,
      allowOverlap: true,
    }));
    const report = checkIntersections(stack, []);
    expect(report.counts.artifactArtifact).toBe(0);
    expect(report.counts.tightSpacing).toBe(0);
    expect(boardQuality(stack, []).score).toBe(100);

    // Two ordinary blocks standing 10px apart are still reported.
    const crowded = [node('x', 0, 0), node('y', 210, 0)];
    expect(checkIntersections(crowded, []).counts.tightSpacing).toBe(1);
  });
});
