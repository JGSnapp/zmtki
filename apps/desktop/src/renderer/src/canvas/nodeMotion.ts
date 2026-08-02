/** Distance (board px) above which a move becomes fade-out / fade-in teleport. */
export const TELEPORT_DISTANCE = 380;
export const EXIT_MS = 340;
export const TELEPORT_OUT_MS = 200;
export const ENTER_MS = 420;
export const TELEPORT_IN_MS = 380;

export type MotionClass = 'rf-enter' | 'rf-exit' | 'rf-teleport-out' | 'rf-teleport-in';

export function motionDistance(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function joinClassNames(...parts: Array<string | undefined | false | null>): string | undefined {
  const out = parts.filter(Boolean).join(' ').trim();
  return out.length > 0 ? out : undefined;
}
