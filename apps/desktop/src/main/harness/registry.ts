import { accessSync, constants, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { HarnessInfo } from '../../shared/ipc.js';
import type { McpServerLaunch } from '../mcp/servers.js';

export interface HarnessLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
}

interface HarnessDefinition {
  id: string;
  label: string;
  /** Executable names to probe on PATH, first match wins. */
  commands: string[];
  /** Install locations to try when the CLI is not on PATH, most likely first. */
  knownLocations?: () => string[];
  /** True when we know how to hand this CLI our MCP endpoint per session. */
  mcp: boolean;
  /**
   * Argv and env for one session. `configPath` is a freshly written MCP config
   * file scoped to this agent — its URL carries the agent's token, so two
   * harnesses on the same board still get separate identities. `extras` are the
   * MCP servers the user switched on, which every harness declares its own way.
   */
  launch(executable: string, endpoint: string, configPath: string, extras: McpServerLaunch[]): HarnessLaunch;
}

/**
 * Resolves a bare command name against PATH.
 *
 * Electron does not run through a shell, so `claude` alone would not be found;
 * and on Windows the real file is usually `claude.cmd`, which is why PATHEXT is
 * consulted rather than assuming an extensionless binary.
 */
const resolveOnPath = (command: string): string | null => {
  const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of paths) {
    for (const ext of extensions) {
      const candidate = join(dir, command + ext.toLowerCase());
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
};

const isExecutable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where Claude Code lives when it is not on PATH: the native installer's
 * directory, and the binary bundled with the VS Code extension — newest
 * extension version first, since old ones linger after updates.
 */
const claudeLocations = (): string[] => {
  const home = homedir();
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const found = [join(home, '.local', 'bin', exe), join(home, '.claude', 'local', exe)];
  for (const editor of ['.vscode', '.cursor', '.vscode-insiders']) {
    const dir = join(home, editor, 'extensions');
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).filter((name) => name.startsWith('anthropic.claude-code-'));
    } catch {
      continue;
    }
    entries
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .forEach((name) => found.push(join(dir, name, 'resources', 'native-binary', exe)));
  }
  return found;
};

/**
 * The config file Claude Code is handed: the board, plus whatever the user
 * switched on. Extras are stdio servers, which is how the catalogue ships them.
 */
export const mcpConfig = (endpoint: string, extras: McpServerLaunch[]): string => {
  const servers: Record<string, unknown> = { board: { type: 'http', url: endpoint } };
  for (const extra of extras) {
    servers[extra.id] = { command: extra.command, args: extra.args, ...(extra.env ? { env: extra.env } : {}) };
  }
  return JSON.stringify({ mcpServers: servers }, null, 2);
};

/**
 * The same set as Codex takes it: dotted `-c` overrides rather than a file.
 * Values are TOML, so strings and arrays are written as JSON, which TOML reads.
 */
export const codexServerArgs = (extras: McpServerLaunch[]): string[] => {
  const args: string[] = [];
  for (const extra of extras) {
    const key = 'mcp_servers.' + extra.id;
    args.push('-c', key + '.command=' + JSON.stringify(extra.command));
    args.push('-c', key + '.args=' + JSON.stringify(extra.args));
    if (extra.env) args.push('-c', key + '.env=' + JSON.stringify(extra.env));
  }
  return args;
};

const codexLocations = (): string[] => {
  const home = homedir();
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const found = [join(home, '.local', 'bin', exe)];
  for (const editor of ['.vscode', '.cursor', '.vscode-insiders']) {
    const dir = join(home, editor, 'extensions');
    try {
      const entries = readdirSync(dir).filter((name) => name.startsWith('openai.chatgpt-'));
      entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const name of entries) found.push(join(dir, name, 'bin', `${platform}-${arch}`, exe));
    } catch {
      // This editor is not installed.
    }
  }
  return found;
};

