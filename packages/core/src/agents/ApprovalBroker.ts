import { newId } from '@zmtki/board-schema';
import type { ApprovalRequest } from '@zmtki/protocol';
import { Emitter } from '../util/emitter.js';

export interface ApprovalDecision {
  approved: boolean;
  /** Remembers the answer for identical requests for the rest of the session. */
  remember: boolean;
}

export interface ApprovalAskOptions {
  /** When aborted (turn interrupt), the ask resolves as denied. */
  signal?: AbortSignal;
  /** Auto-deny after this many ms so a tool cannot hang forever without UI. */
  timeoutMs?: number;
}

/**
 * Bridges a tool that must block on a human decision and a UI that answers
 * asynchronously. Pending requests survive as promises; the UI resolves them
 * by id, and unanswered ones are denied when the turn is aborted so no tool
 * hangs forever.
 */
export class ApprovalBroker {
  readonly onRequest = new Emitter<ApprovalRequest>();
  readonly onResolved = new Emitter<{ id: string; approved: boolean }>();

  private pending = new Map<string, (decision: ApprovalDecision) => void>();
  private pendingRequests = new Map<string, ApprovalRequest>();
  private remembered = new Map<string, boolean>();

  async ask(
    request: Omit<ApprovalRequest, 'id' | 'createdAt'>,
    opts: ApprovalAskOptions = {}
  ): Promise<boolean> {
    const memoKey = `${request.agentId}:${request.kind}:${request.subject}`;
    const remembered = this.remembered.get(memoKey);
    if (remembered !== undefined) return remembered;

    if (opts.signal?.aborted) return false;

    const id = newId('approval');
    const full: ApprovalRequest = { ...request, id, createdAt: Date.now() };

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const finish = (d: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        this.pendingRequests.delete(id);
        resolve(d);
      };

      const onAbort = () => finish({ approved: false, remember: false });
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      const timer =
        opts.timeoutMs && opts.timeoutMs > 0
          ? setTimeout(() => finish({ approved: false, remember: false }), opts.timeoutMs)
          : null;

      this.pending.set(id, finish);
      this.pendingRequests.set(id, full);
      this.onRequest.emit(full);
    });

    if (decision.remember) this.remembered.set(memoKey, decision.approved);
    this.onResolved.emit({ id, approved: decision.approved });
    return decision.approved;
  }

  resolve(id: string, approved: boolean, remember = false): void {
    const resolver = this.pending.get(id);
    if (!resolver) return;
    resolver({ approved, remember });
  }

  /** Denies everything outstanding, e.g. when the user stops the agent. */
  denyAllFor(predicate: (id: string) => boolean = () => true): void {
    for (const [id, resolver] of [...this.pending.entries()]) {
      if (!predicate(id)) continue;
      resolver({ approved: false, remember: false });
    }
  }

  /** Outstanding asks — used to rehydrate the UI after a renderer reconnect. */
  listPending(): ApprovalRequest[] {
    return [...this.pendingRequests.values()];
  }

  forget(): void {
    this.remembered.clear();
  }
}
