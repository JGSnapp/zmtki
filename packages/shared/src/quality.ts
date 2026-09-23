import type { Arrow, Artifact, Vec2 } from './artifacts.js';
import {
  CORNER_INSET,
  MIN_EDGE,
  MIN_MIXED_PORT,
  computeArrowGeometries,
} from './geometry.js';
import {
  checkIntersections,
  type CheckIntersectionsOptions,
  type IntersectionCounts,
  type IntersectionReport,
} from './intersections.js';

export interface QualityMetrics {
  artifacts: number;
  arrows: number;
  /** Arrows cutting through a box. */
  edgeNodeHits: number;
  crossings: number;
  shallowCrossings: number;
  mergedArrows: number;
  clearanceHits: number;
  overlaps: number;
  tightPairs: number;
  labelConflicts: number;
  bends: number;
  /** Direction changes on the polylines as drawn — what the reader counts. */
  drawnTurns: number;
  /** Ports sitting on a box's rounded corner, where a line attaches to nothing. */
  cornerPorts: number;
  totalLength: number;
  /** Mean ratio of drawn length to the shortest orthogonal path; 1.0 is ideal. */
  detour: number;
}

export interface QualityPenalty {
  reason: string;
  count: number;
  cost: number;
}

export type QualityGrade = 'отлично' | 'хорошо' | 'терпимо' | 'плохо';

export interface LayoutQuality {
  /** 0..100, higher is better. Derived from `cost`, never negative. */
  score: number;
  /** Raw weighted penalty, lower is better. Use it to compare two layouts. */
  cost: number;
  grade: QualityGrade;
  metrics: QualityMetrics;
  counts: IntersectionCounts;
  breakdown: QualityPenalty[];
  hints: string[];
}

/**
 * Lexicographic-ish weights: things that make a diagram unreadable cost far
 * more than things that only make it less pretty.
 */
export const QUALITY_WEIGHTS = {
  artifactOverlap: 15,
  edgeNodeHit: 12,
  mergedArrow: 8,
  crossing: 4,
  shallowExtra: 2,
  labelConflict: 3,
  clearance: 2,
  tightSpacing: 1.5,
  extraBend: 2,
  detour: 6,
  shallowPort: 8,
  sharedPort: 8,
  shortEdge: 4,
  /**
   * A port sitting on the box's rounded corner. Nothing used to charge for
   * this, so nothing in the system had any reason to move one: the port search
   * takes strict improvements, and stepping off a corner is never an
   * improvement if the metric cannot see the corner. Priced just above one
   * extra turn, so a straight line that hugs an edge is worth trading for a
   * line with one more bend that does not — and no more than that.
   */
  cornerPort: 3,
  /**
   * Every drawn turn, including the first two that `extraBend` leaves free.
   *
   * Without it a straight line and a line with one jog cost exactly the same,
   * so nothing prefers straight. This was tried once and rejected — but that
   * was while the router still overruled every port the search chose, so the
   * search had no way to act on the charge even when it could see it. Retested
   * once pinned ports were honoured, and then it won on every count at once —
   * 89 boards, against no charge: crossings 74 → 70, drawn turns 1302 → 941,
   * straight arrows 259 → 381, ports on a corner 11 → 9.
   *
   * Small on purpose. A turn that genuinely has to be there should not be worth
   * dodging by taking a longer way round; doubling this to 1 buys 14 fewer
   * turns and costs 3 more crossings.
   *
   * Charged above what the pair cannot avoid, never flat. Two boxes that share
   * no axis need two turns to reach each other whatever anyone does, and
   * charging those would punish the layout for where the boxes are — which is
   * the placement's business, not the line's.
   */
  turn: 0.5,
};

/**
 * Direction changes along a polyline as drawn. Steps shorter than half a pixel
 * are rounding, not movement, and two segments continuing the same way are one
 * straight line to the eye however many vertices carry it.
 */
const turnsOf = (points: Vec2[]): number => {
  let last = '';
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    const direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : dy > 0 ? 'D' : 'U';
    if (last && direction !== last) count += 1;
    last = direction;
  }
  return count;
};

/** How fast the score decays: cost 25 lands on score 50. */
const HALF_COST = 25;

const gradeFor = (score: number): QualityGrade => {
  if (score >= 90) return 'отлично';
  if (score >= 70) return 'хорошо';
  if (score >= 45) return 'терпимо';
  return 'плохо';
};

export interface QualityOptions extends CheckIntersectionsOptions {
  /** Reuse an already computed report instead of running the detector again. */
  report?: IntersectionReport;
}

