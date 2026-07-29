import type { Notification, Severity } from '@zmtki/protocol';
import { submit, useStore } from '../store.js';
import { useNavigation } from '../hooks/useNavigation.js';

const SEVERITY_ORDER: Severity[] = ['blocking', 'attention', 'info'];
const SEVERITY_LABEL: Record<Severity, string> = {
  blocking: 'Требуют вас',
  attention: 'Стоит взглянуть',
  info: 'Фоном'
};

export function NotificationsPanel(): JSX.Element | null {
  const open = useStore((s) => s.notificationsOpen);
  const toggle = useStore((s) => s.toggleNotifications);
  const notifications = useStore((s) => s.notifications);
  const focusMode = useStore((s) => s.focusMode);
  const { focusNode, focusAgent } = useNavigation();

  if (!open) return null;

  const jump = (notification: Notification): void => {
    const { link } = notification;
    if (link.nodeId) focusNode(link.nodeId, link.boardId ?? undefined);
    else if (link.agentId) focusAgent(link.agentId);
    if (link.roomId) useStore.getState().setActiveRoom(link.roomId);
    void submit({ type: 'notification.markRead', id: notification.id });
  };

  const grouped = SEVERITY_ORDER.map((severity) => ({
    severity,
    items: notifications.filter((n) => n.severity === severity)
  })).filter((group) => group.items.length > 0);

  return (
    <div className="drawer" onClick={() => toggle(false)}>
      <div className="drawer-body" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h3>Уведомления</h3>
          <label className="focus-toggle">
            <input
              type="checkbox"
              checked={focusMode}
              onChange={(e) => {
                useStore.setState({ focusMode: e.target.checked });
                void submit({ type: 'notification.setFocusMode', enabled: e.target.checked });
              }}
            />
            Не отвлекать
          </label>
          <button className="link-btn" onClick={() => void submit({ type: 'notification.markRead', id: null })}>
            Прочитать все
          </button>
        </header>

        {grouped.length === 0 && <p className="hint">Пока пусто.</p>}

        {grouped.map((group) => (
          <section key={group.severity} className={`notif-group ${group.severity}`}>
            <h4>{SEVERITY_LABEL[group.severity]}</h4>
            {group.items.map((notification) => (
              <div
                key={notification.id}
                className={`notif ${notification.read ? 'read' : ''} ${notification.resolvedAction ? 'resolved' : ''}`}
                onClick={() => jump(notification)}
              >
                <div className="notif-title">
                  {notification.title}
                  {notification.count > 1 && <span className="notif-count">×{notification.count}</span>}
                </div>
                {notification.body && <div className="notif-body">{notification.body}</div>}
                {notification.actions.length > 0 && !notification.resolvedAction && (
                  <div className="notif-actions">
                    {notification.actions.map((action) => (
                      <button
                        key={action.id}
                        className={`art-btn ${action.kind === 'approve' ? 'primary' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void submit({
                            type: 'notification.act',
                            id: notification.id,
                            actionId: action.id
                          });
                        }}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="notif-time">
                  {new Date(notification.createdAt).toLocaleTimeString('ru', {
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
