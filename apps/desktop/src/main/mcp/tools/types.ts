import type { BoardsService } from '../../boards/boards.service.js';
import type { AgentService } from '../../harness/agents.js';
import type { ArrangeService } from '../../layout/arrange.service.js';
import type { SkillsService } from '../../skills/skills.service.js';

/**
 * What a tool call knows about its caller. The board comes from the agent's
 * MCP binding, never from the arguments, so an agent cannot reach a board it
 * was not placed on.
 */
export interface ToolContext {
  boardId: string;
  /** Harness making the call; empty in tests and for host-side calls. */
  agentId: string;
  boards: BoardsService;
  skills: SkillsService;
  /** Captures what the user currently sees; absent when there is no window. */
  screenshots?: ScreenshotSource;
  /** Agents on the boards: the caller's own record, its subagents, its zone. */
  agents?: AgentService;
  /** Graph layout, computed off the main thread. */
  arrange?: ArrangeService;
}

export interface ScreenshotSource {
  /** PNG data URL of a world region, or null when it is not on screen. */
  request(
    boardId: string,
    region: { x: number; y: number; width: number; height: number },
  ): Promise<string | null>;
}

export interface ToolResult {
  /** JSON-serializable payload handed back to the model. */
  data: unknown;
  /** Returned to the client as MCP image content next to the JSON. */
  image?: { dataUrl: string; caption: string };
  /** Whether the board changed, so the client can be refreshed. */
  mutated?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

export const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const num = (description: string) => ({ type: 'number', description });
export const int = (description: string) => ({ type: 'integer', description });
export const str = (description: string) => ({ type: 'string', description });
export const bool = (description: string) => ({ type: 'boolean', description });
export const enumOf = (values: readonly string[], description: string) => ({
  type: 'string',
  enum: [...values],
  description,
});
