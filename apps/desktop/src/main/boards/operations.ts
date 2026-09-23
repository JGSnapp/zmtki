import type {
  AnchorSide,
  Arrow,
  ArrowRouting,
  ArrowStyle,
  Artifact,
  ArtifactProps,
  ArtifactType,
  BoardState,
  Rect,
  Vec2,
  Zone,
} from '@zmtki/shared';
import { addRect, isRouted, normalizeRects, rectsIntersect, subtractFromRects } from '@zmtki/shared';
import { badRequest, notFound } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { blueprintFor } from './artifact.defaults.js';

export interface CreateArtifactInput {
  type: ArtifactType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  props?: ArtifactProps;
  /** Marks the overlap with neighbours as deliberate. */
  allowOverlap?: boolean;
}

export interface UpdateArtifactInput {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  props?: ArtifactProps;
  /** Marks the overlap with neighbours as deliberate. */
  allowOverlap?: boolean;
  /** Replace props entirely instead of merging. */
  replaceProps?: boolean;
}

export interface CreateArrowInput {
  fromId: string;
  toId: string;
  fromSide?: AnchorSide;
  toSide?: AnchorSide;
  /** Port position along the side, 0..1. Omit to let the board distribute it. */
  fromOffset?: number | null;
  toOffset?: number | null;
  bends?: Vec2[];
  routing?: ArrowRouting;
  label?: string;
  style?: ArrowStyle;
}

const normalizeOffset = (value: number | null | undefined): number | undefined => {
  if (value == null) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
};

const MIN_SIZE = 24;

const findArtifact = (state: BoardState, id: string): Artifact => {
  const artifact = state.artifacts.find((a) => a.id === id);
  if (!artifact) throw notFound(`Artifact ${id}`);
  return artifact;
};

const findArrow = (state: BoardState, id: string): Arrow => {
  const arrow = state.arrows.find((a) => a.id === id);
  if (!arrow) throw notFound(`Arrow ${id}`);
  return arrow;
};

export const createArtifact = (state: BoardState, input: CreateArtifactInput): Artifact => {
  const blueprint = blueprintFor(input.type);
  const now = Date.now();
  const artifact: Artifact = {
    id: newId('art'),
    type: input.type,
    x: Math.round(input.x),
    y: Math.round(input.y),
    width: Math.max(MIN_SIZE, Math.round(input.width ?? blueprint.width)),
    height: Math.max(MIN_SIZE, Math.round(input.height ?? blueprint.height)),
    z: state.artifacts.reduce((max, a) => Math.max(max, a.z), 0) + 1,
    rotation: input.rotation ?? 0,
    props: { ...blueprint.props, ...(input.props ?? {}) },
    ...(input.allowOverlap ? { allowOverlap: true } : {}),
    createdAt: now,
    updatedAt: now,
  };
  state.artifacts.push(artifact);
  return artifact;
};

export interface UpdateArtifactResult {
  artifact: Artifact;
  /** Auto-routed arrows whose polyline was invalidated by the move. */
  arrowsReset: number;
}

/**
 * Auto-routed bends are absolute world coordinates built for one particular
 * arrangement, so moving or resizing a node turns them into garbage that would
 * render as a detour across the board. Ports chosen by the router go with them:
 * a pinned port skips the distribution pass, so a stale one keeps two arrows
 * entering the same node on crossing lines forever. Bends and ports placed by
 * hand are left alone — the router owns its routes, everyone else owns theirs.
 */
const dropRoutedBends = (state: BoardState, artifactId: string): number => {
  let reset = 0;
  for (const arrow of state.arrows) {
    const touches =
      arrow.from.artifactId === artifactId || arrow.to.artifactId === artifactId;
    if (!touches) continue;
    const hadRoute = isRouted(arrow.routing) && arrow.bends.length > 0;
    if (!hadRoute && !arrow.autoPorts) continue;
    if (hadRoute) arrow.bends = [];
    if (arrow.autoPorts) {
      arrow.from.offset = undefined;
      arrow.to.offset = undefined;
      arrow.autoPorts = undefined;
    }
    arrow.updatedAt = Date.now();
    reset++;
  }
  return reset;
};

