import { z } from 'zod';
import { ArtifactSpecSchema } from './artifacts.js';
import { SizeSchema, Vec2Schema } from './geometry.js';

export const StrokeStyleSchema = z.enum(['solid', 'dashed', 'dotted']);
export type StrokeStyle = z.infer<typeof StrokeStyleSchema>;

export const VisualStateSchema = z.enum(['expanded', 'widget', 'icon', 'ghost']);
export type VisualState = z.infer<typeof VisualStateSchema>;

export const LayoutModeSchema = z.enum(['free', 'stack', 'row', 'column', 'grid']);
export type LayoutMode = z.infer<typeof LayoutModeSchema>;

export const NodeLayoutSchema = z.object({
  mode: LayoutModeSchema.default('free'),
  slot: z.string().optional(),
  order: z.number().optional(),
  gap: z.number().optional()
});
export type NodeLayout = z.infer<typeof NodeLayoutSchema>;

export const NodeOwnerSchema = z
  .object({
    kind: z.enum(['human', 'agent']),
    id: z.string()
  })
  .nullable()
  .default(null);
export type NodeOwner = z.infer<typeof NodeOwnerSchema>;

export const NodeLockSchema = z.object({
  /** Agents may not delete without approval / unlock. */
  delete: z.boolean().default(false),
  /** Agents may not move/resize without approval / unlock. */
  move: z.boolean().default(false),
  /** Agents may not edit content without approval / unlock. */
  edit: z.boolean().default(false),
  /** Soft exclusive edit lock held by an agent id. */
  heldBy: z.string().optional(),
  heldUntil: z.number().optional()
});
export type NodeLock = z.infer<typeof NodeLockSchema>;

export const StyleSchema = z.object({
  stroke: z.string().default('#3b4256'),
  strokeWidth: z.number().min(0).max(64).default(2),
  strokeStyle: StrokeStyleSchema.default('solid'),
  fill: z.string().default('transparent'),
  opacity: z.number().min(0).max(1).default(1),
  color: z.string().default('#e6e8ee'),
  fontSize: z.number().min(6).max(200).default(14),
  fontWeight: z.number().min(100).max(900).default(400),
  align: z.enum(['left', 'center', 'right']).default('left'),
  radius: z.number().min(0).default(8)
});
export type Style = z.infer<typeof StyleSchema>;

export const DEFAULT_STYLE: Style = StyleSchema.parse({});

const nodeBase = {
  id: z.string(),
  position: Vec2Schema,
  size: SizeSchema,
  rotation: z.number().default(0),
  layerId: z.string(),
  /** Ordering within a layer. Ties break by id so the render order is stable. */
  z: z.number().default(0),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  /** Set when a node belongs to a group or layout container. */
  parentId: z.string().nullable().default(null),
  visualState: VisualStateSchema.default('expanded'),
  layout: NodeLayoutSchema.default({ mode: 'free' }),
  owner: NodeOwnerSchema,
  lock: NodeLockSchema.default({ delete: false, move: false, edit: false }),
  /** Agent that produced this node, if any. Drives provenance colouring. */
  createdBy: z.string().nullable().default(null),
  createdAt: z.number().int().default(0),
  updatedAt: z.number().int().default(0),
  /** Monotonic revision, bumped on every content change. */
  rev: z.number().int().nonnegative().default(0),
  meta: z.record(z.unknown()).default({})
};

export const ArtifactNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('artifact'),
  artifact: ArtifactSpecSchema
});
export type ArtifactNode = z.infer<typeof ArtifactNodeSchema>;

export const ShapeKindSchema = z.enum([
  'rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'star',
  'arrowBlock'
]);
export type ShapeKind = z.infer<typeof ShapeKindSchema>;

export const ShapeNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('shape'),
  shape: ShapeKindSchema,
  text: z.string().default(''),
  style: StyleSchema
});
export type ShapeNode = z.infer<typeof ShapeNodeSchema>;

export const StickyNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('sticky'),
  text: z.string().default(''),
  style: StyleSchema
});
export type StickyNode = z.infer<typeof StickyNodeSchema>;

export const TextNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('text'),
  text: z.string().default(''),
  style: StyleSchema
});
export type TextNode = z.infer<typeof TextNodeSchema>;

