import { describe, expect, it } from 'vitest';
import type { Arrow, Artifact } from '../src/index.js';
import { SpatialIndex, arrowGeometryScope, computeArrowGeometries } from '../src/index.js';

let seed = 7;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const artifact = (id: string, x: number, y: number, width: number, height: number): Artifact => ({
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

describe('arrowGeometryScope', () => {
  it('gives exactly the geometry the whole board gives, on a dense board with close neighbours', () => {
    const artifacts: Artifact[] = [];
    // A jittered grid tight enough that many ports have a neighbour inside the stub.
    for (let row = 0; row < 30; row += 1) {
      for (let col = 0; col < 30; col += 1) {
        const w = 120 + Math.floor(random() * 160);
        const h = 80 + Math.floor(random() * 120);
        artifacts.push(artifact('a' + row + '_' + col, col * 300 + Math.floor(random() * 60), row * 240 + Math.floor(random() * 50), w, h));
      }
    }
    const arrows: Arrow[] = [];
    for (let i = 0; i < 400; i += 1) {
      const from = artifacts[Math.floor(random() * artifacts.length)];
      const near = artifacts.filter((a) => a !== from && Math.abs(a.x - from.x) < 700 && Math.abs(a.y - from.y) < 600);
      const to = near[Math.floor(random() * near.length)];
      if (!to) continue;
      arrows.push({
        id: 'r' + i,
        from: { artifactId: from.id, side: 'auto' },
        to: { artifactId: to.id, side: i % 5 === 0 ? 'top' : 'auto', offset: i % 7 === 0 ? 0.3 : undefined },
        bends: [],
        routing: 'orthogonal',
        style: {},
        createdAt: 0,
        updatedAt: 0,
      });
    }

    const byId = new Map(artifacts.map((a) => [a.id, a]));
    const index = new SpatialIndex(artifacts);
    // A slice of the arrows, as the canvas draws only those of mounted cards.
    const drawn = arrows.slice(0, 120);
    const scope = arrowGeometryScope(drawn, (id) => byId.get(id), (area) => index.query(area));

    const full = computeArrowGeometries(artifacts, drawn);
    const scoped = computeArrowGeometries(scope, drawn);
    expect(scope.size).toBeLessThan(artifacts.length / 2);
    expect([...scoped.entries()]).toEqual([...full.entries()]);
  });

  it('includes a moving artifact where it is drawn, not where the index last saw it', () => {
    const a = artifact('a', 0, 0, 200, 100);
    const b = artifact('b', 400, 0, 200, 100);
    const index = new SpatialIndex([a, b]);
    const dragged = { ...b, x: 5000 };
    const scope = arrowGeometryScope(
      [{ id: 'r', from: { artifactId: 'a', side: 'auto' }, to: { artifactId: 'b', side: 'auto' }, bends: [], style: {}, createdAt: 0, updatedAt: 0 }],
      (id) => (id === 'b' ? dragged : id === 'a' ? a : undefined),
      (area) => index.query(area),
      ['b'],
    );
    expect(scope.get('b')?.x).toBe(5000);
  });
});
