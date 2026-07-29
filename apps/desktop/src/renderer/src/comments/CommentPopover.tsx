import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { submit, useStore } from '../store.js';

/**
 * Threads attached to an artifact, in the Google Docs sense.
 *
 * An @mention routes the comment into that agent's next turn; without one it
 * goes to whoever created the artifact, so leaving feedback on an agent's work
 * always reaches someone.
 */
export function CommentPopover(): JSX.Element | null {
  const nodeId = useStore((s) => s.commentTargetNodeId);
  const setTarget = useStore((s) => s.setCommentTarget);
  const boardId = useStore((s) => s.activeBoardId);
  const threads = useStore(useShallow((s) => s.threads.filter((t) => t.nodeId === nodeId)));
  const agents = useStore((s) => s.agents);
  const board = useStore((s) => s.activeBoard());
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);

  if (!nodeId || !boardId) return null;
  const node = board?.nodes.get(nodeId);

  const send = (): void => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    if (replyTo) {
      void submit({ type: 'comment.reply', boardId, threadId: replyTo, body });
      setReplyTo(null);
    } else {
      void submit({ type: 'comment.create', boardId, nodeId, body, anchor: null });
    }
  };

  return (
    <div className="comment-popover">
      <header className="comment-head">
        <span>
          Комментарии ·{' '}
          {node?.type === 'artifact' ? node.artifact.title || node.artifact.kind : (node?.type ?? '')}
        </span>
        <button className="icon-btn" onClick={() => setTarget(null)}>
          ×
        </button>
      </header>

      <div className="comment-threads">
        {threads.length === 0 && <div className="hint">Комментариев пока нет.</div>}
        {threads.map((thread) => (
          <div key={thread.id} className={`comment-thread ${thread.resolved ? 'resolved' : ''}`}>
            {thread.comments.map((comment) => {
              const author =
                comment.author.kind === 'human'
                  ? { name: 'Вы', color: '#5b6478' }
                  : {
                      name: comment.author.name,
                      color:
                        agents.find((a) => a.id === (comment.author as { agentId: string }).agentId)
                          ?.avatarColor ?? '#4a5268'
                    };
              return (
                <div key={comment.id} className="comment">
                  <span className="comment-avatar" style={{ background: author.color }}>
                    {author.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <div className="comment-author">{author.name}</div>
                    <div className="comment-body">{comment.body}</div>
                  </div>
                </div>
              );
            })}
            <div className="comment-actions">
              <button className="link-btn" onClick={() => setReplyTo(thread.id)}>
                Ответить
              </button>
              <button
                className="link-btn"
                onClick={() =>
                  void submit({
                    type: 'comment.resolve',
                    boardId,
                    threadId: thread.id,
                    resolved: !thread.resolved
                  })
                }
              >
                {thread.resolved ? 'Вернуть' : 'Решено'}
              </button>
              {thread.pendingDelivery.length > 0 && (
                <span className="comment-pending">ждёт ответа агента</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="comment-compose">
        {replyTo && (
          <div className="comment-replying">
            Ответ в тред
            <button className="link-btn" onClick={() => setReplyTo(null)}>
              отменить
            </button>
          </div>
        )}
        <textarea
          value={draft}
          placeholder="Комментарий… @агент чтобы адресовать"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="art-btn primary" onClick={send} disabled={!draft.trim()}>
          Отправить
        </button>
      </div>
    </div>
  );
}
