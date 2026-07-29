import path from 'node:path';
import { BOARD_DIR } from '@zmtki/board-schema';
import type { ChatMessage } from '../llm/types.js';
import { appendJsonl, ensureDir, readJsonl } from '../util/fs.js';

export interface RolloutEntry {
  ts: number;
  turnId: string;
  message: ChatMessage;
}

const MAX_HISTORY_MESSAGES = 400;
const COMPACT_TARGET = 200;

/**
 * Durable per-agent conversation history, one JSONL file per agent.
 *
 * JSONL rather than a database column because these files are append-only,
 * survive a crash mid-write, and can be read with a text editor when
 * debugging what an agent actually saw.
 */
export class RolloutRecorder {
  private cache = new Map<string, ChatMessage[]>();

  constructor(private readonly boardPath: string) {}

  private fileFor(agentId: string): string {
    return path.join(this.boardPath, BOARD_DIR, 'rollouts', `${agentId}.jsonl`);
  }

  async load(agentId: string): Promise<ChatMessage[]> {
    const cached = this.cache.get(agentId);
    if (cached) return cached;

    const entries = await readJsonl<RolloutEntry>(this.fileFor(agentId));
    const messages = entries.map((e) => e.message);
    this.cache.set(agentId, messages);
    return messages;
  }

  async append(agentId: string, turnId: string, messages: readonly ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const file = this.fileFor(agentId);
    await ensureDir(path.dirname(file));
    const ts = Date.now();
    for (const message of messages) {
      const entry: RolloutEntry = { ts, turnId, message };
      await appendJsonl(file, entry);
    }
    const history = this.cache.get(agentId) ?? [];
    history.push(...messages);
    this.cache.set(agentId, history);
  }

  /**
   * Drops the oldest messages once history grows past the cap, keeping tool
   * results paired with the calls that produced them so the transcript stays
   * valid for every provider.
   */
  compactIfNeeded(agentId: string): ChatMessage[] {
    const history = this.cache.get(agentId);
    if (!history || history.length <= MAX_HISTORY_MESSAGES) return history ?? [];

    let cut = history.length - COMPACT_TARGET;
    while (cut < history.length && history[cut]?.role === 'tool') cut += 1;

    const compacted = history.slice(cut);
    compacted.unshift({
      role: 'system',
      content: `[Ранняя часть диалога свёрнута: ${cut} сообщений. Состояние работы смотри на доске.]`
    });
    this.cache.set(agentId, compacted);
    return compacted;
  }

  clear(agentId: string): void {
    this.cache.delete(agentId);
  }
}
