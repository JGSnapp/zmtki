import type { AnchorSide, Arrow, ArrowRouting, Artifact, Rect, Vec2 } from './artifacts.js';

export type FixedSide = Exclude<AnchorSide, 'auto'>;

/** Clockwise from the top, so iteration order reads the way a person points. */
export const FIXED_SIDES: FixedSide[] = ['top', 'right', 'bottom', 'left'];

/**
 * Shortest legal run between two vertices (port, bend or stub).
 * Anything shorter reads as a nick, not an edge.
 */
export const MIN_EDGE = 24;

/**
 * Perpendicular run into / out of a port. Must be long enough to read as the
 * entry: a 24px nick after a line that grazes the side still looks like 0°.
 */
export const PORT_STUB = 72;

/**
 * Parallel forks/joins (same end type) stay this far apart so two lines
 * do not fuse into one stroke.
 */
export const MIN_PORT_PITCH = 16;

/**
 * Incoming and outgoing ports on one box. A 16px nudge used to slip past a
 * 1.5px "same pixel" check and still look like one port (arrowhead is 10px).
 * Below this, create/update refuse and the router will not pin the pair.
 */
export const MIN_MIXED_PORT = 48;

/**
 * Smallest angle (degrees) between an incoming/outgoing segment and the box
 * side. 0° would slide along the edge; 90° is head-on. Below this the line
 * looks like a crooked nick, not a connection.
 */
export const MIN_PORT_ANGLE_DEG = 30;

export const centerOf = (r: Rect): Vec2 => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2,
});

export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

/** Picks the side facing `target` when the arrow endpoint is set to `auto`. */
export const resolveSide = (rect: Rect, target: Vec2): FixedSide => {
  const c = centerOf(rect);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  const w = Math.max(rect.width, 1);
  const h = Math.max(rect.height, 1);
  // Compare normalized offsets so wide boxes prefer horizontal sides.
  if (Math.abs(dx) / w >= Math.abs(dy) / h) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
};

export const outwardNormal = (side: FixedSide): Vec2 => {
  switch (side) {
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
    default:
      return { x: 1, y: 0 };
  }
};

/**
 * Angle between `direction` and the box side: 0° runs along the edge,
 * 90° hits it head-on. Used to reject nicks flatter than `MIN_PORT_ANGLE_DEG`.
 */
export const angleToSide = (direction: Vec2, side: FixedSide): number => {
  const n = outwardNormal(side);
  const len = Math.hypot(direction.x, direction.y);
  if (len < 1e-6) return 90;
  const cos = Math.min(1, Math.max(-1, (direction.x * n.x + direction.y * n.y) / len));
  const fromNormal = (Math.acos(Math.abs(cos)) * 180) / Math.PI;
  return 90 - fromNormal;
};

export interface RawPortAngles {
  fromSide: FixedSide;
  toSide: FixedSide;
  fromAngle: number;
  toAngle: number;
  /** True when either end is flatter than `MIN_PORT_ANGLE_DEG`. */
  shallow: boolean;
  end: 'from' | 'to' | 'both' | null;
}

/**
 * Angles of the polyline the agent actually specified: port → bends → port,
 * without the draw-time stubs that force 90°. Used to refuse a create that
 * would nick a side.
 */
export const inspectRawPortAngles = (
  from: Artifact,
  to: Artifact,
  fromSide: AnchorSide,
  toSide: AnchorSide,
  bends: Vec2[],
  fromOffset?: number | null,
  toOffset?: number | null,
): RawPortAngles => {
  const firstBend = bends[0];
  const lastBend = bends[bends.length - 1];
  const resolvedFrom = fromSide === 'auto' ? resolveSide(from, firstBend ?? centerOf(to)) : fromSide;
  const resolvedTo = toSide === 'auto' ? resolveSide(to, lastBend ?? centerOf(from)) : toSide;
  const fromPoint = anchorPoint(from, resolvedFrom, fromOffset ?? 0.5);
  const toPoint = anchorPoint(to, resolvedTo, toOffset ?? 0.5);
  const first = firstBend ?? toPoint;
  const last = lastBend ?? fromPoint;
  const fromAngle = angleToSide({ x: first.x - fromPoint.x, y: first.y - fromPoint.y }, resolvedFrom);
  const toAngle = angleToSide({ x: last.x - toPoint.x, y: last.y - toPoint.y }, resolvedTo);
  const fromShallow = fromAngle < MIN_PORT_ANGLE_DEG - 0.5;
  const toShallow = toAngle < MIN_PORT_ANGLE_DEG - 0.5;
  return {
    fromSide: resolvedFrom,
    toSide: resolvedTo,
    fromAngle,
    toAngle,
    shallow: fromShallow || toShallow,
    end: fromShallow && toShallow ? 'both' : fromShallow ? 'from' : toShallow ? 'to' : null,
  };
};

/**
 * If the stored polyline would nick a side, pin a perpendicular stub as a
 * bend so the router cannot emit a <30° entry.
 */
export const ensureHeadOnBends = (
  from: Artifact,
  to: Artifact,
  fromSide: FixedSide,
  toSide: FixedSide,
  bends: Vec2[],
  fromOffset: number,
  toOffset: number,
  artifacts: Iterable<Artifact>,
): Vec2[] => {
  const check = inspectRawPortAngles(from, to, fromSide, toSide, bends, fromOffset, toOffset);
  if (!check.shallow) return bends;
  const fromPoint = anchorPoint(from, fromSide, fromOffset);
  const toPoint = anchorPoint(to, toSide, toOffset);
  const fromLen = approachLength(fromPoint, fromSide, from.id, artifacts);
  const toLen = approachLength(toPoint, toSide, to.id, artifacts);
  const fn = outwardNormal(fromSide);
  const tn = outwardNormal(toSide);
  const stubFrom = {
    x: Math.round(fromPoint.x + fn.x * fromLen),
    y: Math.round(fromPoint.y + fn.y * fromLen),
  };
  const stubTo = {
    x: Math.round(toPoint.x + tn.x * toLen),
    y: Math.round(toPoint.y + tn.y * toLen),
  };
  const next = [...bends];
  const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
  if (check.fromAngle < MIN_PORT_ANGLE_DEG - 0.5 && !next.some((point) => same(point, stubFrom))) {
    next.unshift(stubFrom);
  }
  if (check.toAngle < MIN_PORT_ANGLE_DEG - 0.5 && !next.some((point) => same(point, stubTo))) {
    next.push(stubTo);
  }
  return next;
};

