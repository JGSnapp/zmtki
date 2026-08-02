import type { Agent } from '@zmtki/board-schema';
import type { ToolCallView } from '@zmtki/protocol';
import type { BoardStore } from '../board/BoardStore.js';
import type { ToolSchema } from '../llm/types.js';

export interface ApprovalAsk {
  kind: 'exec' | 'write' | 'network' | 'crossBoardWrite';
  title: string;
  detail: string;
  subject: string;
}

/**
 * Everything a tool is allowed to reach. Passing a single context object keeps
 * tools decoupled from how the runtime is wired, which is what lets them be
 * registered from separate modules.
 */
export interface ToolContext {
  agent: Agent;
  board: BoardStore;
  boardPath: string;
  turnId: string;
  signal: AbortSignal;
  services: ToolServices;
  /** Streams intermediate progress for long-running calls. */
  progress(text: string): void;
  /** Resolves false when the human denies; tools must respect that. */
  requestApproval(ask: ApprovalAsk): Promise<boolean>;
}

/** Late-bound so tool modules do not import the runtime and create a cycle. */
export interface ToolServices {
  search: {
    search(query: string, limit?: number): Promise<{
      results: Array<{ title: string; url: string; snippet: string; source: string }>;
      provider: string;
      attempts: Array<{ provider: string; error: string }>;
    }>;
  };
  terminal: {
    run(options: {
      nodeId: string;
      command: string;
      cwd: string;
      timeoutMs?: number;
    }): Promise<{ exitCode: number | null; output: string }>;
  };
  rooms: {
    send(input: {
      roomId: string;
      agentId: string;
      body: string;
      mentions?: string[];
      artifactRefs?: Array<{ boardId: string; nodeId: string }>;
      parentMessageId?: string | null;
    }): Promise<{ ok: boolean; error?: string }>;
    history(roomId: string, limit: number): Array<{ author: string; body: string; createdAt: number }>;
    listForAgent(agentId: string): Array<{ id: string; title: string; kind: string; members: string[] }>;
    yieldTo(roomId: string, agentId: string, nextSpeaker: string): Promise<{ ok: boolean; error?: string }>;
  };
  directory: {
    search(query: string): Array<{
      agentId: string;
      name: string;
      handle: string;
      boardName: string;
      boardId: string;
      persona: string;
    }>;
    get(agentId: string): { agentId: string; name: string; boardId: string; boardPath: string } | undefined;
  };
  boards: {
    /** Read-only projection of an artifact on another board. */
    readRemoteArtifact(
      boardId: string,
      nodeId: string
    ): Promise<{ title: string; summary: string; boardName: string } | undefined>;
  };
  comments: {
    reply(boardId: string, threadId: string, agentId: string, body: string): Promise<void>;
    listForAgent(boardId: string, agentId: string): Array<{
      threadId: string;
      nodeId: string;
      comments: Array<{ author: string; body: string }>;
    }>;
  };
  boardEvents?: {
    subscribe(
      boardId: string,
      agentId: string,
      event: string,
      filter?: Record<string, unknown>
    ): Promise<void>;
    unsubscribe(boardId: string, agentId: string, event: string): Promise<void>;
  };
  stickers?: {
    list(): Array<{
      id: string;
      name: string;
      scope: 'global' | 'board';
      stickers: Array<{ id: string; emoji?: string }>;
    }>;
    place(input: {
      boardId: string;
      packId: string;
      stickerId: string;
      agentId?: string;
      relativeTo?: string;
      relation?: string;
      position?: { x: number; y: number };
    }): Promise<{ ok: boolean; nodeId?: string; error?: string }>;
  };
  delegate?: {
    run(input: {
      parent: Agent;
      brief: string;
      contextNodeIds: string[];
    }): Promise<{ summary: string; error?: string }>;
  };
  desktop?: {
    /** PNG/JPEG of the visible board viewport for vision. */
    captureBoard(opts?: { scope?: 'viewport' | 'window' }): Promise<{
      mime: string;
      base64: string;
      width?: number;
      height?: number;
    } | null>;
  };
  /** Live web / headless / OS-window surfaces hosted by Electron main. */
  appView?: {
    listSources(): Promise<
      Array<{ id: string; name: string; kind: 'window' | 'screen'; thumbnailDataUrl: string }>
    >;
    open(input: {
      nodeId: string;
      mode: 'web' | 'headless' | 'mirror';
      url?: string;
      sourceId?: string;
      sourceName?: string;
      fps?: number;
      live?: boolean;
    }): Promise<void>;
    navigate(nodeId: string, url: string): Promise<void>;
    stop(nodeId: string): Promise<void>;
  };
}

export interface ToolImage {
  mime: string;
  base64: string;
}

export interface ToolResult {
  /** Text placed into the model's context as the tool result. */
  content: string;
  /** Node the call created or changed, so the UI can offer a jump link. */
  nodeId?: string | null;
  isError?: boolean;
  /** Vision payloads — appended as a user multimodal message after the tool result. */
  images?: ToolImage[];
}

export interface ToolDefinition {
  name: string;
  toolset: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Read-only tools may run concurrently within one round. Anything that
   * mutates the board, the filesystem or a room runs serially.
   */
  readOnly: boolean;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

class Registry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`инструмент уже зарегистрирован: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  forToolsets(toolsets: readonly string[]): ToolDefinition[] {
    const allowed = new Set(toolsets);
    return this.all().filter((t) => allowed.has(t.toolset));
  }

  schemasFor(toolsets: readonly string[]): ToolSchema[] {
    return this.forToolsets(toolsets).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));
  }
}

export const toolRegistry = new Registry();

export function defineTool(tool: ToolDefinition): void {
  toolRegistry.register(tool);
}

/** Shorthand for the common JSON Schema object shape. */
export function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

export function str(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'string', description, ...extra };
}

export function num(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'number', description, ...extra };
}

export function bool(description: string): Record<string, unknown> {
  return { type: 'boolean', description };
}

export function toolCallView(
  id: string,
  name: string,
  args: string,
  status: ToolCallView['status']
): ToolCallView {
  return { id, name, args, status };
}
