import {
  ArtifactSpecSchema,
  DEFAULT_ARTIFACT_SIZE,
  type ArtifactKind,
  type ArtifactSpec
} from './artifacts.js';
import { DEFAULT_LAYER_ID } from './board.js';
import { sideToAnchor, type EdgeSide } from './edgeSides.js';
import type { Vec2 } from './geometry.js';
import { newId } from './ids.js';
import {
  ArtifactNodeSchema,
  BoardEdgeSchema,
  DEFAULT_STYLE,
  FrameNodeSchema,
  GroupNodeSchema,
  ShapeKindSchema,
  ShapeNodeSchema,
  StickyNodeSchema,
  StickerNodeSchema,
  StyleSchema,
  TextNodeSchema,
  type ArtifactNode,
  type BoardEdge,
  type BoardNode,
  type FrameNode,
  type GroupNode,
  type ShapeKind,
  type ShapeNode,
  type StickyNode,
  type StickerNode,
  type Style,
  type TextNode
} from './nodes.js';

export interface CreateArtifactNodeInput {
  artifact: ArtifactSpec;
  position: Vec2;
  size?: { w: number; h: number };
  layerId?: string;
  createdBy?: string | null;
  owner?: { kind: 'human' | 'agent'; id: string } | null;
  lock?: { delete?: boolean; move?: boolean; edit?: boolean };
  parentId?: string | null;
  z?: number;
}

export function createArtifactNode(input: CreateArtifactNodeInput): ArtifactNode {
  const now = Date.now();
  const artifact = ArtifactSpecSchema.parse(input.artifact);
  const size = input.size ?? DEFAULT_ARTIFACT_SIZE[artifact.kind as ArtifactKind];
  const createdBy = input.createdBy ?? null;
  const owner =
    input.owner !== undefined
      ? input.owner
      : createdBy
        ? { kind: 'agent' as const, id: createdBy }
        : { kind: 'human' as const, id: 'human' };
  const isHuman = !createdBy || owner?.kind === 'human';
  return ArtifactNodeSchema.parse({
    id: newId('node'),
    type: 'artifact',
    artifact,
    position: input.position,
    size,
    rotation: 0,
    layerId: input.layerId ?? DEFAULT_LAYER_ID,
    z: input.z ?? 0,
    locked: false,
    hidden: false,
    parentId: input.parentId ?? null,
    visualState: 'expanded',
    layout: { mode: 'free' },
    owner,
    lock: {
      delete: input.lock?.delete ?? isHuman,
      move: input.lock?.move ?? isHuman,
      edit: input.lock?.edit ?? false
    },
    createdBy,
    createdAt: now,
    updatedAt: now,
    rev: 0,
    meta: {}
  });
}

export interface CreateFrameInput {
  label: string;
  position: Vec2;
  size: { w: number; h: number };
  agentId?: string | null;
  layerId?: string;
  style?: Partial<Style>;
}

export function createFrameNode(input: CreateFrameInput): FrameNode {
  const now = Date.now();
  return FrameNodeSchema.parse({
    id: newId('node'),
    type: 'frame',
    label: input.label,
    agentId: input.agentId ?? null,
    position: input.position,
    size: input.size,
    rotation: 0,
    layerId: input.layerId ?? DEFAULT_LAYER_ID,
    z: -1000,
    locked: false,
    hidden: false,
    parentId: null,
    visualState: 'expanded',
    layout: { mode: 'column', gap: 24 },
    owner: input.agentId ? { kind: 'agent', id: input.agentId } : { kind: 'human', id: 'human' },
    lock: { delete: false, move: false, edit: false },
    createdBy: input.agentId ?? null,
    createdAt: now,
    updatedAt: now,
    rev: 0,
    meta: {},
    style: StyleSchema.parse({ ...DEFAULT_STYLE, ...input.style }),
    autoGrow: true
  });
}

export interface CreateGroupInput {
  label: string;
  position: Vec2;
  size: { w: number; h: number };
  accent?: string;
  layerId?: string;
  createdBy?: string | null;
  style?: Partial<Style>;
}

