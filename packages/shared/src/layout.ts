/**
 * Layered graph layout (Sugiyama-style) over artifacts that are already on the
 * board.
 *
 * Why this exists: measurements on real boards showed that after a bad node
 * placement the router is helpless — 12 arrows between 11 nodes produced 50
 * crossings, and no routing parameter moved that number. Crossings are decided
 * by the order of nodes inside a layer, and that is a placement problem.
 *
 * The module only computes coordinates. It never creates, deletes or resizes
 * anything, and it deliberately keeps the agent in charge: the agent chooses
 * which nodes take part, the direction, the groups and the spacing.
 */
import type { Arrow, Artifact, Rect, Vec2 } from './artifacts.js';
import { boundsOf, rectsIntersect, type FixedSide } from './geometry.js';
import { searchPorts, type PortSearchOptions } from './ports.js';
import { boardQuality, type LayoutQuality } from './quality.js';
import { routeArrows, tooTightToRoute } from './routing.js';

export type LayoutDirection = 'LR' | 'TB' | 'RL' | 'BT';

export interface LayoutSpacing {
  /** Air between neighbours inside one layer. */
  node: number;
  /** Air between two consecutive layers. */
  layer: number;
  /** Extra air inserted between two different groups inside a layer. */
  group: number;
}

/**
 * Floors, not defaults. Real spacing is derived from the size of the nodes
 * being laid out: a fixed 220px between layers is sane for a 180px-tall note
 * and absurd for a 60px chip, and on the bench the gaps came out four to ten
 * times the size of the blocks themselves.
 */
// The layer floor is not arbitrary: a route leaves a port along a 72px stub
// (PORT_STUB) and then needs at least MIN_EDGE=24px to turn. At exactly 96 the
// router has no room and emits short jogs, so the floor sits above that.
export const MIN_SPACING: LayoutSpacing = { node: 44, layer: 130, group: 120 };

/**
 * Gap as a fraction of the node extent it separates. Exported so the bench can
 * sweep it: how much air a graph needs is a measured question, not a constant.
 *
 * A layer gap of 1.15 put more than a block width between columns of blocks,
 * which is what made the compositions read as scattered. Swept against the one
 * thing the metric cannot see — the area the drawing eats — 0.7 came out 22%
 * tighter with fewer crossings than before.
 */
export const SPACING_RATIO = { node: 0.4, layer: 0.7, group: 0.8 };

/** Kept for callers that want the old absolute numbers. */
export const DEFAULT_SPACING: LayoutSpacing = { node: 80, layer: 220, group: 170 };

/**
 * Spacing proportional to the median node, so a diagram of small chips is not
 * blown apart by gaps sized for large cards. Anything the caller passed wins.
 */
const resolveSpacing = (
  nodes: Artifact[],
  horizontal: boolean,
  requested: Partial<LayoutSpacing> = {},
  scale = 1,
): LayoutSpacing => {
  if (nodes.length === 0) return { ...MIN_SPACING, ...requested };
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };
  const along = median(nodes.map((n) => (horizontal ? n.width : n.height)));
  const cross = median(nodes.map((n) => (horizontal ? n.height : n.width)));
  const derived = {
    node: requested.node ?? Math.max(MIN_SPACING.node, cross * SPACING_RATIO.node),
    layer: requested.layer ?? Math.max(MIN_SPACING.layer, along * SPACING_RATIO.layer),
    group: requested.group ?? Math.max(MIN_SPACING.group, cross * SPACING_RATIO.group),
  };
  return {
    node: Math.round(derived.node * scale),
    layer: Math.round(derived.layer * scale),
    group: Math.round(derived.group * scale),
  };
};

export interface LayoutOptions {
  /** Artifacts to lay out. Default: everything touched by the given arrows. */
  nodeIds?: string[];
  direction?: LayoutDirection;
  spacing?: Partial<LayoutSpacing>;
  /** Optional semantic grouping; nodes of one group stay adjacent in a layer. */
  groups?: Array<{ id: string; nodeIds: string[] }>;
  /** Nodes that must not move; the whole result is shifted to respect them. */
  lockIds?: string[];
  /** Top-left of the composition. Default: keep the current top-left. */
  origin?: Vec2;
  /** Layers forced by the caller: node id -> layer index. */
  fixedLayers?: Record<string, number>;
  /** Sweeps of the crossing-reduction heuristic. */
  sweeps?: number;
  /** Multiplier applied to the derived spacing; `arrangeGraph` sweeps it. */
  spacingScale?: number;
  /**
   * Keep one order of themes across every layer, so a group reads as a lane
   * down the whole drawing. Off by default: it constrains the crossing
   * heuristic, and whether that trade is worth it depends on the graph.
   */
  groupBands?: boolean;
}

export interface LayoutNode {
  id: string;
  layer: number;
  order: number;
  x: number;
  y: number;
}

