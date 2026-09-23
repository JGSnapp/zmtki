import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCallReport } from '../src/main/mcp/server.js';
import { BoardMcpServer } from '../src/main/mcp/server.js';
import { makeEnv, type TestEnv } from './helpers.js';

/**
 * The harness path end to end, minus the CLI: a real MCP client over real HTTP
 * against the server a terminal agent is pointed at.
 */
describe('board MCP server', () => {
  let env: TestEnv;
  let server: BoardMcpServer;
  let reports: ToolCallReport[];
  const changes: Array<{ origin: string; agentId?: string }> = [];

  beforeEach(async () => {
    env = makeEnv();
    reports = [];
    changes.length = 0;
    server = new BoardMcpServer(env.ctx.boards, env.ctx.skills, undefined, (report) => reports.push(report));
    await server.start();
    env.ctx.boards.onUpdate((event) => changes.push({ origin: event.origin, agentId: event.agentId }));
  });

  afterEach(async () => {
    await server.stop();
    await env.dispose();
  });

  const connect = async (endpoint: string) => {
    const client = new Client({ name: 'test-harness', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    return client;
  };

  it('serves every board tool with its schema and the layout prompt as instructions', async () => {
    const board = env.ctx.boards.create({ title: 'MCP' });
    const client = await connect(server.bind('agent-1', board.id));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['artifact_create', 'arrow_create', 'board_arrange_graph', 'skill_get', 'board_screenshot']));
    expect(tools.find((t) => t.name === 'artifact_create')?.inputSchema.type).toBe('object');
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('движок расстановки артефактов');
    expect(instructions).toContain('graph-layout');
    expect(instructions).toContain('"MCP"');
    await client.close();
  });

  it('edits the bound board as that agent and reports the call', async () => {
    const board = env.ctx.boards.create();
    const client = await connect(server.bind('agent-7', board.id));
    const result = await client.callTool({ name: 'artifact_create', arguments: { type: 'note', x: 40, y: 60, props: { text: 'из MCP' } } });
    expect(result.isError).toBeFalsy();

    const state = env.ctx.boards.snapshot(board.id);
    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0].props.text).toBe('из MCP');
    expect(changes.at(-1)).toEqual({ origin: 'agent', agentId: 'agent-7' });
    expect(reports.at(-1)).toMatchObject({ agentId: 'agent-7', tool: 'artifact_create', ok: true });
    expect(reports.at(-1)?.target).toMatchObject({ x: 40, y: 60 });
    await client.close();
  });

  it('coerces numbers sent as strings, as models do, instead of failing', async () => {
    const board = env.ctx.boards.create();
    const client = await connect(server.bind('agent-1', board.id));
    const result = await client.callTool({ name: 'artifact_create', arguments: { type: 'note', x: '100', y: '20' } });
    expect(result.isError).toBeFalsy();
    expect(env.ctx.boards.snapshot(board.id).artifacts[0].x).toBe(100);
    await client.close();
  });

  it('returns a failed operation as a tool error the agent can read', async () => {
    const board = env.ctx.boards.create();
    const client = await connect(server.bind('agent-1', board.id));
    const result = await client.callTool({ name: 'artifact_move', arguments: { id: 'art_missing', x: 0, y: 0 } });
    expect(result.isError).toBe(true);
    expect(reports.at(-1)?.ok).toBe(false);
    await client.close();
  });

  it('keeps an agent on its own board and refuses a revoked token', async () => {
    const mine = env.ctx.boards.create();
    const other = env.ctx.boards.create();
    const endpoint = server.bind('agent-1', mine.id);
    const client = await connect(endpoint);
    await client.callTool({ name: 'artifact_create', arguments: { type: 'note', x: 0, y: 0 } });
    expect(env.ctx.boards.snapshot(other.id).artifacts).toHaveLength(0);
    await client.close();

    server.unbind('agent-1');
    await expect(connect(endpoint)).rejects.toThrow();
  });

  it('refuses requests that come from a browser page', async () => {
    const board = env.ctx.boards.create();
    const endpoint = server.bind('agent-1', board.id);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(403);
  });
});