const DEFINITIONS: HarnessDefinition[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    commands: ['claude'],
    knownLocations: claudeLocations,
    mcp: true,
    launch: (executable, endpoint, configPath, extras) => {
      writeFileSync(configPath, mcpConfig(endpoint, extras), 'utf8');
      return {
        file: executable,
        // --strict-mcp-config keeps the user's own global MCP servers out of
        // this session: an agent placed on a board should see the board and
        // what was switched on here, not whatever happened to be configured on
        // the machine.
        args: ['--mcp-config', configPath, '--strict-mcp-config'],
        env: { ZMTKI_BOARD_MCP: endpoint },
      };
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    commands: ['codex'],
    knownLocations: codexLocations,
    mcp: true,
    launch: (executable, endpoint, configPath, extras) => {
      writeFileSync(configPath, mcpConfig(endpoint, extras), 'utf8');
      return {
        file: executable,
        // Codex takes config overrides as dotted -c keys rather than a config
        // file, so the server is declared inline. A short developer instruction
        // makes the embedded context explicit: Codex currently exposes MCP
        // tools but does not reliably pass the server's initialize instructions
        // to the model.
        args: [
          ...codexServerArgs(extras),
          '-c',
          'mcp_servers.board.url=' + JSON.stringify(endpoint),
          '-c',
          'mcp_servers.board.default_tools_approval_mode="approve"',
          '-c',
          'developer_instructions=' +
            JSON.stringify(
              'Ты запущен внутри терминала на интерактивной доске. MCP-сервер board — твой прямой доступ к этой доске. ' +
                'Для любого запроса о доске сначала вызови board_get_region или другой инструмент board. ' +
                'Не утверждай, что доступа к доске нет, не проверив его инструментом board.',
            ),
        ],
        env: { ZMTKI_BOARD_MCP: endpoint },
      };
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    commands: ['opencode'],
    mcp: false,
    launch: (executable, endpoint) => ({
      file: executable,
      args: [],
      // No per-session MCP flag we can rely on, so the endpoint is offered
      // through the environment and the agent is told about it in the banner.
      env: { ZMTKI_BOARD_MCP: endpoint },
    }),
  },
  {
    id: 'shell',
    label: 'Терминал',
    commands: [],
    mcp: false,
    launch: (executable, endpoint) => ({ file: executable, args: [], env: { ZMTKI_BOARD_MCP: endpoint } }),
  },
];

export class HarnessRegistry {
  private readonly resolved = new Map<string, string | null>();

  /** Probes PATH once per harness and caches the answer for the session. */
  private executable(definition: HarnessDefinition): string | null {
    if (this.resolved.has(definition.id)) return this.resolved.get(definition.id) ?? null;
    let found: string | null = null;
    for (const command of definition.commands) {
      found = resolveOnPath(command);
      if (found) break;
    }
    if (!found && definition.knownLocations) {
      found = definition.knownLocations().find((candidate) => isExecutable(candidate)) ?? null;
    }
    this.resolved.set(definition.id, found);
    return found;
  }

  list(): HarnessInfo[] {
    return DEFINITIONS.filter((definition) => definition.id !== 'shell').map((definition) => {
      const executable = this.executable(definition);
      return {
        id: definition.id,
        label: definition.label,
        executable,
        available: executable !== null,
        mcp: definition.mcp,
      };
    });
  }

  find(id: string): HarnessDefinition | null {
    return DEFINITIONS.find((definition) => definition.id === id) ?? null;
  }

  /**
   * Builds the launch for a harness, or null when its CLI is not installed —
   * the caller falls back to a plain shell and says so in the terminal rather
   * than failing to create the artifact.
   */
  launch(id: string, endpoint: string, configPath: string, extras: McpServerLaunch[] = []): HarnessLaunch | null {
    const definition = this.find(id);
    if (!definition) return null;
    const executable = this.executable(definition);
    if (!executable) return null;
    return definition.launch(executable, endpoint, configPath, extras);
  }
}
