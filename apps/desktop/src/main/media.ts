import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { desktopCapturer, net, protocol, shell } from 'electron';
import type { AppSource, FileStat } from '../shared/ipc.js';

export const FILE_SCHEME = 'zmtki-file';

/**
 * Must run before `app.ready`. Local files are served to the renderer through
 * their own scheme rather than `file://`: the dev renderer is an http page that
 * may not load file URLs, and a dedicated scheme can stream video with range
 * requests the same in dev and in a packaged build.
 */
export const registerFileScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    { scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
};

export const handleFileScheme = (): void => {
  protocol.handle(FILE_SCHEME, (request) => {
    const encoded = new URL(request.url).pathname.replace(/^\//, '');
    const path = decodeURIComponent(encoded);
    return net.fetch(pathToFileURL(path).toString(), { headers: request.headers });
  });
};

export const statFile = async (path: string): Promise<FileStat> => {
  try {
    const s = await fs.stat(path);
    return { path, exists: true, size: s.size, mtime: s.mtimeMs, isDirectory: s.isDirectory() };
  } catch {
    return { path, exists: false, size: 0, mtime: 0, isDirectory: false };
  }
};

/** Text editors refuse files this large rather than freeze the board on them. */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

export const readTextFile = async (path: string): Promise<{ text: string; stat: FileStat }> => {
  const stat = await statFile(path);
  if (!stat.exists) throw new Error('Файл не найден: ' + path);
  if (stat.isDirectory) throw new Error('Это папка: ' + path);
  if (stat.size > MAX_TEXT_BYTES) throw new Error('Файл больше 5 МБ — откройте его во внешнем редакторе');
  return { text: await fs.readFile(path, 'utf8'), stat };
};

/** Written through a temp file and a rename, so a crash never leaves half a file. */
export const writeTextFile = async (path: string, text: string): Promise<FileStat> => {
  const tmp = path + '.zmtki-tmp';
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, path);
  return statFile(path);
};

export const openFile = (path: string): Promise<string> => shell.openPath(path);

export const revealFile = (path: string): void => {
  shell.showItemInFolder(path);
};

/** Windows and screens that can be streamed onto the board, our own window left out. */
export const appSources = async (ownTitle: string): Promise<AppSource[]> => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((source) => source.name && source.name !== ownTitle)
    .map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
      icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : undefined,
    }));
};

const FOCUS_SCRIPT = `
param([long]$Handle)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ZmtkiWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@
$h = [IntPtr]$Handle
if ([ZmtkiWin]::IsIconic($h)) { [void][ZmtkiWin]::ShowWindow($h, 9) }
[ZmtkiWin]::SetForegroundWindow($h)
`;

/**
 * Brings a streamed window to the front. A stream is a picture; to type into
 * the application the user switches to it, and this saves finding it among
 * the open windows. Source ids of windows carry the native handle.
 */
export const focusAppWindow = (sourceId: string): Promise<boolean> => {
  const match = /^window:(\d+):/.exec(sourceId);
  if (!match || process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '& {' + FOCUS_SCRIPT + '} -Handle ' + match[1]],
      { windowsHide: true, timeout: 8000 },
      (error, stdout) => resolve(!error && /True/.test(stdout)),
    );
  });
};
