import { checkIntersections } from '@zmtki/shared';
import { describe, expect, it } from 'vitest';
import { ArrangeService } from '../src/main/layout/arrange.service.js';
import { ToolRegistry } from '../src/main/mcp/tools/index.js';
import { createArrow, createArtifact } from '../src/main/boards/operations.js';
import { makeEnv, type TestEnv } from './helpers.js';

// Routing runs on the layout thread; without a built worker beside it the
// service runs the same code here, which is what these small boards want.
const arrange = new ArrangeService();

const toolContext = (env: TestEnv, boardId: string) => ({
  boardId,
  agentId: '',
  boards: env.ctx.boards,
  skills: env.ctx.skills,
  arrange,
});

/** a → b with a box parked between them, so the direct line is blocked. */
const blockedBoard = (env: TestEnv, gap = 120) => {
  const board = env.ctx.boards.create();
  const width = 240;
  const ids = env.ctx.boards.mutate(board.id, (state) => {
    const a = createArtifact(state, { type: 'note', x: 0, y: 0 });
    createArtifact(state, { type: 'note', x: width + gap, y: 0 });
    const b = createArtifact(state, { type: 'note', x: (width + gap) * 2, y: 0 });
    const arrow = createArrow(state, { fromId: a.id, toId: b.id, fromSide: 'right', toSide: 'left' });
    return { arrowId: arrow.id };
  });
  return { boardId: board.id, ...ids };
};