/**
 * Freehand strokes keep raw input points; the renderer turns them into an
 * outline with perfect-freehand at draw time so pressure and thinning stay
 * adjustable after the fact.
 */
export const FreehandNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('freehand'),
  /** Points are relative to the node position, as [x, y, pressure]. */
  points: z.array(z.tuple([z.number(), z.number(), z.number()])).default([]),
  style: StyleSchema
});
export type FreehandNode = z.infer<typeof FreehandNodeSchema>;

export const GroupNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('group'),
  label: z.string().default(''),
  /** Colour band for the group chrome. */
  accent: z.string().default('#6ea8fe'),
  style: StyleSchema
});
export type GroupNode = z.infer<typeof GroupNodeSchema>;

/**
 * An agent's embodiment on the board. Everything geometrically inside is in
 * that agent's context, and the agent can move the frame to change what it
 * sees.
 */
export const FrameNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('frame'),
  label: z.string().default(''),
  /** Null for a plain layout frame; set for an agent's working area. */
  agentId: z.string().nullable().default(null),
  style: StyleSchema,
  /** Agent frames auto-grow to keep newly created artifacts inside. */
  autoGrow: z.boolean().default(true)
});
export type FrameNode = z.infer<typeof FrameNodeSchema>;

/** Reusable sticker from a sticker pack, placed on the board. */
export const StickerNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('sticker'),
  packId: z.string(),
  stickerId: z.string(),
  /** Absolute or app-served path / data URL for the image. */
  src: z.string(),
  emoji: z.string().optional()
});
export type StickerNode = z.infer<typeof StickerNodeSchema>;

export const BoardNodeSchema = z.discriminatedUnion('type', [
  ArtifactNodeSchema,
  ShapeNodeSchema,
  StickyNodeSchema,
  TextNodeSchema,
  FreehandNodeSchema,
  GroupNodeSchema,
  FrameNodeSchema,
  StickerNodeSchema
]);
export type BoardNode = z.infer<typeof BoardNodeSchema>;
export type BoardNodeType = BoardNode['type'];

export const EdgeEndpointSchema = z.object({
  nodeId: z.string().nullable(),
  /** Free endpoint when nodeId is null. */
  point: Vec2Schema.nullable().default(null),
  /** Normalised anchor within the node box, 0..1 on each axis. */
  anchor: Vec2Schema.nullable().default(null)
});
export type EdgeEndpoint = z.infer<typeof EdgeEndpointSchema>;

export const EdgeArrowSchema = z.enum(['none', 'arrow', 'dot', 'diamond']);

export const BoardEdgeSchema = z.object({
  id: z.string(),
  from: EdgeEndpointSchema,
  to: EdgeEndpointSchema,
  label: z.string().default(''),
  style: StyleSchema,
  startArrow: EdgeArrowSchema.default('none'),
  endArrow: EdgeArrowSchema.default('arrow'),
  routing: z.enum(['straight', 'bezier', 'orthogonal']).default('bezier'),
  layerId: z.string(),
  createdBy: z.string().nullable().default(null),
  meta: z.record(z.unknown()).default({})
});
export type BoardEdge = z.infer<typeof BoardEdgeSchema>;

export const LayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  order: z.number().int().default(0)
});
export type Layer = z.infer<typeof LayerSchema>;

export function isArtifactNode(node: BoardNode): node is ArtifactNode {
  return node.type === 'artifact';
}

export function isFrameNode(node: BoardNode): node is FrameNode {
  return node.type === 'frame';
}

export function isGroupNode(node: BoardNode): node is GroupNode {
  return node.type === 'group';
}

export function isStickerNode(node: BoardNode): node is StickerNode {
  return node.type === 'sticker';
}

export function isAgentFrame(node: BoardNode): node is FrameNode & { agentId: string } {
  return node.type === 'frame' && typeof node.agentId === 'string';
}

/** Text content of any node, for board search and the outline projection. */
export function nodeText(node: BoardNode): string {
  switch (node.type) {
    case 'shape':
    case 'sticky':
    case 'text':
      return node.text;
    case 'group':
    case 'frame':
      return node.label;
    case 'freehand':
      return '';
    case 'sticker':
      return node.emoji ?? `${node.packId}/${node.stickerId}`;
    case 'artifact':
      return node.artifact.title;
  }
}
