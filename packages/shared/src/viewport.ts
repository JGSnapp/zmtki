import type { Rect } from './artifacts.js';
import { rectsIntersect } from './geometry.js';
import type { Viewport } from './boards.js';

/**
 * What the canvas is allowed to draw for one artifact at the current zoom.
 *
 * The level is chosen from zoom rather than from the artifact's own size
 * because the cost being avoided is text: below roughly a third of full size
 * body copy is a grey smear, so parsing markdown, highlighting code or laying
 * out a kanban board buys the user nothing and costs a full DOM subtree per
 * artifact. Live artifacts ignore the level for their content — a terminal at
 * `dot` still runs — but not for their chrome.
 */
export type DetailLevel = 'full' | 'reduced' | 'placeholder' | 'dot';

/**
 * Zoom at or above which each level applies. Ordered high to low.
 *
 * There is no middle step. A card used to spend the zoom between 0.28 and 0.55
 * as a type name and a caption on a flat fill, which read as the board turning
 * to mud on the way out rather than as a zoom. Below 0.28 the whole board is
 * drawn on one canvas anyway, so the step bought nothing there either.
 */
export const DETAIL_THRESHOLDS: ReadonlyArray<readonly [DetailLevel, number]> = [
  ['full', 0.28],
  ['placeholder', 0.1],
  ['dot', 0],
];

export const detailLevel = (zoom: number): DetailLevel => {
  for (const [level, min] of DETAIL_THRESHOLDS) {
    if (zoom >= min) return level;
  }
  return 'dot';
};

/**
 * World-space rectangle currently on screen, grown by `overscan` screen pixels.
 *
 * Overscan is in screen pixels, not world units, so the band of pre-rendered
 * artifacts stays the same physical width at every zoom: at 4x zoom a world-unit
 * margin would render a strip sixteen times the area for no benefit.
 */
export const worldViewRect = (
  viewport: Viewport,
  screen: { width: number; height: number },
  overscan = 0,
): Rect => {
  const zoom = viewport.zoom || 1;
  const margin = overscan / zoom;
  return {
    x: noNegativeZero(-viewport.x / zoom - margin),
    y: noNegativeZero(-viewport.y / zoom - margin),
    width: screen.width / zoom + margin * 2,
    height: screen.height / zoom + margin * 2,
  };
};

/**
 * Negating an unpanned viewport yields `-0`, which every arithmetic use treats
 * as `0` but `Object.is` does not — so it would survive into persisted board
 * JSON and make a React memo compare a viewport at the origin as changed.
 */
const noNegativeZero = (value: number): number => (value === 0 ? 0 : value);

/**
 * Uniform-grid index over board rectangles.
 *
 * A board is a flat, sparse, mostly-static scatter of boxes, so a grid beats a
 * tree here: queries touch only the cells the viewport covers, and moving one
 * artifact re-buckets one entry instead of rebalancing. The grid is rebuilt
 * from scratch only when artifacts are added or removed.
 *
 * `cellSize` is deliberately close to a typical artifact's size. Much smaller
 * and a single artifact is registered in dozens of cells; much larger and every
 * query degenerates to a full scan of a handful of crowded cells.
 */
export class SpatialIndex<T extends Rect & { id: string }> {
  private readonly cells = new Map<string, T[]>();
  private readonly items = new Map<string, T>();

  constructor(
    items: readonly T[] = [],
    private readonly cellSize = 512,
  ) {
    for (const item of items) this.insert(item);
  }

  private key(cx: number, cy: number): string {
    return `${cx}:${cy}`;
  }

  /** Inclusive cell range covering a rectangle. */
  private range(rect: Rect) {
    return {
      x0: Math.floor(rect.x / this.cellSize),
      y0: Math.floor(rect.y / this.cellSize),
      x1: Math.floor((rect.x + rect.width) / this.cellSize),
      y1: Math.floor((rect.y + rect.height) / this.cellSize),
    };
  }

  insert(item: T): void {
    this.items.set(item.id, item);
    const { x0, y0, x1, y1 } = this.range(item);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const key = this.key(cx, cy);
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(item);
        else this.cells.set(key, [item]);
      }
    }
  }

  remove(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    const { x0, y0, x1, y1 } = this.range(item);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const key = this.key(cx, cy);
        const bucket = this.cells.get(key);
        if (!bucket) continue;
        const next = bucket.filter((entry) => entry.id !== id);
        if (next.length > 0) this.cells.set(key, next);
        else this.cells.delete(key);
      }
    }
  }

  update(item: T): void {
    this.remove(item.id);
    this.insert(item);
  }

  get size(): number {
    return this.items.size;
  }

  /**
   * Every item whose rectangle intersects `rect`.
   *
   * An item straddling a cell border sits in several buckets, so results are
   * de-duplicated by id before the exact intersection test.
   */
  query(rect: Rect): T[] {
    const { x0, y0, x1, y1 } = this.range(rect);
    const seen = new Set<string>();
    const out: T[] = [];
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const bucket = this.cells.get(this.key(cx, cy));
        if (!bucket) continue;
        for (const item of bucket) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          if (rectsIntersect(item, rect)) out.push(item);
        }
      }
    }
    return out;
  }
}
