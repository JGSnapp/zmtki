import type { Arrow, Artifact, Rect, Vec2 } from './artifacts.js';
import {
  FIXED_SIDES,
  MIN_EDGE,
  MIN_PORT_ANGLE_DEG,
  approachLength,
  anchorPoint,
  boundsOf,
  centerOf,
  collectIntendedPorts,
  computeArrowGeometries,
  ensureHeadOnBends,
  findMixedPortConflict,
  freePortOffset,
  inspectRawPortAngles,
  offsetFromPoint,
  outwardNormal,
  rectsIntersect,
  resolveSide,
  tidyOrthogonal,
  type FixedSide,
} from './geometry.js';
import { boardQuality } from './quality.js';

export interface RouteOptions {
  /** Distance from artifact boxes at which routing corridors are placed. */
  margin?: number;
  /** Hard no-go padding around artifacts. */
  clearance?: number;
  /** Extra cost per 90° turn, in pixels. */
  turnPenalty?: number;
  /**
   * Cost per pixel of running alongside an already routed arrow. Keep it near
   * 1: at that level avoiding an overlap is worth exactly as much of a detour
   * as the overlap is long, which is the honest trade. Higher values buy
   * absurd loops around whole boxes to dodge a short shared stretch.
   */
  overlapPenalty?: number;
  /** Cost of crossing an already routed arrow. */
  crossPenalty?: number;
  /**
   * Give every port a point of its own, instead of letting two arrows that
   * leave the same side share one. Off by default — see `freePortOffset`, where
   * the measurement is. Worth switching on when a single arrow is being re-laid
   * and the stub it shares with a neighbour is what is being paid for.
   */
  spreadPorts?: boolean;
  /** Route only these arrows; default is every arrow on the board. */
  arrowIds?: string[];
  /**
   * Parallel lanes carved into every wide gap. Defaults to a value scaled by
   * the number of arrows being laid, so a busy gap does not collapse into one
   * shared line. Exposed mainly for experiments.
   */
  lanesPerGap?: number;
  /**
   * Grid lines outside the composition, so a route can go around it instead of
   * through it. Without them the only line beyond the outermost box sits at
   * `margin`, which is usually unusable, and the search has no way to express
   * "around the right-hand side" — raising `crossPenalty` twenty-five-fold left
   * the number of crossings unchanged because the alternative did not exist.
   */
  outerRings?: number;
  /** A polyline run shorter than this counts as a wobble, not a turn. */
  jogLength?: number;
  /** Cost of one such wobble. */
  jogPenalty?: number;
}

export interface RoutedArrow {
  arrowId: string;
  bends: Vec2[];
  /**
   * Ports the route was built for. They have to be pinned: an `auto` side is
   * resolved from the first bend, so writing bends without fixing the ports
   * would make the next render pick different ones and bend the polyline into
   * a diagonal.
   */
  fromSide: FixedSide;
  toSide: FixedSide;
  fromOffset: number;
  toOffset: number;
  /** True when the search failed and a plain L-shaped fallback was used. */
  fallback: boolean;
  /**
   * Set when the ports themselves sit inside another box: no route can be
   * clean until the nodes are moved apart.
   */
  crowded?: boolean;
  /** True when the polyline is a long hook: much longer than the straight run, or it leaves the composition. */
  hook?: boolean;
  /** Drawn length divided by Manhattan distance between ports. 1 is a straight orthogonal run. */
  detourRatio?: number;
}

export interface RouteResult {
  routed: RoutedArrow[];
  skipped: Array<{ arrowId: string; reason: string }>;
  /** How many distinct laying orders were scored before picking a winner. */
  variantsTried: number;
  /**
   * Set when the layout is too tight to route: overlapping boxes or ports
   * sitting inside a neighbour. Nothing is written.
   */
  refused?: boolean;
  crowded?: string[];
  overlapping?: number;
  note?: string;
}

const DEFAULTS = {
  margin: 24,
  clearance: 8,
  turnPenalty: 120,
  overlapPenalty: 2,
  // A crossing has to be worth a couple of turns before the router accepts it.
  // The old price of 80 sat below the cost of a single turn (`turnPenalty` 120),
  // so cutting through was always cheaper than stepping around.
  //
  // 200 measured on the whole corpus of 66 boards, against the old 80: 27
  // boards better, 2 worse, worst single board +4.3. It beats every other price
  // tried on all four counts at once — 150 wins less and loses harder, 300
  // gains a little average and ruins four boards, one by 12 points. The router
  // lays arrows one after another, so refusing a crossing early can corner the
  // ones that come later; too high a price makes that happen more, not less.
  //
  // Grid rings outside the composition were measured alongside this and turned
  // out to be inert: rings 0, 1 and 2 give byte-identical results at every
  // price. The detour the router actually takes runs between the boxes, not
  // around the outside, so rings only enlarge the grid. Left at 0.
  crossPenalty: 200,
  outerRings: 0,
  jogLength: 64,
  // Cheap insurance: at 400 a wobble has to save more than three turns to be
  // worth drawing. Measured effect is small because most visible wobbles come
  // from nodes that are not aligned, not from the route.
  jogPenalty: 0,
};

/** Above this many artifacts the Hanan grid gets too big for interactive use. */
const MAX_GRID_ARTIFACTS = 140;

const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  width: r.width + by * 2,
  height: r.height + by * 2,
});

const EPS = 1e-6;

const overlapLength = (a1: number, a2: number, b1: number, b2: number): number =>
  Math.max(0, Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2)));

/** Does an axis-aligned segment pass through the interior of a rect? */
const segmentHitsRect = (a: Vec2, b: Vec2, rect: Rect): boolean => {
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  return (
    x1 < rect.x + rect.width - EPS &&
    x2 > rect.x + EPS &&
    y1 < rect.y + rect.height - EPS &&
    y2 > rect.y + EPS
  );
};

const uniqueSorted = (values: number[]): number[] => {
  const sorted = [...new Set(values.map((v) => Math.round(v)))];
  sorted.sort((a, b) => a - b);
  return sorted;
};

/**
 * Pins start/goal onto the Hanan grid and drops any other line that would
 * sit closer than `MIN_EDGE`. Otherwise A* cannot step off the pin and the
 * search falls back to a straight cut through the obstacles.
 */
