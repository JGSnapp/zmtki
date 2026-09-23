import type { Rect, Vec2 } from './artifacts.js';

export interface FreeSpotOptions {
  /** Air required between the new box and its neighbours. */
  gap?: number;
  /** Grid the result lands on; boards place on 20. */
  step?: number;
  /** Rings of the search before giving up and returning the wanted spot. */
  maxRings?: number;
}

const snap = (value: number, step: number): number => Math.round(value / step) * step;

/**
 * The nearest position to `wanted` where a box of that size fits without
 * touching anything, searched ring by ring outwards on the grid.
 *
 * `occupied` answers "what is in this rectangle" — a spatial index query on the
 * canvas, a filter in tests — so the search costs a handful of cell lookups per
 * candidate rather than a scan of the board. Within a ring the closest free
 * candidate wins, so a block dropped just onto a neighbour moves the short way
 * off it, not to wherever the scan happened to start.
 */
export const findFreeSpot = (
  wanted: Rect,
  occupied: (area: Rect) => Rect[],
  options: FreeSpotOptions = {},
): Vec2 => {
  const gap = options.gap ?? 40;
  const step = options.step ?? 20;
  const maxRings = options.maxRings ?? 120;
  const origin = { x: snap(wanted.x, step), y: snap(wanted.y, step) };

  const fits = (x: number, y: number): boolean =>
    occupied({ x: x - gap, y: y - gap, width: wanted.width + gap * 2, height: wanted.height + gap * 2 }).length === 0;

  if (fits(origin.x, origin.y)) return origin;

  for (let ring = 1; ring <= maxRings; ring += 1) {
    let best: Vec2 | null = null;
    let bestDistance = Infinity;
    const r = ring * step;
    for (let i = -ring; i <= ring; i += 1) {
      const d = i * step;
      const candidates: Vec2[] = [
        { x: origin.x + d, y: origin.y - r },
        { x: origin.x + d, y: origin.y + r },
      ];
      if (i !== -ring && i !== ring) {
        candidates.push({ x: origin.x - r, y: origin.y + d }, { x: origin.x + r, y: origin.y + d });
      }
      for (const c of candidates) {
        const distance = Math.hypot(c.x - wanted.x, c.y - wanted.y);
        if (distance >= bestDistance) continue;
        if (fits(c.x, c.y)) {
          best = c;
          bestDistance = distance;
        }
      }
    }
    if (best) return best;
  }
  return origin;
};
