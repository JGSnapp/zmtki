import { z } from 'zod';
import { AgentSchema, CameraSchema } from '@zmtki/board-schema';
import { BoardOpSchema } from './boardOps.js';
import { RoomSchema, TurnPolicySchema } from './rooms.js';

/**
 * Requests flowing UI -> core. Validated at the boundary: a malformed op from
 * a buggy renderer should fail loudly rather than corrupt a board file.
 */
export const OpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workspace.list') }),
  z.object({ type: z.literal('workspace.openBoard'), path: z.string() }),
  z.object({ type: z.literal('workspace.createBoard'), path: z.string(), name: z.string() }),
  z.object({ type: z.literal('workspace.closeBoard'), boardId: z.string() }),
  z.object({ type: z.literal('workspace.setActive'), boardId: z.string().nullable() }),

  z.object({ type: z.literal('board.get'), boardId: z.string() }),
  z.object({
    type: z.literal('board.apply'),
    boardId: z.string(),
    ops: z.array(BoardOpSchema),
    label: z.string().optional()
  }),
  z.object({ type: z.literal('board.undo'), boardId: z.string() }),
  z.object({ type: z.literal('board.redo'), boardId: z.string() }),
  z.object({ type: z.literal('board.search'), boardId: z.string(), query: z.string() }),
  z.object({ type: z.literal('board.tidy'), boardId: z.string() }),

  z.object({ type: z.literal('agent.list') }),
  z.object({
    type: z.literal('agent.create'),
    boardId: z.string(),
    name: z.string(),
    persona: z.string().default(''),
    endpointId: z.string().optional(),
    model: z.string().optional()
  }),
  z.object({ type: z.literal('agent.update'), agentId: z.string(), patch: AgentSchema.partial() }),
  z.object({ type: z.literal('agent.delete'), agentId: z.string() }),
  z.object({ type: z.literal('agent.interrupt'), agentId: z.string() }),

  z.object({ type: z.literal('room.list') }),
  z.object({
    type: z.literal('room.create'),
    title: z.string(),
    kind: z.enum(['dm', 'group', 'channel']),
    memberAgentIds: z.array(z.string()).default([]),
    turnPolicy: TurnPolicySchema.default('mention-only'),
    boardId: z.string().nullable().default(null)
  }),
  z.object({ type: z.literal('room.update'), roomId: z.string(), patch: RoomSchema.partial() }),
  z.object({ type: z.literal('room.delete'), roomId: z.string() }),
  z.object({
    type: z.literal('room.send'),
    roomId: z.string(),
    body: z.string().default(''),
    /** Human messages steer a running turn instead of queueing behind it. */
    steer: z.boolean().default(true),
    attachments: z
      .array(
        z.object({
          name: z.string(),
          path: z.string(),
          mime: z.string().default('application/octet-stream'),
          size: z.number().int().nonnegative().default(0)
        })
      )
      .default([]),
    sticker: z
      .object({
        packId: z.string(),
        stickerId: z.string(),
        src: z.string(),
        emoji: z.string().optional()
      })
      .nullable()
      .default(null)
  }),
  z.object({ type: z.literal('room.history'), roomId: z.string(), limit: z.number().int().default(200) }),
  z.object({ type: z.literal('room.markRead'), roomId: z.string() }),
  z.object({ type: z.literal('room.resume'), roomId: z.string() }),
  z.object({ type: z.literal('room.searchMessages'), query: z.string(), limit: z.number().int().default(50) }),

  z.object({
    type: z.literal('comment.create'),
    boardId: z.string(),
    nodeId: z.string(),
    body: z.string(),
    anchor: z.object({ x: z.number(), y: z.number() }).nullable().default(null)
  }),
  z.object({
    type: z.literal('comment.reply'),
    boardId: z.string(),
    threadId: z.string(),
    body: z.string()
  }),
  z.object({
    type: z.literal('comment.resolve'),
    boardId: z.string(),
    threadId: z.string(),
    resolved: z.boolean()
  }),
  z.object({ type: z.literal('comment.list'), boardId: z.string() }),

  z.object({ type: z.literal('approval.respond'), requestId: z.string(), approved: z.boolean(), remember: z.boolean().default(false) }),

  z.object({ type: z.literal('notification.list'), limit: z.number().int().default(200) }),
  z.object({ type: z.literal('notification.markRead'), id: z.string().nullable() }),
  z.object({ type: z.literal('notification.act'), id: z.string(), actionId: z.string() }),
  z.object({ type: z.literal('notification.setFocusMode'), enabled: z.boolean() }),

  z.object({ type: z.literal('terminal.input'), nodeId: z.string(), data: z.string() }),
  z.object({ type: z.literal('terminal.resize'), nodeId: z.string(), cols: z.number().int(), rows: z.number().int() }),
  z.object({ type: z.literal('terminal.kill'), nodeId: z.string() }),
  z.object({ type: z.literal('terminal.spawn'), boardId: z.string(), nodeId: z.string(), command: z.string() }),

  z.object({ type: z.literal('browser.navigate'), nodeId: z.string(), url: z.string() }),
  z.object({
    type: z.literal('browser.setBounds'),
    boardId: z.string(),
    nodeId: z.string(),
    bounds: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
    visible: z.boolean()
  }),

  z.object({ type: z.literal('provider.list') }),
  z.object({
    type: z.literal('provider.upsert'),
    endpoint: z.object({
      id: z.string().optional(),
      label: z.string(),
      baseUrl: z.string(),
      apiKey: z.string().optional(),
      models: z.array(z.string()).default([])
    })
  }),
  z.object({ type: z.literal('provider.delete'), endpointId: z.string() }),
  z.object({ type: z.literal('provider.probe'), endpointId: z.string() }),

  z.object({ type: z.literal('chatgpt.status') }),
  z.object({ type: z.literal('chatgpt.login') }),
  z.object({ type: z.literal('chatgpt.cancelLogin') }),
  z.object({ type: z.literal('chatgpt.logout') }),

  z.object({ type: z.literal('extensions.list') }),
  z.object({
    type: z.literal('extensions.skills.upsert'),
    scope: z.enum(['global', 'board']),
    name: z.string().min(1),
    description: z.string().default(''),
    body: z.string()
  }),
  z.object({
    type: z.literal('extensions.skills.remove'),
    scope: z.enum(['global', 'board']),
    name: z.string().min(1)
  }),
  z.object({
    type: z.literal('extensions.mcp.upsert'),
    scope: z.enum(['global', 'board']),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    disabled: z.boolean().default(false)
  }),
  z.object({
    type: z.literal('extensions.mcp.remove'),
    scope: z.enum(['global', 'board']),
    name: z.string().min(1)
  }),
  z.object({ type: z.literal('extensions.mcp.test'), name: z.string().min(1) }),

  z.object({
    type: z.literal('artifact.control'),
    boardId: z.string(),
    nodeId: z.string(),
    controlId: z.string(),
    action: z.string().default(''),
    value: z.unknown().optional()
  }),

  z.object({ type: z.literal('stickers.list') }),
  z.object({
    type: z.literal('stickers.upsertPack'),
    scope: z.enum(['global', 'board']).default('global'),
    id: z.string().min(1),
    name: z.string().min(1)
  }),
  z.object({
    type: z.literal('stickers.removePack'),
    scope: z.enum(['global', 'board']).default('global'),
    id: z.string().min(1)
  }),
  z.object({
    type: z.literal('stickers.addSticker'),
    scope: z.enum(['global', 'board']).default('global'),
    packId: z.string().min(1),
    id: z.string().min(1),
    /** Absolute path to source image, or data URL. */
    sourcePath: z.string().min(1),
    emoji: z.string().optional()
  }),
  z.object({
    type: z.literal('stickers.removeSticker'),
    scope: z.enum(['global', 'board']).default('global'),
    packId: z.string().min(1),
    id: z.string().min(1)
  }),
  z.object({
    type: z.literal('stickers.place'),
    boardId: z.string(),
    packId: z.string(),
    stickerId: z.string(),
    position: z.object({ x: z.number(), y: z.number() }).optional()
  }),

  z.object({
    type: z.literal('node.setLock'),
    boardId: z.string(),
    nodeId: z.string(),
    lock: z.object({
      delete: z.boolean().optional(),
      move: z.boolean().optional(),
      edit: z.boolean().optional()
    })
  }),
  z.object({
    type: z.literal('node.setVisualState'),
    boardId: z.string(),
    nodeId: z.string(),
    visualState: z.enum(['expanded', 'widget', 'icon', 'ghost'])
  }),

  z.object({ type: z.literal('settings.get') }),
  z.object({ type: z.literal('settings.set'), patch: z.record(z.unknown()) }),

  z.object({ type: z.literal('camera.set'), boardId: z.string(), camera: CameraSchema })
]);

export type Op = z.infer<typeof OpSchema>;
export type OpType = Op['type'];

export interface Submission {
  id: string;
  op: Op;
}

export type OpResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: string };