/**
 * The largest sweep a curved corner may take, and the share of a segment it may
 * spend getting there.
 *
 * A single fixed radius made every corner identical, which reads as a stencil
 * rather than a drawn line. The radius is a share of the shorter of the two
 * segments the corner joins, so a long run gets a wide sweep and a short one a
 * tight turn, and the cap only stops the very longest from ballooning.
 *
 * The share stays under a half: two corners at the ends of one segment take
 * 0.45 of it each and still leave room between them, so an arc can never run
 * into its neighbour.
 */
export const CORNER_RADIUS_MAX = 72;
export const CORNER_RADIUS_SHARE = 0.45;

/** One rounded corner: where the arc leaves the run, its apex, where it rejoins. */
export interface RoundedCorner {
  start: Vec2;
  apex: Vec2;
  end: Vec2;
}

/**
 * The corners of a polyline as arcs.
 *
 * Every consumer of the curved shape comes through here — the SVG path, and the
 * polyline the quality metric measures. Two places computing the same rounding
 * from the same points independently is exactly how the libavoid routes ended
 * up drawn differently from how they were measured.
 */
export const roundedCorners = (points: Vec2[]): RoundedCorner[] => {
  const out: RoundedCorner[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const before = points[i - 1];
    const apex = points[i];
    const after = points[i + 1];
    const inLen = Math.hypot(apex.x - before.x, apex.y - before.y);
    const outLen = Math.hypot(after.x - apex.x, after.y - apex.y);
    if (inLen < 1 || outLen < 1) continue;

    const inX = (apex.x - before.x) / inLen;
    const inY = (apex.y - before.y) / inLen;
    const outX = (after.x - apex.x) / outLen;
    const outY = (after.y - apex.y) / outLen;
    // Straight through: nothing to round.
    if (Math.abs(inX - outX) < 1e-6 && Math.abs(inY - outY) < 1e-6) continue;

    const r = Math.min(CORNER_RADIUS_MAX, inLen * CORNER_RADIUS_SHARE, outLen * CORNER_RADIUS_SHARE);
    out.push({
      start: { x: apex.x - inX * r, y: apex.y - inY * r },
      apex,
      end: { x: apex.x + outX * r, y: apex.y + outY * r },
    });
  }
  return out;
};

/**
 * The SVG path for one arrow.
 *
 * The polyline is the route; this only decides how it is drawn. Both renderers
 * — the board in the browser and the bench that makes the screenshots — build
 * their path here, so a curve added for one is a curve in the other.
 */
export const arrowPathData = (points: Vec2[], routing?: ArrowRouting): string => {
  if (points.length === 0) return '';
  const sharp = () => points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  if (routing !== 'curved' || points.length < 3) return sharp();

  const out: string[] = [`M ${points[0].x} ${points[0].y}`];
  for (const corner of roundedCorners(points)) {
    out.push(`L ${Math.round(corner.start.x)} ${Math.round(corner.start.y)}`);
    // The corner itself is the control point, so the arc leaves and arrives
    // along the original segments and the arrowhead still points true.
    out.push(`Q ${corner.apex.x} ${corner.apex.y} ${Math.round(corner.end.x)} ${Math.round(corner.end.y)}`);
  }
  const last = points[points.length - 1];
  out.push(`L ${last.x} ${last.y}`);
  return out.join(' ');
};

/** Samples per arc when the curve is turned back into a polyline for measuring. */
const ARC_SAMPLES = 6;

/**
 * The line as drawn, in straight pieces.
 *
 * Everything that judges what the reader sees — crossings, lines cutting
 * through blocks, clearances — measures this, because on a curved arrow the
 * drawn line and the route are not the same line. What the route itself is
 * worth — turns, bends, detour — is still measured on `points`: an arc is one
 * turn however finely it is sampled.
 */
export const drawnPolyline = (points: Vec2[], routing?: ArrowRouting): Vec2[] => {
  if (routing !== 'curved' || points.length < 3) return points;
  const corners = roundedCorners(points);
  if (corners.length === 0) return points;

  const out: Vec2[] = [points[0]];
  for (const { start, apex, end } of corners) {
    out.push(start);
    for (let step = 1; step <= ARC_SAMPLES; step++) {
      const t = step / ARC_SAMPLES;
      const m = 1 - t;
      out.push({
        x: m * m * start.x + 2 * m * t * apex.x + t * t * end.x,
        y: m * m * start.y + 2 * m * t * apex.y + t * t * end.y,
      });
    }
  }
  out.push(points[points.length - 1]);
  return out;
};

export const clampOffset = (offset: number): number => Math.min(1, Math.max(0, offset));

/**
 * How far an automatically chosen port is kept from the corners of its box.
 *
 * A line leaving exactly at a corner reads as coming from nothing in
 * particular: it touches two sides at once, the arrowhead sits on the box
 * outline, and the eye cannot tell which side it belongs to. The inset is a
 * distance in pixels rather than a share of the side, so a tall box and a wide
 * one end up looking the same.
 *
 * 14px is the box corner radius (10px) plus a little straight edge: below that
 * the port sits on the rounded part and the line attaches to nothing. Wider
 * insets were measured and cost real quality — 18px added about six points of
 * penalty for no further gain in how the corner reads.
 *
 * This binds only where the system *chooses* a port. A side and offset the
 * agent or the user asked for explicitly are drawn as given — `anchorPoint`
 * does not apply the inset.
 */
