import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, nativeImage, shell } from 'electron';
import type { Rect, Viewport } from '@zmtki/shared';
import type {
  AgentEvent,
  BenchReport,
  CreateArrowInput,
  CreateArtifactInput,
  CreateBoardInput,
  CreateZoneInput,
  StartTerminalInput,
  TerminalEvent,
  UpdateArrowInput,
  UpdateArtifactInput,
  UpdateZoneInput,
} from '../shared/ipc.js';
import { IPC } from '../shared/ipc.js';
import { BoardsService } from './boards/boards.service.js';
import {
  acceptZone,
  carveZone,
  createArrow,
  createArtifact,
  createZone,
  growZone,
  deleteArrow,
  deleteArtifact,
  deleteZone,
  updateArrow,
  updateArtifact,
  updateZone,
} from './boards/operations.js';
import { writeBenchReport } from './bench.js';
import { AgentService } from './harness/agents.js';
import { BoardMcpServer } from './mcp/server.js';
import type { ScreenshotSource } from './mcp/tools/types.js';
import { SettingsService } from './core/settings.js';
import { McpServersService } from './mcp/servers.js';
import { SkillsService } from './skills/skills.service.js';
import { TerminalManager } from './terminal/manager.js';
import { ChromeHost } from './browser/chrome.js';
import { BrowserService } from './browser/service.js';
import {
  appSources,
  focusAppWindow,
  handleFileScheme,
  openFile,
  readTextFile,
  registerFileScheme,
  revealFile,
  statFile,
  writeTextFile,
} from './media.js';

const dataDir = process.env.ZMTKI_DATA_DIR || join(app.getPath('userData'), 'data');

/**
 * HTML cards render in the board's process instead of one process each.
 *
 * A card's markup is shown in an iframe with `sandbox="allow-scripts"`, and
 * current Chromium gives every sandboxed frame its own renderer. A board is
 * not a page with two or three embeds: forty of them exhausted the budget for
 * out-of-process frames, and the ones that lost went white — the cards that
 * "disappear" while the board is panned or zoomed. Measured on a board of
 * forty-two cards, a zoom left a fifth of the board white with this on and
 * effectively none of it with this off.
 *
 * What the `sandbox` attribute is for stays: the document keeps an opaque
 * origin, so it cannot reach this window's DOM, its storage or its preload
 * bridge, and it cannot navigate the board. What is given up is process-level
 * isolation between that markup and the board's own renderer — a defence
 * against a Chromium exploit rather than against the page itself.
 */
app.commandLine.appendSwitch('disable-features', 'IsolateSandboxedIframes');

registerFileScheme();

const boards = new BoardsService(dataDir);
const skills = new SkillsService(dataDir);
const mcpServers = new McpServersService(dataDir);
const settings = new SettingsService(dataDir);

let window: BrowserWindow | null = null;

/**
 * Sends to the renderer if there is one. Agents keep working while the window
 * reloads in dev, and a send to destroyed web contents throws.
 */
const push = (channel: string, payload: unknown): void => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
};

// --- Screenshots -------------------------------------------------------------

const LOCATE_TIMEOUT_MS = 1500;
const pendingLocates = new Map<string, (rect: Rect | null) => void>();

/**
 * A real capture of what the user sees. The renderer is asked where the world
 * region sits on screen; if it is fully visible, that part of the window is
 * captured. Anything else — off screen, another board open, no window — is a
 * null, and the tool falls back to its schema, saying why.
 */
const screenshots: ScreenshotSource = {
  async request(boardId, region) {
    const target = window;
    if (!target || target.isDestroyed()) return null;
    const requestId = randomUUID();
    const rect = await new Promise<Rect | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingLocates.delete(requestId);
        resolve(null);
      }, LOCATE_TIMEOUT_MS);
      pendingLocates.set(requestId, (value) => {
        clearTimeout(timer);
        pendingLocates.delete(requestId);
        resolve(value);
      });
      target.webContents.send(IPC.locateRequest, { requestId, boardId, region });
    });
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    const image = await target.webContents.capturePage({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    return image.isEmpty() ? null : image.toDataURL();
  },
};