export const boardQuality = (
  artifacts: Artifact[],
  arrows: Arrow[],
  options: QualityOptions = {},
): LayoutQuality => {
  const report = options.report ?? checkIntersections(artifacts, arrows, options);
  const counts = report.counts;
  const geometries = computeArrowGeometries(artifacts, arrows);

  let bends = 0;
  let extraBends = 0;
  let drawnTurns = 0;
  let unavoidableTurns = 0;
  let cornerPorts = 0;
  let totalLength = 0;
  let detourSum = 0;
  let detourCount = 0;

  const arrowsById = new Map(arrows.map((arrow) => [arrow.id, arrow]));
  const boxById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  for (const [arrowId, geometry] of geometries) {
    // Render-time port stubs are implementation details, not user bends.
    const manualBends = arrowsById.get(arrowId)?.bends.length ?? 0;
    bends += manualBends;

    // Charging for stored bends undercounts what the reader actually sees by
    // about half: the renderer adds corners of its own around the port stubs.
    // The arrow that steps aside and immediately steps back stores two bends —
    // free under the old rule — while drawing four visible turns. So the charge
    // follows the polyline as drawn. Two turns stay free: that is the plain Z
    // between two facing ports, and the stubs make it unavoidable.
    const turns = turnsOf(geometry.points);
    drawnTurns += turns;
    extraBends += Math.max(0, turns - 2);

    // The fewest turns this pair could possibly be drawn with: none if the two
    // boxes overlap on an axis, since then one straight line reaches across;
    // two otherwise, for the unavoidable step sideways.
    const pair = arrowsById.get(arrowId);
    const fromBox = pair ? boxById.get(pair.from.artifactId) : undefined;
    const toBox = pair ? boxById.get(pair.to.artifactId) : undefined;
    if (fromBox && toBox) {
      const sharesX =
        fromBox.x < toBox.x + toBox.width && toBox.x < fromBox.x + fromBox.width;
      const sharesY =
        fromBox.y < toBox.y + toBox.height && toBox.y < fromBox.y + fromBox.height;
      unavoidableTurns += sharesX || sharesY ? 0 : 2;
    }

    const arrow = arrowsById.get(arrowId);
    if (arrow) {
      const ends = [
        [arrow.from.artifactId, geometry.fromSide, geometry.fromOffset],
        [arrow.to.artifactId, geometry.toSide, geometry.toOffset],
      ] as const;
      for (const [artifactId, side, offset] of ends) {
        const box = boxById.get(artifactId);
        if (!box) continue;
        const span = side === 'top' || side === 'bottom' ? box.width : box.height;
        if (Math.min(offset, 1 - offset) * span < CORNER_INSET) cornerPorts += 1;
      }
    }

    let length = 0;
    for (let i = 0; i < geometry.points.length - 1; i++) {
      const a = geometry.points[i];
      const b = geometry.points[i + 1];
      length += Math.hypot(b.x - a.x, b.y - a.y);
    }
    totalLength += length;

    // Comparing an orthogonal line with the Euclidean diagonal punished nodes
    // merely for not sharing an axis. Manhattan distance is the true baseline
    // for the rectilinear graph rendered by the board.
    const direct =
      Math.abs(geometry.toPoint.x - geometry.fromPoint.x) +
      Math.abs(geometry.toPoint.y - geometry.fromPoint.y);
    if (direct > 1) {
      detourSum += length / direct;
      detourCount += 1;
    }
  }

  const shallowCrossings = report.findings.filter(
    (f) => f.kind === 'arrow_arrow' && f.shallow,
  ).length;
  const detour = detourCount > 0 ? detourSum / detourCount : 1;

  const breakdown: QualityPenalty[] = [
    {
      reason: 'поворот линии',
      count: Math.max(0, drawnTurns - unavoidableTurns),
      cost: Math.max(0, drawnTurns - unavoidableTurns) * QUALITY_WEIGHTS.turn,
    },
    {
      reason: 'порт на скруглении блока',
      count: cornerPorts,
      cost: cornerPorts * QUALITY_WEIGHTS.cornerPort,
    },
    {
      reason: 'наложение артефактов',
      count: counts.artifactArtifact,
      cost: counts.artifactArtifact * QUALITY_WEIGHTS.artifactOverlap,
    },
    {
      reason: 'стрелка сквозь артефакт',
      count: counts.arrowArtifact,
      cost: counts.arrowArtifact * QUALITY_WEIGHTS.edgeNodeHit,
    },
    {
      reason: 'стрелки слились в одну линию',
      count: counts.arrowOverlap,
      cost: counts.arrowOverlap * QUALITY_WEIGHTS.mergedArrow,
    },
    {
      reason: 'пересечения стрелок',
      count: counts.arrowArrow,
      cost: counts.arrowArrow * QUALITY_WEIGHTS.crossing,
    },
    {
      reason: 'пологие пересечения',
      count: shallowCrossings,
      cost: shallowCrossings * QUALITY_WEIGHTS.shallowExtra,
    },
    {
      reason: 'подписи налезают',
      count: counts.labelConflict,
      cost: counts.labelConflict * QUALITY_WEIGHTS.labelConflict,
    },
    {
      reason: 'стрелка идёт впритык к артефакту',
      count: counts.arrowClearance,
      cost: counts.arrowClearance * QUALITY_WEIGHTS.clearance,
    },
    {
      reason: 'артефакты стоят слишком тесно',
      count: counts.tightSpacing,
      cost: counts.tightSpacing * QUALITY_WEIGHTS.tightSpacing,
    },
    {
      reason: 'лишние изгибы',
      count: extraBends,
      cost: extraBends * QUALITY_WEIGHTS.extraBend,
    },
    {
      reason: 'стрелки идут в обход',
      count: Math.round(Math.max(0, detour - 1) * 100),
      cost: Math.max(0, detour - 1) * QUALITY_WEIGHTS.detour * geometries.size,
    },
    {
      reason: 'вход в карточку слишком пологий',
      count: counts.arrowPortAngle,
      cost: counts.arrowPortAngle * QUALITY_WEIGHTS.shallowPort,
    },
    {
      reason: 'вход и выход в одной точке',
      count: counts.arrowSharedPort,
      cost: counts.arrowSharedPort * QUALITY_WEIGHTS.sharedPort,
    },
    {
      reason: 'слишком короткое ребро',
      count: counts.arrowShortEdge,
      cost: counts.arrowShortEdge * QUALITY_WEIGHTS.shortEdge,
    },
  ].filter((entry) => entry.cost > 0);

  const cost = Math.round(breakdown.reduce((sum, entry) => sum + entry.cost, 0) * 10) / 10;
  const score = Math.round(100 / (1 + cost / HALF_COST));

  const hints: string[] = [];
  if (counts.artifactArtifact > 0) hints.push('Раздвинь наложенные артефакты — это самое дорогое.');
  if (counts.arrowArtifact > 0) {
    hints.push(
      'Стрелки режут артефакты. В тесной раскладке роутер откажется: сначала раздвинь узлы (от 100px между соседями), потом один раз board_route_arrows.',
    );
  }
  if (counts.arrowOverlap > 0) {
    hints.push('Часть стрелок слилась: задай им разные порты (offset) или перемаршрутизируй.');
  }
  if (detour > 1.6) {
    hints.push(
      'Стрелки идут крюком: сначала проверь встречные стороны и расстояние между узлами. Если автороутер не выражает нужную трассу, допустима минимальная ручная ортогональная правка.',
    );
  }
  if (arrows.some((arrow) => arrow.bends.length > 2)) {
    hints.push(
      'На стрелках лишние изгибы: вызови board_clean_arrows, чтобы убрать усы и ступеньки после сдвига блоков.',
    );
  }
  if (counts.arrowArrow > 0 && counts.arrowArtifact === 0) {
    hints.push('Остались пересечения стрелок: поменяй порядок узлов в слое или стороны присоединения.');
  }
  if (counts.tightSpacing > 0) hints.push('Между соседями мало воздуха — увеличь шаг сетки.');
  if (counts.labelConflict > 0) hints.push('Подписям не хватает места — удлини участок стрелки под подпись.');
  if (counts.arrowPortAngle > 0) {
    hints.push(
      'Стрелка входит в карточку плашмя (меньше 30°). Сторона должна смотреть на соседа, затем board_route_arrows — последний отрезок будет под 90°.',
    );
  }
  if (counts.arrowSharedPort > 0) {
    hints.push(`Вход и выход ближе ${MIN_MIXED_PORT}px: две исходящие или две входящие делить точку могут, смешанные — нет. Возьми другую сторону.`);
  }
  if (counts.arrowShortEdge > 0) {
    hints.push(`Ребро короче ${MIN_EDGE}px: раздвинь узлы или вызови board_route_arrows.`);
  }

  return {
    score,
    cost,
    grade: gradeFor(score),
    metrics: {
      artifacts: artifacts.length,
      arrows: arrows.length,
      edgeNodeHits: counts.arrowArtifact,
      crossings: counts.arrowArrow,
      shallowCrossings,
      mergedArrows: counts.arrowOverlap,
      clearanceHits: counts.arrowClearance,
      overlaps: counts.artifactArtifact,
      tightPairs: counts.tightSpacing,
      labelConflicts: counts.labelConflict,
      bends,
      drawnTurns,
      cornerPorts,
      totalLength: Math.round(totalLength),
      detour: Math.round(detour * 100) / 100,
    },
    counts,
    breakdown,
    hints,
  };
};

/** Human readable one-liner for tool results and the board header. */
export const qualitySummary = (quality: LayoutQuality): string =>
  `качество ${quality.score}/100 (${quality.grade}), штраф ${quality.cost}`;