export let CORNER_INSET = 14;

/** Switches the corner rule off (0) or retunes it. */
export const setCornerInset = (px: number): void => {
  CORNER_INSET = Math.max(0, px);
};

/**
 * Pushes a chosen offset out of the corner zone of `side`. On a short side the
 * two margins would meet, so neither is ever allowed past a third of the side:
 * the middle stays reachable whatever the box measures.
 */
export const insetOffset = (rect: Rect, side: FixedSide, offset: number): number => {
  const clamped = clampOffset(offset);
  if (CORNER_INSET <= 0) return clamped;
  const length = Math.max(1, side === 'top' || side === 'bottom' ? rect.width : rect.height);
  const margin = Math.min(CORNER_INSET / length, 0.34);
  return Math.min(1 - margin, Math.max(margin, clamped));
};

/** Point on a side, `offset` running 0..1 from the top/left corner of that side. */
export const anchorPoint = (rect: Rect, side: FixedSide, offset = 0.5): Vec2 => {
  const t = clampOffset(offset);
  switch (side) {
    case 'top':
      return { x: Math.round(rect.x + rect.width * t), y: rect.y };
    case 'bottom':
      return { x: Math.round(rect.x + rect.width * t), y: rect.y + rect.height };
    case 'left':
      return { x: rect.x, y: Math.round(rect.y + rect.height * t) };
    case 'right':
    default:
      return { x: rect.x + rect.width, y: Math.round(rect.y + rect.height * t) };
  }
};

/** Inverse of `anchorPoint`: where `point` sits on `side`, clamped to 0..1. */
export const offsetFromPoint = (rect: Rect, side: FixedSide, point: Vec2): number => {
  // Deliberately *not* inset. This function does not choose a port, it reads
  // back where the route already met the box, and moving what it reports
  // breaks the route that was just computed. Two boxes stacked under a third
  // had their ports placed at 0.063 and 0.944 — different fractions of
  // different sides that land on the same x, which is what made the line
  // perfectly straight. Insetting the read-back nudged them apart and turned
  // two straight arrows into dog-legs.
  //
  // The corner rule belongs where a port is invented: `freePortOffset` and the
  // candidate table in the port search.
  return clampOffset(
    side === 'top' || side === 'bottom'
      ? (point.x - rect.x) / Math.max(rect.width, 1)
      : (point.y - rect.y) / Math.max(rect.height, 1),
  );
};

export interface IntendedPort {
  arrowId: string;
  artifactId: string;
  side: FixedSide;
  end: 'from' | 'to';
  offset: number;
  point: Vec2;
}

const resolveIntendedPort = (
  artifact: Artifact,
  side: AnchorSide,
  offset: number | undefined,
  target: Vec2,
): { side: FixedSide; offset: number; point: Vec2 } => {
  const resolved = side === 'auto' ? resolveSide(artifact, target) : side;
  const off = offset ?? 0.5;
  return { side: resolved, offset: off, point: anchorPoint(artifact, resolved, off) };
};

/** Ports as stored (or 0.5), not the draw-time nudge. */
export const collectIntendedPorts = (
  artifacts: Artifact[] | Map<string, Artifact>,
  arrows: Arrow[],
  excludeArrowId?: string,
): IntendedPort[] => {
  const byId = artifacts instanceof Map ? artifacts : new Map(artifacts.map((item) => [item.id, item]));
  const out: IntendedPort[] = [];
  for (const arrow of arrows) {
    if (arrow.id === excludeArrowId) continue;
    const from = byId.get(arrow.from.artifactId);
    const to = byId.get(arrow.to.artifactId);
    if (!from || !to) continue;
    const fromInt = resolveIntendedPort(
      from,
      arrow.from.side,
      arrow.from.offset,
      arrow.bends[0] ?? centerOf(to),
    );
    const toInt = resolveIntendedPort(
      to,
      arrow.to.side,
      arrow.to.offset,
      arrow.bends[arrow.bends.length - 1] ?? centerOf(from),
    );
    out.push({ arrowId: arrow.id, artifactId: from.id, end: 'from', ...fromInt });
    out.push({ arrowId: arrow.id, artifactId: to.id, end: 'to', ...toInt });
  }
  return out;
};

export const findMixedPortConflict = (
  ports: IntendedPort[],
  proposed: { artifactId: string; end: 'from' | 'to'; point: Vec2 },
): IntendedPort | null =>
  ports.find(
    (port) =>
      port.artifactId === proposed.artifactId &&
      port.end !== proposed.end &&
      Math.hypot(port.point.x - proposed.point.x, port.point.y - proposed.point.y) < MIN_MIXED_PORT,
  ) ?? null;

/**
 * Any port sitting on the proposed point, whichever way its arrow runs.
 *
 * Two outgoing arrows are *allowed* to share a point — a fork drawn from one
 * spot reads as deliberate — but sharing is not free: whatever the two do
 * next, they leave the box along the same stub, and `checkIntersections`
 * charges that shared run as a merge.
 *
 * Refusing every shared point is nevertheless the wrong default. Measured over
 * 159 boards, laying the whole board with ports spread apart trades 6 merges
 * for 128 extra crossings: lines that used to leave together and part once now
 * leave from different points and cut across each other instead. So this is a
 * lever the caller pulls (`spreadPorts`), used when one arrow is being re-laid
 * against neighbours that are already placed and its own stub is the problem.
 */
const findAnyPortConflict = (
  ports: IntendedPort[],
  proposed: { artifactId: string; end: 'from' | 'to'; point: Vec2 },
): IntendedPort | null =>
  ports.find(
    (port) =>
      port.artifactId === proposed.artifactId &&
      Math.hypot(port.point.x - proposed.point.x, port.point.y - proposed.point.y) <
        (port.end === proposed.end ? MIN_PORT_PITCH : MIN_MIXED_PORT),
  ) ?? null;

