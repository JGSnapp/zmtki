import { z } from 'zod';
import { ArtifactRefSchema } from '@zmtki/board-schema';

/**
 * One entity covers direct messages, groups and per-project channels. Members
 * can be agents from different boards, which is why rooms live at app level
 * rather than inside a board folder.
 */

export const MemberRefSchema = z.union([
  z.object({ kind: z.literal('human'), id: z.literal('human'), name: z.string().default('You') }),
  z.object({ kind: z.literal('agent'), id: z.string(), name: z.string().default('') })
]);
export type MemberRef = z.infer<typeof MemberRefSchema>;

export const RoomKindSchema = z.enum(['dm', 'group', 'channel']);
export type RoomKind = z.infer<typeof RoomKindSchema>;

/**
 * How the room decides who speaks next. This is the main guard against two
 * agents politely talking to each other until the budget is gone, so it is a
 * property of the room rather than a hope expressed in a prompt.
 */
export const TurnPolicySchema = z.enum(['mention-only', 'moderated', 'round-robin', 'free']);
export type TurnPolicy = z.infer<typeof TurnPolicySchema>;

export const RoomBudgetSchema = z.object({
  /** Max agent->agent hops traced back to one human message. */
  maxHops: z.number().int().min(0).default(6),
  /** Exchanges without a tool call or artifact change before we call it stalled. */
  stallThreshold: z.number().int().min(1).default(4),
  maxTokens: z.number().int().positive().nullable().default(null),
  maxCostUsd: z.number().positive().nullable().default(null),
  spentTokens: z.number().int().nonnegative().default(0),
  spentCostUsd: z.number().nonnegative().default(0)
});
export type RoomBudget = z.infer<typeof RoomBudgetSchema>;

export const RoomSchema = z.object({
  id: z.string(),
  kind: RoomKindSchema,
  title: z.string(),
  members: z.array(MemberRefSchema).default([]),
  turnPolicy: TurnPolicySchema.default('mention-only'),
  /** Agent that hands out the floor when turnPolicy is 'moderated'. */
  moderatorId: z.string().nullable().default(null),
  budget: RoomBudgetSchema,
  /** Set when every member lives on one board; enables mirroring into it. */
  boardId: z.string().nullable().default(null),
  paused: z.boolean().default(false),
  pausedReason: z.string().default(''),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastReadAt: z.number().int().default(0)
});
export type Room = z.infer<typeof RoomSchema>;

/**
 * Causation chain back to the human message that started this exchange. Every
 * budget and loop guard is attributed through it.
 */
export const CausationSchema = z.object({
  rootHumanMessageId: z.string().nullable().default(null),
  parentMessageId: z.string().nullable().default(null),
  hopCount: z.number().int().nonnegative().default(0)
});
export type Causation = z.infer<typeof CausationSchema>;

export const RoomMessageAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  mime: z.string().default('application/octet-stream'),
  size: z.number().int().nonnegative().default(0)
});
export type RoomMessageAttachment = z.infer<typeof RoomMessageAttachmentSchema>;

export const RoomMessageStickerSchema = z.object({
  packId: z.string(),
  stickerId: z.string(),
  src: z.string(),
  emoji: z.string().optional()
});
export type RoomMessageSticker = z.infer<typeof RoomMessageStickerSchema>;

export const RoomMessageSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  author: MemberRefSchema,
  body: z.string(),
  mentions: z.array(z.string()).default([]),
  artifactRefs: z.array(ArtifactRefSchema).default([]),
  attachments: z.array(RoomMessageAttachmentSchema).default([]),
  sticker: RoomMessageStickerSchema.nullable().default(null),
  causation: CausationSchema,
  createdAt: z.number().int(),
  /** True for system notices such as "room paused: hop limit reached". */
  system: z.boolean().default(false),
  /** Turn that produced this message, for jumping to the transcript. */
  turnId: z.string().nullable().default(null)
});
export type RoomMessage = z.infer<typeof RoomMessageSchema>;

export const DEFAULT_ROOM_BUDGET: RoomBudget = RoomBudgetSchema.parse({});