describe('board_route_arrows', () => {
  it('writes bends that clear the obstacle and reports the gain', async () => {
    const env = makeEnv();
    try {
      const { boardId, arrowId } = blockedBoard(env);
      const result = await new ToolRegistry()
        .get('board_route_arrows')!
        .run({}, toolContext(env, boardId));

      const data = (
        result as {
          data: {
            routed: Array<{ arrowId: string; bends: number }>;
            qualityBefore: { cost: number };
            qualityAfter: { cost: number };
            improvedBy: number;
            counts: { arrowArtifact: number };
          };
          mutated?: boolean;
        }
      ).data;

      expect((result as { mutated?: boolean }).mutated).toBe(true);
      expect(data.routed.map((r) => r.arrowId)).toEqual([arrowId]);
      expect(data.counts.arrowArtifact).toBe(0);
      expect(data.qualityAfter.cost).toBeLessThan(data.qualityBefore.cost);

      const stored = env.ctx.boards.read(boardId, (state) => state.arrows[0]);
      expect(stored.from.side).not.toBe('auto');
      expect(stored.to.side).not.toBe('auto');
    } finally {
      void env.dispose();
    }
  });

  it('says the nodes are too crowded instead of drawing a bad line quietly', async () => {
    const env = makeEnv();
    try {
      const { boardId } = blockedBoard(env, 10);
      const result = await new ToolRegistry()
        .get('board_route_arrows')!
        .run({}, toolContext(env, boardId));
      const data = (
        result as { data: { crowded: string[]; verdict: string; refused?: boolean }; mutated?: boolean }
      ).data;
      expect((result as { mutated?: boolean }).mutated).toBe(false);
      expect(data.refused).toBe(true);
      expect(data.crowded).toHaveLength(1);
      // Both ports here are pinned to the sides the arrow was created with, so
      // the gate judges those sides and no others — and reports that they are
      // buried. An arrow whose ports the router owns is judged on whether any
      // side would work, which is what lets a deliberately tight row be routed.
      expect(data.verdict).toMatch(/нет свободной стороны/);
      expect(data.verdict).toMatch(/Маршрут не проложен/);
      expect(env.ctx.boards.read(boardId, (s) => s.arrows[0].bends)).toEqual([]);
    } finally {
      void env.dispose();
    }
  });

  it('refuses to route when artifacts overlap', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      env.ctx.boards.mutate(board.id, (state) => {
        const a = createArtifact(state, { type: 'note', x: 0, y: 0 });
        const b = createArtifact(state, { type: 'note', x: 40, y: 20 });
        createArrow(state, { fromId: a.id, toId: b.id, fromSide: 'right', toSide: 'left' });
      });
      const result = await new ToolRegistry()
        .get('board_route_arrows')!
        .run({}, toolContext(env, board.id));
      const data = (result as { data: { refused?: boolean; overlapping?: number; verdict: string }; mutated?: boolean })
        .data;
      expect((result as { mutated?: boolean }).mutated).toBe(false);
      expect(data.refused).toBe(true);
      expect(data.overlapping).toBeGreaterThan(0);
      expect(data.verdict).toMatch(/накладываются/);
      expect(env.ctx.boards.read(board.id, (s) => s.arrows[0].bends)).toEqual([]);
    } finally {
      void env.dispose();
    }
  });

  it('warns when a route comes out as a hook', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      env.ctx.boards.mutate(board.id, (state) => {
        const a = createArtifact(state, { type: 'note', x: 0, y: 0 });
        createArtifact(state, { type: 'note', x: 300, y: -400, width: 80, height: 1200 });
        const b = createArtifact(state, { type: 'note', x: 600, y: 0 });
        createArrow(state, { fromId: a.id, toId: b.id, fromSide: 'right', toSide: 'left' });
      });
      const result = await new ToolRegistry()
        .get('board_route_arrows')!
        .run({}, toolContext(env, board.id));
      const data = (
        result as {
          data: {
            hooks?: string[];
            warnings?: string[];
            verdict: string;
            routed: Array<{ hook?: boolean }>;
          };
          mutated?: boolean;
        }
      ).data;
      expect((result as { mutated?: boolean }).mutated).toBe(true);
      expect(data.hooks?.length).toBeGreaterThan(0);
      expect(data.warnings?.join(' ')).toMatch(/крюком/);
      expect(data.verdict).toMatch(/Проблема/);
    } finally {
      void env.dispose();
    }
  });

  it('pins the ports it routed for', async () => {
    const env = makeEnv();
    try {
      const { boardId } = blockedBoard(env);
      await new ToolRegistry().get('board_route_arrows')!.run({}, toolContext(env, boardId));

      const stored = env.ctx.boards.read(boardId, (state) => state.arrows[0]);
      expect(stored.routing).toBe('orthogonal');
      expect(stored.from.side).not.toBe('auto');
      expect(stored.from.offset).toBeTypeOf('number');
      expect(stored.to.offset).toBeTypeOf('number');
    } finally {
      void env.dispose();
    }
  });

  it('drops the routed polyline once a node moves out from under it', async () => {
    const env = makeEnv();
    try {
      const { boardId, arrowId } = blockedBoard(env);
      const registry = new ToolRegistry();
      await registry.get('board_route_arrows')!.run({}, toolContext(env, boardId));
      const before = env.ctx.boards.read(boardId, (s) => s.arrows[0].bends.length);
      expect(env.ctx.boards.read(boardId, (s) => s.arrows[0].routing)).toBe('orthogonal');

      const endpointId = env.ctx.boards.read(boardId, (state) => state.artifacts[0].id);
      const moved = await registry
        .get('artifact_move')!
        .run({ id: endpointId, x: 0, y: 900 }, toolContext(env, boardId));

      const data = (moved as { data: { arrowsReset?: number; note?: string } }).data;
      const stored = env.ctx.boards.read(boardId, (state) =>
        state.arrows.find((a) => a.id === arrowId),
      );
      if (before > 0) {
        expect(data.arrowsReset).toBe(1);
        expect(data.note).toMatch(/board_route_arrows/);
        expect(stored?.bends).toEqual([]);
      }
    } finally {
      void env.dispose();
    }
  });

  it('keeps hand placed bends when a node moves', async () => {
    const env = makeEnv();
    try {
      const { boardId, arrowId } = blockedBoard(env);
      const registry = new ToolRegistry();
      await registry
        .get('arrow_bend_add')!
        .run({ id: arrowId, x: 300, y: 300 }, toolContext(env, boardId));

      const endpointId = env.ctx.boards.read(boardId, (state) => state.artifacts[0].id);
      await registry
        .get('artifact_move')!
        .run({ id: endpointId, x: 0, y: 900 }, toolContext(env, boardId));

      const stored = env.ctx.boards.read(boardId, (state) =>
        state.arrows.find((a) => a.id === arrowId),
      );
      expect(stored?.bends).toEqual([{ x: 300, y: 300 }]);
    } finally {
      void env.dispose();
    }
  });

  it('leaves the result editable by the usual bend tools', async () => {
    const env = makeEnv();
    try {
      const { boardId, arrowId } = blockedBoard(env);
      const registry = new ToolRegistry();
      await registry.get('board_route_arrows')!.run({}, toolContext(env, boardId));
      if (env.ctx.boards.read(boardId, (s) => s.arrows[0].bends.length) === 0) {
        await registry.get('arrow_bend_add')!.run({ id: arrowId, x: 300, y: -40 }, toolContext(env, boardId));
      }

      await registry
        .get('arrow_bend_move')!
        .run({ id: arrowId, index: 0, x: 111, y: 222 }, toolContext(env, boardId));

      const stored = env.ctx.boards.read(boardId, (state) => state.arrows[0]);
      expect(stored.bends[0]).toEqual({ x: 111, y: 222 });
    } finally {
      void env.dispose();
    }
  });
});

