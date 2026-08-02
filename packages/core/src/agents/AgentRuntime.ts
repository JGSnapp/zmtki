import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { newId, type Agent } from '@zmtki/board-schema';
import type { ActivityEntry, EventMsg, TurnUsage } from '@zmtki/protocol';
import { formatArtifactEtiquette, type AppSettings } from '../app/settings.js';
import type { BoardStore } from '../board/BoardStore.js';
import type { EndpointRegistry } from '../llm/registry.js';
import { streamWithFallback } from '../llm/stream.js';
import type { ChatMessage, CompletionRequest, ResolvedEndpoint, ToolCall, Usage } from '../llm/types.js';
import { toolRegistry, type ToolContext, type ToolResult, type ToolServices } from '../tools/index.js';
import { Emitter } from '../util/emitter.js';
import { mapLimit } from '../util/async.js';
import type { ApprovalBroker } from './ApprovalBroker.js';
import { ContextAssembler } from './ContextAssembler.js';
import type { ExtensionHost } from '../extensions/McpHub.js';
import { buildPromptTiers, buildSubagentPrompt, tiersToMessages } from './prompts.js';
import { RolloutRecorder } from './RolloutRecorder.js';

const execAsync = promisify(exec);

/** Tools that need the strong model (search, shell, code, delegation). */
const STRONG_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'shell',
  'write_file',
  'apply_patch',
  'search_files',
  'read_file',
  'list_files',
  'show_file',
  'skill_read',
  'delegate_task',
  'task_assign',
  'portal_create',
  'memory_write'
]);

/** Tools whose results include images — escalate to the vision model. */
const VISION_TOOLS = new Set(['board_screenshot']);

type ModelTier = 'weak' | 'strong' | 'vision';

function needsStrongModel(name: string): boolean {
  if (STRONG_TOOLS.has(name) || VISION_TOOLS.has(name)) return true;
  // MCP / extension tools are treated as heavy.
  if (name.startsWith('mcp_') || name.includes('__')) return true;
  return false;
}

function needsVisionModel(name: string): boolean {
  return VISION_TOOLS.has(name);
}

export interface TurnInput {
  /** What kicked the turn off: a human message, a mention, or a comment. */
  source: 'user' | 'agent' | 'comment' | 'system';
  text: string;
  roomId?: string | null;
  /** Hop count from the originating human message, for loop protection. */
  hops?: number;
}

export interface TurnResult {
  turnId: string;
  finalText: string;
  usage: TurnUsage;
  rounds: number;
  stopReason: 'done' | 'maxRounds' | 'aborted' | 'error';
  error?: string;
  /** Rooms already messaged via room_send this turn — skip auto-post there. */
  postedRoomIds?: string[];
}

export interface AgentRuntimeDeps {
  board: BoardStore;
  boardPath: string;
  endpoints: EndpointRegistry;
  settings: () => AppSettings;
  services: ToolServices;
  listAgents: () => Agent[];
  getAgent: (agentId: string) => Agent | undefined;
  setAgentStatus: (agentId: string, status: Agent['status'], headline?: string) => void;
  approvals: ApprovalBroker;
  extensions?: ExtensionHost;
}

interface ActiveTurn {
  turnId: string;
  controller: AbortController;
  /** Human messages injected while the turn is already running. */
  steer: string[];
}

const PARALLEL_READONLY_LIMIT = 4;

/**
 * Runs one agent's turn: assemble context, call the model, execute the tools it
 * asks for, repeat until it stops calling tools.
 *
 * The loop is modelled on codex's `run_turn` — bounded rounds, tool results fed
 * back as messages, and abort handled at every await — but with the board as
 * the side-effect surface rather than a transcript.
 */
export class AgentRuntime {
  readonly onEvent = new Emitter<EventMsg>();
  readonly onActivity = new Emitter<ActivityEntry>();

