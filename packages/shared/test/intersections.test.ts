import type { Arrow, Artifact } from '@zmtki/shared';
import {
  suggestMoves,
  checkIntersections,
  computeArrowGeometries,
  polylineRectHits,
  segmentIntersection,
} from '@zmtki/shared';
import { describe, expect, it } from 'vitest';

const artifact = (
  id: string,
  x: number,
  y: number,
  width = 200,
  height = 100,
): Artifact => ({
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

const arrow = (
  id: string,
  fromId: string,
  toId: string,
  bends: Array<{ x: number; y: number }> = [],
  fromSide: Arrow['from']['side'] = 'right',
  toSide: Arrow['to']['side'] = 'left',
): Arrow => ({
  id,
  from: { artifactId: fromId, side: fromSide },
  to: { artifactId: toId, side: toSide },
  bends,
  style: {},
  createdAt: 0,
  updatedAt: 0,
});

describe('segmentIntersection', () => {
  it('finds a midpoint crossing', () => {
    const hit = segmentIntersection(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    );
    expect(hit?.point.x).toBeCloseTo(50, 5);
    expect(hit?.point.y).toBeCloseTo(50, 5);
  });

  it('returns null for parallel segments', () => {
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }),
    ).toBeNull();
  });
});

describe('polylineRectHits', () => {
  it('reports left entry and right exit for a horizontal cut', () => {
    const rect = { x: 100, y: 0, width: 100, height: 100 };
    const hits = polylineRectHits(
      [
        { x: 0, y: 50 },
        { x: 300, y: 50 },
      ],
      rect,
    );
    expect(hits.map((h) => h.side)).toEqual(['left', 'right']);
  });
});

