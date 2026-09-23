import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

type Listener = (method: string, params: Record<string, unknown>, sessionId?: string) => void;

/** Where Google Chrome usually lives; `ZMTKI_CHROME` wins when set. */
export const findChrome = (): string | null => {
  const candidates = [
    process.env.ZMTKI_CHROME,
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One Google Chrome process shared by every browser card, driven over the
 * DevTools protocol.
 *
 * The browser on the board is the user's real Chrome engine, not an embedded
 * copy: it runs in the new headless mode — the full browser without its own
 * window — and each card is one of its tabs, streamed as frames and fed the
 * user's input. Being plain Chrome with a debugging port, the same tabs are
 * reachable by browser-use agents.
 *
 * The profile lives in the app's data directory, separate from the user's
 * everyday Chrome: logins made on the board persist between runs, and a
 * running personal Chrome never locks it.
 */
export class ChromeHost {
  private process: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<Listener>();
  userAgent = '';

  constructor(
    private readonly profileDir: string,
    readonly executable: string | null = findChrome(),
  ) {}

  get available(): boolean {
    return this.executable !== null;
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  ensure(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    if (!this.executable) throw new Error('Google Chrome не найден. Укажите путь в переменной ZMTKI_CHROME.');
    mkdirSync(this.profileDir, { recursive: true });
    const portFile = join(this.profileDir, 'DevToolsActivePort');
    rmSync(portFile, { force: true });

    this.process = spawn(
      this.executable,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        '--user-data-dir=' + this.profileDir,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        // Frames for tabs nobody looks at are still wanted when a card comes
        // back into view; the renderer stops the screencast itself instead.
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--hide-scrollbars',
        '--mute-audio',
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    this.process.once('exit', () => {
      this.process = null;
      this.socket?.close();
      this.socket = null;
    });

    let line = '';
    for (let i = 0; i < 150 && !line; i += 1) {
      await sleep(100);
      try {
        line = readFileSync(portFile, 'utf8');
      } catch {
        // Not written yet.
      }
    }
    const [port, path] = line.split(/\r?\n/);
    if (!port || !path) throw new Error('Chrome не открыл порт отладки');

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket('ws://127.0.0.1:' + port + path, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      socket.once('open', () => {
        this.socket = socket;
        resolve();
      });
      socket.once('error', reject);
      socket.on('message', (raw) => this.receive(raw.toString()));
      socket.on('close', () => {
        for (const { reject: fail } of this.pending.values()) fail(new Error('Chrome закрылся'));
        this.pending.clear();
        if (this.socket === socket) this.socket = null;
      });
    });

    const version = (await this.send('Browser.getVersion')) as { userAgent: string };
    // Headless Chrome announces itself; sites like Google treat that as a bot
    // and refuse sign-in. The engine is the same, so the announcement goes.
    this.userAgent = version.userAgent.replace('HeadlessChrome', 'Chrome');
    await this.send('Target.setDiscoverTargets', { discover: true });
  }

  private receive(text: string): void {
    const message = JSON.parse(text) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const listener of this.listeners) listener(message.method, message.params ?? {}, message.sessionId);
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Chrome не запущен'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  stop(): void {
    this.socket?.close();
    this.socket = null;
    if (this.process && !this.process.killed) this.process.kill();
    this.process = null;
  }
}