/**
 * Lane centres a multi-layer edge should pass through. `from`/`to` are in the
 * direction the layout used, which is reversed for a back edge.
 */
export interface EdgeWaypoints {
  from: string;
  to: string;
  points: Vec2[];
}

export interface LayoutResult {
  nodes: LayoutNode[];
  /** Reserved lanes for edges that span more than one layer. */
  waypoints: EdgeWaypoints[];
  layers: string[][];
  /** Edge crossings between adjacent layers after ordering. */
  crossings: number;
  /** Crossings before the ordering heuristic ran, for the report. */
  crossingsBefore: number;
  /** Edges that had to be reversed to break a cycle. */
  reversedEdges: Array<[string, string]>;
  bounds: Rect;
  direction: LayoutDirection;
  spacing: LayoutSpacing;
}

interface Edge {
  from: string;
  to: string;
}

const uniq = <T>(values: T[]): T[] => [...new Set(values)];

/** Depth-first cycle breaking: back edges are reversed, not dropped. */
const breakCycles = (nodes: string[], edges: Edge[]): { edges: Edge[]; reversed: Array<[string, string]> } => {
  const out = new Map<string, string[]>(nodes.map((id) => [id, []]));
  for (const edge of edges) out.get(edge.from)?.push(edge.to);

  const state = new Map<string, 0 | 1 | 2>(nodes.map((id) => [id, 0]));
  const reversed: Array<[string, string]> = [];

  const visit = (id: string): void => {
    state.set(id, 1);
    for (const next of out.get(id) ?? []) {
      const mark = state.get(next) ?? 0;
      if (mark === 1) reversed.push([id, next]);
      else if (mark === 0) visit(next);
    }
    state.set(id, 2);
  };
  for (const id of nodes) if (state.get(id) === 0) visit(id);

  const isReversed = new Set(reversed.map(([a, b]) => `${a}->${b}`));
  return {
    edges: edges.map((edge) =>
      isReversed.has(`${edge.from}->${edge.to}`) ? { from: edge.to, to: edge.from } : edge,
    ),
    reversed,
  };
};

/** Longest-path layering: every node sits one layer below its deepest parent. */
const assignLayers = (
  nodes: string[],
  edges: Edge[],
  fixed: Record<string, number> = {},
): Map<string, number> => {
  const parents = new Map<string, string[]>(nodes.map((id) => [id, []]));
  for (const edge of edges) parents.get(edge.to)?.push(edge.from);

  const layer = new Map<string, number>();
  const resolving = new Set<string>();
  const depth = (id: string): number => {
    const forced = fixed[id];
    if (typeof forced === 'number') {
      layer.set(id, forced);
      return forced;
    }
    const known = layer.get(id);
    if (known != null) return known;
    // A residual cycle cannot deepen itself; treat it as a root.
    if (resolving.has(id)) return 0;
    resolving.add(id);
    let value = 0;
    for (const parent of parents.get(id) ?? []) value = Math.max(value, depth(parent) + 1);
    resolving.delete(id);
    layer.set(id, value);
    return value;
  };
  for (const id of nodes) depth(id);

  const min = Math.min(...layer.values());
  for (const [id, value] of layer) layer.set(id, value - min);
  return layer;
};

/** Crossings between two adjacent layers for the current order. */
const countCrossings = (upper: string[], lower: string[], edges: Edge[]): number => {
  const rank = new Map(lower.map((id, index) => [id, index]));
  const pairs: number[] = [];
  for (const id of upper) {
    const targets = edges
      .filter((edge) => edge.from === id && rank.has(edge.to))
      .map((edge) => rank.get(edge.to)!)
      .sort((a, b) => a - b);
    pairs.push(...targets);
  }
  let crossings = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) if (pairs[i] > pairs[j]) crossings += 1;
  }
  return crossings;
};

const totalCrossings = (layers: string[][], edges: Edge[]): number => {
  let total = 0;
  for (let i = 0; i < layers.length - 1; i++) total += countCrossings(layers[i], layers[i + 1], edges);
  return total;
};

