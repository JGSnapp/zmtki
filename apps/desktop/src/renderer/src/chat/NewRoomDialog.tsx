import { useMemo, useState } from 'react';
import type { Room, TurnPolicy } from '@zmtki/protocol';
import { submit, useStore } from '../store.js';

/**
 * Creating a chat and creating a group are the same flow: pick members. The
 * kind follows from how many agents were selected, because asking the user to
 * classify a conversation before having it is friction with no payoff.
 */
export function NewRoomDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const agents = useStore((s) => s.agents);
  const activeBoardId = useStore((s) => s.activeBoardId);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [policy, setPolicy] = useState<TurnPolicy>('mention-only');

  const boardAgents = useMemo(
    () =>
      activeBoardId
        ? agents.filter((a) => a.homeBoardId === activeBoardId)
        : [],
    [agents, activeBoardId]
  );

  const toggle = (agentId: string): void =>
    setSelected((prev) => (prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId]));

  const create = async (): Promise<void> => {
    if (selected.length === 0 || !activeBoardId) return;
    const kind = selected.length === 1 ? 'dm' : 'group';
    const result = await submit<Room>({
      type: 'room.create',
      kind,
      title: title || (selected.length === 1 ? '' : 'Новая группа'),
      memberAgentIds: selected,
      turnPolicy: selected.length === 1 ? 'free' : policy,
      boardId: activeBoardId
    });
    if (result.ok) setActiveRoom(result.value.id);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Новый чат</h3>

        {boardAgents.length === 0 ? (
          <>
            <p className="hint">Сначала создайте агента на этой доске.</p>
            <div className="modal-actions">
              <button className="art-btn" onClick={onClose}>
                Закрыть
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="member-list">
              {boardAgents.map((agent) => (
                <label key={agent.id} className={selected.includes(agent.id) ? 'member on' : 'member'}>
                  <input
                    type="checkbox"
                    checked={selected.includes(agent.id)}
                    onChange={() => toggle(agent.id)}
                  />
                  <span className="member-dot" style={{ background: agent.avatarColor }} />
                  <span className="member-name">{agent.name}</span>
                  <span className="member-handle">@{agent.handle}</span>
                </label>
              ))}
            </div>

            {selected.length > 1 && (
              <>
                <label className="field">
                  Название группы
                  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: Бэкенд" />
                </label>
                <label className="field">
                  Кто говорит
                  <select value={policy} onChange={(e) => setPolicy(e.target.value as TurnPolicy)}>
                    <option value="mention-only">Только по @упоминанию</option>
                    <option value="moderated">Через модератора</option>
                    <option value="round-robin">По очереди</option>
                    <option value="free">Свободно</option>
                  </select>
                </label>
                <p className="hint">
                  «Свободно» означает, что на каждое сообщение ответят все агенты сразу. Для групп это
                  быстро съедает бюджет — лучше начать с @упоминаний.
                </p>
              </>
            )}

            <div className="modal-actions">
              <button className="art-btn" onClick={onClose}>
                Отмена
              </button>
              <button className="art-btn primary" disabled={selected.length === 0} onClick={() => void create()}>
                Создать
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
