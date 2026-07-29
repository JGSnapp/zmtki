import { z } from 'zod';

export const Vec2Schema = z.object({ x: z.number(), y: z.number() });
export type Vec2 = z.infer<typeof Vec2Schema>;

export const SizeSchema = z.object({ w: z.number(), h: z.number() });
export type Size = z.infer<typeof SizeSchema>;

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number()
});
export type Rect = z.infer<typeof RectSchema>;

export const CameraSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  zoom: z.number().min(0.01).max(8).default(1)
});
export type Camera = z.infer<typeof CameraSchema>;

export function rectOf(node: { position: Vec2; size: Size }): Rect {
  return { x: node.position.x, y: node.position.y, w: node.size.w, h: node.size.h };
}

export function rectRight(r: Rect): number {
  return r.x + r.w;
}

export function rectBottom(r: Rect): number {
  return r.y + r.h;
}

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function rectArea(r: Rect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < rectRight(b) && rectRight(a) > b.x && a.y < rectBottom(b) && rectBottom(a) > b.y;
}

export function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(rectRight(a), rectRight(b)) - Math.max(a.x, b.x);
  const h = Math.min(rectBottom(a), rectBottom(b)) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/**
 * Containment used by the agent frame: a node counts as "inside" the frame when
 * most of its area is inside. Strict containment would make a node fall out of
 * an agent's context the moment a user nudges it a few pixels over the edge.
 */
export function isMostlyInside(inner: Rect, outer: Rect, threshold = 0.6): boolean {
  const area = rectArea(inner);
  if (area <= 0) return false;
  return intersectionArea(inner, outer) / area >= threshold;
}

export function unionRects(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, rectRight(r));
    maxY = Math.max(maxY, rectBottom(r));
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function expandRect(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}
