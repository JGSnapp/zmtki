import type { Arrow, Artifact, Board, BoardSummary, Rect, Viewport, Zone } from '@zmtki/shared';
import type { BoardEvent } from '../main/boards/boards.service.js';
import type {
  CreateArrowInput,
  CreateArtifactInput,
  CreateZoneInput,
  UpdateArrowInput,
  UpdateArtifactInput,
  UpdateZoneInput,
} from '../main/boards/operations.js';

export type {
  CreateArrowInput,
  CreateArtifactInput,
  CreateZoneInput,
  UpdateArrowInput,
  UpdateArtifactInput,
  UpdateZoneInput,
};

/** Channel names shared by main and preload. `*:event` channels are pushes from main. */
export const IPC = {
  boardList: 'board:list',
  boardGet: 'board:get',
  boardCreate: 'board:create',
  boardDelete: 'board:delete',
  boardPatch: 'board:patch',
  boardViewport: 'board:viewport',
  boardBench: 'board:bench',
  boardUndo: 'board:undo',
  boardRedo: 'board:redo',
  artifactCreate: 'artifact:create',
  artifactUpdate: 'artifact:update',
  artifactDelete: 'artifact:delete',
  arrowCreate: 'arrow:create',
  arrowUpdate: 'arrow:update',
  arrowDelete: 'arrow:delete',
  zoneCreate: 'zone:create',
  zoneUpdate: 'zone:update',
  zoneDelete: 'zone:delete',
  zoneAccept: 'zone:accept',
  zoneGrow: 'zone:grow',
  zoneCarve: 'zone:carve',

  terminalStart: 'terminal:start',
  terminalAttach: 'terminal:attach',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalStop: 'terminal:stop',

  harnessList: 'harness:list',
  agentList: 'agent:list',
  agentRelease: 'agent:release',
  agentRequests: 'agent:requests',
  agentApprove: 'agent:approve',
  agentDecline: 'agent:decline',
  agentPolicy: 'agent:policy',
  agentZone: 'agent:zone',
  mcpInfo: 'mcp:info',
  settingsAll: 'settings:all',
  settingsSet: 'settings:set',
  mcpServerList: 'mcp:servers:list',
  mcpServerSetEnabled: 'mcp:servers:set-enabled',

  pickDirectory: 'dialog:pickDirectory',
  pickFiles: 'dialog:pickFiles',

  browserInfo: 'browser:info',
  browserOpen: 'browser:open',
  browserNavigate: 'browser:navigate',
  browserHistory: 'browser:history',
  browserReload: 'browser:reload',
  browserResize: 'browser:resize',
  browserStream: 'browser:stream',
  browserInput: 'browser:input',
  browserAck: 'browser:ack',
  browserClose: 'browser:close',
  browserExternal: 'browser:external',
  browserFrame: 'browser:frame',
  browserState: 'browser:state',

  appSources: 'appstream:sources',
  appFocus: 'appstream:focus',

  fileRead: 'file:read',
  fileWrite: 'file:write',
  fileStat: 'file:stat',
  fileOpen: 'file:open',
  fileReveal: 'file:reveal',
  benchReport: 'bench:report',

  boardEvent: 'board:event',
  terminalEvent: 'terminal:event',
  agentEvent: 'agent:event',
  /** Main asks the renderer where a world region is on screen. */
  locateRequest: 'screen:locate',
  locateReply: 'screen:located',
  screenCapture: 'screen:capture',
} as const;

// --- Boards -----------------------------------------------------------------

export interface CreateBoardInput {
  title?: string;
  rootDir?: string;
}

/**
 * Pushed whenever a board changes, whoever changed it. `origin` lets the
 * renderer tell an agent's edit from the echo of its own.
 */
export type { BoardEvent } from '../main/boards/boards.service.js';

// --- Terminals --------------------------------------------------------------

