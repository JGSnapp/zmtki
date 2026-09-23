import type { Arrow, Artifact, Rect, Vec2 } from './artifacts.js';
import {
  MIN_EDGE,
  MIN_MIXED_PORT,
  MIN_PORT_ANGLE_DEG,
  angleToSide,
  computeArrowGeometries,
  drawnPolyline,
  labelAnchor,
  rectsIntersect,
} from './geometry.js';

export type BoxSide = 'top' | 'right' | 'bottom' | 'left';

/**
 * The same polyline with vertices that sit on a straight run removed. Two
 * segments continuing in one direction are one edge to the eye, however many
 * points carry them.
 */
const straightRuns = (points: Vec2[]): Vec2[] => {
  if (points.length < 3) return points;
  const out: Vec2[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const next = points[i + 1];
    const here = points[i];
    const straightX = Math.abs(prev.x - here.x) < 0.5 && Math.abs(here.x - next.x) < 0.5;
    const straightY = Math.abs(prev.y - here.y) < 0.5 && Math.abs(here.y - next.y) < 0.5;
    if (straightX || straightY) continue;
    out.push(here);
  }
  out.push(points[points.length - 1]);
  return out;
};

/** How close to a shared port a meeting still counts as a fork, not a crossing. */
const FORK_RADIUS = 28;

export interface SegmentHit {
  point: Vec2;
  /** Distance along the whole polyline, for ordering. */
  along: number;
  segmentIndex: number;
}

export interface ArrowArtifactCrossing {
  kind: 'arrow_artifact';
  arrowId: string;
  artifactId: string;
  artifactType: string;
  /** Sides of the artifact box the polyline crosses (entry/exit order). */
  sides: BoxSide[];
  entrySide: BoxSide | null;
  exitSide: BoxSide | null;
  points: Vec2[];
  note: string;
}

export interface ArrowArrowCrossing {
  kind: 'arrow_arrow';
  arrowAId: string;
  arrowBId: string;
  point: Vec2;
  /** Crossing angle in degrees, 0..90. Shallow crossings read worse. */
  angle: number;
  shallow: boolean;
  note: string;
}

export interface ArrowOverlap {
  kind: 'arrow_overlap';
  arrowAId: string;
  arrowBId: string;
  /** How long the two arrows run on top of each other. */
  length: number;
  from: Vec2;
  to: Vec2;
  note: string;
}

export interface ArrowClearance {
  kind: 'arrow_clearance';
  arrowId: string;
  artifactId: string;
  artifactType: string;
  distance: number;
  required: number;
  point: Vec2;
  note: string;
}

export interface ArtifactOverlap {
  kind: 'artifact_artifact';
  aId: string;
  bId: string;
  aType: string;
  bType: string;
  /** Where B sits relative to the center of A. */
  bRelativeToA: BoxSide[];
  /** Where A sits relative to the center of B. */
  aRelativeToB: BoxSide[];
  overlap: Rect;
  note: string;
}

export interface TightSpacing {
  kind: 'tight_spacing';
  aId: string;
  bId: string;
  gap: number;
  required: number;
  axis: 'horizontal' | 'vertical';
  note: string;
}

export interface LabelConflict {
  kind: 'label_conflict';
  arrowId: string;
  /** Estimated label box; text metrics are approximated, not measured. */
  box: Rect;
  withArtifactId?: string;
  withArrowId?: string;
  note: string;
}

export interface ArrowPortAngle {
  kind: 'arrow_port_angle';
  arrowId: string;
  end: 'from' | 'to';
  side: BoxSide;
  angle: number;
  required: number;
  note: string;
}

export interface ArrowSharedPort {
  kind: 'arrow_shared_port';
  arrowAId: string;
  arrowBId: string;
  artifactId: string;
  point: Vec2;
  note: string;
}

export interface ArrowShortEdge {
  kind: 'arrow_short_edge';
  arrowId: string;
  length: number;
  required: number;
  note: string;
}

export type IntersectionFinding =
  | ArrowArtifactCrossing
  | ArrowArrowCrossing
  | ArrowOverlap
  | ArrowClearance
  | ArtifactOverlap
  | TightSpacing
  | LabelConflict
  | ArrowPortAngle
  | ArrowSharedPort
  | ArrowShortEdge;

export interface IntersectionCounts {
  arrowArtifact: number;
  arrowArrow: number;
  arrowOverlap: number;
  arrowClearance: number;
  artifactArtifact: number;
  tightSpacing: number;
  labelConflict: number;
  arrowPortAngle: number;
  arrowSharedPort: number;
  arrowShortEdge: number;
}

