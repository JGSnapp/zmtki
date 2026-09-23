import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { StartTerminalInput, TerminalEvent, TerminalSnapshot } from '../../shared/ipc.js';
import { loadPty, type Pty } from './pty.js';

/**
 * How long PTY output is allowed to pile up before it is forwarded.
 *
 * A build or a test run emits output in hundreds of tiny writes per second.
 * Each one crossing the IPC boundary separately costs a structured clone and a
 * React update, and the user cannot read any of it at that rate anyway. One
 * batch per frame is both cheaper and no less legible.
 */
const OUTPUT_BATCH_MS = 16;

/**
 * Scrollback kept per session, in characters.
 *
 * This is what a terminal artifact replays when it scrolls back into view or
 * the window reloads. It is capped because an agent left running for an hour
 * would otherwise hold its entire output in the main process forever.
 */
const MAX_SCROLLBACK = 200_000;

const CRLF = String.fromCharCode(13, 10);
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

interface Session {
  id: string;
  boardId: string;
  artifactId: string;
  harnessId?: string;
  agentId?: string;
  process: Pty | null;
  cols: number;
  rows: number;
  /** Retained tail of the output, already trimmed to MAX_SCROLLBACK. */
  buffer: string;
  /** Total characters ever emitted, so a reattach knows what it missed. */
  offset: number;
  pending: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  exitCode?: number;
}

type Emit = (event: TerminalEvent) => void;

/**
 * Owns every PTY process.
 *
 * Sessions outlive the artifact being visible: a terminal that scrolls off
 * screen keeps running and keeps buffering, because the whole point of putting
 * an agent on the board is that it works while the user looks elsewhere.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly emit: Emit) {}

  private static shell(): { file: string; args: string[] } {
    if (process.platform === 'win32') {
      return { file: 'powershell.exe', args: ['-NoLogo'] };
    }
    return { file: process.env.SHELL || '/bin/bash', args: ['-l'] };
  }

  private snapshot(session: Session): TerminalSnapshot {
    return {
      sessionId: session.id,
      artifactId: session.artifactId,
      cols: session.cols,
      rows: session.rows,
      buffer: session.buffer,
      offset: session.offset,
      running: session.running,
      harnessId: session.harnessId,
      agentId: session.agentId,
      exitCode: session.exitCode,
    };
  }

  private append(session: Session, chunk: string): void {
    session.offset += chunk.length;
    session.buffer += chunk;
    if (session.buffer.length > MAX_SCROLLBACK) {
      session.buffer = session.buffer.slice(session.buffer.length - MAX_SCROLLBACK);
    }
    session.pending.push(chunk);
    if (session.flushTimer) return;
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null;
      const data = session.pending.join('');
      session.pending.length = 0;
      if (data.length > 0) {
        this.emit({ type: 'data', sessionId: session.id, data, offset: session.offset });
      }
    }, OUTPUT_BATCH_MS);
  }

  /**
   * Starts a PTY. `command` overrides the plain shell — that is how a harness
   * is launched, with its MCP configuration already in `env`.
   */
  async start(
    input: StartTerminalInput,
    launch?: { file: string; args: string[]; env?: Record<string, string> },
    agentId?: string,
  ): Promise<TerminalSnapshot> {
    const loaded = await loadPty();
    const cols = input.cols ?? DEFAULT_COLS;
    const rows = input.rows ?? DEFAULT_ROWS;
    const command: { file: string; args: string[]; env?: Record<string, string> } =
      launch ?? TerminalManager.shell();

    const session: Session = {
      id: randomUUID(),
      boardId: input.boardId,
      artifactId: input.artifactId,
      harnessId: input.harnessId,
      agentId,
      process: null,
      cols,
      rows,
      buffer: '',
      offset: 0,
      pending: [],
      flushTimer: null,
      running: false,
    };
    this.sessions.set(session.id, session);

    if (!loaded.binding) {
      this.append(session, (loaded.reason ?? 'PTY недоступен') + CRLF);
      return this.snapshot(session);
    }

    try {
      const child = loaded.binding.spawn(command.file, command.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: input.cwd || homedir(),
        env: { ...process.env, TERM: 'xterm-256color', ...(command.env ?? {}) } as Record<string, string>,
      });
      session.process = child;
      session.running = true;

      child.onData((data) => {
        this.append(session, data);
      });
      child.onExit(({ exitCode, signal }) => {
        session.running = false;
        session.exitCode = exitCode;
        session.process = null;
        this.emit({ type: 'exit', sessionId: session.id, exitCode, signal });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.running = false;
      // Report through the buffer as well, so the failure is visible in the
      // terminal artifact itself and not only in a toast the user may miss.
      this.append(session, 'Не удалось запустить процесс: ' + message + '\r\n');
      this.emit({ type: 'error', sessionId: session.id, message });
    }

    return this.snapshot(session);
  }

  attach(sessionId: string): TerminalSnapshot | null {
    const session = this.sessions.get(sessionId);
    return session ? this.snapshot(session) : null;
  }

  /** The session bound to a board artifact, if it is still around. */
  attachByArtifact(artifactId: string): TerminalSnapshot | null {
    for (const session of this.sessions.values()) {
      if (session.artifactId === artifactId) return this.snapshot(session);
    }
    return null;
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.process?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const safeCols = Math.max(2, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    if (session.cols === safeCols && session.rows === safeRows) return;
    session.cols = safeCols;
    session.rows = safeRows;
    try {
      session.process?.resize(safeCols, safeRows);
    } catch {
      // Racing a process that exited between the check and the call. The
      // session is about to be marked dead by onExit anyway.
    }
  }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    try {
      session.process?.kill();
    } catch {
      // Already gone.
    }
    session.running = false;
    this.sessions.delete(sessionId);
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }
}
