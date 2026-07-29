import { z } from 'zod';
import { CameraSchema } from './geometry.js';
import { BoardEdgeSchema, BoardNodeSchema, LayerSchema } from './nodes.js';
import { newId } from './ids.js';

export const BOARD_FILE_NAME = 'board.zmtki.json';
export const BOARD_DIR = '.zmtki';
export const BOARD_SCHEMA_VERSION = 1;

export const BoardSettingsSchema = z.object({
  /** Overrides on top of app-level settings; unset keys inherit. */
  defaultEndpointId: z.string().nullable().default(null),
  defaultModel: z.string().nullable().default(null),
  approvalPolicy: z.enum(['never', 'onRequest', 'untrusted']).nullable().default(null),
  maxConcurrentTurns: z.number().int().positive().nullable().default(null),
  tokenBudget: z.number().int().positive().nullable().default(null),
  gridSize: z.number().int().positive().default(8),
  snapToGrid: z.boolean().default(true)
});
export type BoardSettings = z.infer<typeof BoardSettingsSchema>;

export const NamedViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  camera: CameraSchema
});
export type NamedView = z.infer<typeof NamedViewSchema>;

export const BoardDocSchema = z.object({
  version: z.literal(BOARD_SCHEMA_VERSION).default(BOARD_SCHEMA_VERSION),
  id: z.string(),
  name: z.string(),
  /** Free-form description that also seeds every agent's system prompt. */
  description: z.string().default(''),
  createdAt: z.number().int().default(0),
  updatedAt: z.number().int().default(0),
  camera: CameraSchema,
  layers: z.array(LayerSchema).default([]),
  nodes: z.array(BoardNodeSchema).default([]),
  edges: z.array(BoardEdgeSchema).default([]),
  views: z.array(NamedViewSchema).default([]),
  settings: BoardSettingsSchema
});
export type BoardDoc = z.infer<typeof BoardDocSchema>;

export const DEFAULT_LAYER_ID = 'lyr_default';

export function createEmptyBoard(name: string, id = newId('board')): BoardDoc {
  const now = Date.now();
  return BoardDocSchema.parse({
    version: BOARD_SCHEMA_VERSION,
    id,
    name,
    description: '',
    createdAt: now,
    updatedAt: now,
    camera: { x: 0, y: 0, zoom: 1 },
    layers: [{ id: DEFAULT_LAYER_ID, name: 'Основной', visible: true, locked: false, order: 0 }],
    nodes: [],
    edges: [],
    views: [],
    settings: {}
  });
}

/**
 * Serialisation is deliberately deterministic: keys sorted, arrays ordered by
 * id, two-space indent. The board file sits in the project repo next to the
 * code, so a noisy diff on every camera nudge would make it unmergeable.
 */
export function serializeBoard(doc: BoardDoc): string {
  const ordered: BoardDoc = {
    ...doc,
    layers: [...doc.layers].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    nodes: [...doc.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...doc.edges].sort((a, b) => a.id.localeCompare(b.id)),
    views: [...doc.views].sort((a, b) => a.id.localeCompare(b.id))
  };
  return `${JSON.stringify(ordered, sortedReplacer, 2)}\n`;
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) out[k] = src[k];
  return out;
}

export type BoardParseResult =
  | { ok: true; doc: BoardDoc }
  | { ok: false; error: string };

export function parseBoard(text: string): BoardParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `board file is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = BoardDocSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, doc: parsed.data };
}