export interface IntersectionReport {
  region: Rect | null;
  /** True when no hard problem is left; soft hints may still be present. */
  ok: boolean;
  /** Arrow crossings allowed before `ok` turns false. */
  crossingBudget: number;
  counts: IntersectionCounts;
  findings: IntersectionFinding[];
}

const EPS = 1e-6;
const near = (a: Vec2, b: Vec2, tol = 1.5): boolean =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

const polylineLengthUpTo = (points: Vec2[], segmentIndex: number, t: number): number => {
  let along = 0;
  for (let i = 0; i < segmentIndex; i++) {
    const a = points[i];
    const b = points[i + 1];
    along += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const a = points[segmentIndex];
  const b = points[segmentIndex + 1];
  along += Math.hypot(b.x - a.x, b.y - a.y) * t;
  return along;
};

/** Proper / improper segment intersection. Returns point + param t on AB in [0,1]. */
export const segmentIntersection = (
  a: Vec2,
  b: Vec2,
  c: Vec2,
  d: Vec2,
): { point: Vec2; t: number; u: number } | null => {
  const dx1 = b.x - a.x;
  const dy1 = b.y - a.y;
  const dx2 = d.x - c.x;
  const dy2 = d.y - c.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < EPS) return null;
  const t = ((c.x - a.x) * dy2 - (c.y - a.y) * dx2) / denom;
  const u = ((c.x - a.x) * dy1 - (c.y - a.y) * dx1) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return {
    point: { x: a.x + t * dx1, y: a.y + t * dy1 },
    t: Math.min(1, Math.max(0, t)),
    u: Math.min(1, Math.max(0, u)),
  };
};

/** Angle between two segments in degrees, folded into 0..90. */
export const segmentAngle = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): number => {
  const a1 = Math.atan2(b.y - a.y, b.x - a.x);
  const a2 = Math.atan2(d.y - c.y, d.x - c.x);
  let deg = Math.abs(((a1 - a2) * 180) / Math.PI) % 180;
  if (deg > 90) deg = 180 - deg;
  return deg;
};

const rectEdges = (rect: Rect): Array<{ side: BoxSide; a: Vec2; b: Vec2 }> => {
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  return [
    { side: 'top', a: { x: rect.x, y: rect.y }, b: { x: x2, y: rect.y } },
    { side: 'right', a: { x: x2, y: rect.y }, b: { x: x2, y: y2 } },
    { side: 'bottom', a: { x: rect.x, y: y2 }, b: { x: x2, y: y2 } },
    { side: 'left', a: { x: rect.x, y: rect.y }, b: { x: rect.x, y: y2 } },
  ];
};

export const pointInRect = (p: Vec2, rect: Rect, pad = 0): boolean =>
  p.x >= rect.x - pad &&
  p.x <= rect.x + rect.width + pad &&
  p.y >= rect.y - pad &&
  p.y <= rect.y + rect.height + pad;

/** Hits of a polyline against the four sides of a rectangle, ordered along the path. */
export const polylineRectHits = (
  points: Vec2[],
  rect: Rect,
): Array<SegmentHit & { side: BoxSide }> => {
  const hits: Array<SegmentHit & { side: BoxSide }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    for (const edge of rectEdges(rect)) {
      const hit = segmentIntersection(a, b, edge.a, edge.b);
      if (!hit) continue;
      hits.push({
        point: { x: Math.round(hit.point.x), y: Math.round(hit.point.y) },
        along: polylineLengthUpTo(points, i, hit.t),
        segmentIndex: i,
        side: edge.side,
      });
    }
  }
  hits.sort((x, y) => x.along - y.along);
  // Deduplicate corner hits (same point counted on two edges).
  const unique: Array<SegmentHit & { side: BoxSide }> = [];
  for (const hit of hits) {
    const prev = unique[unique.length - 1];
    if (prev && near(prev.point, hit.point)) continue;
    unique.push(hit);
  }
  return unique;
};

/** Shortest distance from a point to a segment, plus the closest point. */
const pointSegmentDistance = (p: Vec2, a: Vec2, b: Vec2): { distance: number; point: Vec2 } => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < EPS) return { distance: Math.hypot(p.x - a.x, p.y - a.y), point: a };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.min(1, Math.max(0, t));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  return { distance: Math.hypot(p.x - point.x, p.y - point.y), point };
};

