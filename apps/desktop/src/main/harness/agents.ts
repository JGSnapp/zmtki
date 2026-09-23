import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDefinition, findFreeSpot, rectsIntersect } from '@zmtki/shared';
import type { AgentEvent, AgentInfo, SpawnRequest, StartTerminalInput, TerminalSnapshot } from '../../shared/ipc.js';
import type { BoardsService } from '../boards/boards.service.js';
import { createArtifact } from '../boards/operations.js';
import type { BoardMcpServer, ToolCallReport } from '../mcp/server.js';
import type { TerminalManager } from '../terminal/manager.js';
import type { McpServerLaunch } from '../mcp/servers.js';
import { HarnessRegistry } from './registry.js';

type Emit = (event: AgentEvent) => void;

interface Running extends AgentInfo {
  sessionId: string;
  configPath: string;
}

/**
 * Marker colours handed out in order. Distinct enough to tell four agents
 * apart at a glance on a dark board, which is about as many as fit on screen.
 */
const AGENT_COLORS = ['#7aa2ff', '#ff9e64', '#9ece6a', '#f7768e', '#bb9af7', '#2ac3de', '#e0af68'];

/**
 * What an agent may do about subagents unless the user says otherwise: ask
 * first, and no more than two at a time. A subagent starts with none of its
 * own — a chain of agents spawning agents is something the user opts into
 * deliberately, one level at a time.
 */
const DEFAULT_SUBAGENT_LIMIT = 2;
const SUBAGENT_DEFAULT_LIMIT = 0;

/** How long `agent_spawn` waits for the user before telling the agent to check back. */
const APPROVAL_WAIT_MS = 90_000;

export interface SpawnInput {
  purpose: string;
  harnessId?: string;
  cwd?: string;
}

export type SpawnOutcome =
  | { status: 'started'; agentId: string; artifactId: string }
  | { status: 'refused'; reason: string }
  | { status: 'pending'; requestId: string };

