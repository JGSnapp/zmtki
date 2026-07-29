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
  setAgentStatus: (agentId: string, status: Agent['status']) => void;
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
      const result = await this.loop(agent, turnId, input, controller);
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
    const endpoints = this.resolveEndpoints(agent, settings);
    if (endpoints.length === 0) {
      throw new Error('не настроен ни один LLM-эндпоинт — добавь его в настройках');
    }
    if (!endpoints.some((endpoint) => this.pickModel(agent, endpoint, settings))) {
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
        controller.signal
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
      await this.rollouts.append(
        agent.id,
        turnId,
        results.map((r) => ({
          role: 'tool' as const,
          content: r.result.content,
          toolCallId: r.call.id,
          name: r.call.name
        }))
      );

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

  private resolveEndpoints(agent: Agent, settings: AppSettings): ResolvedEndpoint[] {
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
    return out;
  }

  private pickModel(agent: Agent, endpoint: ResolvedEndpoint, settings: AppSettings): string {
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
    signal: AbortSignal
  ): Promise<{ text: string; reasoning: string; calls: ToolCall[]; roundUsage: Usage }> {
    const settings = this.deps.settings();
    let text = '';
    let reasoning = '';
    let calls: ToolCall[] = [];
    let roundUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };

    const requestFor = (endpoint: ResolvedEndpoint): CompletionRequest => ({
      model: this.pickModel(agent, endpoint, settings),
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
          const approved = await this.deps.approvals.ask({
            agentId: agent.id,
            boardId: this.deps.board.id,
            kind: 'exec',
            title: `MCP: ${call.name}`,
            detail: call.arguments.slice(0, 500),
            subject: call.name
          });
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
      requestApproval: (ask) =>
        this.deps.approvals.ask({
          agentId: agent.id,
          boardId: this.deps.board.id,
          kind: ask.kind,
          title: ask.title,
          detail: ask.detail,
          subject: ask.subject
        })
    };

    try {
      const result = await tool.handler(args, ctx);
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
    const endpoints = this.resolveEndpoints(parent, settings);
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
        controller.signal
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
