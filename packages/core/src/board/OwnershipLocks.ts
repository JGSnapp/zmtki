import type { BoardNode, NodeLock } from '@zmtki/board-schema';

export type LockAction = 'delete' | 'move' | 'edit';

export interface LockDecision {
  ok: boolean;
  reason?: string;
  needsApproval?: boolean;
}

/**
 * Enforces ownership locks so agents cannot wipe or shove human work,
 * and soft-holds prevent two agents editing the same node.
 */
export function checkNodeAction(
  node: BoardNode,
  agentId: string,
  action: LockAction
): LockDecision {
  const lock: NodeLock = node.lock ?? { delete: false, move: false, edit: false };

  if (lock.heldBy && lock.heldBy !== agentId) {
    if (!lock.heldUntil || lock.heldUntil > Date.now()) {
      return {
        ok: false,
        reason: `узел удерживает агент ${lock.heldBy}`,
        needsApproval: true
      };
    }
  }

  const ownedBySelf =
    node.owner?.kind === 'agent' && node.owner.id === agentId
      ? true
      : node.createdBy === agentId;

  if (ownedBySelf && !lock[action]) {
    return { ok: true };
  }

  if (lock[action]) {
    return {
      ok: false,
      reason: `узел защищён от ${action} (owner: ${node.owner?.kind ?? 'unknown'})`,
      needsApproval: true
    };
  }

  // Foreign agent touching unlocked agent content — soft warn via approval for edit/delete
  if (!ownedBySelf && action !== 'move' && node.owner?.kind === 'agent') {
    return {
      ok: false,
      reason: `узел принадлежит другому агенту (${node.owner.id})`,
      needsApproval: true
    };
  }

  return { ok: true };
}

export function withHeldBy(node: BoardNode, agentId: string, ms = 120_000): NodeLock {
  return {
    ...(node.lock ?? { delete: false, move: false, edit: false }),
    heldBy: agentId,
    heldUntil: Date.now() + ms
  };
}

export function clearHeldBy(node: BoardNode): NodeLock {
  const lock = { ...(node.lock ?? { delete: false, move: false, edit: false }) };
  delete lock.heldBy;
  delete lock.heldUntil;
  return lock;
}
