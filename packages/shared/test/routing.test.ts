import type { Arrow, Artifact, RoutedArrow, Vec2 } from '../src/index.js';
import {
  MIN_PORT_ANGLE_DEG,
  angleToSide,
  boardQuality,
  checkIntersections,
  cleanArrowRoutes,
  computeArrowGeometries,
  collectIntendedPorts,
  inspectRawPortAngles,
  routeArrows,
  searchPorts,
  tooTightToRoute,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

const box = (id: string, x: number, y: number, width = 200, height = 120): Artifact => ({
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

const arrow = (id: string, from: string, to: string, bends: Vec2[] = []): Arrow => ({
  id,
  from: { artifactId: from, side: 'auto' },
  to: { artifactId: to, side: 'auto' },
  bends,
  style: {},
  createdAt: 0,
  updatedAt: 0,
});

const isOrthogonal = (points: Vec2[]): boolean =>
  points.every((point, index) => {
    if (index === 0) return true;
    const previous = points[index - 1];
    return Math.abs(point.x - previous.x) < 1e-6 || Math.abs(point.y - previous.y) < 1e-6;
  });

/** Mirrors what the board does with a route: bends plus pinned ports. */
const apply = (arrows: Arrow[], routed: RoutedArrow[]): Arrow[] =>
  arrows.map((item) => {
    const match = routed.find((r) => r.arrowId === item.id);
    if (!match) return item;
    return {
      ...item,
      bends: match.bends,
      routing: 'orthogonal' as const,
      from: { ...item.from, side: match.fromSide, offset: match.fromOffset },
      to: { ...item.to, side: match.toSide, offset: match.toOffset },
    };
  });

describe('orthogonal auto router', () => {
  it('routes around an artifact standing between the endpoints', () => {
    const artifacts = [box('a', 0, 0), box('blocker', 300, 0), box('b', 600, 0)];
    const arrows = [arrow('r1', 'a', 'b')];

    const before = checkIntersections(artifacts, arrows);
    expect(before.counts.arrowArtifact).toBe(1);

    const result = routeArrows(artifacts, arrows);
    expect(result.routed).toHaveLength(1);
    expect(result.routed[0].fallback).toBe(false);

    const after = checkIntersections(artifacts, apply(arrows, result.routed));
    expect(after.counts.arrowArtifact).toBe(0);
  });

  it('produces axis-aligned polylines', () => {
    const artifacts = [box('a', 0, 0), box('b', 500, 400)];
    const arrows = [arrow('r1', 'a', 'b')];
    const result = routeArrows(artifacts, arrows);
    const routed = apply(arrows, result.routed);
    const geometry = computeArrowGeometries(artifacts, routed).get('r1');
    expect(isOrthogonal(geometry!.points)).toBe(true);
  });

  it('routes several arrows into one left side at 90°, not as a star of diagonals', () => {
    const artifacts = [
      box('note', 400, 120, 220, 160),
      box('ryuk', 700, 0),
      box('light', 0, 0),
      box('misa', 0, 320),
    ];
    const arrows = [
      {
        ...arrow('owns', 'ryuk', 'note'),
        from: { artifactId: 'ryuk', side: 'bottom' as const },
        to: { artifactId: 'note', side: 'left' as const, offset: 0.5 },
      },
      {
        ...arrow('hero', 'light', 'note'),
        from: { artifactId: 'light', side: 'right' as const },
        to: { artifactId: 'note', side: 'left' as const, offset: 0.5 },
      },
      {
        ...arrow('got', 'misa', 'note'),
        from: { artifactId: 'misa', side: 'right' as const },
        to: { artifactId: 'note', side: 'left' as const, offset: 0.5 },
      },
    ];
    const result = routeArrows(artifacts, arrows);
    expect(result.refused).not.toBe(true);
    const routed = apply(arrows, result.routed);
    const geos = computeArrowGeometries(artifacts, routed);
    for (const id of ['owns', 'hero', 'got']) {
      const geo = geos.get(id)!;
      const points = geo.points;
      expect(isOrthogonal(points)).toBe(true);
      const last = points[points.length - 1];
      const prev = points[points.length - 2];
      expect(
        angleToSide({ x: prev.x - last.x, y: prev.y - last.y }, geo.toSide),
      ).toBeGreaterThanOrEqual(MIN_PORT_ANGLE_DEG);
      const raw = inspectRawPortAngles(
        artifacts.find((item) => item.id === routed.find((a) => a.id === id)!.from.artifactId)!,
        artifacts.find((item) => item.id === routed.find((a) => a.id === id)!.to.artifactId)!,
        geo.fromSide,
        geo.toSide,
        routed.find((a) => a.id === id)!.bends,
        geo.fromOffset,
        geo.toOffset,
      );
      expect(raw.shallow).toBe(false);
    }
  });

  it('does not pin an outgoing port on top of an incoming one', () => {
    const artifacts = [
      box('mid', 200, 200),
      box('src', 560, 200),
      box('dst', 920, 200),
    ];
    const arrows: Arrow[] = [
      {
        ...arrow('in', 'src', 'mid'),
        from: { artifactId: 'src', side: 'left', offset: 0.5 },
        to: { artifactId: 'mid', side: 'right', offset: 0.5 },
      },
      {
        ...arrow('out', 'mid', 'dst'),
        from: { artifactId: 'mid', side: 'right', offset: 0.5 },
        to: { artifactId: 'dst', side: 'left', offset: 0.5 },
      },
    ];
    const result = routeArrows(artifacts, arrows);
    const routed = apply(arrows, result.routed);
    const ports = collectIntendedPorts(artifacts, routed).filter((port) => port.artifactId === 'mid');
    for (const outgoing of ports.filter((port) => port.end === 'from')) {
      for (const incoming of ports.filter((port) => port.end === 'to')) {
        expect(
          Math.hypot(outgoing.point.x - incoming.point.x, outgoing.point.y - incoming.point.y),
        ).toBeGreaterThanOrEqual(1.5);
      }
    }
  });

  it('keeps two arrows between the same pair from merging into one line', () => {
    const artifacts = [box('a', 0, 0), box('b', 600, 0)];
    const arrows = [arrow('r1', 'a', 'b'), arrow('r2', 'b', 'a')];
    const result = routeArrows(artifacts, arrows);
    const report = checkIntersections(artifacts, apply(arrows, result.routed));
    expect(report.counts.arrowOverlap).toBe(0);
  });

  it('improves the quality score of a tangled board', () => {
    const artifacts = [
      box('a', 0, 0),
      box('b', 400, 0),
      box('c', 200, 260),
      box('blocker', 240, 20, 120, 80),
    ];
    const arrows = [arrow('r1', 'a', 'b'), arrow('r2', 'a', 'c'), arrow('r3', 'c', 'b')];

    const before = boardQuality(artifacts, arrows);
    const result = routeArrows(artifacts, arrows);
    const after = boardQuality(artifacts, apply(arrows, result.routed));

    expect(result.routed.length).toBe(arrows.length);
    expect(after.counts.arrowArtifact).toBeLessThanOrEqual(before.counts.arrowArtifact);
  });

  it('pins the ports so a later arrow on the same side cannot bend the route', () => {
    const artifacts = [box('a', 0, 0), box('b', 500, 400)];
    const routed = apply([arrow('r1', 'a', 'b')], routeArrows(artifacts, [arrow('r1', 'a', 'b')]).routed);

    // A second arrow would redistribute the ports of a side that is not pinned.
    const crowd = [...routed, arrow('r2', 'a', 'b'), arrow('r3', 'a', 'b')];
    const geometry = computeArrowGeometries(artifacts, crowd).get('r1');
    expect(isOrthogonal(geometry!.points)).toBe(true);
  });

  it('skips self loops and unknown endpoints instead of throwing', () => {
    const artifacts = [box('a', 0, 0)];
    const arrows = [arrow('self', 'a', 'a'), arrow('ghost', 'a', 'nope')];
    const result = routeArrows(artifacts, arrows);
    expect(result.routed).toHaveLength(0);
    expect(result.skipped.map((s) => s.arrowId).sort()).toEqual(['ghost', 'self']);
  });

  it('routes only the requested arrows', () => {
    const artifacts = [box('a', 0, 0), box('b', 500, 0), box('c', 0, 400)];
    const arrows = [arrow('r1', 'a', 'b'), arrow('r2', 'a', 'c')];
    const result = routeArrows(artifacts, arrows, { arrowIds: ['r2'] });
    expect(result.routed.map((r) => r.arrowId)).toEqual(['r2']);
  });

  it('routes a deliberately tight row instead of demanding it be spread out', () => {
    // Eight blocks with a 12px gap, which is the shape a user asks for when
    // they want a row packed tight. The sides facing along the row are buried
    // in the neighbours, but the tops and bottoms are open, and the router can
    // use them — so the gate must not refuse.
    //
    // This also covers the code path itself. A missing import left the gate
    // throwing a ReferenceError on every blocked port, which no test noticed
    // because none of them reached the branch: the whole suite passed while the
    // routing tool crashed on every live board that was even slightly crowded.
    const artifacts = Array.from({ length: 8 }, (_, i) => box(`n${i}`, i * 232, 0, 220, 140));
    const arrows = [
      arrow('a', 'n0', 'n3'),
      arrow('b', 'n1', 'n5'),
      arrow('c', 'n2', 'n7'),
      arrow('d', 'n4', 'n6'),
    ];

    const gate = tooTightToRoute(artifacts, arrows);
    expect(gate.ready).toBe(true);
    expect(gate.crowded).toEqual([]);

    const result = routeArrows(artifacts, arrows);
    expect(result.refused).not.toBe(true);
    expect(result.routed).toHaveLength(arrows.length);
  });

  it('refuses to invent a corridor when nodes overlap', () => {
    const artifacts = [box('a', 0, 0), box('b', 40, 20)];
    const arrows = [arrow('r1', 'a', 'b')];
    const result = routeArrows(artifacts, arrows);
    expect(result.refused).toBe(true);
    expect(result.routed).toHaveLength(0);
    expect(result.overlapping).toBeGreaterThan(0);
  });

  it('refuses when a port already sits inside a neighbour', () => {
    const artifacts = [box('a', 0, 0), box('blocker', 210, 0), box('b', 420, 0)];
    const arrows = [
      {
        ...arrow('r1', 'a', 'b'),
        from: { artifactId: 'a', side: 'right' as const },
        to: { artifactId: 'b', side: 'left' as const },
      },
    ];
    const result = routeArrows(artifacts, arrows);
    expect(result.refused).toBe(true);
    expect(result.crowded).toEqual(['r1']);
    expect(result.routed).toHaveLength(0);
  });

  it('marks a long wrap-around as a hook', () => {
    const artifacts = [
      box('a', 0, 0),
      box('wall', 300, -400, 80, 1200),
      box('b', 600, 0),
    ];
    const arrows = [
      {
        ...arrow('r1', 'a', 'b'),
        from: { artifactId: 'a', side: 'right' as const },
        to: { artifactId: 'b', side: 'left' as const },
      },
    ];
    const result = routeArrows(artifacts, arrows);
    expect(result.refused).not.toBe(true);
    expect(result.routed[0]?.hook).toBe(true);
    expect(result.routed[0]?.detourRatio).toBeGreaterThanOrEqual(1.8);
  });

  it('keeps the ports it was given instead of sliding them onto one lane', () => {
    // This used to assert the opposite: the router moved both offsets until the
    // line was straight. That freedom is what made the port search pointless —
    // the search would choose a port and the router would quietly replace it,
    // so not one requested offset in 77 survived a re-route. A port somebody
    // asked for is now an instruction. Straightening is the port search's job,
    // and the test below checks it does it.
    const artifacts = [box('a', 0, 0, 220, 140), box('b', 350, 20, 220, 160)];
    const arrows = [
      {
        ...arrow('r1', 'a', 'b'),
        from: { artifactId: 'a', side: 'right' as const, offset: 0.2 },
        to: { artifactId: 'b', side: 'left' as const, offset: 0.8 },
      },
    ];
    const result = routeArrows(artifacts, arrows);
    expect(result.refused).not.toBe(true);
    expect(result.routed[0]?.fromSide).toBe('right');
    expect(result.routed[0]?.toSide).toBe('left');
    expect(result.routed[0]?.fromOffset).toBeCloseTo(0.2, 2);
    expect(result.routed[0]?.toOffset).toBeCloseTo(0.8, 2);
  });

  it('lets the port search straighten what the router now leaves alone', () => {
    const artifacts = [box('a', 0, 0, 220, 140), box('b', 350, 20, 220, 160)];
    const arrows = [
      {
        ...arrow('r1', 'a', 'b'),
        from: { artifactId: 'a', side: 'right' as const, offset: 0.2 },
        to: { artifactId: 'b', side: 'left' as const, offset: 0.8 },
      },
    ];
    const searched = searchPorts(artifacts, arrows);
    const ys = computeArrowGeometries(artifacts, searched.arrows)
      .get('r1')!
      .points.map((p) => p.y);
    expect(new Set(ys).size).toBe(1);
  });

  it('attaches a skip-connection to the tops when the side corridor is blocked', () => {
    const artifacts = [
      box('a', 0, 0, 220, 140),
      box('mid', 300, -40, 220, 220),
      box('b', 700, 0, 220, 140),
    ];
    const arrows = [
      {
        ...arrow('skip', 'a', 'b'),
        // `autoPorts` marks a port the router owns. Without it these sides are
        // an instruction and are kept as given, blocked corridor or not; with
        // it the router is free to find the way over the top.
        autoPorts: true,
        from: { artifactId: 'a', side: 'right' as const },
        to: { artifactId: 'b', side: 'left' as const },
      },
    ];
    const result = routeArrows(artifacts, arrows);
    expect(result.refused).not.toBe(true);
    expect(result.routed[0]?.fromSide).toBe('top');
    expect(result.routed[0]?.toSide).toBe('top');
    expect(result.routed[0]?.hook).not.toBe(true);
    const routed = apply(arrows, result.routed);
    const points = computeArrowGeometries(artifacts, routed).get('skip')!.points;
    for (let i = 1; i < points.length; i++) {
      const diagonal =
        Math.abs(points[i].x - points[i - 1].x) > 0.5 && Math.abs(points[i].y - points[i - 1].y) > 0.5;
      expect(diagonal).toBe(false);
    }
  });

  it('picks the same quality regardless of which arrow was created first', () => {
    const artifacts = [box('a', 0, 200), box('b', 500, 200), box('c', 0, 0), box('d', 500, 400)];
    const shortThenLong = [arrow('short', 'a', 'b'), arrow('long', 'c', 'd')];
    const longThenShort = [arrow('long', 'c', 'd'), arrow('short', 'a', 'b')];

    const a = boardQuality(artifacts, apply(shortThenLong, routeArrows(artifacts, shortThenLong).routed));
    const b = boardQuality(artifacts, apply(longThenShort, routeArrows(artifacts, longThenShort).routed));
    expect(a.cost).toBe(b.cost);
    expect(routeArrows(artifacts, longThenShort).variantsTried).toBeGreaterThan(1);
  });
});

describe('cleanArrowRoutes', () => {
  it('drops a leftover whisker and writes a shorter polyline', () => {
    const artifacts = [box('a', 0, 0), box('b', 600, 0)];
    const arrows: Arrow[] = [
      {
        ...arrow('r1', 'a', 'b'),
        from: { artifactId: 'a', side: 'right', offset: 0.5 },
        to: { artifactId: 'b', side: 'left', offset: 0.5 },
        routing: 'orthogonal',
        bends: [{ x: 400, y: 30 }],
      },
    ];
    const result = cleanArrowRoutes(artifacts, arrows);
    expect(result.cleaned).toHaveLength(1);
    expect(result.cleaned[0].changed).toBe(true);
    expect(result.cleaned[0].after).toBeLessThan(result.cleaned[0].before);

    const rewritten = apply(arrows, [
      {
        arrowId: 'r1',
        bends: result.cleaned[0].bends,
        fromSide: result.cleaned[0].fromSide,
        toSide: result.cleaned[0].toSide,
        fromOffset: result.cleaned[0].fromOffset,
        toOffset: result.cleaned[0].toOffset,
        fallback: false,
      },
    ]);
    const ys = computeArrowGeometries(artifacts, rewritten)
      .get('r1')!
      .points.map((p) => p.y);
    expect(ys.every((y) => y === 60)).toBe(true);
    expect(ys.includes(30)).toBe(false);
  });
});
