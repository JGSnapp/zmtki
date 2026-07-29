import path from 'node:path';
import {
  BOARD_FILE_NAME,
  createEmptyBoard,
  createStickerNode,
  isAgentFrame,
  isArtifactNode,
  isMostlyInside,
  outlineNode,
  rectOf,
  renderPeripheralIndex,
  serializeBoard,
  summarizeArtifact
} from '@zmtki/board-schema';
import {
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
  DEFAULT_ARTIFACT_ETIQUETTE,
  mergeMissingEtiquetteDefaults,
  type AppSettings
} from '../app/settings.js';
import {
  OpSchema,
  type BoardOp,
  type BoardSpatialEvent,
  type EventMsg,
  type Op,
  type OpResult,
  type Submission
} from '@zmtki/protocol';
import { ApprovalBroker } from '../agents/ApprovalBroker.js';
import { AgentDirectory } from '../app/AgentDirectory.js';
import { AgentInbox } from '../app/AgentInbox.js';
import { AppDatabase } from '../app/AppDatabase.js';
import { ChatGptAuth, startDeviceLogin } from '../llm/chatgpt.js';
import { ExtensionHost } from '../extensions/McpHub.js';
import { BoardEventBus } from '../board/BoardEventBus.js';
import { relativePosition } from '../board/SpatialLayoutEngine.js';
import { StickerPackStore } from '../stickers/StickerPackStore.js';
import { EndpointRegistry, passthroughSecrets, type SecretStore } from '../llm/registry.js';
import { bindExtensionHost } from '../tools/index.js';
import { NotificationHub } from '../notifications/NotificationHub.js';
import { RoomBus } from '../rooms/RoomBus.js';
import { SearchService, type SearchKeys } from '../search/SearchService.js';
import { TerminalManager } from '../terminal/TerminalManager.js';
import type { ToolServices } from '../tools/registry.js';
import { Emitter } from '../util/emitter.js';
import { ensureDir, pathExists, writeFileAtomic } from '../util/fs.js';
import { BoardSession } from './BoardSession.js';
import { TurnScheduler } from './TurnScheduler.js';

export interface WorkspaceState {
  boards: Array<{ id: string; name: string; path: string }>;
  activeBoardId: string | null;
}

const KV_OPEN_BOARDS = 'workspace.openBoards';
const KV_ACTIVE_BOARD = 'workspace.activeBoard';
const KV_SETTINGS = 'app.settings';
const KV_SEARCH_KEYS = 'search.keys';

/**
 * The core process, seen from the UI as one object that takes Submissions and
 * emits Events.
 *
 * Single dispatch point on purpose: every mutation, whether from a human click
 * or an agent tool, goes through here, which is where cross-board rules
 * (concurrency, notifications, waking agents) can actually be enforced.
 */
export class Workspace {
  readonly onEvent = new Emitter<EventMsg>();

  readonly approvals = new ApprovalBroker();
  readonly terminals = new TerminalManager();

  private db!: AppDatabase;
  private settings: AppSettings = DEFAULT_APP_SETTINGS;
  private searchKeys: SearchKeys = { brave: '', tavily: '', serper: '', googlePse: '' };
  private secrets: SecretStore = passthroughSecrets;

  private endpointsRegistry!: EndpointRegistry;
  private chatgpt!: ChatGptAuth;
  private pendingLogin: { cancel(): void } | null = null;
  private extensions!: ExtensionHost;
  private boardEvents = new BoardEventBus();
  private stickers!: StickerPackStore;
  private directory!: AgentDirectory;
  private inbox!: AgentInbox;
  private rooms!: RoomBus;
  private notifications!: NotificationHub;
  private search!: SearchService;
  private scheduler!: TurnScheduler;

  private sessions = new Map<string, BoardSession>();
  private activeBoardId: string | null = null;

  constructor(private readonly appDir: string) {}

  async init(secrets?: SecretStore): Promise<void> {
    if (secrets) this.secrets = secrets;

    this.db = await AppDatabase.open(path.join(this.appDir, 'app.db'));
    const loaded = AppSettingsSchema.parse(this.db.getKv<unknown>(KV_SETTINGS, {}));
    // Own the array; append any new factory rules the user doesn't have yet.
    const etiquette = mergeMissingEtiquetteDefaults(loaded.artifactEtiquette);
    this.settings = { ...loaded, artifactEtiquette: etiquette.rules };
    if (etiquette.added) this.db.setKv(KV_SETTINGS, this.settings);
    this.searchKeys = this.loadSearchKeys();

    this.endpointsRegistry = new EndpointRegistry(this.db, this.secrets);
    this.chatgpt = new ChatGptAuth(this.db, this.secrets);
    this.endpointsRegistry.useChatGpt(this.chatgpt);
    this.directory = new AgentDirectory(this.db);
    this.inbox = new AgentInbox(this.db);
    this.rooms = new RoomBus(this.db, this.directory, this.inbox, () => this.settings);
    this.notifications = new NotificationHub(
      this.db,
      () => this.settings,
      () => this.activeBoardId
    );
    this.search = new SearchService(
      () => this.settings,
      () => this.searchKeys
    );
    this.scheduler = new TurnScheduler(this.settings.maxConcurrentTurns);

    this.extensions = new ExtensionHost(this.appDir);
    await this.extensions.init();
    bindExtensionHost(this.extensions);

    this.stickers = new StickerPackStore(this.appDir);
    await this.stickers.reload();

    this.wireGlobals();
    await this.restoreOpenBoards();
    await this.syncExtensionsBoard();
    await this.syncStickersBoard();
    this.syncBoardEventSubscriptions();
  }

  // ---------------------------------------------------------------- submissions

