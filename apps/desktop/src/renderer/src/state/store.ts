import type { Artifact, ArtifactType, Board, BoardSummary, Rect } from '@zmtki/shared';
import { applyStateChange, artifactDefinition } from '@zmtki/shared';
import { create } from 'zustand';
import type { AgentEvent, AgentInfo, BoardEvent, HarnessInfo, McpInfo, McpServerInfo, SpawnRequest } from '../../../shared/ipc';
import { type Ghost, MOTION, Motion, type ViewInfo, isWatching, planMove } from './motion';

export const api = window.zmtki;

/** `zone` turns drags into zone sweeps instead of selection; see BoardCanvas. */
export type Tool = 'select' | 'draw' | 'zone';

/**
 * A block on its way to the board. Blocks are never dropped into the middle of
 * the screen unannounced: they follow the pointer — dragged out of a menu, or
 * picked with a click and carried — and the canvas shows where they will land.
 */
export interface Placement {
  type: ArtifactType;
  props: Record<string, unknown>;
  label: string;
  /** press: button held, not yet moved; drag: carried with the button held; click: carried after a click. */
  mode: 'press' | 'drag' | 'click';
  clientX: number;
  clientY: number;
  startX: number;
  startY: number;
}

interface State {
  boards: BoardSummary[];
  board: Board | null;
  selection: string[];
  selectedArrow: string | null;
  /**
   * Geometry overrides for artifacts being dragged or resized right now.
   *
   * A drag never writes to `board`: that would rebuild the spatial index and
   * every memo downstream on each pointer move. Only the dragged artifacts and
   * the arrow layer read drafts, and a draft is committed once, on release.
   */
  drafts: Record<string, Partial<Rect>>;
  /** Geometry of cards mid-slide, published by the motion loop once per frame. */
  motion: Record<string, Rect>;
  /** Cards drawn after they left: deleted, or moved too far to slide. */
  ghosts: Ghost[];
  /** Cards playing their appear animation, with the time it started. */
  entering: Record<string, number>;
  agents: AgentInfo[];
  /** Subagents waiting for the user's word. Their parent's call is blocked on it. */
  spawnRequests: SpawnRequest[];
  /** Zone being edited: sweeps grow it, Shift-sweeps cut it. */
  zoneSelection: string | null;
  harnesses: HarnessInfo[];
  mcp: McpInfo | null;
  /** Extra MCP servers on offer, and which of them are switched on. */
  mcpServers: McpServerInfo[];
  /** Preferences about the view, kept by the main process so they survive a restart. */
  settings: Record<string, unknown>;
  tool: Tool;
  placement: Placement | null;
  focusRequest: { id: string; nonce: number } | null;
  /** What the canvas shows, kept for deciding whether a change is worth animating. */
  view: ViewInfo | null;
  toast: { text: string; nonce: number } | null;

  init(): Promise<void>;
  refreshBoards(): Promise<void>;
  openBoard(id: string): Promise<void>;
  createBoard(title?: string, rootDir?: string): Promise<void>;
  deleteBoard(id: string): Promise<void>;
  createBenchBoard(count: number): Promise<void>;
  applyBoardEvent(event: BoardEvent): void;
  select(ids: string[]): void;
  selectArrow(id: string | null): void;
  setDrafts(drafts: Record<string, Partial<Rect>>): void;
  commitDrafts(): Promise<void>;
  createAt(type: ArtifactType, topLeft: { x: number; y: number }, props?: Record<string, unknown>): Promise<string | null>;
  patchProps(id: string, props: Record<string, unknown>): Promise<void>;
  removeSelection(): Promise<void>;
  connect(fromId: string, toId: string): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  applyAgentEvent(event: AgentEvent): void;
  focusArtifact(id: string): void;
  setTool(tool: Tool): void;
  selectZone(id: string | null): void;
  resolveSpawn(requestId: string, approved: boolean): Promise<void>;
  setView(view: ViewInfo): void;
  /** Switches an extra MCP server on or off. Reaches agents started afterwards. */
  setMcpServer(id: string, enabled: boolean): Promise<void>;
  setSetting(key: string, value: unknown): Promise<void>;
  beginPlacement(type: ArtifactType, clientX: number, clientY: number, props?: Record<string, unknown>, label?: string): void;
  movePlacement(clientX: number, clientY: number): void;
  setPlacementMode(mode: Placement['mode']): void;
  endPlacement(): void;
  /** Stop slides of these cards where they are drawn — the user has grabbed them. */
  stopMotion(ids: string[]): void;
  notify(text: string): void;
}

