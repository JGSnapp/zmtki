import type { BoardEdge, BoardNode, LayoutMode, Vec2 } from '@zmtki/board-schema';
import type { BoardOp } from '@zmtki/protocol';

const PAD = 24;
/** Clearance under the floating agent name badge so layout never covers it. */
const HEADER = 52;

/** Padding so a group/frame fill wraps members (label strip on top). */
export const WRAP_PAD = { left: 16, right: 16, top: 40, bottom: 16 };

/**
 * Absolute rect that wraps `nodes` with padding. Used for free-layout groups
 * that must follow member positions without restacking them.
 */
export function wrapBounds(
  nodes: readonly BoardNode[],
  pad: { left: number; right: number; top: number; bottom: number } = WRAP_PAD
): { position: Vec2; size: { w: number; h: number } } | undefined {
  if (nodes.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + n.size.w);
    maxY = Math.max(maxY, n.position.y + n.size.h);
  }
  return {
    position: { x: minX - pad.left, y: minY - pad.top },
    size: {
      w: Math.max(80, maxX - minX + pad.left + pad.right),
      h: Math.max(80, maxY - minY + pad.top + pad.bottom)
    }
  };
}

export interface LayoutContainer {
  id: string;
  position: Vec2;
  size: { w: number; h: number };
  layout?: { mode?: LayoutMode; gap?: number };
}

/**
 * Arrange-only modes (not persisted as NodeLayout.mode):
 * - `flow` — layered left→right DAG
 * - `graph` — Mermaid-like layered graph (tb|lr) with air for edge labels
 */
export type ArrangeMode = LayoutMode | 'flow' | 'graph';

export type GraphDirection = 'tb' | 'lr';

export interface LayoutOpts {
  mode?: ArrangeMode;
  /** Shorthand gap for both axes when gapX / gapY omitted. */
  gap?: number;
  /** Horizontal gap (row / grid columns / flow rank spacing). */
  gapX?: number;
  /** Vertical gap (column / stack / grid rows / flow within a rank). */
  gapY?: number;
  columns?: number;
  /** Edges among children — used by mode=flow/graph to reduce crossings. */
  edges?: ReadonlyArray<Pick<BoardEdge, 'from' | 'to'> | { from: string; to: string }>;
  /** Direction for mode=graph (default tb, like Mermaid). */
  direction?: GraphDirection;
}

function resolveGaps(
  opts: LayoutOpts,
  container: LayoutContainer,
  defaults: { gap: number; gapX?: number; gapY?: number }
): { gapX: number; gapY: number; gap: number } {
  const base = opts.gap ?? container.layout?.gap ?? defaults.gap;
  const gapX = opts.gapX ?? defaults.gapX ?? base;
  const gapY = opts.gapY ?? defaults.gapY ?? base;
  return { gapX, gapY, gap: base };
}

/**
 * Computes absolute positions for children inside a frame/group using
 * row/column/grid/stack/flow modes. Ghost nodes are skipped for collision packing.
 */
