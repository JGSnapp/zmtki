import type { Arrow, Artifact } from '../src/index.js';
import {
  CORNER_RADIUS_MAX,
  CORNER_RADIUS_SHARE,
  MIN_EDGE,
  MIN_MIXED_PORT,
  MIN_PORT_ANGLE_DEG,
  PORT_STUB,
  anchorPoint,
  angleToSide,
  arrowGeometry,
  arrowHeadVertices,
  collectIntendedPorts,
  ensureHeadOnBends,
  findMixedPortConflict,
  inspectRawPortAngles,
  boundsOf,
  arrowPathData,
  computeArrowGeometries,
  drawnPolyline,
  rectsIntersect,
  resolveSide,
  tidyOrthogonal,
} from '../src/index.js';
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

describe('arrow geometry', () => {
  it('anchors on the requested side of a rectangle', () => {
    const rect = { x: 0, y: 0, width: 200, height: 100 };
    expect(anchorPoint(rect, 'right')).toEqual({ x: 200, y: 50 });
    expect(anchorPoint(rect, 'top')).toEqual({ x: 100, y: 0 });
    expect(anchorPoint(rect, 'bottom')).toEqual({ x: 100, y: 100 });
    expect(anchorPoint(rect, 'left')).toEqual({ x: 0, y: 50 });
  });

  it('measures the angle to a side: 90° is head-on, 0° slides along the edge', () => {
    expect(angleToSide({ x: -1, y: 0 }, 'left')).toBeCloseTo(90, 5);
    expect(angleToSide({ x: 0, y: 1 }, 'left')).toBeCloseTo(0, 5);
    expect(angleToSide({ x: -1, y: -1 }, 'left')).toBeCloseTo(45, 5);
  });

  it('flags a raw diagonal that nicks a side, and accepts an L-bend', () => {
    const light = box('light', 0, 0, 240, 180);
    const note = box('note', 300, 200, 240, 180);
    const flat = inspectRawPortAngles(light, note, 'right', 'left', []);
    expect(flat.shallow).toBe(true);
    expect(flat.toAngle).toBeLessThan(MIN_PORT_ANGLE_DEG);

    const corner = inspectRawPortAngles(light, note, 'right', 'left', [
      { x: 270, y: 90 },
      { x: 270, y: 290 },
    ]);
    expect(corner.shallow).toBe(false);
    expect(corner.fromAngle).toBeGreaterThanOrEqual(MIN_PORT_ANGLE_DEG);
    expect(corner.toAngle).toBeGreaterThanOrEqual(MIN_PORT_ANGLE_DEG);
  });

  it('detects a mixed in/out port and not a fork', () => {
    const mid = box('mid', 200, 200, 240, 180);
    const src = box('src', 500, 200, 240, 180);
    const dst = box('dst', 700, 200, 240, 180);
    const incoming: Arrow = {
      id: 'in',
      from: { artifactId: 'src', side: 'left', offset: 0.5 },
      to: { artifactId: 'mid', side: 'right', offset: 0.5 },
      bends: [],
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const ports = collectIntendedPorts([mid, src, dst], [incoming]);
    const leave = { x: mid.x + mid.width, y: mid.y + mid.height / 2 };
    expect(findMixedPortConflict(ports, { artifactId: 'mid', end: 'from', point: leave })).not.toBeNull();
    expect(findMixedPortConflict(ports, { artifactId: 'src', end: 'from', point: leave })).toBeNull();
    const sixteenDown = { x: leave.x, y: leave.y + 16 };
    expect(findMixedPortConflict(ports, { artifactId: 'mid', end: 'from', point: sixteenDown })).not.toBeNull();
    const far = { x: leave.x, y: leave.y + MIN_MIXED_PORT };
    expect(findMixedPortConflict(ports, { artifactId: 'mid', end: 'from', point: far })).toBeNull();
  });

  it('draws mixed in/out on one side at least MIN_MIXED_PORT apart', () => {
    const phone = box('phone', 800, 0, 240, 160);
    const left = box('left', 400, 0, 240, 160);
    const below = box('below', 800, 500, 240, 160);
    const arrows: Arrow[] = [
      {
        id: 'in',
        from: { artifactId: 'left', side: 'right', offset: 0.5 },
        to: { artifactId: 'phone', side: 'left', offset: 0.5 },
        bends: [],
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'out',
        from: { artifactId: 'phone', side: 'left', offset: 0.6 },
        to: { artifactId: 'below', side: 'left', offset: 0.5 },
        bends: [
          { x: 728, y: 96 },
          { x: 728, y: 580 },
        ],
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const geos = computeArrowGeometries([phone, left, below], arrows);
    const incoming = geos.get('in')!.toPoint;
    const outgoing = geos.get('out')!.fromPoint;
    expect(Math.hypot(incoming.x - outgoing.x, incoming.y - outgoing.y)).toBeGreaterThanOrEqual(
      MIN_MIXED_PORT,
    );
  });

  it('stores a stub bend so a raw diagonal is no longer shallower than 30°', () => {
    const light = box('light', 0, 0, 240, 180);
    const note = box('note', 300, 200, 240, 180);
    const bends = ensureHeadOnBends(light, note, 'right', 'left', [], 0.5, 0.5, [light, note]);
    const after = inspectRawPortAngles(light, note, 'right', 'left', bends, 0.5, 0.5);
    expect(after.shallow).toBe(false);
  });

  it('points the arrowhead into the box from the port side, not along a tangent', () => {
    const [tip, a, b] = arrowHeadVertices({ x: 500, y: 327 }, 'left', 10);
    expect(tip).toEqual({ x: 500, y: 327 });
    expect(a.x).toBeLessThan(tip.x);
    expect(b.x).toBeLessThan(tip.x);
  });

  it('picks the facing side for auto anchors, accounting for aspect ratio', () => {
    const wide = { x: 0, y: 0, width: 400, height: 50 };
    expect(resolveSide(wide, { x: 900, y: 25 })).toBe('right');
    expect(resolveSide(wide, { x: 200, y: 400 })).toBe('bottom');
    expect(resolveSide(wide, { x: -300, y: 25 })).toBe('left');
    expect(resolveSide(wide, { x: 200, y: -400 })).toBe('top');
  });

  it('builds a polyline through the bend points', () => {
    const from = box('a', 0, 0);
    const to = box('b', 600, 300);
    const arrow: Arrow = {
      id: 'arr',
      from: { artifactId: 'a', side: 'right' },
      to: { artifactId: 'b', side: 'left' },
      bends: [{ x: 400, y: 50 }],
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const geometry = arrowGeometry(arrow, new Map([['a', from], ['b', to]]));
    const points = geometry!.points;
    expect(points[0]).toEqual({ x: 200, y: 50 });
    expect(points[points.length - 1]).toEqual({ x: 600, y: 350 });
    for (let i = 1; i < points.length; i++) {
      const diagonal =
        Math.abs(points[i].x - points[i - 1].x) > 0.5 && Math.abs(points[i].y - points[i - 1].y) > 0.5;
      expect(diagonal).toBe(false);
    }
  });

  it('leaves a side at 90° instead of sliding along it', () => {
    const from = box('a', 0, 0);
    const to = box('b', 40, 400);
    const arrow: Arrow = {
      id: 'arr',
      from: { artifactId: 'a', side: 'right' },
      to: { artifactId: 'b', side: 'top' },
      bends: [],
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const geometry = arrowGeometry(arrow, new Map([['a', from], ['b', to]]));
    const [start, next] = geometry!.points;
    expect(start).toEqual({ x: 200, y: 50 });
    // First step is purely horizontal: the exit is perpendicular to the right side.
    expect(next.y).toBe(start.y);
    expect(next.x).toBeGreaterThan(start.x);
  });

  it('never lets a shallow diagonal enter a side — last segment is head-on', () => {
    const from = box('a', 0, 0);
    const to = box('b', 400, 40);
    const arrow: Arrow = {
      id: 'arr',
      from: { artifactId: 'a', side: 'right' },
      to: { artifactId: 'b', side: 'left' },
      bends: [],
      routing: 'straight',
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const geometry = arrowGeometry(arrow, new Map([['a', from], ['b', to]]))!;
    const points = geometry.points;
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    const inward = { x: last.x - prev.x, y: last.y - prev.y };
    const outward = { x: prev.x - last.x, y: prev.y - last.y };
    expect(angleToSide(outward, 'left')).toBeGreaterThanOrEqual(MIN_PORT_ANGLE_DEG);
    // Last step is horizontal into the left side, not a 5° nick.
    expect(Math.abs(inward.y)).toBeLessThan(0.5);
    expect(inward.x).toBeGreaterThan(0);
    for (let i = 1; i < points.length; i++) {
      const diagonal =
        Math.abs(points[i].x - points[i - 1].x) > 0.5 && Math.abs(points[i].y - points[i - 1].y) > 0.5;
      expect(diagonal).toBe(false);
    }
  });

  it('spreads ports so arrows sharing a side do not merge', () => {
    const source = box('src', 0, 0);
    const first = box('t1', 400, -200);
    const second = box('t2', 400, 200);
    const arrows: Arrow[] = [
      {
        id: 'a1',
        from: { artifactId: 'src', side: 'right' },
        to: { artifactId: 't1', side: 'left' },
        bends: [],
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'a2',
        from: { artifactId: 'src', side: 'right' },
        to: { artifactId: 't2', side: 'left' },
        bends: [],
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const geometries = computeArrowGeometries([source, first, second], arrows);
    const p1 = geometries.get('a1')!.fromPoint;
    const p2 = geometries.get('a2')!.fromPoint;
    expect(p1.x).toBe(p2.x);
    expect(p1.y).not.toBe(p2.y);
    // Ordered by the target they run to, top target gets the top port.
    expect(p1.y).toBeLessThan(p2.y);
  });

  it('honours a pinned port offset', () => {
    const from = box('a', 0, 0);
    const to = box('b', 400, 0);
    const arrow: Arrow = {
      id: 'arr',
      from: { artifactId: 'a', side: 'right', offset: 0 },
      to: { artifactId: 'b', side: 'left', offset: 1 },
      bends: [],
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const geometry = arrowGeometry(arrow, new Map([['a', from], ['b', to]]));
    expect(geometry?.fromPoint).toEqual({ x: 200, y: 0 });
    expect(geometry?.toPoint).toEqual({ x: 400, y: 100 });
  });

  it('resolves auto sides against the first bend, not the far endpoint', () => {
    const from = box('a', 0, 0);
    const to = box('b', 600, 0);
    const arrow: Arrow = {
      id: 'arr',
      from: { artifactId: 'a', side: 'auto' },
      to: { artifactId: 'b', side: 'auto' },
      bends: [{ x: 100, y: -400 }],
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const geometry = arrowGeometry(arrow, new Map([['a', from], ['b', to]]));
    expect(geometry?.fromSide).toBe('top');
    expect(geometry?.toSide).toBe('top');
  });

  it('never draws an orthogonal arrow as a diagonal, even on stale bends', () => {
    const from = box('a', 0, 0);
    const to = box('b', 600, 400);
    const arrow: Arrow = {
      id: 'arr',
      from: { artifactId: 'a', side: 'right', offset: 0.5 },
      to: { artifactId: 'b', side: 'left', offset: 0.5 },
      // Left over from an arrangement where the nodes stood somewhere else.
      bends: [{ x: 320, y: 90 }, { x: 415, y: 265 }],
      routing: 'orthogonal',
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const geometry = arrowGeometry(arrow, new Map([['a', from], ['b', to]]));
    const points = geometry!.points;
    for (let i = 1; i < points.length; i++) {
      const diagonal =
        Math.abs(points[i].x - points[i - 1].x) > 0.5 && Math.abs(points[i].y - points[i - 1].y) > 0.5;
      expect(diagonal).toBe(false);
    }
    expect(points[0]).toEqual({ x: 200, y: 50 });
    expect(points[points.length - 1]).toEqual({ x: 600, y: 450 });
  });

  it('drops a T-shaped whisker left by a stale bend just off the line', () => {
    const from = box('a', 0, 0);
    const to = box('b', 600, 0);
    const arrow: Arrow = {
      id: 'arr',
      from: { artifactId: 'a', side: 'right', offset: 0.5 },
      to: { artifactId: 'b', side: 'left', offset: 0.5 },
      // Port line is y=50; this leftover sits 20px above it and rectify would
      // otherwise draw a spike up and back at the corner.
      bends: [{ x: 400, y: 30 }],
      routing: 'orthogonal',
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const points = arrowGeometry(arrow, new Map([['a', from], ['b', to]]))!.points;
    const ys = new Set(points.map((p) => p.y));
    expect(ys.has(30)).toBe(false);
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1];
      const next = points[i + 1];
      expect(prev.x === next.x && prev.y === next.y).toBe(false);
    }
  });

  it('flattens a one-cell raised bridge between two almost-aligned ports', () => {
    const from = box('a', 0, 0);
    const to = box('b', 600, 0);
    const arrow: Arrow = {
      id: 'arr',
      from: { artifactId: 'a', side: 'right', offset: 0.5 },
      to: { artifactId: 'b', side: 'left', offset: 0.5 },
      bends: [
        { x: 250, y: 42 },
        { x: 550, y: 42 },
      ],
      routing: 'orthogonal',
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const points = arrowGeometry(arrow, new Map([['a', from], ['b', to]]))!.points;
    const ys = [...new Set(points.map((p) => p.y))];
    expect(ys).toEqual([50]);
  });

  it('keeps a real Z when the ports sit on different rows', () => {
    const from = box('a', 0, 0);
    const to = box('b', 600, 80);
    const arrow: Arrow = {
      id: 'arr',
      from: { artifactId: 'a', side: 'right', offset: 0.5 },
      to: { artifactId: 'b', side: 'left', offset: 0.5 },
      bends: [],
      routing: 'orthogonal',
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const points = arrowGeometry(arrow, new Map([['a', from], ['b', to]]))!.points;
    const ys = [...new Set(points.map((p) => p.y))];
    expect(ys).toContain(50);
    expect(ys).toContain(130);
  });

  it('maps polyline segments back to the bend they would be inserted at', () => {
    const from = box('a', 0, 0);
    const to = box('b', 600, 300);
    const arrow: Arrow = {
      id: 'arr',
      from: { artifactId: 'a', side: 'right' },
      to: { artifactId: 'b', side: 'left' },
      bends: [{ x: 400, y: 50 }],
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const geometry = arrowGeometry(arrow, new Map([['a', from], ['b', to]]))!;
    expect(geometry.insertAt).toHaveLength(geometry.points.length - 1);
    // Before the stored bend, then after it for the rest of the polyline.
    expect(geometry.insertAt[0]).toBe(0);
    expect(geometry.insertAt[geometry.insertAt.length - 1]).toBe(1);
  });

  it('never draws a diagonal even when routing is straight', () => {
    const from = box('a', 200, 300);
    const to = box('b', 0, 0);
    const arrow: Arrow = {
      id: 'arr',
      from: { artifactId: 'a', side: 'top', offset: 0.5 },
      to: { artifactId: 'b', side: 'bottom', offset: 0.5 },
      bends: [],
      routing: 'straight',
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const points = arrowGeometry(arrow, new Map([['a', from], ['b', to]]))!.points;
    for (let i = 1; i < points.length; i++) {
      const dx = Math.abs(points[i].x - points[i - 1].x);
      const dy = Math.abs(points[i].y - points[i - 1].y);
      expect(dx > 0.5 && dy > 0.5).toBe(false);
      if (dx + dy >= 0.5) expect(dx + dy).toBeGreaterThanOrEqual(MIN_EDGE);
    }
    const first = { x: points[1].x - points[0].x, y: points[1].y - points[0].y };
    const last = { x: points[points.length - 2].x - points[points.length - 1].x, y: points[points.length - 2].y - points[points.length - 1].y };
    expect(angleToSide(first, 'top')).toBeGreaterThanOrEqual(MIN_PORT_ANGLE_DEG);
    expect(angleToSide(last, 'bottom')).toBeGreaterThanOrEqual(MIN_PORT_ANGLE_DEG);
  });

  it('does not skim a top side when the previous bend sits on the edge', () => {
    const from = box('a', 400, 80);
    const to = box('b', 0, 100);
    const arrow: Arrow = {
      id: 'arr',
      from: { artifactId: 'a', side: 'left', offset: 0.5 },
      to: { artifactId: 'b', side: 'top', offset: 0.5 },
      bends: [{ x: 250, y: 100 }],
      routing: 'straight',
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const points = arrowGeometry(arrow, new Map([['a', from], ['b', to]]))!.points;
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    expect(Math.abs(last.x - prev.x)).toBeLessThan(0.5);
    expect(prev.y).toBeLessThan(last.y - 0.5);
    expect(last.y - prev.y).toBeGreaterThanOrEqual(PORT_STUB - 0.5);
    expect(angleToSide({ x: prev.x - last.x, y: prev.y - last.y }, 'top')).toBeGreaterThanOrEqual(
      MIN_PORT_ANGLE_DEG,
    );
    for (let i = 1; i < points.length; i++) {
      const diagonal =
        Math.abs(points[i].x - points[i - 1].x) > 0.5 && Math.abs(points[i].y - points[i - 1].y) > 0.5;
      expect(diagonal).toBe(false);
    }
  });

  it('enters a shared left-side join head-on, even from above and below', () => {
    const note = box('note', 400, 120, 220, 160);
    const ryuk = box('ryuk', 700, 0);
    const light = box('light', 0, 0);
    const misa = box('misa', 0, 320);
    const arrows: Arrow[] = [
      {
        id: 'owns',
        from: { artifactId: 'ryuk', side: 'bottom', offset: 0.5 },
        to: { artifactId: 'note', side: 'left', offset: 0.5 },
        bends: [],
        routing: 'straight',
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'hero',
        from: { artifactId: 'light', side: 'right', offset: 0.5 },
        to: { artifactId: 'note', side: 'left', offset: 0.5 },
        bends: [],
        routing: 'straight',
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'got',
        from: { artifactId: 'misa', side: 'right', offset: 0.5 },
        to: { artifactId: 'note', side: 'left', offset: 0.5 },
        bends: [],
        routing: 'straight',
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const geos = computeArrowGeometries([note, ryuk, light, misa], arrows);
    for (const id of ['owns', 'hero', 'got']) {
      const points = geos.get(id)!.points;
      const last = points[points.length - 1];
      const prev = points[points.length - 2];
      expect(Math.abs(last.y - prev.y)).toBeLessThan(0.5);
      expect(last.x - prev.x).toBeGreaterThanOrEqual(PORT_STUB - 0.5);
      expect(
        angleToSide({ x: prev.x - last.x, y: prev.y - last.y }, 'left'),
      ).toBeGreaterThanOrEqual(MIN_PORT_ANGLE_DEG);
      for (let i = 1; i < points.length; i++) {
        const diagonal =
          Math.abs(points[i].x - points[i - 1].x) > 0.5 &&
          Math.abs(points[i].y - points[i - 1].y) > 0.5;
        expect(diagonal).toBe(false);
      }
    }
  });

  it('turns a one-bend leftover into a horizontal left entry, never a diagonal', () => {
    // Live board: Light (60,60) → notebook (500,280), stored bend on Light's row
    // 24px left of the notebook. Without an L-corner that last hop is ~7° to
    // the side and the arrowhead points down-right along it.
    const light = box('light', 60, 60, 280, 140);
    const note = box('note', 500, 280, 280, 140);
    const arrows: Arrow[] = [
      {
        id: 'owns',
        from: { artifactId: 'light', side: 'right', offset: 0.5 },
        to: { artifactId: 'note', side: 'left', offset: 0.336 },
        bends: [{ x: 476, y: 130 }],
        routing: 'orthogonal',
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const points = computeArrowGeometries([light, note], arrows).get('owns')!.points;
    for (let i = 1; i < points.length; i++) {
      const diagonal =
        Math.abs(points[i].x - points[i - 1].x) > 0.5 &&
        Math.abs(points[i].y - points[i - 1].y) > 0.5;
      expect(diagonal).toBe(false);
    }
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    expect(Math.abs(last.y - prev.y)).toBeLessThan(0.5);
    expect(last.x - prev.x).toBeGreaterThanOrEqual(MIN_EDGE);
    expect(angleToSide({ x: prev.x - last.x, y: prev.y - last.y }, 'left')).toBeCloseTo(90, 0);
  });

  it('does not reverse in a facing gap shorter than two stubs', () => {
    const ryuk = box('ryuk', 500, 60, 280, 140);
    const note = box('note', 500, 280, 280, 140);
    const arrows: Arrow[] = [
      {
        id: 'gave',
        from: { artifactId: 'ryuk', side: 'bottom', offset: 0.5 },
        to: { artifactId: 'note', side: 'top', offset: 0.5 },
        bends: [],
        routing: 'orthogonal',
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const points = computeArrowGeometries([ryuk, note], arrows).get('gave')!.points;
    for (let i = 1; i < points.length; i++) {
      expect(Math.abs(points[i].x - points[i - 1].x)).toBeLessThan(0.5);
      expect(points[i].y).toBeGreaterThanOrEqual(points[i - 1].y - 0.5);
    }
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    expect(last.y - prev.y).toBeGreaterThan(0);
    expect(angleToSide({ x: prev.x - last.x, y: prev.y - last.y }, 'top')).toBeCloseTo(90, 0);
  });

  it('allows two outgoing arrows to share a point', () => {
    const root = box('root', 0, 0);
    const left = box('l', 400, -200);
    const right = box('r', 400, 200);
    const arrows: Arrow[] = [
      {
        id: 'a1',
        from: { artifactId: 'root', side: 'right', offset: 0.5 },
        to: { artifactId: 'l', side: 'left', offset: 0.5 },
        bends: [],
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'a2',
        from: { artifactId: 'root', side: 'right', offset: 0.5 },
        to: { artifactId: 'r', side: 'left', offset: 0.5 },
        bends: [],
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const geos = computeArrowGeometries([root, left, right], arrows);
    expect(geos.get('a1')!.fromPoint).toEqual(geos.get('a2')!.fromPoint);
  });

  it('nudges a corner so an incoming and an outgoing arrow do not share a pixel', () => {
    const mid = box('mid', 200, 200);
    const up = box('up', 200, 0);
    const left = box('left', 0, 200);
    const arrows: Arrow[] = [
      {
        id: 'in',
        from: { artifactId: 'up', side: 'bottom', offset: 0 },
        to: { artifactId: 'mid', side: 'top', offset: 0 },
        bends: [],
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'out',
        from: { artifactId: 'mid', side: 'left', offset: 0 },
        to: { artifactId: 'left', side: 'right', offset: 0.5 },
        bends: [],
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const geos = computeArrowGeometries([mid, up, left], arrows);
    const enter = geos.get('in')!.toPoint;
    const leave = geos.get('out')!.fromPoint;
    expect(Math.hypot(enter.x - leave.x, enter.y - leave.y)).toBeGreaterThanOrEqual(1.5);
  });

  it('returns null when an endpoint no longer exists', () => {
    const arrow: Arrow = {
      id: 'arr',
      from: { artifactId: 'a', side: 'auto' },
      to: { artifactId: 'gone', side: 'auto' },
      bends: [],
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
    expect(arrowGeometry(arrow, new Map([['a', box('a', 0, 0)]]))).toBeNull();
  });
});

describe('tidyOrthogonal', () => {
  it('removes a collinear U-turn', () => {
    const cleaned = tidyOrthogonal([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 80 },
    ]);
    expect(cleaned).toEqual([
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 80 },
    ]);
  });
});

describe('layout helpers', () => {
  it('detects overlapping rectangles', () => {
    expect(rectsIntersect(box('a', 0, 0), box('b', 100, 50))).toBe(true);
    expect(rectsIntersect(box('a', 0, 0), box('b', 400, 0))).toBe(false);
  });

  it('computes the bounding box of a composition', () => {
    expect(boundsOf([box('a', 0, 0), box('b', 300, 200)])).toEqual({
      x: 0,
      y: 0,
      width: 500,
      height: 300,
    });
    expect(boundsOf([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('arrowPathData', () => {
  const corner = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];

  it('leaves an orthogonal route as straight segments', () => {
    expect(arrowPathData(corner, 'orthogonal')).toBe('M 0 0 L 100 0 L 100 100');
  });

  it('rounds a corner without moving the ends', () => {
    const d = arrowPathData(corner, 'curved');
    // The route is the same route: it starts and finishes at the same ports,
    // and only the corner between them is drawn round.
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d.endsWith('L 100 100')).toBe(true);
    expect(d).toContain('Q 100 0');
    expect(d).toContain(`L ${100 - 100 * CORNER_RADIUS_SHARE} 0`);
  });

  it('gives a longer run a wider sweep', () => {
    // The radius is a share of the run, not a fixed number, so corners on a
    // spacious board read differently from corners on a cramped one.
    const sweep = (run: number) => {
      const d = arrowPathData(
        [
          { x: 0, y: 0 },
          { x: run, y: 0 },
          { x: run, y: run },
        ],
        'curved',
      );
      return run - Number(d.split(' L ')[1].split(' ')[0]);
    };
    expect(sweep(400)).toBeGreaterThan(sweep(100));
    expect(sweep(100)).toBeGreaterThan(sweep(40));
  });

  it('caps the sweep so a very long run does not balloon', () => {
    const d = arrowPathData(
      [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 1000 },
      ],
      'curved',
    );
    expect(d).toContain(`L ${1000 - CORNER_RADIUS_MAX} 0`);
  });

  it('shrinks the radius rather than overrunning a short segment', () => {
    // Ten pixels of run cannot carry a wide arc; the share keeps it inside its
    // own leg, so the corner stays sharp-ish rather than spilling over.
    const d = arrowPathData(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      'curved',
    );
    expect(d).toBe('M 0 0 L 6 0 Q 10 0 10 5 L 10 10');
  });

  it('measures the drawn arc, not the corner it replaced', () => {
    // A curved arrow is not the same line as its route, so anything judging
    // what the reader sees has to be given the arc in pieces.
    const route = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
    ];
    const drawn = drawnPolyline(route, 'curved');
    expect(drawn.length).toBeGreaterThan(route.length);
    // The apex of the turn is cut off: nothing drawn reaches the corner itself.
    expect(drawn.some((p) => p.x > 199 && p.y < 1)).toBe(false);
    // And an orthogonal arrow is handed back untouched.
    expect(drawnPolyline(route, 'orthogonal')).toBe(route);
  });

  it('does not bend a point that lies on a straight run', () => {
    const d = arrowPathData(
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 100, y: 0 },
      ],
      'curved',
    );
    expect(d).toBe('M 0 0 L 100 0');
  });

  it('is the same polyline whichever way it is drawn', () => {
    // Curving is a drawing mode, not a route: everything that measures the
    // board reads these points, and they must not move.
    const artifacts = [box('a', 0, 0), box('b', 500, 300)];
    const arrows: Arrow[] = [
      {
        id: 'r1',
        from: { artifactId: 'a', side: 'right', offset: 0.5 },
        to: { artifactId: 'b', side: 'left', offset: 0.5 },
        bends: [{ x: 300, y: 70 }],
        style: {},
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const sharp = computeArrowGeometries(artifacts, arrows).get('r1')!.points;
    const curved = computeArrowGeometries(
      artifacts,
      arrows.map((a) => ({ ...a, routing: 'curved' as const })),
    ).get('r1')!.points;
    expect(curved).toEqual(sharp);
  });
});
