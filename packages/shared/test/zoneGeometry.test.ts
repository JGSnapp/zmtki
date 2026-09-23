import { describe, expect, it } from 'vitest';
import type { Rect, Zone } from '../src/index.js';
import { addRect, normalizeRects, subtractRect, zoneContainsRect, zoneOutline } from '../src/index.js';

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

const zone = (rects: Rect[]): Zone => ({
  id: 'z',
  title: 'z',
  color: '#fff',
  rects,
  createdAt: 0,
  updatedAt: 0,
});

/** Samples the plane on a grid and says which points the set covers. */
const coverage = (rects: Rect[], bounds: Rect, step = 10): string => {
  const rows: string[] = [];
  for (let y = bounds.y; y < bounds.y + bounds.height; y += step) {
    let row = '';
    for (let x = bounds.x; x < bounds.x + bounds.width; x += step) {
      const inside = rects.some((r) => x + 1 >= r.x && x + 1 <= r.x + r.width && y + 1 >= r.y && y + 1 <= r.y + r.height);
      row += inside ? '#' : '.';
    }
    rows.push(row);
  }
  return rows.join('\n');
};

describe('subtractRect', () => {
  it('leaves the source alone when the cut misses it', () => {
    expect(subtractRect(rect(0, 0, 100, 100), rect(200, 0, 50, 50))).toEqual([rect(0, 0, 100, 100)]);
  });

  it('removes everything when the cut covers the source', () => {
    expect(subtractRect(rect(10, 10, 50, 50), rect(0, 0, 100, 100))).toEqual([]);
  });

  it('leaves a ring of four strips when the cut is in the middle', () => {
    const pieces = subtractRect(rect(0, 0, 100, 100), rect(40, 40, 20, 20));
    expect(pieces).toHaveLength(4);
    expect(pieces.reduce((sum, p) => sum + p.width * p.height, 0)).toBe(100 * 100 - 20 * 20);
  });

  it('cuts a corner into two pieces', () => {
    const pieces = subtractRect(rect(0, 0, 100, 100), rect(60, 60, 100, 100));
    expect(pieces.reduce((sum, p) => sum + p.width * p.height, 0)).toBe(100 * 100 - 40 * 40);
  });
});

describe('normalizeRects', () => {
  it('drops a rectangle swallowed by another', () => {
    expect(normalizeRects([rect(0, 0, 100, 100), rect(20, 20, 10, 10)])).toEqual([rect(0, 0, 100, 100)]);
  });

  it('keeps the covered area exactly when two rectangles overlap', () => {
    const before = [rect(0, 0, 100, 100), rect(60, 60, 100, 100)];
    const after = normalizeRects(before);
    expect(coverage(after, rect(-20, -20, 220, 220))).toBe(coverage(before, rect(-20, -20, 220, 220)));
    // No piece overlaps another any more.
    for (let i = 0; i < after.length; i += 1) {
      for (let j = i + 1; j < after.length; j += 1) {
        const a = after[i];
        const b = after[j];
        expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
      }
    }
  });
});

describe('zoneOutline', () => {
  it('draws four sides for one rectangle', () => {
    const segments = zoneOutline([rect(0, 0, 100, 60)]);
    expect(segments).toHaveLength(4);
    expect(segments.filter((s) => s.y1 === s.y2)).toHaveLength(2);
  });

  it('leaves no line inside two rectangles joined along an edge', () => {
    const segments = zoneOutline([rect(0, 0, 100, 100), rect(100, 0, 100, 100)]);
    // The shared edge at x = 100 is covered from both sides and must not be drawn.
    expect(segments.some((s) => s.x1 === 100 && s.x2 === 100)).toBe(false);
    const total = segments.reduce((sum, s) => sum + Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1), 0);
    expect(total).toBe(2 * 200 + 2 * 100);
  });

  it('keeps the part of a shared edge that sticks out', () => {
    const segments = zoneOutline([rect(0, 0, 100, 100), rect(100, 0, 100, 40)]);
    const stub = segments.filter((s) => s.x1 === 100 && s.x2 === 100);
    expect(stub).toHaveLength(1);
    expect(Math.abs(stub[0].y2 - stub[0].y1)).toBe(60);
  });
});

describe('zoneContainsRect', () => {
  it('accepts a rectangle inside one piece', () => {
    expect(zoneContainsRect(zone([rect(0, 0, 500, 500)]), rect(100, 100, 100, 100))).toBe(true);
  });

  it('accepts a rectangle spanning two touching pieces', () => {
    expect(zoneContainsRect(zone([rect(0, 0, 200, 200), rect(200, 0, 200, 200)]), rect(150, 50, 100, 100))).toBe(true);
  });

  it('refuses a rectangle that pokes outside', () => {
    expect(zoneContainsRect(zone([rect(0, 0, 200, 200)]), rect(150, 50, 100, 100))).toBe(false);
  });

  it('refuses everything for an empty zone', () => {
    expect(zoneContainsRect(zone([]), rect(0, 0, 10, 10))).toBe(false);
  });
});

describe('addRect', () => {
  it('merges a swept rectangle into the set without stacking', () => {
    const rects = addRect([rect(0, 0, 100, 100)], rect(50, 0, 100, 100));
    expect(rects.reduce((sum, r) => sum + r.width * r.height, 0)).toBe(150 * 100);
  });
});
