import type { DragEvent } from 'react';

export const AGENT_DRAG_MIME = 'application/x-zmtki-agent';

export type AgentDragPayload = { agentId: string };

export function setAgentDragData(event: DragEvent, agentId: string): void {
  const json = JSON.stringify({ agentId } satisfies AgentDragPayload);
  event.dataTransfer.setData(AGENT_DRAG_MIME, json);
  event.dataTransfer.setData('text/plain', json);
  event.dataTransfer.effectAllowed = 'copyMove';
}

export function readAgentDragData(event: DragEvent): AgentDragPayload | null {
  const raw = event.dataTransfer.getData(AGENT_DRAG_MIME) || event.dataTransfer.getData('text/plain');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AgentDragPayload>;
    if (typeof parsed.agentId === 'string') return { agentId: parsed.agentId };
  } catch {
    /* ignore */
  }
  return null;
}

export function isAgentDrag(event: DragEvent): boolean {
  return [...event.dataTransfer.types].some((t) => t === AGENT_DRAG_MIME || t === 'text/plain');
}
