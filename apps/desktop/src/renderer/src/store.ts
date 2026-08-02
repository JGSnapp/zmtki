import { create } from 'zustand';
import { DEFAULT_STYLE } from '@zmtki/board-schema';
import type {
  Agent,
  BoardDoc,
  BoardEdge,
  BoardNode,
  Camera,
  CommentThread,
  Style
} from '@zmtki/board-schema';
import type {
  ActivityEntry,
  ApprovalRequest,
  BoardOp,
  ChatGptStatusView,
  CoreEvent,
  Notification,
  Op,
  OpResult,
  Room,
  RoomMessage,
  ToolCallView
} from '@zmtki/protocol';

export type ToolName =
  | 'select'
  | 'hand'
  | 'sticky'
  | 'text'
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'arrow'
  | 'line'
  | 'draw'
  | 'frame'
  | 'comment';

export interface LiveTurn {
  agentId: string;
  turnId: string;
  text: string;
  reasoning: string;
  calls: ToolCallView[];
}

/** Finished turn trace kept in the chat UI (collapsed under the message). */
export interface ArchivedTurn {
  agentId: string;
  turnId: string;
  text: string;
  reasoning: string;
  calls: ToolCallView[];
  status: 'completed' | 'failed' | 'aborted';
  finishedAt: number;
}

const MAX_ARCHIVED_TURNS = 120;

export interface BoardState {
  doc: BoardDoc;
  nodes: Map<string, BoardNode>;
  edges: Map<string, BoardEdge>;
  camera: Camera;
  path: string;
}

interface AppState {
  boards: Map<string, BoardState>;
  activeBoardId: string | null;

  agents: Agent[];
  agentHeadlines: Record<string, string>;

  rooms: Room[];
  messages: Map<string, RoomMessage[]>;
  activeRoomId: string | null;

  threads: CommentThread[];
  notifications: Notification[];
  approvals: ApprovalRequest[];
  activity: ActivityEntry[];
  scheduler: { running: number; queued: number; limit: number };

  /** Null until the first status arrives, so settings can show a spinner-free default. */
  chatgpt: ChatGptStatusView | null;
  chatgptError: string;

  liveTurns: Map<string, LiveTurn>;
  /** Keyed by turnId — reasoning/tool calls survive after the live strip goes away. */
  archivedTurns: Map<string, ArchivedTurn>;
  terminalBuffers: Map<string, string>;

  tool: ToolName;
  /** Style applied to newly drawn shapes, strokes and notes. */
  drawStyle: Style;
  selection: string[];
  editingNodeId: string | null;
  commentTargetNodeId: string | null;
  followAgentId: string | null;
  cameraHistory: Camera[];

  paletteOpen: boolean;
  settingsOpen: boolean;
  notificationsOpen: boolean;
  activityOpen: boolean;
  /** Mirrors the app setting so the toggle renders without a round trip. */
  focusMode: boolean;
  /** True while a modal/dialog owns the keyboard (create agent, etc.). */
  overlayOpen: boolean;
}

interface AppActions {
  handleEvent(event: CoreEvent): void;
  setTool(tool: ToolName): void;
  setDrawStyle(patch: Partial<Style>): void;
  setSelection(ids: string[]): void;
  setEditingNode(id: string | null): void;
  setCommentTarget(id: string | null): void;
  setActiveBoard(boardId: string | null): void;
  setActiveRoom(roomId: string | null): void;
  setFollow(agentId: string | null): void;
  pushCamera(camera: Camera): void;
  popCamera(): Camera | null;
  setCameraLocal(boardId: string, camera: Camera): void;
  togglePalette(open?: boolean): void;
  toggleSettings(open?: boolean): void;
  toggleNotifications(open?: boolean): void;
  toggleActivity(open?: boolean): void;
  setOverlayOpen(open: boolean): void;
  activeBoard(): BoardState | undefined;
  agentById(agentId: string): Agent | undefined;
}

export type Store = AppState & AppActions;

const MAX_ACTIVITY = 200;
const MAX_TERMINAL_CHARS = 200_000;

export const submit = <T = unknown>(op: Op): Promise<OpResult<T>> => window.zmtki.submit<T>(op);

