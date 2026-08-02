import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolSchema } from '../llm/types.js';
import {
  ensureMcpScaffold,
  loadMergedMcpConfig,
  removeMcpServer,
  upsertMcpServer
} from './mcpConfig.js';
import type {
  ExtensionScope,
  ExtensionsSnapshot,
  McpServerConfig,
  McpServerView
} from './types.js';
import { SkillLoader } from './SkillLoader.js';

interface LiveServer {
  name: string;
  scope: ExtensionScope;
  config: McpServerConfig;
  status: McpServerView['status'];
  error: string;
  client: Client | null;
  transport: StdioClientTransport | null;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

function toolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

function parseToolName(full: string): { server: string; tool: string } | null {
  if (!full.startsWith('mcp__')) return null;
  const rest = full.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/**
 * Owns skills + MCP lifecycle for the app. Board-scoped config is rebound
 * whenever the active board changes.
 */
export class ExtensionHost {
  readonly skills: SkillLoader;
  private servers = new Map<string, LiveServer>();
  private boardDir: string | null = null;

  constructor(private readonly globalDir: string) {
    this.skills = new SkillLoader(globalDir);
  }

  async init(): Promise<void> {
    await ensureMcpScaffold(this.globalDir);
    await this.skills.reload();
    await this.reconnectMcp();
  }

  async setBoardDir(boardDir: string | null): Promise<void> {
    this.boardDir = boardDir;
    this.skills.setBoardDir(boardDir);
    await this.skills.reload();
    await this.reconnectMcp();
  }

  snapshot(): ExtensionsSnapshot {
    return {
      skills: this.skills.list().map((s) => ({
        name: s.name,
        description: s.description,
        scope: s.scope,
        dir: s.dir
      })),
      mcpServers: [...this.servers.values()].map((s) => ({
        name: s.name,
        scope: s.scope,
        command: s.config.command,
        args: s.config.args ?? [],
        disabled: Boolean(s.config.disabled),
        status: s.status,
        error: s.error,
        toolCount: s.tools.length
      }))
    };
  }

  mcpSchemas(): ToolSchema[] {
    const schemas: ToolSchema[] = [];
    for (const server of this.servers.values()) {
      if (server.status !== 'ready') continue;
      for (const tool of server.tools) {
        schemas.push({
          name: toolName(server.name, tool.name),
          description: `[MCP:${server.name}] ${tool.description || tool.name}`,
          parameters: tool.inputSchema?.type
            ? tool.inputSchema
            : { type: 'object', properties: {}, additionalProperties: true }
        });
      }
    }
    return schemas;
  }

  isMcpTool(name: string): boolean {
    return name.startsWith('mcp__');
  }

  /** Pick a chat-like tool on an MCP server (for external agent bridges). */
  resolveChatTool(serverName: string, preferred = ''): string | null {
    const live = this.servers.get(serverName);
    if (!live || live.status !== 'ready' || live.tools.length === 0) return null;
    if (preferred && live.tools.some((t) => t.name === preferred)) return preferred;
    const prefer = ['chat', 'ask', 'prompt', 'message', 'agent', 'query', 'complete', 'run'];
    for (const key of prefer) {
      const hit = live.tools.find(
        (t) => t.name.toLowerCase() === key || t.name.toLowerCase().includes(key)
      );
      if (hit) return hit.name;
    }
    return live.tools[0]?.name ?? null;
  }

  async callMcpTool(
    fullName: string,
    args: Record<string, unknown>
  ): Promise<{ content: string; isError?: boolean }> {
    const parsed = parseToolName(fullName);
    if (!parsed) return { content: `некорректное имя MCP-инструмента: ${fullName}`, isError: true };
    const live = this.servers.get(parsed.server);
    if (!live?.client || live.status !== 'ready') {
      return { content: `MCP-сервер ${parsed.server} не готов`, isError: true };
    }
    try {
      const result = await live.client.callTool({ name: parsed.tool, arguments: args });
      const parts = Array.isArray(result.content) ? result.content : [];
      const text = parts
        .map((part) => {
          if (part && typeof part === 'object' && 'type' in part && part.type === 'text') {
            return String((part as { text?: string }).text ?? '');
          }
          return JSON.stringify(part);
        })
        .filter(Boolean)
        .join('\n');
      return {
        content: text || JSON.stringify(result),
        isError: Boolean(result.isError)
      };
    } catch (err) {
      return { content: `MCP ${parsed.server}.${parsed.tool}: ${(err as Error).message}`, isError: true };
    }
  }

  async upsertSkill(input: {
    scope: ExtensionScope;
    name: string;
    description: string;
    body: string;
  }): Promise<void> {
    await this.skills.upsert(input);
  }

  async removeSkill(scope: ExtensionScope, name: string): Promise<void> {
    await this.skills.remove(scope, name);
  }

  async upsertMcp(scope: ExtensionScope, name: string, config: McpServerConfig): Promise<void> {
    await upsertMcpServer(scope, this.globalDir, this.boardDir, name, config);
    await this.reconnectMcp();
  }

  async removeMcp(scope: ExtensionScope, name: string): Promise<void> {
    await removeMcpServer(scope, this.globalDir, this.boardDir, name);
    await this.reconnectMcp();
  }

  async testMcp(name: string): Promise<{ ok: boolean; tools: string[]; error: string }> {
    const live = this.servers.get(name);
    if (!live) return { ok: false, tools: [], error: 'сервер не найден' };
    if (live.status !== 'ready') {
      await this.startServer(live);
    }
    // startServer mutates status; re-read after await so TS does not keep the narrowed union
    const status = live.status;
    if (status === 'ready') {
      return { ok: true, tools: live.tools.map((t) => t.name), error: '' };
    }
    return { ok: false, tools: [], error: live.error || 'не удалось подключить' };
  }

  async shutdown(): Promise<void> {
    await this.stopAll();
  }

  private async reconnectMcp(): Promise<void> {
    await this.stopAll();
    const merged = await loadMergedMcpConfig(this.globalDir, this.boardDir);
    for (const entry of merged) {
      const live: LiveServer = {
        name: entry.name,
        scope: entry.scope,
        config: entry.config,
        status: entry.config.disabled ? 'stopped' : 'starting',
        error: '',
        client: null,
        transport: null,
        tools: []
      };
      this.servers.set(entry.name, live);
      if (!entry.config.disabled) {
        await this.startServer(live);
      }
    }
  }

  private async startServer(live: LiveServer): Promise<void> {
    live.status = 'starting';
    live.error = '';
    try {
      const transport = new StdioClientTransport({
        command: live.config.command,
        args: live.config.args ?? [],
        env: { ...process.env, ...(live.config.env ?? {}) } as Record<string, string>,
        stderr: 'pipe'
      });
      const client = new Client({ name: 'zmtki', version: '0.1.0' });
      await client.connect(transport);
      const listed = await client.listTools();
      live.transport = transport;
      live.client = client;
      live.tools = (listed.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
          type: 'object',
          properties: {}
        }
      }));
      live.status = 'ready';
    } catch (err) {
      live.status = 'error';
      live.error = (err as Error).message;
      live.client = null;
      live.transport = null;
      live.tools = [];
    }
  }

  private async stopAll(): Promise<void> {
    for (const live of this.servers.values()) {
      try {
        await live.client?.close();
      } catch {
        /* ignore */
      }
      try {
        await live.transport?.close();
      } catch {
        /* ignore */
      }
    }
    this.servers.clear();
  }
}
