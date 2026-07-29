import type { BoardEdge, BoardNode, LayoutMode, Vec2 } from '@zmtki/board-schema';
import type { BoardOp } from '@zmtki/protocol';

const PAD = 24;
const HEADER = 36;

export interface LayoutContainer {
  id: string;
  position: Vec2;
  size: { w: number; h: number };
  layout?: { mode?: LayoutMode; gap?: number };
}

/** `flow` is arrange-only (edge-aware); not persisted as NodeLayout.mode. */
export type ArrangeMode = LayoutMode | 'flow';

export interface LayoutOpts {
  mode?: ArrangeMode;
  gap?: number;
  columns?: number;
  /** Edges among children — used by mode=flow to reduce crossings. */
  edges?: ReadonlyArray<Pick<BoardEdge, 'from' | 'to'> | { from: string; to: string }>;
}

/**
 * Computes absolute positions for children inside a frame/group using
 * row/column/grid/stack/flow modes. Ghost nodes are skipped for collision packing.
 */
export function layoutChildren(
  container: LayoutContainer,
  children: BoardNode[],
  opts: LayoutOpts = {}
): { moves: Array<{ id: string; position: Vec2 }>; containerSize: { w: number; h: number } } {
  const mode = opts.mode ?? container.layout?.mode ?? 'column';
  const gap = opts.gap ?? container.layout?.gap ?? 16;
  const packable = children
    .filter((n) => n.visualState !== 'ghost' && !n.hidden)
    .sort((a, b) => {
      const ao = a.layout?.order ?? a.createdAt;
      const bo = b.layout?.order ?? b.createdAt;
      return ao - bo;
    });

  const originX = container.position.x + PAD;
  const originY = container.position.y + PAD + HEADER;
  const moves: Array<{ id: string; position: Vec2 }> = [];

  if (mode === 'free' || packable.length === 0) {
    return {
      moves: [],
      containerSize: container.size
    };
  }

  if (mode === 'flow') {
    return layoutFlow(container, packable, opts.edges ?? [], { gap });
  }

  if (mode === 'stack') {
    let y = originY;
    let maxW = 0;
    for (const node of packable) {
      moves.push({ id: node.id, position: { x: originX, y } });
      y += node.size.h + gap;
      maxW = Math.max(maxW, node.size.w);
    }
    return {
      moves,
      containerSize: {
        w: Math.max(container.size.w, maxW + PAD * 2),
        h: Math.max(container.size.h, y - container.position.y + PAD)
      }
    };
  }

  if (mode === 'row') {
    let x = originX;
    let maxH = 0;
    for (const node of packable) {
      moves.push({ id: node.id, position: { x, y: originY } });
      x += node.size.w + gap;
      maxH = Math.max(maxH, node.size.h);
    }
    return {
      moves,
      containerSize: {
        w: Math.max(container.size.w, x - container.position.x + PAD),
        h: Math.max(container.size.h, maxH + PAD + HEADER + PAD)
      }
    };
  }

  if (mode === 'column') {
    let y = originY;
    let maxW = 0;
    for (const node of packable) {
      moves.push({ id: node.id, position: { x: originX, y } });
      y += node.size.h + gap;
      maxW = Math.max(maxW, node.size.w);
    }
    return {
      moves,
      containerSize: {
        w: Math.max(container.size.w, maxW + PAD * 2),
        h: Math.max(container.size.h, y - container.position.y + PAD)
      }
    };
  }

  // grid
  const columns = Math.max(
    1,
    opts.columns ?? Math.ceil(Math.sqrt(packable.length))
  );
  const colWidth = Math.max(...packable.map((n) => n.size.w)) + gap;
  let x = originX;
  let y = originY;
  let rowHeight = 0;
  let col = 0;
  for (const node of packable) {
    moves.push({ id: node.id, position: { x, y } });
    rowHeight = Math.max(rowHeight, node.size.h);
    col += 1;
    if (col >= columns) {
      col = 0;
      x = originX;
      y += rowHeight + gap;
      rowHeight = 0;
    } else {
      x += colWidth;
    }
  }
  const endY = col === 0 ? y : y + rowHeight + gap;
  return {
    moves,
    containerSize: {
      w: Math.max(container.size.w, columns * colWidth + PAD),
      h: Math.max(container.size.h, endY - container.position.y + PAD)
    }
  };
}

/**
 * Layered left-to-right layout driven by edges. Uses longest-path ranking and
 * a barycenter pass so connected schemes have fewer line crossings and more air.
 */