// --- Services ----------------------------------------------------------------

const terminals = new TerminalManager((event: TerminalEvent) => {
  push(IPC.terminalEvent, event);
  if (event.type === 'exit') agents.markExited(event.sessionId);
});

const mcp = new BoardMcpServer(boards, skills, screenshots, (report) => {
  agents.noteToolCall(report);
});

const agents = new AgentService(
  boards,
  terminals,
  mcp,
  (event: AgentEvent) => {
    push(IPC.agentEvent, event);
  },
  () => mcpServers.launches(),
);
mcp.attachAgents(agents);

// --- Browser cards: Google Chrome tabs ----------------------------------------

/** Board each open tab belongs to, and the URL last written to its card. */
const browserBoards = new Map<string, { boardId: string; syncedUrl: string }>();

const browsers = new BrowserService(new ChromeHost(join(dataDir, 'chrome-profile')), {
  frame: (artifactId, data, width, height) => push(IPC.browserFrame, { artifactId, data, width, height }),
  state: (state) => push(IPC.browserState, state),
  // The page moved on its own — a link, a redirect, a search. The card keeps
  // its address so the board reopens there and agents read where it is, but
  // outside undo: Ctrl+Z is for edits, not for browsing history.
  navigated: (artifactId, url) => {
    const entry = browserBoards.get(artifactId);
    if (!entry || entry.syncedUrl === url) return;
    entry.syncedUrl = url;
    boards.observe(entry.boardId, (state) => {
      const artifact = state.artifacts.find((a) => a.id === artifactId);
      if (artifact && artifact.props.url !== url) {
        artifact.props = { ...artifact.props, url };
        artifact.updatedAt = Date.now();
      }
    });
  },
});

boards.onUpdate((event) => {
  push(IPC.boardEvent, event);
  if (event.type !== 'board_delta') return;
  // An agent or the user set a card's address: take the tab there. Addresses
  // the tab itself reported are recognised by `syncedUrl` and ignored.
  for (const { entity } of event.change.artifacts.upsert) {
    if (entity.type !== 'browser') continue;
    const entry = browserBoards.get(entity.id);
    const url = typeof entity.props.url === 'string' ? entity.props.url : '';
    if (entry && url && url !== entry.syncedUrl) {
      entry.syncedUrl = url;
      void browsers.navigate(entity.id, url).catch(() => undefined);
    }
  }
  for (const id of event.change.artifacts.remove) {
    if (browserBoards.delete(id)) void browsers.close(id);
  }
});

// End-to-end checks drive the real app and act as an agent through the real
// MCP server; they reach the services through this handle. Never set in use.
if (process.env.ZMTKI_E2E === '1') {
  (globalThis as Record<string, unknown>).__zmtki = { boards, mcp, agents };
}

const benchCount = Number(process.env.ZMTKI_BENCH ?? 0) || 0;

/**
 * The Z mark for the title bar, taskbar and Alt+Tab. Windows gets the .ico
 * with every size drawn from the artwork (scripts/build-icons.cjs); scaling one
 * large PNG down to 16 px itself, it would render the mark as a blur.
 */
const appIcon = (): Electron.NativeImage | undefined => {
  const dir = join(app.getAppPath(), 'resources');
  const files = process.platform === 'win32' ? ['icon.ico', 'icon.png'] : ['icon-512.png', 'icon.png'];
  for (const name of files) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image;
  }
  return undefined;
};

// Without an app id of its own the window is grouped on the taskbar under
// electron.exe and shows that executable's icon instead of ours.
if (process.platform === 'win32') app.setAppUserModelId('com.zmtki.desktop');

