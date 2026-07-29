import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Agent } from '@zmtki/board-schema';
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

function CreateAgentForm({ boardId, onDone }: { boardId: string; onDone: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');

  return (
    <div className="modal-backdrop" onClick={onDone}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Новый агент</h3>
        <label className="field">
          Имя
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: Бэкенд" />
        </label>
        <label className="field">
          Специализация
          <textarea
            rows={4}
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="Чем занимается, какой стек, на что обращать внимание. Это попадёт в системный промпт."
          />
        </label>
        <p className="hint">
          У агента появится рамка на доске. Всё, что окажется внутри неё, он держит в контексте целиком;
          остальную доску видит кратким списком.
        </p>
        <div className="modal-actions">
          <button className="art-btn" onClick={onDone}>
            Отмена
          </button>
          <button
            className="art-btn primary"
            disabled={!name.trim()}
            onClick={async () => {
              await submit({ type: 'agent.create', boardId, name: name.trim(), persona });
              onDone();
            }}
          >
            Создать
          </button>
        </div>
      </div>
    </div>
  );
}

export function AgentBar(): JSX.Element {
  const boardId = useStore((s) => s.activeBoardId);
  const board = useStore((s) => s.activeBoard());
  // Filtering inside a selector builds a new array on every snapshot, which
  // zustand v5 compares by reference — that is an infinite render loop.
  const agents = useStore(useShallow((s) => s.agents.filter((a) => a.homeBoardId === boardId)));
  const headlines = useStore((s) => s.agentHeadlines);
  const followAgentId = useStore((s) => s.followAgentId);
  const setFollow = useStore((s) => s.setFollow);
  const toggleActivity = useStore((s) => s.toggleActivity);
  const toggleNotifications = useStore((s) => s.toggleNotifications);
  const notifications = useStore(useShallow((s) => s.notifications.filter((n) => !n.read)));
  const { focusAgent } = useNavigation();
  const [creating, setCreating] = useState(false);

  const blocking = notifications.filter((n) => n.severity === 'blocking').length;

  return (
    <header className="agent-bar">
      <div className="board-name">{board?.doc.name ?? 'Нет доски'}</div>

      <div className="agent-chips">
        {agents.map((agent, index) => (
          <button
            key={agent.id}
            className={`agent-chip status-${agent.status} ${followAgentId === agent.id ? 'following' : ''}`}
            title={`${STATUS_LABEL[agent.status]}${headlines[agent.id] ? ` — ${headlines[agent.id]}` : ''}\nAlt+${index + 1}`}
            onClick={() => focusAgent(agent.id)}
            onDoubleClick={() => setFollow(followAgentId === agent.id ? null : agent.id)}
          >
            <span className="agent-dot" style={{ background: agent.avatarColor }} />
            <span className="agent-name">{agent.name}</span>
            {STATUS_LABEL[agent.status] && (
              <span className="agent-status">{STATUS_LABEL[agent.status]}</span>
            )}
            {(agent.status === 'running' || agent.status === 'thinking') && <span className="agent-spin" />}
          </button>
        ))}

        {boardId && (
          <button className="agent-chip add" onClick={() => setCreating(true)} title="Новый агент">
            +
          </button>
        )}
      </div>

      <div className="agent-bar-actions">
        {followAgentId && (
          <button className="icon-btn" onClick={() => setFollow(null)} title="Не следить">
            ◎
          </button>
        )}
        <button className="icon-btn" title="Активность" onClick={() => toggleActivity()}>
          ≡
        </button>
        <button className="icon-btn notif" title="Уведомления" onClick={() => toggleNotifications()}>
          ▫
          {notifications.length > 0 && (
            <span className={`badge ${blocking > 0 ? 'blocking' : ''}`}>{notifications.length}</span>
          )}
        </button>
      </div>

      {creating && boardId && <CreateAgentForm boardId={boardId} onDone={() => setCreating(false)} />}
    </header>
  );
}
