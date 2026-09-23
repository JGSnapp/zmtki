import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Rect } from '@zmtki/shared';
import { boardQuality, boundsOf, zoneBounds, zoneContainsRect } from '@zmtki/shared';
import type { BoardsService } from '../boards/boards.service.js';
import type { AgentService } from '../harness/agents.js';
import { ArrangeService } from '../layout/arrange.service.js';
import type { SkillsService } from '../skills/skills.service.js';
import { mcpInstructions } from './prompt.js';
import { ToolRegistry } from './tools/index.js';
import type { ScreenshotSource, ToolResult } from './tools/types.js';
import { validateArgs } from './tools/validate.js';

/** One harness's access to one board. The token in the URL is the whole credential. */
export interface AgentBinding {
  agentId: string;
  boardId: string;
  token: string;
}

export interface ToolCallReport {
  agentId: string;
  tool: string;
  ok: boolean;
  error?: string;
  /** Where on the board the call acted, when the result says. */
  target?: Rect;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_LISTED_ARTIFACTS = 40;

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Тело запроса слишком большое'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on('error', reject);
  });

/**
 * Same shape of refusal the teca agent loop recognised: a tool that declines
 * returns `refused: true` and a reason rather than throwing, and the model
 * should read it as "try differently", not as a crash.
 */
const refusalReason = (data: unknown): string | null => {
  if (!data || typeof data !== 'object') return null;
  const row = data as Record<string, unknown>;
  if (row.refused !== true) return null;
  return typeof row.reason === 'string' ? row.reason : 'Инструмент отказал';
};

const isRect = (value: unknown): value is Rect => {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof r[k] === 'number');
};

/** Finds the artifact a result is about, for the agent's marker on the board. */
const targetOf = (data: unknown): Rect | undefined => {
  if (!data || typeof data !== 'object') return undefined;
  const row = data as Record<string, unknown>;
  if (isRect(row.artifact)) return row.artifact;
  if (isRect(row)) return row;
  if (isRect(row.bounds)) return row.bounds;
  return undefined;
};

/**
 * Serves the board tools to harnesses over MCP (Streamable HTTP).
 *
 * One HTTP listener for every agent, the agent's token in the path: a CLI gets
 * a URL rather than a bridge process, so a second harness costs a token, not a
 * child process. Bound to loopback, and a request carrying a browser `Origin`
 * is refused, so a web page the user has open cannot reach a local board.
 *
 * The tool specs are teca's, served with their JSON Schemas as they are —
 * which is why this uses the SDK's low-level `Server` rather than `McpServer`,
 * whose registration wants zod shapes. Arguments go through teca's own
 * validator, which coerces the numbers-as-strings models like to send.
 *
 * Each request builds its own server over a stateless transport. Registration
 * is two handlers, and long-lived sessions would have to be reconciled with
 * agents being killed and restarted from the board at any moment.
 */
export class BoardMcpServer {
  private http: HttpServer | null = null;
  private port = 0;
  private readonly bindings = new Map<string, AgentBinding>();
  private readonly registry = new ToolRegistry();

  constructor(
    private readonly boards: BoardsService,
    private readonly skills: SkillsService,
    private readonly screenshots: ScreenshotSource | undefined,
    private readonly onToolCall: (report: ToolCallReport) => void,
  ) {}

  /**
   * Agents are attached after construction: they need this server to hand out
   * their MCP endpoints, and this server needs them for the agent tools and for
   * the zone a caller is bound to.
   */
  private agents: AgentService | null = null;

  /** The layout engine's thread, shared by every board that asks for a layout. */
  private readonly arrange = new ArrangeService();

  attachAgents(agents: AgentService): void {
    this.agents = agents;
  }

  /**
   * Keeps a zone-bound agent inside its zone.
   *
   * Checked after the call rather than before: one tool call is one
   * transaction, so whatever it wrote can be taken back whole, and this covers
   * every way of moving something — creating, moving, resizing, laying out a
   * graph — without teaching each tool about zones.
   */
  private enforceZone(binding: AgentBinding, startedAt: number, versionBefore: number): string | null {
    const agent = this.agents?.get(binding.agentId);
    if (!agent?.zoneId) return null;
    const outside = this.boards.read(binding.boardId, (state, board) => {
      const zone = state.zones.find((z) => z.id === agent.zoneId && z.pending !== true);
      if (!zone) return null;
      if (board.version === versionBefore) return null;
      const strays = state.artifacts.filter((a) => a.updatedAt >= startedAt && !zoneContainsRect(zone, a));
      return strays.length > 0 ? { zone, strays } : null;
    });
    if (!outside) return null;
    this.boards.undo(binding.boardId);
    const bounds = zoneBounds(outside.zone);
    return (
      'Отменено: ты привязан к зоне «' + outside.zone.title + '», а ' + outside.strays.length +
      ' артефакт(ов) вышли за её границы' +
      (bounds ? ' (зона: x=' + bounds.x + ' y=' + bounds.y + ' w=' + bounds.width + ' h=' + bounds.height + ')' : '') +
      '. Размести внутри зоны или попроси её расширить через zone_request с extendZoneId.'
    );
  }

  get toolNames(): string[] {
    return this.registry.all().map((tool) => tool.name);
  }

  get listeningPort(): number {
    return this.port;
  }

