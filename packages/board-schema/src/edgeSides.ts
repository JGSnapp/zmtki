import type { Vec2 } from './geometry.js';

export const EDGE_SIDES = ['left', 'right', 'top', 'bottom'] as const;
export type EdgeSide = (typeof EDGE_SIDES)[number];

/** Normalised side midpoints inside a node box (0..1). */
export function sideToAnchor(side: EdgeSide): Vec2 {
  switch (side) {
    case 'left':
      return { x: 0, y: 0.5 };
    case 'right':
      return { x: 1, y: 0.5 };
    case 'top':
      return { x: 0.5, y: 0 };
    case 'bottom':
      return { x: 0.5, y: 1 };
  }
}

export function anchorToSide(anchor: Vec2 | null | undefined): EdgeSide | null {
  if (!anchor) return null;
  const candidates: Array<{ side: EdgeSide; d: number }> = EDGE_SIDES.map((side) => {
    const a = sideToAnchor(side);
    const dx = a.x - anchor.x;
    const dy = a.y - anchor.y;
    return { side, d: dx * dx + dy * dy };
  });
  candidates.sort((a, b) => a.d - b.d);
  return candidates[0]?.side ?? null;
}

export function sideMidpoint(
  node: { position: Vec2; size: { w: number; h: number } },
  side: EdgeSide
): Vec2 {
  const a = sideToAnchor(side);
  return {
    x: node.position.x + node.size.w * a.x,
    y: node.position.y + node.size.h * a.y
  };
}

/** Pick the pair of sides whose midpoints are closest. */
export function nearestSides(
  from: { position: Vec2; size: { w: number; h: number } },
  to: { position: Vec2; size: { w: number; h: number } }
): { from: EdgeSide; to: EdgeSide } {
  let best: { from: EdgeSide; to: EdgeSide; d: number } = {
    from: 'right',
    to: 'left',
    d: Number.POSITIVE_INFINITY
  };
  for (const fs of EDGE_SIDES) {
    const p1 = sideMidpoint(from, fs);
    for (const ts of EDGE_SIDES) {
      const p2 = sideMidpoint(to, ts);
      const dx = p1.x - p2.x;
      const dy = p1.y - p2.y;
      const d = dx * dx + dy * dy;
      if (d < best.d) best = { from: fs, to: ts, d };
    }
  }
  return { from: best.from, to: best.to };
}

export function parseEdgeSide(value: unknown): EdgeSide | 'auto' | null {
  if (value == null || value === '') return 'auto';
  const s = String(value).toLowerCase();
  if (s === 'auto' || s === 'nearest') return 'auto';
  if ((EDGE_SIDES as readonly string[]).includes(s)) return s as EdgeSide;
  return null;
}