const createWindow = (): void => {
  window = new BrowserWindow({
    icon: appIcon(),
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    show: false,
    title: 'zmtki',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      // The renderer runs no Node: everything privileged goes through the
      // preload bridge, so a page shown in a webview artifact can never reach
      // the file system or a PTY.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
      // Only a benchmark needs frames from a window that is not in front; in
      // normal use a minimised board should stop rendering like any other app.
      backgroundThrottling: benchCount === 0,
    },
  });

  window.once('ready-to-show', () => {
    window?.show();
    window?.focus();
  });

  // Links to the outside world open in the user's browser, not as another
  // Electron window with our preload attached.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) {
    // The dev server can still be binding when the window opens; retry for a
    // few seconds instead of leaving an error page up.
    let attempts = 0;
    const target = window;
    target.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (!isMainFrame || !url.startsWith(devServer) || code === -3 || attempts >= 20) return;
      attempts += 1;
      setTimeout(() => {
        if (!target.isDestroyed()) void target.loadURL(devServer);
      }, 300);
    });
    void target.loadURL(devServer);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }

  // Renderer warnings and errors land in the terminal that started the app,
  // where they are seen, instead of only in a devtools window nobody opened.
  window.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 2) console.log('[renderer] ' + message + ' (' + source + ':' + line + ')');
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.log('[renderer] gone: ' + details.reason);
  });

  window.on('closed', () => {
    window = null;
  });
};