  async submit(submission: Submission): Promise<OpResult> {
    const parsed = OpSchema.safeParse(submission.op);
    if (!parsed.success) {
      return { ok: false, error: `некорректная операция: ${parsed.error.issues[0]?.message ?? ''}` };
    }
    try {
      return await this.dispatch(parsed.data);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async dispatch(op: Op): Promise<OpResult> {
    switch (op.type) {
      case 'workspace.list':
        return { ok: true, value: this.state() };

      case 'workspace.openBoard': {
        const session = await this.openBoard(op.path);
        return { ok: true, value: { boardId: session.id } };
      }

      case 'workspace.createBoard': {
        const session = await this.createBoard(op.path, op.name);
        return { ok: true, value: { boardId: session.id } };
      }

      case 'workspace.closeBoard':
        await this.closeBoard(op.boardId);
        return { ok: true, value: null };

      case 'workspace.setActive':
        this.activeBoardId = op.boardId;
        this.db.setKv(KV_ACTIVE_BOARD, op.boardId);
        await this.syncExtensionsBoard();
        await this.syncStickersBoard();
        this.syncBoardEventSubscriptions();
        return { ok: true, value: null };

      case 'board.get': {
        const session = this.require(op.boardId);
        return { ok: true, value: session.board.toDoc() };
      }

      case 'board.apply': {
        const session = this.require(op.boardId);
        const before = this.snapshotFrameMembership(session);
        session.board.apply({ origin: null, ops: op.ops, ...(op.label ? { label: op.label } : {}) });
        this.handleHumanBoardOps(session, op.ops, before);
        return { ok: true, value: null };
      }

      case 'board.undo':
        this.require(op.boardId).board.undo();
        return { ok: true, value: null };

      case 'board.redo':
        this.require(op.boardId).board.redo();
        return { ok: true, value: null };

      case 'board.search': {
        const session = this.require(op.boardId);
        const query = op.query.toLowerCase();
        const matches = session.board.nodes.filter((node) => {
          const outline = outlineNode(node);
          return (
            outline.title.toLowerCase().includes(query) || outline.summary.toLowerCase().includes(query)
          );
        });
        return { ok: true, value: matches.map(outlineNode) };
      }

      case 'board.tidy': {
        const session = this.require(op.boardId);
        return { ok: true, value: { moved: session.board.tidy() } };
      }

      case 'agent.list':
        return { ok: true, value: this.allAgents() };

      case 'agent.create': {
        const session = this.require(op.boardId);
        const agent = session.agents.create({
          name: op.name,
          persona: op.persona,
          ...(op.endpointId ? { endpointId: op.endpointId } : {}),
          ...(op.model ? { model: op.model } : {})
        });
        this.syncDirectory(session);
        // Every agent gets a DM immediately: the first thing a user wants after
        // creating one is to talk to it.
        const room = this.rooms.dmWith(agent.id);
        // The shared project channel appears as soon as there is someone to
        // share it with, and every later agent joins it.
        this.ensureProjectChannel(session);
        this.emit({ type: 'room.list', rooms: this.rooms.list() });
        return { ok: true, value: { agent, roomId: room.id } };
      }

      case 'agent.update': {
        const session = this.sessionOfAgent(op.agentId);
        if (!session) return { ok: false, error: 'агент не найден' };
        const updated = session.agents.update(op.agentId, op.patch);
        this.syncDirectory(session);
        return { ok: true, value: updated };
      }

      case 'agent.delete': {
        const session = this.sessionOfAgent(op.agentId);
        if (!session) return { ok: false, error: 'агент не найден' };
        session.runtime.interrupt(op.agentId);
        this.scheduler.dropAgent(op.agentId);
        session.agents.remove(op.agentId);
        this.inbox.clear(op.agentId);
        this.syncDirectory(session);
        return { ok: true, value: null };
      }

      case 'agent.interrupt': {
        const session = this.sessionOfAgent(op.agentId);
        if (!session) return { ok: false, error: 'агент не найден' };
        session.runtime.interrupt(op.agentId);
        this.scheduler.dropAgent(op.agentId);
        return { ok: true, value: null };
      }

      case 'room.list':
        return { ok: true, value: this.rooms.list() };

      case 'room.create': {
        const room = this.rooms.create({
          kind: op.kind,
          title: op.title,
          memberAgentIds: op.memberAgentIds,
          turnPolicy: op.turnPolicy,
          boardId: op.boardId
        });
        this.emit({ type: 'room.list', rooms: this.rooms.list() });
        return { ok: true, value: room };
      }

      case 'room.update': {
        const room = this.rooms.update(op.roomId, op.patch);
        if (room) this.emit({ type: 'room.updated', room });
        return room ? { ok: true, value: room } : { ok: false, error: 'комната не найдена' };
      }

      case 'room.delete':
        this.rooms.remove(op.roomId);
        this.emit({ type: 'room.list', rooms: this.rooms.list() });
        return { ok: true, value: null };

      case 'room.send':
        return await this.humanSend(op);

      case 'room.history':
        return { ok: true, value: this.rooms.history(op.roomId, op.limit) };

      case 'room.markRead':
        this.rooms.markRead(op.roomId);
        return { ok: true, value: null };

      case 'room.resume':
        this.rooms.resume(op.roomId);
        this.emit({ type: 'room.list', rooms: this.rooms.list() });
        return { ok: true, value: null };

      case 'room.searchMessages':
        return { ok: true, value: this.rooms.searchMessages(op.query, op.limit) };

      case 'comment.create':
      case 'comment.reply':
        return this.addComment(op);

      case 'comment.resolve': {
        const session = this.require(op.boardId);
        const thread = session.comments.resolve(op.threadId, op.resolved);
        return thread ? { ok: true, value: thread } : { ok: false, error: 'тред не найден' };
      }

      case 'comment.list':
        return { ok: true, value: this.require(op.boardId).comments.list() };

      case 'approval.respond':
        this.approvals.resolve(op.requestId, op.approved, op.remember);
        this.emit({ type: 'approval.resolved', requestId: op.requestId, approved: op.approved });
        return { ok: true, value: null };

      case 'notification.list':
        return { ok: true, value: this.notifications.list(op.limit) };

      case 'notification.markRead':
        if (op.id) this.notifications.markRead([op.id]);
        else this.notifications.markAllRead();
        return { ok: true, value: null };

      case 'notification.act':
        return this.actOnNotification(op.id, op.actionId);

      case 'notification.setFocusMode':
        await this.setSettings({ focusMode: op.enabled });
        return { ok: true, value: null };

      case 'terminal.input':
        this.terminals.write(op.nodeId, op.data);
        return { ok: true, value: null };

      case 'terminal.resize':
        this.terminals.resize(op.nodeId, op.cols, op.rows);
        return { ok: true, value: null };

      case 'terminal.kill':
        this.terminals.kill(op.nodeId);
        return { ok: true, value: null };

      case 'terminal.spawn': {
        const session = this.require(op.boardId);
        this.terminals.spawn({ nodeId: op.nodeId, command: op.command, cwd: session.boardPath });
        return { ok: true, value: null };
      }

      case 'browser.navigate':
      case 'browser.setBounds':
        // Owned by the host process, which has the WebContentsView. Accepted
        // here so the renderer has one submission channel for everything.
        return { ok: true, value: null };

      case 'provider.list':
        return { ok: true, value: this.endpointsRegistry.views() };

      case 'provider.upsert': {
        const endpoint = this.endpointsRegistry.upsert(op.endpoint);
        // First endpoint added becomes the default, so agents work immediately.
        if (!this.settings.defaultEndpointId) {
          await this.setSettings({ defaultEndpointId: endpoint.id });
        }
        return { ok: true, value: this.endpointsRegistry.views() };
      }

      case 'provider.delete':
        this.endpointsRegistry.remove(op.endpointId);
        if (this.settings.defaultEndpointId === op.endpointId) {
          await this.setSettings({ defaultEndpointId: null });
        }
        return { ok: true, value: this.endpointsRegistry.views() };

      case 'provider.probe':
        return { ok: true, value: await this.endpointsRegistry.probe(op.endpointId) };

      case 'chatgpt.status':
        return { ok: true, value: this.chatgpt.status() };

      case 'chatgpt.login': {
        // Device flow: return the code for the UI, poll in the background.
        this.pendingLogin?.cancel();
        const login = await startDeviceLogin();
        this.pendingLogin = login;
        void login.completed
          .then((tokens) => {
            this.chatgpt.save(tokens);
            const endpoint = this.endpointsRegistry.ensureChatGptEndpoint();
            if (!this.settings.defaultEndpointId) {
              void this.setSettings({ defaultEndpointId: endpoint.id });
            }
            void this.endpointsRegistry.probe(endpoint.id).then(async (probe) => {
              const patch: Record<string, unknown> = {};
              if (!this.settings.defaultEndpointId) patch.defaultEndpointId = endpoint.id;
              if (!this.settings.defaultModel && probe.models[0]) {
                patch.defaultModel = probe.models[0];
              }
              if (Object.keys(patch).length > 0) await this.setSettings(patch);
              this.emit({ type: 'provider.list', endpoints: this.endpointsRegistry.views() });
            });
            this.emit({ type: 'chatgpt.status', status: this.chatgpt.status(), error: '' });
            this.emit({ type: 'provider.list', endpoints: this.endpointsRegistry.views() });
          })
          .catch((err: Error) => {
            if (err.name === 'AbortError') return;
            this.emit({
              type: 'chatgpt.status',
              status: this.chatgpt.status(),
              error: err.message
            });
          })
          .finally(() => {
            if (this.pendingLogin === login) this.pendingLogin = null;
          });
        return {
          ok: true,
          value: {
            userCode: login.start.userCode,
            verificationUri: login.start.verificationUri,
            expiresIn: login.start.expiresIn
          }
        };
      }

      case 'chatgpt.cancelLogin':
        this.pendingLogin?.cancel();
        this.pendingLogin = null;
        return { ok: true, value: null };

      case 'chatgpt.logout': {
        this.chatgpt.clear();
        this.endpointsRegistry.removeChatGptEndpoints();
        this.emit({ type: 'chatgpt.status', status: this.chatgpt.status(), error: '' });
        this.emit({ type: 'provider.list', endpoints: this.endpointsRegistry.views() });
        return { ok: true, value: this.chatgpt.status() };
      }

      case 'extensions.list':
        return { ok: true, value: this.extensions.snapshot() };

      case 'extensions.skills.upsert': {
        await this.extensions.upsertSkill({
          scope: op.scope,
          name: op.name,
          description: op.description,
          body: op.body
        });
        return { ok: true, value: this.extensions.snapshot() };
      }

      case 'extensions.skills.remove': {
        await this.extensions.removeSkill(op.scope, op.name);
        return { ok: true, value: this.extensions.snapshot() };
      }

      case 'extensions.mcp.upsert': {
        await this.extensions.upsertMcp(op.scope, op.name, {
          command: op.command,
          args: op.args,
          env: op.env,
          disabled: op.disabled
        });
        return { ok: true, value: this.extensions.snapshot() };
      }

      case 'extensions.mcp.remove': {
        await this.extensions.removeMcp(op.scope, op.name);
        return { ok: true, value: this.extensions.snapshot() };
      }

      case 'extensions.mcp.test':
        return { ok: true, value: await this.extensions.testMcp(op.name) };

      case 'artifact.control': {
        const session = this.require(op.boardId);
        const node = session.board.getNode(op.nodeId);
        if (!node || node.type !== 'artifact' || node.artifact.kind !== 'controls') {
          return { ok: false, error: 'controls-артефакт не найден' };
        }
        const items = [...(node.artifact.items ?? [])];
        const idx = items.findIndex((i) => i.id === op.controlId);
        if (idx >= 0) {
          const item = items[idx]!;
          if (item.type !== 'button') {
            items[idx] = { ...item, value: op.value as never } as typeof item;
            session.board.apply({
              origin: null,
              ops: [
                {
                  op: 'updateNode',
                  id: op.nodeId,
                  patch: { artifact: { ...node.artifact, items } }
                }
              ]
            });
          }
        }
        const frame = session.board.nodes.find(
          (n) => isAgentFrame(n) && n.agentId && isMostlyInside(rectOf(node), rectOf(n))
        );
        const agentId =
          (frame && isAgentFrame(frame) ? frame.agentId : null) ||
          node.createdBy ||
          undefined;
        const event: BoardSpatialEvent = {
          type: 'artifact.control_invoked',
          at: Date.now(),
          nodeId: op.nodeId,
          agentId: agentId ?? undefined,
          frameId: frame?.id,
          detail: op.action || op.controlId,
          payload: { controlId: op.controlId, action: op.action, value: op.value }
        };
        this.dispatchBoardEvent(session.id, event);
        return { ok: true, value: null };
      }

      case 'stickers.list':
        return {
          ok: true,
          value: this.stickers.list().map((p) => ({
            id: p.id,
            name: p.name,
            scope: p.scope,
            stickers: p.stickers.map((s) => ({
              id: s.id,
              emoji: s.emoji,
              // Custom scheme — file:// is blocked by renderer CSP.
              src: `zmtki-sticker://${encodeURIComponent(p.id)}/${encodeURIComponent(s.id)}`
            }))
          }))
        };

      case 'stickers.upsertPack': {
        const pack = await this.stickers.upsertPack(op.scope, op.id, op.name);
        return { ok: true, value: pack };
      }

      case 'stickers.removePack': {
        await this.stickers.removePack(op.scope, op.id);
        return { ok: true, value: null };
      }

      case 'stickers.addSticker': {
        const sticker = await this.stickers.addSticker({
          scope: op.scope,
          packId: op.packId,
          id: op.id,
          sourcePath: op.sourcePath,
          emoji: op.emoji
        });
        return { ok: true, value: sticker };
      }

      case 'stickers.removeSticker': {
        await this.stickers.removeSticker(op.scope, op.packId, op.id);
        return { ok: true, value: null };
      }

      case 'stickers.place': {
        const result = await this.placeSticker({
          boardId: op.boardId,
          packId: op.packId,
          stickerId: op.stickerId,
          position: op.position
        });
        return result.ok
          ? { ok: true, value: { nodeId: result.nodeId } }
          : { ok: false, error: result.error ?? 'не удалось' };
      }

      case 'node.setLock': {
        const session = this.require(op.boardId);
        const node = session.board.getNode(op.nodeId);
        if (!node) return { ok: false, error: 'узел не найден' };
        const lock = { ...(node.lock ?? { delete: false, move: false, edit: false }), ...op.lock };
        session.board.apply({
          origin: null,
          ops: [{ op: 'updateNode', id: op.nodeId, patch: { lock } }]
        });
        this.dispatchBoardEvent(session.id, {
          type: 'node.locked_changed',
          at: Date.now(),
          nodeId: op.nodeId,
          payload: { lock }
        });
        return { ok: true, value: null };
      }

      case 'node.setVisualState': {
        const session = this.require(op.boardId);
        const node = session.board.getNode(op.nodeId);
        if (!node) return { ok: false, error: 'узел не найден' };
        const patch: Record<string, unknown> = { visualState: op.visualState };
        const meta = { ...(node.meta ?? {}) };
        if (op.visualState !== 'expanded' && node.visualState === 'expanded') {
          meta.expandedSize = { ...node.size };
          patch.meta = meta;
          if (op.visualState === 'widget') patch.size = { w: Math.min(node.size.w, 280), h: 72 };
          if (op.visualState === 'icon') patch.size = { w: 64, h: 64 };
        }
        if (op.visualState === 'expanded' && meta.expandedSize) {
          patch.size = meta.expandedSize;
          delete meta.expandedSize;
          patch.meta = meta;
        }
        session.board.apply({
          origin: null,
          ops: [{ op: 'updateNode', id: op.nodeId, patch }]
        });
        this.dispatchBoardEvent(session.id, {
          type: 'artifact.state_changed',
          at: Date.now(),
          nodeId: op.nodeId,
          detail: op.visualState
        });
        return { ok: true, value: null };
      }

      case 'settings.get':
        return { ok: true, value: this.settings };

      case 'settings.set':
        return { ok: true, value: await this.setSettings(op.patch) };

      case 'camera.set': {
        const session = this.require(op.boardId);
        session.board.apply({ origin: null, ops: [{ op: 'setCamera', camera: op.camera }] });
        return { ok: true, value: null };
      }

      default: {
        const exhaustive: never = op;
        return { ok: false, error: `неизвестная операция: ${JSON.stringify(exhaustive)}` };
      }
    }
  }

  // -------------------------------------------------------------------- boards

  async openBoard(boardPath: string): Promise<BoardSession> {
    const resolved = path.resolve(boardPath);
    const existing = [...this.sessions.values()].find((s) => s.boardPath === resolved);
    if (existing) return existing;

    if (!(await pathExists(path.join(resolved, BOARD_FILE_NAME)))) {
      throw new Error(`это не папка доски: ${resolved}`);
    }

    const session = await BoardSession.open({
      boardPath: resolved,
      endpoints: this.endpointsRegistry,
      settings: () => this.settings,
      approvals: this.approvals,
      extensions: this.extensions,
      services: this.toolServices()
    });

    session.onEvent.on((event) => this.onBoardEvent(session, event));

    this.sessions.set(session.id, session);
    this.syncDirectory(session);
    this.ensureProjectChannel(session);
    session.emitInitialState();
    await this.persistOpenBoards();

    if (!this.activeBoardId) this.activeBoardId = session.id;
    await this.syncExtensionsBoard();
    await this.syncStickersBoard();
    this.syncBoardEventSubscriptions();
    this.emit({ type: 'room.list', rooms: this.rooms.list() });
    return session;
  }

  async createBoard(boardPath: string, name: string): Promise<BoardSession> {
    const resolved = path.resolve(boardPath);
    await ensureDir(resolved);
    const file = path.join(resolved, BOARD_FILE_NAME);
    if (!(await pathExists(file))) {
      const doc = createEmptyBoard(name || path.basename(resolved));
      await writeFileAtomic(file, serializeBoard(doc));
    }
    return this.openBoard(resolved);
  }

  async closeBoard(boardId: string): Promise<void> {
    const session = this.sessions.get(boardId);
    if (!session) return;
    this.scheduler.dropBoard(boardId);
    await session.close();
    this.sessions.delete(boardId);
    if (this.activeBoardId === boardId) {
      this.activeBoardId = [...this.sessions.keys()][0] ?? null;
    }
    await this.persistOpenBoards();
  }

  state(): WorkspaceState {
    return {
      boards: [...this.sessions.values()].map((s) => ({ id: s.id, name: s.name, path: s.boardPath })),
      activeBoardId: this.activeBoardId
    };
  }

  /** Absolute path of a sticker file for the privileged renderer protocol. */
  resolveStickerFile(packId: string, stickerId: string): string | null {
    return this.stickers.getSticker(packId, stickerId)?.src ?? null;
  }

  session(boardId: string): BoardSession | undefined {
    return this.sessions.get(boardId);
  }

  private require(boardId: string): BoardSession {
    const session = this.sessions.get(boardId);
    if (!session) throw new Error(`доска не открыта: ${boardId}`);
    return session;
  }

  private sessionOfAgent(agentId: string): BoardSession | undefined {
    return [...this.sessions.values()].find((s) => s.agents.get(agentId) !== undefined);
  }

  private allAgents() {
    return [...this.sessions.values()].flatMap((s) => s.agents.list());
  }

  // ------------------------------------------------------------------ messaging

  /**
   * A human message either steers the agent's running turn or starts a new one.
   *
   * Steering matters: without it, typing "стоп, не туда" while an agent works
   * would sit in a queue until the wrong work was finished.
   */
  private async humanSend(op: {
    roomId: string;
    body: string;
    steer: boolean;
    attachments?: Array<{ name: string; path: string; mime: string; size: number }>;
    sticker?: {
      packId: string;
      stickerId: string;
      src: string;
      emoji?: string;
    } | null;
  }): Promise<OpResult> {
    const attachments = await this.materializeChatAttachments(op.attachments ?? []);
    let body = op.body.trim();
    if (!body && op.sticker) body = op.sticker.emoji ? `стикер ${op.sticker.emoji}` : 'стикер';
    if (!body && attachments.length > 0) {
      body = attachments.map((a) => a.name).join(', ');
    }
    if (!body && !op.sticker && attachments.length === 0) {
      return { ok: false, error: 'пустое сообщение' };
    }

    const outcome = this.rooms.send({
      roomId: op.roomId,
      authorId: 'human',
      body,
      attachments,
      sticker: op.sticker ?? null
    });
    if (!outcome.ok) return { ok: false, error: outcome.error ?? 'не отправлено' };

    if (outcome.wake.length === 0) {
      const room = this.rooms.get(op.roomId);
      const hasAgents = room?.members.some((m) => m.kind === 'agent');
      if (!hasAgents) {
        this.rooms.systemNotice(op.roomId, 'В этом чате нет агентов — добавьте участника или напишите в личный чат агента.');
      } else if (room?.turnPolicy === 'mention-only') {
        this.rooms.systemNotice(op.roomId, 'Никого не разбудили. Упомяните агента через @имя или смените политику на «свободно».');
      }
    }

    // Fail fast in the chat itself when nothing can talk to a model.
    if (outcome.wake.length > 0 && !this.settings.defaultEndpointId) {
      const anyEndpoint = this.endpointsRegistry.list().length > 0;
      this.rooms.systemNotice(
        op.roomId,
        anyEndpoint
          ? 'Не выбран провайдер по умолчанию — откройте Настройки → Провайдеры и нажмите Default.'
          : 'Нет LLM-провайдера. Откройте Настройки → Провайдеры и подключите ChatGPT или API-ключ.'
      );
      return { ok: true, value: { messageId: outcome.message?.id ?? null, woke: [] } };
    }

    const wakeText = [
      body,
      attachments.length
        ? `\n\n[вложения]\n${attachments.map((a) => `- ${a.name} (${a.path})`).join('\n')}`
        : '',
      op.sticker ? `\n\n[стикер ${op.sticker.packId}/${op.sticker.stickerId}]` : ''
    ].join('');

    for (const agentId of outcome.wake) {
      const session = this.sessionOfAgent(agentId);
      if (!session) {
        this.notifications.notify({
          kind: 'mentioned',
          title: 'Агент в закрытом проекте',
          body: `${this.directory.get(agentId)?.name ?? agentId} получит сообщение при открытии проекта.`,
          link: { roomId: op.roomId, agentId }
        });
        continue;
      }
      if (op.steer && session.runtime.steer(agentId, wakeText)) continue;
      this.wakeAgent(session, agentId, op.roomId, wakeText, 'user');
    }

    return { ok: true, value: { messageId: outcome.message?.id ?? null, woke: outcome.wake } };
  }

  private async materializeChatAttachments(
    items: Array<{ name: string; path: string; mime: string; size: number }>
  ): Promise<Array<{ id: string; name: string; path: string; mime: string; size: number }>> {
    if (items.length === 0) return [];
    const { newId } = await import('@zmtki/board-schema');
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const root = pathMod.join(this.appDir, 'chat-files');
    await ensureDir(root);
    const out: Array<{ id: string; name: string; path: string; mime: string; size: number }> = [];
    for (const item of items) {
      const id = newId('file');
      const dest = pathMod.join(root, `${id}-${item.name.replace(/[^\w.-]+/g, '_')}`);
      try {
        await fs.copyFile(item.path, dest);
        const stat = await fs.stat(dest);
        out.push({
          id,
          name: item.name,
          path: dest,
          mime: item.mime || 'application/octet-stream',
          size: stat.size
        });
      } catch (err) {
        out.push({
          id,
          name: item.name,
          path: item.path,
          mime: item.mime || 'application/octet-stream',
          size: item.size
        });
        void err;
      }
    }
    return out;
  }

  private wakeAgent(
    session: BoardSession,
    agentId: string,
    roomId: string | null,
    text: string,
    source: 'user' | 'agent' | 'comment' | 'system'
  ): void {
    const queued = this.scheduler.enqueue({
      agentId,
      boardId: session.id,
      priority: source === 'user' ? 10 : 1,
      run: async () => {
        const digest = this.inbox.drain(agentId);
        const prompt = digest.digest ? `${digest.digest}\n\n---\n\n${text}` : text;
        const result = await session.runTurn(agentId, {
          source,
          text: prompt,
          roomId
        });

        if (roomId) {
          this.rooms.addSpend(roomId, result.usage.totalTokens, result.usage.costUsd);
          if (result.stopReason === 'error') {
            this.rooms.systemNotice(
              roomId,
              `${this.directory.get(agentId)?.name ?? 'Агент'}: ${result.error ?? 'ошибка хода'}`
            );
          } else if (
            result.finalText.trim() &&
            !(result.postedRoomIds ?? []).includes(roomId)
          ) {
            const sent = this.rooms.send({
              roomId,
              authorId: agentId,
              body: result.finalText,
              turnId: result.turnId
            });
            for (const next of sent.wake) {
              const nextSession = this.sessionOfAgent(next);
              if (nextSession) this.wakeAgent(nextSession, next, roomId, result.finalText, 'agent');
            }
          }
        }

        this.notifyTurnResult(session, agentId, roomId, result);
      }
    });

    if (!queued) {
      // Already running or queued: the inbox already holds the message, so it
      // will be read at the start of the turn that is about to happen.
      this.emit({ type: 'scheduler.state', ...this.scheduler.state });
    }
  }

  private notifyTurnResult(
    session: BoardSession,
    agentId: string,
    roomId: string | null,
    result: { stopReason: string; error?: string; finalText: string }
  ): void {
    const agent = session.agents.get(agentId);
    const name = agent?.name ?? agentId;

    if (result.stopReason === 'error') {
      this.notifications.notify({
        kind: 'turnFailed',
        title: `${name}: ошибка`,
        body: result.error ?? '',
        link: { boardId: session.id, agentId, roomId }
      });
      return;
    }
    if (result.stopReason === 'maxRounds') {
      this.notifications.notify({
        kind: 'roomPaused',
        title: `${name} остановлен на лимите раундов`,
        body: 'Проверьте, что происходит на доске, и подтолкните агента.',
        link: { boardId: session.id, agentId, roomId }
      });
      return;
    }
    this.notifications.notify({
      kind: 'turnComplete',
      title: `${name} закончил`,
      body: result.finalText.slice(0, 200),
      link: { boardId: session.id, agentId, roomId },
      coalesceKey: `turn:${agentId}`
    });
  }

  private addComment(
    op: Extract<Op, { type: 'comment.create' } | { type: 'comment.reply' }>
  ): OpResult {
    const session = this.require(op.boardId);
    const isReply = op.type === 'comment.reply';
    const nodeId = isReply
      ? (session.comments.list().find((t) => t.id === op.threadId)?.nodeId ?? '')
      : op.nodeId;

    const { thread, mentioned } = session.comments.add(
      {
        nodeId,
        body: op.body,
        author: { kind: 'human', name: 'Вы' },
        anchor: isReply ? null : op.anchor,
        threadId: isReply ? op.threadId : null
      },
      (handle) => session.agents.byHandle(handle)?.id
    );

    // A comment with no @mention still needs an owner, otherwise leaving one on
    // an agent's artifact would do nothing. Falls back to whoever made the node.
    const node = session.board.getNode(nodeId);
    const owner = node?.createdBy ?? null;
    const targets = mentioned.length > 0 ? mentioned : owner ? [owner] : [];

    for (const agentId of targets) {
      if (!session.agents.get(agentId)) continue;
      this.inbox.push({
        agentId,
        kind: 'comment',
        text: op.body.slice(0, 500),
        roomId: null,
        boardId: session.id,
        nodeId,
        threadId: thread.id,
        fromId: 'human',
        hops: 0
      });
      const room = this.rooms.dmWith(agentId);
      this.wakeAgent(
        session,
        agentId,
        room.id,
        `К тебе комментарий на артефакте ${nodeId}: ${op.body}`,
        'comment'
      );
    }

    return { ok: true, value: thread };
  }

  private actOnNotification(id: string, actionId: string): OpResult {
    const notification = this.notifications.get(id);
    if (!notification) return { ok: false, error: 'уведомление не найдено' };

    const action = notification.actions.find((a) => a.id === actionId);
    if (action?.kind === 'approve' || action?.kind === 'deny') {
      // The action id doubles as the approval request id, so approving from a
      // notification and from the inline card follow the same path.
      this.approvals.resolve(actionId, action.kind === 'approve');
    }
    if (action?.kind === 'resume' && notification.link.roomId) {
      this.rooms.resume(notification.link.roomId);
    }

    this.notifications.resolveAction(id, actionId);
    return { ok: true, value: null };
  }

  // ------------------------------------------------------------------- plumbing

  private toolServices(): Omit<ToolServices, 'delegate' | 'comments'> {
    return {
      search: {
        search: async (query, limit) => {
          const outcome = await this.search.search(query, limit);
          return {
            results: outcome.results,
            provider: outcome.provider,
            attempts: outcome.attempts
          };
        }
      },
      terminal: {
        run: (options) =>
          this.terminals.run({
            nodeId: options.nodeId,
            command: options.command,
            cwd: options.cwd,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
          })
      },
      rooms: {
        send: async (input) => {
          const outcome = this.rooms.send({
            roomId: input.roomId,
            authorId: input.agentId,
            body: input.body,
            ...(input.mentions ? { mentions: input.mentions } : {}),
            ...(input.artifactRefs ? { artifactRefs: input.artifactRefs } : {}),
            ...(input.parentMessageId === undefined ? {} : { parentMessageId: input.parentMessageId })
          });
          if (!outcome.ok) return { ok: false, ...(outcome.error ? { error: outcome.error } : {}) };
          for (const agentId of outcome.wake) {
            const session = this.sessionOfAgent(agentId);
            if (session) this.wakeAgent(session, agentId, input.roomId, input.body, 'agent');
          }
          return { ok: true };
        },
        history: (roomId, limit) =>
          this.rooms.history(roomId, limit).map((m) => ({
            author: m.author.kind === 'human' ? 'Пользователь' : m.author.name,
            body: m.body,
            createdAt: m.createdAt
          })),
        listForAgent: (agentId) =>
          this.rooms.listForAgent(agentId).map((room) => ({
            id: room.id,
            title: room.title,
            kind: room.kind,
            members: room.members.map((m) => `${m.name} (${m.id})`)
          })),
        yieldTo: async (roomId, agentId, nextSpeaker) => {
          const result = this.rooms.yieldTo(roomId, agentId, nextSpeaker);
          if (result.ok) {
            const session = this.sessionOfAgent(nextSpeaker);
            if (session) {
              this.wakeAgent(session, nextSpeaker, roomId, 'Тебе передали слово в комнате.', 'agent');
            }
          }
          return result;
        }
      },
      directory: {
        search: (query) =>
          this.directory.search(query).map((entry) => ({
            agentId: entry.agentId,
            name: entry.name,
            handle: entry.handle,
            boardName: entry.boardName,
            boardId: entry.boardId,
            persona: entry.persona
          })),
        get: (agentId) => {
          const entry = this.directory.get(agentId);
          return entry
            ? {
                agentId: entry.agentId,
                name: entry.name,
                boardId: entry.boardId,
                boardPath: entry.boardPath
              }
            : undefined;
        }
      },
      boards: {
        readRemoteArtifact: async (boardId, nodeId) => {
          const session = this.sessions.get(boardId);
          if (!session) return undefined;
          const node = session.board.getNode(nodeId);
          if (!node) return undefined;
          return {
            title: isArtifactNode(node) ? node.artifact.title : outlineNode(node).title,
            summary: isArtifactNode(node) ? summarizeArtifact(node.artifact) : outlineNode(node).summary,
            boardName: session.name
          };
        }
      },
      boardEvents: {
        subscribe: async (boardId, agentId, event, filter) => {
          this.boardEvents.addSubscription(boardId, { agentId, event, filter });
          const session = this.sessions.get(boardId);
          const agent = session?.agents.get(agentId);
          if (agent) {
            const subs = [
              ...(agent.subscriptions ?? []).filter((s) => s.event !== event),
              { event, filter }
            ];
            session!.agents.update(agentId, { subscriptions: subs });
          }
        },
        unsubscribe: async (boardId, agentId, event) => {
          this.boardEvents.removeSubscription(boardId, agentId, event);
          const session = this.sessions.get(boardId);
          const agent = session?.agents.get(agentId);
          if (agent) {
            session!.agents.update(agentId, {
              subscriptions: (agent.subscriptions ?? []).filter((s) => s.event !== event)
            });
          }
        }
      },
      stickers: {
        list: () =>
          this.stickers.list().map((p) => ({
            id: p.id,
            name: p.name,
            scope: p.scope,
            stickers: p.stickers.map((s) => ({ id: s.id, emoji: s.emoji }))
          })),
        place: async (input) => this.placeSticker(input)
      }
    };
  }

  private wireGlobals(): void {
    this.approvals.onRequest.on((request) => {
      this.emit({ type: 'approval.request', request });
      const agent = this.directory.get(request.agentId);
      this.notifications.notify({
        kind: 'approvalRequired',
        title: `${agent?.name ?? request.agentId}: ${request.title}`,
        body: request.subject,
        link: { boardId: request.boardId, agentId: request.agentId },
        actions: [
          { id: request.id, label: 'Разрешить', kind: 'approve' },
          { id: `${request.id}:deny`, label: 'Отклонить', kind: 'deny' }
        ]
      });
    });

    this.terminals.onData.on(({ nodeId, data }) => {
      this.emit({ type: 'terminal.data', nodeId, data });
    });
    this.terminals.onExit.on(({ nodeId, exitCode }) => {
      this.emit({ type: 'terminal.exit', nodeId, exitCode });
      for (const session of this.sessions.values()) {
        if (!session.board.getNode(nodeId)) continue;
        this.dispatchBoardEvent(session.id, {
          type: 'terminal.exited',
          at: Date.now(),
          nodeId,
          detail: `exit ${exitCode}`,
          payload: { exitCode }
        });
      }
    });

    this.rooms.onMessage.on((message) => this.emit({ type: 'room.message', message }));
    this.rooms.onRoom.on((room) => this.emit({ type: 'room.updated', room }));

    this.notifications.onNew.on((notification) =>
      this.emit({ type: 'notification.new', notification })
    );
    this.notifications.onUpdated.on((notification) =>
      this.emit({ type: 'notification.updated', notification })
    );
    this.notifications.onCleared.on((ids) => this.emit({ type: 'notification.cleared', ids }));

    this.scheduler.onState.on((state) => this.emit({ type: 'scheduler.state', ...state }));
  }

  private onBoardEvent(session: BoardSession, event: EventMsg): void {
    this.emit(event);

    // Board-level events that carry app-level meaning are translated here, so
    // BoardSession stays unaware of notifications and the directory.
    if (event.type === 'agent.list') {
      this.syncDirectory(session);
    }
    if (event.type === 'turn.completed' && event.usage.totalTokens > 0) {
      this.emit({ type: 'scheduler.state', ...this.scheduler.state });
    }
  }

  private ensureProjectChannel(session: BoardSession): void {
    const agents = session.agents.list();
    if (agents.length < 2) return;
    const existing = this.rooms.list().find((r) => r.kind === 'channel' && r.boardId === session.id);
    if (existing) {
      this.rooms.addMembers(existing.id, agents.map((a) => a.id));
      return;
    }
    this.rooms.create({
      kind: 'channel',
      // No sigil in the stored title: the channel marker is presentation, and
      // the chat list adds its own.
      title: session.name,
      memberAgentIds: agents.map((a) => a.id),
      turnPolicy: 'mention-only',
      boardId: session.id
    });
  }

  private syncDirectory(session: BoardSession): void {
    this.directory.syncBoard(session.id, session.boardPath, session.name, session.agents.list());
  }

  private async setSettings(patch: Record<string, unknown>): Promise<AppSettings> {
    const next: Record<string, unknown> = { ...this.settings, ...patch };
    // null = reset etiquette to factory defaults (UI «Сбросить»).
    if (Object.prototype.hasOwnProperty.call(patch, 'artifactEtiquette') && patch.artifactEtiquette === null) {
      next.artifactEtiquette = DEFAULT_ARTIFACT_ETIQUETTE.map((r) => ({ ...r }));
    }
    const merged = AppSettingsSchema.parse(next);
    this.settings = merged;
    this.db.setKv(KV_SETTINGS, merged);
    this.scheduler.setLimit(merged.maxConcurrentTurns);
    return merged;
  }

  setSearchKey(provider: keyof SearchKeys, value: string): void {
    this.searchKeys = { ...this.searchKeys, [provider]: value };
    const encrypted: Record<string, string> = {};
    for (const [key, plain] of Object.entries(this.searchKeys)) {
      encrypted[key] = plain ? this.secrets.encrypt(plain) : '';
    }
    this.db.setKv(KV_SEARCH_KEYS, encrypted);
  }

  private loadSearchKeys(): SearchKeys {
    const stored = this.db.getKv<Record<string, string>>(KV_SEARCH_KEYS, {});
    const decrypt = (value: string | undefined): string => {
      if (!value) return '';
      try {
        return this.secrets.decrypt(value);
      } catch {
        return '';
      }
    };
    return {
      brave: decrypt(stored.brave),
      tavily: decrypt(stored.tavily),
      serper: decrypt(stored.serper),
      googlePse: decrypt(stored.googlePse)
    };
  }

  private async persistOpenBoards(): Promise<void> {
    this.db.setKv(
      KV_OPEN_BOARDS,
      [...this.sessions.values()].map((s) => s.boardPath)
    );
    this.db.setKv(KV_ACTIVE_BOARD, this.activeBoardId);
  }

  /** Reopens what was open last time, skipping folders that have since moved. */
  private async restoreOpenBoards(): Promise<void> {
    const paths = this.db.getKv<string[]>(KV_OPEN_BOARDS, []);
    for (const boardPath of paths) {
      try {
        await this.openBoard(boardPath);
      } catch {
        // Folder deleted or moved; drop it silently rather than blocking startup.
      }
    }
    const active = this.db.getKv<string | null>(KV_ACTIVE_BOARD, null);
    if (active && this.sessions.has(active)) this.activeBoardId = active;
  }

  /** Board outline for the workspace overview and the command palette. */
  overview(): Array<{ boardId: string; name: string; outline: string; agents: number }> {
    return [...this.sessions.values()].map((session) => ({
      boardId: session.id,
      name: session.name,
      outline: renderPeripheralIndex(session.board.nodes, 30),
      agents: session.agents.list().length
    }));
  }

  private async syncExtensionsBoard(): Promise<void> {
    const session = this.activeBoardId ? this.sessions.get(this.activeBoardId) : undefined;
    await this.extensions.setBoardDir(session?.boardPath ?? null);
  }

  private async syncStickersBoard(): Promise<void> {
    const session = this.activeBoardId ? this.sessions.get(this.activeBoardId) : undefined;
    this.stickers.setBoardDir(session?.boardPath ?? null);
    await this.stickers.reload();
  }

  private syncBoardEventSubscriptions(): void {
    for (const session of this.sessions.values()) {
      const list = session.agents.list().flatMap((agent) =>
        (agent.subscriptions ?? []).map((s) => ({
          agentId: agent.id,
          event: s.event,
          filter: s.filter
        }))
      );
      this.boardEvents.setSubscriptions(session.id, list);
    }
  }

  private snapshotFrameMembership(session: BoardSession): Map<string, string | null> {
    const map = new Map<string, string | null>();
    const frames = session.board.nodes.filter(isAgentFrame);
    for (const node of session.board.nodes) {
      if (node.type === 'frame') continue;
      const frame = frames.find((f) => isMostlyInside(rectOf(node), rectOf(f)));
      map.set(node.id, frame?.id ?? null);
    }
    return map;
  }

  private handleHumanBoardOps(
    session: BoardSession,
    ops: BoardOp[],
    before: Map<string, string | null>
  ): void {
    const after = this.snapshotFrameMembership(session);
    for (const [nodeId, prevFrame] of before) {
      const nextFrame = after.get(nodeId) ?? null;
      if (prevFrame === nextFrame) continue;
      if (nextFrame) {
        const frame = session.board.getNode(nextFrame);
        this.dispatchBoardEvent(session.id, {
          type: 'human.moved_into_frame',
          at: Date.now(),
          nodeId,
          frameId: nextFrame,
          agentId: frame && isAgentFrame(frame) ? frame.agentId : undefined,
          detail: `узел ${nodeId} попал в рамку`
        });
      }
      if (prevFrame) {
        const frame = session.board.getNode(prevFrame);
        this.dispatchBoardEvent(session.id, {
          type: 'human.moved_out_of_frame',
          at: Date.now(),
          nodeId,
          frameId: prevFrame,
          agentId: frame && isAgentFrame(frame) ? frame.agentId : undefined,
          detail: `узел ${nodeId} покинул рамку`
        });
      }
    }
    for (const op of ops) {
      if (op.op === 'addEdge') {
        this.dispatchBoardEvent(session.id, {
          type: 'human.drew_edge',
          at: Date.now(),
          edgeId: op.edge.id,
          detail: `${op.edge.from.nodeId} → ${op.edge.to.nodeId}`
        });
      }
      if (op.op === 'removeEdge') {
        this.dispatchBoardEvent(session.id, {
          type: 'human.removed_edge',
          at: Date.now(),
          edgeId: op.id
        });
      }
    }
  }

  private dispatchBoardEvent(boardId: string, event: BoardSpatialEvent): void {
    this.emit({ type: 'board.event', boardId, event });
    const wake = this.boardEvents.emit(boardId, event);
    const session = this.sessions.get(boardId);
    if (!session) return;
    const digest = `[board.event:${event.type}] ${event.detail ?? ''}\n${JSON.stringify(event.payload ?? {})}`;
    for (const agentId of wake) {
      const room = this.rooms.dmWith(agentId);
      this.inbox.push({
        agentId,
        kind: 'system',
        text: digest,
        roomId: room.id,
        boardId,
        nodeId: event.nodeId ?? null,
        threadId: null,
        fromId: 'board',
        hops: 0
      });
      this.wakeAgent(session, agentId, room.id, digest, 'system');
    }
  }

  private async placeSticker(input: {
    boardId: string;
    packId: string;
    stickerId: string;
    agentId?: string;
    relativeTo?: string;
    relation?: string;
    position?: { x: number; y: number };
  }): Promise<{ ok: boolean; nodeId?: string; error?: string }> {
    const session = this.sessions.get(input.boardId);
    if (!session) return { ok: false, error: 'доска не открыта' };
    const found = this.stickers.getSticker(input.packId, input.stickerId);
    if (!found) return { ok: false, error: 'стикер не найден' };

    let position = input.position ?? { x: 120, y: 120 };
    if (input.relativeTo && input.relation && input.relation !== 'inside') {
      const anchor = session.board.getNode(input.relativeTo);
      if (anchor) {
        position = relativePosition(
          anchor,
          input.relation as 'rightOf' | 'leftOf' | 'below' | 'above',
          { w: 128, h: 128 }
        );
      }
    }
    const node = createStickerNode({
      packId: input.packId,
      stickerId: input.stickerId,
      src: `zmtki-sticker://${encodeURIComponent(input.packId)}/${encodeURIComponent(input.stickerId)}`,
      position,
      emoji: found.sticker.emoji,
      createdBy: input.agentId ?? null
    });
    if (input.relation === 'inside' && input.relativeTo) {
      node.parentId = input.relativeTo;
    }
    session.board.apply({
      origin: input.agentId ?? null,
      ops: [{ op: 'addNode', node }]
    });
    return { ok: true, nodeId: node.id };
  }

  private emit(event: EventMsg): void {
    this.onEvent.emit(event);
  }

  async shutdown(): Promise<void> {
    this.terminals.killAll();
    await this.scheduler.drain();
    for (const session of [...this.sessions.values()]) await session.close();
    await this.extensions.shutdown();
    this.inbox.prune();
    await this.db.close();
  }
}
