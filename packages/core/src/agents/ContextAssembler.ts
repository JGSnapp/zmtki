import {
  isAgentFrame,
  nodesInRect,
  outlineNode,
  rectOf,
  renderPeripheralIndex,
  summarizeArtifact,
  type Agent,
  type BoardNode,
  type FrameNode
} from '@zmtki/board-schema';
import type { BoardStore } from '../board/BoardStore.js';

export interface AssembledContext {
  frameContext: string;
  peripheralContext: string;
  agentRoster: string;
  /** Nodes the agent currently owns visually; used for change detection. */
  frameNodeIds: string[];
}

const FULL_DETAIL_KINDS = new Set([
  'markdown',
  'status',
  'todo',
  'kanban',
  'table',
  'diff',
  'fileFragment',
  'mermaid',
  'note',
  'chart'
]);

const MAX_FRAME_CHARS = 40_000;
const MAX_ARTIFACT_CHARS = 6_000;

/**
 * Turns the spatial board into text the model can reason about.
 *
 * The frame is rendered in full because it is the agent's working set; the
 * rest of the board is rendered as one line per node. That asymmetry is what
 * makes the frame mean something — moving it is how an agent changes what it
 * can see in detail.
 */
export class ContextAssembler {
  constructor(private readonly board: BoardStore) {}

  frameOf(agentId: string): FrameNode | undefined {
    return this.board.nodes.find((n): n is FrameNode => isAgentFrame(n) && n.agentId === agentId);
  }

  assemble(agent: Agent, allAgents: readonly Agent[]): AssembledContext {
    const doc = this.board.toDoc();
    const frame = this.frameOf(agent.id);

    const inside = frame ? nodesInRect(doc, rectOf(frame)) : [];
    const insideIds = new Set(inside.map((n) => n.id));
    const outside = doc.nodes.filter((n) => !insideIds.has(n.id) && n.id !== frame?.id);

    return {
      frameContext: this.renderFull(inside),
      peripheralContext: this.renderPeripheral(outside, frame),
      agentRoster: this.renderRoster(agent, allAgents),
      frameNodeIds: [...insideIds]
    };
  }

  private renderFull(nodes: readonly BoardNode[]): string {
    if (nodes.length === 0) return '';

    const ordered = [...nodes].sort((a, b) => b.updatedAt - a.updatedAt);
    const chunks: string[] = [];
    let budget = MAX_FRAME_CHARS;

    for (const node of ordered) {
      const rendered = this.renderNode(node);
      if (rendered.length > budget) {
        // Once the budget is gone, fall back to one-liners so nothing silently
        // disappears from the agent's view of its own frame.
        const remaining = ordered.slice(ordered.indexOf(node));
        chunks.push(`\n[остальные ${remaining.length} объектов кратко]\n${renderPeripheralIndex(remaining)}`);
        break;
      }
      chunks.push(rendered);
      budget -= rendered.length;
    }

    return chunks.join('\n\n');
  }

  private renderNode(node: BoardNode): string {
    const header = `## ${node.id} [${node.type === 'artifact' ? node.artifact.kind : node.type}]`;

    if (node.type !== 'artifact') {
      const outline = outlineNode(node);
      return `${header} ${outline.title}\n${outline.summary}`;
    }

    const spec = node.artifact;
    if (!FULL_DETAIL_KINDS.has(spec.kind)) {
      return `${header} ${spec.title}\n${summarizeArtifact(spec)}`;
    }

    const body = JSON.stringify(
      spec,
      (key, value: unknown) => {
        // Payload refs point at files on disk; inlining them would blow the budget.
        if (key === 'payload') return '[внешние данные]';
        return value;
      },
      2
    );

    return `${header} ${spec.title} (tone=${spec.tone})\n${
      body.length > MAX_ARTIFACT_CHARS
        ? `${body.slice(0, MAX_ARTIFACT_CHARS)}\n[...обрезано]`
        : body
    }`;
  }

  private renderPeripheral(nodes: readonly BoardNode[], frame: FrameNode | undefined): string {
    if (nodes.length === 0) return '';
    const index = renderPeripheralIndex(nodes, 120);
    if (!frame) return index;
    // Directions let the agent aim board_move_frame without a coordinate dump.
    const center = { x: frame.position.x + frame.size.w / 2, y: frame.position.y + frame.size.h / 2 };
    const hint = nodes
      .slice(0, 12)
      .map((n) => {
        const dx = n.position.x + n.size.w / 2 - center.x;
        const dy = n.position.y + n.size.h / 2 - center.y;
        const dir = `${dy < -50 ? 'сверху' : dy > 50 ? 'снизу' : ''}${Math.abs(dx) > 50 ? (dx < 0 ? ' слева' : ' справа') : ''}`.trim();
        return `${n.id}: ${dir || 'рядом'} (${Math.round(n.position.x)},${Math.round(n.position.y)})`;
      })
      .join('; ');
    return `${index}\n\nГде что лежит относительно твоей рамки: ${hint}`;
  }

  private renderRoster(self: Agent, all: readonly Agent[]): string {
    const others = all.filter((a) => a.id !== self.id);
    if (others.length === 0) return '';
    return others
      .map((a) => {
        const frame = this.frameOf(a.id);
        const where = frame
          ? `рамка в (${Math.round(frame.position.x)},${Math.round(frame.position.y)})`
          : 'без рамки';
        return `- ${a.id} @${a.handle} "${a.name}" [${a.status}] ${where}${a.persona ? ` — ${a.persona.slice(0, 100)}` : ''}`;
      })
      .join('\n');
  }
}
