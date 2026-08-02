import { newId } from '@zmtki/board-schema';
import {
  DEFAULT_ROOM_BUDGET,
  RoomMessageSchema,
  RoomSchema,
  type Causation,
  type MemberRef,
  type Room,
  type RoomKind,
  type RoomMessage,
  type TurnPolicy
} from '@zmtki/protocol';
import type { AgentDirectory } from '../app/AgentDirectory.js';
import type { AgentInbox } from '../app/AgentInbox.js';
import type { AppDatabase } from '../app/AppDatabase.js';
import type { AppSettings } from '../app/settings.js';
import { Emitter } from '../util/emitter.js';

export interface SendInput {
  roomId: string;
  /** 'human' or an agent id. */
  authorId: string;
  body: string;
  mentions?: string[];
  artifactRefs?: Array<{ boardId: string; nodeId: string }>;
  attachments?: Array<{
    id?: string;
    name: string;
    path: string;
    mime?: string;
    size?: number;
  }>;
  sticker?: {
    packId: string;
    stickerId: string;
    src: string;
    emoji?: string;
  } | null;
  parentMessageId?: string | null;
  turnId?: string | null;
}

export interface SendOutcome {
  ok: boolean;
  error?: string;
  message?: RoomMessage;
  /** Agents that should take a turn as a result of this message. */
  wake: string[];
}

export interface RoomCreateInput {
  kind: RoomKind;
  title?: string;
  memberAgentIds: string[];
  includeHuman?: boolean;
  turnPolicy?: TurnPolicy;
  boardId?: string | null;
  moderatorId?: string | null;
}

const HUMAN: MemberRef = { kind: 'human', id: 'human', name: 'Вы' };

/**
 * The single messaging channel for humans and agents: DMs, groups and project
 * channels are one entity with different member sets.
 *
 * Turn-taking lives here rather than in prompts. A prompt asking agents not to
 * chat forever is a suggestion; a hop counter that pauses the room is a
 * guarantee. Every message carries causation back to the human message that
 * started the exchange, and the guards below are all attributed through it.
 */
export class RoomBus {
  readonly onRoom = new Emitter<Room>();
  readonly onMessage = new Emitter<RoomMessage>();

  constructor(
    private readonly db: AppDatabase,
    private readonly directory: AgentDirectory,
    private readonly inbox: AgentInbox,
    private readonly settings: () => AppSettings
  ) {
    // Token/cost room pauses were removed as a product guard; clear leftovers
    // from older sessions so existing chats are not stuck behind the banner.
    this.liftSpendBudgets();
  }

  list(): Room[] {
    return this.db
      .all<{ json: string }>('SELECT json FROM rooms ORDER BY updated_at DESC')
      .map((row) => RoomSchema.parse(JSON.parse(row.json)));
  }

  get(roomId: string): Room | undefined {
    const row = this.db.get<{ json: string }>('SELECT json FROM rooms WHERE id = ?', [roomId]);
    return row ? RoomSchema.parse(JSON.parse(row.json)) : undefined;
  }

  listForAgent(agentId: string): Room[] {
    return this.list().filter((room) => room.members.some((m) => m.id === agentId));
  }

  create(input: RoomCreateInput): Room {
    const members: MemberRef[] = [];
    if (input.includeHuman !== false) members.push(HUMAN);
    for (const agentId of input.memberAgentIds) {
      const entry = this.directory.get(agentId);
      members.push({ kind: 'agent', id: agentId, name: entry?.name ?? agentId });
    }

    const settings = this.settings();
    const now = Date.now();
    const agentCount = input.memberAgentIds.length;

    const room = RoomSchema.parse({
      id: newId('room'),
      kind: input.kind,
      title: input.title ?? defaultTitle(input.kind, members),
      members,
      // A DM has nobody to loop with, so it runs free; anything larger defaults
      // to mention-only, where an agent speaks only when addressed.
      turnPolicy: input.turnPolicy ?? (agentCount <= 1 ? 'free' : 'mention-only'),
      moderatorId: input.moderatorId ?? null,
      budget: {
        ...DEFAULT_ROOM_BUDGET,
        maxHops: settings.defaultMaxHops,
        stallThreshold: settings.defaultStallThreshold,
        maxTokens: settings.defaultRoomTokenBudget
      },
      boardId: input.boardId ?? this.inferBoardId(input.memberAgentIds),
      createdAt: now,
      updatedAt: now
    });

    this.save(room);
    return room;
  }

  /** Finds or creates the one-to-one room between the human and an agent. */
  dmWith(agentId: string): Room {
    const existing = this.list().find(
      (room) =>
        room.kind === 'dm' &&
        room.members.length === 2 &&
        room.members.some((m) => m.id === agentId) &&
        room.members.some((m) => m.kind === 'human')
    );
    if (existing) return existing;
    return this.create({ kind: 'dm', memberAgentIds: [agentId] });
  }

