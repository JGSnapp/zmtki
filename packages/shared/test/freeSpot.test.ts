import { describe, expect, it } from 'vitest';
import type { Rect } from '../src/index.js';
import { SpatialIndex, findFreeSpot, rectsIntersect } from '../src/index.js';

const boxes = (rects: Array<[number, number, number, number]>) =>
  rects.map(([x, y, width, height], i) => ({ id: 'b' + i, x, y, width, height }));

const query = (items: Rect[]) => (area: Rect) => items.filter((item) => rectsIntersect(item, area));

describe('findFreeSpot', () => {
  it('keeps the wanted spot when it is free', () => {
    expect(findFreeSpot({ x: 100, y: 100, width: 200, height: 100 }, query([]))).toEqual({ x: 100, y: 100 });
  });

  it('snaps the result to the grid', () => {
    expect(findFreeSpot({ x: 107, y: 93, width: 200, height: 100 }, query([]))).toEqual({ x: 100, y: 100 });
  });

  it('moves a box dropped onto a neighbour the short way off it, keeping the gap', () => {
    const items = boxes([[0, 0, 400, 300]]);
    // Wanted right edge overlaps the neighbour by 20px on its right side.
    const spot = findFreeSpot({ x: 380, y: 0, width: 200, height: 100 }, query(items), { gap: 40 });
    expect(spot).toEqual({ x: 440, y: 0 });
  });

  it('never returns a spot that overlaps or crowds anything', () => {
    const items = boxes(
      Array.from({ length: 30 }, (_, i) => [(i % 6) * 300, Math.floor(i / 6) * 260, 260, 220] as [number, number, number, number]),
    );
    const index = new SpatialIndex(items);
    const wanted = { x: 600, y: 520, width: 260, height: 220 };
    const spot = findFreeSpot(wanted, (area) => index.query(area), { gap: 40 });
    const placed = { ...spot, width: wanted.width, height: wanted.height };
    const crowded = { x: placed.x - 39, y: placed.y - 39, width: placed.width + 78, height: placed.height + 78 };
    expect(items.some((item) => rectsIntersect(item, crowded))).toBe(false);
  });
});
