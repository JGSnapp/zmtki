import path from 'node:path';
import {
  AgentSchema,
  AgentsFileSchema,
  BOARD_DIR,
  agentHandleFromName,
  createFrameNode,
  newId,
  type Agent,
  type AgentStatus,
  type FrameNode
} from '@zmtki/board-schema';
import type { BoardStore } from '../board/BoardStore.js';
import { Emitter } from '../util/emitter.js';
import { debounceWithMaxWait } from '../util/async.js';
import { readJsonIfExists, writeFileAtomic } from '../util/fs.js';

export interface CreateAgentInput {
  name: string;
  persona?: string;
  avatarColor?: string;
  endpointId?: string;
  model?: string;
  toolsets?: string[];
  /** Where to put the agent's frame; auto-placed to the right if omitted. */
  position?: { x: number; y: number };
}

const AVATAR_PALETTE = [
  '#7c9cff',
  '#f5a97f',
  '#a6da95',
  '#f5bde6',
  '#eed49f',
  '#8bd5ca',
  '#ed8796',
  '#c6a0f6'
];

const FRAME_SIZE = { w: 1200, h: 900 };
const FRAME_GAP = 160;

/**
 * Agents of one board, persisted next to the board document.
 *
 * Agent ids are globally unique even though the file is per-board, because a
 * room can contain agents from several projects. The board folder stays the
 * source of truth; AgentDirectory only caches it.
 */
export class AgentStore {
  readonly onChange = new Emitter<Agent[]>();
  readonly onStatus = new Emitter<{ agentId: string; status: AgentStatus; headline: string }>();

  private agents = new Map<string, Agent>();
  private headlines = new Map<string, string>();
  private saver: ReturnType<typeof debounceWithMaxWait>;

  constructor(
    private readonly boardPath: string,
    private readonly board: BoardStore
  ) {
    this.saver = debounceWithMaxWait(() => this.write(), 400, 2500);
  }

  private get file(): string {
    return path.join(this.boardPath, BOARD_DIR, 'agents.json');
  }

  async load(): Promise<void> {
    const raw = await readJsonIfExists<unknown>(this.file);
    if (raw) {
      const parsed = AgentsFileSchema.safeParse(raw);
      if (parsed.success) {
        this.agents = new Map(parsed.data.agents.map((a) => [a.id, { ...a, status: 'idle' as const }]));
      }
    }
    // A frame may have been deleted by hand while the app was closed.
    this.reconcileFrames();
    this.onChange.emit(this.list());
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }

