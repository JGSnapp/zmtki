import type { Rect } from './artifacts.js';

/**
 * A zone is a region of the board claimed for one purpose — a project, a
 * research thread, one agent's working area.
 *
 * It is a set of rectangles rather than a single one because zones are drawn by
 * sweeping out squares and unioning them: two rectangles of the same zone merge
 * into one shape, and a rectangle can be subtracted again. Storing the pieces
 * keeps that editable; the outline is derived for rendering.
 */
export interface Zone {
  id: string;
  title: string;
  color: string;
  /** Rectangles that together make up the zone. Axis-aligned, world space. */
  rects: Rect[];
  /**
   * Set when an agent proposed this zone and the user has not answered yet.
   * Pending zones render highlighted with accept/reject controls and take part
   * in no containment checks until confirmed.
   */
  pending?: boolean;
  /** Agent that proposed or owns the zone, when there is one. */
  ownerId?: string;
  /** Why the agent asked for it — shown to the user with the request. */
  reason?: string;
  /**
   * Set on a pending request that asks to grow an existing zone. Accepting it
   * merges these rectangles into that zone instead of keeping a second one.
   */
  extendsZoneId?: string;
  /**
   * When true, an agent bound to this zone may not place artifacts outside it
   * and may not move its own harness elsewhere without asking.
   */
  locked?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Rectangles that make up a zone, in the order they were added. */
export const zoneRects = (zone: Zone): Rect[] => zone.rects;

/** Bounding box of every rectangle in the zone; null for an empty zone. */
export const zoneBounds = (zone: Zone): Rect | null => {
  if (zone.rects.length === 0) return null;
  const minX = Math.min(...zone.rects.map((r) => r.x));
  const minY = Math.min(...zone.rects.map((r) => r.y));
  const maxX = Math.max(...zone.rects.map((r) => r.x + r.width));
  const maxY = Math.max(...zone.rects.map((r) => r.y + r.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/** True when the point falls inside any rectangle of the zone. */
export const zoneContainsPoint = (zone: Zone, x: number, y: number): boolean =>
  zone.rects.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