/** Next offset on `side` far enough from an opposite-end port, or null if none. */
export const freePortOffset = (
  artifact: Artifact,
  side: FixedSide,
  end: 'from' | 'to',
  ports: IntendedPort[],
  preferred = 0.5,
  /** Refuse a point another arrow already uses, even a same-end one. */
  spread = false,
): number | null => {
  const len = side === 'top' || side === 'bottom' ? artifact.width : artifact.height;
  const pitch = MIN_PORT_PITCH / Math.max(len, 1);
  const inset = (offset: number) => insetOffset(artifact, side, offset);
  // The fallbacks used to end at the bare corners, 0 and 1 — which is where a
  // crowded side sent every port that could not fit anywhere else. The band
  // edges take their place: still the last resort, but off the corner.
  // `preferred` is not a guess — the caller worked it out, usually so the port
  // lines up with the one it faces, and a straight line is worth more than a
  // clear corner. It is tried as given. Everything after it is invention, and
  // invention obeys the corner rule.
  const candidates = [preferred, inset(0.12), inset(0.88), inset(0), inset(1)];
  const steps = Math.max(8, Math.ceil(1 / Math.max(pitch, 1e-6)));
  for (let step = 1; step <= steps; step++) {
    candidates.push(inset(preferred + step * pitch), inset(preferred - step * pitch));
  }
  // The corner rule is a preference, not a wall. On a crowded side the inset
  // band can genuinely have no free point left, and a port off the corner is
  // worth less than two ports landing on each other — so the corner zone stays
  // available as a last tier, after every inset candidate has been refused.
  for (let step = steps; step >= 1; step--) {
    candidates.push(clampOffset(preferred + step * pitch), clampOffset(preferred - step * pitch));
  }
  candidates.push(0, 1);
  // Two passes over the same list. The first keeps every port to itself; the
  // second allows two same-end arrows onto one point, which is legal but costs
  // a merge. A crowded side falls through to it, an empty one never does.
  for (const conflicts of spread ? [findAnyPortConflict, findMixedPortConflict] : [findMixedPortConflict]) {
    for (const offset of candidates) {
      const point = anchorPoint(artifact, side, offset);
      if (!conflicts(ports, { artifactId: artifact.id, end, point })) return offset;
    }
  }
  return null;
};

export const intendedPortOf = (
  artifact: Artifact,
  side: AnchorSide,
  offset: number | undefined,
  target: Vec2,
): { side: FixedSide; offset: number; point: Vec2 } =>
  resolveIntendedPort(artifact, side, offset, target);

export interface ArrowGeometry {
  arrowId: string;
  points: Vec2[];
  fromSide: FixedSide;
  toSide: FixedSide;
  fromOffset: number;
  toOffset: number;
  fromPoint: Vec2;
  toPoint: Vec2;
  /**
   * For every segment of `points`, the index in `arrow.bends` at which a bend
   * added on that segment belongs. The polyline carries synthetic vertices
   * (lead-out stubs, orthogonal corners), so it cannot be indexed directly.
   */
  insertAt: number[];
}

export type Axis = 'h' | 'v';

const axisOf = (side: FixedSide): Axis => (side === 'left' || side === 'right' ? 'h' : 'v');

/** A vertex plus how many stored bends precede it. */
interface Vertex {
  p: Vec2;
  bends: number;
}

const ALIGN_EPS = 0.5;

/**
 * A leftover jog shorter than this is a ghost from a node that moved a few
 * pixels, not a real corridor. Larger detours are left alone — they are how
 * the router goes around boxes.
 */
const JOG_SNAP = 12;

const aligned = (a: Vec2, b: Vec2): boolean =>
  Math.abs(a.x - b.x) < ALIGN_EPS || Math.abs(a.y - b.y) < ALIGN_EPS;

const sameVertex = (a: Vec2, b: Vec2): boolean =>
  Math.abs(a.x - b.x) < ALIGN_EPS && Math.abs(a.y - b.y) < ALIGN_EPS;

const segmentLength = (a: Vec2, b: Vec2): number => Math.abs(b.x - a.x) + Math.abs(b.y - a.y);

/** Drops repeated and collinear vertices, keeping the bend bookkeeping intact. */
const compact = (vertices: Vertex[]): Vertex[] => {
  const out: Vertex[] = [];
  for (const vertex of vertices) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.p.x - vertex.p.x) < ALIGN_EPS && Math.abs(last.p.y - vertex.p.y) < ALIGN_EPS) {
      last.bends = Math.max(last.bends, vertex.bends);
      continue;
    }
    out.push(vertex);
  }
  for (let i = 1; i < out.length - 1; ) {
    const a = out[i - 1].p;
    const b = out[i].p;
    const c = out[i + 1].p;
    const collinear =
      (Math.abs(a.x - b.x) < ALIGN_EPS && Math.abs(b.x - c.x) < ALIGN_EPS) ||
      (Math.abs(a.y - b.y) < ALIGN_EPS && Math.abs(b.y - c.y) < ALIGN_EPS);
    if (collinear) {
      const leadOut = i === 1 && segmentLength(a, b) <= PORT_STUB + 1;
      const leadIn = i === out.length - 2 && segmentLength(b, c) <= PORT_STUB + 1;
      if (!leadOut && !leadIn) {
        out.splice(i, 1);
        continue;
      }
    }
    i++;
  }
  return out;
};

/**
 * Drops the artefacts that appear when a node moves a few pixels but the
 * stored bends stay put: a T-shaped whisker at a corner (the polyline goes
 * out and back along the same line) and a one-grid-cell "bridge" between two
 * runs that are already almost on the same line.
 *
 * Ports (first and last vertices) are never moved — the line still has to
 * meet the box. Only interior junk is removed.
 */