export function layoutChildren(
  container: LayoutContainer,
  children: BoardNode[],
  opts: LayoutOpts = {}
): {
  moves: Array<{ id: string; position: Vec2 }>;
  containerSize: { w: number; h: number };
  /** Set when the container origin must follow free-layout member bounds. */
  containerPosition?: Vec2;
} {
  const mode = opts.mode ?? container.layout?.mode ?? 'column';
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
    const wrapped = wrapBounds(packable);
    return {
      moves: [],
      // Follow member bbox; never restack children into a line.
      containerSize: wrapped?.size ?? container.size,
      containerPosition: wrapped?.position
    };
  }

  if (mode === 'flow') {
    const { gapX, gapY } = resolveGaps(opts, container, { gap: 80, gapX: 160, gapY: 80 });
    return layoutFlow(container, packable, opts.edges ?? [], { gapX, gapY });
  }

  if (mode === 'graph') {
    const direction = opts.direction === 'lr' ? 'lr' : 'tb';
    // Generous defaults so edge labels ("маскот", "стартер") fit between cards.
    const defaults =
      direction === 'tb'
        ? { gap: 120, gapX: 96, gapY: 140 }
        : { gap: 120, gapX: 160, gapY: 96 };
    const { gapX, gapY } = resolveGaps(opts, container, defaults);
    return layoutGraph(container, packable, opts.edges ?? [], { gapX, gapY, direction });
  }

  const { gapX, gapY } = resolveGaps(opts, container, { gap: 24 });

  if (mode === 'stack') {
    let y = originY;
    let maxW = 0;
    for (const node of packable) {
      moves.push({ id: node.id, position: { x: originX, y } });
      y += node.size.h + gapY;
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
      x += node.size.w + gapX;
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
      y += node.size.h + gapY;
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
  const colWidth = Math.max(...packable.map((n) => n.size.w)) + gapX;
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
      y += rowHeight + gapY;
      rowHeight = 0;
    } else {
      x += colWidth;
    }
  }
  const endY = col === 0 ? y : y + rowHeight + gapY;
  return {
    moves,
    containerSize: {
      w: Math.max(container.size.w, columns * colWidth + PAD),
      h: Math.max(container.size.h, endY - container.position.y + PAD)
    }
  };
}

type EdgeLink = { from: string; to: string };

function normalizeLinks(
  children: BoardNode[],
  edges: ReadonlyArray<Pick<BoardEdge, 'from' | 'to'> | { from: string; to: string }>
): {
  ids: Set<string>;
  byId: Map<string, BoardNode>;
  layers: string[][];
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
} {
  const ids = new Set(children.map((n) => n.id));
  const byId = new Map(children.map((n) => [n.id, n]));

  const links: EdgeLink[] = [];
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

  for (const layer of layers) {
    layer.sort((a, b) => (byId.get(a)!.createdAt ?? 0) - (byId.get(b)!.createdAt ?? 0));
  }

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

  return { ids, byId, layers, outgoing, incoming };
}

/**
 * Layered left-to-right layout driven by edges (pipeline / DAG).
 */
export function layoutFlow(
  container: LayoutContainer,
  children: BoardNode[],
  edges: ReadonlyArray<Pick<BoardEdge, 'from' | 'to'> | { from: string; to: string }>,
  opts: { gap?: number; gapX?: number; gapY?: number } = {}
): { moves: Array<{ id: string; position: Vec2 }>; containerSize: { w: number; h: number } } {
  const gap = Math.max(72, opts.gapY ?? opts.gap ?? 80);
  const rankGap = Math.max(140, opts.gapX ?? (opts.gap != null ? Math.max(opts.gap * 2, 160) : 160));
  return placeLayered(container, children, edges, 'lr', gap, rankGap);
}

/**
 * Mermaid-like layered graph: top→bottom (default) or left→right, with extra
 * clearance so edge labels sit between cards instead of overlapping them.
 */
export function layoutGraph(
  container: LayoutContainer,
  children: BoardNode[],
  edges: ReadonlyArray<Pick<BoardEdge, 'from' | 'to'> | { from: string; to: string }>,
  opts: { gap?: number; gapX?: number; gapY?: number; direction?: GraphDirection } = {}
): { moves: Array<{ id: string; position: Vec2 }>; containerSize: { w: number; h: number } } {
  const direction = opts.direction === 'lr' ? 'lr' : 'tb';
  if (direction === 'tb') {
    const rowGap = Math.max(120, opts.gapY ?? opts.gap ?? 140);
    const colGap = Math.max(80, opts.gapX ?? 96);
    return placeLayered(container, children, edges, 'tb', rowGap, colGap);
  }
  const colGap = Math.max(140, opts.gapX ?? opts.gap ?? 160);
  const rowGap = Math.max(80, opts.gapY ?? 96);
  return placeLayered(container, children, edges, 'lr', rowGap, colGap);
}