export const updateArtifact = (
  state: BoardState,
  id: string,
  patch: UpdateArtifactInput,
): UpdateArtifactResult => {
  const artifact = findArtifact(state, id);
  const moved =
    (patch.x != null && Math.round(patch.x) !== artifact.x) ||
    (patch.y != null && Math.round(patch.y) !== artifact.y) ||
    (patch.width != null && Math.round(patch.width) !== artifact.width) ||
    (patch.height != null && Math.round(patch.height) !== artifact.height);

  if (patch.x != null) artifact.x = Math.round(patch.x);
  if (patch.y != null) artifact.y = Math.round(patch.y);
  if (patch.width != null) artifact.width = Math.max(MIN_SIZE, Math.round(patch.width));
  if (patch.height != null) artifact.height = Math.max(MIN_SIZE, Math.round(patch.height));
  if (patch.rotation != null) artifact.rotation = patch.rotation;
  if (patch.allowOverlap != null) artifact.allowOverlap = patch.allowOverlap || undefined;
  if (patch.props) {
    artifact.props = patch.replaceProps ? { ...patch.props } : { ...artifact.props, ...patch.props };
  }
  artifact.updatedAt = Date.now();
  return { artifact, arrowsReset: moved ? dropRoutedBends(state, id) : 0 };
};

export const bringToFront = (state: BoardState, id: string): Artifact => {
  const artifact = findArtifact(state, id);
  artifact.z = state.artifacts.reduce((max, a) => Math.max(max, a.z), 0) + 1;
  return artifact;
};

export const deleteArtifact = (state: BoardState, id: string): { arrowsRemoved: number } => {
  const index = state.artifacts.findIndex((a) => a.id === id);
  if (index < 0) throw notFound(`Artifact ${id}`);
  state.artifacts.splice(index, 1);
  const before = state.arrows.length;
  state.arrows = state.arrows.filter(
    (arrow) => arrow.from.artifactId !== id && arrow.to.artifactId !== id,
  );
  return { arrowsRemoved: before - state.arrows.length };
};

export const createArrow = (state: BoardState, input: CreateArrowInput): Arrow => {
  findArtifact(state, input.fromId);
  findArtifact(state, input.toId);
  if (input.fromId === input.toId) throw badRequest('Arrow endpoints must differ');
  const now = Date.now();
  const arrow: Arrow = {
    id: newId('arr'),
    from: {
      artifactId: input.fromId,
      side: input.fromSide ?? 'auto',
      offset: normalizeOffset(input.fromOffset),
    },
    to: {
      artifactId: input.toId,
      side: input.toSide ?? 'auto',
      offset: normalizeOffset(input.toOffset),
    },
    bends: (input.bends ?? []).map((b) => ({ x: Math.round(b.x), y: Math.round(b.y) })),
    routing: input.routing,
    label: input.label,
    style: input.style ?? {},
    createdAt: now,
    updatedAt: now,
  };
  state.arrows.push(arrow);
  return arrow;
};

export interface UpdateArrowInput {
  /**
   * Re-hangs an end on another artifact. Ours, not teca's: there an arrow is
   * drawn by an agent and re-hung by deleting it, but on a board a person can
   * grab the end of a line and pull it onto another block, and that must not
   * mean losing the line's identity.
   */
  fromId?: string;
  toId?: string;
  fromSide?: AnchorSide;
  toSide?: AnchorSide;
  /** 0..1 pins the port; null hands it back to automatic distribution. */
  fromOffset?: number | null;
  toOffset?: number | null;
  label?: string;
  style?: ArrowStyle;
  bends?: Vec2[];
  routing?: ArrowRouting;
}