const registerIpc = (): void => {
  const handle = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void => {
    ipcMain.handle(channel, async (_event, ...args) => fn(...(args as A)));
  };

  handle(IPC.boardList, () => boards.list());
  handle(IPC.boardGet, (id: string) => {
    try {
      return boards.get(id);
    } catch {
      return null;
    }
  });
  handle(IPC.boardCreate, (input: CreateBoardInput) => boards.create(input));
  handle(IPC.boardDelete, async (id: string) => {
    const board = boards.get(id);
    // Revoke every MCP token first, including agents whose terminal artifact
    // disappeared unexpectedly, then stop any remaining plain terminals.
    for (const agent of agents.list()) if (agent.boardId === id) agents.release(agent.id);
    for (const artifact of board.state.artifacts) agents.releaseByArtifact(artifact.id);

    const closing: Promise<void>[] = [];
    for (const [artifactId, entry] of browserBoards) {
      if (entry.boardId !== id) continue;
      browserBoards.delete(artifactId);
      closing.push(browsers.close(artifactId));
    }
    await Promise.allSettled(closing);
    boards.remove(id);
  });
  // Changes return nothing: the renderer learns about them from the delta
  // event like everyone else, instead of receiving the whole board twice.
  handle(IPC.boardPatch, (id: string, patch: { title?: string; description?: string; rootDir?: string }) => {
    boards.updateMeta(id, patch);
  });
  handle(IPC.boardViewport, (id: string, viewport: Viewport) => {
    boards.setViewport(id, viewport);
  });
  handle(IPC.boardBench, (count: number) => boards.createBench(count));
  handle(IPC.boardUndo, (id: string) => {
    boards.undo(id);
  });
  handle(IPC.boardRedo, (id: string) => {
    boards.redo(id);
  });

  handle(IPC.artifactCreate, (boardId: string, input: CreateArtifactInput) =>
    boards.mutate(boardId, (state) => createArtifact(state, input)),
  );
  handle(IPC.artifactUpdate, (boardId: string, id: string, patch: UpdateArtifactInput) =>
    boards.mutate(boardId, (state) => updateArtifact(state, id, patch).artifact),
  );
  handle(IPC.artifactDelete, (boardId: string, id: string) => {
    // Deleting a terminal takes its PTY and MCP token with it, or the agent
    // would keep editing a board with no visible presence on it.
    agents.releaseByArtifact(id);
    boards.mutate(boardId, (state) => {
      deleteArtifact(state, id);
    });
  });

  handle(IPC.arrowCreate, (boardId: string, input: CreateArrowInput) =>
    boards.mutate(boardId, (state) => createArrow(state, input)),
  );
  handle(IPC.arrowUpdate, (boardId: string, id: string, patch: UpdateArrowInput) =>
    boards.mutate(boardId, (state) => updateArrow(state, id, patch)),
  );
  handle(IPC.arrowDelete, (boardId: string, id: string) => {
    boards.mutate(boardId, (state) => {
      deleteArrow(state, id);
    });
  });

  handle(IPC.zoneCreate, (boardId: string, input: CreateZoneInput) =>
    boards.mutate(boardId, (state) => createZone(state, input)),
  );
  handle(IPC.zoneUpdate, (boardId: string, id: string, patch: UpdateZoneInput) =>
    boards.mutate(boardId, (state) => updateZone(state, id, patch)),
  );
  handle(IPC.zoneDelete, (boardId: string, id: string) => {
    boards.mutate(boardId, (state) => {
      deleteZone(state, id);
    });
  });
  handle(IPC.zoneAccept, (boardId: string, id: string) => {
    const zone = boards.mutate(boardId, (state) => acceptZone(state, id));
    // A zone an agent asked for becomes that agent's working area.
    if (zone?.ownerId) agents.assignZone(zone.ownerId, zone.id);
    return zone;
  });
  handle(IPC.zoneGrow, (boardId: string, id: string, rect: Rect) =>
    boards.mutate(boardId, (state) => growZone(state, id, rect)),
  );
  handle(IPC.zoneCarve, (boardId: string, id: string, rect: Rect) =>
    boards.mutate(boardId, (state) => carveZone(state, id, rect)),
  );

  handle(IPC.agentRequests, () => agents.pendingRequests());
  handle(IPC.agentApprove, (requestId: string) => {
    agents.approve(requestId);
  });
  handle(IPC.agentDecline, (requestId: string, reason?: string) => {
    agents.decline(requestId, reason);
  });
  handle(IPC.agentPolicy, (agentId: string, policy: { subagentLimit?: number; requireApproval?: boolean }) => {
    agents.setPolicy(agentId, policy);
  });
  handle(IPC.agentZone, (agentId: string, zoneId: string | null) => {
    agents.assignZone(agentId, zoneId);
  });

  handle(IPC.terminalStart, (input: StartTerminalInput) => agents.start(input));
  handle(IPC.terminalAttach, (artifactId: string) => terminals.attachByArtifact(artifactId));
  handle(IPC.terminalStop, (sessionId: string) => {
    terminals.stop(sessionId);
  });
  // Keystrokes and resizes are fire-and-forget: a round trip per character
  // would put IPC latency into typing.
  ipcMain.on(IPC.terminalWrite, (_event, sessionId: string, data: string) => {
    terminals.write(sessionId, data);
  });
  ipcMain.on(IPC.terminalResize, (_event, sessionId: string, cols: number, rows: number) => {
    terminals.resize(sessionId, cols, rows);
  });

  handle(IPC.harnessList, () => agents.harnesses());
  handle(IPC.agentList, () => agents.list());
  handle(IPC.agentRelease, (agentId: string) => {
    agents.release(agentId);
  });
  handle(IPC.mcpInfo, () => ({ port: mcp.listeningPort, tools: mcp.toolNames }));
  handle(IPC.settingsAll, () => settings.all());
  handle(IPC.settingsSet, (key: string, value: unknown) => settings.set(key, value));
  handle(IPC.mcpServerList, () => mcpServers.list());
  handle(IPC.mcpServerSetEnabled, (id: string, enabled: boolean) => mcpServers.setEnabled(id, enabled));

  ipcMain.on(IPC.locateReply, (_event, requestId: string, rect: Rect | null) => {
    pendingLocates.get(requestId)?.(rect);
  });

  handle(IPC.screenCapture, async (rect: Rect, options?: { format?: 'png' | 'jpeg'; quality?: number }) => {
    const target = window;
    if (!target || target.isDestroyed()) return null;
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
    const bounds = target.getContentBounds();
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const width = Math.min(bounds.width - x, Math.ceil(rect.width));
    const height = Math.min(bounds.height - y, Math.ceil(rect.height));
    if (width < 2 || height < 2 || width > 4096 || height > 4096) return null;
    const image = await target.webContents.capturePage({ x, y, width, height });
    if (image.isEmpty()) return null;
    // `toDataURL` encodes PNG, and a window-sized lossless encode is the bulk
    // of what a capture costs. Callers that only need something to look at say so.
    if (options?.format === 'jpeg') {
      return 'data:image/jpeg;base64,' + image.toJPEG(options.quality ?? 72).toString('base64');
    }
    return image.toDataURL();
  });

  handle(IPC.pickFiles, async (options: { title?: string; extensions?: string[]; multiple?: boolean }) => {
    if (!window) return [];
    const result = await dialog.showOpenDialog(window, {
      title: options.title,
      properties: options.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: options.extensions?.length ? [{ name: 'Файлы', extensions: options.extensions }] : undefined,
    });
    return result.canceled ? [] : result.filePaths;
  });

  handle(IPC.browserInfo, () => ({ available: browsers.available, executable: new ChromeHost('').executable }));
  handle(IPC.browserOpen, async (boardId: string, artifactId: string, url: string, width: number, height: number, scale: number) => {
    const existing = browserBoards.get(artifactId);
    browserBoards.set(artifactId, { boardId, syncedUrl: existing?.syncedUrl ?? url });
    return browsers.open(artifactId, url, width, height, scale);
  });
  handle(IPC.browserNavigate, (artifactId: string, input: string) => browsers.navigate(artifactId, input));
  handle(IPC.browserHistory, (artifactId: string, direction: -1 | 1) => browsers.history(artifactId, direction));
  handle(IPC.browserReload, (artifactId: string) => browsers.reload(artifactId));
  handle(IPC.browserClose, async (artifactId: string) => {
    browserBoards.delete(artifactId);
    await browsers.close(artifactId);
  });
  handle(IPC.browserExternal, async (artifactId: string) => {
    const url = browsers.urlOf(artifactId);
    if (url) await shell.openExternal(url);
  });
  ipcMain.on(IPC.browserResize, (_event, artifactId: string, width: number, height: number, scale: number) => {
    void browsers.resize(artifactId, width, height, scale).catch(() => undefined);
  });
  ipcMain.on(IPC.browserStream, (_event, artifactId: string, on: boolean) => {
    void browsers.setStreaming(artifactId, on).catch(() => undefined);
  });
  ipcMain.on(IPC.browserInput, (_event, artifactId: string, input) => {
    void browsers.input(artifactId, input).catch(() => undefined);
  });
  ipcMain.on(IPC.browserAck, (_event, artifactId: string) => {
    browsers.ackFrame(artifactId);
  });

  handle(IPC.appSources, () => appSources(window?.getTitle() ?? 'zmtki'));
  handle(IPC.appFocus, (sourceId: string) => focusAppWindow(sourceId));

  handle(IPC.fileRead, (path: string) => readTextFile(path));
  handle(IPC.fileWrite, (path: string, text: string) => writeTextFile(path, text));
  handle(IPC.fileStat, (path: string) => statFile(path));
  handle(IPC.fileOpen, (path: string) => openFile(path));
  ipcMain.on(IPC.fileReveal, (_event, path: string) => {
    revealFile(path);
  });

  handle(IPC.pickDirectory, async () => {
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.on(IPC.benchReport, (_event, report: BenchReport) => {
    writeBenchReport(dataDir, report);
    if (benchCount > 0 && process.env.ZMTKI_BENCH_QUIT === '1') app.quit();
  });
};

void app.whenReady().then(async () => {
  handleFileScheme();
  await mcp.start();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  // Agents are child processes: without this they outlive the app and keep
  // holding their working directories.
  agents.releaseAll();
  terminals.stopAll();
  browsers.closeAll();
  void Promise.allSettled([boards.flush(), skills.flush(), mcp.stop()]).then(() => {
    app.quit();
  });
});