/** Distance from a segment to a rectangle; 0 when they touch or overlap. */
const segmentRectDistance = (a: Vec2, b: Vec2, rect: Rect): { distance: number; point: Vec2 } => {
  let best = { distance: Infinity, point: a };
  for (const edge of rectEdges(rect)) {
    if (segmentIntersection(a, b, edge.a, edge.b)) return { distance: 0, point: a };
    for (const [p, s1, s2] of [
      [a, edge.a, edge.b],
      [b, edge.a, edge.b],
      [edge.a, a, b],
      [edge.b, a, b],
    ] as Array<[Vec2, Vec2, Vec2]>) {
      const candidate = pointSegmentDistance(p, s1, s2);
      if (candidate.distance < best.distance) best = candidate;
    }
  }
  return best;
};

interface Overlap {
  length: number;
  from: Vec2;
  to: Vec2;
}

/**
 * Overlap of two nearly parallel segments: how long they visually merge into
 * a single line. Returns null when they are not parallel or not close enough.
 */
export const parallelOverlap = (
  a1: Vec2,
  a2: Vec2,
  b1: Vec2,
  b2: Vec2,
  tolerance: number,
): Overlap | null => {
  const d1 = { x: a2.x - a1.x, y: a2.y - a1.y };
  const d2 = { x: b2.x - b1.x, y: b2.y - b1.y };
  const len1 = Math.hypot(d1.x, d1.y);
  const len2 = Math.hypot(d2.x, d2.y);
  if (len1 < EPS || len2 < EPS) return null;

  const cross = Math.abs(d1.x * d2.y - d1.y * d2.x) / (len1 * len2);
  // sin(8°): anything more angled is a crossing, not a merge.
  if (cross > 0.139) return null;

  const ux = d1.x / len1;
  const uy = d1.y / len1;
  const perp = Math.abs((b1.x - a1.x) * -uy + (b1.y - a1.y) * ux);
  if (perp > tolerance) return null;

  const t1 = (b1.x - a1.x) * ux + (b1.y - a1.y) * uy;
  const t2 = (b2.x - a1.x) * ux + (b2.y - a1.y) * uy;
  const start = Math.max(0, Math.min(t1, t2));
  const end = Math.min(len1, Math.max(t1, t2));
  const length = end - start;
  if (length <= 0) return null;

  return {
    length,
    from: { x: Math.round(a1.x + ux * start), y: Math.round(a1.y + uy * start) },
    to: { x: Math.round(a1.x + ux * end), y: Math.round(a1.y + uy * end) },
  };
};

const sidesFacingOverlap = (self: Rect, other: Rect): BoxSide[] => {
  const sides: BoxSide[] = [];
  if (other.x + other.width > self.x && other.x < self.x + self.width) {
    if (other.y + other.height > self.y && other.y < self.y + 1) sides.push('top');
    if (other.y < self.y + self.height && other.y + other.height > self.y + self.height - 1) {
      sides.push('bottom');
    }
  }
  if (other.y + other.height > self.y && other.y < self.y + self.height) {
    if (other.x + other.width > self.x && other.x < self.x + 1) sides.push('left');
    if (other.x < self.x + self.width && other.x + other.width > self.x + self.width - 1) {
      sides.push('right');
    }
  }
  // Fallback: relative center position when boxes deeply overlap.
  if (sides.length === 0) {
    const acx = self.x + self.width / 2;
    const acy = self.y + self.height / 2;
    const bcx = other.x + other.width / 2;
    const bcy = other.y + other.height / 2;
    if (Math.abs(bcx - acx) >= Math.abs(bcy - acy)) sides.push(bcx >= acx ? 'right' : 'left');
    else sides.push(bcy >= acy ? 'bottom' : 'top');
  }
  return sides;
};

const overlapRect = (a: Rect, b: Rect): Rect => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
};

/** Gap between two non-overlapping boxes along the axis that separates them. */
const gapBetween = (a: Rect, b: Rect): { gap: number; axis: 'horizontal' | 'vertical' } | null => {
  const dx = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const dy = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  if (dx >= 0 && dy >= 0) return null; // diagonal neighbours never crowd each other
  if (dx >= 0) return { gap: dx, axis: 'horizontal' };
  if (dy >= 0) return { gap: dy, axis: 'vertical' };
  return null;
};

/** Rough label box; real text metrics live in the browser, this is an estimate. */
const CHAR_WIDTH = 6.5;
const LABEL_HEIGHT = 18;

/** Distance the label is nudged off its line; mirrors what the board draws. */
export const LABEL_GAP = 6;