const mergeGrid = (lines: number[], pins: number[]): number[] => {
  const keep = uniqueSorted(pins);
  const keepSet = new Set(keep);
  return uniqueSorted([...lines, ...keep]).filter(
    (line) => keepSet.has(line) || keep.every((pin) => Math.abs(line - pin) >= MIN_EDGE),
  );
};

/**
 * Perpendicular distance under which two parallel arrows read as one line.
 * Matches the merge tolerance of the intersection detector, so the router
 * optimises for the same thing the quality metric measures.
 */
const LANE_TOLERANCE = 12;

interface Occupied {
  line: number;
  from: number;
  to: number;
}

/**
 * Corridors already taken by other arrows. Lines are bucketed so a lookup can
 * cheaply find not just the identical line but every one close enough to merge
 * with it visually.
 */
class Corridors {
  private readonly horizontal = new Map<number, Occupied[]>();
  private readonly vertical = new Map<number, Occupied[]>();

  add(points: Vec2[]): void {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (Math.abs(a.y - b.y) < EPS) this.push(this.horizontal, a.y, a.x, b.x);
      else if (Math.abs(a.x - b.x) < EPS) this.push(this.vertical, a.x, a.y, b.y);
    }
  }

  /** Pixels this segment would run alongside an arrow that is already drawn. */
  cost(a: Vec2, b: Vec2): number {
    const horizontal = Math.abs(a.y - b.y) < EPS;
    const map = horizontal ? this.horizontal : this.vertical;
    const line = horizontal ? a.y : a.x;
    const from = horizontal ? a.x : a.y;
    const to = horizontal ? b.x : b.y;
    const bucket = Math.floor(line / LANE_TOLERANCE);
    let total = 0;
    for (let k = bucket - 1; k <= bucket + 1; k++) {
      const spans = map.get(k);
      if (!spans) continue;
      for (const span of spans) {
        if (Math.abs(span.line - line) > LANE_TOLERANCE) continue;
        total += overlapLength(from, to, span.from, span.to);
      }
    }
    return total;
  }

  /**
   * How many already drawn arrows this segment cuts across. Everything here is
   * axis aligned, so a crossing is always a perpendicular segment passing
   * strictly through the inside of this one — touching at a shared corner does
   * not count.
   */
  crossings(a: Vec2, b: Vec2): number {
    const horizontal = Math.abs(a.y - b.y) < EPS;
    // A horizontal segment can only be crossed by a vertical one.
    const map = horizontal ? this.vertical : this.horizontal;
    const line = horizontal ? a.y : a.x;
    const lo = Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y);
    const hi = Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y);
    let count = 0;
    for (let k = Math.floor(lo / LANE_TOLERANCE); k <= Math.floor(hi / LANE_TOLERANCE); k++) {
      const spans = map.get(k);
      if (!spans) continue;
      for (const span of spans) {
        const inside = span.line > lo + EPS && span.line < hi - EPS;
        const spans_it = span.from < line - EPS && span.to > line + EPS;
        if (inside && spans_it) count++;
      }
    }
    return count;
  }

  private push(map: Map<number, Occupied[]>, line: number, v1: number, v2: number): void {
    const entry: Occupied = { line, from: Math.min(v1, v2), to: Math.max(v1, v2) };
    const bucket = Math.floor(line / LANE_TOLERANCE);
    const list = map.get(bucket);
    if (list) list.push(entry);
    else map.set(bucket, [entry]);
  }
}

/** Minimal binary heap keyed by f-score. */
class Heap {
  private readonly items: Array<{ key: number; f: number }> = [];

  push(key: number, f: number): void {
    this.items.push({ key, f });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].f <= this.items[i].f) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }

  pop(): number | null {
    if (this.items.length === 0) return null;
    const top = this.items[0];
    const last = this.items.pop() as { key: number; f: number };
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let best = i;
        if (left < this.items.length && this.items[left].f < this.items[best].f) best = left;
        if (right < this.items.length && this.items[right].f < this.items[best].f) best = right;
        if (best === i) break;
        [this.items[best], this.items[i]] = [this.items[i], this.items[best]];
        i = best;
      }
    }
    return top.key;
  }

  get size(): number {
    return this.items.length;
  }
}

/** Spacing between parallel lanes inside one corridor. */
const LANE_PITCH = 28;
const MAX_LANES_PER_GAP = 4;
/** Keeps the Hanan grid small enough for the A* search to stay interactive. */
const MAX_LINES_PER_AXIS = 110;

/** Lanes closer than this read as the same line, so they are not worth having. */
const MIN_LANE_PITCH = MIN_EDGE;

/** Keeps the first of every cluster of lines that sit on top of each other. */
const spread = (lines: number[], pitch: number): number[] => {
  const out: number[] = [];
  for (const line of lines) {
    if (out.length > 0 && line - out[out.length - 1] < pitch) continue;
    out.push(line);
  }
  return out;
};

/** Drops every other line until the axis fits, keeping the outer ones. */
const thin = (lines: number[], limit: number): number[] => {
  if (lines.length <= limit) return lines;
  const step = Math.ceil(lines.length / limit);
  const kept = lines.filter((_, i) => i % step === 0);
  const last = lines[lines.length - 1];
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept;
};

/**
 * Grid lines for one axis: a corridor on either side of every box, then a few
 * parallel lanes inside every wide gap so arrows sharing a corridor can pick
 * different lines instead of merging into one.
 *
 * Lines on the box edges are deliberately absent — they make routes hug the
 * boxes instead of using the free space, and they are the main source of
 * pointless little jogs.
 */
const corridorLines = (
  spans: Array<[number, number]>,
  margin: number,
  lanesPerGap: number = MAX_LANES_PER_GAP,
): number[] => {
  const edges = uniqueSorted(spans.flatMap(([lo, hi]) => [lo - margin, hi + margin]));
  const lines = [...edges];
  for (let i = 1; i < edges.length; i++) {
    const gap = edges[i] - edges[i - 1];
    const lanes = Math.min(lanesPerGap, Math.floor(gap / LANE_PITCH) - 1);
    for (let lane = 1; lane <= lanes; lane++) {
      lines.push(Math.round(edges[i - 1] + (gap * lane) / (lanes + 1)));
    }
  }
  return thin(spread(uniqueSorted(lines), MIN_LANE_PITCH), MAX_LINES_PER_AXIS);
};

