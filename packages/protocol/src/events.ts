import type { Agent, AgentStatus, BoardDoc, CommentThread } from '@zmtki/board-schema';
import type { BoardOp } from './boardOps.js';
import type { Notification } from './notifications.js';
import type { Room, RoomMessage } from './rooms.js';

/**
 * Core -> UI. Deliberately not zod-validated: deltas arrive many times per
 * second and the cost of parsing each one is not worth it inside one process.
 * The schema version below guards against a stale renderer after an update.
 */
export const PROTOCOL_VERSION = 1;

export interface ApprovalRequest {
  id: string;
  agentId: string;
  boardId: string;
  kind: 'exec' | 'write' | 'network' | 'crossBoardWrite';
  title: string;
  detail: string;
  /** Command line, target path or URL, depending on kind. */
  subject: string;
  createdAt: number;
}

export interface ToolCallView {
  id: string;
  name: string;
  args: string;
  status: 'running' | 'ok' | 'error';
  resultPreview?: string;
  durationMs?: number;
  /** Node the call created or touched, so the UI can offer a jump link. */
  nodeId?: string | null;
}

export interface ActivityEntry {
  agentId: string;
  boardId: string;
  status: AgentStatus;
  headline: string;
  nodeId: string | null;
  updatedAt: number;
}

export type EventMsg =
  /** Full document, sent on open and after an external file change. */
  | { type: 'board.loaded'; boardId: string; doc: BoardDoc; path: string }
  | { type: 'board.ops'; boardId: string; ops: BoardOp[]; origin: string | null }
  | { type: 'board.closed'; boardId: string }
  | { type: 'board.error'; boardId: string; error: string }

  | { type: 'agent.list'; agents: Agent[] }
  | { type: 'agent.status'; agentId: string; status: AgentStatus; headline: string }

  | { type: 'turn.started'; turnId: string; agentId: string; roomId: string | null }
  | { type: 'turn.reasoningDelta'; turnId: string; agentId: string; text: string }
  | { type: 'turn.messageDelta'; turnId: string; agentId: string; text: string }
  | { type: 'turn.toolCall'; turnId: string; agentId: string; call: ToolCallView }
  | {
      type: 'turn.completed';
      turnId: string;
      agentId: string;
      usage: TurnUsage;
      stopReason: 'done' | 'maxRounds' | 'aborted' | 'error';
    }
  | { type: 'turn.failed'; turnId: string; agentId: string; error: string }
  | { type: 'turn.aborted'; turnId: string; agentId: string }

  | { type: 'room.list'; rooms: Room[] }
  | { type: 'room.message'; message: RoomMessage }
  | { type: 'room.updated'; room: Room }

  | { type: 'comment.threads'; boardId: string; threads: CommentThread[] }

  | { type: 'approval.request'; request: ApprovalRequest }
  | { type: 'approval.resolved'; requestId: string; approved: boolean }

  | { type: 'notification.new'; notification: Notification }
  | { type: 'notification.updated'; notification: Notification }
  | { type: 'notification.cleared'; ids: string[] }

  | { type: 'terminal.data'; nodeId: string; data: string }
  | { type: 'terminal.exit'; nodeId: string; exitCode: number | null }

  | { type: 'activity'; entries: ActivityEntry[] }

  | { type: 'scheduler.state'; running: number; queued: number; limit: number }

  | { type: 'provider.list'; endpoints: EndpointSummary[] }
  | { type: 'chatgpt.status'; status: ChatGptStatusView; error: string }

  | {
      type: 'board.event';
      boardId: string;
      event: BoardSpatialEvent;
    };

export interface EndpointSummary {
  id: string;
  label: string;
  baseUrl: string;
  provider: string;
  hasKey: boolean;
  models: string[];
  lastProbedAt: number;
  lastError: string;
}

export interface ChatGptStatusView {
  signedIn: boolean;
  email: string;
  plan: string;
  accountId: string;
  expiresAt: number;
}

export type BoardSpatialEventType =
  | 'human.moved_into_frame'
  | 'human.moved_out_of_frame'
  | 'human.drew_edge'
  | 'human.removed_edge'
  | 'artifact.state_changed'
  | 'artifact.control_invoked'
  | 'terminal.exited'
  | 'node.locked_changed';

export interface BoardSpatialEvent {
  type: BoardSpatialEventType | string;
  at: number;
  nodeId?: string;
  frameId?: string;
  edgeId?: string;
  agentId?: string;
  detail?: string;
  payload?: Record<string, unknown>;
}

export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt-cache hits, reported separately because they are billed cheaper. */
  cachedTokens: number;
  costUsd: number;
  rounds: number;
  durationMs: number;
}

export interface CoreEvent {
  /** Correlates with a Submission id when the event answers a request. */
  id: string | null;
  msg: EventMsg;
}