const median = (values: number[]): number => {
  if (values.length === 0) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Median heuristic with group cohesion: inside a layer nodes are sorted by the
 * median position of their neighbours, and nodes of one group are kept together
 * so a semantic group reads as one compact blob.
 */
const orderLayers = (
  layers: string[][],
  edges: Edge[],
  groupOf: Map<string, string>,
  sweeps: number,
  bands?: Map<string, number>,
): string[][] => {
  let best = layers.map((layer) => [...layer]);
  let bestScore = totalCrossings(best, edges);
  let current = best.map((layer) => [...layer]);

  const sweep = (down: boolean) => {
    const range = down
      ? Array.from({ length: current.length - 1 }, (_, i) => i + 1)
      : Array.from({ length: current.length - 1 }, (_, i) => current.length - 2 - i);
    for (const index of range) {
      const fixed = current[down ? index - 1 : index + 1];
      const rank = new Map(fixed.map((id, i) => [id, i]));
      const weight = new Map<string, number>();
      for (const id of current[index]) {
        const neighbours = edges
          .filter((edge) => (down ? edge.to === id : edge.from === id))
          .map((edge) => rank.get(down ? edge.from : edge.to))
          .filter((value): value is number => value != null);
        weight.set(id, median(neighbours));
      }
      // Groups move as a block: the group's own weight is the median of its members.
      const groupWeight = new Map<string, number>();
      for (const id of current[index]) {
        const group = groupOf.get(id);
        if (!group) continue;
        const values = current[index]
          .filter((other) => groupOf.get(other) === group)
          .map((other) => weight.get(other) ?? -1)
          .filter((value) => value >= 0);
        groupWeight.set(group, median(values));
      }
      const keyOf = (id: string): number => {
        const group = groupOf.get(id);
        const own = weight.get(id) ?? -1;
        if (group) {
          const shared = groupWeight.get(group);
          if (shared != null && shared >= 0) return shared;
        }
        return own;
      };
      const original = new Map(current[index].map((id, i) => [id, i]));
      current[index] = [...current[index]].sort((a, b) => {
        // Bands: one order of themes for the whole composition, so a subsystem
        // reads as a lane down the drawing instead of a group that jumps from
        // the top of one layer to the bottom of the next.
        if (bands) {
          const ba = bands.get(groupOf.get(a) ?? '') ?? Number.POSITIVE_INFINITY;
          const bb = bands.get(groupOf.get(b) ?? '') ?? Number.POSITIVE_INFINITY;
          if (ba !== bb) return ba - bb;
        }
        const ka = keyOf(a);
        const kb = keyOf(b);
        // A node with no neighbours in the fixed layer keeps its place.
        if (ka < 0 && kb < 0) return original.get(a)! - original.get(b)!;
        if (ka < 0) return 1;
        if (kb < 0) return -1;
        if (ka !== kb) return ka - kb;
        const ga = groupOf.get(a) ?? '';
        const gb = groupOf.get(b) ?? '';
        if (ga !== gb) return ga.localeCompare(gb);
        return original.get(a)! - original.get(b)!;
      });
    }
  };

  for (let i = 0; i < sweeps; i++) {
    sweep(i % 2 === 0);
    const score = totalCrossings(current, edges);
    if (score < bestScore) {
      bestScore = score;
      best = current.map((layer) => [...layer]);
    }
  }
  return best;
};

const isHorizontal = (direction: LayoutDirection): boolean =>
  direction === 'LR' || direction === 'RL';

/**
 * Straightens the layout: each node is pulled towards the median centre of its
 * neighbours, then the layer is re-packed so nothing overlaps and the chosen
 * order is preserved.
 */
const alignWithinLayers = (
  layers: string[][],
  edges: Edge[],
  cross: Map<string, number>,
  size: Map<string, number>,
  groupOf: Map<string, string>,
  spacing: LayoutSpacing,
  passes = 4,
): void => {
  const gapBetween = (a: string, b: string): number =>
    groupOf.get(a) && groupOf.get(a) !== groupOf.get(b) ? spacing.group : spacing.node;

  const repack = (layer: string[]) => {
    for (let i = 1; i < layer.length; i++) {
      const prev = layer[i - 1];
      const id = layer[i];
      const need =
        cross.get(prev)! + size.get(prev)! / 2 + gapBetween(prev, id) + size.get(id)! / 2;
      if (cross.get(id)! < need) cross.set(id, need);
    }
    for (let i = layer.length - 2; i >= 0; i--) {
      const next = layer[i + 1];
      const id = layer[i];
      const limit =
        cross.get(next)! - size.get(next)! / 2 - gapBetween(id, next) - size.get(id)! / 2;
      if (cross.get(id)! > limit) cross.set(id, limit);
    }
  };

  for (let pass = 0; pass < passes; pass++) {
    const down = pass % 2 === 0;
    const order = down
      ? Array.from({ length: layers.length }, (_, i) => i)
      : Array.from({ length: layers.length }, (_, i) => layers.length - 1 - i);
    for (const index of order) {
      for (const id of layers[index]) {
        const neighbours = edges
          .filter((edge) => (down ? edge.to === id : edge.from === id))
          .map((edge) => cross.get(down ? edge.from : edge.to))
          .filter((value): value is number => value != null);
        if (neighbours.length > 0) cross.set(id, median(neighbours));
      }
      repack(layers[index]);
    }
  }
};

/**
 * Straightening pulls nodes towards their neighbours and leaves empty bands
 * across the whole composition. Collapsing a band is a uniform translation of
 * everything past it, so alignment and straight edges survive untouched.
 */
const compactBands = (
  layers: string[][],
  cross: Map<string, number>,
  size: Map<string, number>,
  maxGap: number,
): void => {
  const spans = layers
    .flat()
    .map((id) => ({ lo: cross.get(id)! - size.get(id)! / 2, hi: cross.get(id)! + size.get(id)! / 2 }))
    .sort((a, b) => a.lo - b.lo);
  if (spans.length === 0) return;

  const shifts: Array<{ from: number; by: number }> = [];
  let reach = spans[0].hi;
  for (const span of spans.slice(1)) {
    const gap = span.lo - reach;
    if (gap > maxGap) shifts.push({ from: span.lo, by: gap - maxGap });
    reach = Math.max(reach, span.hi);
  }
  if (shifts.length === 0) return;

  for (const id of layers.flat()) {
    const centre = cross.get(id)!;
    const lo = centre - size.get(id)! / 2;
    const by = shifts.filter((shift) => lo >= shift.from - 0.5).reduce((sum, s) => sum + s.by, 0);
    cross.set(id, centre - by);
  }
};

/**
 * Lays out `nodeIds` as a layered graph using the arrows already on the board.
 * Returns coordinates only — applying them is the caller's job.
 */
export const layoutGraph = (
  artifacts: Artifact[],
  arrows: Arrow[],
  options: LayoutOptions = {},
): LayoutResult => {
  const direction = options.direction ?? 'LR';
  const byId = new Map(artifacts.map((a) => [a.id, a]));

  const requested = options.nodeIds?.filter((id) => byId.has(id));
  // Default: every artifact. Leaving unlisted ones in place is almost always
  // wrong — they end up under the block that just moved.
  const nodeIds = requested && requested.length > 0 ? uniq(requested) : artifacts.map((a) => a.id);

  const inSet = new Set(nodeIds);
  const rawEdges: Edge[] = arrows
    .filter((arrow) => inSet.has(arrow.from.artifactId) && inSet.has(arrow.to.artifactId))
    .filter((arrow) => arrow.from.artifactId !== arrow.to.artifactId)
    .map((arrow) => ({ from: arrow.from.artifactId, to: arrow.to.artifactId }));

  const groupOf = new Map<string, string>();
  for (const group of options.groups ?? []) {
    for (const id of group.nodeIds) if (inSet.has(id)) groupOf.set(id, group.id);
  }

  // Nodes with no edges are not part of the flow. Left in the layering they all
  // land in layer 0 and stretch the composition into a strip — on one real
  // board 13 of 23 nodes were edgeless and the aspect ratio hit 15:1. They get
  // their own compact block next to the graph instead.
  const touched = new Set(rawEdges.flatMap((e) => [e.from, e.to]));
  const linked = nodeIds.filter((id) => touched.has(id));
  const orphans = nodeIds.filter((id) => !touched.has(id));
  const laid = linked.length > 0 ? linked : nodeIds;
  const asideIds = linked.length > 0 ? orphans : [];

  const spacing = resolveSpacing(
    laid.map((id) => byId.get(id)!),
    isHorizontal(direction),
    options.spacing,
    options.spacingScale ?? 1,
  );

  const { edges, reversed } = breakCycles(laid, rawEdges);
  const layerOf = assignLayers(laid, edges, options.fixedLayers ?? {});

  const depth = Math.max(0, ...layerOf.values()) + 1;

  // An edge spanning several layers has nowhere to go: it is not counted by the
  // crossing heuristic (which only compares neighbouring layers) and no space is
  // reserved for it, so the router drags it straight across the composition.
  // On the densest bench board that produced 0 layout crossings but 24 crossings
  // on the drawn board. Splitting such an edge over dummy nodes gives it a lane
  // in every layer it passes and puts it into the crossing count.
  const chains = new Map<string, string[]>();
  const routedEdges: Edge[] = [];
  const dummyLayer = new Map<string, number>();
  let dummySeq = 0;
  for (const edge of edges) {
    const from = layerOf.get(edge.from) ?? 0;
    const to = layerOf.get(edge.to) ?? 0;
    const step = to > from ? 1 : -1;
    if (Math.abs(to - from) <= 1) {
      routedEdges.push(edge);
      continue;
    }
    const chain: string[] = [];
    let previous = edge.from;
    for (let layer = from + step; layer !== to; layer += step) {
      const id = `__lane_${dummySeq++}`;
      dummyLayer.set(id, layer);
      chain.push(id);
      routedEdges.push({ from: previous, to: id });
      previous = id;
    }
    routedEdges.push({ from: previous, to: edge.to });
    chains.set(`${edge.from}->${edge.to}`, chain);
  }

  const layers: string[][] = Array.from({ length: depth }, () => []);
  // Seed the order by group, so cohesion has something to hold onto.
  for (const id of [...laid].sort((a, b) =>
    (groupOf.get(a) ?? '~').localeCompare(groupOf.get(b) ?? '~'),
  )) {
    layers[layerOf.get(id) ?? 0].push(id);
  }
  for (const [id, layer] of dummyLayer) layers[layer].push(id);

  // One band per theme, ordered by where its members naturally fall, so the
  // constraint costs as few crossings as possible.
  let bands: Map<string, number> | undefined;
  if (options.groupBands && (options.groups?.length ?? 0) > 1) {
    const seen = new Map<string, number[]>();
    layers.forEach((layer) =>
      layer.forEach((id, order) => {
        const group = groupOf.get(id);
        if (!group) return;
        if (!seen.has(group)) seen.set(group, []);
        seen.get(group)!.push(order);
      }),
    );
    const ranked = [...seen.entries()]
      .map(([group, orders]) => ({ group, at: median(orders) }))
      .sort((a, b) => a.at - b.at);
    bands = new Map(ranked.map((item, index) => [item.group, index]));
  }

  const crossingsBefore = totalCrossings(layers, routedEdges);
  const ordered = orderLayers(layers, routedEdges, groupOf, options.sweeps ?? 8, bands);
  const crossings = totalCrossings(ordered, routedEdges);

  const horizontal = isHorizontal(direction);
  const alongSize = (a: Artifact) => (horizontal ? a.width : a.height);
  const crossSize = (a: Artifact) => (horizontal ? a.height : a.width);
  /** A lane is just wide enough for a line plus its clearance. */
  const LANE = 28;
  const isLane = (id: string): boolean => dummyLayer.has(id);

  // Position along the flow: one coordinate per layer, sized by its widest node.
  const layerAt: number[] = [];
  let cursor = 0;
  for (const layer of ordered) {
    const extent = Math.max(
      0,
      ...layer.filter((id) => !isLane(id)).map((id) => alongSize(byId.get(id)!)),
    );
    layerAt.push(cursor + extent / 2);
    cursor += extent + spacing.layer;
  }

  const crossCentre = new Map<string, number>();
  const crossExtent = new Map<string, number>();
  for (const layer of ordered) {
    let offset = 0;
    for (const id of layer) {
      const extent = isLane(id) ? LANE : crossSize(byId.get(id)!);
      crossExtent.set(id, extent);
      crossCentre.set(id, offset + extent / 2);
      offset += extent + spacing.node;
    }
  }
  alignWithinLayers(ordered, routedEdges, crossCentre, crossExtent, groupOf, spacing);

  compactBands(ordered, crossCentre, crossExtent, spacing.node * 2);

  const nodes: LayoutNode[] = [];
  /** Centre of every lane, so a long edge can be handed its waypoints. */
  const laneAt = new Map<string, Vec2>();
  ordered.forEach((layer, layerIndex) => {
    layer.forEach((id, order) => {
      const along = layerAt[layerIndex];
      const cross = crossCentre.get(id)!;
      if (isLane(id)) {
        laneAt.set(id, horizontal ? { x: along, y: cross } : { x: cross, y: along });
        return;
      }
      const artifact = byId.get(id)!;
      const x = horizontal ? along - artifact.width / 2 : cross - artifact.width / 2;
      const y = horizontal ? cross - artifact.height / 2 : along - artifact.height / 2;
      nodes.push({ id, layer: layerIndex, order, x, y });
    });
  });

  if (asideIds.length > 0) {
    // A compact grid past the last layer, roughly as deep as the graph itself,
    // so edgeless material reads as a separate block and not as a first layer.
    const graphCross = nodes.length
      ? Math.max(...nodes.map((n) => (horizontal ? n.y + byId.get(n.id)!.height : n.x + byId.get(n.id)!.width))) -
        Math.min(...nodes.map((n) => (horizontal ? n.y : n.x)))
      : 0;
    const cell = Math.max(
      ...asideIds.map((id) => crossSize(byId.get(id)!) + spacing.node),
      spacing.node,
    );
    // At least a square block, at most as deep as the graph: a single file of
    // edgeless cards stretches the composition just as badly as layer 0 did.
    const perColumn = Math.max(
      Math.ceil(Math.sqrt(asideIds.length)),
      Math.min(asideIds.length, Math.floor((graphCross || 0) / cell)),
    );
    // `layerAt` holds layer centres, so the block starts past the far edge of
    // the last layer, not past its middle.
    const lastLayer = ordered[ordered.length - 1] ?? [];
    const lastHalf = lastLayer.length
      ? Math.max(...lastLayer.map((id) => alongSize(byId.get(id)!))) / 2
      : 0;
    const startAlong = (layerAt[layerAt.length - 1] ?? 0) + lastHalf + spacing.group;

    let alongCursor = startAlong;
    let columnWidth = 0;
    asideIds.forEach((id, index) => {
      const artifact = byId.get(id)!;
      const row = index % perColumn;
      if (row === 0 && index > 0) {
        alongCursor += columnWidth + spacing.node;
        columnWidth = 0;
      }
      columnWidth = Math.max(columnWidth, alongSize(artifact));
      const cross = row * cell;
      const x = horizontal ? alongCursor : cross;
      const y = horizontal ? cross : alongCursor;
      nodes.push({ id, layer: layers.length, order: index, x, y });
    });
  }

  // Flip for the reversed directions instead of duplicating the placement code.
  if (direction === 'RL' || direction === 'BT') {
    const span = boundsOf(
      nodes.map((n) => ({ x: n.x, y: n.y, width: byId.get(n.id)!.width, height: byId.get(n.id)!.height })),
    );
    for (const node of nodes) {
      const artifact = byId.get(node.id)!;
      if (direction === 'RL') node.x = span.x * 2 + span.width - node.x - artifact.width;
      else node.y = span.y * 2 + span.height - node.y - artifact.height;
    }
    for (const point of laneAt.values()) {
      if (direction === 'RL') point.x = span.x * 2 + span.width - point.x;
      else point.y = span.y * 2 + span.height - point.y;
    }
  }

  // Anchor: locked nodes win, then an explicit origin, then the old top-left.
  const rects = nodes.map((n) => ({
    x: n.x,
    y: n.y,
    width: byId.get(n.id)!.width,
    height: byId.get(n.id)!.height,
  }));
  const span = boundsOf(rects);
  const lock = (options.lockIds ?? []).find((id) => inSet.has(id));
  let shift: Vec2;
  if (lock) {
    const node = nodes.find((n) => n.id === lock)!;
    const artifact = byId.get(lock)!;
    shift = { x: artifact.x - node.x, y: artifact.y - node.y };
  } else if (options.origin) {
    shift = { x: options.origin.x - span.x, y: options.origin.y - span.y };
  } else {
    const before = boundsOf(nodeIds.map((id) => byId.get(id)!));
    shift = { x: before.x - span.x, y: before.y - span.y };
  }
  for (const node of nodes) {
    node.x = Math.round(node.x + shift.x);
    node.y = Math.round(node.y + shift.y);
  }
  for (const point of laneAt.values()) {
    point.x = Math.round(point.x + shift.x);
    point.y = Math.round(point.y + shift.y);
  }

  const waypoints: EdgeWaypoints[] = [...chains.entries()].map(([key, chain]) => {
    const [from, to] = key.split('->');
    return {
      from,
      to,
      points: chain.map((id) => laneAt.get(id)!).filter(Boolean),
    };
  });

  return {
    nodes,
    waypoints,
    layers: ordered,
    crossings,
    crossingsBefore,
    reversedEdges: reversed,
    bounds: boundsOf(
      nodes.map((n) => ({
        x: n.x,
        y: n.y,
        width: byId.get(n.id)!.width,
        height: byId.get(n.id)!.height,
      })),
    ),
    direction,
    spacing,
  };
};

/**
 * Slides a laid-out block until it no longer touches artifacts that were not
 * part of the layout. Infinite canvas: moving right is always allowed, so this
 * terminates.
 */
export const avoidBystanders = (
  result: LayoutResult,
  artifacts: Artifact[],
  outsiders: Set<string>,
  gap = 120,
): Vec2 => {
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const foreign = artifacts.filter((a) => outsiders.has(a.id));
  if (foreign.length === 0) return { x: 0, y: 0 };

  const rectsAt = (dx: number): Rect[] =>
    result.nodes.map((n) => ({
      x: n.x + dx,
      y: n.y,
      width: byId.get(n.id)!.width,
      height: byId.get(n.id)!.height,
    }));

  let dx = 0;
  for (let attempt = 0; attempt < 64; attempt++) {
    const rects = rectsAt(dx);
    const hit = foreign.find((other) =>
      rects.some((rect) =>
        rectsIntersect(
          { x: rect.x - gap, y: rect.y - gap, width: rect.width + gap * 2, height: rect.height + gap * 2 },
          other,
        ),
      ),
    );
    if (!hit) return { x: dx, y: 0 };
    const span = boundsOf(rects);
    dx += hit.x + hit.width + gap - span.x;
  }
  return { x: dx, y: 0 };
};

/* ------------------------------------------------------------------------- *
 * arrangeGraph: layout + routing + scoring in one step.
 *
 * Layout and routing cannot be judged separately — a placement is only good if
 * the arrows can actually be laid on it. So candidate layouts are routed and
 * scored with the same `boardQuality` the rest of the system uses, and the best
 * one wins. Nothing is written here either; the caller applies the result.
 * ------------------------------------------------------------------------- */

export interface ArrangeOptions extends Omit<LayoutOptions, 'direction'> {
  /** 'auto' tries both flow directions and keeps the one that scores better. */
  direction?: LayoutDirection | 'auto';
  /** Spacing multipliers to try. Wider layouts route better but read worse. */
  spacingSteps?: number[];
  /** Set false to skip the port-attachment search after routing. */
  searchPorts?: boolean;
  /**
   * Work budget for that search. Left alone it uses its own defaults, which are
   * tuned for boards of about a dozen nodes; a caller that knows the graph is
   * large can trade quality for finishing this decade. Ours only — the engine
   * upstream has no such field (see docs/PROVENANCE.md).
   */
  portSearch?: PortSearchOptions;
  /**
   * Pin multi-layer edges to the lanes the layout reserved instead of letting
   * the router find them. Off until it is shown to help: the first attempt made
   * the average penalty worse, see EXPERIMENTS.md A04.
   */
  useLanes?: boolean;
}

export interface ArrangeCandidate {
  direction: LayoutDirection;
  spacingScale: number;
  crossings: number;
  quality: Pick<LayoutQuality, 'score' | 'cost' | 'grade'>;
  routed: boolean;
}

export interface ArrangeResult {
  /** Final positions to apply. */
  artifacts: Artifact[];
  /** Final arrows, already routed for those positions. */
  arrows: Arrow[];
  layout: LayoutResult;
  chosen: ArrangeCandidate;
  candidates: ArrangeCandidate[];
  qualityBefore: Pick<LayoutQuality, 'score' | 'cost' | 'grade'>;
  qualityAfter: Pick<LayoutQuality, 'score' | 'cost' | 'grade'>;
}

/**
 * Median gap to the nearest neighbour, measured in node sizes. This is the
 * "distances are five times the blocks" complaint expressed as a number.
 */
const nearestGapRatio = (artifacts: Artifact[]): number => {
  if (artifacts.length < 2) return 0;
  const ratios: number[] = [];
  for (const a of artifacts) {
    let nearest = Infinity;
    for (const b of artifacts) {
      if (a.id === b.id) continue;
      const dx = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), 0);
      const dy = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height), 0);
      nearest = Math.min(nearest, Math.hypot(dx, dy));
    }
    if (Number.isFinite(nearest)) ratios.push(nearest / Math.max(1, Math.min(a.width, a.height)));
  }
  if (ratios.length === 0) return 0;
  ratios.sort((x, y) => x - y);
  return ratios[ratios.length >> 1];
};