export interface StartTerminalInput {
  boardId: string;
  artifactId: string;
  /** Working directory; defaults to the board's rootDir, then the home dir. */
  cwd?: string;
  /** Harness to launch, or omitted for a plain shell. */
  harnessId?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalSnapshot {
  sessionId: string;
  artifactId: string;
  cols: number;
  rows: number;
  /** Scrollback replayed on attach, already trimmed to the retained window. */
  buffer: string;
  /** Characters emitted so far, including those trimmed from `buffer`. */
  offset: number;
  running: boolean;
  harnessId?: string;
  agentId?: string;
  exitCode?: number;
}

export type TerminalEvent =
  | { type: 'data'; sessionId: string; data: string; offset: number }
  | { type: 'exit'; sessionId: string; exitCode: number; signal?: number }
  | { type: 'error'; sessionId: string; message: string };

// --- Harnesses and agents ---------------------------------------------------

export interface HarnessInfo {
  id: string;
  label: string;
  /** Resolved executable, or null when the CLI is not on PATH. */
  executable: string | null;
  available: boolean;
  /** Whether this harness is wired to the board over MCP automatically. */
  mcp: boolean;
}

/**
 * A harness running on the board. `artifactId` is its terminal — the terminal
 * itself can never be collapsed into the side panel, only linked to from it.
 * `lastTarget` is where on the board it last acted, drawn as its marker.
 */
export interface AgentInfo {
  id: string;
  boardId: string;
  artifactId: string;
  harnessId: string;
  label: string;
  color: string;
  cwd: string;
  running: boolean;
  startedAt: number;
  toolCalls: number;
  lastTool?: string;
  lastToolAt?: number;
  lastTarget?: Rect;
  /** Last tool error, shown in the panel so a stuck agent is visible. */
  lastError?: string;
  /** Agent that asked for this one to be started, when it is a subagent. */
  parentId?: string;
  /** What the parent said the subagent is for. */
  purpose?: string;
  subagentIds: string[];
  /** How many subagents this agent may have at once. Zero forbids them. */
  subagentLimit: number;
  /** Whether each subagent needs the user's word before it starts. */
  requireApproval: boolean;
  /**
   * Zone the agent is bound to. While set, its placements must stay inside it;
   * to work elsewhere it asks for a zone and the user decides.
   */
  zoneId?: string;
}

/**
 * A subagent an agent wants to start, waiting for the user. Created by the
 * `agent_spawn` tool; the agent's own call waits on the answer for a while and
 * can check back later.
 */
export interface SpawnRequest {
  id: string;
  parentId: string;
  parentLabel: string;
  boardId: string;
  harnessId: string;
  purpose: string;
  cwd: string;
  createdAt: number;
}

export type AgentEvent =
  | { type: 'agent_added'; agent: AgentInfo }
  | { type: 'agent_updated'; agent: AgentInfo }
  | { type: 'agent_removed'; agentId: string }
  | { type: 'spawn_requested'; request: SpawnRequest }
  | { type: 'spawn_resolved'; requestId: string; approved: boolean };

export interface McpInfo {
  port: number;
  /** Tool names served to harnesses. */
  tools: string[];
}

/**
 * An MCP server the user can switch on for their agents, beyond the board's own.
 *
 * `available` is about this machine — what a server needs in order to run at
 * all; `enabled` is about the user's choice. A server can be wanted and not
 * runnable, and the interface says so rather than failing at launch.
 */
export interface McpServerInfo {
  id: string;
  label: string;
  hint: string;
  /** What the machine is missing, in words, when `available` is false. */
  requires: string;
  /** The command it is started with, shown so nothing runs unexplained. */
  command: string;
  available: boolean;
  enabled: boolean;
}

export interface BenchReport {
  artifacts: number;
  frames: number;
  durationMs: number;
  avgFps: number;
  p95FrameMs: number;
  maxFrameMs: number;
  maxMounted: number;
  phases: Array<{ name: string; avgFps: number; p95FrameMs: number; maxMounted: number }>;
}

// --- Browser (Google Chrome over DevTools) ------------------------------------

export interface BrowserTabState {
  artifactId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

export interface BrowserInfo {
  available: boolean;
  executable: string | null;
}

export type BrowserInput =
  | {
      kind: 'mouse';
      type: 'mousePressed' | 'mouseReleased' | 'mouseMoved';
      x: number;
      y: number;
      button: 'none' | 'left' | 'middle' | 'right';
      buttons: number;
      clickCount: number;
      modifiers: number;
    }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | {
      kind: 'key';
      type: 'keyDown' | 'keyUp' | 'rawKeyDown';
      key: string;
      code: string;
      text?: string;
      keyCode: number;
      modifiers: number;
    }
  | { kind: 'paste' }
  | { kind: 'copy' };

export interface BrowserFrame {
  artifactId: string;
  data: Uint8Array;
  width: number;
  height: number;
}

// --- Application streams ----------------------------------------------------

export interface AppSource {
  id: string;
  name: string;
  kind: 'window' | 'screen';
  /** PNG data URL, small. */
  thumbnail: string;
  icon?: string;
}

// --- Files ------------------------------------------------------------------

export interface FileStat {
  path: string;
  exists: boolean;
  size: number;
  mtime: number;
  isDirectory: boolean;
}

export interface DesktopApi {
  boards: {
    list(): Promise<BoardSummary[]>;
    get(id: string): Promise<Board | null>;
    create(input: CreateBoardInput): Promise<Board>;
    remove(id: string): Promise<void>;
    patch(id: string, patch: { title?: string; description?: string; rootDir?: string }): Promise<void>;
    setViewport(id: string, viewport: Viewport): Promise<void>;
    /** Generates a board with `count` artifacts for performance checks. */
    bench(count: number): Promise<Board>;
    /** Results arrive as a board delta event, like any other change. */
    undo(id: string): Promise<void>;
    redo(id: string): Promise<void>;
    onChanged(handler: (event: BoardEvent) => void): () => void;
  };
  artifacts: {
    create(boardId: string, input: CreateArtifactInput): Promise<Artifact>;
    update(boardId: string, id: string, patch: UpdateArtifactInput): Promise<Artifact>;
    remove(boardId: string, id: string): Promise<void>;
  };
  arrows: {
    create(boardId: string, input: CreateArrowInput): Promise<Arrow>;
    update(boardId: string, id: string, patch: UpdateArrowInput): Promise<Arrow>;
    remove(boardId: string, id: string): Promise<void>;
  };
  zones: {
    create(boardId: string, input: CreateZoneInput): Promise<Zone>;
    update(boardId: string, id: string, patch: UpdateZoneInput): Promise<Zone>;
    remove(boardId: string, id: string): Promise<void>;
    /** Accepts an agent's request: a growth request merges into its zone. */
    accept(boardId: string, id: string): Promise<Zone | null>;
    /** Adds a swept rectangle to the zone. */
    grow(boardId: string, id: string, rect: Rect): Promise<Zone>;
    /** Cuts a rectangle out; a zone with nothing left is removed. */
    carve(boardId: string, id: string, rect: Rect): Promise<Zone | null>;
  };
  terminal: {
    start(input: StartTerminalInput): Promise<TerminalSnapshot>;
    /** The live session bound to a terminal artifact, if there is one. */
    attach(artifactId: string): Promise<TerminalSnapshot | null>;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    stop(sessionId: string): Promise<void>;
    onEvent(handler: (event: TerminalEvent) => void): () => void;
  };
  harnesses: {
    list(): Promise<HarnessInfo[]>;
  };
  agents: {
    list(): Promise<AgentInfo[]>;
    release(agentId: string): Promise<void>;
    /** Subagent requests still waiting for an answer. */
    requests(): Promise<SpawnRequest[]>;
    approve(requestId: string): Promise<void>;
    decline(requestId: string, reason?: string): Promise<void>;
    /** How many subagents an agent may start, and whether it must ask first. */
    setPolicy(agentId: string, policy: { subagentLimit?: number; requireApproval?: boolean }): Promise<void>;
    /** Binds an agent to a zone, or frees it with null. */
    assignZone(agentId: string, zoneId: string | null): Promise<void>;
    onEvent(handler: (event: AgentEvent) => void): () => void;
  };
  /**
   * Preferences about the view. Kept by the main process because the renderer's
   * own storage does not survive a restart — see `SettingsService`.
   */
  settings: {
    all(): Promise<Record<string, unknown>>;
    /** Writes one and returns the whole set. */
    set(key: string, value: unknown): Promise<Record<string, unknown>>;
  };
  mcp: {
    info(): Promise<McpInfo>;
    /** Extra MCP servers on offer, with what is on right now. */
    servers(): Promise<McpServerInfo[]>;
    /** Switches one on or off; the new list comes back. Agents already running keep theirs. */
    setServerEnabled(id: string, enabled: boolean): Promise<McpServerInfo[]>;
  };
  screen: {
    /** Answers main's "where is this world region on screen" questions. */
    onLocate(handler: (region: Rect, boardId: string) => Rect | null): () => void;
    /** Captures a rectangle of this app's content in CSS pixel coordinates. */
    /**
     * A data URL of part of the window. PNG unless a JPEG is asked for: the
     * encode happens on the main process and a lossless one of a full window
     * costs about ninety milliseconds, which is worth avoiding for anything
     * that only has to look right rather than be exact.
     */
    capture(rect: Rect, options?: { format?: 'png' | 'jpeg'; quality?: number }): Promise<string | null>;
  };
  pickDirectory(): Promise<string | null>;
  pickFiles(options: { title?: string; extensions?: string[]; multiple?: boolean }): Promise<string[]>;
  browser: {
    info(): Promise<BrowserInfo>;
    open(boardId: string, artifactId: string, url: string, width: number, height: number, scale: number): Promise<BrowserTabState>;
    navigate(artifactId: string, input: string): Promise<void>;
    history(artifactId: string, direction: -1 | 1): Promise<void>;
    reload(artifactId: string): Promise<void>;
    resize(artifactId: string, width: number, height: number, scale: number): void;
    stream(artifactId: string, on: boolean): void;
    input(artifactId: string, event: BrowserInput): void;
    ack(artifactId: string): void;
    close(artifactId: string): Promise<void>;
    /** Opens the tab's page in the user's own Chrome window. */
    openExternal(artifactId: string): Promise<void>;
    onFrame(handler: (frame: BrowserFrame) => void): () => void;
    onState(handler: (state: BrowserTabState) => void): () => void;
  };
  appStream: {
    sources(): Promise<AppSource[]>;
    /** Brings the captured window to the front so the user can work in it. */
    focus(sourceId: string): Promise<boolean>;
  };
  files: {
    read(path: string): Promise<{ text: string; stat: FileStat }>;
    write(path: string, text: string): Promise<FileStat>;
    stat(path: string): Promise<FileStat>;
    open(path: string): Promise<string>;
    reveal(path: string): void;
    /** URL the renderer can load a local file from (images, video, audio). */
    url(path: string): string;
  };
  /** Absolute path of a file dropped from the OS; empty when it has none. */
  pathForFile(file: File): string;
  bench: {
    report(report: BenchReport): void;
    /** Set when the app was launched to run the benchmark and quit. */
    autorun: number;
  };
}
