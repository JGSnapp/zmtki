import type { Arrow, Artifact } from '../src/index.js';
import { boardQuality, qualitySummary } from '../src/index.js';
import { describe, expect, it } from 'vitest';

const box = (id: string, x: number, y: number, width = 200, height = 100): Artifact => ({
  id,
  type: 'note',
  x,
  y,
  width,
  height,
  z: 1,
  props: {},
  createdAt: 0,
  updatedAt: 0,
});

const arrow = (id: string, from: string, to: string): Arrow => ({
  id,
  from: { artifactId: from, side: 'right' },
  to: { artifactId: to, side: 'left' },
  bends: [],
  style: {},
  createdAt: 0,
  updatedAt: 0,
});

describe('boardQuality', () => {
  it('gives a clean two-node layout a top score', () => {
    const artifacts = [box('a', 0, 0), box('b', 400, 0)];
    const quality = boardQuality(artifacts, [arrow('r', 'a', 'b')]);
    expect(quality.cost).toBe(0);
    expect(quality.score).toBe(100);
    expect(quality.grade).toBe('отлично');
    expect(quality.breakdown).toHaveLength(0);
  });

  it('does not reward nodes merely for sharing an axis', () => {
    const aligned = boardQuality(
      [box('a', 0, 0), box('b', 400, 0)],
      [arrow('aligned', 'a', 'b')],
    );
    const offsetArrow: Arrow = {
      ...arrow('offset', 'a', 'b'),
      bends: [
        { x: 300, y: 50 },
        { x: 300, y: 350 },
      ],
    };
    const offset = boardQuality(
      [box('a', 0, 0), box('b', 400, 300)],
      [offsetArrow],
    );

    expect(offset.metrics.detour).toBe(1);
    expect(offset.metrics.bends).toBe(2);
    expect(offset.counts.arrowShortEdge).toBe(0);
    expect(offset.cost).toBe(aligned.cost);
    expect(offset.score).toBe(100);
  });

  it('charges the most for overlapping artifacts and arrows cutting through boxes', () => {
    const clean = boardQuality([box('a', 0, 0), box('b', 400, 0)], [arrow('r', 'a', 'b')]);
    const cut = boardQuality(
      [box('a', 0, 0), box('mid', 250, 0), box('b', 500, 0)],
      [arrow('r', 'a', 'b')],
    );
    const overlapped = boardQuality([box('a', 0, 0), box('b', 100, 20)], []);

    expect(cut.cost).toBeGreaterThan(clean.cost);
    expect(cut.metrics.edgeNodeHits).toBe(1);
    expect(overlapped.metrics.overlaps).toBe(1);
    expect(overlapped.cost).toBeGreaterThan(cut.cost);
  });

  it('keeps the score inside 0..100 for a hopeless board', () => {
    const artifacts = Array.from({ length: 8 }, (_, i) => box(`n${i}`, i * 10, i * 5));
    const arrows = artifacts
      .slice(1)
      .map((artifact, index) => arrow(`r${index}`, artifacts[0].id, artifact.id));
    const quality = boardQuality(artifacts, arrows);
    expect(quality.score).toBeGreaterThanOrEqual(0);
    expect(quality.score).toBeLessThan(30);
    expect(quality.grade).toBe('плохо');
    expect(quality.hints.length).toBeGreaterThan(0);
  });

  it('charges a long hook more than a short orthogonal run', () => {
    const short = boardQuality(
      [box('a', 0, 0), box('b', 400, 0)],
      [arrow('r', 'a', 'b')],
    );
    const hooked: Arrow = {
      ...arrow('r', 'a', 'b'),
      from: { artifactId: 'a', side: 'right' },
      to: { artifactId: 'b', side: 'left' },
      bends: [
        { x: 320, y: 50 },
        { x: 320, y: -800 },
        { x: 80, y: -800 },
        { x: 80, y: 50 },
      ],
    };
    const long = boardQuality([box('a', 0, 0), box('b', 400, 0)], [hooked]);
    expect(long.metrics.detour).toBeGreaterThan(2);
    expect(long.cost).toBeGreaterThan(short.cost + 10);
    expect(long.hints.join(' ')).toMatch(/крюком/);
  });

  it('summarises itself for the header and tool output', () => {
    const quality = boardQuality([box('a', 0, 0), box('b', 400, 0)], [arrow('r', 'a', 'b')]);
    expect(qualitySummary(quality)).toBe('качество 100/100 (отлично), штраф 0');
  });
});
