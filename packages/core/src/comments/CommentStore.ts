import path from 'node:path';
import {
  BOARD_DIR,
  CommentFileSchema,
  extractMentions,
  newId,
  type AuthorRef,
  type Comment,
  type CommentThread
} from '@zmtki/board-schema';
import { Emitter } from '../util/emitter.js';
import { debounceWithMaxWait } from '../util/async.js';
import { readJsonIfExists, writeFileAtomic } from '../util/fs.js';

export interface AddCommentInput {
  nodeId: string;
  body: string;
  author: AuthorRef;
  /** Point inside the artifact, in node-local coordinates. */
  anchor?: { x: number; y: number } | null;
  threadId?: string | null;
}

/**
 * Comment threads anchored to board nodes, in the Google Docs sense: they live
 * beside the content rather than inside it.
 *
 * Stored in the board folder so they travel with the project and diff in git,
 * separately from board.zmtki.json to keep discussion churn out of the
 * document's history.
 */
export class CommentStore {
  readonly onChange = new Emitter<CommentThread[]>();

  private threads = new Map<string, CommentThread>();
  private saver: ReturnType<typeof debounceWithMaxWait>;

  constructor(private readonly boardPath: string) {
    this.saver = debounceWithMaxWait(() => this.write(), 400, 2500);
  }

  private get file(): string {
    return path.join(this.boardPath, BOARD_DIR, 'comments.json');
  }

  async load(): Promise<void> {
    const raw = await readJsonIfExists<unknown>(this.file);
    if (!raw) return;
    const parsed = CommentFileSchema.safeParse(raw);
    if (!parsed.success) return;
    this.threads = new Map(parsed.data.threads.map((t) => [t.id, t]));
    this.onChange.emit(this.list());
  }

  list(): CommentThread[] {
    return [...this.threads.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  forNode(nodeId: string): CommentThread[] {
    return this.list().filter((t) => t.nodeId === nodeId);
  }

  unresolvedCount(): number {
    return this.list().filter((t) => !t.resolved).length;
  }

  /**
   * Adds a comment and returns the agents that must see it.
   *
   * Mentions are recorded as pendingDelivery rather than pushed immediately: an
   * agent should read the whole thread as it stands when its turn starts, not a
   * snapshot from the moment of the mention.
   */
  add(input: AddCommentInput, resolveHandle: (handle: string) => string | undefined): {
    thread: CommentThread;
    mentioned: string[];
  } {
    const now = Date.now();
    const mentioned = extractMentions(input.body, resolveHandle);

    const comment: Comment = {
      id: newId('comment'),
      author: input.author,
      body: input.body,
      mentions: mentioned,
      createdAt: now
    };

    const existing = input.threadId ? this.threads.get(input.threadId) : undefined;
    const thread: CommentThread = existing
      ? {
          ...existing,
          comments: [...existing.comments, comment],
          updatedAt: now,
          pendingDelivery: [...new Set([...existing.pendingDelivery, ...mentioned])]
        }
      : {
          id: newId('thread'),
          nodeId: input.nodeId,
          anchor: input.anchor ?? null,
          comments: [comment],
          resolved: false,
          createdAt: now,
          updatedAt: now,
          pendingDelivery: mentioned
        };

    this.threads.set(thread.id, thread);
    this.saver.schedule();
    this.onChange.emit(this.list());
    return { thread, mentioned };
  }

  resolve(threadId: string, resolved: boolean): CommentThread | undefined {
    const thread = this.threads.get(threadId);
    if (!thread) return undefined;
    const next: CommentThread = { ...thread, resolved, updatedAt: Date.now() };
    this.threads.set(threadId, next);
    this.saver.schedule();
    this.onChange.emit(this.list());
    return next;
  }

  remove(threadId: string): void {
    if (!this.threads.delete(threadId)) return;
    this.saver.schedule();
    this.onChange.emit(this.list());
  }

  /** Threads waiting on a given agent, for the next-turn context. */
  pendingFor(agentId: string): CommentThread[] {
    return this.list().filter((t) => !t.resolved && t.pendingDelivery.includes(agentId));
  }

  /** Clears the pending flag once the thread has been shown to the agent. */
  markDelivered(agentId: string): void {
    let changed = false;
    for (const [id, thread] of this.threads) {
      if (!thread.pendingDelivery.includes(agentId)) continue;
      this.threads.set(id, {
        ...thread,
        pendingDelivery: thread.pendingDelivery.filter((a) => a !== agentId)
      });
      changed = true;
    }
    if (changed) this.saver.schedule();
  }

  /** Drops threads whose node no longer exists. */
  pruneOrphans(existingNodeIds: ReadonlySet<string>): void {
    let changed = false;
    for (const [id, thread] of this.threads) {
      if (existingNodeIds.has(thread.nodeId)) continue;
      this.threads.delete(id);
      changed = true;
    }
    if (changed) {
      this.saver.schedule();
      this.onChange.emit(this.list());
    }
  }

  async flush(): Promise<void> {
    await this.saver.flush();
  }

  private async write(): Promise<void> {
    const payload = CommentFileSchema.parse({ version: 1, threads: this.list() });
    await writeFileAtomic(this.file, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
