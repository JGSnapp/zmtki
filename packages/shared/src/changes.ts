import type { Arrow, Artifact } from './artifacts.js';
import type { BoardState } from './boards.js';
import type { Zone } from './zones.js';

/**
 * Entities written or removed by one transaction, for one collection.
 *
 * `index` on an upserted entity is where it sat in the collection. It matters
 * when an undo puts a deleted arrow back: port slots on a shared side are
 * handed out in collection order, so re-appending it at the end would move its
 * attachment point.
 */
export interface EntityChanges<T> {
  upsert: Array<{ entity: T; index: number }>;
  remove: string[];
}

export interface StateChange {
  artifacts: EntityChanges<Artifact>;
  arrows: EntityChanges<Arrow>;
  zones: EntityChanges<Zone>;
}

type Entity = { id: string };

/**
 * A copy of a board state taken before a transaction, deep exactly as far as
 * the operations write in place.
 *
 * Operations replace an artifact's `props` object rather than editing it, but
 * they do edit an arrow's `from`/`to` ports and splice its `bends`. So artifacts
 * are copied one level, arrows one level plus those three, zones one level.
 * Measured against the `structuredClone` of the whole state it replaces, this
 * is a pointer copy per entity instead of a deep copy of every string in every
 * artifact's content.
 */
export interface Captured {
  artifacts: Map<string, { entity: Artifact; index: number }>;
  arrows: Map<string, { entity: Arrow; index: number }>;
  zones: Map<string, { entity: Zone; index: number }>;
}

export const copyArtifact = (a: Artifact): Artifact => ({ ...a });

export const copyArrow = (a: Arrow): Arrow => ({
  ...a,
  from: { ...a.from },
  to: { ...a.to },
  bends: a.bends.slice(),
});

export const copyZone = (z: Zone): Zone => ({ ...z, rects: z.rects.slice() });

const captureList = <T extends Entity>(items: T[], copy: (item: T) => T) => {
  const out = new Map<string, { entity: T; index: number }>();
  items.forEach((item, index) => out.set(item.id, { entity: copy(item), index }));
  return out;
};

export const captureState = (state: BoardState): Captured => ({
  artifacts: captureList(state.artifacts, copyArtifact),
  arrows: captureList(state.arrows, copyArrow),
  zones: captureList(state.zones, copyZone),
});

const shallowDiffers = (a: object, b: object, skip?: Set<string>): boolean => {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const key of Object.keys(ra)) {
    if (skip?.has(key)) continue;
    if (ra[key] !== rb[key]) return true;
  }
  for (const key of Object.keys(rb)) {
    if (skip?.has(key)) continue;
    if (!(key in ra) && rb[key] !== undefined) return true;
  }
  return false;
};

const ARROW_NESTED = new Set(['from', 'to', 'bends']);

const arrowDiffers = (a: Arrow, b: Arrow): boolean =>
  shallowDiffers(a, b, ARROW_NESTED) ||
  shallowDiffers(a.from, b.from) ||
  shallowDiffers(a.to, b.to) ||
  a.bends.length !== b.bends.length ||
  a.bends.some((bend, i) => bend !== b.bends[i]);

const zoneDiffers = (a: Zone, b: Zone): boolean =>
  shallowDiffers(a, b, new Set(['rects'])) ||
  a.rects.length !== b.rects.length ||
  a.rects.some((rect, i) => rect !== b.rects[i]);

const diffList = <T extends Entity>(
  before: Map<string, { entity: T; index: number }>,
  after: T[],
  differs: (a: T, b: T) => boolean,
  copy: (item: T) => T,
): { forward: EntityChanges<T>; inverse: EntityChanges<T> } => {
  const forward: EntityChanges<T> = { upsert: [], remove: [] };
  const inverse: EntityChanges<T> = { upsert: [], remove: [] };
  const seen = new Set<string>();
  after.forEach((entity, index) => {
    seen.add(entity.id);
    const pre = before.get(entity.id);
    if (!pre) {
      forward.upsert.push({ entity: copy(entity), index });
      inverse.remove.push(entity.id);
    } else if (differs(pre.entity, entity)) {
      forward.upsert.push({ entity: copy(entity), index });
      inverse.upsert.push(pre);
    }
  });
  for (const [id, pre] of before) {
    if (seen.has(id)) continue;
    forward.remove.push(id);
    inverse.upsert.push(pre);
  }
  return { forward, inverse };
};

/**
 * What a transaction changed, forwards (to broadcast and to redo) and backwards
 * (to undo). Entities in both are private copies: the live objects keep being
 * written in place by later transactions.
 */
export const diffState = (before: Captured, after: BoardState): { forward: StateChange; inverse: StateChange } => {
  const artifacts = diffList(before.artifacts, after.artifacts, (a, b) => shallowDiffers(a, b), copyArtifact);
  const arrows = diffList(before.arrows, after.arrows, arrowDiffers, copyArrow);
  const zones = diffList(before.zones, after.zones, zoneDiffers, copyZone);
  return {
    forward: { artifacts: artifacts.forward, arrows: arrows.forward, zones: zones.forward },
    inverse: { artifacts: artifacts.inverse, arrows: arrows.inverse, zones: zones.inverse },
  };
};

export const isEmptyChange = (change: StateChange): boolean =>
  change.artifacts.upsert.length === 0 &&
  change.artifacts.remove.length === 0 &&
  change.arrows.upsert.length === 0 &&
  change.arrows.remove.length === 0 &&
  change.zones.upsert.length === 0 &&
  change.zones.remove.length === 0;

/**
 * Applies changes to one collection and returns a new array; entities not
 * mentioned keep their identity, which is what lets the renderer's memoised
 * cards skip everything an agent did not touch.
 */
export const applyEntityChanges = <T extends Entity>(
  items: T[],
  changes: EntityChanges<T>,
  copy: (item: T) => T = (item) => item,
): T[] => {
  if (changes.upsert.length === 0 && changes.remove.length === 0) return items;
  const removed = new Set(changes.remove);
  const replaced = new Map<string, T>();
  const inserted: Array<{ entity: T; index: number }> = [];
  const present = new Set(items.map((item) => item.id));
  for (const change of changes.upsert) {
    if (present.has(change.entity.id)) replaced.set(change.entity.id, copy(change.entity));
    else inserted.push({ entity: copy(change.entity), index: change.index });
  }
  const out: T[] = [];
  for (const item of items) {
    if (removed.has(item.id)) continue;
    out.push(replaced.get(item.id) ?? item);
  }
  inserted.sort((a, b) => a.index - b.index);
  for (const { entity, index } of inserted) {
    out.splice(Math.min(Math.max(0, index), out.length), 0, entity);
  }
  return out;
};

/** A new state with the change applied; untouched entities are shared with `state`. */
export const applyStateChange = (state: BoardState, change: StateChange, copyEntities = false): BoardState => ({
  artifacts: applyEntityChanges(state.artifacts, change.artifacts, copyEntities ? copyArtifact : undefined),
  arrows: applyEntityChanges(state.arrows, change.arrows, copyEntities ? copyArrow : undefined),
  zones: applyEntityChanges(state.zones, change.zones, copyEntities ? copyZone : undefined),
});