/**
 * A wide empty gap between two columns has to carry every arrow that crosses
 * it. With a fixed handful of lanes they all end up on the same line and merge
 * into one bus — the single most common defect on real boards. Scale the lanes
 * with the number of arrows actually being laid.
 */
const lanesFor = (arrowCount: number): number =>
  Math.min(16, Math.max(MAX_LANES_PER_GAP, Math.ceil(arrowCount * 0.75)));

const samePoint = (a: Vec2 | undefined, b: Vec2): boolean =>
  a != null && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

/**
 * The lead-out stubs are re-created from the ports when the arrow is drawn, so
 * storing them as bends would only litter the arrow with extra handles.
 */
const trimStubs = (path: Vec2[], start: Vec2, goal: Vec2): Vec2[] => {
  if (path.length < 3) return [];
  const from = samePoint(path[0], start) ? 1 : 0;
  const to = samePoint(path[path.length - 1], goal) ? path.length - 1 : path.length;
  return path.slice(from, to);
};

const stubPoint = (
  anchor: Vec2,
  side: FixedSide,
  selfId: string,
  artifacts: Artifact[],
): Vec2 => {
  const n = outwardNormal(side);
  const len = approachLength(anchor, side, selfId, artifacts);
  return { x: Math.round(anchor.x + n.x * len), y: Math.round(anchor.y + n.y * len) };
};

interface CostModel {
  corridors: Corridors;
  turnPenalty: number;
  overlapPenalty: number;
  crossPenalty: number;
}

/** Cost of a finished polyline under the same model the search optimises. */
const pathCost = (points: Vec2[], model: CostModel): number => {
  let total = Math.max(0, points.length - 2) * model.turnPenalty;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    total += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    total += model.corridors.cost(a, b) * model.overlapPenalty;
    total += model.corridors.crossings(a, b) * model.crossPenalty;
  }
  return total;
};

/**
 * The shapes a person would draw by hand: a straight line, one corner, or two
 * corners through a middle line. They are tried explicitly because the grid
 * search can only turn where its lines happen to fall, and a four-bend
 * staircase where two bends would do reads as noise.
 */
const simpleRoutes = (start: Vec2, goal: Vec2): Vec2[][] => {
  const midX = Math.round((start.x + goal.x) / 2);
  const midY = Math.round((start.y + goal.y) / 2);
  const routes: Vec2[][] = [
    [start, goal],
    [start, { x: start.x, y: goal.y }, goal],
    [start, { x: goal.x, y: start.y }, goal],
    [start, { x: midX, y: start.y }, { x: midX, y: goal.y }, goal],
    [start, { x: start.x, y: midY }, { x: goal.x, y: midY }, goal],
  ];
  // Parallel corridors: if a neighbour already sits on the straight run, a
  // 24px shift is cheaper than a hook around the whole composition.
  if (Math.abs(start.y - goal.y) < EPS) {
    for (const delta of [-24, 24, -48, 48]) {
      const y = start.y + delta;
      routes.push([start, { x: start.x, y }, { x: goal.x, y }, goal]);
    }
  }
  if (Math.abs(start.x - goal.x) < EPS) {
    for (const delta of [-24, 24, -48, 48]) {
      const x = start.x + delta;
      routes.push([start, { x, y: start.y }, { x, y: goal.y }, goal]);
    }
  }
  return routes;
};

const SIDE_PAIRS: Array<[FixedSide, FixedSide]> = [
  ['right', 'left'],
  ['left', 'right'],
  ['bottom', 'top'],
  ['top', 'bottom'],
  ['top', 'top'],
  ['bottom', 'bottom'],
  ['left', 'left'],
  ['right', 'right'],
];

