import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../src/shared/ipc.js';
import { createZone } from '../src/main/boards/operations.js';
import type { AgentService, SpawnInput, SpawnOutcome } from '../src/main/harness/agents.js';
import { BoardMcpServer } from '../src/main/mcp/server.js';
import { makeEnv, type TestEnv } from './helpers.js';

const agentInfo = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'a1',
  boardId: '',
  artifactId: 'term-1',
  harnessId: 'claude',
  label: 'Claude',
  color: '#7aa2ff',
  cwd: '',
  running: true,
  startedAt: Date.now(),
  toolCalls: 0,
  subagentIds: [],
  subagentLimit: 2,
  requireApproval: true,
  ...over,
});

/**
 * The agent service as the MCP layer sees it. The real one owns PTYs; what the
 * tools and the zone guard use of it is this much, so the rules can be checked
 * without starting a shell.
 */
class FakeAgents {
  readonly agents = new Map<string, AgentInfo>();
  readonly asked: SpawnInput[] = [];
  outcome: SpawnOutcome = { status: 'pending', requestId: 'req-1' };
  readonly sent: Array<{ agentId: string; text: string }> = [];

  add(info: AgentInfo): AgentInfo {
    this.agents.set(info.id, info);
    return info;
  }
  get(id: string): AgentInfo | null {
    return this.agents.get(id) ?? null;
  }
  list(): AgentInfo[] {
    return [...this.agents.values()];
  }
  requestSubagent(_parentId: string, input: SpawnInput): Promise<SpawnOutcome> {
    this.asked.push(input);
    return Promise.resolve(this.outcome);
  }
  requestStatus(): 'pending' | 'gone' {
    return 'pending';
  }
  sendTo(_parentId: string, agentId: string, text: string): { ok: boolean; reason?: string } {
    this.sent.push({ agentId, text });
    return { ok: true };
  }
  release(): void {}
}

describe('zones and subagents over MCP', () => {
  let env: TestEnv;
  let server: BoardMcpServer;
  let fake: FakeAgents;

  beforeEach(async () => {
    env = makeEnv();
    fake = new FakeAgents();
    server = new BoardMcpServer(env.ctx.boards, env.ctx.skills, undefined, () => undefined);
    server.attachAgents(fake as unknown as AgentService);
    await server.start();
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

  const textOf = (result: unknown): string => {
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    return content.map((part) => part.text ?? '').join('\n');
  };

  /** A board with one zone and an agent bound to it. */
  const boundBoard = () => {
    const board = env.ctx.boards.create({ title: 'Зоны' });
    const zone = env.ctx.boards.mutate(board.id, (state) =>
      createZone(state, { title: 'Исследование', rects: [{ x: 0, y: 0, width: 1000, height: 800 }] }),
    );
    fake.add(agentInfo({ boardId: board.id, zoneId: zone.id }));
    return { board, zone };
  };

  it('undoes what an agent places outside its zone and tells it how to get more room', async () => {
    const { board, zone } = boundBoard();
    const client = await connect(server.bind('a1', board.id));

    const result = await client.callTool({ name: 'artifact_create', arguments: { type: 'note', x: 4000, y: 4000 } });
    expect(result.isError).toBeTruthy();
    const said = textOf(result);
    expect(said).toContain('Исследование');
    expect(said).toContain('zone_request');
    expect(env.ctx.boards.snapshot(board.id).artifacts).toHaveLength(0);
    expect(env.ctx.boards.snapshot(board.id).zones.map((z) => z.id)).toEqual([zone.id]);
    await client.close();
  });

  it('leaves what it places inside the zone alone', async () => {
    const { board } = boundBoard();
    const client = await connect(server.bind('a1', board.id));

    const result = await client.callTool({ name: 'artifact_create', arguments: { type: 'note', x: 40, y: 40 } });
    expect(result.isError).toBeFalsy();
    expect(env.ctx.boards.snapshot(board.id).artifacts).toHaveLength(1);
    await client.close();
  });

  it('asks the user for a zone instead of taking one: the zone arrives pending', async () => {
    const board = env.ctx.boards.create();
    fake.add(agentInfo({ boardId: board.id }));
    const client = await connect(server.bind('a1', board.id));

    await client.callTool({
      name: 'zone_request',
      arguments: { title: 'Черновики', reason: 'Сложить туда наброски', x: 0, y: 0, width: 600, height: 400 },
    });

    const [zone] = env.ctx.boards.snapshot(board.id).zones;
    expect(zone.pending).toBe(true);
    expect(zone.ownerId).toBe('a1');
    expect(zone.reason).toBe('Сложить туда наброски');
    await client.close();
  });

  it('hands a spawn request to the user and does not block on the answer', async () => {
    const board = env.ctx.boards.create();
    fake.add(agentInfo({ boardId: board.id }));
    const client = await connect(server.bind('a1', board.id));

    const result = await client.callTool({ name: 'agent_spawn', arguments: { purpose: 'Проверить тесты' } });
    expect(fake.asked[0].purpose).toBe('Проверить тесты');
    const said = textOf(result);
    expect(said).toContain('pending');
    expect(said).toContain('req-1');
    await client.close();
  });

  it('refuses a spawn the user has forbidden, in words the agent can act on', async () => {
    const board = env.ctx.boards.create();
    fake.add(agentInfo({ boardId: board.id, subagentLimit: 0 }));
    fake.outcome = { status: 'refused', reason: 'Субагенты запрещены для этого агента.' };
    const client = await connect(server.bind('a1', board.id));

    const result = await client.callTool({ name: 'agent_spawn', arguments: { purpose: 'Помощник' } });
    expect(textOf(result)).toContain('Субагенты запрещены');
    await client.close();
  });

  it('lets an agent leave a button, always asking before a command runs', async () => {
    const board = env.ctx.boards.create();
    fake.add(agentInfo({ boardId: board.id }));
    const client = await connect(server.bind('a1', board.id));

    await client.callTool({
      name: 'button_set',
      arguments: { label: 'Прогнать тесты', kind: 'command', value: 'npm test', targetId: 'term-1', confirm: false, x: 20, y: 20 },
    });

    const [button] = env.ctx.boards.snapshot(board.id).artifacts;
    expect(button.type).toBe('button');
    expect(button.props.action).toBe('npm test');
    // `confirm: false` asked for by an agent is not honoured for a command.
    expect(button.props.confirm).toBe(true);
    expect(button.props.createdBy).toBe('a1');
    await client.close();
  });

  it('only lets a button write to the agent own subagent', async () => {
    const board = env.ctx.boards.create();
    fake.add(agentInfo({ boardId: board.id }));
    fake.add(agentInfo({ id: 'other', boardId: board.id, label: 'Чужой' }));
    const client = await connect(server.bind('a1', board.id));

    const refused = await client.callTool({
      name: 'button_set',
      arguments: { label: 'Дать задание', kind: 'agent', value: 'собери отчёт', targetId: 'other' },
    });
    expect(textOf(refused)).toContain('субагенту');
    expect(env.ctx.boards.snapshot(board.id).artifacts).toHaveLength(0);

    fake.agents.get('a1')!.subagentIds.push('other');
    const allowed = await client.callTool({
      name: 'button_set',
      arguments: { label: 'Дать задание', kind: 'agent', value: 'собери отчёт', targetId: 'other' },
    });
    expect(allowed.isError).toBeFalsy();
    expect(env.ctx.boards.snapshot(board.id).artifacts).toHaveLength(1);
    await client.close();
  });
});
