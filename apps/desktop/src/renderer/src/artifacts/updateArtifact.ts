import { submit, useStore } from '../store.js';

/** Patch fields on an artifact node from a human edit on the board. */
export function updateArtifact(
  nodeId: string,
  patch: Record<string, unknown>,
  label = 'Правка артефакта'
): void {
  const boardId = useStore.getState().activeBoardId;
  if (!boardId) return;
  void submit({
    type: 'board.apply',
    boardId,
    label,
    ops: [{ op: 'updateNode', id: nodeId, patch: { artifact: patch } }]
  });
}