const labelBox = (label: string, points: Vec2[]): Rect | null => {
  if (!label.trim()) return null;
  const anchor = labelAnchor(points);
  if (!anchor) return null;
  const width = Math.max(24, label.length * CHAR_WIDTH);
  // Above a horizontal run, to the right of a vertical one.
  return anchor.horizontal
    ? {
        x: anchor.point.x - width / 2,
        y: anchor.point.y - LABEL_HEIGHT - LABEL_GAP,
        width,
        height: LABEL_HEIGHT,
      }
    : {
        x: anchor.point.x + LABEL_GAP,
        y: anchor.point.y - LABEL_HEIGHT / 2,
        width,
        height: LABEL_HEIGHT,
      };
};

export interface CheckIntersectionsOptions {
  /** Limit analysis to a region (artifacts that intersect it + arrows touching them). */
  region?: Rect | null;
  /** Also report arrow–arrow crossings. Default true. */
  includeArrowArrow?: boolean;
  /** Also report overlapping artifacts. Default true. */
  includeArtifactOverlaps?: boolean;
  /** Also report arrows that visually merge into one line. Default true. */
  includeArrowOverlaps?: boolean;
  /** Also report arrows running too close to a box, and crowded boxes. Default true. */
  includeClearance?: boolean;
  /** Also report labels sitting on top of artifacts or other labels. Default true. */
  includeLabels?: boolean;
  /** Minimum air between neighbouring artifacts. Default 40. */
  minArtifactGap?: number;
  /** Minimum distance from an arrow to a foreign box. Default 12. */
  minArrowClearance?: number;
  /** Perpendicular distance under which two parallel arrows count as merged. Default 10. */
  mergeTolerance?: number;
  /** Overlap shorter than this is not worth reporting. Default 16. */
  minMergeLength?: number;
  /** Crossings flatter than this angle (degrees) are marked shallow. Default 25. */
  shallowAngle?: number;
  /**
   * How many arrow-to-arrow crossings `ok` tolerates. Default: the graph's
   * cyclomatic number, `arrows - artifacts + 1`, floored at zero.
   *
   * Demanding zero crossings made `ok` unreachable for six of eight bench
   * tasks and pushed the agent into endless edit loops chasing a planar drawing
   * that does not exist. A tree still gets a budget of zero, so a crossing on a
   * tree is still reported as a real defect. Crossings are priced in `cost`
   * either way — this only changes the pass/fail flag.
   */
  crossingBudget?: number;
}

/**
 * Finds layout problems: arrows cutting through boxes, arrows crossing or
 * merging with each other, crowded or overlapping artifacts and labels that
 * have nowhere to sit. Hard problems drive `ok`; the rest are hints.
 */