  async start(): Promise<number> {
    if (this.http) return this.port;
    const http = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => {
        http.removeListener('error', reject);
        resolve();
      });
    });
    const address = http.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    this.http = http;
    return this.port;
  }

  async stop(): Promise<void> {
    const http = this.http;
    if (!http) return;
    this.http = null;
    http.closeAllConnections();
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
  }

  /** Registers an agent and returns the endpoint its CLI should be pointed at. */
  bind(agentId: string, boardId: string): string {
    const token = randomBytes(24).toString('hex');
    this.bindings.set(token, { agentId, boardId, token });
    return 'http://127.0.0.1:' + this.port + '/mcp/' + token;
  }

  /** Revokes an agent's access. Its next call gets a 404. */
  unbind(agentId: string): void {
    for (const [token, binding] of this.bindings) {
      if (binding.agentId === agentId) this.bindings.delete(token);
    }
  }

  private boardContext(boardId: string): string {
    return this.boards.read(boardId, (state, board) => {
      const lines = [
        'Доска: "' + board.title + '" (id: ' + board.id + ')',
        board.rootDir ? 'Папка доски: ' + board.rootDir : '',
        'Артефактов: ' + state.artifacts.length + ', стрелок: ' + state.arrows.length,
      ].filter(Boolean);
      if (state.artifacts.length === 0) {
        lines.push('Доска пустая. Начинай композицию около точки (0, 0).');
        return lines.join('\n');
      }
      const bounds = boundsOf(state.artifacts);
      lines.push(
        'Занятая область: x=' + bounds.x + ' y=' + bounds.y + ' w=' + bounds.width + ' h=' + bounds.height,
        'Артефакты:',
        ...state.artifacts
          .slice(0, MAX_LISTED_ARTIFACTS)
          .map((a) => '  ' + a.id + ' [' + a.type + '] @(' + a.x + ',' + a.y + ') ' + a.width + 'x' + a.height),
      );
      if (state.artifacts.length > MAX_LISTED_ARTIFACTS) {
        lines.push('  … ещё ' + (state.artifacts.length - MAX_LISTED_ARTIFACTS) + ', смотри board_get_region');
      }
      if (state.arrows.length > 0) {
        const quality = boardQuality(state.artifacts, state.arrows);
        lines.push('Качество раскладки: ' + quality.score + '/100 (' + quality.grade + '), штраф ' + quality.cost);
      }
      return lines.join('\n');
    });
  }

  private skillCatalog(): string {
    const skills = this.skills.catalog();
    if (skills.length === 0) return 'Скиллов пока нет.';
    return [
      'Прежде чем менять доску, подбери скилл и прочитай его через skill_get(slug):',
      ...skills.map((skill) => '  ' + skill.slug + ' — ' + skill.name + '. Когда: ' + skill.when),
    ].join('\n');
  }

  private async callTool(binding: AgentBinding, name: string, rawArgs: unknown) {
    const fail = (message: string) => {
      this.onToolCall({ agentId: binding.agentId, tool: name, ok: false, error: message });
      return { isError: true, content: [{ type: 'text' as const, text: message }] };
    };

    const tool = this.registry.get(name);
    if (!tool) return fail('Неизвестный инструмент ' + name);
    const validation = validateArgs(tool.parameters, rawArgs);
    if (!validation.ok) return fail(validation.errors.join('; '));

    const startedAt = Date.now();
    const versionBefore = this.boards.read(binding.boardId, (_state, board) => board.version);
    let result: ToolResult;
    try {
      result = await this.boards.runAs(binding.agentId, () =>
        tool.run(validation.value, {
          boardId: binding.boardId,
          agentId: binding.agentId,
          boards: this.boards,
          skills: this.skills,
          screenshots: this.screenshots,
          agents: this.agents ?? undefined,
          arrange: this.arrange,
        }),
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    // A subagent's terminal is placed by the host next to its parent, so it is
    // not the caller's placement to police.
    if (name !== 'agent_spawn') {
      const violation = this.enforceZone(binding, startedAt, versionBefore);
      if (violation) return fail(violation);
    }

    const refusal = refusalReason(result.data);
    this.onToolCall({
      agentId: binding.agentId,
      tool: name,
      ok: refusal == null,
      error: refusal ?? undefined,
      target: targetOf(result.data),
    });

    const text = JSON.stringify(
      refusal ? { status: 'refused', reason: refusal, result: result.data } : result.data,
      null,
      2,
    );
    const content: Array<
      { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
    > = [{ type: 'text', text }];
    if (result.image) {
      const match = /^data:([^;]+);base64,(.*)$/.exec(result.image.dataUrl);
      if (match) {
        content.push({ type: 'text', text: result.image.caption });
        content.push({ type: 'image', mimeType: match[1], data: match[2] });
      }
    }
    return { content };
  }

  private buildServer(binding: AgentBinding): Server {
    const server = new Server(
      { name: 'zmtki-board', version: '0.1.0' },
      {
        capabilities: { tools: {} },
        instructions: mcpInstructions(this.boardContext(binding.boardId), this.skillCatalog()),
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.registry.all().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters as { type: 'object'; properties?: Record<string, unknown> },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.callTool(binding, request.params.name, request.params.arguments ?? {}),
    );
    return server;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A CLI client sends no Origin. A browser always does.
    if (req.headers.origin) {
      res.writeHead(403).end('Запросы из браузера не принимаются');
      return;
    }

    const match = /^\/mcp\/([a-f0-9]{48})$/.exec((req.url ?? '').split('?')[0]);
    const binding = match ? this.bindings.get(match[1]) : undefined;
    if (!binding) {
      res.writeHead(404).end('Неизвестный агент');
      return;
    }
    // A stateless server has no SSE stream to offer and nothing to delete.
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400).end('Тело запроса не разобрано');
      return;
    }

    const server = this.buildServer(binding);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500).end(error instanceof Error ? error.message : 'Ошибка MCP');
      }
    }
  }
}
