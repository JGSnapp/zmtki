import { useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Camera } from '@zmtki/board-schema';
import { submit, useStore } from '../store.js';

export interface Navigation {
  focusNode(nodeId: string, boardId?: string): void;
  focusAgent(agentId: string): void;
  focusRect(rect: { x: number; y: number; w: number; h: number }): void;
  back(): void;
}

/**
 * Camera movement, in one place so every entry point — palette, notification
 * deep link, follow mode, activity feed — lands the same way and records the
 * previous position so Backspace returns.
 */
export function useNavigation(): Navigation {
  const flow = useReactFlow();

  const focusRect = useCallback(
    (rect: { x: number; y: number; w: number; h: number }) => {
      // Read the live viewport rather than the store: the store copy is only
      // refreshed when panning settles, so it lags behind during a drag.
      useStore.getState().pushCamera(flow.getViewport());

      void flow.fitBounds(
        { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
        { padding: 0.35, duration: 420 }
      );
    },
    [flow]
  );

  const focusNode = useCallback(
    (nodeId: string, boardId?: string) => {
      const state = useStore.getState();
      if (boardId && boardId !== state.activeBoardId && state.boards.has(boardId)) {
        state.setActiveBoard(boardId);
      }
      // The board may have just been switched, so the node is looked up after.
      const board = useStore.getState().activeBoard();
      const node = board?.nodes.get(nodeId);
      if (!node) return;
      useStore.getState().setSelection([nodeId]);
      focusRect({ x: node.position.x, y: node.position.y, w: node.size.w, h: node.size.h });
    },
    [focusRect]
  );

  const focusAgent = useCallback(
    (agentId: string) => {
      const state = useStore.getState();
      const agent = state.agents.find((a) => a.id === agentId);
      if (!agent) return;
      if (agent.homeBoardId !== state.activeBoardId && state.boards.has(agent.homeBoardId)) {
        state.setActiveBoard(agent.homeBoardId);
      }
      const board = useStore.getState().activeBoard();
      const frame = [...(board?.nodes.values() ?? [])].find(
        (node) => node.type === 'frame' && node.agentId === agentId
      );
      if (!frame) return;
      focusRect({ x: frame.position.x, y: frame.position.y, w: frame.size.w, h: frame.size.h });

      const room = useStore
        .getState()
        .rooms.find((r) => r.kind === 'dm' && r.members.some((m) => m.id === agentId));
      if (room) useStore.getState().setActiveRoom(room.id);
    },
    [focusRect]
  );

  const back = useCallback(() => {
    const camera: Camera | null = useStore.getState().popCamera();
    if (!camera) return;
    void flow.setViewport(camera, { duration: 320 });
    const boardId = useStore.getState().activeBoardId;
    if (boardId) void submit({ type: 'camera.set', boardId, camera });
  }, [flow]);

  return { focusNode, focusAgent, focusRect, back };
}
