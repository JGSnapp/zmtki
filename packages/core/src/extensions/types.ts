export type ExtensionScope = 'global' | 'board';

export interface SkillMeta {
  name: string;
  description: string;
  /** Absolute path to the skill folder. */
  dir: string;
  scope: ExtensionScope;
  /** Body without frontmatter. */
  body: string;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

export interface McpServersFile {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpServerView {
  name: string;
  scope: ExtensionScope;
  command: string;
  args: string[];
  disabled: boolean;
  status: 'stopped' | 'starting' | 'ready' | 'error';
  error: string;
  toolCount: number;
}

export interface ExtensionsSnapshot {
  skills: Array<{
    name: string;
    description: string;
    scope: ExtensionScope;
    dir: string;
  }>;
  mcpServers: McpServerView[];
}
