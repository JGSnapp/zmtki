import { useEffect, useRef } from 'react';
import { useStore } from '../store.js';
import { useNavigation } from './useNavigation.js';

/**
 * Keeps the camera on an agent as it works.
 *
 * Watching an agent build something is the clearest way to understand what it
 * is doing, but chasing every artifact would be nauseating — so the camera only
 * moves when the agent creates something new, and only if the agent's own
 * frame moved or grew.
 *
 * Subscribes imperatively rather than through a selector: this hook renders
 * nothing, and it is called from the app shell, so a selector here would
 * re-render every panel in the window on every board change.
 */
export function useFollowMode(): void {
  const { focusRect } = useNavigation();
  const followed = useRef<{ agentId: string | null; signature: string }>({
    agentId: null,
    signature: ''
  });

  useEffect(
    () =>
      useStore.subscribe((state) => {
        const agentId = state.followAgentId;
        if (followed.current.agentId !== agentId) {
          followed.current = { agentId, signature: '' };
        }
        if (!agentId) return;

        const board = state.activeBoardId ? state.boards.get(state.activeBoardId) : undefined;
        if (!board) return;

        let frame: { position: { x: number; y: number }; size: { w: number; h: number }; id: string } | null = null;
        for (const node of board.nodes.values()) {
          if (node.type === 'frame' && node.agentId === agentId) {
            frame = node;
            break;
          }
        }
        if (!frame) return;

        let inside = 0;
        for (const node of board.nodes.values()) {
          if (
            node.id !== frame.id &&
            node.position.x >= frame.position.x &&
            node.position.y >= frame.position.y &&
            node.position.x <= frame.position.x + frame.size.w &&
            node.position.y <= frame.position.y + frame.size.h
          ) {
            inside += 1;
          }
        }

        const signature = `${frame.position.x},${frame.position.y},${frame.size.w},${frame.size.h},${inside}`;
        if (signature === followed.current.signature) return;
        followed.current.signature = signature;

        focusRect({ x: frame.position.x, y: frame.position.y, w: frame.size.w, h: frame.size.h });
      }),
    [focusRect]
  );
}
