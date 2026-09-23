import {
  boardQuality,
  searchPorts,
  routeArrows,
  type Arrow,
  type Artifact,
  type FixedSide,
  type Vec2,
} from '@zmtki/shared';
import { describe, expect, it } from 'vitest';

const node = (id: string, x: number, y: number): Artifact => ({
  id, type: 'note', x, y, width: 200, height: 120, z: 1, rotation: 0,
  props: {}, createdAt: 0, updatedAt: 0,
});

const edge = (id: string, from: string, to: string): Arrow => ({
  id,
  from: { artifactId: from, side: 'auto' },
  to: { artifactId: to, side: 'auto' },
  bends: [], routing: 'orthogonal', style: {}, createdAt: 0, updatedAt: 0,
});

const lay = (artifacts: Artifact[], arrows: Arrow[]): Arrow[] => {
  const out = routeArrows(artifacts, arrows);
  return arrows.map((a) => {
    const m = out.routed.find((x) => x.arrowId === a.id);
    return m
      ? { ...a, bends: m.bends, routing: 'orthogonal' as const, autoPorts: true,
          from: { ...a.from, side: m.fromSide, offset: m.fromOffset },
          to: { ...a.to, side: m.toSide, offset: m.toOffset } }
      : a;
  });
};

describe('searchPorts', () => {
  it('untangles arrows that meet at one node in the wrong order', () => {
    // Two sources above, two targets below, wired crosswise: whichever way the
    // router lays them first, one attachment order crosses and the other does not.
    const artifacts = [
      node('s1', 0, 0), node('s2', 400, 0),
      node('hub', 200, 300),
      node('t1', 0, 600), node('t2', 400, 600),
    ];
    const arrows = [
      edge('a', 's1', 'hub'), edge('b', 's2', 'hub'),
      edge('c', 'hub', 't2'), edge('d', 'hub', 't1'),
    ];
    const laid = lay(artifacts, arrows);
    const before = boardQuality(artifacts, laid);
    const result = searchPorts(artifacts, laid);

    expect(result.costAfter).toBeLessThanOrEqual(before.cost);
    expect(result.tried).toBeGreaterThan(0);
  });

  it('never returns something worse than it was given', () => {
    const artifacts = [node('a', 0, 0), node('b', 500, 0), node('c', 250, 400)];
    const arrows = [edge('e1', 'a', 'b'), edge('e2', 'a', 'c'), edge('e3', 'b', 'c')];
    const laid = lay(artifacts, arrows);
    const result = searchPorts(artifacts, laid);
    expect(result.costAfter).toBeLessThanOrEqual(result.costBefore);
  });

  it('leaves ports the agent pinned alone', () => {
    const artifacts = [node('a', 0, 0), node('b', 500, 0), node('c', 250, 400)];
    const arrows = lay(artifacts, [
      edge('e1', 'a', 'c'), edge('e2', 'b', 'c'),
    ]).map((arrow) =>
      // The agent asked for this one explicitly, so it is not the router's to move.
      arrow.id === 'e1' ? { ...arrow, autoPorts: undefined } : arrow,
    );

    const pinned = arrows.find((a) => a.id === 'e1')!;
    const result = searchPorts(artifacts, arrows, { lockedArrowIds: ['e1'] });
    const after = result.arrows.find((a) => a.id === 'e1')!;

    expect(after.from.side).toBe(pinned.from.side);
    expect(after.from.offset).toBe(pinned.from.offset);
    expect(after.to.side).toBe(pinned.to.side);
    expect(after.to.offset).toBe(pinned.to.offset);
  });

  it('stops after the swap budget', () => {
    const artifacts = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => node(id, (i % 3) * 400, Math.floor(i / 3) * 400));
    const arrows = [
      edge('e1', 'a', 'e'), edge('e2', 'b', 'd'), edge('e3', 'c', 'e'),
      edge('e4', 'a', 'f'), edge('e5', 'b', 'f'),
    ];
    const result = searchPorts(artifacts, lay(artifacts, arrows), { maxSwaps: 1 });
    expect(result.swaps).toBeLessThanOrEqual(1);
  });
});