export function createGroupNode(input: CreateGroupInput): GroupNode {
  const now = Date.now();
  const createdBy = input.createdBy ?? null;
  return GroupNodeSchema.parse({
    id: newId('node'),
    type: 'group',
    label: input.label,
    accent: input.accent ?? '#6ea8fe',
    position: input.position,
    size: input.size,
    rotation: 0,
    layerId: input.layerId ?? DEFAULT_LAYER_ID,
    z: -100,
    locked: false,
    hidden: false,
    parentId: null,
    visualState: 'expanded',
    // Groups are visual wrappers: keep free layout so creating a group never
    // restacks members into a column/row. Call board_arrange explicitly to pack.
    layout: { mode: 'free', gap: 16 },
    owner: createdBy ? { kind: 'agent', id: createdBy } : { kind: 'human', id: 'human' },
    lock: {
      delete: !createdBy,
      move: !createdBy,
      edit: false
    },
    createdBy,
    createdAt: now,
    updatedAt: now,
    rev: 0,
    meta: {},
    style: StyleSchema.parse({
      ...DEFAULT_STYLE,
      fill: 'rgba(110,168,254,0.08)',
      stroke: input.accent ?? '#6ea8fe',
      ...input.style
    })
  });
}

export interface CreateStickerInput {
  packId: string;
  stickerId: string;
  src: string;
  position: Vec2;
  size?: { w: number; h: number };
  emoji?: string;
  layerId?: string;
  createdBy?: string | null;
}

export function createStickerNode(input: CreateStickerInput): StickerNode {
  const now = Date.now();
  const createdBy = input.createdBy ?? null;
  return StickerNodeSchema.parse({
    id: newId('node'),
    type: 'sticker',
    packId: input.packId,
    stickerId: input.stickerId,
    src: input.src,
    emoji: input.emoji,
    position: input.position,
    size: input.size ?? { w: 128, h: 128 },
    rotation: 0,
    layerId: input.layerId ?? DEFAULT_LAYER_ID,
    z: 10,
    locked: false,
    hidden: false,
    parentId: null,
    visualState: 'expanded',
    layout: { mode: 'free' },
    owner: createdBy ? { kind: 'agent', id: createdBy } : { kind: 'human', id: 'human' },
    lock: {
      delete: !createdBy,
      move: !createdBy,
      edit: false
    },
    createdBy,
    createdAt: now,
    updatedAt: now,
    rev: 0,
    meta: {}
  });
}

export interface CreateShapeInput {
  shape: ShapeKind;
  text?: string;
  position: Vec2;
  size?: { w: number; h: number };
  layerId?: string;
  createdBy?: string | null;
  parentId?: string | null;
  style?: Partial<Style>;
}

export function createShapeNode(input: CreateShapeInput): ShapeNode {
  const now = Date.now();
  const createdBy = input.createdBy ?? null;
  const shape = ShapeKindSchema.parse(input.shape);
  return ShapeNodeSchema.parse({
    id: newId('node'),
    type: 'shape',
    shape,
    text: input.text ?? '',
    position: input.position,
    size: input.size ?? { w: 160, h: 100 },
    rotation: 0,
    layerId: input.layerId ?? DEFAULT_LAYER_ID,
    z: 0,
    locked: false,
    hidden: false,
    parentId: input.parentId ?? null,
    visualState: 'expanded',
    layout: { mode: 'free' },
    owner: createdBy ? { kind: 'agent', id: createdBy } : { kind: 'human', id: 'human' },
    lock: { delete: !createdBy, move: !createdBy, edit: false },
    createdBy,
    createdAt: now,
    updatedAt: now,
    rev: 0,
    meta: {},
    style: StyleSchema.parse({ ...DEFAULT_STYLE, ...input.style })
  });
}

export interface CreateTextInput {
  text: string;
  position: Vec2;
  size?: { w: number; h: number };
  layerId?: string;
  createdBy?: string | null;
  parentId?: string | null;
  style?: Partial<Style>;
}