export function layoutFlow(
  container: LayoutContainer,
  children: BoardNode[],
  edges: ReadonlyArray<Pick<BoardEdge, 'from' | 'to'> | { from: string; to: string }>,
  opts: { gap?: number } = {}
): { moves: Array<{ id: string; position: Vec2 }>; containerSize: { w: number; h: number } } {
  const gap = Math.max(28, opts.gap ?? 40);
  const rankGap = Math.max(72, gap * 2);
  const originX = container.position.x + PAD;
  const originY = container.position.y + PAD + HEADER;

  const ids = new Set(children.map((n) => n.id));
  const byId = new Map(children.map((n) => [n.id, n]));

  const links: Array<{ from: string; to: string }> = [];
  for (const edge of edges) {
    const from = typeof edge.from === 'string' ? edge.from : edge.from.nodeId;
    const to = typeof edge.to === 'string' ? edge.to : edge.to.nodeId;
    if (!from || !to || from === to) continue;
    if (!ids.has(from) || !ids.has(to)) continue;
    links.push({ from, to });
  }

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of ids) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const { from, to } of links) {
    outgoing.get(from)!.push(to);
    incoming.get(to)!.push(from);
  }

  // Longest-path layering (roots = no incoming edges among the set).
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const dfs = (id: string): number => {
    const cached = rank.get(id);
    if (cached !== undefined && !visiting.has(id)) return cached;
    if (visiting.has(id)) return rank.get(id) ?? 0;
    visiting.add(id);
    let best = 0;
    for (const pred of incoming.get(id) ?? []) {
      best = Math.max(best, dfs(pred) + 1);
    }
    visiting.delete(id);
    rank.set(id, best);
    return best;
  };
  for (const id of ids) dfs(id);

  const maxRank = Math.max(0, ...[...rank.values()]);
  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const id of ids) layers[rank.get(id) ?? 0]!.push(id);

  // Stable seed order inside layers.
  for (const layer of layers) {
    layer.sort((a, b) => (byId.get(a)!.createdAt ?? 0) - (byId.get(b)!.createdAt ?? 0));
  }

  // Barycenter heuristic: reorder each layer by average neighbor index.
  const reorder = (layer: string[], neighborOf: (id: string) => string[], other: string[]): void => {
    const index = new Map(other.map((id, i) => [id, i]));
    const seed = new Map(layer.map((id, i) => [id, i]));
    const scored = layer.map((id) => {
      const ns = neighborOf(id)
        .map((n) => index.get(n))
        .filter((v): v is number => v !== undefined);
      const bary = ns.length ? ns.reduce((s, v) => s + v, 0) / ns.length : (seed.get(id) ?? 0);
      return { id, bary };
    });
    scored.sort((a, b) => a.bary - b.bary || (seed.get(a.id) ?? 0) - (seed.get(b.id) ?? 0));
    for (let i = 0; i < layer.length; i += 1) layer[i] = scored[i]!.id;
  };

  for (let pass = 0; pass < 4; pass += 1) {
    for (let r = 1; r < layers.length; r += 1) {
      reorder(layers[r]!, (id) => incoming.get(id) ?? [], layers[r - 1]!);
    }
    for (let r = layers.length - 2; r >= 0; r -= 1) {
      reorder(layers[r]!, (id) => outgoing.get(id) ?? [], layers[r + 1]!);
    }
  }

  const colWidths = layers.map((layer) =>
    layer.length ? Math.max(...layer.map((id) => byId.get(id)!.size.w)) : 0
  );

  const moves: Array<{ id: string; position: Vec2 }> = [];
  let x = originX;
  let maxBottom = originY;

  for (let r = 0; r < layers.length; r += 1) {
    const layer = layers[r]!;
    let y = originY;
    for (const id of layer) {
      const node = byId.get(id)!;
      moves.push({ id, position: { x, y } });
      y += node.size.h + gap;
      maxBottom = Math.max(maxBottom, y);
    }
    x += (colWidths[r] ?? 0) + rankGap;
  }

  return {
    moves,
    containerSize: {
      w: Math.max(container.size.w, x - container.position.x + PAD - rankGap + PAD),
      h: Math.max(container.size.h, maxBottom - container.position.y + PAD)
    }
  };
}

export function relativePosition(
  anchor: BoardNode,
  relation: 'rightOf' | 'leftOf' | 'below' | 'above',
  size: { w: number; h: number },
  gap = 24
): Vec2 {
  switch (relation) {
    case 'rightOf':
      return { x: anchor.position.x + anchor.size.w + gap, y: anchor.position.y };
    case 'leftOf':
      return { x: anchor.position.x - size.w - gap, y: anchor.position.y };
    case 'below':
      return { x: anchor.position.x, y: anchor.position.y + anchor.size.h + gap };
    case 'above':
      return { x: anchor.position.x, y: anchor.position.y - size.h - gap };
  }
}

export function layoutOps(
  container: LayoutContainer,
  children: BoardNode[],
  opts: LayoutOpts = {}
): BoardOp[] {
  const { moves, containerSize } = layoutChildren(container, children, opts);
  const ops: BoardOp[] = [];
  if (moves.length > 0) ops.push({ op: 'moveNodes', moves });
  if (containerSize.w !== container.size.w || containerSize.h !== container.size.h) {
    ops.push({ op: 'resizeNode', id: container.id, size: containerSize });
  }
  return ops;
}

export function childrenOf(nodes: BoardNode[], parentId: string): BoardNode[] {
  return nodes.filter((n) => n.parentId === parentId);
}