describe('переезд конца на другую сторону', () => {
  it('находит вариант, недоступный обменом: у узла одна стрелка', () => {
    // A single arrow has nothing to swap with, so only a side move can help.
    const artifacts = [node('a', 0, 0), node('blocker', 260, 0), node('b', 520, 0)];
    const arrows = [edge('e1', 'a', 'b')];
    const laid = lay(artifacts, arrows);
    const result = searchPorts(artifacts, laid);

    expect(result.costAfter).toBeLessThanOrEqual(result.costBefore);
    expect(result.tried).toBeGreaterThan(0);
  });

  it('уводит стрелку низом, когда каждый ход по отдельности хуже', () => {
    // Доска fix-broken, как её оставил агент. Одно пересечение, и снять его
    // можно только двумя ходами сразу: перенести дальний конец на нижнюю
    // сторону «Отказа» И сдвинуть ближний конец по низу «Скоринга». Порознь
    // первый ход даёт 83 против 86, поэтому переборы по одному его отвергают.
    const wide = (id: string, x: number, y: number): Artifact => ({
      ...node(id, x, y),
      width: 220,
      height: 140,
    });
    const artifacts = [
      wide('приём', 0, 0), wide('проверка', 260, 0), wide('скоринг', 520, 0),
      wide('ручная', 780, 200), wide('одобрено', 780, 0),
      wide('отказ', 1040, 200), wide('выдача', 1040, 0),
    ];
    const link = (
      id: string,
      from: string,
      fromSide: FixedSide,
      to: string,
      toSide: FixedSide,
      bends: Vec2[] = [],
      fromOffset = 0.5,
    ): Arrow => ({
      ...edge(id, from, to),
      from: { artifactId: from, side: fromSide, offset: fromOffset },
      to: { artifactId: to, side: toSide, offset: 0.5 },
      bends,
    });
    const arrows = [
      link('a1', 'приём', 'right', 'проверка', 'left'),
      link('a2', 'проверка', 'right', 'скоринг', 'left'),
      link('a3', 'скоринг', 'bottom', 'ручная', 'left', [{ x: 630, y: 270 }]),
      link('a4', 'скоринг', 'right', 'одобрено', 'left'),
      link('a5', 'ручная', 'top', 'одобрено', 'bottom'),
      link('a6', 'ручная', 'right', 'отказ', 'left'),
      link('a7', 'скоринг', 'bottom', 'отказ', 'top', [{ x: 667, y: 148 }, { x: 1098, y: 148 }], 0.668),
      link('a8', 'одобрено', 'right', 'выдача', 'left'),
    ];

    expect(boardQuality(artifacts, arrows).metrics.crossings).toBe(1);

    const withoutDetour = searchPorts(artifacts, arrows, { detour: false });
    expect(boardQuality(artifacts, withoutDetour.arrows).metrics.crossings).toBe(1);

    const withDetour = searchPorts(artifacts, arrows);
    const after = boardQuality(artifacts, withDetour.arrows);
    expect(after.metrics.crossings).toBe(0);
    expect(after.score).toBeGreaterThanOrEqual(95);

    // Низом, а не поверху: линия уходит под «Ручную проверку» и входит в
    // «Отказ» снизу — тот же маршрут, который нарисовал бы человек.
    const detoured = withDetour.arrows.find((arrow) => arrow.id === 'a7')!;
    expect(detoured.to.side).toBe('bottom');
  });

  it('spreadPorts даёт каждой стрелке свою точку на стороне', () => {
    const artifacts = [node('src', 0, 0), node('left', -300, 400), node('right', 300, 400)];
    const arrows = [edge('e1', 'src', 'left'), edge('e2', 'src', 'right')];
    const pointsOf = (spread: boolean) => {
      const out = routeArrows(artifacts, arrows, { spreadPorts: spread });
      return out.routed
        .filter((r) => r.fromSide === 'bottom')
        .map((r) => Math.round(r.fromOffset * 1000) / 1000);
    };
    const shared = pointsOf(false);
    const apart = pointsOf(true);
    if (shared.length === 2) {
      expect(shared[0]).toBe(shared[1]);
      expect(apart[0]).not.toBe(apart[1]);
    }
  });

  it('считает обмены и переезды по отдельности', () => {
    const artifacts = [node('a', 0, 0), node('b', 500, 0), node('c', 250, 400)];
    const arrows = lay(artifacts, [edge('e1', 'a', 'c'), edge('e2', 'b', 'c')]);
    const result = searchPorts(artifacts, arrows);

    expect(typeof result.swaps).toBe('number');
    expect(typeof result.moves).toBe('number');
    expect(result.swaps + result.moves).toBeLessThanOrEqual(24);
  });
});
