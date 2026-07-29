import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import { Emitter } from '../util/emitter.js';

export interface TerminalDataEvent {
  nodeId: string;
  data: string;
}

export interface TerminalExitEvent {
  nodeId: string;
  exitCode: number | null;
  scrollback: string;
}

export interface SpawnOptions {
  nodeId: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  /** Hard stop for runaway commands. */
  timeoutMs?: number;
}

interface Session {
  nodeId: string;
  child: ChildProcessWithoutNullStreams;
  scrollback: string[];
  bytes: number;
  timer: NodeJS.Timeout | null;
  finished: boolean;
}

const MAX_SCROLLBACK_BYTES = 512 * 1024;

/**
 * Runs the agent's shell commands so they are visible on the board as live
 * terminal artifacts.
 *
 * Deliberately built on `child_process` rather than a pseudo-terminal. node-pty
 * is a native module that needs a C++ toolchain on Windows, and making the
 * whole app unbuildable for that is a bad trade when agent commands are
 * non-interactive. `PtyBackend` below is the seam for adding it later; the
 * observable behaviour for callers does not change.
 */
export class TerminalManager {
  readonly onData = new Emitter<TerminalDataEvent>();
  readonly onExit = new Emitter<TerminalExitEvent>();

  private sessions = new Map<string, Session>();

  get shell(): { file: string; args: (command: string) => string[] } {
    if (process.platform === 'win32') {
      return { file: 'powershell.exe', args: (c) => ['-NoLogo', '-NoProfile', '-Command', c] };
    }
    return { file: process.env.SHELL || '/bin/bash', args: (c) => ['-lc', c] };
  }

  isRunning(nodeId: string): boolean {
    return this.sessions.has(nodeId);
  }

  spawn(options: SpawnOptions): void {
    this.kill(options.nodeId);

    const { file, args } = this.shell;
    const child = spawn(file, args(options.command), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
      windowsHide: true
    }) as ChildProcessWithoutNullStreams;

    const session: Session = {
      nodeId: options.nodeId,
      child,
      scrollback: [],
      bytes: 0,
      timer: null,
      finished: false
    };
    this.sessions.set(options.nodeId, session);

    const push = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      session.bytes += chunk.byteLength;
      session.scrollback.push(text);
      // Keep memory bounded on a command that prints forever.
      while (session.bytes > MAX_SCROLLBACK_BYTES && session.scrollback.length > 1) {
        const dropped = session.scrollback.shift();
        session.bytes -= Buffer.byteLength(dropped ?? '', 'utf8');
      }
      this.onData.emit({ nodeId: options.nodeId, data: text });
    };

    child.stdout.on('data', push);
    child.stderr.on('data', push);

    if (options.timeoutMs && options.timeoutMs > 0) {
      session.timer = setTimeout(() => {
        push(Buffer.from(`\r\n[превышен лимит времени ${options.timeoutMs} мс, процесс остановлен]\r\n`));
        this.kill(options.nodeId);
      }, options.timeoutMs);
    }

    const finish = (code: number | null): void => {
      if (session.finished) return;
      session.finished = true;
      if (session.timer) clearTimeout(session.timer);
      this.sessions.delete(options.nodeId);
      this.onExit.emit({
        nodeId: options.nodeId,
        exitCode: code,
        scrollback: session.scrollback.join('')
      });
    };

    child.on('error', (err) => {
      push(Buffer.from(`\r\n[не удалось запустить: ${err.message}]\r\n`));
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  }

  /**
   * Runs a command to completion and resolves with its output. Used by the
   * shell tool, which needs the result inline in the agent's context while the
   * same output streams to the board.
   */
  run(options: SpawnOptions): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const off = this.onExit.on((event) => {
        if (event.nodeId !== options.nodeId) return;
        off();
        resolve({ exitCode: event.exitCode, output: event.scrollback });
      });
      this.spawn(options);
    });
  }

  write(nodeId: string, data: string): void {
    const session = this.sessions.get(nodeId);
    if (!session) return;
    session.child.stdin.write(data);
  }

  /** No-op without a real PTY; kept so callers do not branch on the backend. */
  resize(_nodeId: string, _cols: number, _rows: number): void {
    void _nodeId;
    void _cols;
    void _rows;
  }

  kill(nodeId: string): void {
    const session = this.sessions.get(nodeId);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    try {
      if (process.platform === 'win32' && session.child.pid !== undefined) {
        // Killing the shell alone would orphan whatever it launched.
        spawn('taskkill', ['/pid', String(session.child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        session.child.kill('SIGTERM');
      }
    } catch {
      // Already gone.
    }
  }

  killAll(): void {
    for (const nodeId of [...this.sessions.keys()]) this.kill(nodeId);
  }

  homeDir(): string {
    return os.homedir();
  }
}
