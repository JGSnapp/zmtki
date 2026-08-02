import { useEffect } from 'react';
import { submit, useStore, type ToolName } from '../store.js';
import { useNavigation } from './useNavigation.js';

const TOOL_KEYS: Record<string, ToolName> = {
  v: 'select',
  h: 'hand',
  s: 'sticky',
  t: 'text',
  r: 'rect',
  o: 'ellipse',
  d: 'diamond',
  a: 'arrow',
  p: 'draw',
  f: 'frame',
  c: 'comment'
};

function isEditableElement(element: EventTarget | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') {
    return true;
  }
  if (element.isContentEditable) return true;
  return Boolean(element.closest('input, textarea, select, [contenteditable="true"]'));
}

/** True when a text field has focus, or when a modal/dialog owns the keyboard. */
function shouldIgnoreToolKeys(target: EventTarget | null): boolean {
  if (isEditableElement(target) || isEditableElement(document.activeElement)) return true;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest('.modal-backdrop, .modal, .palette-box, .drawer')) {
    return true;
  }
  if (target instanceof HTMLElement && target.closest('.modal-backdrop, .modal, .palette-box, .drawer')) {
    return true;
  }
  return Boolean(document.querySelector('.modal-backdrop'));
}

/**
 * Global keyboard map. Single letters pick tools, which is only safe because
 * every text field and modal is excluded first.
 */
export function useShortcuts(): void {
  const { focusAgent, back } = useNavigation();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const state = useStore.getState();
      const mod = event.ctrlKey || event.metaKey;

      if (mod && event.key.toLowerCase() === 'k') {
        if (shouldIgnoreToolKeys(event.target)) return;
        event.preventDefault();
        state.togglePalette();
        return;
      }

      if (event.key === 'Escape') {
        state.togglePalette(false);
        state.toggleSettings(false);
        state.toggleNotifications(false);
        state.setCommentTarget(null);
        state.setEditingNode(null);
        return;
      }

      if (shouldIgnoreToolKeys(event.target) || useStore.getState().overlayOpen) return;

      // Alt+1..9 jumps to the nth agent of the active board, which is the
      // fastest way to move between working areas.
      if (event.altKey && /^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        const agent = state.agents.filter((a) => a.homeBoardId === state.activeBoardId)[index];
        if (agent) {
          event.preventDefault();
          focusAgent(agent.id);
        }
        return;
      }

      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        const boardId = state.activeBoardId;
        if (!boardId) return;
        void submit(event.shiftKey ? { type: 'board.redo', boardId } : { type: 'board.undo', boardId });
        return;
      }

      if (mod && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        state.togglePalette(true);
        return;
      }

      if (mod) return;

      if (event.key === 'Backspace' && state.selection.length === 0) {
        event.preventDefault();
        back();
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && state.selection.length > 0) {
        const boardId = state.activeBoardId;
        if (!boardId) return;
        event.preventDefault();
        void submit({
          type: 'board.apply',
          boardId,
          label: 'Удаление',
          ops: state.selection.map((id) => ({ op: 'removeNode' as const, id }))
        });
        state.setSelection([]);
        return;
      }

      const tool = TOOL_KEYS[event.key.toLowerCase()];
      if (tool) {
        event.preventDefault();
        state.setTool(tool);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [back, focusAgent]);
}
