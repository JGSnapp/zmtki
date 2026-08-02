import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type CoreEvent, type Op, type OpResult } from '@zmtki/protocol';

let counter = 0;

/**
 * The renderer's entire access to the system. Node stays out of the renderer,
 * so a malicious HTML widget rendered on the board cannot reach the filesystem.
 */
const api = {
  submit<T = unknown>(op: Op): Promise<OpResult<T>> {
    counter += 1;
    return ipcRenderer.invoke(IPC.submit, { id: `sub_${counter}`, op }) as Promise<OpResult<T>>;
  },

  /** Fire-and-forget path for keystrokes, which are too frequent to await. */
  push(payload: { type: string; nodeId?: string; data?: string }): void {
    ipcRenderer.send(IPC.push, payload);
  },

  onEvent(handler: (event: CoreEvent) => void): () => void {
    const listener = (_e: unknown, payload: CoreEvent): void => handler(payload);
    ipcRenderer.on(IPC.event, listener);
    return () => ipcRenderer.removeListener(IPC.event, listener);
  },

  /** JPEG/PNG frames for appView headless/mirror (and web when overlay is off). */
  onAppViewFrame(handler: (payload: { nodeId: string; dataUrl: string }) => void): () => void {
    const listener = (_e: unknown, payload: { nodeId: string; dataUrl: string }): void =>
      handler(payload);
    ipcRenderer.on(IPC.appViewFrame, listener);
    return () => ipcRenderer.removeListener(IPC.appViewFrame, listener);
  },

  pickFolder(): Promise<string | null> {
    return ipcRenderer.invoke('zmtki:pickFolder') as Promise<string | null>;
  },

  pickFiles(): Promise<Array<{ name: string; path: string; mime: string; size: number }>> {
    return ipcRenderer.invoke('zmtki:pickFiles') as Promise<
      Array<{ name: string; path: string; mime: string; size: number }>
    >;
  },

  setSearchKey(provider: string, value: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('zmtki:setSearchKey', provider, value) as Promise<{ ok: boolean }>;
  },

  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke('zmtki:openExternal', url) as Promise<void>;
  },

  revealPath(target: string): Promise<void> {
    return ipcRenderer.invoke('zmtki:revealPath', target) as Promise<void>;
  }
};

contextBridge.exposeInMainWorld('zmtki', api);

export type ZmtkiApi = typeof api;
