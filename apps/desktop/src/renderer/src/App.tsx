import { useEffect, useState } from 'react';
import { BoardCanvas } from './canvas/BoardCanvas';
import { AgentsPanel } from './panels/AgentsPanel';
import { Inspector } from './panels/Inspector';
import { Toolbar } from './panels/Toolbar';
import { api, useStore } from './state/store';

const Toast = () => {
  const toast = useStore((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  if (!toast || !visible) return null;
  return <div className="toast">{toast.text}</div>;
};

export const App = () => {
  const board = useStore((s) => s.board);

  useEffect(() => {
    const { init, applyBoardEvent, applyAgentEvent, notify } = useStore.getState();
    const offBoard = api.boards.onChanged((event) => applyBoardEvent(event));
    const offAgents = api.agents.onEvent((event) => applyAgentEvent(event));
    init().catch((error: unknown) => notify(error instanceof Error ? error.message : String(error)));
    return () => {
      offBoard();
      offAgents();
    };
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <main className="workspace">
        {/* Keyed by board: a camera, an index and gesture state belong to one board. */}
        <div className="canvas-column">
          {board ? <BoardCanvas key={board.id} board={board} /> : <div className="loading">Загрузка…</div>}
          <Inspector />
        </div>
        <AgentsPanel />
      </main>
      <Toast />
    </div>
  );
};