export function createTextNode(input: CreateTextInput): TextNode {
  const now = Date.now();
  const createdBy = input.createdBy ?? null;
  return TextNodeSchema.parse({
    id: newId('node'),
    type: 'text',
    text: input.text,
    position: input.position,
    size: input.size ?? { w: 240, h: 48 },
    rotation: 0,
    layerId: input.layerId ?? DEFAULT_LAYER_ID,
    z: 0,
    locked: false,
    hidden: false,
    parentId: input.parentId ?? null,
    visualState: 'expanded',
    layout: { mode: 'free' },
    owner: createdBy ? { kind: 'agent', id: createdBy } : { kind: 'human', id: 'human' },
    lock: { delete: !createdBy, move: !createdBy, edit: false },
    createdBy,
    createdAt: now,
    updatedAt: now,
    rev: 0,
    meta: {},
    style: StyleSchema.parse({ ...DEFAULT_STYLE, fontSize: 18, ...input.style })
  });
}

export interface CreateStickyInput {
  text: string;
  position: Vec2;
  size?: { w: number; h: number };
  layerId?: string;
  createdBy?: string | null;
  parentId?: string | null;
  style?: Partial<Style>;
}

export function createStickyNode(input: CreateStickyInput): StickyNode {
  const now = Date.now();
  const createdBy = input.createdBy ?? null;
  return StickyNodeSchema.parse({
    id: newId('node'),
    type: 'sticky',
    text: input.text,
    position: input.position,
    size: input.size ?? { w: 180, h: 140 },
    rotation: 0,
    layerId: input.layerId ?? DEFAULT_LAYER_ID,
    z: 0,
    locked: false,
    hidden: false,
    parentId: input.parentId ?? null,
    visualState: 'expanded',
    layout: { mode: 'free' },
    owner: createdBy ? { kind: 'agent', id: createdBy } : { kind: 'human', id: 'human' },
    lock: { delete: !createdBy, move: !createdBy, edit: false },
    createdBy,
    createdAt: now,
    updatedAt: now,
    rev: 0,
    meta: {},
    style: StyleSchema.parse({
      ...DEFAULT_STYLE,
      fill: '#f5d97a',
      color: '#1b1d24',
      ...input.style
    })
  });
}

export function createEdge(
  from: string,
  to: string,
  opts: {
    label?: string;
    layerId?: string;
    createdBy?: string | null;
    /** Fixed attach side; omit / null = auto nearest at render time. */
    fromSide?: EdgeSide | null;
    toSide?: EdgeSide | null;
  } = {}
): BoardEdge {
  return BoardEdgeSchema.parse({
    id: newId('edge'),
    from: {
      nodeId: from,
      point: null,
      anchor: opts.fromSide ? sideToAnchor(opts.fromSide) : null
    },
    to: {
      nodeId: to,
      point: null,
      anchor: opts.toSide ? sideToAnchor(opts.toSide) : null
    },
    label: opts.label ?? '',
    style: DEFAULT_STYLE,
    startArrow: 'none',
    endArrow: 'arrow',
    routing: 'bezier',
    layerId: opts.layerId ?? DEFAULT_LAYER_ID,
    createdBy: opts.createdBy ?? null,
    meta: {}
  });
}

/**
 * Places a new node inside a frame without overlapping what is already there.
 * Agents create artifacts constantly and should not have to do layout maths,
 * so the store lays them out in reading order and grows the frame when needed.
 */
export function findFreeSlot(
  frame: { position: Vec2; size: { w: number; h: number } },
  occupied: readonly { position: Vec2; size: { w: number; h: number } }[],
  size: { w: number; h: number },
  gap = 24
): Vec2 {
  const startX = frame.position.x + gap;
  // Leave room for the floating agent name badge on the top edge of the frame.
  const startY = frame.position.y + gap + 48;
  const maxX = frame.position.x + frame.size.w - gap;

  let x = startX;
  let y = startY;
  let rowHeight = 0;

  const collides = (cx: number, cy: number): boolean =>
    occupied.some(
      (o) =>
        cx < o.position.x + o.size.w + gap &&
        cx + size.w + gap > o.position.x &&
        cy < o.position.y + o.size.h + gap &&
        cy + size.h + gap > o.position.y
    );

  for (let guard = 0; guard < 2000; guard += 1) {
    if (x + size.w > maxX && x > startX) {
      x = startX;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    if (!collides(x, y)) return { x, y };
    x += 64;
    rowHeight = Math.max(rowHeight, size.h);
  }
  return { x: startX, y: startY };
}

export function boundsOf(nodes: readonly BoardNode[]) {
  if (nodes.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + n.size.w);
    maxY = Math.max(maxY, n.position.y + n.size.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