describe('board_quality', () => {
  it('scores the board and compares against the previous measurement', async () => {
    const env = makeEnv();
    try {
      const { boardId } = blockedBoard(env);
      const registry = new ToolRegistry();

      const first = await registry.get('board_quality')!.run({}, toolContext(env, boardId));
      const before = (first as { data: { score: number; cost: number; previousCost: number | null; hints: string[] } })
        .data;
      expect(before.previousCost).toBeNull();
      expect(before.cost).toBeGreaterThan(0);
      expect(before.hints.join(' ')).toMatch(/board_route_arrows/);

      // Move the obstacle out of the way: the next measurement must notice.
      const midId = env.ctx.boards.read(boardId, (state) => state.artifacts[1].id);
      await registry
        .get('artifact_update')!
        .run({ id: midId, x: 0, y: 600 }, toolContext(env, boardId));

      const second = await registry.get('board_quality')!.run({}, toolContext(env, boardId));
      const after = (second as { data: { cost: number; improvedBy: number | null } }).data;
      expect(after.cost).toBeLessThan(before.cost);
      expect(after.improvedBy).toBeGreaterThan(0);
    } finally {
      void env.dispose();
    }
  });
});

describe('board_check_intersections', () => {
  it('reports quality, hints and a verdict alongside the findings', async () => {
    const env = makeEnv();
    try {
      const { boardId } = blockedBoard(env);
      const result = await new ToolRegistry()
        .get('board_check_intersections')!
        .run({}, toolContext(env, boardId));

      const data = (
        result as {
          data: {
            ok: boolean;
            quality: { score: number; grade: string };
            verdict: string;
            hints: string[];
            findings: Array<{ kind: string }>;
          };
        }
      ).data;

      expect(data.ok).toBe(false);
      expect(data.quality.score).toBeLessThan(100);
      expect(data.verdict).toMatch(/board_route_arrows/);
      expect(data.findings.some((f) => f.kind === 'arrow_artifact')).toBe(true);
    } finally {
      void env.dispose();
    }
  });
});