function placeLayered(
  container: LayoutContainer,
  children: BoardNode[],
  edges: ReadonlyArray<Pick<BoardEdge, 'from' | 'to'> | { from: string; to: string }>,
  direction: GraphDirection,
  /** Spacing along the rank axis between successive layers. */
  rankGap: number,
  /** Spacing between siblings inside one layer. */
  siblingGap: number
): { moves: Array<{ id: string; position: Vec2 }>; containerSize: { w: number; h: number } } {
  const originX = container.position.x + PAD;
  const originY = container.position.y + PAD + HEADER;
  const { byId, layers } = normalizeLinks(children, edges);
  const moves: Array<{ id: string; position: Vec2 }> = [];

  if (direction === 'lr') {
    const colWidths = layers.map((layer) =>
      layer.length ? Math.max(...layer.map((id) => byId.get(id)!.size.w)) : 0
    );
    // Center each column vertically relative to the tallest column.
    const colHeights = layers.map((layer) => {
      if (!layer.length) return 0;
      const sum = layer.reduce((s, id) => s + byId.get(id)!.size.h, 0);
      return sum + siblingGap * Math.max(0, layer.length - 1);
    });
    const tallest = Math.max(0, ...colHeights);

    let x = originX;
    let maxBottom = originY;
    let maxRight = originX;
    for (let r = 0; r < layers.length; r += 1) {
      const layer = layers[r]!;
      let y = originY + Math.max(0, (tallest - (colHeights[r] ?? 0)) / 2);
      for (const id of layer) {
        const node = byId.get(id)!;
        moves.push({ id, position: { x, y } });
        y += node.size.h + siblingGap;
        maxBottom = Math.max(maxBottom, y);
        maxRight = Math.max(maxRight, x + node.size.w);
      }
      x += (colWidths[r] ?? 0) + rankGap;
    }
    return {
      moves,
      containerSize: {
        w: Math.max(container.size.w, maxRight - container.position.x + PAD),
        h: Math.max(container.size.h, maxBottom - container.position.y + PAD)
      }
    };
  }

  // Top → bottom (Mermaid default): ranks are rows, siblings go left→right.
  const rowHeights = layers.map((layer) =>
    layer.length ? Math.max(...layer.map((id) => byId.get(id)!.size.h)) : 0
  );
  const rowWidths = layers.map((layer) => {
    if (!layer.length) return 0;
    const sum = layer.reduce((s, id) => s + byId.get(id)!.size.w, 0);
    return sum + siblingGap * Math.max(0, layer.length - 1);
  });
  const widest = Math.max(0, ...rowWidths);

  let y = originY;
  let maxRight = originX;
  let maxBottom = originY;
  for (let r = 0; r < layers.length; r += 1) {
    const layer = layers[r]!;
    let x = originX + Math.max(0, (widest - (rowWidths[r] ?? 0)) / 2);
    for (const id of layer) {
      const node = byId.get(id)!;
      moves.push({ id, position: { x, y } });
      x += node.size.w + siblingGap;
      maxRight = Math.max(maxRight, x);
      maxBottom = Math.max(maxBottom, y + node.size.h);
    }
    y += (rowHeights[r] ?? 0) + rankGap;
  }

  return {
    moves,
    containerSize: {
      w: Math.max(container.size.w, maxRight - container.position.x + PAD),
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
  const { moves, containerSize, containerPosition } = layoutChildren(container, children, opts);
  const ops: BoardOp[] = [];
  if (moves.length > 0) ops.push({ op: 'moveNodes', moves });
  if (
    containerPosition &&
    (containerPosition.x !== container.position.x || containerPosition.y !== container.position.y)
  ) {
    ops.push({ op: 'moveNodes', moves: [{ id: container.id, position: containerPosition }] });
  }
  if (containerSize.w !== container.size.w || containerSize.h !== container.size.h) {
    ops.push({ op: 'resizeNode', id: container.id, size: containerSize });
  }
  return ops;
}

export function childrenOf(nodes: BoardNode[], parentId: string): BoardNode[] {
  return nodes.filter((n) => n.parentId === parentId);
}