  get(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  byHandle(handle: string): Agent | undefined {
    const clean = handle.replace(/^@/, '').toLowerCase();
    return this.list().find((a) => a.handle.toLowerCase() === clean);
  }

  headline(agentId: string): string {
    return this.headlines.get(agentId) ?? '';
  }

  create(input: CreateAgentInput): Agent {
    const id = newId('agent');
    const position = input.position ?? this.nextFramePosition();
    const color = input.avatarColor ?? AVATAR_PALETTE[this.agents.size % AVATAR_PALETTE.length] ?? '#7c9cff';

    const frame = createFrameNode({
      label: input.name,
      position,
      size: FRAME_SIZE,
      agentId: id,
      style: { stroke: color }
    });
    this.board.apply({ origin: null, label: 'Создание агента', ops: [{ op: 'addNode', node: frame }] });

    const agent = AgentSchema.parse({
      id,
      name: input.name,
      handle: this.uniqueHandle(input.name),
      avatarColor: color,
      homeBoardId: this.board.id,
      frameNodeId: frame.id,
      persona: input.persona ?? '',
      model: {
        endpointId: input.endpointId ?? '',
        model: input.model ?? '',
        fallbacks: []
      },
      toolsets: input.toolsets ?? ['core', 'board', 'files', 'shell', 'web', 'rooms'],
      status: 'idle',
      createdAt: Date.now()
    });

    this.agents.set(agent.id, agent);
    this.saver.schedule();
    this.onChange.emit(this.list());
    return agent;
  }

  update(agentId: string, patch: Partial<Agent>): Agent | undefined {
    const existing = this.agents.get(agentId);
    if (!existing) return undefined;
    const next = AgentSchema.parse({ ...existing, ...patch, id: existing.id });
    this.agents.set(agentId, next);

    // Keep the frame's label and accent in step with the agent it represents.
    if (patch.name || patch.avatarColor) {
      const frame = this.frameOf(agentId);
      if (frame) {
        this.board.apply({
          origin: null,
          ops: [
            {
              op: 'updateNode',
              id: frame.id,
              patch: {
                label: next.name,
                ...(patch.avatarColor ? { style: { ...frame.style, stroke: next.avatarColor } } : {})
              }
            }
          ]
        });
      }
    }

    this.saver.schedule();
    this.onChange.emit(this.list());
    return next;
  }

  remove(agentId: string): void {
    const frame = this.frameOf(agentId);
    if (frame) {
      this.board.apply({
        origin: null,
        label: 'Удаление агента',
        ops: [{ op: 'removeNode', id: frame.id }]
      });
    }
    this.agents.delete(agentId);
    this.headlines.delete(agentId);
    this.saver.schedule();
    this.onChange.emit(this.list());
  }

  setStatus(agentId: string, status: AgentStatus, headline = ''): void {
    const existing = this.agents.get(agentId);
    if (!existing) return;
    if (headline) this.headlines.set(agentId, headline);
    if (existing.status === status && !headline) return;

    // Status is transient and lives only in memory: a crash should not leave an
    // agent recorded as 'running' forever. The renderer joins it onto the frame
    // by agentId when drawing.
    this.agents.set(agentId, { ...existing, status });
    this.onStatus.emit({ agentId, status, headline: this.headline(agentId) });
    this.onChange.emit(this.list());
  }

  frameOf(agentId: string): FrameNode | undefined {
    const agent = this.agents.get(agentId);
    if (!agent) return undefined;
    const byId = agent.frameNodeId ? this.board.getNode(agent.frameNodeId) : undefined;
    if (byId && byId.type === 'frame') return byId;
    return this.board.nodes.find(
      (n): n is FrameNode => n.type === 'frame' && n.agentId === agentId
    );
  }

  /** Recreates frames that went missing and repairs stale frame ids. */
  private reconcileFrames(): void {
    for (const agent of this.list()) {
      const frame = this.frameOf(agent.id);
      if (frame) {
        if (frame.id !== agent.frameNodeId) {
          this.agents.set(agent.id, { ...agent, frameNodeId: frame.id });
          this.saver.schedule();
        }
        continue;
      }
      const created = createFrameNode({
        label: agent.name,
        position: this.nextFramePosition(),
        size: FRAME_SIZE,
        agentId: agent.id,
        style: { stroke: agent.avatarColor }
      });
      this.board.apply({ origin: null, ops: [{ op: 'addNode', node: created }] });
      this.agents.set(agent.id, { ...agent, frameNodeId: created.id });
      this.saver.schedule();
    }
  }

  /** Places new frames in a row so agents never start on top of each other. */
  private nextFramePosition(): { x: number; y: number } {
    const frames = this.board.nodes.filter((n) => n.type === 'frame');
    if (frames.length === 0) return { x: 0, y: 0 };
    const rightmost = Math.max(...frames.map((f) => f.position.x + f.size.w));
    const topmost = Math.min(...frames.map((f) => f.position.y));
    return { x: rightmost + FRAME_GAP, y: topmost };
  }

  private uniqueHandle(name: string): string {
    const base = agentHandleFromName(name);
    const taken = new Set(this.list().map((a) => a.handle));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}${Date.now().toString(36)}`;
  }

  async flush(): Promise<void> {
    await this.saver.flush();
  }

  private async write(): Promise<void> {
    const payload = AgentsFileSchema.parse({
      version: 1,
      agents: this.list()
        .map((a) => ({ ...a, status: 'idle' as const }))
        .sort((a, b) => a.createdAt - b.createdAt)
    });
    await writeFileAtomic(this.file, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
