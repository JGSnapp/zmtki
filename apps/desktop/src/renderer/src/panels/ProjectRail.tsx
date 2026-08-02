import { useState } from 'react';
import { submit, useStore } from '../store.js';

/**
 * Vertical strip of open projects. Boards stay loaded when switched away from,
 * so their agents keep working in the background — the badge is how you notice.
 */
export function ProjectRail(): JSX.Element {
  const boards = useStore((s) => s.boards);
  const activeBoardId = useStore((s) => s.activeBoardId);
  const setActiveBoard = useStore((s) => s.setActiveBoard);
  const agents = useStore((s) => s.agents);
  const notifications = useStore((s) => s.notifications);
  const scheduler = useStore((s) => s.scheduler);
  const toggleSettings = useStore((s) => s.toggleSettings);
  const [busy, setBusy] = useState(false);

  const openBoard = async (create: boolean): Promise<void> => {
    const folder = await window.zmtki.pickFolder();
    if (!folder) return;
    setBusy(true);
    const name = folder.split(/[\\/]/).pop() ?? 'Доска';
    await submit(
      create
        ? { type: 'workspace.createBoard', path: folder, name }
        : { type: 'workspace.openBoard', path: folder }
    );
    setBusy(false);
  };

  const closeBoard = async (boardId: string, name: string): Promise<void> => {
    const ok = window.confirm(
      `Закрыть проект «${name}»?\nФайлы на диске останутся — можно открыть снова.`
    );
    if (!ok) return;
    setBusy(true);
    await submit({ type: 'workspace.closeBoard', boardId });
    setBusy(false);
  };

  return (
    <nav className="project-rail">
      {[...boards.values()].map((board) => {
        const boardAgents = agents.filter((a) => a.homeBoardId === board.doc.id);
        const running = boardAgents.filter((a) => a.status === 'running' || a.status === 'thinking').length;
        const blocking = notifications.filter(
          (n) => !n.read && n.severity === 'blocking' && n.link.boardId === board.doc.id
        ).length;

        return (
          <div
            key={board.doc.id}
            className={`rail-item ${board.doc.id === activeBoardId ? 'active' : ''}`}
            title={`${board.path}\nПКМ — закрыть проект`}
          >
            <button
              type="button"
              className="rail-item-main"
              onClick={() => setActiveBoard(board.doc.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                void closeBoard(board.doc.id, board.doc.name);
              }}
            >
              <span className="rail-mark">{board.doc.name.slice(0, 2).toUpperCase()}</span>
              <span className="rail-name">{board.doc.name}</span>
              {running > 0 && <span className="rail-running">{running}</span>}
              {blocking > 0 && <span className="rail-blocking">{blocking}</span>}
            </button>
            <button
              type="button"
              className="rail-item-close"
              title="Закрыть проект"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void closeBoard(board.doc.id, board.doc.name);
              }}
            >
              ×
            </button>
          </div>
        );
      })}

      <div className="rail-spacer" />

      <button className="rail-action" disabled={busy} title="Открыть доску" onClick={() => void openBoard(false)}>
        ⌸
      </button>
      <button className="rail-action" disabled={busy} title="Создать доску" onClick={() => void openBoard(true)}>
        +
      </button>
      <button className="rail-action" title="Настройки" onClick={() => toggleSettings(true)}>
        ⚙
      </button>
      <div className="rail-scheduler" title="Одновременных ходов">
        {scheduler.running}/{scheduler.limit}
        {scheduler.queued > 0 && <span className="rail-queued">+{scheduler.queued}</span>}
      </div>
    </nav>
  );
}