const uniquePairs = (pairs: Array<[FixedSide, FixedSide]>): Array<[FixedSide, FixedSide]> => {
  const seen = new Set<string>();
  const out: Array<[FixedSide, FixedSide]> = [];
  for (const pair of pairs) {
    const key = `${pair[0]}>${pair[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  return out;
};

const facingPair = (from: Artifact, to: Artifact): [FixedSide, FixedSide] => [
  resolveSide(from, centerOf(to)),
  resolveSide(to, centerOf(from)),
];

/**
 * When two boxes face each other, both ports can sit on one shared lane
 * inside the overlap. A 10px Z between almost-aligned ports is then a
 * straight wire — if that lane is free.
 */
const facingLanes = (
  from: Artifact,
  fromSide: FixedSide,
  to: Artifact,
  toSide: FixedSide,
  artifacts: Artifact[],
): Array<{ start: Vec2; goal: Vec2 }> => {
  const fromPort = (offset: number) =>
    stubPoint(anchorPoint(from, fromSide, offset), fromSide, from.id, artifacts);
  const toPort = (offset: number) =>
    stubPoint(anchorPoint(to, toSide, offset), toSide, to.id, artifacts);
  const horizontal =
    (fromSide === 'left' || fromSide === 'right') && (toSide === 'left' || toSide === 'right');
  const vertical =
    (fromSide === 'top' || fromSide === 'bottom') && (toSide === 'top' || toSide === 'bottom');

  if (horizontal) {
    const lo = Math.max(from.y, to.y);
    const hi = Math.min(from.y + from.height, to.y + to.height);
    if (hi - lo >= 16) {
      const mid = Math.round((lo + hi) / 2);
      const lanes = [mid];
      for (const delta of [-24, 24, -48, 48, -12, 12]) {
        const y = mid + delta;
        if (y >= lo + 8 && y <= hi - 8) lanes.push(y);
      }
      const x0 = fromPort(0.5).x;
      const x1 = toPort(0.5).x;
      return lanes.map((y) => ({ start: { x: x0, y }, goal: { x: x1, y } }));
    }
  }

  if (vertical) {
    const lo = Math.max(from.x, to.x);
    const hi = Math.min(from.x + from.width, to.x + to.width);
    if (hi - lo >= 16) {
      const mid = Math.round((lo + hi) / 2);
      const lanes = [mid];
      for (const delta of [-24, 24, -48, 48, -12, 12]) {
        const x = mid + delta;
        if (x >= lo + 8 && x <= hi - 8) lanes.push(x);
      }
      const y0 = fromPort(0.5).y;
      const y1 = toPort(0.5).y;
      return lanes.map((x) => ({ start: { x, y: y0 }, goal: { x, y: y1 } }));
    }
  }

  return [{ start: fromPort(0.5), goal: toPort(0.5) }];
};

const axisAligned = (points: Vec2[]): boolean => {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (Math.abs(a.x - b.x) > EPS && Math.abs(a.y - b.y) > EPS) return false;
  }
  return true;
};

/** Plain Z-shaped connection used when the grid search finds nothing. */
const fallbackPath = (start: Vec2, goal: Vec2, startSide: FixedSide): Vec2[] => {
  if (Math.abs(start.x - goal.x) < EPS || Math.abs(start.y - goal.y) < EPS) return [start, goal];
  const horizontalFirst = startSide === 'left' || startSide === 'right';
  const mid = horizontalFirst
    ? { x: Math.round((start.x + goal.x) / 2), y: start.y }
    : { x: start.x, y: Math.round((start.y + goal.y) / 2) };
  const mid2 = horizontalFirst ? { x: mid.x, y: goal.y } : { x: goal.x, y: mid.y };
  return [start, mid, mid2, goal];
};

const pathLength = (points: Vec2[]): number => {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
  }
  return total;
};

const HOOK_RATIO = 1.8;
const OUTSIDE_PAD = 32;

const leavesComposition = (points: Vec2[], artifacts: Artifact[]): boolean => {
  if (artifacts.length === 0) return false;
  const box = boundsOf(artifacts);
  const loX = box.x - OUTSIDE_PAD;
  const loY = box.y - OUTSIDE_PAD;
  const hiX = box.x + box.width + OUTSIDE_PAD;
  const hiY = box.y + box.height + OUTSIDE_PAD;
  return points.some((p) => p.x < loX || p.y < loY || p.x > hiX || p.y > hiY);
};

export interface RoutingGate {
  ready: boolean;
  crowded: string[];
  overlapping: number;
  note: string;
}

/**
 * Routing needs free air around every port. Overlapping boxes or a stub that
 * already sits inside a neighbour cannot be saved by a clever polyline.
 */
export const tooTightToRoute = (
  artifacts: Artifact[],
  arrows: Arrow[],
  arrowIds?: string[],
): RoutingGate => {
  let overlapping = 0;
  for (let i = 0; i < artifacts.length; i++) {
    for (let j = i + 1; j < artifacts.length; j++) {
      if (rectsIntersect(artifacts[i], artifacts[j])) overlapping++;
    }
  }

  const wanted = arrowIds ? new Set(arrowIds) : null;
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const geometries = computeArrowGeometries(artifacts, arrows);
  const inflated = artifacts.map((a) => ({ id: a.id, rect: inflate(a, DEFAULTS.clearance) }));
  const crowded: string[] = [];

  for (const arrow of arrows) {
    if (wanted && !wanted.has(arrow.id)) continue;
    if (arrow.from.artifactId === arrow.to.artifactId) continue;
    const geometry = geometries.get(arrow.id);
    if (!geometry) continue;
    const start = stubPoint(geometry.fromPoint, geometry.fromSide, arrow.from.artifactId, artifacts);
    const goal = stubPoint(geometry.toPoint, geometry.toSide, arrow.to.artifactId, artifacts);
    const ends = new Set([arrow.from.artifactId, arrow.to.artifactId]);
    const clear = (point: Vec2) =>
      !inflated.some((item) => !ends.has(item.id) && segmentHitsRect(point, point, item.rect));

    if (clear(start) && clear(goal)) continue;

    // The port that is blocked is not necessarily the only port available.
    //
    // Asked for a row of blocks packed tightly — which is a real requirement,
    // not a mistake — the sides facing along the row are buried in the
    // neighbours, while the tops and bottoms are wide open. Judging the arrow
    // by the side it happens to be on refused the whole board and told the
    // agent to spread the nodes out by 100px, undoing exactly what it had been
    // asked to do. It obeyed, was refused again for another reason, and went
    // round three times.
    //
    // So the question is whether *any* attachment works, not whether this one
    // does. A port the agent pinned deliberately is exempt: there the specific
    // side is the instruction, and reporting it blocked is the useful answer.
    const from = byId.get(arrow.from.artifactId);
    const to = byId.get(arrow.to.artifactId);
    const pinnedFrom = arrow.autoPorts !== true && arrow.from.side !== 'auto';
    const pinnedTo = arrow.autoPorts !== true && arrow.to.side !== 'auto';

    const openSides = (
      artifact: Artifact | undefined,
      pinned: boolean,
      side: FixedSide,
    ): Vec2[] => {
      if (!artifact) return [];
      const sides = pinned ? [side] : FIXED_SIDES;
      return sides
        .map((candidate) => stubPoint(anchorPoint(artifact, candidate, 0.5), candidate, artifact.id, artifacts))
        .filter(clear);
    };

    const fromOptions = openSides(from, pinnedFrom, geometry.fromSide);
    const toOptions = openSides(to, pinnedTo, geometry.toSide);
    if (fromOptions.length === 0 || toOptions.length === 0) crowded.push(arrow.id);
  }

  const ready = overlapping === 0 && crowded.length === 0;
  const note = !ready
    ? overlapping > 0
      ? `Узлы накладываются (${overlapping} пар). Раздвинь артефакты (между соседями от 100px) и вызови роутер снова. Маршрут не проложен.`
      : `Для стрелок ${crowded.join(', ')} нет свободной стороны: все четыре стороны хотя бы одного из блоков закрыты соседями. Раздвинь эти блоки или освободи одну сторону. Маршрут не проложен.`
    : '';

  return { ready, crowded, overlapping, note };
};

/**
 * Orthogonal, obstacle-avoiding routing over a Hanan grid built from the
 * artifact boxes. Turns and shared corridors are penalised, so the result
 * prefers few bends and does not stack parallel arrows on one line.
 *
 * Arrows are laid one after another, so the order matters: the first one
 * takes the cheap corridor. Several orders are tried (creation, short-first,
 * long-first, top-to-bottom) and the board quality metric picks the winner.
 *
 * If the layout is too tight, nothing is routed — a polyline cannot invent
 * a corridor that does not exist.
 */
export const routeArrows = (
  artifacts: Artifact[],
  arrows: Arrow[],
  options: RouteOptions = {},
): RouteResult => {
  const margin = options.margin ?? DEFAULTS.margin;
  const clearance = options.clearance ?? DEFAULTS.clearance;
  const turnPenalty = options.turnPenalty ?? DEFAULTS.turnPenalty;
  const overlapPenalty = options.overlapPenalty ?? DEFAULTS.overlapPenalty;
  const crossPenalty = options.crossPenalty ?? DEFAULTS.crossPenalty;
  const spreadPorts = options.spreadPorts === true;
  const jogLength = options.jogLength ?? DEFAULTS.jogLength;
  const jogPenalty = options.jogPenalty ?? DEFAULTS.jogPenalty;

  const wanted = options.arrowIds ? new Set(options.arrowIds) : null;
  const targets = arrows.filter((arrow) => (wanted ? wanted.has(arrow.id) : true));

  const gate = tooTightToRoute(artifacts, arrows, options.arrowIds);
  if (!gate.ready) {
    return {
      routed: [],
      skipped: targets.map((arrow) => ({ arrowId: arrow.id, reason: 'layout too tight' })),
      variantsTried: 0,
      refused: true,
      crowded: gate.crowded,
      overlapping: gate.overlapping,
      note: gate.note,
    };
  }

  // Ports the router itself assigned belong to the previous arrangement. Kept,
  // they skip the distribution pass in `computeArrowGeometries`, and arrows
  // into one node stay on crossing lines however the nodes are moved. Ports the
  // agent asked for are untouched.
  const wanted2 = new Set(targets.map((arrow) => arrow.id));
  const freshPorts = arrows.map((arrow) =>
    arrow.autoPorts && wanted2.has(arrow.id)
      ? {
          ...arrow,
          from: { ...arrow.from, offset: undefined },
          to: { ...arrow.to, offset: undefined },
        }
      : arrow,
  );
  const geometries = computeArrowGeometries(artifacts, freshPorts);

  const usableGrid = artifacts.length <= MAX_GRID_ARTIFACTS;
  const blockers = artifacts.map((a) => ({ id: a.id, rect: inflate(a, clearance) }));

  const lanesPerGap =
    typeof options.lanesPerGap === 'number' ? options.lanesPerGap : lanesFor(targets.length);
  const rings = options.outerRings ?? DEFAULTS.outerRings;
  /** Lines at increasing distances outside the composition, on both sides. */
  const ringLines = (lo: number, hi: number): number[] => {
    const out: number[] = [];
    for (let ring = 1; ring <= rings; ring++) {
      const away = margin * (ring + 1) * 1.5;
      out.push(Math.round(lo - away), Math.round(hi + away));
    }
    return out;
  };
  const spanX = artifacts.map((a) => [a.x, a.x + a.width] as [number, number]);
  const spanY = artifacts.map((a) => [a.y, a.y + a.height] as [number, number]);
  const xs = uniqueSorted([
    ...corridorLines(spanX, margin, lanesPerGap),
    ...ringLines(Math.min(...spanX.map((s) => s[0])), Math.max(...spanX.map((s) => s[1]))),
  ]);
  const ys = uniqueSorted([
    ...corridorLines(spanY, margin, lanesPerGap),
    ...ringLines(Math.min(...spanY.map((s) => s[0])), Math.max(...spanY.map((s) => s[1]))),
  ]);

  const keepOccupied = (): Corridors => {
    const corridors = new Corridors();
    const rerouting = wanted ?? new Set(targets.map((arrow) => arrow.id));
    for (const arrow of arrows) {
      if (rerouting.has(arrow.id)) continue;
      const geometry = geometries.get(arrow.id);
      if (geometry) corridors.add(geometry.points);
    }
    return corridors;
  };

  const routeOne = (
    arrow: Arrow,
    corridors: Corridors,
    routedSoFar: RoutedArrow[],
  ): RoutedArrow | { skip: string } => {
    const from = artifacts.find((item) => item.id === arrow.from.artifactId);
    const to = artifacts.find((item) => item.id === arrow.to.artifactId);
    if (!from || !to) return { skip: 'endpoint artifact missing' };
    if (from.id === to.id) return { skip: 'self loop' };

    const occupiedArrows = arrows.map((item) => {
      if (item.id === arrow.id) return item;
      const match = routedSoFar.find((routed) => routed.arrowId === item.id);
      if (!match) return item;
      return {
        ...item,
        bends: match.bends,
        from: { ...item.from, side: match.fromSide, offset: match.fromOffset },
        to: { ...item.to, side: match.toSide, offset: match.toOffset },
      };
    });
    const occupied = collectIntendedPorts(artifacts, occupiedArrows, arrow.id);

    const geometry = geometries.get(arrow.id);
    const endpointIds = new Set([from.id, to.id]);
    const foreign = blockers.filter((b) => !endpointIds.has(b.id)).map((b) => b.rect);
    const selfBoxes: Rect[] = [from, to];
    const allObstacles = [...foreign, ...selfBoxes];

    const passableAt = (start: Vec2, goal: Vec2) => {
      const crowded = allObstacles.filter(
        (rect) => segmentHitsRect(start, start, rect) || segmentHitsRect(goal, goal, rect),
      );
      const usable = allObstacles.filter((rect) => !crowded.includes(rect));
      return (a: Vec2, b: Vec2): boolean => !usable.some((rect) => segmentHitsRect(a, b, rect));
    };

    const model: CostModel = { corridors, turnPenalty, overlapPenalty, crossPenalty };

    interface Candidate {
      path: Vec2[];
      start: Vec2;
      goal: Vec2;
      fromSide: FixedSide;
      toSide: FixedSide;
      score: number;
    }
    let best: Candidate | null = null;

    const consider = (
      raw: Vec2[],
      start: Vec2,
      goal: Vec2,
      fromSide: FixedSide,
      toSide: FixedSide,
      passable: (a: Vec2, b: Vec2) => boolean,
    ) => {
      const points = tidyOrthogonal(raw);
      if (points.length < 2 || !axisAligned(points)) return;
      for (let i = 1; i < points.length; i++) {
        if (!passable(points[i - 1], points[i])) return;
      }
      const bends = Math.max(0, points.length - 2);
      const manh = Math.abs(goal.x - start.x) + Math.abs(goal.y - start.y);
      const ratio = manh < 1 ? 1 : pathLength(points) / manh;
      const hook = ratio >= HOOK_RATIO || leavesComposition(points, artifacts) || bends > 4;
      const topY = Math.min(from.y, to.y);
      const botY = Math.max(from.y + from.height, to.y + to.height);
      const overTheTop = points.some((p) => p.y < topY - 8);
      const underTheBottom = points.some((p) => p.y > botY + 8);
      const wrongSide =
        (overTheTop ? (fromSide === 'top' ? 0 : 120) + (toSide === 'top' ? 0 : 120) : 0) +
        (underTheBottom ? (fromSide === 'bottom' ? 0 : 120) + (toSide === 'bottom' ? 0 : 120) : 0);
      // A short middle run is the "step sideways and come straight back" shape:
      // two turns that cancel out and read as a wobble rather than a route.
      // Two turns cost 240 here, so a jog has to be worth more than that.
      let jogs = 0;
      for (let i = 1; i < points.length - 2; i++) {
        const run = Math.abs(points[i + 1].x - points[i].x) + Math.abs(points[i + 1].y - points[i].y);
        if (run < jogLength) jogs += 1;
      }
      const score =
        pathCost(points, model) + (hook ? 800 : 0) + bends * 8 + wrongSide + jogs * jogPenalty;
      if (!best || score < best.score) {
        best = { path: points, start, goal, fromSide, toSide, score };
      }
    };

    const requested: [FixedSide, FixedSide] = geometry
      ? [geometry.fromSide, geometry.toSide]
      : facingPair(from, to);

    /**
     * A port somebody pinned deliberately is an instruction, not a hint.
     *
     * Without this the loop below sweeps all sixteen side pairs and every lane
     * within them, scores each on path quality alone — nothing charges for
     * ignoring what was asked — and keeps whichever it likes best. So the port
     * search would choose a port, the router would overrule it, and the search
     * would then measure the router's choice as if it were its own. Measured on
     * 77 attempts: not one requested offset survived, and one requested side.
     *
     * `autoPorts` marks a port the router owns and may move. Anything else was
     * put there by the port search, the agent, or the user.
     */
    // Sides and offsets are pinned separately, because they are asked for
    // separately: the search's side move names a side and deliberately leaves
    // the offset free for the draw-time spread to place.
    const owned = arrow.autoPorts === true;
    const sidesPinned = !owned && arrow.from.side !== 'auto' && arrow.to.side !== 'auto';
    const portsPinned =
      sidesPinned && arrow.from.offset != null && arrow.to.offset != null;

    if (portsPinned && geometry) {
      const start = stubPoint(geometry.fromPoint, geometry.fromSide, from.id, artifacts);
      const goal = stubPoint(geometry.toPoint, geometry.toSide, to.id, artifacts);
      const passable = passableAt(start, goal);
      for (const candidate of simpleRoutes(start, goal)) {
        consider(candidate, start, goal, geometry.fromSide, geometry.toSide, passable);
      }
    } else {
      const pairs = sidesPinned
        ? [requested]
        : uniquePairs([requested, facingPair(from, to), ...SIDE_PAIRS]);
      for (const [fromSide, toSide] of pairs) {
        for (const { start, goal } of facingLanes(from, fromSide, to, toSide, artifacts)) {
          const passable = passableAt(start, goal);
          for (const candidate of simpleRoutes(start, goal)) {
            consider(candidate, start, goal, fromSide, toSide, passable);
          }
        }
      }
    }

    const searchPair = (fromSide: FixedSide, toSide: FixedSide, start: Vec2, goal: Vec2) => {
      if (!usableGrid) return;
      const passable = passableAt(start, goal);
      const found = search({
        start,
        goal,
        xs: mergeGrid(xs, [start.x, goal.x]),
        ys: mergeGrid(ys, [start.y, goal.y]),
        passable,
        corridors,
        turnPenalty,
        overlapPenalty,
        crossPenalty,
      });
      if (found) consider(found, start, goal, fromSide, toSide, passable);
    };

    if (geometry) {
      searchPair(
        geometry.fromSide,
        geometry.toSide,
        stubPoint(geometry.fromPoint, geometry.fromSide, from.id, artifacts),
        stubPoint(geometry.toPoint, geometry.toSide, to.id, artifacts),
      );
    }
    // Candidates are assigned inside `consider`; keep the declared union here
    // instead of letting control-flow analysis treat the closure-owned value as null.
    const simpleBest = best as Candidate | null;
    if (simpleBest) searchPair(simpleBest.fromSide, simpleBest.toSide, simpleBest.start, simpleBest.goal);

    const selected = best as Candidate | null;
    const fromSide = selected?.fromSide ?? requested[0];
    const toSide = selected?.toSide ?? requested[1];
    const start = selected?.start ?? stubPoint(anchorPoint(from, fromSide, 0.5), fromSide, from.id, artifacts);
    const goal = selected?.goal ?? stubPoint(anchorPoint(to, toSide, 0.5), toSide, to.id, artifacts);
    const fallback = selected === null;
    const finalPath = selected?.path ?? tidyOrthogonal(fallbackPath(start, goal, fromSide));
    const fromOffset = freePortOffset(
      from,
      fromSide,
      'from',
      occupied,
      offsetFromPoint(from, fromSide, start),
      spreadPorts,
    );
    const toOffset = freePortOffset(
      to,
      toSide,
      'to',
      occupied,
      offsetFromPoint(to, toSide, goal),
      spreadPorts,
    );
    if (fromOffset == null || toOffset == null) {
      return { skip: 'вход и выход слишком близко на одной стороне — нужна другая сторона' };
    }
    const fromPoint = anchorPoint(from, fromSide, fromOffset);
    const toPoint = anchorPoint(to, toSide, toOffset);
    corridors.add([fromPoint, ...finalPath, toPoint]);
    const manh = Math.abs(goal.x - start.x) + Math.abs(goal.y - start.y);
    const ratio = manh < 1 ? 1 : pathLength(finalPath) / manh;
    const bends = ensureHeadOnBends(
      from,
      to,
      fromSide,
      toSide,
      trimStubs(finalPath, start, goal),
      fromOffset,
      toOffset,
      artifacts,
    );
    const raw = inspectRawPortAngles(from, to, fromSide, toSide, bends, fromOffset, toOffset);
    if (raw.shallow) {
      return {
        skip: `вход/выход ${Math.round(Math.min(raw.fromAngle, raw.toAngle))}° < ${MIN_PORT_ANGLE_DEG}°`,
      };
    }
    const hook =
      ratio >= HOOK_RATIO || leavesComposition(finalPath, artifacts) || bends.length > 4;
    return {
      arrowId: arrow.id,
      bends,
      fromSide,
      toSide,
      fromOffset,
      toOffset,
      fallback,
      detourRatio: Math.round(ratio * 100) / 100,
      ...(hook ? { hook: true } : {}),
    };
  };

  const routeInOrder = (order: Arrow[]): RouteResult => {
    const corridors = keepOccupied();
    const routed: RoutedArrow[] = [];
    const skipped: Array<{ arrowId: string; reason: string }> = [];
    for (const arrow of order) {
      const outcome = routeOne(arrow, corridors, routed);
      if ('skip' in outcome) skipped.push({ arrowId: arrow.id, reason: outcome.skip });
      else routed.push(outcome);
    }
    const split = splitMixedPorts(routed);
    for (const arrowId of split.dropped) {
      skipped.push({
        arrowId,
        reason: 'вход и выход слишком близко на одной стороне — нужна другая сторона',
      });
    }
    return { routed: split.routed, skipped, variantsTried: 1 };
  };

  const splitMixedPorts = (routed: RoutedArrow[]): { routed: RoutedArrow[]; dropped: string[] } => {
    const next = routed.map((item) => ({ ...item }));
    const dropped: string[] = [];
    for (let i = 0; i < next.length; i++) {
      const current = next[i];
      const arrow = arrows.find((item) => item.id === current.arrowId);
      const from = artifacts.find((item) => item.id === arrow?.from.artifactId);
      const to = artifacts.find((item) => item.id === arrow?.to.artifactId);
      if (!arrow || !from || !to) continue;
      const painted = arrows.map((item) => {
        const match = next.find((routedArrow) => routedArrow.arrowId === item.id);
        if (!match) return item;
        return {
          ...item,
          bends: match.bends,
          from: { ...item.from, side: match.fromSide, offset: match.fromOffset },
          to: { ...item.to, side: match.toSide, offset: match.toOffset },
        };
      });
      const ports = collectIntendedPorts(artifacts, painted, current.arrowId);
      const nextFrom = freePortOffset(from, current.fromSide, 'from', ports, current.fromOffset, spreadPorts);
      const nextTo = freePortOffset(to, current.toSide, 'to', ports, current.toOffset, spreadPorts);
      if (nextFrom == null || nextTo == null) {
        dropped.push(current.arrowId);
        continue;
      }
      current.fromOffset = nextFrom;
      current.toOffset = nextTo;
    }
    return {
      routed: next.filter((item) => !dropped.includes(item.arrowId)),
      dropped,
    };
  };

  const paint = (result: RouteResult): Arrow[] =>
    arrows.map((item) => {
      const match = result.routed.find((r) => r.arrowId === item.id);
      if (!match) return item;
      return {
        ...item,
        bends: match.bends,
        routing: 'orthogonal' as const,
        from: { ...item.from, side: match.fromSide, offset: match.fromOffset },
        to: { ...item.to, side: match.toSide, offset: match.toOffset },
      };
    });

  const scoreOf = (result: RouteResult): number => {
    const painted = paint(result);
    const quality = boardQuality(artifacts, painted);
    const fallbacks = result.routed.filter((r) => r.fallback).length;
    const hooks = result.routed.filter((r) => r.hook).length;
    const extraBends = result.routed.reduce((sum, r) => sum + Math.max(0, r.bends.length - 2), 0);
    const ports = collectIntendedPorts(artifacts, painted);
    let mixed = 0;
    for (let i = 0; i < ports.length; i++) {
      if (
        findMixedPortConflict(
          ports.filter((_, index) => index !== i),
          { artifactId: ports[i].artifactId, end: ports[i].end, point: ports[i].point },
        )
      ) {
        mixed++;
      }
    }
    return quality.cost + fallbacks * 50 + hooks * 25 + extraBends * 8 + mixed * 40;
  };

  const span = (arrow: Arrow): number => {
    const geometry = geometries.get(arrow.id);
    if (!geometry) return 0;
    return (
      Math.abs(geometry.toPoint.x - geometry.fromPoint.x) +
      Math.abs(geometry.toPoint.y - geometry.fromPoint.y)
    );
  };

  const orders: Arrow[][] = [];
  const seen = new Set<string>();
  const remember = (order: Arrow[]) => {
    const key = order.map((arrow) => arrow.id).join('|');
    if (seen.has(key)) return;
    seen.add(key);
    orders.push(order);
  };

  remember(targets);
  remember([...targets].sort((a, b) => span(a) - span(b) || a.id.localeCompare(b.id)));
  remember([...targets].sort((a, b) => span(b) - span(a) || a.id.localeCompare(b.id)));
  remember(
    [...targets].sort((a, b) => {
      const ga = geometries.get(a.id);
      const gb = geometries.get(b.id);
      const dy = (ga?.fromPoint.y ?? 0) - (gb?.fromPoint.y ?? 0);
      if (dy !== 0) return dy;
      const dx = (ga?.fromPoint.x ?? 0) - (gb?.fromPoint.x ?? 0);
      if (dx !== 0) return dx;
      return a.id.localeCompare(b.id);
    }),
  );

  let best = routeInOrder(orders[0] ?? []);
  let bestScore = scoreOf(best);
  for (let i = 1; i < orders.length; i++) {
    const candidate = routeInOrder(orders[i]);
    const score = scoreOf(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  const indexOf = new Map(targets.map((arrow, i) => [arrow.id, i]));
  best.routed.sort((a, b) => (indexOf.get(a.arrowId) ?? 0) - (indexOf.get(b.arrowId) ?? 0));
  best.variantsTried = orders.length;

  const unique = computeArrowGeometries(artifacts, paint(best));
  for (const route of best.routed) {
    const geo = unique.get(route.arrowId);
    if (!geo) continue;
    route.fromOffset = geo.fromOffset;
    route.toOffset = geo.toOffset;
  }
  return best;
};

interface SearchArgs {
  start: Vec2;
  goal: Vec2;
  xs: number[];
  ys: number[];
  passable: (a: Vec2, b: Vec2) => boolean;
  corridors: Corridors;
  turnPenalty: number;
  overlapPenalty: number;
  crossPenalty: number;
}

const search = (args: SearchArgs): Vec2[] | null => {
  const { xs, ys, passable, corridors, turnPenalty, overlapPenalty, crossPenalty } = args;
  const xIndex = new Map(xs.map((v, i) => [v, i]));
  const yIndex = new Map(ys.map((v, i) => [v, i]));
  const sx = xIndex.get(args.start.x);
  const sy = yIndex.get(args.start.y);
  const gx = xIndex.get(args.goal.x);
  const gy = yIndex.get(args.goal.y);
  if (sx == null || sy == null || gx == null || gy == null) return null;

  const width = xs.length;
  const height = ys.length;
  const nodeCount = width * height;
  if (nodeCount > 60_000) return null;

  // Four directions per node so turn costs can be accounted for.
  const stateCount = nodeCount * 4;
  const gScore = new Float64Array(stateCount).fill(Infinity);
  const cameFrom = new Int32Array(stateCount).fill(-1);
  const closed = new Uint8Array(stateCount);
  const heap = new Heap();

  const point = (ix: number, iy: number): Vec2 => ({ x: xs[ix], y: ys[iy] });
  const heuristic = (ix: number, iy: number): number =>
    Math.abs(xs[ix] - args.goal.x) + Math.abs(ys[iy] - args.goal.y);

  // A single start state is enough: the first move is never charged a turn.
  const startState = (sy * width + sx) * 4;
  gScore[startState] = 0;
  heap.push(startState, heuristic(sx, sy));

  const deltas = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];

  let goalState = -1;
  while (heap.size > 0) {
    const current = heap.pop();
    if (current == null) break;
    if (closed[current]) continue;
    closed[current] = 1;

    const node = Math.floor(current / 4);
    const dir = current % 4;
    const ix = node % width;
    const iy = Math.floor(node / width);

    if (ix === gx && iy === gy) {
      goalState = current;
      break;
    }

    for (let nextDir = 0; nextDir < 4; nextDir++) {
      const { dx, dy } = deltas[nextDir];
      const nx = ix + dx;
      const ny = iy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

      const a = point(ix, iy);
      const b = point(nx, ny);
      if (!passable(a, b)) continue;

      const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      if (length < MIN_EDGE) continue;
      const turn = gScore[current] > 0 && nextDir !== dir ? turnPenalty : 0;
      const busy = corridors.cost(a, b) * overlapPenalty;
      const crossed = corridors.crossings(a, b) * crossPenalty;
      const tentative = gScore[current] + length + turn + busy + crossed;

      const nextState = (ny * width + nx) * 4 + nextDir;
      if (tentative >= gScore[nextState]) continue;
      gScore[nextState] = tentative;
      cameFrom[nextState] = current;
      heap.push(nextState, tentative + heuristic(nx, ny));
    }
  }

  if (goalState < 0) return null;

  const path: Vec2[] = [];
  for (let state = goalState; state >= 0; state = cameFrom[state]) {
    const node = Math.floor(state / 4);
    path.push(point(node % width, Math.floor(node / width)));
  }
  path.reverse();
  return path;
};

const bendsEqual = (a: Vec2[], b: Vec2[]): boolean => {
  if (a.length !== b.length) return false;
  return a.every((point, i) => samePoint(point, b[i]));
};

export interface CleanedArrow {
  arrowId: string;
  bends: Vec2[];
  fromSide: FixedSide;
  toSide: FixedSide;
  fromOffset: number;
  toOffset: number;
  before: number;
  after: number;
  changed: boolean;
}

export interface CleanResult {
  cleaned: CleanedArrow[];
  skipped: Array<{ arrowId: string; reason: string }>;
}

/**
 * Rewrites stored bends so they match the polyline that is actually drawn:
 * whiskers, one-cell bridges and collinear leftovers are dropped. Does not
 * search for a new path — call `routeArrows` when the route itself is wrong.
 */
export const cleanArrowRoutes = (
  artifacts: Artifact[],
  arrows: Arrow[],
  options: { arrowIds?: string[] } = {},
): CleanResult => {
  const wanted = options.arrowIds ? new Set(options.arrowIds) : null;
  // Ghosts come from rectify of orthogonal arrows; treat any arrow that still
  // has bends as orthogonal so a leftover from an older run is cleaned too.
  const asOrthogonal = arrows.map((arrow) =>
    arrow.bends.length > 0 && arrow.routing !== 'orthogonal'
      ? { ...arrow, routing: 'orthogonal' as const }
      : arrow,
  );
  const geometries = computeArrowGeometries(artifacts, asOrthogonal);
  const cleaned: CleanedArrow[] = [];
  const skipped: Array<{ arrowId: string; reason: string }> = [];

  for (const arrow of asOrthogonal) {
    if (wanted && !wanted.has(arrow.id)) continue;
    const geometry = geometries.get(arrow.id);
    if (!geometry) {
      skipped.push({ arrowId: arrow.id, reason: 'endpoint artifact missing' });
      continue;
    }
    if (arrow.from.artifactId === arrow.to.artifactId) {
      skipped.push({ arrowId: arrow.id, reason: 'self loop' });
      continue;
    }
    if (arrow.bends.length === 0) {
      skipped.push({ arrowId: arrow.id, reason: 'no bends' });
      continue;
    }

    const start = stubPoint(geometry.fromPoint, geometry.fromSide, arrow.from.artifactId, artifacts);
    const goal = stubPoint(geometry.toPoint, geometry.toSide, arrow.to.artifactId, artifacts);
    const bends = trimStubs(geometry.points, start, goal).filter(
      (point) =>
        !samePoint(point, geometry.fromPoint) &&
        !samePoint(point, geometry.toPoint) &&
        !samePoint(point, start) &&
        !samePoint(point, goal),
    );
    const rounded = bends.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y) }));
    cleaned.push({
      arrowId: arrow.id,
      bends: rounded,
      fromSide: geometry.fromSide,
      toSide: geometry.toSide,
      fromOffset: geometry.fromOffset,
      toOffset: geometry.toOffset,
      before: arrow.bends.length,
      after: rounded.length,
      changed: !bendsEqual(arrow.bends, rounded),
    });
  }

  return { cleaned, skipped };
};
