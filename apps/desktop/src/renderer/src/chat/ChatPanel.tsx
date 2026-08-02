import { useEffect, useMemo, useRef, useState } from 'react';
import type { Room, RoomMessage, TurnPolicy } from '@zmtki/protocol';
import { renderMarkdown } from '../markdown.js';
import { pickQuickStickers, stickerImgSrc, type QuickSticker } from '../stickers/quickStickers.js';
import type { ToolCallView } from '@zmtki/protocol';
import { submit, useStore } from '../store.js';
import { NewRoomDialog } from './NewRoomDialog.js';

const POLICY_LABEL: Record<TurnPolicy, string> = {
  'mention-only': 'по @упоминанию',
  moderated: 'модератор',
  'round-robin': 'по очереди',
  free: 'свободно'
};

type PendingFile = { name: string; path: string; mime: string; size: number };

type PackView = {
  id: string;
  name: string;
  stickers: Array<{ id: string; emoji?: string; src: string }>;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function RoomRow({ room, active }: { room: Room; active: boolean }): JSX.Element {
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const agents = useStore((s) => s.agents);
  const members = room.members.filter((m) => m.kind === 'agent');
  const busy = members.some((m) => agents.find((a) => a.id === m.id)?.status === 'running');
  const primary = members[0] ? agents.find((a) => a.id === members[0]!.id) : undefined;

  return (
    <button className={`room-row ${active ? 'active' : ''}`} onClick={() => setActiveRoom(room.id)}>
      <span
        className="room-avatar-lg"
        style={{ background: primary?.avatarColor ?? '#4a5268' }}
      >
        {(room.kind === 'channel' ? '#' : (primary?.name ?? room.title).slice(0, 1)).toUpperCase()}
      </span>
      <span className="room-main">
        <span className="room-title">{room.kind === 'channel' ? `# ${room.title}` : room.title}</span>
        <span className="room-sub">
          {busy ? 'печатает…' : members.map((m) => m.name).slice(0, 2).join(', ') || 'чат'}
        </span>
      </span>
      {busy && <span className="room-busy" title="агент работает" />}
    </button>
  );
}

function TurnTrace({
  reasoning,
  calls,
  defaultOpen = false,
  live = false
}: {
  reasoning: string;
  calls: ToolCallView[];
  defaultOpen?: boolean;
  live?: boolean;
}): JSX.Element | null {
  const [showReasoning, setShowReasoning] = useState(false);
  const [showTools, setShowTools] = useState(defaultOpen || live);
  if (!reasoning && calls.length === 0) return null;

  const running = calls.some((c) => c.status === 'running');

  return (
    <div className={`turn-trace ${live ? 'live' : 'archived'}`}>
      {calls.length > 0 && (
        <div className="turn-trace-block">
          <button
            type="button"
            className="turn-trace-toggle"
            onClick={() => setShowTools((v) => !v)}
          >
            <span className={`turn-trace-chevron ${showTools ? 'open' : ''}`} />
            Инструменты ({calls.length})
            {running && <span className="turn-trace-live-tag">сейчас</span>}
          </button>
          {showTools && (
            <div className="live-steps">
              {calls.map((call, i) => (
                <div
                  key={call.id}
                  className={`live-step ${call.status} ${i === calls.length - 1 ? 'latest' : ''}`}
                >
                  <span className="live-step-mark" />
                  <div className="live-step-body">
                    <span className="live-step-name">{friendlyToolLabel(call.name)}</span>
                    {call.resultPreview && (
                      <span className="live-step-preview">{shortPreview(call.resultPreview)}</span>
                    )}
                    {typeof call.durationMs === 'number' && call.status !== 'running' && (
                      <span className="live-step-dur">{Math.round(call.durationMs)}ms</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {reasoning && (
        <div className="turn-trace-block">
          <button
            type="button"
            className="turn-trace-toggle"
            onClick={() => setShowReasoning((v) => !v)}
          >
            <span className={`turn-trace-chevron ${showReasoning ? 'open' : ''}`} />
            Рассуждения
          </button>
          {showReasoning && (
            <pre className="turn-trace-reasoning">{reasoning.slice(-12000)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: RoomMessage }): JSX.Element {
  const agents = useStore((s) => s.agents);
  const setActiveBoard = useStore((s) => s.setActiveBoard);
  const boards = useStore((s) => s.boards);
  const archived = useStore((s) =>
    message.turnId ? s.archivedTurns.get(message.turnId) : undefined
  );
  const agent = agents.find((a) => a.id === message.author.id);
  const mine = message.author.kind === 'human';

  if (message.system) {
    return <div className="msg system">{message.body}</div>;
  }

  return (
    <div className={`msg ${mine ? 'mine' : 'theirs'}`}>
      {!mine && (
        <span className="msg-avatar" style={{ background: agent?.avatarColor ?? '#4a5268' }}>
          {message.author.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="msg-body">
        {!mine && <div className="msg-author">{message.author.name}</div>}
        {!mine && archived && (
          <TurnTrace reasoning={archived.reasoning} calls={archived.calls} defaultOpen={false} />
        )}
        {message.sticker && (
          <img
            className="msg-sticker"
            src={stickerImgSrc(message.sticker.packId, message.sticker.stickerId, message.sticker.src)}
            alt={message.sticker.emoji ?? 'sticker'}
          />
        )}
        {message.body && !(message.sticker && message.body.startsWith('стикер')) && (
          <div className={`msg-text ${mine ? '' : 'msg-md'}`.trim()}>
            {mine ? message.body : renderMarkdown(message.body)}
          </div>
        )}
        {message.attachments?.length > 0 && (
          <div className="msg-attachments">
            {message.attachments.map((file) => (
              <button
                key={file.id}
                className="msg-attach"
                title={file.path}
                onClick={() => void window.zmtki.revealPath(file.path)}
              >
                <span className="msg-attach-icon">📎</span>
                <span className="msg-attach-meta">
                  <span className="msg-attach-name">{file.name}</span>
                  <span className="msg-attach-size">{formatBytes(file.size)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {message.artifactRefs.length > 0 && (
          <div className="msg-refs">
            {message.artifactRefs.map((ref) => (
              <button
                key={`${ref.boardId}:${ref.nodeId}`}
                className="msg-ref"
                onClick={() => {
                  if (boards.has(ref.boardId)) setActiveBoard(ref.boardId);
                  useStore.setState({ selection: [ref.nodeId] });
                }}
              >
                артефакт {ref.nodeId.slice(-6)}
              </button>
            ))}
          </div>
        )}
        <div className="msg-time">
          {new Date(message.createdAt).toLocaleTimeString('ru', {
            hour: '2-digit',
            minute: '2-digit'
          })}
          {message.causation.hopCount > 0 && (
            <span className="msg-hops" title="ответов агентов подряд">
              ·{message.causation.hopCount}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function LiveTurnView({ agentId }: { agentId: string }): JSX.Element | null {
  const turn = useStore((s) => s.liveTurns.get(agentId));
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  if (!turn || !agent) return null;

  const activeCall = [...turn.calls].reverse().find((c) => c.status === 'running') ?? turn.calls.at(-1);
  const phase =
    agent.status === 'thinking'
      ? 'Думает'
      : agent.status === 'waitingApproval'
        ? 'Ждёт подтверждения'
        : agent.status === 'waitingInput'
          ? 'Ждёт ввода'
          : activeCall
            ? 'Работает'
            : 'Пишет ответ';

  return (
    <div className="live-turn" style={{ ['--live-accent' as string]: agent.avatarColor }}>
      <div className="live-head">
        <span className="live-avatar" style={{ background: agent.avatarColor }}>
          {agent.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="live-meta">
          <div className="live-name-row">
            <span className="live-name">{agent.name}</span>
            <span className="live-phase">
              <span className="live-dot" />
              {phase}
            </span>
          </div>
          {activeCall && (
            <div className="live-now" title={activeCall.resultPreview || activeCall.name}>
              {friendlyToolLabel(activeCall.name)}
              {activeCall.resultPreview ? (
                <span className="live-now-detail"> · {shortPreview(activeCall.resultPreview)}</span>
              ) : null}
            </div>
          )}
        </div>
        <button
          type="button"
          className="live-stop"
          onClick={() => void submit({ type: 'agent.interrupt', agentId })}
        >
          Прервать
        </button>
      </div>

      <TurnTrace reasoning={turn.reasoning} calls={turn.calls} live />

      {turn.text && (
        <div className="live-text">
          {turn.text}
          <span className="live-caret" />
        </div>
      )}
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  board_read: 'Читает доску',
  board_screenshot: 'Снимает доску',
  board_move_frame: 'Двигает рамку',
  board_arrange: 'Раскладывает',
  board_create_mark: 'Ставит метку',
  board_set_state: 'Меняет состояние',
  sticker_place: 'Ставит стикер',
  stickers_list: 'Смотрит стикеры',
  room_send: 'Пишет в чат',
  room_read: 'Читает чат',
  room_list: 'Смотрит комнаты',
  list_files: 'Смотрит файлы',
  read_file: 'Читает файл',
  write_file: 'Пишет файл',
  search_files: 'Ищет в файлах',
  shell: 'Команда в терминале',
  web_search: 'Ищет в интернете',
  web_fetch: 'Открывает страницу',
  apply_patch: 'Патчит код',
  delegate_task: 'Делегирует',
  memory_write: 'Пишет в память',
  memory_read: 'Читает память'
};

function friendlyToolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (name.startsWith('mcp_') || name.includes('__')) return `Инструмент · ${name.replace(/^mcp_/, '')}`;
  return name.replace(/_/g, ' ');
}

function shortPreview(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 72 ? `${clean.slice(0, 72)}…` : clean;
}

function ChatStickerPicker({
  onPick,
  onClose
}: {
  onPick: (packId: string, stickerId: string, src: string, emoji?: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [packs, setPacks] = useState<PackView[]>([]);

  useEffect(() => {
    void submit<PackView[]>({ type: 'stickers.list' }).then((result) => {
      if (!result.ok) return;
      const ordered = [...result.value].sort((a, b) => {
        if (a.id === 'basics') return -1;
        if (b.id === 'basics') return 1;
        return a.name.localeCompare(b.name, 'ru');
      });
      setPacks(ordered);
    });
  }, []);

  return (
    <div className="chat-sticker-pop">
      <div className="chat-sticker-pop-head">
        <span>Стикеры</span>
        <button className="icon-btn" onClick={onClose}>
          ×
        </button>
      </div>
      {packs.map((pack) => (
        <div key={pack.id} className="chat-sticker-pack">
          <div className="chat-sticker-pack-name">
            {pack.name}
            {pack.id === 'basics' ? ' · стартовый' : ''}
          </div>
          <div className="chat-sticker-grid">
            {pack.stickers.map((s) => (
              <button
                key={s.id}
                className="chat-sticker-cell"
                title={s.emoji ?? s.id}
                onClick={() => onPick(pack.id, s.id, s.src, s.emoji)}
              >
                <img src={stickerImgSrc(pack.id, s.id, s.src)} alt={s.emoji ?? s.id} />
              </button>
            ))}
          </div>
        </div>
      ))}
      {packs.length === 0 && <div className="hint">Паков пока нет — перезапустите приложение</div>}
    </div>
  );
}

const NO_MESSAGES: RoomMessage[] = [];

export function ChatPanel(): JSX.Element {
  const rooms = useStore((s) => s.rooms);
  const activeRoomId = useStore((s) => s.activeRoomId);
  const activeBoardId = useStore((s) => s.activeBoardId);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const messages = useStore((s) => (activeRoomId ? (s.messages.get(activeRoomId) ?? NO_MESSAGES) : NO_MESSAGES));
  const agents = useStore((s) => s.agents);
  const liveTurns = useStore((s) => s.liveTurns);
  const approvals = useStore((s) => s.approvals);

  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [quickStickers, setQuickStickers] = useState<QuickSticker[]>([]);
  const [endpoints, setEndpoints] = useState<
    Array<{ id: string; label: string; models: string[]; hasKey: boolean }>
  >([]);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const boardRooms = useMemo(() => {
    if (!activeBoardId) return [];
    return rooms.filter((room) => {
      if (room.boardId === activeBoardId) return true;
      if (room.boardId != null) return false;
      return room.members.some((m) => {
        if (m.kind !== 'agent') return false;
        return agents.find((a) => a.id === m.id)?.homeBoardId === activeBoardId;
      });
    });
  }, [rooms, agents, activeBoardId]);

  const room = boardRooms.find((r) => r.id === activeRoomId) ?? rooms.find((r) => r.id === activeRoomId);
  const roomAgents = useMemo(
    () => (room ? room.members.filter((m) => m.kind === 'agent').map((m) => m.id) : []),
    [room]
  );
  const primaryAgent = useMemo(() => {
    const id = roomAgents[0];
    return id ? agents.find((a) => a.id === id) : undefined;
  }, [agents, roomAgents]);

  const modelOptions = useMemo(() => {
    const endpointId = primaryAgent?.model.endpointId;
    const ep = endpoints.find((e) => e.id === endpointId);
    return ep?.models ?? [];
  }, [endpoints, primaryAgent]);

  useEffect(() => {
    if (boardRooms.length === 0) {
      if (activeRoomId) setActiveRoom(null);
      return;
    }
    const stillVisible = boardRooms.some((r) => r.id === activeRoomId);
    if (!activeRoomId || !stillVisible) setActiveRoom(boardRooms[0]!.id);
  }, [activeRoomId, boardRooms, setActiveRoom]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, liveTurns]);

  useEffect(() => {
    void submit<Array<{ id: string; label: string; models: string[]; hasKey: boolean }>>({
      type: 'provider.list'
    }).then((result) => {
      if (result.ok) setEndpoints(result.value);
    });
  }, [primaryAgent?.id]);

  useEffect(() => {
    void submit<PackView[]>({ type: 'stickers.list' }).then((result) => {
      if (result.ok) setQuickStickers(pickQuickStickers(result.value, 5));
    });
  }, []);

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const query = mentionQuery.toLowerCase();
    return agents
      .filter((a) => roomAgents.includes(a.id))
      .filter((a) => !query || a.handle.toLowerCase().includes(query) || a.name.toLowerCase().includes(query));
  }, [agents, mentionQuery, roomAgents]);

  const canSend = Boolean(room) && (draft.trim().length > 0 || pendingFiles.length > 0);

  const send = (extra?: {
    sticker?: { packId: string; stickerId: string; src: string; emoji?: string };
  }): void => {
    if (!activeRoomId || !room) return;
    const body = draft.trim();
    if (!body && pendingFiles.length === 0 && !extra?.sticker) return;
    setDraft('');
    setMentionQuery(null);
    setStickersOpen(false);
    const attachments = pendingFiles;
    setPendingFiles([]);
    void submit({
      type: 'room.send',
      roomId: activeRoomId,
      body,
      steer: true,
      attachments,
      sticker: extra?.sticker ?? null
    });
  };

  const attachFiles = async (): Promise<void> => {
    const files = await window.zmtki.pickFiles();
    if (files.length === 0) return;
    setPendingFiles((prev) => [...prev, ...files]);
  };

  const changeModel = async (model: string): Promise<void> => {
    if (!primaryAgent || !model) return;
    await submit({
      type: 'agent.update',
      agentId: primaryAgent.id,
      patch: {
        model: {
          ...primaryAgent.model,
          model
        }
      }
    });
  };

  const insertMention = (handle: string): void => {
    setDraft((prev) => prev.replace(/@[\w.-]*$/, `@${handle} `));
    setMentionQuery(null);
    input.current?.focus();
  };

  return (
    <aside className="chat-panel">
      <div className="chat-rooms">
        <div className="chat-rooms-head">
          <span>Чаты</span>
          <button className="icon-btn" title="Новый чат" onClick={() => setCreating(true)}>
            +
          </button>
        </div>
        <div className="chat-rooms-list">
          {boardRooms.map((r) => (
            <RoomRow key={r.id} room={r} active={r.id === activeRoomId} />
          ))}
          {boardRooms.length === 0 && <div className="hint">Создайте агента, чтобы начать диалог</div>}
        </div>
      </div>

      <div className="chat-thread">
        {room && (
          <header className="chat-head">
            <div className="chat-head-main">
              <div className="chat-title">{room.kind === 'channel' ? `# ${room.title}` : room.title}</div>
              <div className="chat-sub">
                {roomAgents.length} участник{roomAgents.length === 1 ? '' : 'а'} · {POLICY_LABEL[room.turnPolicy]}
              </div>
            </div>
            <div className="chat-head-actions">
              <button
                type="button"
                className="icon-btn"
                title="Очистить чат"
                disabled={messages.length === 0}
                onClick={() => {
                  if (!window.confirm('Очистить историю этого чата?')) return;
                  void submit({ type: 'room.clear', roomId: room.id });
                }}
              >
                ⌫
              </button>
              <select
                className="policy-select"
                title="Кто отвечает"
                value={room.turnPolicy}
                onChange={(e) =>
                  void submit({
                    type: 'room.update',
                    roomId: room.id,
                    patch: { turnPolicy: e.target.value as TurnPolicy }
                  })
                }
              >
                {(Object.keys(POLICY_LABEL) as TurnPolicy[]).map((policy) => (
                  <option key={policy} value={policy}>
                    {POLICY_LABEL[policy]}
                  </option>
                ))}
              </select>
            </div>
          </header>
        )}

        {room?.paused && (
          <div className="chat-paused">
            Комната на паузе: {room.pausedReason}
            <button className="art-btn" onClick={() => void submit({ type: 'room.resume', roomId: room.id })}>
              Продолжить
            </button>
          </div>
        )}

        <div className="chat-messages" ref={scroller}>
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {roomAgents.map((agentId) => (
            <LiveTurnView key={agentId} agentId={agentId} />
          ))}

          {approvals.map((request) => (
            <div key={request.id} className="approval-card">
              <div className="approval-title">{request.title}</div>
              <code className="approval-subject">{request.subject}</code>
              <div className="approval-detail">{request.detail}</div>
              <div className="approval-actions">
                <button
                  className="art-btn primary"
                  onClick={() =>
                    void submit({
                      type: 'approval.respond',
                      requestId: request.id,
                      approved: true,
                      remember: false
                    })
                  }
                >
                  Разрешить
                </button>
                <button
                  className="art-btn"
                  onClick={() =>
                    void submit({
                      type: 'approval.respond',
                      requestId: request.id,
                      approved: true,
                      remember: true
                    })
                  }
                >
                  Всегда
                </button>
                <button
                  className="art-btn danger"
                  onClick={() =>
                    void submit({
                      type: 'approval.respond',
                      requestId: request.id,
                      approved: false,
                      remember: false
                    })
                  }
                >
                  Отклонить
                </button>
              </div>
            </div>
          ))}
        </div>

        {mentionCandidates.length > 0 && (
          <div className="mention-popup">
            {mentionCandidates.map((agent) => (
              <button key={agent.id} onClick={() => insertMention(agent.handle)}>
                <span className="mention-dot" style={{ background: agent.avatarColor }} />@{agent.handle}
                <span className="mention-name">{agent.name}</span>
              </button>
            ))}
          </div>
        )}

        {stickersOpen && (
          <ChatStickerPicker
            onClose={() => setStickersOpen(false)}
            onPick={(packId, stickerId, src, emoji) =>
              send({ sticker: { packId, stickerId, src, emoji } })
            }
          />
        )}

        <div className="chat-compose">
          {pendingFiles.length > 0 && (
            <div className="compose-attachments">
              {pendingFiles.map((file) => (
                <span key={`${file.path}:${file.name}`} className="compose-chip">
                  📎 {file.name}
                  <button
                    type="button"
                    onClick={() =>
                      setPendingFiles((prev) => prev.filter((f) => f.path !== file.path))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="compose-toolbar">
            <button
              type="button"
              className="compose-tool"
              title="Вложение"
              disabled={!room}
              onClick={() => void attachFiles()}
            >
              📎
            </button>

            <div className="sticker-strip" title="Быстрые стикеры">
              {quickStickers.map((s) => (
                <button
                  key={`${s.packId}:${s.stickerId}`}
                  type="button"
                  className="sticker-strip-btn"
                  disabled={!room}
                  title={s.emoji ?? s.stickerId}
                  onClick={() =>
                    send({
                      sticker: {
                        packId: s.packId,
                        stickerId: s.stickerId,
                        src: s.src,
                        emoji: s.emoji
                      }
                    })
                  }
                >
                  <img src={s.src} alt={s.emoji ?? s.stickerId} />
                </button>
              ))}
              <button
                type="button"
                className={`sticker-strip-more ${stickersOpen ? 'on' : ''}`}
                title="Все стикеры"
                disabled={!room}
                onClick={() => setStickersOpen((v) => !v)}
              >
                ⋯
              </button>
            </div>
          </div>

          {primaryAgent && (
            <select
              className="compose-model"
              title="Сильная модель агента"
              value={primaryAgent.model.model || ''}
              disabled={modelOptions.length === 0}
              onChange={(e) => void changeModel(e.target.value)}
            >
              {modelOptions.length === 0 && (
                <option value={primaryAgent.model.model || ''}>
                  {primaryAgent.model.model || 'модель не выбрана'}
                </option>
              )}
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          )}

          <div className="compose-row">
            <textarea
              ref={input}
              value={draft}
              placeholder={room ? 'Написать сообщение…' : 'Выберите чат'}
              disabled={!room}
              rows={1}
              onChange={(e) => {
                setDraft(e.target.value);
                const match = /@([\w.-]*)$/.exec(e.target.value);
                setMentionQuery(match ? (match[1] ?? '') : null);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
                if (e.key === 'Escape') {
                  setMentionQuery(null);
                  setStickersOpen(false);
                }
              }}
            />
            <button className="send-btn" onClick={() => send()} disabled={!canSend}>
              ↑
            </button>
          </div>
        </div>
      </div>

      {creating && <NewRoomDialog onClose={() => setCreating(false)} />}
    </aside>
  );
}
