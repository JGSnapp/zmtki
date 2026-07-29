import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Agent, BoardDoc, CommentThread } from '@zmtki/board-schema';
import type { ChatGptStatusView, Notification, Room } from '@zmtki/protocol';
import { BoardCanvas } from './canvas/BoardCanvas.js';
import { ChatPanel } from './chat/ChatPanel.js';
import { CommentPopover } from './comments/CommentPopover.js';
import { ActivityFeed } from './panels/ActivityFeed.js';
import { AgentBar } from './panels/AgentBar.js';
import { CommandPalette } from './panels/CommandPalette.js';
import { NotificationsPanel } from './panels/NotificationsPanel.js';
import { ProjectRail } from './panels/ProjectRail.js';
import { StylePanel } from './panels/StylePanel.js';
import { Toolbar } from './panels/Toolbar.js';
import { SettingsDialog } from './settings/SettingsDialog.js';
import { useShortcuts } from './hooks/useShortcuts.js';
import { useFollowMode } from './hooks/useFollowMode.js';
import { submit, useStore } from './store.js';
import './artifacts/renderers.js';

function Shell(): JSX.Element {
  useShortcuts();
  useFollowMode();

  return (
    <div className="app">
      <ProjectRail />
      <main className="workspace">
        <AgentBar />
        <div className="stage">
          <Toolbar />
          <BoardCanvas />
          <StylePanel />
          <CommentPopover />
          <ActivityFeed />
        </div>
      </main>
      <ChatPanel />
      <CommandPalette />
      <NotificationsPanel />
      <SettingsDialog />
    </div>
  );
}

export function App(): JSX.Element {
  const handleEvent = useStore((s) => s.handleEvent);

  useEffect(() => {
    const off = window.zmtki.onEvent(handleEvent);

    // Boards were restored by the core before the window existed, so the
    // initial state is pulled rather than waited for.
    void submit<{ boards: Array<{ id: string; path: string }> }>({ type: 'workspace.list' }).then(
      async (result) => {
        if (!result.ok) return;
        for (const board of result.value.boards) {
          const [doc, agents, threads] = await Promise.all([
            submit<BoardDoc>({ type: 'board.get', boardId: board.id }),
            submit<Agent[]>({ type: 'agent.list' }),
            submit<CommentThread[]>({ type: 'comment.list', boardId: board.id })
          ]);
          if (doc.ok) {
            handleEvent({
              id: null,
              msg: { type: 'board.loaded', boardId: board.id, doc: doc.value, path: board.path }
            });
          }
          if (agents.ok) handleEvent({ id: null, msg: { type: 'agent.list', agents: agents.value } });
          if (threads.ok) {
            handleEvent({
              id: null,
              msg: { type: 'comment.threads', boardId: board.id, threads: threads.value }
            });
          }
        }
      }
    );
    void submit<Room[]>({ type: 'room.list' }).then((result) => {
      if (result.ok) handleEvent({ id: null, msg: { type: 'room.list', rooms: result.value } });
    });
    void submit<Notification[]>({ type: 'notification.list', limit: 100 }).then((result) => {
      if (result.ok) useStore.setState({ notifications: result.value });
    });
    void submit<{ focusMode: boolean }>({ type: 'settings.get' }).then((result) => {
      if (result.ok) useStore.setState({ focusMode: result.value.focusMode });
    });
    void submit<ChatGptStatusView>({ type: 'chatgpt.status' }).then((result) => {
      if (result.ok) useStore.setState({ chatgpt: result.value });
    });

    return off;
  }, [handleEvent]);

  // One provider at the root so navigation hooks can move the camera from
  // anywhere, including panels rendered outside the canvas.
  return (
    <ReactFlowProvider>
      <Shell />
    </ReactFlowProvider>
  );
}
