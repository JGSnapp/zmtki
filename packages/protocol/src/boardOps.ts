import { z } from 'zod';
import {
  BoardEdgeSchema,
  BoardNodeSchema,
  CameraSchema,
  LayerSchema,
  NamedViewSchema,
  SizeSchema,
  Vec2Schema
} from '@zmtki/board-schema';

/**
 * The only way anything mutates a board. Both the user's pointer and an
 * agent's tool call funnel through the same op list, so undo, persistence,
 * conflict resolution and the event stream have a single code path.
 */

export const BoardOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addNode'), node: BoardNodeSchema }),
  z.object({
    op: z.literal('updateNode'),
    id: z.string(),
    /** Shallow merge over the node; artifact specs are merged one level deeper. */
    patch: z.record(z.unknown())
  }),
  z.object({ op: z.literal('removeNode'), id: z.string() }),
  z.object({
    op: z.literal('moveNodes'),
    moves: z.array(z.object({ id: z.string(), position: Vec2Schema }))
  }),
  z.object({ op: z.literal('resizeNode'), id: z.string(), size: SizeSchema, position: Vec2Schema.optional() }),
  z.object({ op: z.literal('reorderNode'), id: z.string(), z: z.number() }),
  z.object({ op: z.literal('addEdge'), edge: BoardEdgeSchema }),
  z.object({ op: z.literal('updateEdge'), id: z.string(), patch: z.record(z.unknown()) }),
  z.object({ op: z.literal('removeEdge'), id: z.string() }),
  z.object({ op: z.literal('setCamera'), camera: CameraSchema }),
  z.object({ op: z.literal('addLayer'), layer: LayerSchema }),
  z.object({ op: z.literal('updateLayer'), id: z.string(), patch: z.record(z.unknown()) }),
  z.object({ op: z.literal('removeLayer'), id: z.string() }),
  z.object({ op: z.literal('addView'), view: NamedViewSchema }),
  z.object({ op: z.literal('removeView'), id: z.string() }),
  z.object({
    op: z.literal('setBoardMeta'),
    patch: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      settings: z.record(z.unknown()).optional()
    })
  })
]);
export type BoardOp = z.infer<typeof BoardOpSchema>;

export interface BoardTransaction {
  ops: BoardOp[];
  /** Agent id, or null for the human. Drives provenance and write permission. */
  origin: string | null;
  /** Grouping key for undo; ops sharing a label collapse into one step. */
  label?: string;
}
