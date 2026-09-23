import type { Rect } from './artifacts.js';
import type { Zone } from './zones.js';

/**
 * Zones are kept as a set of axis-aligned rectangles and drawn as one shape.
 *
 * Everything here works on that set: adding a rectangle, cutting one out, and
 * deriving the outline of the union for rendering. Rectangles are the only
 * primitive on purpose — they are what a user sweeps out with the pointer and
 * what an agent can ask for in numbers, and every operation on them stays exact
 * with integer coordinates.
 */

const EPS = 0.01;

const area = (r: Rect): number => r.width * r.height;

export const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width - EPS && a.x + a.width > b.x + EPS && a.y < b.y + b.height - EPS && a.y + a.height > b.y + EPS;

/** True when `inner` lies entirely within `outer` (touching edges count as inside). */
export const rectInside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x - EPS &&
  inner.y >= outer.y - EPS &&
  inner.x + inner.width <= outer.x + outer.width + EPS &&
  inner.y + inner.height <= outer.y + outer.height + EPS;

/**
 * `source` minus `cut`, as up to four rectangles: the strips left above, below,
 * left and right of the cut. This is what "subtract a square from the zone"
 * does to each piece the square touches.
 */
export const subtractRect = (source: Rect, cut: Rect): Rect[] => {
  if (!rectsOverlap(source, cut)) return [source];
  const out: Rect[] = [];
  const top = Math.max(source.y, cut.y);
  const bottom = Math.min(source.y + source.height, cut.y + cut.height);
  if (cut.y > source.y + EPS) out.push({ x: source.x, y: source.y, width: source.width, height: cut.y - source.y });
  if (cut.y + cut.height < source.y + source.height - EPS) {
    out.push({
      x: source.x,
      y: cut.y + cut.height,
      width: source.width,
      height: source.y + source.height - (cut.y + cut.height),
    });
  }
  if (cut.x > source.x + EPS) out.push({ x: source.x, y: top, width: cut.x - source.x, height: bottom - top });
  if (cut.x + cut.width < source.x + source.width - EPS) {
    out.push({ x: cut.x + cut.width, y: top, width: source.x + source.width - (cut.x + cut.width), height: bottom - top });
  }
  return out.filter((r) => r.width > EPS && r.height > EPS);
};

/** Every rectangle of the set with `cut` removed from it. */
export const subtractFromRects = (rects: Rect[], cut: Rect): Rect[] =>
  rects.flatMap((rect) => subtractRect(rect, cut));

/**
 * Tidies a set without changing the area it covers: drops pieces swallowed by
 * another, and cuts the overlap out of the smaller one so the pieces only
 * touch. A zone the user swept over twice then has no stacked rectangles, and
 * the outline below has no seams inside it.
 */
export const normalizeRects = (rects: Rect[]): Rect[] => {
  const kept: Rect[] = [];
  for (const rect of [...rects].sort((a, b) => area(b) - area(a))) {
    let pieces: Rect[] = [rect];
    for (const other of kept) pieces = pieces.flatMap((piece) => subtractRect(piece, other));
    kept.push(...pieces.filter((piece) => piece.width > EPS && piece.height > EPS));
  }
  return kept.map((r) => ({
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  }));
};

/** Adds a rectangle to a zone's set, leaving no stacked pieces behind. */
export const addRect = (rects: Rect[], added: Rect): Rect[] => normalizeRects([...rects, added]);

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The outline of the union: the parts of every rectangle's edges that no other
 * rectangle covers. Drawing these instead of four borders per rectangle is what
 * makes two swept squares of one zone read as a single shape.
 */
export const zoneOutline = (rects: Rect[]): Segment[] => {
  const out: Segment[] = [];
  const spans = (from: number, to: number, covered: Array<[number, number]>): Array<[number, number]> => {
    const free: Array<[number, number]> = [];
    let at = from;
    for (const [start, end] of covered.sort((a, b) => a[0] - b[0])) {
      if (end <= at + EPS) continue;
      if (start > at + EPS) free.push([at, Math.min(start, to)]);
      at = Math.max(at, end);
      if (at >= to - EPS) break;
    }
    if (at < to - EPS) free.push([at, to]);
    return free.filter(([a, b]) => b - a > EPS);
  };

  rects.forEach((rect, index) => {
    const others = rects.filter((_, i) => i !== index);
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;

    // An edge is interior where another rectangle occupies the space on its far
    // side — whether it overlaps this one or merely butts against it. A
    // neighbour starting exactly on the edge still hides it, which is what
    // makes two swept squares read as one shape.
    for (const [y, neighbourSide] of [
      [rect.y, (o: Rect) => o.y < rect.y - EPS && o.y + o.height >= rect.y - EPS],
      [bottom, (o: Rect) => o.y + o.height > bottom + EPS && o.y <= bottom + EPS],
    ] as Array<[number, (o: Rect) => boolean]>) {
      const covered = others
        .filter((o) => neighbourSide(o) && o.x < right - EPS && o.x + o.width > rect.x + EPS)
        .map((o) => [Math.max(o.x, rect.x), Math.min(o.x + o.width, right)] as [number, number]);
      for (const [x1, x2] of spans(rect.x, right, covered)) out.push({ x1, y1: y, x2, y2: y });
    }

    for (const [x, neighbourSide] of [
      [rect.x, (o: Rect) => o.x < rect.x - EPS && o.x + o.width >= rect.x - EPS],
      [right, (o: Rect) => o.x + o.width > right + EPS && o.x <= right + EPS],
    ] as Array<[number, (o: Rect) => boolean]>) {
      const covered = others
        .filter((o) => neighbourSide(o) && o.y < bottom - EPS && o.y + o.height > rect.y + EPS)
        .map((o) => [Math.max(o.y, rect.y), Math.min(o.y + o.height, bottom)] as [number, number]);
      for (const [y1, y2] of spans(rect.y, bottom, covered)) out.push({ x1: x, y1, x2: x, y2 });
    }
  });
  return out;
};

/** True when the rectangle is covered by the zone — the test an agent's placement must pass. */
export const zoneContainsRect = (zone: Zone, rect: Rect): boolean => {
  let remaining: Rect[] = [rect];
  for (const piece of zone.rects) {
    remaining = remaining.flatMap((part) => subtractRect(part, piece));
    if (remaining.length === 0) return true;
  }
  return remaining.every((part) => part.width <= EPS || part.height <= EPS);
};

/** Total area a zone covers, for showing how big it is. */
export const zoneArea = (zone: Zone): number => normalizeRects(zone.rects).reduce((sum, r) => sum + area(r), 0);