describe('board_clean_arrows', () => {
  it('writes away a leftover whisker after a node was nudged', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      const arrowId = env.ctx.boards.mutate(board.id, (state) => {
        const a = createArtifact(state, { type: 'note', x: 0, y: 0 });
        const b = createArtifact(state, { type: 'note', x: 500, y: 0 });
        const arrow = createArrow(state, {
          fromId: a.id,
          toId: b.id,
          fromSide: 'right',
          toSide: 'left',
          fromOffset: 0.5,
          toOffset: 0.5,
          routing: 'orthogonal',
          bends: [{ x: 300, y: 20 }],
        });
        return arrow.id;
      });

      const result = await new ToolRegistry()
        .get('board_clean_arrows')!
        .run({}, toolContext(env, board.id));
      const data = (
        result as {
          data: { changed: number; bendsRemoved: number; cleaned: Array<{ after: number }> };
          mutated?: boolean;
        }
      ).data;

      expect((result as { mutated?: boolean }).mutated).toBe(true);
      expect(data.changed).toBe(1);
      expect(data.bendsRemoved).toBeGreaterThan(0);

      const stored = env.ctx.boards.read(board.id, (s) => s.arrows.find((a) => a.id === arrowId));
      expect(stored?.bends.some((b) => b.y === 20)).toBe(false);
    } finally {
      void env.dispose();
    }
  });
});

describe('arrow ports', () => {
  it('pins a port when an offset is given and frees it on -1', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      const ids = env.ctx.boards.mutate(board.id, (state) => {
        const a = createArtifact(state, { type: 'note', x: 0, y: 0 });
        const b = createArtifact(state, { type: 'note', x: 500, y: 0 });
        return { a: a.id, b: b.id };
      });

      const registry = new ToolRegistry();
      const created = await registry.get('arrow_create')!.run(
        { fromId: ids.a, toId: ids.b, fromSide: 'right', toSide: 'left', fromOffset: 0.25 },
        toolContext(env, board.id),
      );
      const arrowId = (created as { data: { id: string } }).data.id;
      expect(env.ctx.boards.read(board.id, (s) => s.arrows[0].from.offset)).toBe(0.25);

      await registry
        .get('arrow_update')!
        .run({ id: arrowId, fromOffset: -1 }, toolContext(env, board.id));
      expect(env.ctx.boards.read(board.id, (s) => s.arrows[0].from.offset)).toBeUndefined();
    } finally {
      void env.dispose();
    }
  });

  it('repairs a flat approach with a perpendicular bend instead of refusing', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      const ids = env.ctx.boards.mutate(board.id, (state) => {
        const a = createArtifact(state, { type: 'note', x: 0, y: 0 });
        const b = createArtifact(state, { type: 'note', x: 300, y: 200 });
        return { a: a.id, b: b.id };
      });
      const registry = new ToolRegistry();

      const repaired = await registry.get('arrow_create')!.run(
        { fromId: ids.a, toId: ids.b, fromSide: 'right', toSide: 'left' },
        toolContext(env, board.id),
      );
      const repairedData = repaired.data as { adjustments?: string[]; bends?: unknown[] };
      expect(repaired.mutated).toBe(true);
      expect(repairedData.adjustments?.join(' ')).toMatch(/плашмя/);
      expect(env.ctx.boards.read(board.id, (s) => s.arrows)).toHaveLength(1);
      // The stored polyline now meets the side head-on.
      expect(env.ctx.boards.read(board.id, (s) => s.arrows[0].bends.length)).toBeGreaterThan(0);

      env.ctx.boards.mutate(board.id, (state) => {
        state.arrows = [];
        return null;
      });

      const created = await registry.get('arrow_create')!.run(
        {
          fromId: ids.a,
          toId: ids.b,
          fromSide: 'right',
          toSide: 'left',
          bends: [
            { x: 270, y: 90 },
            { x: 270, y: 290 },
          ],
        },
        toolContext(env, board.id),
      );
      expect(created.mutated).toBe(true);
      expect((created.data as { id?: string }).id).toMatch(/^arr_/);
      expect(env.ctx.boards.read(board.id, (s) => s.arrows)).toHaveLength(1);
    } finally {
      void env.dispose();
    }
  });

  it('moves an outgoing port off a pixel that already carries an incoming one', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      const ids = env.ctx.boards.mutate(board.id, (state) => {
        const mid = createArtifact(state, { type: 'note', x: 200, y: 200 });
        const src = createArtifact(state, { type: 'note', x: 500, y: 200 });
        const dst = createArtifact(state, { type: 'note', x: 700, y: 200 });
        createArrow(state, {
          fromId: src.id,
          toId: mid.id,
          fromSide: 'left',
          toSide: 'right',
          fromOffset: 0.5,
          toOffset: 0.5,
        });
        return { mid: mid.id, dst: dst.id };
      });
      const registry = new ToolRegistry();
      const created = await registry.get('arrow_create')!.run(
        {
          fromId: ids.mid,
          toId: ids.dst,
          fromSide: 'right',
          toSide: 'left',
          fromOffset: 0.5,
          toOffset: 0.5,
        },
        toolContext(env, board.id),
      );
      const data = created.data as { adjustments?: string[] };
      expect(created.mutated).toBe(true);
      expect(data.adjustments?.join(' ')).toMatch(/занята|перенесён/);
      expect(env.ctx.boards.read(board.id, (s) => s.arrows)).toHaveLength(2);

      // The repaired port really is clear of the incoming one.
      const report = env.ctx.boards.read(board.id, (s) =>
        checkIntersections(s.artifacts, s.arrows),
      );
      expect(report.counts.arrowSharedPort).toBe(0);
    } finally {
      void env.dispose();
    }
  });
});

