import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import {
  BrowserWindow,
  Notification as ElectronNotification,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  net,
  protocol,
  safeStorage,
  shell
} from 'electron';
import { IPC, type CoreEvent, type EventMsg, type Submission } from '@zmtki/protocol';
import { Workspace, type SecretStore } from '@zmtki/core';
import { AppViewHost } from './appViewHost.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let workspace: Workspace | null = null;
let appViews: AppViewHost | null = null;

/**
 * Keys are encrypted with the OS keychain (DPAPI on Windows, Keychain on macOS)
 * rather than a key file next to the database, so a copied app folder does not
 * carry usable credentials.
 */
const secrets: SecretStore = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) =>
    safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(plain).toString('base64')
      : Buffer.from(plain, 'utf8').toString('base64'),
  decrypt: (cipher) => {
    const buffer = Buffer.from(cipher, 'base64');
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buffer)
      : buffer.toString('utf8');
  }
};

/**
 * Serves artifact payload files to the renderer.
 *
 * Payloads live under each board's `.zmtki/artifacts/<nodeId>/`, which the
 * renderer has no filesystem access to. A dedicated scheme keeps the content
 * security policy tight — no `file://` needed — and confines reads to the
 * artifact directory of a board that is actually open.
 */
function registerArtifactProtocol(): void {
  protocol.handle('zmtki-artifact', async (request) => {
    const url = new URL(request.url);
    const nodeId = url.hostname;
    const file = decodeURIComponent(url.pathname).replace(/^\//, '');

    if (!workspace || !nodeId || !file || file.includes('..')) {
      return new Response('not found', { status: 404 });
    }

    for (const board of workspace.state().boards) {
      const session = workspace.session(board.id);
      if (!session?.board.getNode(nodeId)) continue;
      const target = path.join(session.board.boardDir, 'artifacts', nodeId, file);
      try {
        await fs.access(target);
        return net.fetch(`file://${target.replace(/\\/g, '/')}`);
      } catch {
        return new Response('not found', { status: 404 });
      }
    }
    return new Response('not found', { status: 404 });
  });
}

/** Serves sticker pack images; CSP blocks raw file:// in the renderer. */
function registerStickerProtocol(): void {
  protocol.handle('zmtki-sticker', async (request) => {
    if (!workspace) return new Response('not found', { status: 404 });
    const url = new URL(request.url);
    const packId = decodeURIComponent(url.hostname);
    const stickerId = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!packId || !stickerId || packId.includes('..') || stickerId.includes('..')) {
      return new Response('not found', { status: 404 });
    }
    const target = workspace.resolveStickerFile(packId, stickerId);
    if (!target) return new Response('not found', { status: 404 });
    try {
      await fs.access(target);
      return net.fetch(`file://${target.replace(/\\/g, '/')}`);
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

function send(event: EventMsg, id: string | null = null): void {
  if (!window || window.isDestroyed()) return;
  const payload: CoreEvent = { id, msg: event };
  window.webContents.send(IPC.event, payload);
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0d0f14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.once('ready-to-show', () => window?.show());

  // Without this the renderer can die silently and the window just shows the
  // background colour, which looks identical to a slow start.
  window.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${source}:${line} ${message}`);
  });
  window.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[renderer] не загрузилось ${url}: ${description} (${code})`);
  });
  window.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[renderer] процесс упал: ${details.reason}`);
  });

  // Links inside artifacts open in the real browser rather than replacing the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    await window.loadURL(devUrl);
  } else {
    await window.loadFile(path.join(dirname, '../renderer/index.html'));
  }

  appViews = new AppViewHost(window, (nodeId, dataUrl) => {
    if (!window || window.isDestroyed()) return;
    window.webContents.send(IPC.appViewFrame, { nodeId, dataUrl });
  });
  workspace?.setAppViewBridge({
    listSources: () => appViews!.listSources(),
    open: (input) =>
      appViews!.open(input.nodeId, {
        mode: input.mode,
        url: input.url,
        sourceId: input.sourceId,
        sourceName: input.sourceName,
        fps: input.fps,
        live: input.live
      }),
    navigate: (nodeId, url) => appViews!.navigate(nodeId, url),
    stop: async (nodeId) => {
      appViews?.destroy(nodeId);
    }
  });
}

function createTray(): void {
  // A 1x1 transparent image keeps the tray working without shipping an icon;
  // replaced by the real asset at packaging time.
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  );
  tray = new Tray(icon);
  tray.setToolTip('Artifact Board');
  tray.on('click', () => {
    if (!window) return;
    if (window.isVisible()) window.focus();
    else window.show();
  });
}

function wireWorkspace(ws: Workspace): void {
  ws.onEvent.on((event) => send(event));

  // Only blocking notifications reach the OS; everything else stays in-app.
  ws.approvals.onRequest.on(() => {
    if (window?.isFocused()) return;
    new ElectronNotification({
      title: 'Требуется подтверждение',
      body: 'Агент ждёт вашего решения.'
    }).show();
  });
}

function registerIpc(ws: Workspace): void {
  ipcMain.handle(IPC.submit, async (_event, submission: Submission) => {
    // Live views need the BrowserWindow; core stays headless-agnostic.
    if (submission.op.type === 'browser.setBounds') {
      appViews?.setBrowserBounds(
        submission.op.nodeId,
        submission.op.bounds,
        submission.op.visible
      );
      return { ok: true, value: null };
    }
    if (submission.op.type === 'browser.navigate') {
      await appViews?.navigateBrowser(submission.op.nodeId, submission.op.url);
      return { ok: true, value: null };
    }
    if (submission.op.type === 'appView.setBounds') {
      appViews?.setBounds(submission.op.nodeId, submission.op.bounds, submission.op.visible);
      return { ok: true, value: null };
    }
    if (submission.op.type === 'appView.navigate') {
      await appViews?.navigate(submission.op.nodeId, submission.op.url);
      return { ok: true, value: null };
    }
    if (submission.op.type === 'appView.open') {
      await appViews?.open(submission.op.nodeId, {
        mode: submission.op.mode,
        url: submission.op.url,
        sourceId: submission.op.sourceId,
        sourceName: submission.op.sourceName,
        fps: submission.op.fps,
        live: submission.op.live
      });
      return { ok: true, value: null };
    }
    if (submission.op.type === 'appView.stop') {
      appViews?.destroy(submission.op.nodeId);
      return { ok: true, value: null };
    }
    if (submission.op.type === 'appView.listSources') {
      const sources = (await appViews?.listSources()) ?? [];
      return { ok: true, value: sources };
    }
    return ws.submit(submission);
  });

  ipcMain.on(IPC.push, (_event, payload: { type: string; nodeId?: string; data?: string }) => {
    if (payload.type === 'terminal.input' && payload.nodeId && payload.data !== undefined) {
      ws.terminals.write(payload.nodeId, payload.data);
    }
  });

  ipcMain.handle('zmtki:pickFolder', async () => {
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Выберите папку доски'
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle('zmtki:pickFiles', async () => {
    if (!window) return [];
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
      title: 'Прикрепить файлы'
    });
    if (result.canceled) return [];
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const out: Array<{ name: string; path: string; mime: string; size: number }> = [];
    for (const filePath of result.filePaths) {
      try {
        const stat = await fs.stat(filePath);
        const ext = pathMod.extname(filePath).toLowerCase();
        const mime =
          ext === '.png'
            ? 'image/png'
            : ext === '.jpg' || ext === '.jpeg'
              ? 'image/jpeg'
              : ext === '.gif'
                ? 'image/gif'
                : ext === '.webp'
                  ? 'image/webp'
                  : ext === '.pdf'
                    ? 'application/pdf'
                    : ext === '.md'
                      ? 'text/markdown'
                      : ext === '.txt'
                        ? 'text/plain'
                        : 'application/octet-stream';
        out.push({
          name: pathMod.basename(filePath),
          path: filePath,
          mime,
          size: stat.size
        });
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  });

  ipcMain.handle('zmtki:setSearchKey', (_event, provider: string, value: string) => {
    ws.setSearchKey(provider as 'brave' | 'tavily' | 'serper' | 'googlePse', value);
    return { ok: true };
  });

  ipcMain.handle('zmtki:openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('zmtki:revealPath', (_event, target: string) => {
    shell.showItemInFolder(target);
  });
}

// A second instance would fight over app.db and board files.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  // Must run before the app is ready, otherwise the scheme is not treated as
  // privileged and the renderer's CSP rejects it.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'zmtki-artifact',
      privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false }
    },
    {
      scheme: 'zmtki-sticker',
      privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false }
    }
  ]);

  app.whenReady().then(async () => {
    workspace = new Workspace(path.join(app.getPath('home'), '.zmtki'));
    await workspace.init(secrets);

    registerArtifactProtocol();
    registerStickerProtocol();
    await createWindow();
    workspace.setDesktopCapture(async (opts) => {
      if (!window || window.isDestroyed()) return null;
      try {
        let rect: Electron.Rectangle | undefined;
        if (opts?.scope !== 'window') {
          const bounds = (await window.webContents.executeJavaScript(`
            (() => {
              const el = document.querySelector('.react-flow') || document.querySelector('.board-canvas');
              if (!el) return null;
              const r = el.getBoundingClientRect();
              const x = Math.max(0, Math.round(r.x));
              const y = Math.max(0, Math.round(r.y));
              const width = Math.max(1, Math.round(r.width));
              const height = Math.max(1, Math.round(r.height));
              return { x, y, width, height };
            })()
          `)) as { x: number; y: number; width: number; height: number } | null;
          if (bounds) rect = bounds;
        }
        const image = rect
          ? await window.webContents.capturePage(rect)
          : await window.webContents.capturePage();
        if (image.isEmpty()) return null;
        const size = image.getSize();
        return {
          mime: 'image/png',
          base64: image.toPNG().toString('base64'),
          width: size.width,
          height: size.height
        };
      } catch (err) {
        console.error('[capture] board screenshot failed', err);
        return null;
      }
    });
    createTray();
    wireWorkspace(workspace);
    registerIpc(workspace);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Boards and the database are flushed on the way out so a close never loses
  // the last few seconds of work.
  app.on('before-quit', async (event) => {
    if (!workspace) return;
    event.preventDefault();
    const ws = workspace;
    workspace = null;
    appViews?.destroyAll();
    appViews = null;
    await ws.shutdown();
    tray?.destroy();
    app.quit();
  });
}