export const updateArrow = (state: BoardState, id: string, patch: UpdateArrowInput): Arrow => {
  const arrow = findArrow(state, id);
  if (patch.fromId != null || patch.toId != null) {
    const fromId = patch.fromId ?? arrow.from.artifactId;
    const toId = patch.toId ?? arrow.to.artifactId;
    findArtifact(state, fromId);
    findArtifact(state, toId);
    if (fromId === toId) throw badRequest('Arrow endpoints must differ');
    arrow.from.artifactId = fromId;
    arrow.to.artifactId = toId;
  }
  const portsMoved =
    (patch.fromSide != null && patch.fromSide !== arrow.from.side) ||
    (patch.toSide != null && patch.toSide !== arrow.to.side) ||
    (patch.fromOffset !== undefined && patch.fromOffset !== (arrow.from.offset ?? null)) ||
    (patch.toOffset !== undefined && patch.toOffset !== (arrow.to.offset ?? null));

  if (patch.fromSide) arrow.from.side = patch.fromSide;
  if (patch.toSide) arrow.to.side = patch.toSide;
  if (patch.fromOffset !== undefined) arrow.from.offset = normalizeOffset(patch.fromOffset);
  if (patch.toOffset !== undefined) arrow.to.offset = normalizeOffset(patch.toOffset);
  if (patch.label != null) arrow.label = patch.label;
  if (patch.style) arrow.style = { ...arrow.style, ...patch.style };
  if (patch.bends) {
    arrow.bends = patch.bends.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y) }));
  } else if (portsMoved && isRouted(arrow.routing) && arrow.bends.length > 0) {
    // Ports moved, stored bends are now in the wrong place and would draw as whiskers.
    arrow.bends = [];
  }
  if (patch.routing) arrow.routing = patch.routing;
  arrow.updatedAt = Date.now();
  return arrow;
};

export interface RouteApplication {
  bends: Vec2[];
  fromSide: AnchorSide;
  toSide: AnchorSide;
  fromOffset: number;
  toOffset: number;
}

/**
 * Writes an auto-routed polyline. The ports get pinned as well: bends are
 * absolute coordinates, so an endpoint that is still free to move — an `auto`
 * side, or an offset the board redistributes — would silently invalidate the
 * route the next time the arrow is drawn.
 */
export const applyRoute = (state: BoardState, id: string, route: RouteApplication): Arrow => {
  const arrow = findArrow(state, id);
  arrow.bends = route.bends.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y) }));
  arrow.from.side = route.fromSide;
  arrow.to.side = route.toSide;
  arrow.from.offset = normalizeOffset(route.fromOffset);
  arrow.to.offset = normalizeOffset(route.toOffset);
  arrow.autoPorts = true;
  // Curved is the same route drawn round, so re-routing must not straighten the
  // corners of an arrow somebody asked to be curved.
  if (arrow.routing !== 'curved') arrow.routing = 'orthogonal';
  arrow.updatedAt = Date.now();
  return arrow;
};

export const addBend = (state: BoardState, id: string, point: Vec2, index?: number): Arrow => {
  const arrow = findArrow(state, id);
  const at = index == null ? arrow.bends.length : Math.max(0, Math.min(index, arrow.bends.length));
  arrow.bends.splice(at, 0, { x: Math.round(point.x), y: Math.round(point.y) });
  arrow.updatedAt = Date.now();
  return arrow;
};

export const moveBend = (state: BoardState, id: string, index: number, point: Vec2): Arrow => {
  const arrow = findArrow(state, id);
  if (index < 0 || index >= arrow.bends.length) {
    throw badRequest(`Bend index ${index} out of range (0..${arrow.bends.length - 1})`);
  }
  arrow.bends[index] = { x: Math.round(point.x), y: Math.round(point.y) };
  arrow.updatedAt = Date.now();
  return arrow;
};

export const removeBend = (state: BoardState, id: string, index: number): Arrow => {
  const arrow = findArrow(state, id);
  if (index < 0 || index >= arrow.bends.length) {
    throw badRequest(`Bend index ${index} out of range`);
  }
  arrow.bends.splice(index, 1);
  arrow.updatedAt = Date.now();
  return arrow;
};

export const deleteArrow = (state: BoardState, id: string): void => {
  const index = state.arrows.findIndex((a) => a.id === id);
  if (index < 0) throw notFound(`Arrow ${id}`);
  state.arrows.splice(index, 1);
};

export interface RegionQuery extends Rect {}

export interface RegionResult {
  region: Rect;
  artifacts: Artifact[];
  arrows: Arrow[];
  totalArtifacts: number;
}