const snap = (value: number): number => Math.round(value / 20) * 20;

const rectOf = (a: Rect): Rect => ({ x: a.x, y: a.y, width: a.width, height: a.height });

/** Every IPC failure surfaces as a toast rather than an unhandled rejection. */
const guarded =
  <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
  async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      useStore.getState().notify(error instanceof Error ? error.message : String(error));
    }
  };

let ghostSeq = 0;

export const useStore = create<State>((set, get) => {
  const motion = new Motion((overrides) => set({ motion: overrides }));

  const addGhost = (artifact: Artifact, kind: Ghost['kind']) => {
    const duration = kind === 'exit' ? MOTION.exitMs : MOTION.teleportOutMs;
    const ghost: Ghost = { key: 'g' + ghostSeq++, artifact, kind, until: performance.now() + duration };
    set({ ghosts: [...get().ghosts, ghost] });
    window.setTimeout(() => {
      set({ ghosts: get().ghosts.filter((g) => g.key !== ghost.key) });
    }, duration + 40);
  };

  const markEntering = (id: string, delay = 0) => {
    set({ entering: { ...get().entering, [id]: performance.now() + delay } });
    window.setTimeout(() => {
      const { [id]: _done, ...rest } = get().entering;
      set({ entering: rest });
    }, MOTION.enterMs + delay + 40);
  };

  /**
   * Decides, before a delta is applied, how each touched card should get from
   * where it is drawn to where it now is. "Where it is drawn" is the live drag
   * draft or the mid-slide position when there is one, so a drop settles onto
   * the grid and a re-move by an agent picks up from wherever the card is.
   */
  const animateDelta = (board: Board, event: Extract<BoardEvent, { type: 'board_delta' }>) => {
    const view = get().view;
    const drafts = get().drafts;
    const before = new Map(board.state.artifacts.map((a) => [a.id, a]));

    for (const { entity } of event.change.artifacts.upsert) {
      const pre = before.get(entity.id);
      if (!pre) {
        if (isWatching(view, entity)) markEntering(entity.id);
        continue;
      }
      const draft = drafts[entity.id];
      // A live drag draft is where the card really is; only without one does a
      // slide in progress say where it is drawn.
      const drawn = draft ? { ...rectOf(pre), ...draft } : (motion.rectOf(entity.id) ?? rectOf(pre));
      const plan = planMove(view, drawn, entity);
      if (plan === 'slide') {
        motion.slide(entity.id, drawn, rectOf(entity), view, !!draft && event.origin === 'renderer');
      } else if (plan === 'teleport') {
        motion.cancel(entity.id);
        if (isWatching(view, drawn)) addGhost({ ...pre, ...drawn }, 'teleport');
        if (isWatching(view, entity)) markEntering(entity.id, MOTION.teleportInDelayMs);
      }
    }
    for (const id of event.change.artifacts.remove) {
      const pre = before.get(id);
      motion.cancel(id);
      if (!pre) continue;
      const draft = drafts[id];
      const drawn = draft ? { ...pre, ...draft } : pre;
      if (isWatching(view, drawn)) addGhost(drawn, 'exit');
    }
  };

  return {
    boards: [],
    board: null,
    selection: [],
    selectedArrow: null,
    drafts: {},
    motion: {},
    ghosts: [],
    entering: {},
    agents: [],
    spawnRequests: [],
    zoneSelection: null,
    harnesses: [],
    mcp: null,
    mcpServers: [],
    settings: {},
    tool: 'select',
    placement: null,
    focusRequest: null,
    view: null,
    toast: null,

    async init() {
      // Each list stands on its own: one call failing — an older main process
      // without a channel this build asks for, a service that has not come up —
      // must not leave the panels empty.
      const [boards, agents, spawnRequests, harnesses, mcp, mcpServers, settings] = await Promise.all([
        api.boards.list(),
        api.agents.list().catch(() => []),
        api.agents.requests().catch(() => []),
        api.harnesses.list().catch(() => []),
        api.mcp.info().catch(() => null),
        api.mcp.servers().catch(() => []),
        api.settings.all().catch(() => ({})),
      ]);
      set({ boards, agents, spawnRequests, harnesses, mcp, mcpServers, settings });
      if (api.bench.autorun > 0) {
        await get().createBenchBoard(api.bench.autorun);
        return;
      }
      if (boards.length > 0) {
        const latest = [...boards].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        await get().openBoard(latest.id);
      } else {
        await get().createBoard('Первая доска');
      }
    },

    async refreshBoards() {
      set({ boards: await api.boards.list() });
    },

    async openBoard(id) {
      const board = await api.boards.get(id);
      set({ board, selection: [], selectedArrow: null, zoneSelection: null, drafts: {}, ghosts: [], entering: {}, motion: {} });
    },

    async createBoard(title, rootDir) {
      const board = await api.boards.create({ title, rootDir });
      set({ board, selection: [], selectedArrow: null, drafts: {}, ghosts: [], entering: {} });
      await get().refreshBoards();
    },

    async deleteBoard(id) {
      const deletingCurrent = get().board?.id === id;
      await api.boards.remove(id);
      let boards = await api.boards.list();
      const agents = get().agents.filter((agent) => agent.boardId !== id);

      if (boards.length === 0) {
        const board = await api.boards.create({ title: 'Первая доска' });
        boards = await api.boards.list();
        set({
          boards,
          board,
          agents,
          selection: [],
          selectedArrow: null,
          zoneSelection: null,
          drafts: {},
          ghosts: [],
          entering: {},
          motion: {},
        });
        return;
      }

      if (deletingCurrent) {
        const next = [...boards].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        const board = await api.boards.get(next.id);
        set({
          boards,
          board,
          agents,
          selection: [],
          selectedArrow: null,
          zoneSelection: null,
          drafts: {},
          ghosts: [],
          entering: {},
          motion: {},
        });
        return;
      }

      set({ boards, agents });
    },

    async createBenchBoard(count) {
      const board = await api.boards.bench(count);
      set({ board, selection: [], selectedArrow: null, drafts: {}, ghosts: [], entering: {} });
      await get().refreshBoards();
    },

    applyBoardEvent(event) {
      const current = get().board;
      if (event.type === 'board_reset') {
        if (current?.id === event.board.id) set({ board: event.board });
        void get().refreshBoards();
        return;
      }
      if (!current || current.id !== event.boardId) {
        void get().refreshBoards();
        return;
      }
      if (event.version <= current.version) return;
      if (event.version !== current.version + 1) {
        // Missed a delta somewhere: a fresh copy is cheaper than a wrong board.
        void get().openBoard(current.id);
        return;
      }

      animateDelta(current, event);
      const state = applyStateChange(current.state, event.change);
      const board: Board = {
        ...current,
        ...event.meta,
        state,
        version: event.version,
      };
      const alive = new Set(state.artifacts.map((a) => a.id));
      const selectedArrow = get().selectedArrow;
      const drafts = get().drafts;
      const touched = new Set(event.change.artifacts.upsert.map((u) => u.entity.id));
      const keptDrafts: Record<string, Partial<Rect>> = {};
      // A committed drag's draft is dropped the moment its delta lands; the
      // slide from draft to snapped position takes over from there.
      for (const [id, draft] of Object.entries(drafts)) if (!touched.has(id) && alive.has(id)) keptDrafts[id] = draft;
      set({
        board,
        drafts: event.origin === 'renderer' ? keptDrafts : drafts,
        selection: get().selection.filter((id) => alive.has(id)),
        selectedArrow: selectedArrow && state.arrows.some((a) => a.id === selectedArrow) ? selectedArrow : null,
      });
    },

    select(ids) {
      set({ selection: ids, selectedArrow: null, ...(ids.length > 0 ? { zoneSelection: null } : {}) });
    },

    selectArrow(id) {
      set({ selectedArrow: id, selection: [] });
    },

    setDrafts(drafts) {
      set({ drafts });
    },

    commitDrafts: guarded(async () => {
      const { board, drafts } = get();
      if (!board) return;
      for (const [id, draft] of Object.entries(drafts)) {
        await api.artifacts.update(board.id, id, {
          ...(draft.x !== undefined ? { x: snap(draft.x) } : {}),
          ...(draft.y !== undefined ? { y: snap(draft.y) } : {}),
          ...(draft.width !== undefined ? { width: snap(draft.width) } : {}),
          ...(draft.height !== undefined ? { height: snap(draft.height) } : {}),
        });
      }
      // Normally already cleared by the delta; this covers a drop that changed nothing.
      set({ drafts: {} });
    }),

    async createAt(type, topLeft, props) {
      const board = get().board;
      if (!board) return null;
      try {
        const artifact = await api.artifacts.create(board.id, {
          type,
          x: snap(topLeft.x),
          y: snap(topLeft.y),
          props: props ?? {},
        });
        set({ selection: [artifact.id], selectedArrow: null });
        return artifact.id;
      } catch (error) {
        get().notify(error instanceof Error ? error.message : String(error));
        return null;
      }
    },

    patchProps: guarded(async (id: string, props: Record<string, unknown>) => {
      const board = get().board;
      if (!board) return;
      await api.artifacts.update(board.id, id, { props });
    }),

    removeSelection: guarded(async () => {
      const { board, selection, selectedArrow } = get();
      if (!board) return;
      if (selectedArrow) {
        await api.arrows.remove(board.id, selectedArrow);
        set({ selectedArrow: null });
        return;
      }
      for (const id of selection) await api.artifacts.remove(board.id, id);
      set({ selection: [] });
    }),

    connect: guarded(async (fromId: string, toId: string) => {
      const board = get().board;
      if (!board || fromId === toId) return;
      const arrow = await api.arrows.create(board.id, { fromId, toId, routing: 'orthogonal' });
      set({ selectedArrow: arrow.id, selection: [] });
    }),

    undo: guarded(async () => {
      const board = get().board;
      if (board) await api.boards.undo(board.id);
    }),

    redo: guarded(async () => {
      const board = get().board;
      if (board) await api.boards.redo(board.id);
    }),

    applyAgentEvent(event) {
      const agents = get().agents;
      switch (event.type) {
        case 'agent_added':
          set({ agents: [...agents.filter((a) => a.id !== event.agent.id), event.agent] });
          break;
        case 'agent_updated':
          set({ agents: agents.map((a) => (a.id === event.agent.id ? event.agent : a)) });
          break;
        case 'agent_removed':
          set({ agents: agents.filter((a) => a.id !== event.agentId) });
          break;
        case 'spawn_requested':
          set({ spawnRequests: [...get().spawnRequests, event.request] });
          break;
        case 'spawn_resolved':
          set({ spawnRequests: get().spawnRequests.filter((r) => r.id !== event.requestId) });
          break;
      }
    },

    focusArtifact(id) {
      set({ focusRequest: { id, nonce: Date.now() }, selection: [id], selectedArrow: null });
    },

    setTool(tool) {
      // Leaving zone mode drops the zone being edited, so a later drag on the
      // board does not quietly reshape a zone the user stopped thinking about.
      set({ tool, ...(tool === 'zone' ? {} : { zoneSelection: null }) });
    },

    selectZone(id) {
      set({ zoneSelection: id, ...(id ? { selection: [], selectedArrow: null } : {}) });
    },

    resolveSpawn: guarded(async (requestId: string, approved: boolean) => {
      // The list is trimmed here as well as on the event: the answer travels
      // through main and back, and the banner should go on the click.
      set({ spawnRequests: get().spawnRequests.filter((r) => r.id !== requestId) });
      if (approved) await api.agents.approve(requestId);
      else await api.agents.decline(requestId, 'Пользователь отклонил запрос');
    }),

    setView(view) {
      set({ view });
    },

    setMcpServer: guarded(async (id: string, enabled: boolean) => {
      set({ mcpServers: await api.mcp.setServerEnabled(id, enabled) });
    }),

    setSetting: guarded(async (key: string, value: unknown) => {
      // Applied at once so the switch answers the click, then confirmed by the
      // set the main process writes back.
      set({ settings: { ...get().settings, [key]: value } });
      set({ settings: await api.settings.set(key, value) });
    }),

    beginPlacement(type, clientX, clientY, props, label) {
      set({
        placement: {
          type,
          props: props ?? {},
          label: label ?? artifactDefinition(type).label,
          mode: 'press',
          clientX,
          clientY,
          startX: clientX,
          startY: clientY,
        },
      });
    },

    movePlacement(clientX, clientY) {
      const placement = get().placement;
      if (!placement) return;
      const moved = Math.hypot(clientX - placement.startX, clientY - placement.startY) > 5;
      set({
        placement: {
          ...placement,
          clientX,
          clientY,
          mode: placement.mode === 'press' && moved ? 'drag' : placement.mode,
        },
      });
    },

    setPlacementMode(mode) {
      const placement = get().placement;
      if (placement) set({ placement: { ...placement, mode } });
    },

    endPlacement() {
      set({ placement: null });
    },

    stopMotion(ids) {
      for (const id of ids) motion.cancel(id);
    },

    notify(text) {
      set({ toast: { text, nonce: Date.now() } });
    },
  };
});