const applyLayout = (artifacts: Artifact[], layout: LayoutResult, shift: Vec2): Artifact[] => {
  const at = new Map(layout.nodes.map((node) => [node.id, node]));
  return artifacts.map((artifact) => {
    const node = at.get(artifact.id);
    return node ? { ...artifact, x: node.x + shift.x, y: node.y + shift.y } : artifact;
  });
};

/**
 * Writes the reserved lane centres onto the arrows that span several layers.
 * The polyline is left orthogonal by inserting the turn between two lanes on
 * the flow axis, which is where a Sugiyama drawing puts it too.
 */
const applyWaypoints = (
  arrows: Arrow[],
  layout: LayoutResult,
  shift: Vec2,
): { arrows: Arrow[]; pinned: Set<string> } => {
  const pinned = new Set<string>();
  if (layout.waypoints.length === 0) return { arrows, pinned };

  const horizontal = layout.direction === 'LR' || layout.direction === 'RL';
  const next = arrows.map((arrow) => {
    const forward = layout.waypoints.find(
      (w) => w.from === arrow.from.artifactId && w.to === arrow.to.artifactId,
    );
    const backward = forward
      ? undefined
      : layout.waypoints.find(
          (w) => w.to === arrow.from.artifactId && w.from === arrow.to.artifactId,
        );
    const match = forward ?? backward;
    if (!match || match.points.length === 0) return arrow;

    const lane = match.points.map((point) => ({ x: point.x + shift.x, y: point.y + shift.y }));
    const points = backward ? [...lane].reverse() : lane;
    pinned.add(arrow.id);
    return {
      ...arrow,
      bends: points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })),
      routing: 'orthogonal' as const,
      from: { ...arrow.from, side: (horizontal ? 'right' : 'bottom') as FixedSide, offset: undefined },
      to: { ...arrow.to, side: (horizontal ? 'left' : 'top') as FixedSide, offset: undefined },
    };
  });
  return { arrows: next, pinned };
};

