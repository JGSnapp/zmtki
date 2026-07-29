import { useStore } from '../store.js';
import { useNavigation } from '../hooks/useNavigation.js';

/**
 * Chronological stream of what every agent on every board just did.
 *
 * Necessary because the board is spatial: work happening off-screen, or on a
 * project that is not in front of you, would otherwise be invisible until you
 * went looking for it.
 */
export function ActivityFeed(): JSX.Element | null {
  const open = useStore((s) => s.activityOpen);
  const toggle = useStore((s) => s.toggleActivity);
  const activity = useStore((s) => s.activity);
  const agents = useStore((s) => s.agents);
  const { focusNode, focusAgent } = useNavigation();

  if (!open) return null;

  return (
    <div className="activity-feed">
      <header className="activity-head">
        <h4>Активность</h4>
        <button className="icon-btn" onClick={() => toggle(false)}>
          ×
        </button>
      </header>
      <div className="activity-list">
        {activity.length === 0 && <div className="hint">Агенты ещё ничего не делали.</div>}
        {activity.map((entry, i) => {
          const agent = agents.find((a) => a.id === entry.agentId);
          return (
            <button
              key={`${entry.agentId}-${entry.updatedAt}-${i}`}
              className="activity-row"
              onClick={() => (entry.nodeId ? focusNode(entry.nodeId, entry.boardId) : focusAgent(entry.agentId))}
            >
              <span className="activity-dot" style={{ background: agent?.avatarColor ?? '#4a5268' }} />
              <span className="activity-text">{entry.headline}</span>
              <span className="activity-time">
                {new Date(entry.updatedAt).toLocaleTimeString('ru', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                })}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