/** Artifacts overlapping the region plus every arrow touching one of them. */
export const queryRegion = (state: BoardState, region: RegionQuery): RegionResult => {
  const artifacts = state.artifacts
    .filter((a) => rectsIntersect(a, region))
    .sort((a, b) => a.z - b.z);
  const ids = new Set(artifacts.map((a) => a.id));
  const arrows = state.arrows.filter(
    (arrow) => ids.has(arrow.from.artifactId) || ids.has(arrow.to.artifactId),
  );
  return { region, artifacts, arrows, totalArtifacts: state.artifacts.length };
};

// --- Zones -------------------------------------------------------------------

export interface CreateZoneInput {
  title: string;
  color?: string;
  rects: Rect[];
  pending?: boolean;
  ownerId?: string;
  locked?: boolean;
  reason?: string;
  extendsZoneId?: string;
}

export interface UpdateZoneInput {
  title?: string;
  color?: string;
  rects?: Rect[];
  pending?: boolean;
  locked?: boolean;
}

const findZone = (state: BoardState, id: string): Zone => {
  const zone = state.zones.find((z) => z.id === id);
  if (!zone) throw notFound('Zone ' + id);
  return zone;
};

const roundRect = (r: Rect): Rect => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  width: Math.max(1, Math.round(r.width)),
  height: Math.max(1, Math.round(r.height)),
});

export const createZone = (state: BoardState, input: CreateZoneInput): Zone => {
  if (input.rects.length === 0) throw badRequest('Zone needs at least one rectangle');
  const now = Date.now();
  const zone: Zone = {
    id: newId('zon'),
    title: input.title,
    color: input.color ?? '#6b8cff',
    rects: input.rects.map(roundRect),
    ...(input.pending ? { pending: true } : {}),
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(input.locked ? { locked: true } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.extendsZoneId ? { extendsZoneId: input.extendsZoneId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  state.zones.push(zone);
  return zone;
};

/**
 * Accepts a pending zone. A request to grow an existing zone merges into it and
 * disappears; a plain request simply stops being pending.
 */
export const acceptZone = (state: BoardState, id: string): Zone => {
  const zone = findZone(state, id);
  const target = zone.extendsZoneId ? state.zones.find((z) => z.id === zone.extendsZoneId) : undefined;
  const now = Date.now();
  if (target) {
    target.rects = addRect(target.rects, zone.rects[0] ?? { x: 0, y: 0, width: 0, height: 0 });
    for (const rect of zone.rects.slice(1)) target.rects = addRect(target.rects, rect);
    target.updatedAt = now;
    state.zones = state.zones.filter((z) => z.id !== id);
    return target;
  }
  zone.pending = undefined;
  zone.extendsZoneId = undefined;
  zone.rects = normalizeRects(zone.rects);
  zone.updatedAt = now;
  return zone;
};

/** Cuts a rectangle out of a zone; a zone left with nothing is removed. */
export const carveZone = (state: BoardState, id: string, cut: Rect): Zone | null => {
  const zone = findZone(state, id);
  zone.rects = normalizeRects(subtractFromRects(zone.rects, roundRect(cut)));
  zone.updatedAt = Date.now();
  if (zone.rects.length > 0) return zone;
  state.zones = state.zones.filter((z) => z.id !== id);
  return null;
};

/** Adds a swept rectangle to a zone. */
export const growZone = (state: BoardState, id: string, added: Rect): Zone => {
  const zone = findZone(state, id);
  zone.rects = addRect(zone.rects, roundRect(added));
  zone.updatedAt = Date.now();
  return zone;
};

export const updateZone = (state: BoardState, id: string, patch: UpdateZoneInput): Zone => {
  const zone = findZone(state, id);
  if (patch.title != null) zone.title = patch.title;
  if (patch.color != null) zone.color = patch.color;
  if (patch.rects) zone.rects = patch.rects.map(roundRect);
  if (patch.pending != null) zone.pending = patch.pending || undefined;
  if (patch.locked != null) zone.locked = patch.locked || undefined;
  zone.updatedAt = Date.now();
  return zone;
};

export const deleteZone = (state: BoardState, id: string): void => {
  const index = state.zones.findIndex((z) => z.id === id);
  if (index < 0) throw notFound('Zone ' + id);
  state.zones.splice(index, 1);
};
