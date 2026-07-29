import { z } from 'zod';

/**
 * Three levels with different routing, so a stream of artifacts does not turn
 * into a stream of popups.
 *
 * - blocking: work has stopped until a human answers. OS notification + sound.
 * - attention: worth a toast and a badge, but nothing is waiting.
 * - info: badge and the activity feed only.
 */
export const SeveritySchema = z.enum(['blocking', 'attention', 'info']);
export type Severity = z.infer<typeof SeveritySchema>;

export const NotificationKindSchema = z.enum([
  'approvalRequired',
  'questionAsked',
  'turnComplete',
  'turnFailed',
  'commentReply',
  'mentioned',
  'budgetExceeded',
  'roomPaused',
  'artifactCreated',
  'commandFinished'
]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NotificationActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Resolved by the main process against the pending approval registry. */
  kind: z.enum(['approve', 'deny', 'open', 'snooze', 'resume'])
});
export type NotificationAction = z.infer<typeof NotificationActionSchema>;

/**
 * Every notification is a deep link. Clicking it switches project, flies the
 * camera to the node and opens the room, which is what ties notifications and
 * navigation into one mechanism.
 */
export const DeepLinkSchema = z.object({
  boardId: z.string().nullable().default(null),
  nodeId: z.string().nullable().default(null),
  roomId: z.string().nullable().default(null),
  agentId: z.string().nullable().default(null)
});
export type DeepLink = z.infer<typeof DeepLinkSchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  kind: NotificationKindSchema,
  severity: SeveritySchema,
  title: z.string(),
  body: z.string().default(''),
  link: DeepLinkSchema,
  actions: z.array(NotificationActionSchema).default([]),
  createdAt: z.number().int(),
  read: z.boolean().default(false),
  /** Bursts from one agent collapse into a single row with a count. */
  coalesceKey: z.string().default(''),
  count: z.number().int().min(1).default(1),
  /** Set once an action was taken, so the row can render as resolved. */
  resolvedAction: z.string().nullable().default(null)
});
export type Notification = z.infer<typeof NotificationSchema>;

export function formatDeepLink(link: DeepLink): string {
  const parts = ['zmtki://'];
  if (link.boardId) parts.push(`board/${link.boardId}`);
  if (link.nodeId) parts.push(`/node/${link.nodeId}`);
  if (link.roomId) parts.push(`/room/${link.roomId}`);
  if (link.agentId) parts.push(`/agent/${link.agentId}`);
  return parts.join('');
}
