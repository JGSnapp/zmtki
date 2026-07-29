import { summarizeArtifact } from './artifacts.js';
import type { BoardDoc } from './board.js';
import { isMostlyInside, rectOf, type Rect } from './geometry.js';
import { isAgentFrame, nodeText, type BoardNode } from './nodes.js';

/**
 * Textual projection of the board. Two audiences: the agent (this is how it
 * "sees" parts of the board it is not focused on) and the human reading the
 * repo, since it is written to `.zmtki/board.outline.md` on every save.
 */

export interface NodeOutline {
  id: string;
  type: BoardNode['type'];
  kind?: string;
  title: string;
  summary: string;
  rect: Rect;
  createdBy: string | null;
  rev: number;
}

export function outlineNode(node: BoardNode): NodeOutline {
  const rect = rectOf(node);
  if (node.type === 'artifact') {
    return {
      id: node.id,
      type: node.type,
      kind: node.artifact.kind,
      title: node.artifact.title || node.artifact.kind,
      summary: summarizeArtifact(node.artifact),
      rect,
      createdBy: node.createdBy,
      rev: node.rev
    };
  }
  const text = nodeText(node);
  return {
    id: node.id,
    type: node.type,
    title: text.slice(0, 80) || node.type,
    summary: text.slice(0, 200),
    rect,
    createdBy: node.createdBy,
    rev: node.rev
  };
}

export function nodesInRect(doc: BoardDoc, rect: Rect, threshold = 0.6): BoardNode[] {
  return doc.nodes.filter(
    (n) => !n.hidden && n.type !== 'frame' && isMostlyInside(rectOf(n), rect, threshold)
  );
}

export function agentFrame(doc: BoardDoc, agentId: string) {
  return doc.nodes.find((n) => isAgentFrame(n) && n.agentId === agentId);
}

function fmtRect(r: Rect): string {
  return `(${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)})`;
}

/**
 * Compact one-line-per-node index. Used for everything outside an agent's
 * frame, where full content would blow the context budget but the agent still
 * needs to know what exists and where, so it can decide to move.
 */
export function renderPeripheralIndex(nodes: readonly BoardNode[], limit = 120): string {
  if (nodes.length === 0) return '(пусто)';
  const lines = nodes.slice(0, limit).map((n) => {
    const o = outlineNode(n);
    const kind = o.kind ? `${o.type}/${o.kind}` : o.type;
    return `- ${o.id} [${kind}] ${fmtRect(o.rect)} ${o.title}${o.summary && o.summary !== o.title ? ` — ${o.summary}` : ''}`;
  });
  if (nodes.length > limit) lines.push(`- ... и ещё ${nodes.length - limit} объектов`);
  return lines.join('\n');
}

export function renderBoardOutline(doc: BoardDoc): string {
  const frames = doc.nodes.filter(isAgentFrame);
  const parts: string[] = [];
  parts.push(`# ${doc.name}`);
  parts.push('');
  parts.push(`_Автогенерируемая проекция доски. Правьте доску, а не этот файл._`);
  parts.push('');
  if (doc.description) {
    parts.push(doc.description);
    parts.push('');
  }
  parts.push(
    `Объектов: ${doc.nodes.length}, связей: ${doc.edges.length}, слоёв: ${doc.layers.length}, агентов: ${frames.length}.`
  );
  parts.push('');

  const claimed = new Set<string>();
  for (const frame of frames) {
    const inside = nodesInRect(doc, rectOf(frame));
    for (const n of inside) claimed.add(n.id);
    parts.push(`## Рамка агента: ${frame.label || frame.agentId} ${fmtRect(rectOf(frame))}`);
    parts.push('');
    parts.push(renderPeripheralIndex(inside));
    parts.push('');
  }

  const loose = doc.nodes.filter((n) => n.type !== 'frame' && !claimed.has(n.id));
  if (loose.length > 0) {
    parts.push('## Вне рамок');
    parts.push('');
    parts.push(renderPeripheralIndex(loose));
    parts.push('');
  }

  if (doc.edges.length > 0) {
    parts.push('## Связи');
    parts.push('');
    for (const e of doc.edges.slice(0, 200)) {
      const from = e.from.nodeId ?? 'точка';
      const to = e.to.nodeId ?? 'точка';
      parts.push(`- ${from} -> ${to}${e.label ? ` (${e.label})` : ''}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}