  update(roomId: string, patch: Partial<Room>): Room | undefined {
    const room = this.get(roomId);
    if (!room) return undefined;
    const next = RoomSchema.parse({ ...room, ...patch, id: room.id, updatedAt: Date.now() });
    this.save(next);
    return next;
  }

  addMembers(roomId: string, agentIds: readonly string[]): Room | undefined {
    const room = this.get(roomId);
    if (!room) return undefined;
    const known = new Set(room.members.map((m) => m.id));
    const members = [...room.members];
    for (const agentId of agentIds) {
      if (known.has(agentId)) continue;
      const entry = this.directory.get(agentId);
      members.push({ kind: 'agent', id: agentId, name: entry?.name ?? agentId });
    }
    // Growing a DM past two members makes it a group, and the loose 'free'
    // policy a DM uses is no longer safe.
    const kind: RoomKind = room.kind === 'dm' && members.length > 2 ? 'group' : room.kind;
    const turnPolicy: TurnPolicy =
      kind === 'group' && room.turnPolicy === 'free' ? 'mention-only' : room.turnPolicy;
    return this.update(roomId, { members, kind, turnPolicy });
  }

  removeMember(roomId: string, memberId: string): Room | undefined {
    const room = this.get(roomId);
    if (!room) return undefined;
    return this.update(roomId, { members: room.members.filter((m) => m.id !== memberId) });
  }

  remove(roomId: string): void {
    this.db.run('DELETE FROM messages WHERE room_id = ?', [roomId]);
    this.db.run('DELETE FROM message_search WHERE room_id = ?', [roomId]);
    this.db.run('DELETE FROM rooms WHERE id = ?', [roomId]);
  }

  /** Wipe message history; keep the room and its members. */
  clear(roomId: string): Room | undefined {
    const room = this.get(roomId);
    if (!room) return undefined;
    this.db.run('DELETE FROM messages WHERE room_id = ?', [roomId]);
    this.db.run('DELETE FROM message_search WHERE room_id = ?', [roomId]);
    return this.update(roomId, {
      paused: false,
      pausedReason: '',
      budget: { ...room.budget, spentTokens: 0, spentCostUsd: 0 }
    });
  }

  history(roomId: string, limit = 50): RoomMessage[] {
    return this.db
      .all<{ json: string }>(
        'SELECT json FROM (SELECT json, created_at FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC',
        [roomId, limit]
      )
      .map((row) => RoomMessageSchema.parse(JSON.parse(row.json)));
  }

  searchMessages(query: string, limit = 40): RoomMessage[] {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    return this.db
      .all<{ json: string }>(
        `SELECT m.json FROM message_search s
         JOIN messages m ON m.id = s.message_id
         WHERE s.body_lower LIKE ?
         ORDER BY m.created_at DESC
         LIMIT ?`,
        [`%${trimmed}%`, limit]
      )
      .map((row) => RoomMessageSchema.parse(JSON.parse(row.json)));
  }

  markRead(roomId: string): void {
    this.update(roomId, { lastReadAt: Date.now() });
  }