const tidyVertices = (vertices: Vertex[]): Vertex[] => {
  let current = compact(vertices);
  for (let pass = 0; pass < 8; pass++) {
    const next = flattenShortJogs(removeSpikes(compact(current)));
    if (next.length === current.length && next.every((v, i) => sameVertex(v.p, current[i].p))) {
      return next;
    }
    current = next;
  }
  return current;
};

/** A-B-A and collinear U-turns: the line went to a stale bend and came back. */
const removeSpikes = (vertices: Vertex[]): Vertex[] => {
  const out = vertices.map((v) => ({ p: { ...v.p }, bends: v.bends }));
  for (let i = 1; i < out.length - 1; ) {
    const prev = out[i - 1].p;
    const cur = out[i].p;
    const next = out[i + 1].p;
    const bounced = sameVertex(prev, next);
    const abx = cur.x - prev.x;
    const aby = cur.y - prev.y;
    const bcx = next.x - cur.x;
    const bcy = next.y - cur.y;
    const collinear =
      (Math.abs(abx) < ALIGN_EPS && Math.abs(bcx) < ALIGN_EPS) ||
      (Math.abs(aby) < ALIGN_EPS && Math.abs(bcy) < ALIGN_EPS);
    const reversed = abx * bcx + aby * bcy < -ALIGN_EPS;
    if (bounced) {
      // prev, spike, prev-again, rest → drop the spike and the return copy.
      out.splice(i, 2);
      continue;
    }
    if (collinear && reversed) {
      // Keep the perpendicular lead-out: dropping it would send the line back
      // through the port along the side of the box.
      const leadOut = i === 1 && segmentLength(prev, cur) <= PORT_STUB + 1;
      const leadIn = i === out.length - 2 && segmentLength(cur, next) <= PORT_STUB + 1;
      if (!leadOut && !leadIn) {
        out.splice(i, 1);
        continue;
      }
    }
    i++;
  }
  return out;
};

/**
 * If an interior hop is shorter than JOG_SNAP, pull the following run onto
 * the same line so a 6px "bridge" between two almost-aligned ports becomes a
 * straight wire. The real ports are never moved — a genuine Z that has to
 * change lane to meet the other box still meets it.
 */
const flattenShortJogs = (vertices: Vertex[]): Vertex[] => {
  if (vertices.length < 5) return vertices;
  const out = vertices.map((v) => ({ p: { ...v.p }, bends: v.bends }));
  for (let i = 1; i <= out.length - 4; i++) {
    const a = out[i].p;
    const b = out[i + 1].p;
    const hop = segmentLength(a, b);
    if (hop < ALIGN_EPS || hop >= JOG_SNAP) continue;
    if (Math.abs(a.x - b.x) < ALIGN_EPS) {
      const fromY = b.y;
      const toY = a.y;
      for (let k = i + 1; k < out.length - 1; k++) {
        const y = out[k].p.y;
        if (Math.abs(y - fromY) > ALIGN_EPS && Math.abs(y - toY) > ALIGN_EPS) break;
        if (Math.abs(y - fromY) <= ALIGN_EPS) out[k].p = { x: out[k].p.x, y: toY };
      }
    } else if (Math.abs(a.y - b.y) < ALIGN_EPS) {
      const fromX = b.x;
      const toX = a.x;
      for (let k = i + 1; k < out.length - 1; k++) {
        const x = out[k].p.x;
        if (Math.abs(x - fromX) > ALIGN_EPS && Math.abs(x - toX) > ALIGN_EPS) break;
        if (Math.abs(x - fromX) <= ALIGN_EPS) out[k].p = { x: toX, y: out[k].p.y };
      }
    }
  }
  return compact(out);
};

/**
 * Public entry for the same cleanup the renderer applies. Used by the router
 * and by `board_clean_arrows` so what is stored matches what is drawn.
 */
export const tidyOrthogonal = (points: Vec2[]): Vec2[] =>
  tidyVertices(points.map((p) => ({ p, bends: 0 }))).map((v) => v.p);

/**
 * Replaces every diagonal segment with a pair of axis-aligned ones.
 *
 * Bends are stored in world coordinates, so they go stale the moment a node
 * moves or a port shifts. Without this an orthogonal arrow would render as a
 * long diagonal cutting across the board; here the worst case is a staircase
 * that still reads as a wire.
 */
const rectify = (vertices: Vertex[], fromSide: FixedSide, toSide: FixedSide): Vertex[] => {
  if (vertices.length < 2) return vertices;
  const out: Vertex[] = [vertices[0]];
  let heading: Axis = axisOf(fromSide);

  for (let i = 1; i < vertices.length; i++) {
    const prev = out[out.length - 1].p;
    const next = vertices[i];
    if (aligned(prev, next.p)) {
      if (Math.abs(prev.x - next.p.x) >= ALIGN_EPS) heading = 'h';
      else if (Math.abs(prev.y - next.p.y) >= ALIGN_EPS) heading = 'v';
      out.push(next);
      continue;
    }
    // The last leg has to meet the port head-on; elsewhere keep the heading.
    const firstLegVertical =
      i === vertices.length - 1 ? axisOf(toSide) === 'h' : heading === 'v';
    const corner = firstLegVertical
      ? { x: prev.x, y: next.p.y }
      : { x: next.p.x, y: prev.y };
    out.push({ p: corner, bends: out[out.length - 1].bends });
    out.push(next);
    heading = firstLegVertical ? 'h' : 'v';
  }
  return out;
};

const stubOf = (port: Vec2, side: FixedSide, length = PORT_STUB): Vec2 => {
  const n = outwardNormal(side);
  return { x: port.x + n.x * length, y: port.y + n.y * length };
};

