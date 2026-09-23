import { agentTools } from './agents.tools.js';
import { arrangeTools } from './arrange.tools.js';
import { arrowTools } from './arrow.tools.js';
import { artifactTools } from './artifact.tools.js';
import { buttonTools } from './button.tools.js';
import { layoutTools } from './layout.tools.js';
import { perceptionTools } from './perception.tools.js';
import { skillTools } from './skills.tools.js';
import { zoneTools } from './zones.tools.js';
import type { ToolSpec } from './types.js';

/** Every tool a harness can call over MCP. Add a module here to extend them. */
export const ALL_TOOLS: ToolSpec[] = [
  ...skillTools,
  ...perceptionTools,
  ...artifactTools,
  ...arrowTools,
  ...layoutTools,
  ...arrangeTools,
  ...buttonTools,
  ...zoneTools,
  ...agentTools,
];

export class ToolRegistry {
  private readonly byName: Map<string, ToolSpec>;

  constructor(private readonly tools: ToolSpec[] = ALL_TOOLS) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  get(name: string): ToolSpec | undefined {
    return this.byName.get(name);
  }

  all(): ToolSpec[] {
    return this.tools;
  }
}

export type { ToolContext, ToolResult, ToolSpec } from './types.js';
