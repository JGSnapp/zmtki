import { describe, expect, it } from 'vitest';
import { SpatialIndex, detailLevel, isLiveArtifact, rectsIntersect, worldViewRect } from '../src/index.js';

const box = (id: string, x: number, y: number, width = 100, height = 100) => ({
  id,
  x,
  y,
  width,
  height,
});

describe('worldViewRect', () => {
  it('maps an unpanned, unzoomed viewport to the screen rect at the origin', () => {
    expect(worldViewRect({ x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 })).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it('shows half the world area at 2x zoom', () => {
    const rect = worldViewRect({ x: 0, y: 0, zoom: 2 }, { width: 800, height: 600 });
    expect(rect.width).toBe(400);
    expect(rect.height).toBe(300);
  });

  it('treats a positive pan as the world moving right, so the view starts left of the origin', () => {
    const rect = worldViewRect({ x: 200, y: 100, zoom: 1 }, { width: 800, height: 600 });
    expect(rect.x).toBe(-200);
    expect(rect.y).toBe(-100);
  });

  it('keeps overscan a constant width on screen rather than in world units', () => {
    const at1x = worldViewRect({ x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 }, 100);
    const at4x = worldViewRect({ x: 0, y: 0, zoom: 4 }, { width: 800, height: 600 }, 100);
    // 100 screen px is 100 world units at 1x but only 25 at 4x.
    expect(at1x.width).toBe(800 + 200);
    expect(at4x.width).toBe(200 + 50);
  });
});

describe('detailLevel', () => {
  it('renders everything at or above full size', () => {
    expect(detailLevel(1)).toBe('full');
    expect(detailLevel(0.55)).toBe('full');
  });

  it('keeps cards whole until the board goes to the overview', () => {
    // No middle step: down to 0.28 a card is drawn as itself, and below that
    // the whole board is one canvas anyway.
    expect(detailLevel(0.54)).toBe('full');
    expect(detailLevel(0.28)).toBe('full');
    expect(detailLevel(0.27)).toBe('placeholder');
    expect(detailLevel(0.1)).toBe('placeholder');
  });

  it('falls back to a dot when nothing could be legible anyway', () => {
    expect(detailLevel(0.05)).toBe('dot');
    expect(detailLevel(0)).toBe('dot');
  });
});

describe('persistent surfaces', () => {
  it('keeps embedded HTML documents alive across detail levels', () => {
    expect(isLiveArtifact('html')).toBe(true);
    expect(isLiveArtifact('ui')).toBe(true);
  });
});

describe('rectsIntersect', () => {
  it('is false for boxes that only touch along an edge', () => {
    expect(rectsIntersect(box('a', 0, 0), box('b', 100, 0))).toBe(false);
  });

  it('is true for overlapping boxes', () => {
    expect(rectsIntersect(box('a', 0, 0), box('b', 99, 99))).toBe(true);
  });
});

describe('SpatialIndex', () => {
  it('returns only the items intersecting the query rect', () => {
    const index = new SpatialIndex([box('near', 0, 0), box('far', 10_000, 10_000)]);
    const hits = index.query({ x: -50, y: -50, width: 200, height: 200 });
    expect(hits.map((h) => h.id)).toEqual(['near']);
  });

  it('reports an item straddling several cells exactly once', () => {
    const index = new SpatialIndex([box('wide', 0, 0, 2000, 2000)], 512);
    const hits = index.query({ x: 0, y: 0, width: 2000, height: 2000 });
    expect(hits).toHaveLength(1);
  });

  it('stops returning a removed item', () => {
    const index = new SpatialIndex([box('a', 0, 0)]);
    index.remove('a');
    expect(index.query({ x: 0, y: 0, width: 100, height: 100 })).toEqual([]);
    expect(index.size).toBe(0);
  });

  it('follows an item that moved out of the query rect', () => {
    const index = new SpatialIndex([box('a', 0, 0)]);
    index.update(box('a', 5000, 5000));
    expect(index.query({ x: 0, y: 0, width: 100, height: 100 })).toEqual([]);
    expect(index.query({ x: 5000, y: 5000, width: 100, height: 100 })).toHaveLength(1);
  });

  it('matches a brute-force scan over a large scattered board', () => {
    const items = Array.from({ length: 5000 }, (_, i) =>
      box(`a${i}`, (i % 100) * 400, Math.floor(i / 100) * 400, 260, 180),
    );
    const index = new SpatialIndex(items);
    const rect = { x: 3000, y: 2000, width: 1600, height: 1200 };
    const expected = items.filter((item) => rectsIntersect(item, rect)).map((i) => i.id).sort();
    expect(index.query(rect).map((i) => i.id).sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });
});
