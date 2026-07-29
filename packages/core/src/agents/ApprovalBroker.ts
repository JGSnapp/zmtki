import { newId } from '@zmtki/board-schema';
import type { ApprovalRequest } from '@zmtki/protocol';
import { Emitter } from '../util/emitter.js';

export interface ApprovalDecision {
  approved: boolean;
  /** Remembers the answer for identical requests for the rest of the session. */
  remember: boolean;
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
  private remembered = new Map<string, boolean>();

  async ask(request: Omit<ApprovalRequest, 'id' | 'createdAt'>): Promise<boolean> {
    const memoKey = `${request.agentId}:${request.kind}:${request.subject}`;
    const remembered = this.remembered.get(memoKey);
    if (remembered !== undefined) return remembered;

    const id = newId('approval');

    const full: ApprovalRequest = { ...request, id, createdAt: Date.now() };

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(id, resolve);
      this.onRequest.emit(full);
    });

    if (decision.remember) this.remembered.set(memoKey, decision.approved);
    this.onResolved.emit({ id, approved: decision.approved });
    return decision.approved;
  }

  resolve(id: string, approved: boolean, remember = false): void {
    const resolver = this.pending.get(id);
    if (!resolver) return;
    this.pending.delete(id);
    resolver({ approved, remember });
  }

  /** Denies everything outstanding, e.g. when the user stops the agent. */
  denyAllFor(predicate: (id: string) => boolean = () => true): void {
    for (const [id, resolver] of [...this.pending.entries()]) {
      if (!predicate(id)) continue;
      this.pending.delete(id);
      resolver({ approved: false, remember: false });
    }
  }

  forget(): void {
    this.remembered.clear();
  }
}
