import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { McpServerInfo } from '../../shared/ipc.js';
import { JsonStore } from '../core/store.js';

/**
 * Extra MCP servers an agent gets besides the board's own.
 *
 * The board server is not optional — it is what an agent is here for. These are
 * the rest: capabilities the user turns on, and which are then handed to every
 * harness that is launched afterwards. A harness receives them in whatever
 * shape it takes its configuration; what is stored here is the command, and the
 * translation belongs to the harness (see `registry.ts`).
 */
export interface McpServerLaunch {
  /** Name the server is registered under, which is what tool names are prefixed with. */
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpServerDefinition extends McpServerLaunch {
  label: string;
  hint: string;
  /** What it needs on the machine, in words, when it is not there. */
  requires: string;
  /** Whether the machine can actually run it right now. */
  available(): boolean;
}

/**
 * Resolves a bare command against PATH, the same way harnesses are found:
 * Electron does not run through a shell, and on Windows the real file behind
 * `npx` is `npx.cmd`.
 */
const onPath = (command: string): boolean => {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      try {
        accessSync(join(dir, command + ext.toLowerCase()), constants.X_OK);
        return true;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return false;
};

const hasNpx = (): boolean => onPath('npx');

/**
 * The catalogue.
 *
 * Everything here is launched with `npx`, so nothing has to be installed ahead
 * of time and nothing is vendored into this repository: the first run of a
 * server fetches it, later ones come from the npm cache. The cost of that is a
 * slow first launch, which is why a server is off until the user asks for it.
 */
const DEFINITIONS: McpServerDefinition[] = [
  {
    id: 'playwright',
    label: 'Playwright — браузер',
    hint: 'Агент сам открывает страницы, кликает, заполняет формы и читает текст. Ходит в тот же Chrome, что стоит на машине.',
    requires: 'Node.js с npx в PATH',
    command: 'npx',
    // `--browser chrome` uses the Chrome already on the machine instead of
    // downloading Playwright's own build on first use, which is a hundred
    // megabytes the user did not ask for.
    args: ['-y', '@playwright/mcp@latest', '--browser', 'chrome'],
    available: hasNpx,
  },
];

interface ServersData {
  /** Ids the user has switched on. Everything else is off. */
  enabled: string[];
}

/**
 * Which extra MCP servers are on, remembered between runs.
 *
 * Changing this affects agents started afterwards. A harness is handed its
 * configuration once, at launch, so an agent already running keeps the set it
 * started with — saying otherwise in the interface would be a lie.
 */
export class McpServersService {
  private readonly store: JsonStore<ServersData>;

  constructor(dataDir: string) {
    this.store = new JsonStore<ServersData>(join(dataDir, 'mcp-servers.json'), () => ({ enabled: [] }));
  }

  list(): McpServerInfo[] {
    const enabled = new Set(this.store.get().enabled);
    return DEFINITIONS.map((definition) => ({
      id: definition.id,
      label: definition.label,
      hint: definition.hint,
      requires: definition.requires,
      command: [definition.command, ...definition.args].join(' '),
      available: definition.available(),
      enabled: enabled.has(definition.id),
    }));
  }

  setEnabled(id: string, on: boolean): McpServerInfo[] {
    if (DEFINITIONS.some((definition) => definition.id === id)) {
      this.store.update((data) => {
        const set = new Set(data.enabled);
        if (on) set.add(id);
        else set.delete(id);
        data.enabled = [...set];
      });
    }
    return this.list();
  }

  /** What a harness launched right now should be given, beyond the board. */
  launches(): McpServerLaunch[] {
    const enabled = new Set(this.store.get().enabled);
    return DEFINITIONS.filter((definition) => enabled.has(definition.id) && definition.available()).map(
      ({ id, command, args, env }) => ({ id, command, args, env }),
    );
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
}
