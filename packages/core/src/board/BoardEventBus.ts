import type { BoardSpatialEvent } from '@zmtki/protocol';
import { Emitter } from '../util/emitter.js';

export interface AgentSubscription {
  agentId: string;
  event: string;
  filter?: Record<string, unknown>;
}

/**
 * Spatial / lifecycle events on a board. Agents subscribe; Workspace wakes them.
 */
export class BoardEventBus {
  readonly onEvent = new Emitter<{ boardId: string; event: BoardSpatialEvent }>();

  private subscriptions = new Map<string, AgentSubscription[]>();

  setSubscriptions(boardId: string, list: AgentSubscription[]): void {
    this.subscriptions.set(boardId, list);
  }

  getSubscriptions(boardId: string): AgentSubscription[] {
    return this.subscriptions.get(boardId) ?? [];
  }

  addSubscription(boardId: string, sub: AgentSubscription): void {
    const list = this.getSubscriptions(boardId).filter(
      (s) => !(s.agentId === sub.agentId && s.event === sub.event)
    );
    list.push(sub);
    this.subscriptions.set(boardId, list);
  }

  removeSubscription(boardId: string, agentId: string, event: string): void {
    this.subscriptions.set(
      boardId,
      this.getSubscriptions(boardId).filter((s) => !(s.agentId === agentId && s.event === event))
    );
  }

  emit(boardId: string, event: BoardSpatialEvent): string[] {
    this.onEvent.emit({ boardId, event });
    const wake: string[] = [];
    for (const sub of this.getSubscriptions(boardId)) {
      if (sub.event !== '*' && sub.event !== event.type) continue;
      if (sub.filter?.frameId && sub.filter.frameId !== event.frameId) continue;
      if (sub.filter?.nodeId && sub.filter.nodeId !== event.nodeId) continue;
      if (!wake.includes(sub.agentId)) wake.push(sub.agentId);
    }
    // Always notify the frame's agent on frame membership events
    if (event.agentId && !wake.includes(event.agentId)) {
      if (
        event.type === 'human.moved_into_frame' ||
        event.type === 'human.moved_out_of_frame' ||
        event.type === 'artifact.control_invoked'
      ) {
        wake.push(event.agentId);
      }
    }
    return wake;
  }
}
