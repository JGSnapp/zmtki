import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import type { Agent } from '@zmtki/board-schema';
import { setAgentDragData } from '../agents/drag.js';
import { submit, useStore } from '../store.js';
import { useNavigation } from '../hooks/useNavigation.js';

const STATUS_LABEL: Record<Agent['status'], string> = {
  idle: '',
  thinking: '…',
  running: '…',
  waitingApproval: '!',
  waitingInput: '?',
  paused: '‖',
  error: '×'
};

type BridgeKind = 'builtin' | 'mcp' | 'command';

type McpServerRow = { name: string; status: string; toolCount: number };

function CreateAgentForm({ boardId, onDone }: { boardId: string; onDone: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const [bridgeKind, setBridgeKind] = useState<BridgeKind>('builtin');
  const [mcpServer, setMcpServer] = useState('');
  const [mcpTool, setMcpTool] = useState('');
  const [command, setCommand] = useState('claude -p "{message}"');
  const [mcpServers, setMcpServers] = useState<McpServerRow[]>([]);
  const nameRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const setOverlayOpen = useStore((s) => s.setOverlayOpen);
  const setSelection = useStore((s) => s.setSelection);

  useEffect(() => {
    void submit<{ mcpServers: McpServerRow[] }>({ type: 'extensions.list' }).then((res) => {
      if (res.ok && res.value?.mcpServers) setMcpServers(res.value.mcpServers);
    });
  }, []);

  useEffect(() => {
    // Board reclaims keyboard focus after agent/frame deletion (exit animation /
    // React Flow pane). Hold the dialog open and pull focus back if it escapes.
    setOverlayOpen(true);
    setSelection([]);
    // Drop keyboard focus from the React Flow pane (often reclaiming it after
    // a frame was deleted and exit animation ran).
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.react-flow')) {
      active.blur();
    }

    const focusName = (): void => {
      const input = nameRef.current;
      const modal = modalRef.current;
      if (!input) return;
      const active = document.activeElement;
      if (active === input) return;
      if (active instanceof HTMLElement && modal?.contains(active)) {
        const tag = active.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
      }
      input.focus({ preventScroll: true });
    };

    focusName();
    const timers = [0, 50, 150, 400, 800].map((ms) => window.setTimeout(focusName, ms));
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (target instanceof Node && modalRef.current?.contains(target)) return;
      focusName();
    };
    document.addEventListener('focusin', onFocusIn);

    return () => {
      setOverlayOpen(false);
      for (const id of timers) window.clearTimeout(id);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [setOverlayOpen, setSelection]);

  return createPortal(
    <div className="modal-backdrop" onClick={onDone}>
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Новый агент"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => {
          e.stopPropagation();
          const t = e.target as HTMLElement | null;
          if (t?.closest('input, textarea, select, button')) return;
          nameRef.current?.focus({ preventScroll: true });
        }}
        onKeyDown={(e) => {
          // Bubble only — after the input handled the key — so board hotkeys
          // on window never see letters typed into this dialog.
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            onDone();
          }
        }}
      >
        <h3>Новый агент</h3>
        <label className="field">
          Имя
          <input
            ref={nameRef}
            type="text"
            name="agent-name"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Например: Бэкенд"
          />
        </label>
        <label className="field">
          Тип
          <select value={bridgeKind} onChange={(e) => setBridgeKind(e.target.value as BridgeKind)}>
            <option value="builtin">Встроенный (LLM на доске)</option>
            <option value="mcp">Внешний через MCP</option>
            <option value="command">Внешний через CLI</option>
          </select>
        </label>
        {bridgeKind === 'builtin' && (
          <label className="field">
            Специализация
            <textarea
              rows={4}
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              placeholder="Чем занимается, какой стек, на что обращать внимание. Это попадёт в системный промпт."
            />
          </label>
        )}
        {bridgeKind === 'mcp' && (
          <>
            <label className="field">
              MCP-сервер
              <select value={mcpServer} onChange={(e) => setMcpServer(e.target.value)}>
                <option value="">Выберите сервер…</option>
                {mcpServers.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name} ({s.status}, tools: {s.toolCount})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Инструмент (опционально)
              <input
                value={mcpTool}
                onChange={(e) => setMcpTool(e.target.value)}
                placeholder="пусто = auto (chat/ask/prompt…)"
              />
            </label>
            <p className="hint">
              Сообщения из чата уходят в MCP-инструмент. Добавь сервер в Настройки → Расширения (Claude Code,
              Cursor bridge и т.п.).
            </p>
          </>
        )}
        {bridgeKind === 'command' && (
          <>
            <label className="field">
              Команда
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder='claude -p "{message}"'
              />
            </label>
            <p className="hint">
              Плейсхолдер {'{message}'} подставит текст из чата. Пример: <code>claude -p &quot;{'{message}'}&quot;</code> или
              вызов Cursor CLI.
            </p>
          </>
        )}
        {bridgeKind === 'builtin' && (
          <p className="hint">
            У агента появится рамка на доске. Всё, что окажется внутри неё, он держит в контексте целиком;
            остальную доску видит кратким списком.
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="art-btn" onClick={onDone}>
            Отмена
          </button>
          <button
            type="button"
            className="art-btn primary"
            disabled={!name.trim() || (bridgeKind === 'mcp' && !mcpServer)}
            onClick={async () => {
              await submit({
                type: 'agent.create',
                boardId,
                name: name.trim(),
                persona,
                bridge: {
                  kind: bridgeKind,
                  mcpServer,
                  mcpTool,
                  command: bridgeKind === 'command' ? command : ''
                }
              });
              onDone();
            }}
          >
            Создать
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function agentOnBoard(
  agent: Agent,
  board: { nodes: Map<string, { type: string; agentId?: string | null }> } | undefined
): boolean {
  if (!board) return false;
  if (agent.frameNodeId && board.nodes.has(agent.frameNodeId)) return true;
  return [...board.nodes.values()].some((n) => n.type === 'frame' && n.agentId === agent.id);
}

export function AgentBar(): JSX.Element {
  const boardId = useStore((s) => s.activeBoardId);
  const board = useStore((s) => s.activeBoard());
  const agents = useStore(useShallow((s) => s.agents.filter((a) => a.homeBoardId === boardId)));
  const headlines = useStore((s) => s.agentHeadlines);
  const followAgentId = useStore((s) => s.followAgentId);
  const setFollow = useStore((s) => s.setFollow);
  const activeRoomId = useStore((s) => s.activeRoomId);
  const rooms = useStore((s) => s.rooms);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const toggleActivity = useStore((s) => s.toggleActivity);
  const toggleNotifications = useStore((s) => s.toggleNotifications);
  const notifications = useStore(useShallow((s) => s.notifications.filter((n) => !n.read)));
  const { focusAgent } = useNavigation();
  const [creating, setCreating] = useState(false);

  const blocking = notifications.filter((n) => n.severity === 'blocking').length;

  const detachFromBoard = async (agent: Agent): Promise<void> => {
    if (!agentOnBoard(agent, board)) return;
    await submit({ type: 'agent.detachFrame', agentId: agent.id });
  };

  const deleteAgent = async (agent: Agent): Promise<void> => {
    const ok = window.confirm(
      `Удалить агента «${agent.name}» полностью?\nЛичный чат тоже исчезнет.`
    );
    if (!ok) return;
    if (followAgentId === agent.id) setFollow(null);
    const room = rooms.find(
      (r) => r.kind === 'dm' && r.members.some((m) => m.id === agent.id)
    );
    if (room && activeRoomId === room.id) setActiveRoom(null);
    const frameId = agent.frameNodeId;
    const result = await submit({ type: 'agent.delete', agentId: agent.id });
    if (!result.ok) {
      window.alert(result.error || 'Не удалось удалить агента');
      return;
    }
    // Optimistic remove if the agent.list event is delayed. Also drop selection
    // of the vanished frame so React Flow doesn't keep keyboard focus on it.
    useStore.setState((s) => ({
      agents: s.agents.filter((a) => a.id !== agent.id),
      selection: s.selection.filter((id) => id !== frameId),
      editingNodeId: s.editingNodeId === frameId ? null : s.editingNodeId
    }));
  };

  return (
    <header className="agent-bar">
      <div className="board-name">{board?.doc.name ?? 'Нет доски'}</div>

      <div className="agent-chips">
        {agents.map((agent, index) => {
          const onBoard = agentOnBoard(agent, board);
          const bridge = agent.bridge?.kind && agent.bridge.kind !== 'builtin' ? agent.bridge.kind : null;
          return (
            <div
              key={agent.id}
              className={`agent-chip status-${agent.status} ${followAgentId === agent.id ? 'following' : ''} ${onBoard ? '' : 'off-board'}`}
              title={`${STATUS_LABEL[agent.status]}${headlines[agent.id] ? ` — ${headlines[agent.id]}` : ''}${bridge ? `\n[${bridge}]` : ''}\nAlt+${index + 1}${
                onBoard
                  ? '\n↓ — убрать с доски\n× — удалить агента'
                  : '\nКлик или перетащите — вернуть на доску\n× — удалить агента'
              }`}
              draggable
              onDragStart={(e) => {
                // Don't start a drag from the action buttons.
                const t = e.target as HTMLElement | null;
                if (t?.closest('.agent-chip-delete, .agent-chip-detach')) {
                  e.preventDefault();
                  return;
                }
                e.dataTransfer.setDragImage(e.currentTarget, 16, 16);
                setAgentDragData(e, agent.id);
              }}
            >
              <button
                type="button"
                className="agent-chip-main"
                onClick={() => {
                  const room = rooms.find(
                    (r) => r.kind === 'dm' && r.members.some((m) => m.id === agent.id)
                  );
                  if (room) setActiveRoom(room.id);
                  if (onBoard) {
                    setFollow(agent.id);
                    focusAgent(agent.id);
                    return;
                  }
                  // Frame was removed — put the agent back on the board.
                  if (boardId) {
                    void submit({ type: 'agent.placeFrame', agentId: agent.id }).then(() => {
                      setFollow(agent.id);
                      focusAgent(agent.id);
                    });
                  }
                }}
              >
                <span className="agent-dot" style={{ background: agent.avatarColor }} />
                <span className="agent-name">
                  {agent.name}
                  {bridge ? ` · ${bridge}` : ''}
                </span>
                {STATUS_LABEL[agent.status] && (
                  <span className="agent-status">{STATUS_LABEL[agent.status]}</span>
                )}
                {(agent.status === 'thinking' || agent.status === 'running') && (
                  <span className="agent-spin" />
                )}
              </button>
              {onBoard && (
                <button
                  type="button"
                  className="agent-chip-detach"
                  title="Убрать с доски"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    void detachFromBoard(agent);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  ↓
                </button>
              )}
              <button
                type="button"
                className="agent-chip-delete"
                title="Удалить агента"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  void deleteAgent(agent);
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="agent-chip add"
          disabled={!boardId}
          onClick={() => {
            useStore.getState().setSelection([]);
            setCreating(true);
          }}
          title="Новый агент"
        >
          +
        </button>
      </div>

      <div className="agent-bar-actions">
        <button className="icon-btn" onClick={toggleActivity} title="Активность">
          ◬
        </button>
        <button className="icon-btn" onClick={toggleNotifications} title="Уведомления">
          ⌂{blocking > 0 && <b className="icon-badge">{blocking}</b>}
        </button>
      </div>

      {creating && boardId && <CreateAgentForm boardId={boardId} onDone={() => setCreating(false)} />}
    </header>
  );
}