/** How far the perpendicular entry can run before it hits another box. */
export const approachLength = (
  port: Vec2,
  side: FixedSide,
  selfId: string,
  artifacts: Iterable<Artifact>,
): number => {
  let room = Infinity;
  const pad = 8;
  for (const other of artifacts) {
    if (other.id === selfId) continue;
    let gap = Infinity;
    if (side === 'left' || side === 'right') {
      const overlapsY = other.y < port.y + pad && other.y + other.height > port.y - pad;
      if (!overlapsY) continue;
      if (side === 'left' && other.x + other.width <= port.x + 0.5) {
        gap = port.x - (other.x + other.width);
      }
      if (side === 'right' && other.x >= port.x - 0.5) {
        gap = other.x - port.x;
      }
    } else {
      const overlapsX = other.x < port.x + pad && other.x + other.width > port.x - pad;
      if (!overlapsX) continue;
      if (side === 'top' && other.y + other.height <= port.y + 0.5) {
        gap = port.y - (other.y + other.height);
      }
      if (side === 'bottom' && other.y >= port.y - 0.5) {
        gap = other.y - port.y;
      }
    }
    if (gap < room) room = gap;
  }
  if (!Number.isFinite(room)) return PORT_STUB;
  return Math.max(8, Math.min(PORT_STUB, room - pad));
};

/**
 * Two 72px stubs in an 80px facing gap overlap and the polyline goes out,
 * back, then in. The last segment is still 90°, but the shaft is a zigzag.
 * Split the corridor so both lead-ins stay head-on and do not reverse.
 */
const fitFacingStubs = (
  from: Vec2,
  fromSide: FixedSide,
  fromLen: number,
  to: Vec2,
  toSide: FixedSide,
  toLen: number,
): [number, number] => {
  const fn = outwardNormal(fromSide);
  const tn = outwardNormal(toSide);
  if (fn.x * tn.x + fn.y * tn.y >= -0.5) return [fromLen, toLen];
  const gap = (to.x - from.x) * fn.x + (to.y - from.y) * fn.y;
  if (gap < 8) return [fromLen, toLen];
  const budget = Math.max(16, gap - 8);
  if (fromLen + toLen <= budget) return [fromLen, toLen];
  const scale = budget / (fromLen + toLen);
  return [Math.max(8, fromLen * scale), Math.max(8, toLen * scale)];
};

/**
 * Arrowhead at a port, pointed into the box — by the side, not by the last
 * path tangent. SVG `marker-end` with `orient="auto"` follows that tangent,
 * so a diagonal last segment (or a CSS-scaled overlay) makes the head lie
 * along the edge. The triangle must not.
 */
export const arrowHeadVertices = (tip: Vec2, side: FixedSide, size = 10): [Vec2, Vec2, Vec2] => {
  const n = outwardNormal(side);
  const ix = -n.x;
  const iy = -n.y;
  const backx = tip.x - ix * size;
  const backy = tip.y - iy * size;
  const hx = -iy * size * 0.55;
  const hy = ix * size * 0.55;
  return [tip, { x: backx + hx, y: backy + hy }, { x: backx - hx, y: backy - hy }];
};

/** True when `p` sits on the same line as the port's side (skimming the box). */
const onPortLine = (p: Vec2, port: Vec2, side: FixedSide): boolean =>
  side === 'top' || side === 'bottom'
    ? Math.abs(p.y - port.y) < ALIGN_EPS
    : Math.abs(p.x - port.x) < ALIGN_EPS;

/**
 * Last step: first and last segments are exactly the port stubs. Any remaining
 * diagonal gets a 90° corner — compacting that corner out is how a skim at 0°
 * used to come back.
 */
const finalizePorts = (
  vertices: Vertex[],
  fromSide: FixedSide,
  toSide: FixedSide,
  fromLen: number,
  toLen: number,
): Vertex[] => {
  if (vertices.length < 2) return vertices;
  const start = vertices[0];
  const end = vertices[vertices.length - 1];

  /**
   * How far the stub may run before it meets a turn of its own.
   *
   * The stub used to be drawn at full length whatever else was on that line.
   * When a bend sat closer than the stub — 42px out where the stub reaches 72 —
   * the line shot past it and came back, leaving a spike sticking out of the
   * box with nothing on the end of it. Stopping at the first turn along the
   * stub's own direction draws the same route without the doubling back.
   */
  const reach = (port: Vec2, side: FixedSide, length: number): number => {
    const normal = outwardNormal(side);
    let shortest = length;
    for (const vertex of vertices.slice(1, -1)) {
      const dx = vertex.p.x - port.x;
      const dy = vertex.p.y - port.y;
      const sideways = normal.x !== 0 ? dy : dx;
      if (Math.abs(sideways) > ALIGN_EPS) continue;
      const outward = normal.x !== 0 ? dx * normal.x : dy * normal.y;
      if (outward > ALIGN_EPS && outward < shortest) shortest = outward;
    }
    return shortest;
  };

  const stubFrom = { p: stubOf(start.p, fromSide, reach(start.p, fromSide, fromLen)), bends: 0 };
  const stubTo = { p: stubOf(end.p, toSide, reach(end.p, toSide, toLen)), bends: end.bends };

  const interior = vertices.slice(1, -1).filter((v) => {
    if (sameVertex(v.p, start.p) || sameVertex(v.p, end.p)) return false;
    if (sameVertex(v.p, stubFrom.p) || sameVertex(v.p, stubTo.p)) return false;
    if (onPortLine(v.p, start.p, fromSide) || onPortLine(v.p, end.p, toSide)) return false;
    return true;
  });

  const seq: Vertex[] = [start, stubFrom, ...interior, stubTo, end];
  const out: Vertex[] = [seq[0]];
  for (let i = 1; i < seq.length; i++) {
    const prev = out[out.length - 1];
    const next = seq[i];
    if (sameVertex(prev.p, next.p)) continue;
    if (!aligned(prev.p, next.p)) {
      const arrivingAtToStub = sameVertex(next.p, stubTo.p);
      const leavingFromStub = sameVertex(prev.p, stubFrom.p);
      const corner = arrivingAtToStub
        ? axisOf(toSide) === 'h'
          ? { x: stubTo.p.x, y: prev.p.y }
          : { x: prev.p.x, y: stubTo.p.y }
        : leavingFromStub
          ? axisOf(fromSide) === 'h'
            ? { x: stubFrom.p.x, y: next.p.y }
            : { x: next.p.x, y: stubFrom.p.y }
          : { x: prev.p.x, y: next.p.y };
      if (!sameVertex(corner, prev.p) && !sameVertex(corner, next.p)) {
        out.push({ p: corner, bends: prev.bends });
      }
    }
    out.push(next);
  }
  return compact(out);
};

