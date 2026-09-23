import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Rect } from '@zmtki/shared';
import type {
  AgentEvent,
  BoardEvent,
  BrowserFrame,
  BrowserTabState,
  DesktopApi,
  TerminalEvent,
} from '../shared/ipc.js';
import { IPC } from '../shared/ipc.js';

/**
 * Subscribes to a push channel and hands back an unsubscribe.
 *
 * The listener is wrapped so the renderer never receives Electron's
 * `IpcRendererEvent`, whose `sender` would hand a React component a way to send
 * on arbitrary channels.
 */
const subscribe = <T,>(channel: string, handler: (payload: T) => void): (() => void) => {
  const listener = (_event: unknown, payload: T): void => {
    handler(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

const api: DesktopApi = {
  boards: {
    list: () => ipcRenderer.invoke(IPC.boardList),
    get: (id) => ipcRenderer.invoke(IPC.boardGet, id),
    create: (input) => ipcRenderer.invoke(IPC.boardCreate, input),
    remove: (id) => ipcRenderer.invoke(IPC.boardDelete, id),
    patch: (id, patch) => ipcRenderer.invoke(IPC.boardPatch, id, patch),
    setViewport: (id, viewport) => ipcRenderer.invoke(IPC.boardViewport, id, viewport),
    bench: (count) => ipcRenderer.invoke(IPC.boardBench, count),
    undo: (id) => ipcRenderer.invoke(IPC.boardUndo, id),
    redo: (id) => ipcRenderer.invoke(IPC.boardRedo, id),
    onChanged: (handler) => subscribe<BoardEvent>(IPC.boardEvent, handler),
  },
  artifacts: {
    create: (boardId, input) => ipcRenderer.invoke(IPC.artifactCreate, boardId, input),
    update: (boardId, id, patch) => ipcRenderer.invoke(IPC.artifactUpdate, boardId, id, patch),
    remove: (boardId, id) => ipcRenderer.invoke(IPC.artifactDelete, boardId, id),
  },
  arrows: {
    create: (boardId, input) => ipcRenderer.invoke(IPC.arrowCreate, boardId, input),
    update: (boardId, id, patch) => ipcRenderer.invoke(IPC.arrowUpdate, boardId, id, patch),
    remove: (boardId, id) => ipcRenderer.invoke(IPC.arrowDelete, boardId, id),
  },
  zones: {
    create: (boardId, input) => ipcRenderer.invoke(IPC.zoneCreate, boardId, input),
    update: (boardId, id, patch) => ipcRenderer.invoke(IPC.zoneUpdate, boardId, id, patch),
    remove: (boardId, id) => ipcRenderer.invoke(IPC.zoneDelete, boardId, id),
    accept: (boardId, id) => ipcRenderer.invoke(IPC.zoneAccept, boardId, id),
    grow: (boardId, id, rect) => ipcRenderer.invoke(IPC.zoneGrow, boardId, id, rect),
    carve: (boardId, id, rect) => ipcRenderer.invoke(IPC.zoneCarve, boardId, id, rect),
  },
  terminal: {
    start: (input) => ipcRenderer.invoke(IPC.terminalStart, input),
    attach: (artifactId) => ipcRenderer.invoke(IPC.terminalAttach, artifactId),
    write: (sessionId, data) => {
      ipcRenderer.send(IPC.terminalWrite, sessionId, data);
    },
    resize: (sessionId, cols, rows) => {
      ipcRenderer.send(IPC.terminalResize, sessionId, cols, rows);
    },
    stop: (sessionId) => ipcRenderer.invoke(IPC.terminalStop, sessionId),
    onEvent: (handler) => subscribe<TerminalEvent>(IPC.terminalEvent, handler),
  },
  harnesses: {
    list: () => ipcRenderer.invoke(IPC.harnessList),
  },
  agents: {
    list: () => ipcRenderer.invoke(IPC.agentList),
    release: (agentId) => ipcRenderer.invoke(IPC.agentRelease, agentId),
    requests: () => ipcRenderer.invoke(IPC.agentRequests),
    approve: (requestId) => ipcRenderer.invoke(IPC.agentApprove, requestId),
    decline: (requestId, reason) => ipcRenderer.invoke(IPC.agentDecline, requestId, reason),
    setPolicy: (agentId, policy) => ipcRenderer.invoke(IPC.agentPolicy, agentId, policy),
    assignZone: (agentId, zoneId) => ipcRenderer.invoke(IPC.agentZone, agentId, zoneId),
    onEvent: (handler) => subscribe<AgentEvent>(IPC.agentEvent, handler),
  },
  settings: {
    all: () => ipcRenderer.invoke(IPC.settingsAll),
    set: (key, value) => ipcRenderer.invoke(IPC.settingsSet, key, value),
  },
  mcp: {
    info: () => ipcRenderer.invoke(IPC.mcpInfo),
    servers: () => ipcRenderer.invoke(IPC.mcpServerList),
    setServerEnabled: (id, enabled) => ipcRenderer.invoke(IPC.mcpServerSetEnabled, id, enabled),
  },
  screen: {
    onLocate: (handler) =>
      subscribe<{ requestId: string; boardId: string; region: Rect }>(IPC.locateRequest, (request) => {
        ipcRenderer.send(IPC.locateReply, request.requestId, handler(request.region, request.boardId));
      }),
    capture: (rect, options) => ipcRenderer.invoke(IPC.screenCapture, rect, options),
  },
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  pickFiles: (options) => ipcRenderer.invoke(IPC.pickFiles, options),
  browser: {
    info: () => ipcRenderer.invoke(IPC.browserInfo),
    open: (boardId, artifactId, url, width, height, scale) =>
      ipcRenderer.invoke(IPC.browserOpen, boardId, artifactId, url, width, height, scale),
    navigate: (artifactId, input) => ipcRenderer.invoke(IPC.browserNavigate, artifactId, input),
    history: (artifactId, direction) => ipcRenderer.invoke(IPC.browserHistory, artifactId, direction),
    reload: (artifactId) => ipcRenderer.invoke(IPC.browserReload, artifactId),
    resize: (artifactId, width, height, scale) => {
      ipcRenderer.send(IPC.browserResize, artifactId, width, height, scale);
    },
    stream: (artifactId, on) => {
      ipcRenderer.send(IPC.browserStream, artifactId, on);
    },
    input: (artifactId, event) => {
      ipcRenderer.send(IPC.browserInput, artifactId, event);
    },
    ack: (artifactId) => {
      ipcRenderer.send(IPC.browserAck, artifactId);
    },
    close: (artifactId) => ipcRenderer.invoke(IPC.browserClose, artifactId),
    openExternal: (artifactId) => ipcRenderer.invoke(IPC.browserExternal, artifactId),
    onFrame: (handler) => subscribe<BrowserFrame>(IPC.browserFrame, handler),
    onState: (handler) => subscribe<BrowserTabState>(IPC.browserState, handler),
  },
  appStream: {
    sources: () => ipcRenderer.invoke(IPC.appSources),
    focus: (sourceId) => ipcRenderer.invoke(IPC.appFocus, sourceId),
  },
  files: {
    read: (path) => ipcRenderer.invoke(IPC.fileRead, path),
    write: (path, text) => ipcRenderer.invoke(IPC.fileWrite, path, text),
    stat: (path) => ipcRenderer.invoke(IPC.fileStat, path),
    open: (path) => ipcRenderer.invoke(IPC.fileOpen, path),
    reveal: (path) => {
      ipcRenderer.send(IPC.fileReveal, path);
    },
    url: (path) => 'zmtki-file://local/' + encodeURIComponent(path),
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  bench: {
    report: (report) => {
      ipcRenderer.send(IPC.benchReport, report);
    },
    autorun: Number(process.env.ZMTKI_BENCH ?? 0) || 0,
  },
};

contextBridge.exposeInMainWorld('zmtki', api);
