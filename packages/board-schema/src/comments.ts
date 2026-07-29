import { z } from 'zod';
import { Vec2Schema } from './geometry.js';

export const AuthorRefSchema = z.union([
  z.object({ kind: z.literal('human'), name: z.string().default('You') }),
  z.object({ kind: z.literal('agent'), agentId: z.string(), name: z.string().default('') })
]);
export type AuthorRef = z.infer<typeof AuthorRefSchema>;

export const CommentSchema = z.object({
  id: z.string(),
  author: AuthorRefSchema,
  body: z.string(),
  createdAt: z.number().int(),
  /** Agent ids explicitly addressed by this comment. */
  mentions: z.array(z.string()).default([])
});
export type Comment = z.infer<typeof CommentSchema>;

export const CommentThreadSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  /** Optional pin inside the artifact, in node-local coordinates. */
  anchor: Vec2Schema.nullable().default(null),
  resolved: z.boolean().default(false),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  comments: z.array(CommentSchema).default([]),
  /** Threads whose mentions have not yet been delivered to an agent inbox. */
  pendingDelivery: z.array(z.string()).default([])
});
export type CommentThread = z.infer<typeof CommentThreadSchema>;

export const CommentFileSchema = z.object({
  version: z.literal(1).default(1),
  threads: z.array(CommentThreadSchema).default([])
});
export type CommentFile = z.infer<typeof CommentFileSchema>;

const MENTION_RE = /@([a-zA-Z0-9_-]+)/g;

/** Resolves `@name` tokens to agent ids using a name index. */
export function extractMentions(
  body: string,
  resolve: (handle: string) => string | undefined
): string[] {
  const out = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) {
    const handle = match[1];
    if (!handle) continue;
    const id = resolve(handle);
    if (id) out.add(id);
  }
  return [...out];
}