  unreadCount(roomId: string): number {
    const room = this.get(roomId);
    if (!room) return 0;
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND created_at > ?',
      [roomId, room.lastReadAt]
    );
    return row?.n ?? 0;
  }

  /**
   * Posts a message and decides who, if anyone, should now take a turn.
   *
   * Returning the wake list instead of starting turns here keeps scheduling in
   * one place: the caller owns the concurrency limit and knows which boards are
   * loaded.
   */
  send(input: SendInput): SendOutcome {
    const room = this.get(input.roomId);
    if (!room) return { ok: false, error: `комната не найдена: ${input.roomId}`, wake: [] };

    const isHuman = input.authorId === 'human';
    if (!isHuman && !room.members.some((m) => m.id === input.authorId)) {
      return { ok: false, error: 'ты не участник этой комнаты', wake: [] };
    }

    // A human message always un-pauses: the guards exist to stop runaway agents,
    // not to lock the person out of their own conversation.
    if (room.paused && isHuman) {
      this.update(room.id, { paused: false, pausedReason: '', budget: { ...room.budget, spentTokens: 0 } });
    } else if (room.paused) {
      return { ok: false, error: `комната на паузе: ${room.pausedReason}`, wake: [] };
    }

    const parent = input.parentMessageId ? this.getMessage(input.parentMessageId) : this.lastMessage(room.id);
    const causation = this.deriveCausation(isHuman, parent);

    if (!isHuman && causation.hopCount > room.budget.maxHops) {
      this.pause(room, `исчерпан лимит в ${room.budget.maxHops} ответов агентов подряд`);
      return { ok: false, error: 'лимит цепочки ответов исчерпан, нужен ответ человека', wake: [] };
    }

    const author: MemberRef = isHuman
      ? HUMAN
      : {
          kind: 'agent',
          id: input.authorId,
          name: this.directory.get(input.authorId)?.name ?? input.authorId
        };

    const mentions = this.resolveMentions(room, input.body, input.mentions ?? []);

    const message = RoomMessageSchema.parse({
      id: newId('message'),
      roomId: room.id,
      author,
      body: input.body,
      mentions,
      artifactRefs: input.artifactRefs ?? [],
      attachments: (input.attachments ?? []).map((a) => ({
        id: a.id ?? newId('file'),
        name: a.name,
        path: a.path,
        mime: a.mime ?? 'application/octet-stream',
        size: a.size ?? 0
      })),
      sticker: input.sticker ?? null,
      causation,
      createdAt: Date.now(),
      system: false,
      turnId: input.turnId ?? null
    });

    this.saveMessage(message);
    this.update(room.id, { updatedAt: message.createdAt });
    this.onMessage.emit(message);

    const wake = this.decideWake(room, message, isHuman);
    for (const agentId of wake) {
      this.inbox.push({
        agentId,
        kind: 'mention',
        text: `${author.name}: ${input.body.slice(0, 500)}`,
        roomId: room.id,
        boardId: room.boardId,
        nodeId: null,
        threadId: null,
        fromId: input.authorId,
        hops: causation.hopCount
      });
    }

    return { ok: true, message, wake };
  }

  /** Posts a system notice; never wakes anyone. */
  systemNotice(roomId: string, body: string): RoomMessage | undefined {
    const room = this.get(roomId);
    if (!room) return undefined;
    const message = RoomMessageSchema.parse({
      id: newId('message'),
      roomId,
      author: HUMAN,
      body,
      mentions: [],
      artifactRefs: [],
      causation: { rootHumanMessageId: null, parentMessageId: null, hopCount: 0 },
      createdAt: Date.now(),
      system: true,
      turnId: null
    });
    this.saveMessage(message);
    this.onMessage.emit(message);
    return message;
  }

  /** Hands the floor to a specific agent in a moderated room. */
  yieldTo(roomId: string, fromAgentId: string, nextSpeaker: string): { ok: boolean; error?: string } {
    const room = this.get(roomId);
    if (!room) return { ok: false, error: 'комната не найдена' };
    if (room.turnPolicy !== 'moderated') {
      return { ok: false, error: 'передача слова работает только при turnPolicy=moderated' };
    }
    if (room.moderatorId !== fromAgentId) {
      return { ok: false, error: 'слово передаёт только модератор комнаты' };
    }
    if (!room.members.some((m) => m.id === nextSpeaker)) {
      return { ok: false, error: 'этот агент не участник комнаты' };
    }
    this.inbox.push({
      agentId: nextSpeaker,
      kind: 'system',
      text: 'Модератор передал тебе слово в комнате.',
      roomId,
      boardId: room.boardId,
      nodeId: null,
      threadId: null,
      fromId: fromAgentId,
      hops: 0
    });
    return { ok: true };
  }

  addSpend(roomId: string, tokens: number, costUsd: number): void {
    const room = this.get(roomId);
    if (!room) return;
    // Spend is tracked for stats only — rooms are not paused on token/cost caps.
    this.update(roomId, {
      budget: {
        ...room.budget,
        maxTokens: null,
        maxCostUsd: null,
        spentTokens: room.budget.spentTokens + tokens,
        spentCostUsd: room.budget.spentCostUsd + costUsd
      }
    });
  }

  /** Drop token/cost caps and resume rooms paused only for those reasons. */
  private liftSpendBudgets(): void {
    for (const room of this.list()) {
      const spendPaused =
        room.paused &&
        (room.pausedReason.includes('бюджет токенов') || room.pausedReason.includes('денежный бюджет'));
      const hadCap = room.budget.maxTokens !== null || room.budget.maxCostUsd !== null;
      if (!spendPaused && !hadCap) continue;
      this.update(room.id, {
        paused: spendPaused ? false : room.paused,
        pausedReason: spendPaused ? '' : room.pausedReason,
        budget: {
          ...room.budget,
          maxTokens: null,
          maxCostUsd: null
        }
      });
    }
  }

  pause(room: Room, reason: string): void {
    this.update(room.id, { paused: true, pausedReason: reason });
    this.systemNotice(room.id, `Комната поставлена на паузу: ${reason}. Ответьте, чтобы продолжить.`);
  }

  resume(roomId: string): void {
    this.update(roomId, { paused: false, pausedReason: '' });
  }

  /**
   * Turn policy in one place.
   *
   * mention-only is the default for groups because it makes silence the norm:
   * an agent speaks when addressed, so ten members do not produce ten replies
   * to every message.
   */
  private decideWake(room: Room, message: RoomMessage, fromHuman: boolean): string[] {
    const agents = room.members.filter((m) => m.kind === 'agent').map((m) => m.id);
    const others = agents.filter((id) => id !== message.author.id);
    if (others.length === 0) return [];

    switch (room.turnPolicy) {
      case 'mention-only': {
        const mentioned = message.mentions.filter((id) => others.includes(id));
        // A human writing into a group with nobody mentioned wakes a single
        // agent — the last one who spoke — rather than the whole room.
        if (mentioned.length === 0 && fromHuman) {
          const last = this.lastAgentSpeaker(room.id, others);
          return last ? [last] : others.slice(0, 1);
        }
        return mentioned;
      }
      case 'moderated': {
        if (fromHuman) return room.moderatorId ? [room.moderatorId] : others.slice(0, 1);
        return message.mentions.filter((id) => others.includes(id));
      }
      case 'round-robin': {
        const last = this.lastAgentSpeaker(room.id, agents);
        const index = last ? agents.indexOf(last) : -1;
        const next = agents[(index + 1) % agents.length];
        return next && next !== message.author.id ? [next] : others.slice(0, 1);
      }
      case 'free':
        return others;
      default:
        return [];
    }
  }

  private deriveCausation(isHuman: boolean, parent: RoomMessage | undefined): Causation {
    if (isHuman) {
      // A human message resets the chain: this is what makes the hop limit a
      // guard against agent loops rather than a cap on conversation length.
      return { rootHumanMessageId: null, parentMessageId: parent?.id ?? null, hopCount: 0 };
    }
    if (!parent) return { rootHumanMessageId: null, parentMessageId: null, hopCount: 1 };
    const root =
      parent.author.kind === 'human' ? parent.id : (parent.causation.rootHumanMessageId ?? parent.id);
    return {
      rootHumanMessageId: root,
      parentMessageId: parent.id,
      hopCount: parent.author.kind === 'human' ? 1 : parent.causation.hopCount + 1
    };
  }

  /** Accepts explicit ids plus @handle syntax written in the body. */
  private resolveMentions(room: Room, body: string, explicit: readonly string[]): string[] {
    const memberIds = new Set(room.members.map((m) => m.id));
    const out = new Set<string>();
    for (const id of explicit) {
      if (memberIds.has(id)) out.add(id);
    }
    for (const match of body.matchAll(/@([a-z0-9][a-z0-9._-]{1,40})/gi)) {
      const handle = match[1];
      if (!handle) continue;
      const entry = this.directory.byHandle(handle);
      if (entry && memberIds.has(entry.agentId)) out.add(entry.agentId);
    }
    return [...out];
  }

  private lastAgentSpeaker(roomId: string, candidates: readonly string[]): string | undefined {
    const recent = this.history(roomId, 30).reverse();
    for (const message of recent) {
      if (message.author.kind === 'agent' && candidates.includes(message.author.id)) {
        return message.author.id;
      }
    }
    return undefined;
  }

  private lastMessage(roomId: string): RoomMessage | undefined {
    return this.history(roomId, 1)[0];
  }

  private getMessage(messageId: string): RoomMessage | undefined {
    const row = this.db.get<{ json: string }>('SELECT json FROM messages WHERE id = ?', [messageId]);
    return row ? RoomMessageSchema.parse(JSON.parse(row.json)) : undefined;
  }

  private inferBoardId(agentIds: readonly string[]): string | null {
    const boards = new Set(
      agentIds.map((id) => this.directory.get(id)?.boardId).filter((id): id is string => Boolean(id))
    );
    return boards.size === 1 ? ([...boards][0] ?? null) : null;
  }

  private save(room: Room): void {
    this.db.run(
      'INSERT INTO rooms(id, json, updated_at) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
      [room.id, JSON.stringify(room), room.updatedAt]
    );
    this.onRoom.emit(room);
  }

  private saveMessage(message: RoomMessage): void {
    this.db.run('INSERT INTO messages(id, room_id, created_at, json) VALUES(?, ?, ?, ?)', [
      message.id,
      message.roomId,
      message.createdAt,
      JSON.stringify(message)
    ]);
    this.db.run('INSERT OR REPLACE INTO message_search(message_id, room_id, body_lower) VALUES(?, ?, ?)', [
      message.id,
      message.roomId,
      message.body.toLowerCase()
    ]);
  }
}

function defaultTitle(kind: RoomKind, members: readonly MemberRef[]): string {
  const agents = members.filter((m) => m.kind === 'agent');
  if (kind === 'dm') return agents[0]?.name ?? 'Личный чат';
  if (kind === 'channel') return 'Канал проекта';
  return agents.map((a) => a.name).join(', ') || 'Новая группа';
}