/**
 * Applies board ops locally instead of refetching the document.
 *
 * The renderer mirrors the same op stream the core applies to its Yjs doc, so a
 * remote agent's edit and a local drag converge without either side reloading.
 */
function applyOps(state: BoardState, ops: readonly BoardOp[]): BoardState {
  const nodes = new Map(state.nodes);
  const edges = new Map(state.edges);
  let camera = state.camera;

  for (const op of ops) {
    switch (op.op) {
      case 'addNode':
        nodes.set(op.node.id, op.node);
        break;
      case 'updateNode': {
        const existing = nodes.get(op.id);
        if (!existing) break;
        const patch = op.patch as Record<string, unknown>;
        const merged = { ...existing, ...patch } as BoardNode;
        // Artifact payloads arrive as partial patches so a status update does
        // not have to resend the whole spec.
        if (existing.type === 'artifact' && patch.artifact) {
          (merged as typeof existing).artifact = {
            ...existing.artifact,
            ...(patch.artifact as Record<string, unknown>)
          } as typeof existing.artifact;
        }
        nodes.set(op.id, merged);
        break;
      }
      case 'removeNode':
        nodes.delete(op.id);
        // Mirror BoardStore: drop arrows that pointed at the deleted node.
        for (const [edgeId, edge] of [...edges]) {
          if (edge.from.nodeId === op.id || edge.to.nodeId === op.id) {
            edges.delete(edgeId);
          }
        }
        break;
      case 'moveNodes':
        for (const move of op.moves) {
          const node = nodes.get(move.id);
          if (node) nodes.set(move.id, { ...node, position: move.position });
        }
        break;
      case 'resizeNode': {
        const node = nodes.get(op.id);
        if (node) {
          nodes.set(op.id, {
            ...node,
            size: op.size,
            ...(op.position ? { position: op.position } : {})
          });
        }
        break;
      }
      case 'addEdge':
        edges.set(op.edge.id, op.edge);
        break;
      case 'updateEdge': {
        const edge = edges.get(op.id);
        if (edge) edges.set(op.id, { ...edge, ...op.patch } as BoardEdge);
        break;
      }
      case 'removeEdge':
        edges.delete(op.id);
        break;
      case 'setCamera':
        camera = op.camera;
        break;
      default:
        break;
    }
  }

  return { ...state, nodes, edges, camera };
}