  private readonly context: ContextAssembler;
  private readonly rollouts: RolloutRecorder;
  private active = new Map<string, ActiveTurn>();

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.context = new ContextAssembler(deps.board);
    this.rollouts = new RolloutRecorder(deps.boardPath);
  }

  isBusy(agentId: string): boolean {
    return this.active.has(agentId);
  }

  interrupt(agentId: string): void {
    const turn = this.active.get(agentId);
    if (!turn) return;
    turn.controller.abort();
    this.deps.approvals.denyAllFor();
  }

  /** Queues a human message into a turn that is already running. */
  steer(agentId: string, text: string): boolean {
    const turn = this.active.get(agentId);
    if (!turn) return false;
    turn.steer.push(text);
    return true;
  }

  async runTurn(agentId: string, input: TurnInput): Promise<TurnResult> {
    const agent = this.deps.getAgent(agentId);
    if (!agent) {
      return {
        turnId: '',
        finalText: '',
        usage: emptyUsage(),
        rounds: 0,
        stopReason: 'error',
        error: `агент не найден: ${agentId}`
      };
    }
    if (this.active.has(agentId)) {
      return {
        turnId: '',
        finalText: '',
        usage: emptyUsage(),
        rounds: 0,
        stopReason: 'error',
        error: 'агент уже выполняет ход'
      };
    }

    const turnId = newId('turn');
    const startedAt = Date.now();
    const controller = new AbortController();
    this.active.set(agentId, { turnId, controller, steer: [] });
    this.deps.setAgentStatus(agentId, 'thinking');
    this.emit({ type: 'turn.started', agentId, turnId, roomId: input.roomId ?? null });

    try {
      const result =
        agent.bridge?.kind && agent.bridge.kind !== 'builtin'
          ? await this.runBridgeTurn(agent, turnId, input, controller)
          : await this.loop(agent, turnId, input, controller);
      result.usage.rounds = result.rounds;
      result.usage.durationMs = Date.now() - startedAt;
      this.emit({
        type: 'turn.completed',
        agentId,
        turnId,
        usage: result.usage,
        stopReason: result.stopReason
      });
      return result;
    } catch (err) {
      const message = (err as Error).message;
      this.emit({ type: 'turn.failed', agentId, turnId, error: message });
      return {
        turnId,
        finalText: '',
        usage: emptyUsage(),
        rounds: 0,
        stopReason: 'error',
        error: message
      };
    } finally {
      this.active.delete(agentId);
      this.deps.setAgentStatus(agentId, 'idle');
    }
  }

  private async loop(
    agent: Agent,
    turnId: string,
    input: TurnInput,
    controller: AbortController
  ): Promise<TurnResult> {
    const settings = this.deps.settings();
    let tier = this.pickInitialTier(input, settings);
    let endpoints = this.resolveEndpoints(agent, settings, tier);
    if (endpoints.length === 0) {
      throw new Error('не настроен ни один LLM-эндпоинт — добавь его в настройках');
    }
    if (!endpoints.some((endpoint) => this.pickModel(agent, endpoint, settings, tier))) {
      throw new Error('не выбрана модель — откройте Настройки → Провайдеры и выберите модель');
    }

    await this.rollouts.load(agent.id);
    const turnMessages: ChatMessage[] = [{ role: 'user', content: input.text }];
    await this.rollouts.append(agent.id, turnId, turnMessages);

    const usage: TurnUsage = emptyUsage();
    const maxRounds = agent.maxRounds > 0 ? agent.maxRounds : settings.maxRoundsPerTurn;
    let finalText = '';
    let rounds = 0;
    const postedRoomIds = new Set<string>();

    for (rounds = 1; rounds <= maxRounds; rounds += 1) {
      if (controller.signal.aborted) {
        return { turnId, finalText, usage, rounds, stopReason: 'aborted', postedRoomIds: [...postedRoomIds] };
      }

      const messages = [...tiersToMessages(this.buildTiers(agent, input.text)), ...this.rollouts.compactIfNeeded(agent.id)];
      const toolsets = agent.toolsets.length > 0 ? agent.toolsets : ['core', 'board', 'files', 'shell', 'web', 'rooms', 'skills', 'mcp'];

      this.deps.setAgentStatus(agent.id, 'thinking');

      const { text, reasoning, calls, roundUsage } = await this.streamRound(
        agent,
        turnId,
        endpoints,
        messages,
        this.schemasFor(toolsets),
        controller.signal,
        tier,
        settings
      );

      accumulate(usage, roundUsage);
      if (text) finalText = text;

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: text,
        ...(reasoning ? { reasoning } : {}),
        ...(calls.length > 0 ? { toolCalls: calls } : {})
      };
      await this.rollouts.append(agent.id, turnId, [assistantMessage]);

      if (calls.length === 0) {
        await this.drainSteer(agent.id, turnId);
        return { turnId, finalText, usage, rounds, stopReason: 'done', postedRoomIds: [...postedRoomIds] };
      }

      if (tier === 'weak' && calls.some((c) => needsStrongModel(c.name))) {
        const next: ModelTier = calls.some((c) => needsVisionModel(c.name)) ? 'vision' : 'strong';
        tier = next;
        endpoints = this.resolveEndpoints(agent, settings, next);
        if (endpoints.length === 0) {
          return {
            turnId,
            finalText,
            usage,
            rounds,
            stopReason: 'error',
            error: 'нет сильной модели для эскалации',
            postedRoomIds: [...postedRoomIds]
          };
        }
      }

      this.deps.setAgentStatus(agent.id, 'running');
      const results = await this.executeCalls(agent, turnId, calls, controller);
      for (const { call, result } of results) {
        if (call.name !== 'room_send' || result.isError) continue;
        try {
          const args = JSON.parse(call.arguments || '{}') as { roomId?: unknown };
          if (args.roomId) postedRoomIds.add(String(args.roomId));
        } catch {
          /* ignore */
        }
      }

      if (results.some((r) => (r.result.images?.length ?? 0) > 0) && tier !== 'vision') {
        tier = 'vision';
        endpoints = this.resolveEndpoints(agent, settings, 'vision');
      }

      const followUp: ChatMessage[] = [];
      for (const r of results) {
        followUp.push({
          role: 'tool',
          content: r.result.content,
          toolCallId: r.call.id,
          name: r.call.name
        });
        if (r.result.images && r.result.images.length > 0) {
          followUp.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `[скриншот от ${r.call.name}] Ниже изображение доски. Оцени раскладку, зазоры и стрелки; при необходимости поправь.`
              },
              ...r.result.images.map((img) => ({
                type: 'image' as const,
                mime: img.mime,
                base64: img.base64
              }))
            ]
          });
        }
      }
      await this.rollouts.append(agent.id, turnId, followUp);

      const steered = await this.drainSteer(agent.id, turnId);
      if (steered) continue;
    }

    this.emit({
      type: 'agent.status',
      agentId: agent.id,
      status: 'paused',
      headline: `Достигнут лимит в ${maxRounds} раундов за ход`
    });
    return {
      turnId,
      finalText,
      usage,
      rounds: rounds - 1,
      stopReason: 'maxRounds',
      postedRoomIds: [...postedRoomIds]
    };
  }

  /**
   * External agent bridge: forward the human message to an MCP chat tool or a
   * shell command (Claude Code / Cursor / custom CLI), then post the reply.
   */
  private async runBridgeTurn(
    agent: Agent,
    turnId: string,
    input: TurnInput,
    controller: AbortController
  ): Promise<TurnResult> {
    this.deps.setAgentStatus(agent.id, 'running');
    this.onActivity.emit({
      agentId: agent.id,
      boardId: this.deps.board.id,
      status: 'running',
      headline: `Внешний агент (${agent.bridge.kind})…`,
      nodeId: null,
      updatedAt: Date.now()
    });

    let finalText = '';
    let error: string | undefined;

    try {
      if (agent.bridge.kind === 'mcp') {
        finalText = await this.runMcpBridge(agent, input.text, controller.signal);
      } else if (agent.bridge.kind === 'command') {
        finalText = await this.runCommandBridge(agent, input.text, controller.signal);
      } else {
        error = 'неизвестный тип bridge';
      }
    } catch (err) {
      error = (err as Error).message;
    }

    if (controller.signal.aborted) {
      return { turnId, finalText, usage: emptyUsage(), rounds: 1, stopReason: 'aborted' };
    }

    if (error) {
      finalText = finalText || `Ошибка внешнего агента: ${error}`;
    }

    if (input.roomId && finalText) {
      await this.deps.services.rooms.send({
        roomId: input.roomId,
        agentId: agent.id,
        body: finalText
      });
    }

    return {
      turnId,
      finalText,
      usage: emptyUsage(),
      rounds: 1,
      stopReason: error ? 'error' : 'done',
      ...(error ? { error } : {}),
      ...(input.roomId ? { postedRoomIds: [input.roomId] } : {})
    };
  }

  private async runMcpBridge(agent: Agent, message: string, signal: AbortSignal): Promise<string> {
    const host = this.deps.extensions;
    if (!host) throw new Error('MCP недоступен');
    const server = agent.bridge.mcpServer.trim();
    if (!server) throw new Error('укажи MCP-сервер у агента (bridge.mcpServer)');
    const tool = host.resolveChatTool(server, agent.bridge.mcpTool.trim());
    if (!tool) throw new Error(`у MCP-сервера «${server}» нет инструментов (или он не запущен)`);
    if (signal.aborted) throw new Error('отменено');
    const full = `mcp__${server}__${tool}`;
    const result = await host.callMcpTool(full, {
      message,
      prompt: message,
      text: message,
      query: message,
      agentId: agent.id,
      boardPath: this.deps.boardPath
    });
    if (result.isError) throw new Error(result.content);
    return result.content || '(пустой ответ MCP)';
  }

  private async runCommandBridge(agent: Agent, message: string, signal: AbortSignal): Promise<string> {
    const template = agent.bridge.command.trim();
    if (!template) {
      throw new Error('укажи команду у агента (bridge.command), например: claude -p "{message}"');
    }
    const escaped = message.replace(/"/g, '\\"');
    const cmd = template.includes('{message}')
      ? template.split('{message}').join(escaped)
      : `${template} ${JSON.stringify(message)}`;
    if (signal.aborted) throw new Error('отменено');
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: this.deps.boardPath,
      timeout: 10 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    });
    const out = [stdout, stderr].map((s) => s?.trim()).filter(Boolean).join('\n\n');
    return out || '(команда завершилась без вывода)';
  }

  private buildTiers(agent: Agent, turnText = '') {
    const assembled = this.context.assemble(agent, this.deps.listAgents());
    const doc = this.deps.board.toDoc();
    const rooms = this.deps.services.rooms.listForAgent(agent.id);

    const roomsContext = rooms
      .map((r) => {
        const recent = this.deps.services.rooms.history(r.id, 8);
        const tail = recent.map((m) => `    ${m.author}: ${m.body.slice(0, 200)}`).join('\n');
        return `- ${r.id} [${r.kind}] ${r.title}\n${tail || '    (пусто)'}`;
      })
      .join('\n');

    const threads = this.deps.services.comments.listForAgent(this.deps.board.id, agent.id);
    const inboxDigest = threads
      .map(
        (t) =>
          `- тред ${t.threadId} на ${t.nodeId}: ${t.comments.map((c) => `${c.author}: ${c.body}`).join(' | ')}`
      )
      .join('\n');

    const settings = this.deps.settings();
    return buildPromptTiers({
      agent,
      boardName: doc.name,
      boardPath: this.deps.boardPath,
      boardDescription: doc.description,
      frameContext: assembled.frameContext,
      peripheralContext: assembled.peripheralContext,
      roomsContext,
      inboxDigest,
      agentRoster: assembled.agentRoster,
      skillsContext: this.deps.extensions?.skills.promptBlock(turnText) ?? '',
      artifactEtiquette: formatArtifactEtiquette(settings.artifactEtiquette ?? [])
    });
  }

  private schemasFor(toolsets: readonly string[]) {
    const base = toolRegistry.schemasFor(toolsets);
    if (!toolsets.includes('mcp') || !this.deps.extensions) return base;
    return [...base, ...this.deps.extensions.mcpSchemas()];
  }

  private pickInitialTier(input: TurnInput, settings: AppSettings): ModelTier {
    if (!settings.modelRouting) return 'strong';
    if (!settings.weakEndpointId && !settings.weakModel) return 'strong';
    if (input.source === 'system' && input.text.includes('[board.event:')) return 'weak';
    if (input.source === 'system' && input.text.length < 280) return 'weak';
    return 'strong';
  }

  private resolveEndpoints(agent: Agent, settings: AppSettings, tier: ModelTier): ResolvedEndpoint[] {
    if (tier === 'weak') {
      const weakId = settings.weakEndpointId || settings.defaultEndpointId;
      if (!weakId) return this.resolveEndpoints(agent, settings, 'strong');
      const resolved = this.deps.endpoints.resolve(weakId);
      return resolved ? [resolved] : this.resolveEndpoints(agent, settings, 'strong');
    }

    if (tier === 'vision') {
      const visionId = settings.visionEndpointId || settings.defaultEndpointId;
      if (settings.visionEndpointId) {
        const resolved = this.deps.endpoints.resolve(settings.visionEndpointId);
        if (resolved) return [resolved];
      }
      if (visionId) {
        const resolved = this.deps.endpoints.resolve(visionId);
        if (resolved) return [resolved];
      }
      return this.resolveEndpoints(agent, settings, 'strong');
    }

    const ids = [
      agent.model.endpointId || settings.defaultEndpointId,
      ...agent.model.fallbacks.map((f) => f.endpointId)
    ].filter((id): id is string => typeof id === 'string' && id.length > 0);

    const seen = new Set<string>();
    const out: ResolvedEndpoint[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const resolved = this.deps.endpoints.resolve(id);
      if (resolved) out.push(resolved);
    }
    // Stale defaultEndpointId / agent.model.endpointId used to yield an empty
    // list even when ChatGPT (or another provider) was clearly connected.
    if (out.length === 0) {
      for (const endpoint of this.deps.endpoints.list()) {
        if (seen.has(endpoint.id)) continue;
        const resolved = this.deps.endpoints.resolve(endpoint.id);
        if (resolved) out.push(resolved);
      }
    }
    return out;
  }

  private pickModel(
    agent: Agent,
    endpoint: ResolvedEndpoint,
    settings: AppSettings,
    tier: ModelTier
  ): string {
    if (tier === 'weak') {
      if (settings.weakModel) return settings.weakModel;
      if (settings.defaultModel) return settings.defaultModel;
      return this.deps.endpoints.find(endpoint.id)?.models[0] ?? '';
    }
    if (tier === 'vision') {
      if (settings.visionModel) return settings.visionModel;
      if (settings.defaultModel) return settings.defaultModel;
      if (agent.model.model) return agent.model.model;
      return this.deps.endpoints.find(endpoint.id)?.models[0] ?? '';
    }
    if (agent.model.endpointId === endpoint.id && agent.model.model) return agent.model.model;
    const fallback = agent.model.fallbacks.find((f) => f.endpointId === endpoint.id);
    if (fallback?.model) return fallback.model;
    if (agent.model.model) return agent.model.model;
    if (settings.defaultModel) return settings.defaultModel;
    return this.deps.endpoints.find(endpoint.id)?.models[0] ?? '';
  }

  private async streamRound(
    agent: Agent,
    turnId: string,
    endpoints: readonly ResolvedEndpoint[],
    messages: ChatMessage[],
    tools: CompletionRequest['tools'],
    signal: AbortSignal,
    tier: ModelTier,
    settings: AppSettings
  ): Promise<{ text: string; reasoning: string; calls: ToolCall[]; roundUsage: Usage }> {
    let text = '';
    let reasoning = '';
    let calls: ToolCall[] = [];
    let roundUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };

    const requestFor = (endpoint: ResolvedEndpoint): CompletionRequest => ({
      model: this.pickModel(agent, endpoint, settings, tier),
      messages,
      tools,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      signal
    });

    for await (const event of streamWithFallback(endpoints, requestFor)) {
      switch (event.type) {
        case 'text':
          text += event.text;
          this.emit({ type: 'turn.messageDelta', agentId: agent.id, turnId, text: event.text });
          break;
        case 'reasoning':
          reasoning += event.text;
          this.emit({ type: 'turn.reasoningDelta', agentId: agent.id, turnId, text: event.text });
          break;
        case 'toolCalls':
          calls = event.calls;
          break;
        case 'usage':
          roundUsage = event.usage;
          break;
        default:
          break;
      }
    }

    return { text, reasoning, calls, roundUsage };
  }

  private async executeCalls(
    agent: Agent,
    turnId: string,
    calls: readonly ToolCall[],
    controller: AbortController
  ): Promise<Array<{ call: ToolCall; result: ToolResult }>> {
    // Read-only calls cannot conflict, so they go out together. Mutating calls
    // run in order, because two tools writing the same file or laying out the
    // same frame concurrently would produce nonsense.
    const readOnly: ToolCall[] = [];
    const mutating: ToolCall[] = [];
    for (const call of calls) {
      (toolRegistry.get(call.name)?.readOnly ? readOnly : mutating).push(call);
    }

    const results: Array<{ call: ToolCall; result: ToolResult }> = [];

    const parallel = await mapLimit(readOnly, PARALLEL_READONLY_LIMIT, async (call) => ({
      call,
      result: await this.invoke(agent, turnId, call, controller)
    }));
    results.push(...parallel);

    for (const call of mutating) {
      if (controller.signal.aborted) {
        results.push({ call, result: { content: 'ход прерван пользователем', isError: true } });
        continue;
      }
      results.push({ call, result: await this.invoke(agent, turnId, call, controller) });
    }

    // Restore the model's original order so tool results line up with calls.
    const byId = new Map(results.map((r) => [r.call.id, r]));
    return calls.map((call) => byId.get(call.id) ?? { call, result: { content: 'нет результата', isError: true } });
  }

  private async invoke(
    agent: Agent,
    turnId: string,
    call: ToolCall,
    controller: AbortController
  ): Promise<ToolResult> {
    const tool = toolRegistry.get(call.name);
    const startedAt = Date.now();
    this.emit({
      type: 'turn.toolCall',
      agentId: agent.id,
      turnId,
      call: { id: call.id, name: call.name, args: call.arguments, status: 'running' }
    });

    if (!tool) {
      if (this.deps.extensions?.isMcpTool(call.name)) {
        if (agent.approvalPolicy !== 'never') {
          this.deps.setAgentStatus(agent.id, 'waitingApproval', `MCP: ${call.name}`);
          let approved = false;
          try {
            approved = await this.deps.approvals.ask(
              {
                agentId: agent.id,
                boardId: this.deps.board.id,
                kind: 'exec',
                title: `MCP: ${call.name}`,
                detail: call.arguments.slice(0, 500),
                subject: call.name
              },
              { signal: controller.signal, timeoutMs: 120_000 }
            );
          } finally {
            if (!controller.signal.aborted) {
              this.deps.setAgentStatus(agent.id, 'running');
            }
          }
          if (!approved) {
            const result = { content: 'отклонено пользователем', isError: true };
            this.emitToolEnd(agent.id, turnId, call, result, startedAt);
            return result;
          }
        }
        let args: Record<string, unknown> = {};
        try {
          args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
        } catch {
          const result = { content: `аргументы ${call.name} не разобрались как JSON`, isError: true };
          this.emitToolEnd(agent.id, turnId, call, result, startedAt);
          return result;
        }
        const result = await this.deps.extensions.callMcpTool(call.name, args);
        this.emitToolEnd(agent.id, turnId, call, result, startedAt);
        return result;
      }
      const result = { content: `неизвестный инструмент: ${call.name}`, isError: true };
      this.emitToolEnd(agent.id, turnId, call, result, startedAt);
      return result;
    }

    let args: Record<string, unknown>;
    try {
      args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
    } catch {
      const result = { content: `аргументы ${call.name} не разобрались как JSON`, isError: true };
      this.emitToolEnd(agent.id, turnId, call, result, startedAt);
      return result;
    }

    const ctx: ToolContext = {
      agent,
      board: this.deps.board,
      boardPath: this.deps.boardPath,
      turnId,
      signal: controller.signal,
      services: this.deps.services,
      progress: (text) =>
        this.emit({
          type: 'turn.toolCall',
          agentId: agent.id,
          turnId,
          call: {
            id: call.id,
            name: call.name,
            args: call.arguments,
            status: 'running',
            resultPreview: text.slice(0, 400)
          }
        }),
      requestApproval: async (ask) => {
        this.deps.setAgentStatus(agent.id, 'waitingApproval', ask.title);
        try {
          return await this.deps.approvals.ask(
            {
              agentId: agent.id,
              boardId: this.deps.board.id,
              kind: ask.kind,
              title: ask.title,
              detail: ask.detail,
              subject: ask.subject
            },
            {
              signal: controller.signal,
              // Invisible / missed approval cards must not freeze the turn.
              timeoutMs: 120_000
            }
          );
        } finally {
          if (!controller.signal.aborted) {
            this.deps.setAgentStatus(agent.id, 'running');
          }
        }
      }
    };

    try {
      const result = await raceTool(tool.handler(args, ctx), controller.signal, call.name, toolTimeoutMs(call.name));
      this.emitToolEnd(agent.id, turnId, call, result, startedAt);
      this.onActivity.emit({
        agentId: agent.id,
        boardId: this.deps.board.id,
        status: 'running',
        headline: `${call.name}: ${result.content.slice(0, 140)}`,
        nodeId: result.nodeId ?? null,
        updatedAt: Date.now()
      });
      return result;
    } catch (err) {
      const result = { content: `${call.name} упал: ${(err as Error).message}`, isError: true };
      this.emitToolEnd(agent.id, turnId, call, result, startedAt);
      return result;
    }
  }

  private emitToolEnd(
    agentId: string,
    turnId: string,
    call: ToolCall,
    result: ToolResult,
    startedAt: number
  ): void {
    this.emit({
      type: 'turn.toolCall',
      agentId,
      turnId,
      call: {
        id: call.id,
        name: call.name,
        args: call.arguments,
        status: result.isError ? 'error' : 'ok',
        resultPreview: result.content.slice(0, 400),
        durationMs: Date.now() - startedAt,
        nodeId: result.nodeId ?? null
      }
    });
  }

  /** Folds any messages the human typed mid-turn into the conversation. */
  private async drainSteer(agentId: string, turnId: string): Promise<boolean> {
    const turn = this.active.get(agentId);
    if (!turn || turn.steer.length === 0) return false;
    const queued = turn.steer.splice(0, turn.steer.length);
    await this.rollouts.append(
      agentId,
      turnId,
      queued.map((text) => ({ role: 'user' as const, content: `[сообщение по ходу] ${text}` }))
    );
    return true;
  }

  /**
   * Runs a throwaway subagent. Its rounds never touch the parent's history,
   * which is the point: the parent pays for the summary, not the transcript.
   */
  async runSubagent(parent: Agent, brief: string, contextText: string): Promise<{ summary: string; error?: string }> {
    const settings = this.deps.settings();
    const endpoints = this.resolveEndpoints(parent, settings, 'strong');
    if (endpoints.length === 0) return { summary: '', error: 'нет LLM-эндпоинта' };

    const controller = new AbortController();
    const messages = buildSubagentPrompt(brief, contextText);
    const child: Agent = { ...parent, id: `${parent.id}_sub`, name: `${parent.name} (подагент)` };

    let summary = '';
    for (let round = 0; round < Math.min(8, settings.maxRoundsPerTurn); round += 1) {
      const { text, calls } = await this.streamRound(
        child,
        `${parent.id}_sub`,
        endpoints,
        messages,
        toolRegistry.schemasFor(['files', 'web']),
        controller.signal,
        'strong',
        settings
      );
      if (text) summary = text;
      if (calls.length === 0) break;

      messages.push({ role: 'assistant', content: text, toolCalls: calls });
      for (const call of calls) {
        const result = await this.invoke(child, `${parent.id}_sub`, call, controller);
        messages.push({
          role: 'tool',
          content: result.content,
          toolCallId: call.id,
          name: call.name
        });
      }
    }

    return summary ? { summary } : { summary: '', error: 'подагент не вернул итог' };
  }

  private emit(event: EventMsg): void {
    this.onEvent.emit(event);
  }
}

function emptyUsage(): TurnUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    rounds: 0,
    durationMs: 0
  };
}

function accumulate(target: TurnUsage, delta: Usage): void {
  target.promptTokens += delta.promptTokens;
  target.completionTokens += delta.completionTokens;
  target.totalTokens += delta.totalTokens;
  target.cachedTokens += delta.cachedTokens;
}

/** Board geometry tools should finish instantly; long hangs mean a stuck await. */
function toolTimeoutMs(name: string): number {
  if (name === 'shell' || name === 'web_fetch' || name.startsWith('mcp_')) return 10 * 60_000;
  if (name.startsWith('board_') || name.startsWith('sticker')) return 20_000;
  return 3 * 60_000;
}

function raceTool<T>(
  work: Promise<T>,
  signal: AbortSignal,
  name: string,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('ход прерван пользователем'));
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`${name}: таймаут ${Math.round(timeoutMs / 1000)}с — вызов прерван`));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('ход прерван пользователем'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}