/** Stretch any leftover run shorter than `MIN_EDGE` without moving the ports. */
const enforceMinEdges = (vertices: Vertex[]): Vertex[] => {
  if (vertices.length < 2) return vertices;
  const out = vertices.map((v) => ({ p: { ...v.p }, bends: v.bends }));
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i].p;
    const b = out[i + 1].p;
    const len = segmentLength(a, b);
    if (len >= MIN_EDGE - 0.5 || len < ALIGN_EPS) continue;
    const dirx = Math.sign(b.x - a.x);
    const diry = Math.sign(b.y - a.y);
    const need = MIN_EDGE - len;
    if (i + 1 < out.length - 1) {
      out[i + 1].p = { x: b.x + dirx * need, y: b.y + diry * need };
    } else if (i > 0) {
      out[i].p = { x: a.x - dirx * need, y: a.y - diry * need };
    }
  }
  return compact(out);
};

type ArtifactIndex = Map<string, Artifact>;

const indexOf = (artifacts: Artifact[] | ArtifactIndex): ArtifactIndex =>
  artifacts instanceof Map ? artifacts : new Map(artifacts.map((a) => [a.id, a]));

/** Coordinate used to order ports along a side so neighbouring arrows do not swap. */
const sortKeyFor = (side: FixedSide, target: Vec2): number =>
  side === 'top' || side === 'bottom' ? target.x : target.y;

interface Resolved {
  arrow: Arrow;
  from: Artifact;
  to: Artifact;
  fromSide: FixedSide;
  toSide: FixedSide;
  fromOffset: number | null;
  toOffset: number | null;
  fromTarget: Vec2;
  toTarget: Vec2;
}

interface SlotEntry {
  index: number;
  end: 'from' | 'to';
  sortKey: number;
}

const withStub = (
  anchor: Vec2,
  side: FixedSide,
  next: Vec2 | undefined,
  length: number,
): Vec2 | null => {
  const normal = outwardNormal(side);
  if (next) {
    const dx = next.x - anchor.x;
    const dy = next.y - anchor.y;
    if (Math.abs(dx) < ALIGN_EPS && Math.abs(dy) < ALIGN_EPS) return null;
    const along =
      (normal.x !== 0 && Math.abs(dy) < ALIGN_EPS && Math.sign(dx) === Math.sign(normal.x)) ||
      (normal.y !== 0 && Math.abs(dx) < ALIGN_EPS && Math.sign(dy) === Math.sign(normal.y));
    if (along) return null;
  }
  return { x: anchor.x + normal.x * length, y: anchor.y + normal.y * length };
};

/**
 * Geometry for every arrow at once. Ports are distributed across the arrows
 * that share a side, and each end gets a perpendicular lead-out so an arrow
 * always leaves a box at 90°, never along its edge.
 */