const applyRouted = (arrows: Arrow[], routed: ReturnType<typeof routeArrows>['routed']): Arrow[] =>
  arrows.map((arrow) => {
    const match = routed.find((item) => item.arrowId === arrow.id);
    if (!match) return arrow;
    return {
      ...arrow,
      bends: match.bends,
      routing: 'orthogonal' as const,
      // Marks the attachment as the router's, so the port search may move it
      // and a later node move knows to release it.
      autoPorts: true,
      from: { ...arrow.from, side: match.fromSide, offset: match.fromOffset },
      to: { ...arrow.to, side: match.toSide, offset: match.toOffset },
    };
  });

export const arrangeGraph = (
  artifacts: Artifact[],
  arrows: Arrow[],
  options: ArrangeOptions = {},
): ArrangeResult => {
  const before = boardQuality(artifacts, arrows);
  const directions: LayoutDirection[] =
    !options.direction || options.direction === 'auto'
      ? ['LR', 'TB']
      : [options.direction as LayoutDirection];
  // The derived spacing is a floor, not an answer: how much air a particular
  // graph needs is decided by scoring, not by a constant.
  // The steps used to run 1 to 1.9: the search could only inflate, never
  // squeeze, and since `boardQuality` has no notion of compactness, air was
  // free — it only ever removed penalties. Measured over 45 boards, letting it
  // squeeze as well took the area down 22% and the crossings from 16 to 13,
  // for two tenths of a penalty point.
  const scales = options.spacingSteps ?? [0.7, 0.85, 1, 1.3];
  const participating = new Set(
    options.nodeIds && options.nodeIds.length > 0 ? options.nodeIds : artifacts.map((a) => a.id),
  );
  const outsiders = new Set(artifacts.map((a) => a.id).filter((id) => !participating.has(id)));

  const candidates: ArrangeCandidate[] = [];
  let best: { result: ArrangeResult; cost: number } | null = null;

  for (const direction of directions) {
    for (const scale of scales) {
      const layout = layoutGraph(artifacts, arrows, {
        ...options,
        direction,
        spacingScale: scale,
      });
      const shift = avoidBystanders(layout, artifacts, outsiders);
      const moved = applyLayout(artifacts, layout, shift);

      // Long edges follow the lanes the layout reserved for them. They are then
      // held out of the router: `routeArrows` treats arrows it is not re-laying
      // as occupied corridors, so the short edges are routed around them
      // instead of through them.
      const laned = options.useLanes
        ? applyWaypoints(arrows, layout, shift)
        : { arrows, pinned: new Set<string>() };
      const freeIds = arrows
        .filter((arrow) => !laned.pinned.has(arrow.id))
        .map((arrow) => arrow.id);

      const gate = tooTightToRoute(moved, laned.arrows, freeIds);
      let nextArrows = laned.arrows;
      let routed = false;
      if (gate.ready) {
        const outcome = routeArrows(moved, laned.arrows, { arrowIds: freeIds });
        if (!outcome.refused) {
          nextArrows = applyRouted(laned.arrows, outcome.routed);
          routed = true;
          // Which side and which point of a node an arrow takes is decided once
          // per arrow and never revisited, and two thirds of the crossings left
          // on the bench boards were between arrows meeting at one node. Trying
          // other attachment orders removes about a quarter of them.
          if (options.searchPorts !== false) {
            const searched = searchPorts(moved, nextArrows, {
              ...options.portSearch,
              lockedArrowIds: nextArrows.filter((a) => !a.autoPorts).map((a) => a.id),
            });
            if (searched.costAfter < searched.costBefore) nextArrows = searched.arrows;
          }
        }
      }
      const quality = boardQuality(moved, nextArrows);
      const candidate: ArrangeCandidate = {
        direction,
        spacingScale: scale,
        crossings: layout.crossings,
        quality: { score: quality.score, cost: quality.cost, grade: quality.grade },
        routed,
      };
      candidates.push(candidate);

      // `boardQuality` knows nothing about proportions or emptiness, and it
      // rewards air: more space means fewer clearance and crossing penalties,
      // so on its own the search always picks the widest variant. Two shape
      // terms balance that. They only break near-ties — a real defect still
      // outweighs them.
      const span = boundsOf(moved);
      const ratio = span.height > 0 ? span.width / span.height : 1;
      const stretch = Math.max(ratio, ratio > 0 ? 1 / ratio : 1);
      const selection =
        quality.cost +
        // A composition stretched past 1:2.5 without reason reads badly, and
        // the penalty has to grow with the stretch: a flat rate of four per
        // unit left a 1:8 ribbon costing only twenty-two, which any routing
        // detail outweighed. Squared, 1:8 costs about a hundred and fifty.
        Math.max(0, stretch - 2.5) * 4 +
        // Gaps wider than about 1.5 blocks make the drawing feel scattered.
        Math.max(0, nearestGapRatio(moved) - 1.5) * 9;

      if (!best || selection < best.cost) {
        best = {
          cost: selection,
          result: {
            artifacts: moved,
            arrows: nextArrows,
            layout,
            chosen: candidate,
            candidates,
            qualityBefore: { score: before.score, cost: before.cost, grade: before.grade },
            qualityAfter: { score: quality.score, cost: quality.cost, grade: quality.grade },
          },
        };
      }
    }
  }

  if (!best) {
    throw new Error('arrangeGraph: no candidate produced');
  }
  best.result.candidates = candidates;
  return best.result;
};
