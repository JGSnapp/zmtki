import path from 'node:path';
import {
  isArtifactNode,
  summarizeArtifact,
  type Agent,
  type AgentStatus
} from '@zmtki/board-schema';
import type { EventMsg } from '@zmtki/protocol';
import { AgentRuntime, type TurnInput, type TurnResult } from '../agents/AgentRuntime.js';
import { AgentStore } from '../agents/AgentStore.js';
import type { ApprovalBroker } from '../agents/ApprovalBroker.js';
import { BoardStore } from '../board/BoardStore.js';
import { CommentStore } from '../comments/CommentStore.js';
import type { AppSettings } from '../app/settings.js';
import type { EndpointRegistry } from '../llm/registry.js';
import type { ExtensionHost } from '../extensions/McpHub.js';
import type { ToolServices } from '../tools/registry.js';
import { Emitter } from '../util/emitter.js';

export interface BoardSessionDeps {
  boardPath: string;
  endpoints: EndpointRegistry;
  settings: () => AppSettings;
  approvals: ApprovalBroker;
  extensions?: ExtensionHost;
  /**
   * Cross-board services owned by the workspace. Comments and delegation are
   * board-local, so the session supplies those itself.
   */
  services: Omit<ToolServices, 'delegate' | 'comments'>;
}

/**
 * One open board: its document, agents, comments and runtime.
 *
 * Keeping this per-board rather than global is what makes several projects open
 * at once tractable — each session is independently closable, and nothing in it
 * reaches into another board except through the workspace-provided services.
 */
export class BoardSession {
  readonly onEvent = new Emitter<EventMsg>();

  readonly agents: AgentStore;
  readonly comments: CommentStore;
  readonly runtime: AgentRuntime;

  static async open(deps: BoardSessionDeps): Promise<BoardSession> {
    const board = await BoardStore.open(deps.boardPath);
    const session = new BoardSession(deps, board);
    await session.load();
    return session;
  }

  private constructor(
    private readonly deps: BoardSessionDeps,
    readonly board: BoardStore
  ) {
    this.agents = new AgentStore(deps.boardPath, this.board);
    this.comments = new CommentStore(deps.boardPath);

    this.runtime = new AgentRuntime({
      board: this.board,
      boardPath: deps.boardPath,
      endpoints: deps.endpoints,
      settings: deps.settings,
      listAgents: () => this.agents.list(),
      getAgent: (id) => this.agents.get(id),
      setAgentStatus: (id, status) => this.agents.setStatus(id, status),
      approvals: deps.approvals,
      extensions: deps.extensions,
      services: {
        ...deps.services,
        comments: {
          reply: async (_boardId: string, threadId: string, agentId: string, body: string) => {
            const agent = this.agents.get(agentId);
            this.comments.add(
              {
                nodeId: this.comments.list().find((t) => t.id === threadId)?.nodeId ?? '',
                threadId,
                body,
                author: { kind: 'agent', agentId, name: agent?.name ?? agentId }
              },
              (handle) => this.agents.byHandle(handle)?.id
            );
          },
          listForAgent: (_boardId: string, agentId: string) =>
            this.comments.pendingFor(agentId).map((thread) => ({
              threadId: thread.id,
              nodeId: thread.nodeId,
              comments: thread.comments.map((c) => ({
                author: c.author.kind === 'human' ? 'Пользователь' : c.author.name,
                body: c.body
              }))
            }))
        },
        delegate: {
          run: async ({ parent, brief, contextNodeIds }) => {
            const context = contextNodeIds
              .map((id) => this.board.getNode(id))
              .filter((n) => n !== undefined)
              .map((n) => (isArtifactNode(n) ? summarizeArtifact(n.artifact) : n.id))
              .join('\n');
            return this.runtime.runSubagent(parent, brief, context);
          }
        }
      }
    });

    this.wire();
  }

  get id(): string {
    return this.board.id;
  }

  get boardPath(): string {
    return this.deps.boardPath;
  }

  get name(): string {
    return this.board.toDoc().name || path.basename(this.deps.boardPath);
  }

  private async load(): Promise<void> {
    await this.agents.load();
    await this.comments.load();
  }

  /**
   * Pushes the current state as events. Called by the workspace once it has
   * subscribed, so the initial document is not emitted into a void.
   */
  emitInitialState(): void {
    this.onEvent.emit({
      type: 'board.loaded',
      boardId: this.board.id,
      doc: this.board.toDoc(),
      path: this.deps.boardPath
    });
    this.onEvent.emit({ type: 'agent.list', agents: this.agents.list() });
    this.onEvent.emit({ type: 'comment.threads', boardId: this.board.id, threads: this.comments.list() });
  }

  private wire(): void {
    this.board.onOps.on(({ ops, origin }) => {
      this.onEvent.emit({ type: 'board.ops', boardId: this.board.id, ops, origin });
    });

    // An edit made outside the app (git pull, editor) invalidates the whole
    // document, so the renderer is told to reload rather than patched.
    this.board.onExternalChange.on(() => {
      this.onEvent.emit({
        type: 'board.loaded',
        boardId: this.board.id,
        doc: this.board.toDoc(),
        path: this.deps.boardPath
      });
      this.comments.pruneOrphans(new Set(this.board.nodes.map((n) => n.id)));
    });

    this.agents.onChange.on((agents) => {
      this.onEvent.emit({ type: 'agent.list', agents });
    });
    this.agents.onStatus.on(({ agentId, status, headline }) => {
      this.onEvent.emit({ type: 'agent.status', agentId, status, headline });
    });

    this.comments.onChange.on((threads) => {
      this.onEvent.emit({ type: 'comment.threads', boardId: this.board.id, threads });
    });

    this.runtime.onEvent.on((event) => this.onEvent.emit(event));
    this.runtime.onActivity.on((entry) => this.onEvent.emit({ type: 'activity', entries: [entry] }));
  }

  async runTurn(agentId: string, input: TurnInput): Promise<TurnResult> {
    // Comment threads addressed to this agent are folded into the turn's input
    // and marked delivered, so they are seen exactly once.
    const pending = this.comments.pendingFor(agentId);
    let text = input.text;
    if (pending.length > 0) {
      const rendered = pending
        .map(
          (t) =>
            `- тред ${t.id} на узле ${t.nodeId}:\n${t.comments
              .map((c) => `    ${c.author.kind === 'human' ? 'Пользователь' : c.author.name}: ${c.body}`)
              .join('\n')}`
        )
        .join('\n');
      text = `${text}\n\n[Комментарии, адресованные тебе — ответь через board_comment_reply]\n${rendered}`;
      this.comments.markDelivered(agentId);
    }

    return this.runtime.runTurn(agentId, { ...input, text });
  }

  setAgentStatus(agentId: string, status: AgentStatus, headline?: string): void {
    this.agents.setStatus(agentId, status, headline);
  }

  agentList(): Agent[] {
    return this.agents.list();
  }

  async close(): Promise<void> {
    for (const agent of this.agents.list()) this.runtime.interrupt(agent.id);
    await this.agents.flush();
    await this.comments.flush();
    await this.board.close();
    this.onEvent.emit({ type: 'board.closed', boardId: this.board.id });
  }
}