export const computeArrowGeometries = (
  artifacts: Artifact[] | ArtifactIndex,
  arrows: Arrow[],
): Map<string, ArrowGeometry> => {
  const byId = indexOf(artifacts);
  const resolved: Resolved[] = [];

  for (const arrow of arrows) {
    const from = byId.get(arrow.from.artifactId);
    const to = byId.get(arrow.to.artifactId);
    if (!from || !to) continue;

    const firstBend = arrow.bends[0];
    const lastBend = arrow.bends[arrow.bends.length - 1];
    const fromTarget = firstBend ?? centerOf(to);
    const toTarget = lastBend ?? centerOf(from);

    resolved.push({
      arrow,
      from,
      to,
      fromSide: arrow.from.side === 'auto' ? resolveSide(from, fromTarget) : arrow.from.side,
      toSide: arrow.to.side === 'auto' ? resolveSide(to, toTarget) : arrow.to.side,
      fromOffset: arrow.from.offset ?? null,
      toOffset: arrow.to.offset ?? null,
      fromTarget,
      toTarget,
    });
  }

  // Automatic ends on one side are spread. Pinned forks/joins keep a shared
  // point. Incoming + outgoing on the same pixel are split later.
  const groups = new Map<string, SlotEntry[]>();
  const push = (artifactId: string, side: FixedSide, entry: SlotEntry) => {
    const key = `${artifactId}|${side}`;
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  };

  resolved.forEach((item, index) => {
    if (item.fromOffset == null) {
      push(item.from.id, item.fromSide, {
        index,
        end: 'from',
        sortKey: sortKeyFor(item.fromSide, item.fromTarget),
      });
    }
    if (item.toOffset == null) {
      push(item.to.id, item.toSide, {
        index,
        end: 'to',
        sortKey: sortKeyFor(item.toSide, item.toTarget),
      });
    }
  });

  for (const entries of groups.values()) {
    if (entries.length === 1) {
      const only = entries[0];
      if (only.end === 'from') resolved[only.index].fromOffset = 0.5;
      else resolved[only.index].toOffset = 0.5;
      continue;
    }
    entries.sort((a, b) => a.sortKey - b.sortKey || a.index - b.index);
    // An even spread across the whole side, deliberately *without* the corner
    // inset. The spread never reaches a corner on its own — with n arrows the
    // outermost sits at 1/(n+1) of the side — and squeezing it into the inset
    // band shifts every port relative to the port it faces. Measured: it turned
    // four straight arrows into dog-legs on one board and doubled the turns on
    // another, both of which had no crossings to fix. The corner rule earns its
    // keep where ports are chosen one at a time; here it only misaligns them.
    entries.forEach((entry, slot) => {
      const offset = (slot + 1) / (entries.length + 1);
      if (entry.end === 'from') resolved[entry.index].fromOffset = offset;
      else resolved[entry.index].toOffset = offset;
    });
  }

  const pointOf = (item: Resolved, end: 'from' | 'to'): Vec2 =>
    end === 'from'
      ? anchorPoint(item.from, item.fromSide, item.fromOffset ?? 0.5)
      : anchorPoint(item.to, item.toSide, item.toOffset ?? 0.5);

  const byArtifact = new Map<string, Array<{ index: number; end: 'from' | 'to' }>>();
  resolved.forEach((item, index) => {
    const add = (id: string, end: 'from' | 'to') => {
      const list = byArtifact.get(id);
      if (list) list.push({ index, end });
      else byArtifact.set(id, [{ index, end }]);
    };
    add(item.from.id, 'from');
    add(item.to.id, 'to');
  });

  const setOffset = (ref: { index: number; end: 'from' | 'to' }, value: number) => {
    if (ref.end === 'from') resolved[ref.index].fromOffset = value;
    else resolved[ref.index].toOffset = value;
  };

  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (const ends of byArtifact.values()) {
      for (let i = 0; i < ends.length; i++) {
        for (let j = i + 1; j < ends.length; j++) {
          const a = ends[i];
          const b = ends[j];
          if (a.end === b.end) continue;
          const pa = pointOf(resolved[a.index], a.end);
          const pb = pointOf(resolved[b.index], b.end);
          if (Math.hypot(pa.x - pb.x, pa.y - pb.y) >= MIN_MIXED_PORT) continue;
          const item = resolved[b.index];
          const artifact = b.end === 'from' ? item.from : item.to;
          const side = b.end === 'from' ? item.fromSide : item.toSide;
          const len = side === 'top' || side === 'bottom' ? artifact.width : artifact.height;
          const current = (b.end === 'from' ? item.fromOffset : item.toOffset) ?? 0.5;
          const step = MIN_MIXED_PORT / Math.max(len, 1);
          const dir = pass % 2 === 0 ? 1 : -1;
          const nudged = clampOffset(current + dir * step);
          setOffset(b, nudged === current ? clampOffset(current + dir * 0.2) : nudged);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  const result = new Map<string, ArrowGeometry>();
  for (const item of resolved) {
    const fromOffset = item.fromOffset ?? 0.5;
    const toOffset = item.toOffset ?? 0.5;
    const fromPoint = anchorPoint(item.from, item.fromSide, fromOffset);
    const toPoint = anchorPoint(item.to, item.toSide, toOffset);

    const [fromLen, toLen] = fitFacingStubs(
      fromPoint,
      item.fromSide,
      approachLength(fromPoint, item.fromSide, item.from.id, byId.values()),
      toPoint,
      item.toSide,
      approachLength(toPoint, item.toSide, item.to.id, byId.values()),
    );

    const stored = item.arrow.bends;
    const vertices: Vertex[] = [{ p: fromPoint, bends: 0 }];
    const startStub = withStub(fromPoint, item.fromSide, stored[0] ?? toPoint, fromLen);
    if (startStub) vertices.push({ p: startStub, bends: 0 });
    stored.forEach((bend, index) => vertices.push({ p: bend, bends: index + 1 }));
    const endStub = withStub(toPoint, item.toSide, vertices[vertices.length - 1].p, toLen);
    if (endStub) vertices.push({ p: endStub, bends: stored.length });
    vertices.push({ p: toPoint, bends: stored.length });

    const laid = tidyVertices(compact(rectify(vertices, item.fromSide, item.toSide)));
    const final = finalizePorts(
      enforceMinEdges(laid),
      item.fromSide,
      item.toSide,
      fromLen,
      toLen,
    );

    result.set(item.arrow.id, {
      arrowId: item.arrow.id,
      points: final.map((v) => v.p),
      fromSide: item.fromSide,
      toSide: item.toSide,
      fromOffset,
      toOffset,
      fromPoint,
      toPoint,
      insertAt: final.slice(0, -1).map((v) => v.bends),
    });
  }
  return result;
};

/**
 * Full polyline for a single arrow. Ports are not distributed here, so prefer
 * `computeArrowGeometries` whenever the whole board is available.
 */
export const arrowGeometry = (
  arrow: Arrow,
  byId: ArtifactIndex,
): ArrowGeometry | null => computeArrowGeometries(byId, [arrow]).get(arrow.id) ?? null;

export interface LabelAnchor {
  /** Middle of the longest straight run of the arrow. */
  point: Vec2;
  /** Orientation of that run, so the label can be nudged off the line. */
  horizontal: boolean;
  length: number;
}

/**
 * Where an arrow label belongs. The longest straight run is used rather than
 * the middle vertex: a label parked on a corner sits where several arrows meet
 * and stops telling you which line it describes.
 */
export const labelAnchor = (points: Vec2[]): LabelAnchor | null => {
  if (points.length < 2) return null;
  let bestIndex = 1;
  let bestLength = -1;
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (length > bestLength) {
      bestLength = length;
      bestIndex = i;
    }
  }
  const a = points[bestIndex - 1];
  const b = points[bestIndex];
  return {
    point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    horizontal: Math.abs(b.x - a.x) >= Math.abs(b.y - a.y),
    length: bestLength,
  };
};

export const boundsOf = (items: Rect[]): Rect => {
  if (items.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + it.width);
    maxY = Math.max(maxY, it.y + it.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};