interface PendingRequest {
  request: SpawnRequest;
  resolve: (outcome: SpawnOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/**
 * Tracks the harnesses living on boards.
 *
 * An agent is three things bound together: a terminal artifact, a PTY running
 * its CLI, and an MCP token that lets that CLI edit the board it was placed on.
 * They are created together and torn down together, so the side panel can
 * never list an agent whose terminal is gone.
 *
 * Agents can ask for helpers. Every such request is the user's to answer: an
 * agent never puts another agent on the board by itself, and the number it may
 * have at once is a setting the user controls per agent.
 */
export class AgentService {
  private readonly agents = new Map<string, Running>();
  private readonly registry = new HarnessRegistry();
  private readonly requests = new Map<string, PendingRequest>();
  /** Terminals created for an approved request, waiting for the renderer to start them. */
  private readonly expected = new Map<string, { parentId: string; purpose: string; zoneId?: string }>();
  private colorCursor = 0;

  constructor(
    private readonly boards: BoardsService,
    private readonly terminals: TerminalManager,
    private readonly mcp: BoardMcpServer,
    private readonly emit: Emit,
    /**
     * Extra MCP servers, read at launch rather than held: switching one on is
     * meant to reach the next agent, and an agent already running keeps what it
     * was started with — a harness reads its configuration once.
     */
    private readonly extraServers: () => McpServerLaunch[] = () => [],
  ) {}

  harnesses() {
    return this.registry.list();
  }

  list(): AgentInfo[] {
    return [...this.agents.values()].map((agent) => this.publicInfo(agent));
  }

  get(agentId: string): AgentInfo | null {
    const agent = this.agents.get(agentId);
    return agent ? this.publicInfo(agent) : null;
  }

  pendingRequests(): SpawnRequest[] {
    return [...this.requests.values()].map((entry) => entry.request);
  }

  private publicInfo(agent: Running): AgentInfo {
    const { sessionId: _sessionId, configPath: _configPath, ...info } = agent;
    return { ...info, subagentIds: [...info.subagentIds] };
  }

  private announce(agent: Running): void {
    this.emit({ type: 'agent_updated', agent: this.publicInfo(agent) });
  }

  private cwdFor(input: StartTerminalInput): string | undefined {
    if (input.cwd) return input.cwd;
    try {
      return this.boards.get(input.boardId).rootDir || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Starts the terminal behind an artifact — as a harness when one is asked
   * for and installed, as a plain shell otherwise. A missing CLI still gives
   * the user a working terminal with a note, not an error card.
   */
  async start(input: StartTerminalInput): Promise<TerminalSnapshot> {
    const existing = this.terminals.attachByArtifact(input.artifactId);
    if (existing) return existing;

    const cwd = this.cwdFor(input);
    const harnessId = input.harnessId;
    if (!harnessId || harnessId === 'shell') {
      return this.terminals.start({ ...input, cwd });
    }

    const agentId = randomUUID();
    const endpoint = this.mcp.bind(agentId, input.boardId);
    const configPath = join(tmpdir(), 'zmtki-mcp-' + agentId + '.json');
    const launch = this.registry.launch(harnessId, endpoint, configPath, this.extraServers());
    const label = this.registry.find(harnessId)?.label ?? harnessId;

    if (!launch) {
      this.mcp.unbind(agentId);
      const snapshot = await this.terminals.start({ ...input, cwd, harnessId: undefined });
      this.terminals.write(
        snapshot.sessionId,
        'echo "' + label + ' не найден в PATH — открыт обычный терминал. MCP доски: ' + endpoint + '"\r',
      );
      return snapshot;
    }

    const snapshot = await this.terminals.start({ ...input, cwd, harnessId }, launch, agentId);
    // A terminal the user approved for a subagent carries its parent with it.
    const link = this.expected.get(input.artifactId);
    this.expected.delete(input.artifactId);
    const parent = link ? this.agents.get(link.parentId) : undefined;

    const agent: Running = {
      id: agentId,
      boardId: input.boardId,
      artifactId: input.artifactId,
      sessionId: snapshot.sessionId,
      configPath,
      harnessId,
      label: link ? label + ' · ' + link.purpose.slice(0, 24) : label,
      color: AGENT_COLORS[this.colorCursor++ % AGENT_COLORS.length],
      cwd: cwd ?? '',
      running: snapshot.running,
      startedAt: Date.now(),
      toolCalls: 0,
      parentId: link?.parentId,
      purpose: link?.purpose,
      zoneId: link?.zoneId,
      subagentIds: [],
      subagentLimit: link ? SUBAGENT_DEFAULT_LIMIT : DEFAULT_SUBAGENT_LIMIT,
      requireApproval: true,
    };
    this.agents.set(agentId, agent);
    if (parent) {
      parent.subagentIds.push(agentId);
      this.announce(parent);
    }
    this.emit({ type: 'agent_added', agent: this.publicInfo(agent) });
    return { ...snapshot, agentId };
  }

  // --- Subagents --------------------------------------------------------------

  /** Number of this agent's subagents that are still running. */
  private liveSubagents(agent: Running): string[] {
    return agent.subagentIds.filter((id) => this.agents.has(id));
  }

  /**
   * An agent asks for a helper. Refused outright when its limit is used up;
   * otherwise it waits on the user's answer for a while and is told to check
   * back if nobody is at the keyboard.
   */
  requestSubagent(parentId: string, input: SpawnInput): Promise<SpawnOutcome> {
    const parent = this.agents.get(parentId);
    if (!parent) return Promise.resolve({ status: 'refused', reason: 'Агент не найден' });
    const live = this.liveSubagents(parent);
    parent.subagentIds = live;
    if (parent.subagentLimit <= 0) {
      return Promise.resolve({
        status: 'refused',
        reason: 'Субагенты запрещены для этого агента. Пользователь может разрешить их в панели «Агенты».',
      });
    }
    if (live.length >= parent.subagentLimit) {
      return Promise.resolve({
        status: 'refused',
        reason:
          'Лимит субагентов исчерпан: ' + live.length + ' из ' + parent.subagentLimit + '. Останови ненужного (agent_stop) или попроси пользователя поднять лимит.',
      });
    }

    const harnessId = input.harnessId && this.registry.find(input.harnessId) ? input.harnessId : parent.harnessId;
    const request: SpawnRequest = {
      id: randomUUID(),
      parentId,
      parentLabel: parent.label,
      boardId: parent.boardId,
      harnessId,
      purpose: input.purpose,
      cwd: input.cwd || parent.cwd,
      createdAt: Date.now(),
    };

    if (!parent.requireApproval) {
      const started = this.spawn(request);
      return Promise.resolve(started);
    }

    return new Promise<SpawnOutcome>((resolve) => {
      const entry: PendingRequest = {
        request,
        resolve,
        settled: false,
        timer: setTimeout(() => {
          if (entry.settled) return;
          entry.settled = true;
          // The request stays on screen; the agent is told to get on with
          // something else and look again later.
          resolve({ status: 'pending', requestId: request.id });
        }, APPROVAL_WAIT_MS),
      };
      this.requests.set(request.id, entry);
      this.emit({ type: 'spawn_requested', request });
    });
  }

  /** Puts the subagent's terminal on the board next to its parent and lets it start. */
  private spawn(request: SpawnRequest): SpawnOutcome {
    const parent = this.agents.get(request.parentId);
    if (!parent) return { status: 'refused', reason: 'Родительский агент уже остановлен' };
    const definition = artifactDefinition('terminal');
    let artifactId = '';
    try {
      this.boards.mutate(request.boardId, (state) => {
        const anchor = state.artifacts.find((a) => a.id === parent.artifactId);
        const wanted = {
          x: (anchor?.x ?? 0) + (anchor?.width ?? 0) + 80,
          y: anchor?.y ?? 0,
          width: definition.width,
          height: definition.height,
        };
        const spot = findFreeSpot(wanted, (area) => state.artifacts.filter((a) => rectsIntersect(a, area)), { gap: 40 });
        const artifact = createArtifact(state, {
          type: 'terminal',
          x: spot.x,
          y: spot.y,
          props: {
            harnessId: request.harnessId,
            title: request.purpose.slice(0, 40),
            cwd: request.cwd,
            purpose: request.purpose,
            parentAgentId: request.parentId,
          },
        });
        artifactId = artifact.id;
      }, 'host');
    } catch (error) {
      return { status: 'refused', reason: error instanceof Error ? error.message : String(error) };
    }
    this.expected.set(artifactId, { parentId: request.parentId, purpose: request.purpose, zoneId: parent.zoneId });
    // The agent id only exists once the renderer starts the terminal; the
    // parent learns it from agent_list when the helper is up.
    return { status: 'started', agentId: '', artifactId };
  }

  approve(requestId: string): SpawnOutcome {
    const entry = this.requests.get(requestId);
    if (!entry) return { status: 'refused', reason: 'Запрос не найден' };
    this.requests.delete(requestId);
    clearTimeout(entry.timer);
    const outcome = this.spawn(entry.request);
    if (!entry.settled) {
      entry.settled = true;
      entry.resolve(outcome);
    }
    this.emit({ type: 'spawn_resolved', requestId, approved: outcome.status === 'started' });
    return outcome;
  }

  decline(requestId: string, reason?: string): void {
    const entry = this.requests.get(requestId);
    if (!entry) return;
    this.requests.delete(requestId);
    clearTimeout(entry.timer);
    if (!entry.settled) {
      entry.settled = true;
      entry.resolve({ status: 'refused', reason: reason?.trim() || 'Пользователь отклонил запрос на субагента' });
    }
    this.emit({ type: 'spawn_resolved', requestId, approved: false });
  }

  /** Where a request stands, for an agent that was told to check back. */
  requestStatus(requestId: string): 'pending' | 'gone' {
    return this.requests.has(requestId) ? 'pending' : 'gone';
  }

  setPolicy(agentId: string, policy: { subagentLimit?: number; requireApproval?: boolean }): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (policy.subagentLimit !== undefined) agent.subagentLimit = Math.max(0, Math.min(8, Math.round(policy.subagentLimit)));
    if (policy.requireApproval !== undefined) agent.requireApproval = policy.requireApproval;
    this.announce(agent);
  }

  assignZone(agentId: string, zoneId: string | null): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.zoneId = zoneId ?? undefined;
    this.announce(agent);
  }

  /** Types into a subagent's terminal — how a parent gives its helper work. */
  sendTo(parentId: string, agentId: string, text: string): { ok: boolean; reason?: string } {
    const parent = this.agents.get(parentId);
    const target = this.agents.get(agentId);
    if (!target) return { ok: false, reason: 'Агент не найден' };
    if (!parent || !parent.subagentIds.includes(agentId)) return { ok: false, reason: 'Это не твой субагент' };
    if (!target.running) return { ok: false, reason: 'Субагент уже не работает' };
    this.terminals.write(target.sessionId, text.endsWith('\r') ? text : text + '\r');
    return { ok: true };
  }

  // --- Lifecycle ---------------------------------------------------------------

  /** Called by the MCP server after every tool call an agent makes. */
  noteToolCall(report: ToolCallReport): void {
    const agent = this.agents.get(report.agentId);
    if (!agent) return;
    agent.toolCalls += 1;
    agent.lastTool = report.tool;
    agent.lastToolAt = Date.now();
    agent.lastError = report.ok ? undefined : report.error;
    if (report.target) agent.lastTarget = report.target;
    this.announce(agent);
  }

  /** Called when a PTY exits, so the panel stops showing the agent as live. */
  markExited(sessionId: string): void {
    for (const agent of this.agents.values()) {
      if (agent.sessionId !== sessionId) continue;
      agent.running = false;
      this.announce(agent);
    }
  }

  /** Stops an agent and revokes its board access. Its subagents keep running. */
  release(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this.terminals.stop(agent.sessionId);
    this.mcp.unbind(agentId);
    rmSync(agent.configPath, { force: true });
    this.agents.delete(agentId);
    for (const other of this.agents.values()) {
      if (!other.subagentIds.includes(agentId)) continue;
      other.subagentIds = other.subagentIds.filter((id) => id !== agentId);
      this.announce(other);
    }
    for (const [id, entry] of this.requests) {
      if (entry.request.parentId === agentId) this.decline(id, 'Родительский агент остановлен');
    }
    this.emit({ type: 'agent_removed', agentId });
  }

  /** A terminal artifact is the agent's body: deleting it ends the agent. */
  releaseByArtifact(artifactId: string): void {
    for (const agent of [...this.agents.values()]) {
      if (agent.artifactId === artifactId) this.release(agent.id);
    }
    this.expected.delete(artifactId);
    const plain = this.terminals.attachByArtifact(artifactId);
    if (plain) this.terminals.stop(plain.sessionId);
  }

  releaseAll(): void {
    for (const id of [...this.requests.keys()]) this.decline(id, 'Приложение закрывается');
    for (const id of [...this.agents.keys()]) this.release(id);
  }
}