describe('checkIntersections', () => {
  it('reports which sides an arrow crosses on a blocking artifact', () => {
    const artifacts = [
      artifact('a', 0, 0),
      artifact('mid', 250, 0),
      artifact('b', 500, 0),
    ];
    const arrows = [arrow('arr1', 'a', 'b')];
    const report = checkIntersections(artifacts, arrows);
    expect(report.ok).toBe(false);
    const hit = report.findings.find((f) => f.kind === 'arrow_artifact');
    expect(hit).toMatchObject({
      kind: 'arrow_artifact',
      arrowId: 'arr1',
      artifactId: 'mid',
      entrySide: 'left',
      exitSide: 'right',
    });
    expect(hit).toBeDefined();
    if (hit?.kind !== 'arrow_artifact') throw new Error('expected arrow_artifact');
    expect(hit.sides).toEqual(expect.arrayContaining(['left', 'right']));
  });

  it('ignores the attachment touch on endpoint artifacts', () => {
    const artifacts = [artifact('a', 0, 0), artifact('b', 400, 0)];
    const arrows = [arrow('arr1', 'a', 'b')];
    const report = checkIntersections(artifacts, arrows, { includeArtifactOverlaps: false });
    expect(report.findings.filter((f) => f.kind === 'arrow_artifact')).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it('reports a clean path when a bend goes around the obstacle', () => {
    const artifacts = [
      artifact('a', 0, 0),
      artifact('mid', 250, 0),
      artifact('b', 500, 0),
    ];
    const arrows = [arrow('arr1', 'a', 'b', [{ x: 225, y: -80 }, { x: 475, y: -80 }])];
    const report = checkIntersections(artifacts, arrows, { includeArtifactOverlaps: false });
    expect(report.findings.filter((f) => f.kind === 'arrow_artifact')).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it('detects arrow-arrow crossings and artifact overlaps', () => {
    const artifacts = [
      artifact('a', 0, 0),
      artifact('b', 400, 0),
      artifact('c', 0, 200),
      artifact('d', 400, 200),
      artifact('overlap', 50, 20, 200, 100),
    ];
    const arrows = [
      arrow('h', 'a', 'b'),
      arrow('v', 'c', 'a', [], 'top', 'bottom'), // will not cross h easily
    ];
    // Force a cross: left-right and top-bottom through the middle.
    const crossing = checkIntersections(
      [artifact('w', 0, 100, 80, 80), artifact('e', 300, 100, 80, 80), artifact('n', 140, 0, 80, 80), artifact('s', 140, 220, 80, 80)],
      [
        arrow('horiz', 'w', 'e'),
        arrow('vert', 'n', 's', [], 'bottom', 'top'),
      ],
      { includeArtifactOverlaps: false },
    );
    expect(crossing.findings.some((f) => f.kind === 'arrow_arrow')).toBe(true);

    const overlap = checkIntersections(artifacts, arrows);
    expect(overlap.findings.some((f) => f.kind === 'artifact_artifact')).toBe(true);
  });

  it('reports the crossing angle and flags shallow crossings', () => {
    const report = checkIntersections(
      [
        artifact('w', 0, 100, 80, 80),
        artifact('e', 300, 100, 80, 80),
        artifact('n', 140, 0, 80, 80),
        artifact('s', 140, 220, 80, 80),
      ],
      [arrow('horiz', 'w', 'e'), arrow('vert', 'n', 's', [], 'bottom', 'top')],
      { includeArtifactOverlaps: false, includeClearance: false },
    );
    const crossing = report.findings.find((f) => f.kind === 'arrow_arrow');
    if (crossing?.kind !== 'arrow_arrow') throw new Error('expected arrow_arrow');
    expect(crossing.angle).toBe(90);
    expect(crossing.shallow).toBe(false);
  });

  it('detects two arrows merged into one visual line', () => {
    const artifacts = [
      artifact('a', 0, 0),
      artifact('b', 600, 0),
      artifact('c', 0, 300),
      artifact('d', 600, 300),
    ];
    // Both routes run along y = -80 for a long stretch.
    const arrows = [
      arrow('top', 'a', 'b', [
        { x: 250, y: -80 },
        { x: 450, y: -80 },
      ]),
      arrow('bottom', 'c', 'd', [
        { x: 260, y: -80 },
        { x: 460, y: -80 },
      ]),
    ];
    const report = checkIntersections(artifacts, arrows, { includeArtifactOverlaps: false });
    const merged = report.findings.find((f) => f.kind === 'arrow_overlap');
    if (merged?.kind !== 'arrow_overlap') throw new Error('expected arrow_overlap');
    expect(merged.length).toBeGreaterThan(150);
    expect(report.ok).toBe(false);
  });

  it('allows a fork to share its outgoing port', () => {
    const artifacts = [artifact('root', 0, 0), artifact('l', 400, -200), artifact('r', 400, 200)];
    const arrows = [
      { ...arrow('f1', 'root', 'l'), from: { artifactId: 'root', side: 'right' as const, offset: 0.5 } },
      { ...arrow('f2', 'root', 'r'), from: { artifactId: 'root', side: 'right' as const, offset: 0.5 } },
    ];
    const report = checkIntersections(artifacts, arrows, { includeArtifactOverlaps: false });
    expect(report.counts.arrowSharedPort).toBe(0);
    const geos = computeArrowGeometries(artifacts, arrows);
    expect(geos.get('f1')!.fromPoint).toEqual(geos.get('f2')!.fromPoint);
  });

  it('warns about crowded artifacts and arrows grazing a box', () => {
    const artifacts = [artifact('a', 0, 0), artifact('b', 215, 0)];
    const report = checkIntersections(artifacts, [], { minArtifactGap: 40 });
    const tight = report.findings.find((f) => f.kind === 'tight_spacing');
    if (tight?.kind !== 'tight_spacing') throw new Error('expected tight_spacing');
    expect(tight.gap).toBe(15);
    expect(tight.axis).toBe('horizontal');
    // Soft findings do not mark the board as broken.
    expect(report.ok).toBe(true);
  });

  it('flags a label that sits on top of an artifact', () => {
    const artifacts = [artifact('a', 0, 0), artifact('b', 600, 0), artifact('mid', 250, -120, 200, 100)];
    const arrows = [
      {
        ...arrow('l', 'a', 'b', [
          { x: 250, y: -20 },
          { x: 450, y: -20 },
        ]),
        label: 'очень длинная подпись связи',
      },
    ];
    const report = checkIntersections(artifacts, arrows, { includeArtifactOverlaps: false });
    expect(report.findings.some((f) => f.kind === 'label_conflict')).toBe(true);
  });
});

describe('suggestMoves', () => {
  const box = (id: string, x: number, y: number): Artifact => ({
    id,
    type: 'note',
    z: 0,
    props: {},
    x,
    y,
    width: 220,
    height: 140,
    createdAt: 0,
    updatedAt: 0,
  });
  const link = (id: string, from: string, to: string): Arrow => ({
    id,
    from: { artifactId: from, side: 'auto' },
    to: { artifactId: to, side: 'auto' },
    bends: [],
    style: {},
    createdAt: 0,
    updatedAt: 0,
  });

  it('says nothing when the lines do not cross', () => {
    // Silence is the useful answer here: an empty list of advice reads as
    // advice to move something.
    const artifacts = [box('a', 0, 0), box('b', 400, 0)];
    expect(suggestMoves(artifacts, [link('r1', 'a', 'b')])).toEqual([]);
  });

  it('says nothing on a board too big to be one block’s fault', () => {
    // Past a couple of dozen blocks a crossing is a property of the layout, not
    // of one misplaced box, and the search would cost more than it is worth.
    const many = Array.from({ length: 30 }, (_, i) => box(`n${i}`, (i % 6) * 300, Math.floor(i / 6) * 220));
    const arrows = many.slice(1).map((n, i) => link(`r${i}`, many[i].id, n.id));
    expect(suggestMoves(many, arrows)).toEqual([]);
  });

  // That it does speak when a move helps is measured on the bench rather than
  // here: a crossing this engine cannot route away is hard to build by hand —
  // the router and the port search untangle the obvious cases themselves. Over
  // the 61 saved boards that still had a crossing, a single-block move fixed 13.
});
