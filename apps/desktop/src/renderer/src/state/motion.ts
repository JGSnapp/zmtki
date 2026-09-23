import type { Artifact, Rect } from '@zmtki/shared';
import { rectsIntersect } from '@zmtki/shared';

/**
 * How long each kind of motion takes. Exits are the slowest on purpose: a card
 * an agent deleted should be seen going, not just be missing on the next glance.
 */
export const MOTION = {
  enterMs: 340,
  exitMs: 480,
  teleportOutMs: 260,
  teleportInDelayMs: 140,
  slideMinMs: 260,
  slideMaxMs: 620,
  settleMs: 160,
} as const;

export type GhostKind = 'exit' | 'teleport';

/** A card that is no longer where it is drawn: removed, or moved far away. */
export interface Ghost {
  key: string;
  artifact: Artifact;
  kind: GhostKind;
  until: number;
}

export interface ViewInfo {
  /** World rectangle on screen. */
  rect: Rect;
  zoom: number;
  screen: { width: number; height: number };
  /** Whether the camera is being moved right now. */
  moving?: boolean;
}

interface Tween {
  from: Rect;
  to: Rect;
  start: number;
  duration: number;
  ease: (t: number) => number;
}

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  width: a.width + (b.width - a.width) * t,
  height: a.height + (b.height - a.height) * t,
});

const sameRect = (a: Rect, b: Rect): boolean =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

/** Motion is only for someone watching: a hidden window, or a change off screen, applies at once. */
export const isWatching = (view: ViewInfo | null, ...rects: Rect[]): boolean => {
  if (!view || document.visibilityState !== 'visible') return false;
  return rects.some((rect) => rectsIntersect(rect, view.rect));
};

export type MovePlan = 'none' | 'slide' | 'teleport';

/**
 * Whether a geometry change reads as a move the eye can follow.
 *
 * A slide is kept to what fits comfortably on screen: a card crossing most of
 * the monitor in half a second is a streak, not motion, and one travelling to
 * somewhere off screen would slide out of view and be lost. Those fade out
 * where they were and fade in where they went instead.
 */
export const planMove = (view: ViewInfo | null, from: Rect, to: Rect): MovePlan => {
  if (sameRect(from, to)) return 'none';
  const fromSeen = isWatching(view, from);
  const toSeen = isWatching(view, to);
  if (!fromSeen && !toSeen) return 'none';
  if (!view || !fromSeen || !toSeen) return 'teleport';
  const dx = (to.x + to.width / 2 - (from.x + from.width / 2)) * view.zoom;
  const dy = (to.y + to.height / 2 - (from.y + from.height / 2)) * view.zoom;
  const limit = Math.max(view.screen.width, view.screen.height) * 0.6;
  return Math.hypot(dx, dy) <= limit ? 'slide' : 'teleport';
};

/**
 * Per-frame geometry tweens for cards that slide.
 *
 * Output is a map of rect overrides published once per frame; the canvas reads
 * it like a drag draft, so arrows attached to a sliding card are re-routed every
 * frame and travel with it. Only sliding cards are in the map, so a frame costs
 * the arrows of those cards, not of the board.
 */
export class Motion {
  private readonly tweens = new Map<string, Tween>();
  private frame: number | null = null;
  private current: Record<string, Rect> = {};

  constructor(private readonly publish: (overrides: Record<string, Rect>) => void) {}

  /** Where a card is drawn right now, if it is mid-slide. */
  rectOf(id: string): Rect | undefined {
    return this.current[id];
  }

  /**
   * `settle` is the user's own drop landing on the grid: it starts exactly at
   * the released position and is short and decelerating. A long ease-in-out
   * there read as the card drifting away after the hand let go.
   */
  slide(id: string, from: Rect, to: Rect, view: ViewInfo | null, settle = false): void {
    const start = settle ? from : (this.current[id] ?? from);
    const distance = view
      ? Math.hypot((to.x - start.x) * view.zoom, (to.y - start.y) * view.zoom) +
        Math.abs(to.width - start.width) * view.zoom
      : 0;
    const duration = settle
      ? MOTION.settleMs
      : Math.min(MOTION.slideMaxMs, Math.max(MOTION.slideMinMs, 220 + distance * 0.45));
    this.tweens.set(id, { from: start, to, start: performance.now(), duration, ease: settle ? easeOutCubic : easeInOutCubic });
    this.current[id] = start;
    this.request();
  }

  cancel(id: string): void {
    if (!this.tweens.delete(id)) return;
    const { [id]: _dropped, ...rest } = this.current;
    this.current = rest;
    this.publish(this.current);
  }

  private request(): void {
    if (this.frame === null) this.frame = requestAnimationFrame((now) => this.tick(now));
  }

  private tick(now: number): void {
    this.frame = null;
    const next: Record<string, Rect> = {};
    for (const [id, tween] of this.tweens) {
      const t = Math.min(1, (now - tween.start) / tween.duration);
      if (t >= 1) {
        this.tweens.delete(id);
        continue;
      }
      next[id] = lerpRect(tween.from, tween.to, tween.ease(t));
    }
    this.current = next;
    this.publish(next);
    if (this.tweens.size > 0) this.request();
  }
}