export const useStore = create<Store>((set, get) => ({
  boards: new Map(),
  activeBoardId: null,

  agents: [],
  agentHeadlines: {},

  rooms: [],
  messages: new Map(),
  activeRoomId: null,

  threads: [],
  notifications: [],
  approvals: [],
  activity: [],
  scheduler: { running: 0, queued: 0, limit: 3 },

  chatgpt: null,
  chatgptError: '',

  liveTurns: new Map(),
  archivedTurns: new Map(),
  terminalBuffers: new Map(),

  tool: 'select',
  drawStyle: DEFAULT_STYLE,
  selection: [],
  editingNodeId: null,
  commentTargetNodeId: null,
  followAgentId: null,
  cameraHistory: [],

  paletteOpen: false,
  settingsOpen: false,
  notificationsOpen: false,
  activityOpen: false,
  focusMode: false,
  overlayOpen: false,

  activeBoard: () => {
    const { boards, activeBoardId } = get();
    return activeBoardId ? boards.get(activeBoardId) : undefined;
  },

  agentById: (agentId) => get().agents.find((a) => a.id === agentId),

  handleEvent: (event) => {
    const msg = event.msg;
    set((state) => {
      switch (msg.type) {
        case 'board.loaded': {
          const boards = new Map(state.boards);
          boards.set(msg.boardId, {
            doc: msg.doc,
            nodes: new Map(msg.doc.nodes.map((n) => [n.id, n])),
            edges: new Map(msg.doc.edges.map((e) => [e.id, e])),
            camera: msg.doc.camera,
            path: msg.path
          });
          return {
            boards,
            activeBoardId: state.activeBoardId ?? msg.boardId
          };
        }

        case 'board.ops': {
          const existing = state.boards.get(msg.boardId);
          if (!existing) return {};
          const boards = new Map(state.boards);
          boards.set(msg.boardId, applyOps(existing, msg.ops));
          return { boards };
        }

        case 'board.closed': {
          const boards = new Map(state.boards);
          boards.delete(msg.boardId);
          return {
            boards,
            agents: state.agents.filter((a) => a.homeBoardId !== msg.boardId),
            activeBoardId:
              state.activeBoardId === msg.boardId ? ([...boards.keys()][0] ?? null) : state.activeBoardId,
            followAgentId:
              state.followAgentId &&
              state.agents.some((a) => a.id === state.followAgentId && a.homeBoardId === msg.boardId)
                ? null
                : state.followAgentId
          };
        }

        case 'agent.list':
          return { agents: msg.agents };

        case 'agent.status':
          return {
            agents: state.agents.map((a) => (a.id === msg.agentId ? { ...a, status: msg.status } : a)),
            agentHeadlines: { ...state.agentHeadlines, [msg.agentId]: msg.headline }
          };

        case 'turn.started': {
          const liveTurns = new Map(state.liveTurns);
          liveTurns.set(msg.agentId, {
            agentId: msg.agentId,
            turnId: msg.turnId,
            text: '',
            reasoning: '',
            calls: []
          });
          return { liveTurns };
        }

        case 'turn.messageDelta':
        case 'turn.reasoningDelta': {
          const liveTurns = new Map(state.liveTurns);
          const turn = liveTurns.get(msg.agentId);
          if (!turn) return {};
          liveTurns.set(msg.agentId, {
            ...turn,
            text: msg.type === 'turn.messageDelta' ? turn.text + msg.text : turn.text,
            reasoning: msg.type === 'turn.reasoningDelta' ? turn.reasoning + msg.text : turn.reasoning
          });
          return { liveTurns };
        }

        case 'turn.toolCall': {
          const liveTurns = new Map(state.liveTurns);
          const turn = liveTurns.get(msg.agentId);
          if (!turn) return {};
          const calls = [...turn.calls];
          const index = calls.findIndex((c) => c.id === msg.call.id);
          if (index >= 0) calls[index] = msg.call;
          else calls.push(msg.call);
          liveTurns.set(msg.agentId, { ...turn, calls });
          return { liveTurns };
        }

        case 'turn.completed':
        case 'turn.failed':
        case 'turn.aborted': {
          const liveTurns = new Map(state.liveTurns);
          const live = liveTurns.get(msg.agentId);
          liveTurns.delete(msg.agentId);
          if (!live || (!live.reasoning && live.calls.length === 0 && !live.text)) {
            return { liveTurns };
          }
          const archivedTurns = new Map(state.archivedTurns);
          archivedTurns.set(live.turnId, {
            agentId: live.agentId,
            turnId: live.turnId,
            text: live.text,
            reasoning: live.reasoning,
            calls: live.calls,
            status:
              msg.type === 'turn.completed'
                ? 'completed'
                : msg.type === 'turn.failed'
                  ? 'failed'
                  : 'aborted',
            finishedAt: Date.now()
          });
          if (archivedTurns.size > MAX_ARCHIVED_TURNS) {
            const oldest = [...archivedTurns.entries()].sort(
              (a, b) => a[1].finishedAt - b[1].finishedAt
            );
            const drop = oldest.length - MAX_ARCHIVED_TURNS;
            for (let i = 0; i < drop; i += 1) {
              const key = oldest[i]?.[0];
              if (key) archivedTurns.delete(key);
            }
          }
          return { liveTurns, archivedTurns };
        }

        case 'room.list': {
          const stillThere =
            state.activeRoomId != null && msg.rooms.some((r) => r.id === state.activeRoomId);
          return {
            rooms: msg.rooms,
            activeRoomId: stillThere ? state.activeRoomId : (msg.rooms[0]?.id ?? null)
          };
        }

        case 'room.updated':
          return {
            rooms: state.rooms.some((r) => r.id === msg.room.id)
              ? state.rooms.map((r) => (r.id === msg.room.id ? msg.room : r))
              : [...state.rooms, msg.room]
          };

        case 'room.message': {
          const messages = new Map(state.messages);
          const list = messages.get(msg.message.roomId) ?? [];
          if (list.some((m) => m.id === msg.message.id)) return {};
          messages.set(msg.message.roomId, [...list, msg.message]);
          return { messages };
        }

        case 'room.cleared': {
          const messages = new Map(state.messages);
          const clearedIds = (state.messages.get(msg.roomId) ?? [])
            .map((m) => m.turnId)
            .filter((id): id is string => Boolean(id));
          messages.set(msg.roomId, []);
          const archivedTurns = new Map(state.archivedTurns);
          for (const turnId of clearedIds) archivedTurns.delete(turnId);
          return { messages, archivedTurns };
        }

        case 'comment.threads':
          return { threads: msg.threads };

        case 'approval.request':
          return { approvals: [...state.approvals, msg.request] };

        case 'approval.resolved':
          return { approvals: state.approvals.filter((a) => a.id !== msg.requestId) };

        case 'notification.new':
          return { notifications: [msg.notification, ...state.notifications].slice(0, 300) };

        case 'notification.updated':
          return {
            notifications: state.notifications.map((n) =>
              n.id === msg.notification.id ? msg.notification : n
            )
          };

        case 'notification.cleared':
          return { notifications: state.notifications.filter((n) => !msg.ids.includes(n.id)) };

        case 'terminal.data': {
          const terminalBuffers = new Map(state.terminalBuffers);
          const previous = terminalBuffers.get(msg.nodeId) ?? '';
          const next = previous + msg.data;
          terminalBuffers.set(
            msg.nodeId,
            next.length > MAX_TERMINAL_CHARS ? next.slice(-MAX_TERMINAL_CHARS) : next
          );
          return { terminalBuffers };
        }

        case 'terminal.exit': {
          const terminalBuffers = new Map(state.terminalBuffers);
          const previous = terminalBuffers.get(msg.nodeId) ?? '';
          terminalBuffers.set(msg.nodeId, `${previous}\n[процесс завершён, код ${msg.exitCode ?? '?'}]\n`);
          return { terminalBuffers };
        }

        case 'activity':
          return { activity: [...msg.entries, ...state.activity].slice(0, MAX_ACTIVITY) };

        case 'scheduler.state':
          return { scheduler: { running: msg.running, queued: msg.queued, limit: msg.limit } };

        case 'chatgpt.status':
          return { chatgpt: msg.status, chatgptError: msg.error };

        case 'provider.list':
          return {};

        default:
          return {};
      }
    });
  },

  setTool: (tool) => set({ tool }),
  setDrawStyle: (patch) => set((s) => ({ drawStyle: { ...s.drawStyle, ...patch } })),
  setSelection: (selection) => set({ selection }),
  setEditingNode: (editingNodeId) => set({ editingNodeId }),
  setCommentTarget: (commentTargetNodeId) => set({ commentTargetNodeId }),

  setActiveBoard: (boardId) => {
    set({ activeBoardId: boardId, selection: [] });
    void submit({ type: 'workspace.setActive', boardId });
  },

  setActiveRoom: (roomId) => {
    set({ activeRoomId: roomId });
    if (!roomId) return;
    void submit({ type: 'room.markRead', roomId });
    void submit<RoomMessage[]>({ type: 'room.history', roomId, limit: 200 }).then((result) => {
      if (!result.ok) return;
      set((state) => {
        const messages = new Map(state.messages);
        messages.set(roomId, result.value);
        return { messages };
      });
    });
  },

  setFollow: (followAgentId) => set({ followAgentId }),

  pushCamera: (camera) =>
    set((state) => ({ cameraHistory: [...state.cameraHistory.slice(-20), camera] })),

  popCamera: () => {
    const history = get().cameraHistory;
    const last = history[history.length - 1];
    if (!last) return null;
    set({ cameraHistory: history.slice(0, -1) });
    return last;
  },

  setCameraLocal: (boardId, camera) =>
    set((state) => {
      const existing = state.boards.get(boardId);
      if (!existing) return {};
      const boards = new Map(state.boards);
      boards.set(boardId, { ...existing, camera });
      return { boards };
    }),

  togglePalette: (open) => set((s) => ({ paletteOpen: open ?? !s.paletteOpen })),
  toggleSettings: (open) => set((s) => ({ settingsOpen: open ?? !s.settingsOpen })),
  toggleNotifications: (open) => set((s) => ({ notificationsOpen: open ?? !s.notificationsOpen })),
  toggleActivity: (open) => set((s) => ({ activityOpen: open ?? !s.activityOpen })),
  setOverlayOpen: (open) => set({ overlayOpen: open })
}));