export const checkIntersections = (
  artifacts: Artifact[],
  arrows: Arrow[],
  options: CheckIntersectionsOptions = {},
): IntersectionReport => {
  const includeArrowArrow = options.includeArrowArrow !== false;
  const includeArtifactOverlaps = options.includeArtifactOverlaps !== false;
  const includeArrowOverlaps = options.includeArrowOverlaps !== false;
  const includeClearance = options.includeClearance !== false;
  const includeLabels = options.includeLabels !== false;
  const minArtifactGap = options.minArtifactGap ?? 40;
  const minArrowClearance = options.minArrowClearance ?? 12;
  const mergeTolerance = options.mergeTolerance ?? 10;
  const minMergeLength = options.minMergeLength ?? 16;
  const shallowAngle = options.shallowAngle ?? 25;
  const region = options.region ?? null;

  const scopedArtifacts = region ? artifacts.filter((a) => rectsIntersect(a, region)) : artifacts;
  const scopedIds = new Set(scopedArtifacts.map((a) => a.id));

  const scopedArrows = region
    ? arrows.filter(
        (arrow) => scopedIds.has(arrow.from.artifactId) || scopedIds.has(arrow.to.artifactId),
      )
    : arrows;

  const geometries = computeArrowGeometries(artifacts, arrows);
  const findings: IntersectionFinding[] = [];
  const polylines = new Map<string, Vec2[]>();
  const arrowById = new Map(arrows.map((a) => [a.id, a]));

  for (const arrow of scopedArrows) {
    const geometry = geometries.get(arrow.id);
    if (!geometry) continue;
    // Crossings, cuts through blocks and clearances are facts about the line
    // the reader sees. On a curved arrow that is not the route: the corners are
    // arcs, and an arc sits inside its turn. Everything below that judges the
    // drawing measures this; what judges the route still reads
    // `geometry.points`, because an arc is one turn however finely it is cut.
    const drawn = drawnPolyline(geometry.points, arrow.routing);
    polylines.set(arrow.id, drawn);

    const first = geometry.points[0];
    const second = geometry.points[1];
    if (first && second) {
      const out = { x: second.x - first.x, y: second.y - first.y };
      const angle = angleToSide(out, geometry.fromSide);
      if (angle < MIN_PORT_ANGLE_DEG - 0.5) {
        findings.push({
          kind: 'arrow_port_angle',
          arrowId: arrow.id,
          end: 'from',
          side: geometry.fromSide,
          angle: Math.round(angle),
          required: MIN_PORT_ANGLE_DEG,
          note: `Стрелка ${arrow.id} выходит из ${geometry.fromSide} под ${Math.round(angle)}° (нужно от ${MIN_PORT_ANGLE_DEG}°). Поставь сторону напротив соседа или вызови board_route_arrows.`,
        });
      }
    }
    const last = geometry.points[geometry.points.length - 1];
    const prev = geometry.points[geometry.points.length - 2];
    if (last && prev) {
      const out = { x: prev.x - last.x, y: prev.y - last.y };
      const angle = angleToSide(out, geometry.toSide);
      if (angle < MIN_PORT_ANGLE_DEG - 0.5) {
        findings.push({
          kind: 'arrow_port_angle',
          arrowId: arrow.id,
          end: 'to',
          side: geometry.toSide,
          angle: Math.round(angle),
          required: MIN_PORT_ANGLE_DEG,
          note: `Стрелка ${arrow.id} входит в ${geometry.toSide} под ${Math.round(angle)}° (нужно от ${MIN_PORT_ANGLE_DEG}°). Так линия выглядит сломанной. Сторона должна смотреть на соседа, либо вызови board_route_arrows.`,
        });
      }
    }

    // The first and last runs are renderer-managed port stubs and may be
    // shorter than MIN_EDGE in an otherwise valid route. Only inner segments
    // represent actual bend spacing that the user/router can improve.
    //
    // Collinear points are merged first, because the renderer puts a vertex at
    // the end of each port stub whether or not the line turns there. On a
    // straight arrow between boxes 160px apart the stubs take 72px each and
    // leave 16px between them — which was reported as a 16px edge on a line
    // that has no bends at all. Five such arrows on one timeline board cost 20
    // penalty points and dropped it from 100 to 56.
    const run = straightRuns(geometry.points);
    for (let i = 2; i < run.length - 1; i++) {
      const a = run[i - 1];
      const b = run[i];
      const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      if (length >= MIN_EDGE - 0.5 || length < 0.5) continue;
      findings.push({
        kind: 'arrow_short_edge',
        arrowId: arrow.id,
        length: Math.round(length),
        required: MIN_EDGE,
        note: `Стрелка ${arrow.id}: ребро ${Math.round(length)}px короче минимума ${MIN_EDGE}px (между сгибами или концами).`,
      });
    }

    for (const artifact of scopedArtifacts) {
      const isEndpoint =
        artifact.id === arrow.from.artifactId || artifact.id === arrow.to.artifactId;
      const hits = polylineRectHits(drawn, artifact);

      if (hits.length === 0) {
        if (
          !isEndpoint &&
          drawn.some(
            (p, index) =>
              index > 0 && index < drawn.length - 1 && pointInRect(p, artifact),
          )
        ) {
          findings.push({
            kind: 'arrow_artifact',
            arrowId: arrow.id,
            artifactId: artifact.id,
            artifactType: artifact.type,
            sides: [],
            entrySide: null,
            exitSide: null,
            points: [],
            note: `Стрелка ${arrow.id} проходит внутри артефакта ${artifact.id} без явного пересечения границы.`,
          });
          continue;
        }

        if (includeClearance && !isEndpoint) {
          let closest = { distance: Infinity, point: drawn[0] };
          for (let i = 0; i < drawn.length - 1; i++) {
            const candidate = segmentRectDistance(drawn[i], drawn[i + 1], artifact);
            if (candidate.distance < closest.distance) closest = candidate;
          }
          if (closest.distance < minArrowClearance) {
            findings.push({
              kind: 'arrow_clearance',
              arrowId: arrow.id,
              artifactId: artifact.id,
              artifactType: artifact.type,
              distance: Math.round(closest.distance),
              required: minArrowClearance,
              point: { x: Math.round(closest.point.x), y: Math.round(closest.point.y) },
              note: `Стрелка ${arrow.id} проходит в ${Math.round(closest.distance)}px от ${artifact.id} (нужно ${minArrowClearance}px).`,
            });
          }
        }
        continue;
      }

      // Ignore pure endpoint attachments: a single touch near the anchor.
      if (isEndpoint && hits.length < 2) continue;

      const sides = hits.map((h) => h.side);
      const entrySide = hits[0]?.side ?? null;
      const exitSide = hits.length > 1 ? hits[hits.length - 1].side : null;
      const points = hits.map((h) => h.point);
      const sideText =
        entrySide && exitSide && entrySide !== exitSide
          ? `входит через ${entrySide}, выходит через ${exitSide}`
          : `пересекает сторону(ы) ${[...new Set(sides)].join(', ')}`;

      findings.push({
        kind: 'arrow_artifact',
        arrowId: arrow.id,
        artifactId: artifact.id,
        artifactType: artifact.type,
        sides: [...new Set(sides)],
        entrySide,
        exitSide,
        points,
        note: `Стрелка ${arrow.id} пересекает ${artifact.type} ${artifact.id}: ${sideText}.`,
      });
    }
  }

  const portEnds: Array<{ arrowId: string; artifactId: string; point: Vec2; end: 'from' | 'to' }> =
    [];
  for (const arrow of scopedArrows) {
    const geometry = geometries.get(arrow.id);
    if (!geometry) continue;
    portEnds.push({
      arrowId: arrow.id,
      artifactId: arrow.from.artifactId,
      point: geometry.fromPoint,
      end: 'from',
    });
    portEnds.push({
      arrowId: arrow.id,
      artifactId: arrow.to.artifactId,
      point: geometry.toPoint,
      end: 'to',
    });
  }
  for (let i = 0; i < portEnds.length; i++) {
    for (let j = i + 1; j < portEnds.length; j++) {
      const a = portEnds[i];
      const b = portEnds[j];
      if (a.arrowId === b.arrowId || a.artifactId !== b.artifactId) continue;
      if (a.end === b.end) continue;
      if (!near(a.point, b.point, MIN_MIXED_PORT - 0.5)) continue;
      findings.push({
        kind: 'arrow_shared_port',
        arrowAId: a.arrowId,
        arrowBId: b.arrowId,
        artifactId: a.artifactId,
        point: { x: Math.round(a.point.x), y: Math.round(a.point.y) },
        note: `На ${a.artifactId} вход и выход ближе ${MIN_MIXED_PORT}px (${Math.round(a.point.x)}, ${Math.round(a.point.y)}). Две исходящие или две входящие могут делить точку, смешанные — нет.`,
      });
    }
  }

  if (includeArrowArrow || includeArrowOverlaps) {
    const list = [...polylines.entries()];
    for (let i = 0; i < list.length; i++) {
      const [idA, ptsA] = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const [idB, ptsB] = list[j];
        const arrowA = arrowById.get(idA);
        const arrowB = arrowById.get(idB);
        const sharedPorts: Vec2[] = [];
        if (arrowA && arrowB) {
          const endsA = [
            { id: arrowA.from.artifactId, point: ptsA[0] },
            { id: arrowA.to.artifactId, point: ptsA[ptsA.length - 1] },
          ];
          const endsB = [
            { id: arrowB.from.artifactId, point: ptsB[0] },
            { id: arrowB.to.artifactId, point: ptsB[ptsB.length - 1] },
          ];
          for (const ea of endsA) {
            for (const eb of endsB) {
              if (ea.id === eb.id && near(ea.point, eb.point, 2)) sharedPorts.push(ea.point);
            }
          }
        }

        let merged: (Overlap & { reported: boolean }) | null = null;

        // One crossing, one finding.
        //
        // The loops below test every segment of A against every segment of B,
        // and a polyline often carries a redundant vertex on a straight run —
        // `1600,604 1600,676 1600,714 1600,786` is one line through three
        // segments. When the crossing falls on such a vertex both neighbouring
        // segments report it, and the pair was counted twice: one board showed
        // six crossings where five were distinct, and every penalty built on
        // that count was inflated with it.
        const seen = new Set<string>();

        // Where the two lines run along one another.
        //
        // Two arrows out of one port share a run and then part. The point where
        // they part sits on both lines, so the crossing test calls it a
        // crossing — at whatever shallow angle the parting takes. Sharp, that
        // angle was 90° and the pair was reported as merged instead; drawn
        // round, the arc lifts away at five degrees and the same parting became
        // a hundred "shallow crossings" across the corpus. A meeting inside a
        // shared run is a parting, not a crossing.
        const shared: Array<{ from: Vec2; to: Vec2 }> = [];
        for (let sa = 0; sa < ptsA.length - 1; sa++) {
          for (let sb = 0; sb < ptsB.length - 1; sb++) {
            const overlap = parallelOverlap(
              ptsA[sa],
              ptsA[sa + 1],
              ptsB[sb],
              ptsB[sb + 1],
              mergeTolerance,
            );
            if (overlap && overlap.length >= minMergeLength) {
              shared.push({ from: overlap.from, to: overlap.to });
            }
          }
        }
        const onSharedRun = (point: Vec2): boolean =>
          shared.some(({ from, to }) => {
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const len = dx * dx + dy * dy;
            if (len < 1e-6) return false;
            let t = ((point.x - from.x) * dx + (point.y - from.y) * dy) / len;
            t = Math.max(0, Math.min(1, t));
            return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy)) <= mergeTolerance;
          });

        for (let sa = 0; sa < ptsA.length - 1; sa++) {
          for (let sb = 0; sb < ptsB.length - 1; sb++) {
            if (includeArrowOverlaps) {
              const overlap = parallelOverlap(
                ptsA[sa],
                ptsA[sa + 1],
                ptsB[sb],
                ptsB[sb + 1],
                mergeTolerance,
              );
              if (overlap && overlap.length >= minMergeLength) {
                // A deliberate fork shares one port: overlap next to it is fine.
                const atFork = sharedPorts.some(
                  (port) =>
                    Math.hypot(port.x - overlap.from.x, port.y - overlap.from.y) <= FORK_RADIUS ||
                    Math.hypot(port.x - overlap.to.x, port.y - overlap.to.y) <= FORK_RADIUS,
                );
                if (!atFork && (!merged || overlap.length > merged.length)) {
                  merged = { ...overlap, reported: false };
                }
              }
            }

            if (!includeArrowArrow) continue;
            const hit = segmentIntersection(ptsA[sa], ptsA[sa + 1], ptsB[sb], ptsB[sb + 1]);
            if (!hit) continue;
            // Two arrows leaving one port are a fork, not a crossing.
            //
            // This used to be decided by segment index — first or last segment,
            // at its very end. That held while a polyline was the route itself,
            // and broke the moment a curved arrow was cut into arcs: the fork
            // then met a few sampled segments in, the rule stopped recognising
            // it, and a board full of forks grew a hundred "crossings" at five
            // degrees. Distance from the shared port says the same thing and
            // does not care how finely the line is cut.
            const atFork = sharedPorts.some(
              (port) => Math.hypot(port.x - hit.point.x, port.y - hit.point.y) <= FORK_RADIUS,
            );
            if (atFork) continue;
            if (onSharedRun(hit.point)) continue;
            const atEndA = (sa === 0 && hit.t < 0.02) || (sa === ptsA.length - 2 && hit.t > 0.98);
            const atEndB = (sb === 0 && hit.u < 0.02) || (sb === ptsB.length - 2 && hit.u > 0.98);
            if (atEndA && atEndB) continue;
            const spot = `${Math.round(hit.point.x)}:${Math.round(hit.point.y)}`;
            if (seen.has(spot)) continue;
            seen.add(spot);
            const angle = segmentAngle(ptsA[sa], ptsA[sa + 1], ptsB[sb], ptsB[sb + 1]);
            const shallow = angle < shallowAngle;
            findings.push({
              kind: 'arrow_arrow',
              arrowAId: idA,
              arrowBId: idB,
              point: { x: Math.round(hit.point.x), y: Math.round(hit.point.y) },
              angle: Math.round(angle),
              shallow,
              note: `Стрелки ${idA} и ${idB} пересекаются в (${Math.round(hit.point.x)}, ${Math.round(hit.point.y)}) под углом ${Math.round(angle)}°${shallow ? ' — слишком полого, разведи их' : ''}.`,
            });
          }
        }

        if (merged) {
          findings.push({
            kind: 'arrow_overlap',
            arrowAId: idA,
            arrowBId: idB,
            length: Math.round(merged.length),
            from: merged.from,
            to: merged.to,
            note: `Стрелки ${idA} и ${idB} сливаются в одну линию на ${Math.round(merged.length)}px (от (${merged.from.x}, ${merged.from.y}) до (${merged.to.x}, ${merged.to.y})) — разведи их.`,
          });
        }
      }
    }
  }

  if (includeArtifactOverlaps || includeClearance) {
    for (let i = 0; i < scopedArtifacts.length; i++) {
      for (let j = i + 1; j < scopedArtifacts.length; j++) {
        const a = scopedArtifacts[i];
        const b = scopedArtifacts[j];
        if (rectsIntersect(a, b)) {
          if (!includeArtifactOverlaps) continue;
          // A stack of photos or a badge on a card is an overlap on purpose.
          // Reporting it as a defect would make the metric argue with what the
          // user asked for.
          if (a.allowOverlap || b.allowOverlap) continue;
          const overlap = overlapRect(a, b);
          if (overlap.width < 1 || overlap.height < 1) continue;
          const bRelativeToA = sidesFacingOverlap(a, b);
          const aRelativeToB = sidesFacingOverlap(b, a);
          findings.push({
            kind: 'artifact_artifact',
            aId: a.id,
            bId: b.id,
            aType: a.type,
            bType: b.type,
            bRelativeToA,
            aRelativeToB,
            overlap,
            note: `Артефакты ${a.id} и ${b.id} пересекаются: ${b.id} со стороны ${bRelativeToA.join('/')} у ${a.id}.`,
          });
          continue;
        }

        if (!includeClearance) continue;
        // Deliberate crowding covers proximity too: a stack of photos was left
        // with the whole penalty as "blocks stand too close" once the overlap
        // itself stopped counting.
        if (a.allowOverlap || b.allowOverlap) continue;
        const gap = gapBetween(a, b);
        if (gap && gap.gap < minArtifactGap) {
          findings.push({
            kind: 'tight_spacing',
            aId: a.id,
            bId: b.id,
            gap: Math.round(gap.gap),
            required: minArtifactGap,
            axis: gap.axis,
            note: `Между ${a.id} и ${b.id} всего ${Math.round(gap.gap)}px по ${gap.axis === 'horizontal' ? 'горизонтали' : 'вертикали'} (нужно ${minArtifactGap}px).`,
          });
        }
      }
    }
  }

  if (includeLabels) {
    const boxes: Array<{ arrowId: string; box: Rect }> = [];
    for (const arrow of scopedArrows) {
      const points = polylines.get(arrow.id);
      if (!points || !arrow.label) continue;
      const box = labelBox(arrow.label, points);
      if (box) boxes.push({ arrowId: arrow.id, box });
    }

    for (const entry of boxes) {
      for (const artifact of scopedArtifacts) {
        if (!rectsIntersect(entry.box, artifact)) continue;
        findings.push({
          kind: 'label_conflict',
          arrowId: entry.arrowId,
          box: entry.box,
          withArtifactId: artifact.id,
          note: `Подпись стрелки ${entry.arrowId} накладывается на ${artifact.id} — нужно больше места вдоль стрелки.`,
        });
      }
    }

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (!rectsIntersect(boxes[i].box, boxes[j].box)) continue;
        findings.push({
          kind: 'label_conflict',
          arrowId: boxes[i].arrowId,
          box: boxes[i].box,
          withArrowId: boxes[j].arrowId,
          note: `Подписи стрелок ${boxes[i].arrowId} и ${boxes[j].arrowId} накладываются друг на друга.`,
        });
      }
    }
  }

  const counts: IntersectionCounts = {
    arrowArtifact: findings.filter((f) => f.kind === 'arrow_artifact').length,
    arrowArrow: findings.filter((f) => f.kind === 'arrow_arrow').length,
    arrowOverlap: findings.filter((f) => f.kind === 'arrow_overlap').length,
    arrowClearance: findings.filter((f) => f.kind === 'arrow_clearance').length,
    artifactArtifact: findings.filter((f) => f.kind === 'artifact_artifact').length,
    tightSpacing: findings.filter((f) => f.kind === 'tight_spacing').length,
    labelConflict: findings.filter((f) => f.kind === 'label_conflict').length,
    arrowPortAngle: findings.filter((f) => f.kind === 'arrow_port_angle').length,
    arrowSharedPort: findings.filter((f) => f.kind === 'arrow_shared_port').length,
    arrowShortEdge: findings.filter((f) => f.kind === 'arrow_short_edge').length,
  };

  const crossingBudget =
    options.crossingBudget ??
    Math.max(0, scopedArrows.length - scopedArtifacts.length + 1);

  return {
    region,
    crossingBudget,
    ok:
      counts.arrowArtifact === 0 &&
      counts.arrowArrow <= crossingBudget &&
      counts.arrowOverlap === 0 &&
      counts.artifactArtifact === 0 &&
      counts.arrowPortAngle === 0 &&
      counts.arrowSharedPort === 0 &&
      counts.arrowShortEdge === 0,
    counts,
    findings,
  };
};
