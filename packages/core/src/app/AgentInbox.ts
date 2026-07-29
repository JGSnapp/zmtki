import { newId } from '@zmtki/board-schema';
import type { AppDatabase } from './AppDatabase.js';

export type InboxItemKind = 'mention' | 'comment' | 'task' | 'system';

export interface InboxItem {
  id: string;
  agentId: string;
  kind: InboxItemKind;
  /** Human-readable text placed into the agent's next-turn digest. */
  text: string;
  roomId: string | null;
  boardId: string | null;
  nodeId: string | null;
  threadId: string | null;
  fromId: string;
  hops: number;
  createdAt: number;
  delivered: boolean;
}

/**
 * Durable queue per agent.
 *
 * The alternative — starting a turn the moment a mention arrives — loses the
 * message if the app closes first, and produces one turn per mention when three
 * arrive together. Queueing means an agent that is busy or offline still sees
 * everything, batched, at the start of its next turn.
 */
export class AgentInbox {
  constructor(private readonly db: AppDatabase) {}

  push(item: Omit<InboxItem, 'id' | 'createdAt' | 'delivered'>): InboxItem {
    const full: InboxItem = {
      ...item,
      id: newId('message'),
      createdAt: Date.now(),
      delivered: false
    };
    this.db.run('INSERT INTO inbox(id, agent_id, created_at, delivered, json) VALUES(?, ?, ?, 0, ?)', [
      full.id,
      full.agentId,
      full.createdAt,
      JSON.stringify(full)
    ]);
    return full;
  }

  pending(agentId: string): InboxItem[] {
    return this.db
      .all<{ json: string }>(
        'SELECT json FROM inbox WHERE agent_id = ? AND delivered = 0 ORDER BY created_at',
        [agentId]
      )
      .map((row) => JSON.parse(row.json) as InboxItem);
  }

  pendingCount(agentId: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM inbox WHERE agent_id = ? AND delivered = 0',
      [agentId]
    );
    return row?.n ?? 0;
  }

  /**
   * Marks items delivered and returns the digest text. Called at the top of a
   * turn, so a crash mid-turn re-delivers rather than silently dropping.
   */
  drain(agentId: string): { items: InboxItem[]; digest: string } {
    const items = this.pending(agentId);
    if (items.length === 0) return { items, digest: '' };

    this.db.run('UPDATE inbox SET delivered = 1 WHERE agent_id = ? AND delivered = 0', [agentId]);

    const lines = items.map((item) => {
      const where = item.roomId
        ? `комната ${item.roomId}`
        : item.threadId
          ? `тред ${item.threadId} на ${item.nodeId}`
          : 'система';
      return `- [${item.kind}] от ${item.fromId} (${where}): ${item.text}`;
    });

    return {
      items,
      digest: `Пока ты не отвечал, накопилось ${items.length} сообщений:\n${lines.join('\n')}`
    };
  }

  clear(agentId: string): void {
    this.db.run('DELETE FROM inbox WHERE agent_id = ?', [agentId]);
  }

  /** Trims delivered items so the table does not grow without bound. */
  prune(olderThanMs = 7 * 24 * 60 * 60 * 1000): void {
    this.db.run('DELETE FROM inbox WHERE delivered = 1 AND created_at < ?', [Date.now() - olderThanMs]);
  }
}
