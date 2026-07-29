import { Emitter } from '../util/emitter.js';

export interface QueuedTurn {
  agentId: string;
  boardId: string;
  /** Human-initiated work jumps ahead of agent-initiated work. */
  priority: number;
  run: () => Promise<void>;
}

export interface SchedulerState {
  running: number;
  queued: number;
  limit: number;
}

/**
 * Global cap on concurrent agent turns across every open board.
 *
 * Without one, five open projects with three agents each will happily run
 * fifteen turns at once and saturate both the machine and the API budget. The
 * limit is global rather than per-board because the constraint being protected
 * is global.
 */
export class TurnScheduler {
  readonly onState = new Emitter<SchedulerState>();

  private queue: QueuedTurn[] = [];
  private running = new Map<string, Promise<void>>();
  private limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    this.pump();
    this.emitState();
  }

  get state(): SchedulerState {
    return { running: this.running.size, queued: this.queue.length, limit: this.limit };
  }

  isRunning(agentId: string): boolean {
    return this.running.has(agentId);
  }

  isQueued(agentId: string): boolean {
    return this.queue.some((t) => t.agentId === agentId);
  }

  /**
   * Enqueues a turn. One agent never has two turns in flight — a second request
   * is dropped, because the messages that triggered it are already durable in
   * the agent's inbox and will be read at the start of the next turn.
   */
  enqueue(turn: QueuedTurn): boolean {
    if (this.running.has(turn.agentId) || this.isQueued(turn.agentId)) return false;
    this.queue.push(turn);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.emitState();
    this.pump();
    return true;
  }

  /** Removes queued turns for a board that is being closed. */
  dropBoard(boardId: string): void {
    this.queue = this.queue.filter((t) => t.boardId !== boardId);
    this.emitState();
  }

  dropAgent(agentId: string): void {
    this.queue = this.queue.filter((t) => t.agentId !== agentId);
    this.emitState();
  }

  private pump(): void {
    while (this.running.size < this.limit && this.queue.length > 0) {
      const turn = this.queue.shift();
      if (!turn) break;

      const promise = turn
        .run()
        .catch(() => {
          // Turn errors surface as turn.failed events; the scheduler only cares
          // about the slot being freed.
        })
        .finally(() => {
          this.running.delete(turn.agentId);
          this.emitState();
          this.pump();
        });

      this.running.set(turn.agentId, promise);
    }
    this.emitState();
  }

  private emitState(): void {
    this.onState.emit(this.state);
  }

  async drain(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()]);
    }
  }
}
