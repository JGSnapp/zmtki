import { nearestSides, sideMidpoint, type EdgeSide } from '@zmtki/board-schema';
import type { BoardEdge, BoardNode } from '@zmtki/board-schema';

export type Box = {
  id: string;
  position: { x: number; y: number };
  size: { w: number; h: number };
};

export type TouchZone = 'top' | 'bottom' | 'left' | 'right' | 'center';

export type NodeOverlap = {
  otherId: string;
  overlapArea: number;
};

export type LineNodeHit = {
  nodeId: string;
  zone: TouchZone;
};

export type EdgeCross = {
  otherEdgeId: string;
  label: string;
};

function rect(b: Box): { x1: number; y1: number; x2: number; y2: number } {
  return {
    x1: b.position.x,
    y1: b.position.y,
    x2: b.position.x + b.size.w,
    y2: b.position.y + b.size.h
  };
}

function overlapArea(a: Box, b: Box): number {
  const A = rect(a);
  const B = rect(b);
  const w = Math.min(A.x2, B.x2) - Math.max(A.x1, B.x1);
  const h = Math.min(A.y2, B.y2) - Math.max(A.y1, B.y1);
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/** Ignore frames/groups/ghosts/hidden and the moving node itself. */
export function collisionCandidates(
  nodes: readonly BoardNode[],
  excludeIds: ReadonlySet<string>
): Box[] {
  return nodes
    .filter(
      (n) =>
        !excludeIds.has(n.id) &&
        !n.hidden &&
        n.visualState !== 'ghost' &&
        n.type !== 'frame' &&
        n.type !== 'group'
    )
    .map((n) => ({ id: n.id, position: n.position, size: n.size }));
}

export function findOverlaps(placed: Box, others: readonly Box[], minArea = 48): NodeOverlap[] {
  const hits: NodeOverlap[] = [];
  for (const other of others) {
    const area = overlapArea(placed, other);
    if (area >= minArea) hits.push({ otherId: other.id, overlapArea: area });
  }
  hits.sort((a, b) => b.overlapArea - a.overlapArea);
  return hits;
}

function orient(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): number {
  return (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
}

function onSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): boolean {
  return (
    Math.min(ax, bx) - 0.5 <= cx &&
    cx <= Math.max(ax, bx) + 0.5 &&
    Math.min(ay, by) - 0.5 <= cy &&
    cy <= Math.max(ay, by) + 0.5
  );
}

/** Proper or improper intersection of segments AB and CD. */
export function segmentsIntersect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number }
): boolean {
  const o1 = orient(a.x, a.y, b.x, b.y, c.x, c.y);
  const o2 = orient(a.x, a.y, b.x, b.y, d.x, d.y);
  const o3 = orient(c.x, c.y, d.x, d.y, a.x, a.y);
  const o4 = orient(c.x, c.y, d.x, d.y, b.x, b.y);
  if (o1 === 0 && onSegment(a.x, a.y, b.x, b.y, c.x, c.y)) return true;
  if (o2 === 0 && onSegment(a.x, a.y, b.x, b.y, d.x, d.y)) return true;
  if (o3 === 0 && onSegment(c.x, c.y, d.x, d.y, a.x, a.y)) return true;
  if (o4 === 0 && onSegment(c.x, c.y, d.x, d.y, b.x, b.y)) return true;
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function classifyTouchZone(
  box: Box,
  enter: { x: number; y: number },
  exit: { x: number; y: number }
): TouchZone {
  const r = rect(box);
  const mx = (enter.x + exit.x) / 2;
  const my = (enter.y + exit.y) / 2;
  const nx = (mx - r.x1) / Math.max(1, box.size.w);
  const ny = (my - r.y1) / Math.max(1, box.size.h);
  // Near a side if within the outer 28% band on that axis.
  const nearLeft = nx < 0.28;
  const nearRight = nx > 0.72;
  const nearTop = ny < 0.28;
  const nearBottom = ny > 0.72;
  if (nearLeft && !nearTop && !nearBottom) return 'left';
  if (nearRight && !nearTop && !nearBottom) return 'right';
  if (nearTop && !nearLeft && !nearRight) return 'top';
  if (nearBottom && !nearLeft && !nearRight) return 'bottom';
  if (nearTop) return 'top';
  if (nearBottom) return 'bottom';
  if (nearLeft) return 'left';
  if (nearRight) return 'right';
  return 'center';
}

function clipSegmentToRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: Box
): { enter: { x: number; y: number }; exit: { x: number; y: number } } | null {
  // Liang–Barsky
  const r = rect(box);
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks: Array<[number, number]> = [
    [-dx, a.x - r.x1],
    [dx, r.x2 - a.x],
    [-dy, a.y - r.y1],
    [dy, r.y2 - a.y]
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  if (t0 > t1) return null;
  // Ignore grazing touches that barely clip the corner.
  if (t1 - t0 < 0.02) return null;
  return {
    enter: { x: a.x + t0 * dx, y: a.y + t0 * dy },
    exit: { x: a.x + t1 * dx, y: a.y + t1 * dy }
  };
}

export function lineHitsNodes(
  from: { x: number; y: number },
  to: { x: number; y: number },
  nodes: readonly Box[],
  excludeIds: ReadonlySet<string>
): LineNodeHit[] {
  const hits: LineNodeHit[] = [];
  for (const node of nodes) {
    if (excludeIds.has(node.id)) continue;
    const clip = clipSegmentToRect(from, to, node);
    if (!clip) continue;
    hits.push({ nodeId: node.id, zone: classifyTouchZone(node, clip.enter, clip.exit) });
  }
  return hits;
}

export function edgeEndpoints(
  fromNode: BoardNode,
  toNode: BoardNode,
  fromSide: EdgeSide | null,
  toSide: EdgeSide | null
): { from: { x: number; y: number }; to: { x: number; y: number }; fromSide: EdgeSide; toSide: EdgeSide } {
  let fs = fromSide;
  let ts = toSide;
  if (!fs || !ts) {
    const nearest = nearestSides(fromNode, toNode);
    fs ??= nearest.from;
    ts ??= nearest.to;
  }
  return {
    from: sideMidpoint(fromNode, fs),
    to: sideMidpoint(toNode, ts),
    fromSide: fs,
    toSide: ts
  };
}

export function findEdgeCrossings(
  from: { x: number; y: number },
  to: { x: number; y: number },
  edges: readonly BoardEdge[],
  nodesById: ReadonlyMap<string, BoardNode>,
  excludeEndpoints: ReadonlySet<string>
): EdgeCross[] {
  const crosses: EdgeCross[] = [];
  for (const edge of edges) {
    const aId = edge.from.nodeId;
    const bId = edge.to.nodeId;
    if (!aId || !bId) continue;
    if (excludeEndpoints.has(aId) && excludeEndpoints.has(bId)) continue;
    const a = nodesById.get(aId);
    const b = nodesById.get(bId);
    if (!a || !b) continue;
    // Skip edges that share an endpoint — common fan-out, not a bad cross.
    if (excludeEndpoints.has(aId) || excludeEndpoints.has(bId)) continue;
    const ends = edgeEndpoints(a, b, null, null);
    if (segmentsIntersect(from, to, ends.from, ends.to)) {
      crosses.push({ otherEdgeId: edge.id, label: edge.label || `${aId}→${bId}` });
    }
  }
  return crosses;
}

const ZONE_LABEL: Record<TouchZone, string> = {
  top: 'через верх',
  bottom: 'через низ',
  left: 'через левую часть',
  right: 'через правую часть',
  center: 'через середину'
};

export function formatSpatialWarning(input: {
  overlaps?: NodeOverlap[];
  lineHits?: LineNodeHit[];
  crossings?: EdgeCross[];
}): string {
  const parts: string[] = [];
  if (input.overlaps?.length) {
    parts.push(
      `Перекрытие с узлами: ${input.overlaps
        .slice(0, 6)
        .map((o) => `${o.otherId} (~${Math.round(o.overlapArea)}px²)`)
        .join(', ')}`
    );
  }
  if (input.lineHits?.length) {
    parts.push(
      `Стрелка заходит на блоки: ${input.lineHits
        .slice(0, 8)
        .map((h) => `${h.nodeId} (${ZONE_LABEL[h.zone]})`)
        .join('; ')}`
    );
  }
  if (input.crossings?.length) {
    parts.push(
      `Пересечение со связями: ${input.crossings
        .slice(0, 6)
        .map((c) => c.label)
        .join(', ')}`
    );
  }
  return parts.join('\n');
}