describe('artifact overlap and placements', () => {
  it('creates a whole set of blocks in one call, skipping only the one that clashes', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      env.ctx.boards.mutate(board.id, (state) => {
        createArtifact(state, { type: 'note', x: 1000, y: 0 });
      });
      const result = await new ToolRegistry().get('artifact_create')!.run(
        {
          items: [
            { type: 'note', x: 0, y: 0, props: { text: 'один' } },
            { type: 'note', x: 300, y: 0, props: { text: 'два' } },
            // Straight on top of the block already parked at (1000, 0).
            { type: 'note', x: 1000, y: 0, props: { text: 'три' } },
          ],
        },
        toolContext(env, board.id),
      );
      const data = (result as { data: Record<string, unknown> }).data;
      expect(data.created).toBe(2);
      expect((data.blocked as unknown[]) ?? []).toHaveLength(1);
      expect(env.ctx.boards.read(board.id, (s2) => s2.artifacts.length)).toBe(3);
    } finally {
      void env.dispose();
    }
  });

  it('creates many arrows in one call, repairing each port as if it were alone', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      const ids = env.ctx.boards.mutate(board.id, (state) => [
        createArtifact(state, { type: 'note', x: 0, y: 0 }).id,
        createArtifact(state, { type: 'note', x: 500, y: 0 }).id,
        createArtifact(state, { type: 'note', x: 500, y: 400 }).id,
      ]);
      const result = await new ToolRegistry().get('arrow_create')!.run(
        {
          links: [
            { fromId: ids[0], toId: ids[1], label: 'вправо' },
            { fromId: ids[0], toId: ids[2], label: 'вниз' },
            { fromId: ids[0], toId: 'art_missing' },
          ],
        },
        toolContext(env, board.id),
      );
      const data = (result as { data: Record<string, unknown> }).data;
      expect(data.created).toBe(2);
      expect((data.blocked as unknown[]) ?? []).toHaveLength(1);
      const arrows = env.ctx.boards.read(board.id, (s2) => s2.arrows);
      expect(arrows).toHaveLength(2);
      // Ports were chosen for each link, not left unset, exactly as a single
      // call would have done.
      expect(arrows.every((a) => a.from.artifactId === ids[0])).toBe(true);
    } finally {
      void env.dispose();
    }
  });

  it('moves a whole row in one call and still reports the one that clashed', async () => {
    // Building a row used to be one call per block, and every call is a model
    // iteration with the whole prompt behind it. A clash on one block must not
    // send the others back for another round trip either.
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      const ids = env.ctx.boards.mutate(board.id, (state) => [
        createArtifact(state, { type: 'note', x: 0, y: 0 }).id,
        createArtifact(state, { type: 'note', x: 400, y: 0 }).id,
        createArtifact(state, { type: 'note', x: 800, y: 0 }).id,
        createArtifact(state, { type: 'note', x: 0, y: 600 }).id,
      ]);

      const result = await new ToolRegistry().get('artifact_move')!.run(
        {
          moves: [
            { id: ids[0], x: 0, y: 1200 },
            { id: ids[1], x: 240, y: 1200 },
            // Straight on top of the block parked at (0, 600).
            { id: ids[2], x: 0, y: 600 },
          ],
        },
        toolContext(env, board.id),
      );
      const data = (result as { data: Record<string, unknown> }).data;

      expect(data.moved).toBe(2);
      expect((data.blocked as unknown[]) ?? []).toHaveLength(1);
      const positions = env.ctx.boards.read(board.id, (s2) =>
        Object.fromEntries(s2.artifacts.map((a) => [a.id, { x: a.x, y: a.y }])),
      );
      expect(positions[ids[0]]).toEqual({ x: 0, y: 1200 });
      expect(positions[ids[1]]).toEqual({ x: 240, y: 1200 });
      // The one that clashed stayed where it was.
      expect(positions[ids[2]]).toEqual({ x: 800, y: 0 });
    } finally {
      void env.dispose();
    }
  });

  it('refuses to create a block on top of another unless acceptOverlap is set', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      env.ctx.boards.mutate(board.id, (state) => {
        createArtifact(state, { type: 'note', x: 0, y: 0, props: { text: 'Уже стоит' } });
      });
      const registry = new ToolRegistry();
      const refused = await registry.get('artifact_create')!.run(
        { type: 'note', x: 20, y: 20 },
        toolContext(env, board.id),
      );
      const data = refused.data as { refused?: boolean; needsConfirmation?: boolean; created?: boolean };
      expect(refused.mutated).toBe(false);
      expect(data.created).toBe(false);
      expect(data.refused).toBe(true);
      expect(data.needsConfirmation).toBe(true);
      expect(env.ctx.boards.read(board.id, (s) => s.artifacts)).toHaveLength(1);

      const forced = await registry.get('artifact_create')!.run(
        { type: 'note', x: 20, y: 20, acceptOverlap: true },
        toolContext(env, board.id),
      );
      expect(forced.mutated).toBe(true);
      expect(env.ctx.boards.read(board.id, (s) => s.artifacts)).toHaveLength(2);
    } finally {
      void env.dispose();
    }
  });

  it('ranks placements without moving the block and prefers the free seat', async () => {
    const env = makeEnv();
    try {
      const board = env.ctx.boards.create();
      const ids = env.ctx.boards.mutate(board.id, (state) => {
        const a = createArtifact(state, { type: 'note', x: 0, y: 0 });
        const b = createArtifact(state, { type: 'note', x: 400, y: 0 });
        createArrow(state, { fromId: a.id, toId: b.id, fromSide: 'right', toSide: 'left' });
        return { b: b.id };
      });
      const result = await new ToolRegistry().get('artifact_rank_placements')!.run(
        {
          id: ids.b,
          placements: [
            { x: 40, y: 0, label: 'на A' },
            { x: 500, y: 0, label: 'справа' },
          ],
        },
        toolContext(env, board.id),
      );
      expect(result.mutated).toBe(false);
      const data = result.data as {
        best: { label: string; x: number };
        verdict: string;
      };
      expect(data.best.label).toBe('справа');
      expect(data.best.x).toBe(500);
      expect(data.verdict).toMatch(/справа/);
      expect(env.ctx.boards.read(board.id, (s) => s.artifacts.find((item) => item.id === ids.b)?.x)).toBe(400);
    } finally {
      void env.dispose();
    }
  });
});
