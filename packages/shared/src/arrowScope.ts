import type { Arrow, Artifact, Rect } from './artifacts.js';
import { PORT_STUB } from './geometry.js';

/**
 * How far from an arrow's end artifact another box can still change the arrow.
 *
 * `computeArrowGeometries` consults the rest of the board in exactly one place:
 * `approachLength`, which shortens a port's perpendicular stub when a neighbour
 * sits in front of it. The stub is capped at PORT_STUB and the neighbour test
 * pads by 8, so a box further than PORT_STUB + 8 from the port yields the same
 * stub as no box at all. One pixel more for rounding.
 */
export const ARROW_SCOPE_MARGIN = PORT_STUB + 8 + 1;

const grow = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  width: r.width + by * 2,
  height: r.height + by * 2,
});

/**
 * The artifacts that can affect the geometry of `arrows`: their end artifacts
 * and whatever lies within ARROW_SCOPE_MARGIN of those. Passing this instead of
 * the whole board to `computeArrowGeometries` gives identical geometry at a
 * cost proportional to the arrows drawn — the full board made `approachLength`
 * a third of all renderer CPU while panning a 10 000-card board.
 *
 * `lookup` returns the current geometry of an artifact (drag drafts and slides
 * folded in); `near` answers what lies in a rectangle. Artifacts in `moving`
 * are always included, since a spatial index built before they moved cannot
 * find them where they are now drawn.
 */
export const arrowGeometryScope = (
  arrows: Arrow[],
  lookup: (id: string) => Artifact | undefined,
  near: (area: Rect) => Artifact[],
  moving: Iterable<string> = [],
): Map<string, Artifact> => {
  const scope = new Map<string, Artifact>();
  const add = (artifact: Artifact | undefined) => {
    if (artifact && !scope.has(artifact.id)) scope.set(artifact.id, lookup(artifact.id) ?? artifact);
  };
  for (const id of moving) add(lookup(id));
  const ends = new Set<string>();
  for (const arrow of arrows) {
    ends.add(arrow.from.artifactId);
    ends.add(arrow.to.artifactId);
  }
  for (const id of ends) {
    const end = lookup(id);
    if (!end) continue;
    add(end);
    for (const other of near(grow(end, ARROW_SCOPE_MARGIN))) add(other);
  }
  return scope;
};
