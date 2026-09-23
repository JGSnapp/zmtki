import type { Arrow, Artifact } from './artifacts.js';
import { checkIntersections } from './intersections.js';
import { boardQuality } from './quality.js';
import { routeArrows, tooTightToRoute } from './routing.js';

export interface MoveSuggestion {
  artifactId: string;
  x: number;
  y: number;
  crossingsBefore: number;
  crossingsAfter: number;
  costBefore: number;
  costAfter: number;
  note: string;
}

/** Boards larger than this are not worth the search: the agent should re-arrange. */
const MAX_ARTIFACTS = 26;
/** Above a handful of crossings the fix is the layout, not one block. */
const MAX_CROSSINGS = 3;

/**
 * Where one block could go to remove a crossing.
 *
 * Some crossings cannot be routed away at all. On one board a line ran
 * horizontally through the corridor between two rows while another climbed from
 * the lower row to the upper one: every attachment point and every route
 * crosses that corridor somewhere, so the port search tried two hundred and
 * fifty-six variants and found nothing. What fixes it is moving a block — and
 * the agent has no way to know which one or where, because trying costs it a
 * whole round trip each time.
 *
 * So the engine tries: for each block touching a crossing, swap it with another
 * block or step it one slot aside, re-route, and keep the moves that actually
 * remove a crossing without making the board worse.
 */
export const suggestMoves = (
  artifacts: Artifact[],
  arrows: Arrow[],
  limit = 3,
): MoveSuggestion[] => {
  if (artifacts.length === 0 || artifacts.length > MAX_ARTIFACTS) return [];

  const before = boardQuality(artifacts, arrows);
  const crossings = before.counts.arrowArrow;
  if (crossings === 0 || crossings > MAX_CROSSINGS) return [];

  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const involved = new Set<string>();
  for (const finding of checkIntersections(artifacts, arrows).findings) {
    if (finding.kind !== 'arrow_arrow') continue;
    for (const id of [finding.arrowAId, finding.arrowBId]) {
      const arrow = arrows.find((a) => a.id === id);
      if (!arrow) continue;
      involved.add(arrow.from.artifactId);
      involved.add(arrow.to.artifactId);
    }
  }

  const step = (a: Artifact) => ({ x: a.width + 40, y: a.height + 40 });
  const results: MoveSuggestion[] = [];

  for (const id of involved) {
    const subject = byId.get(id);
    if (!subject) continue;
    const { x: dx, y: dy } = step(subject);

    const candidates: Array<{ x: number; y: number; why: string }> = [
      { x: subject.x, y: subject.y + dy, why: 'ниже' },
      { x: subject.x, y: subject.y - dy, why: 'выше' },
      { x: subject.x + dx, y: subject.y, why: 'правее' },
      { x: subject.x - dx, y: subject.y, why: 'левее' },
    ];
    // Swapping with a neighbour is what untangles a pair that simply sits in
    // the wrong order, which a shift cannot fix.
    for (const other of artifacts) {
      if (other.id === subject.id) continue;
      const sameRow = Math.abs(other.y - subject.y) < 8;
      const sameColumn = Math.abs(other.x - subject.x) < 8;
      if (sameRow || sameColumn) candidates.push({ x: other.x, y: other.y, why: 'меняя местами' });
    }

    for (const candidate of candidates) {
      const moved = artifacts.map((a) =>
        a.id === subject.id ? { ...a, x: candidate.x, y: candidate.y } : a,
      );
      // A move that lands on another block is not a suggestion.
      const clash = moved.some(
        (a) =>
          a.id !== subject.id &&
          candidate.x < a.x + a.width &&
          a.x < candidate.x + subject.width &&
          candidate.y < a.y + a.height &&
          a.y < candidate.y + subject.height,
      );
      if (clash) continue;

      const loose = arrows.map((a) => ({ ...a, bends: [] }));
      if (!tooTightToRoute(moved, loose).ready) continue;
      const outcome = routeArrows(moved, loose);
      if (outcome.refused) continue;
      const next = loose.map((a) => {
        const r = outcome.routed.find((x) => x.arrowId === a.id);
        return r
          ? {
              ...a,
              bends: r.bends,
              autoPorts: true,
              from: { ...a.from, side: r.fromSide, offset: r.fromOffset },
              to: { ...a.to, side: r.toSide, offset: r.toOffset },
            }
          : a;
      });
      const after = boardQuality(moved, next);
      if (after.counts.arrowArrow >= crossings || after.cost >= before.cost) continue;

      results.push({
        artifactId: subject.id,
        x: candidate.x,
        y: candidate.y,
        crossingsBefore: crossings,
        crossingsAfter: after.counts.arrowArrow,
        costBefore: before.cost,
        costAfter: after.cost,
        note: `Подвинь ${subject.id} ${candidate.why} — в (${candidate.x}, ${candidate.y}): пересечений станет ${after.counts.arrowArrow} вместо ${crossings}, качество ${before.score} → ${after.score}.`,
      });
    }
  }

  return results.sort((a, b) => a.costAfter - b.costAfter).slice(0, limit);
};
