import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { Artifact } from '@zmtki/shared';
import { useEffect, useRef, useState } from 'react';
import type { TerminalEvent, TerminalSnapshot } from '../../../shared/ipc';
import { api, useStore } from '../state/store';

type Handler = (event: TerminalEvent) => void;

/**
 * One IPC subscription for every terminal on the board, fanned out by session.
 * A listener per artifact would have main's pushes walk N callbacks each.
 */
const handlers = new Map<string, Handler>();
let subscribed = false;
const onSession = (sessionId: string, handler: Handler): (() => void) => {
  if (!subscribed) {
    subscribed = true;
    api.terminal.onEvent((event) => handlers.get(event.sessionId)?.(event));
  }
  handlers.set(sessionId, handler);
  return () => {
    if (handlers.get(sessionId) === handler) handlers.delete(sessionId);
  };
};

/**
 * A terminal created moments ago starts on its own. One that comes back after
 * the app restarted waits for a click: relaunching an agent in a folder the
 * user may have moved on from is not something to do behind their back.
 */
const AUTOSTART_WINDOW_MS = 15_000;

interface Props {
  artifact: Artifact;
  boardId: string;
  selected: boolean;
  /** Settled board zoom, clamped by the canvas. */
}

const BASE_FONT = 13;

export const TerminalArtifact = ({ artifact, boardId, selected }: Props) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TerminalSnapshot | null>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'exited' | 'waiting'>('idle');
  const harnessId = typeof artifact.props.harnessId === 'string' ? artifact.props.harnessId : '';
  const cwd = typeof artifact.props.cwd === 'string' ? artifact.props.cwd : '';
  const agent = useStore((s) => s.agents.find((a) => a.artifactId === artifact.id));
  const moving = useStore((s) => s.view?.moving === true);
  const movingRef = useRef(moving);
  const harness = useStore((s) => s.harnesses.find((h) => h.id === harnessId));

  const bindSession = (snapshot: TerminalSnapshot, term: Terminal): (() => void) => {
    sessionRef.current = snapshot;
    term.reset();
    if (snapshot.buffer) term.write(snapshot.buffer);
    setStatus(snapshot.running ? 'running' : 'exited');
    return onSession(snapshot.sessionId, (event) => {
      if (event.type === 'data') writeOut(term, event.data);
      else if (event.type === 'exit') setStatus('exited');
    });
  };

  /**
   * Output while the board is being scrolled is held, not written.
   *
   * A working agent prints continuously, and every write parses the stream and
   * repaints the terminal. That happens on the same thread that moves the
   * board, so scrolling past a busy terminal stuttered. Held output is written
   * in one go the moment the camera stops, which is also cheaper than the same
   * bytes in sixty pieces.
   */
  const heldRef = useRef<string[]>([]);

  // Camera stopped: everything held goes in at once.
  useEffect(() => {
    movingRef.current = moving;
    if (moving || heldRef.current.length === 0) return;
    const term = termRef.current;
    const held = heldRef.current.join('');
    heldRef.current = [];
    term?.write(held);
  }, [moving]);

  const writeOut = (term: Terminal, data: string) => {
    if (movingRef.current) {
      heldRef.current.push(data);
      return;
    }
    term.write(data);
  };

  const start = async (term: Terminal): Promise<(() => void) | null> => {
    const fit = fitRef.current;
    const dims = fit?.proposeDimensions();
    const snapshot = await api.terminal.start({
      boardId,
      artifactId: artifact.id,
      harnessId: harnessId || undefined,
      cwd: cwd || undefined,
      cols: dims?.cols,
      rows: dims?.rows,
    });
    return bindSession(snapshot, term);
  };

  const unbindRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: BASE_FONT,
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: {
        background: '#0b0d11',
        foreground: '#d7dae0',
        cursor: '#ff7a3d',
        selectionBackground: '#5a3322',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      // WebGL keeps a busy agent's output off the main thread's layout path;
      // the DOM renderer remains as the fallback when a context is refused.
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // DOM renderer it is.
    }
    termRef.current = term;
    fitRef.current = fit;
    fit.fit();

    const input = term.onData((data) => {
      const session = sessionRef.current;
      if (session) api.terminal.write(session.sessionId, data);
    });

    let disposed = false;
    void (async () => {
      const existing = await api.terminal.attach(artifact.id);
      if (disposed) return;
      if (existing) {
        unbindRef.current = bindSession(existing, term);
      } else if (Date.now() - artifact.createdAt < AUTOSTART_WINDOW_MS) {
        unbindRef.current = await start(term);
      } else {
        setStatus('waiting');
      }
    })();

    // Fitting reads layout, so it is coalesced to a frame; the PTY is resized
    // only when the character grid actually changed. The observed element is
    // the unscaled container, so a zoom — which changes the font, not the
    // card — never refits and never makes a running TUI redraw.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        fit.fit();
        const session = sessionRef.current;
        if (session) api.terminal.resize(session.sessionId, term.cols, term.rows);
      });
    });
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      input.dispose();
      unbindRef.current?.();
      term.dispose();
      termRef.current = null;
    };
    // The terminal is created once per artifact; props changes do not recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.id]);

  useEffect(() => {
    if (selected) termRef.current?.focus();
  }, [selected]);

  /*
   * The terminal is drawn once, at its own size, and the board's transform
   * scales it like any other card.
   *
   * It used to be re-laid at every settled zoom — a larger font, a re-measured
   * grid, a full repaint — to keep the text crisp at one device pixel per CSS
   * pixel. What that cost was visible: after each zoom the terminal blinked and
   * its contents changed size, which is the opposite of a card that simply got
   * bigger. Sharpness at deep zoom is worth less than a card that stays put.
   */

  const restart = async () => {
    const term = termRef.current;
    if (!term) return;
    unbindRef.current?.();
    // An exited agent is released first, so the panel does not keep a dead
    // entry next to the new one.
    const old = sessionRef.current;
    if (agent) await api.agents.release(agent.id);
    else if (old) await api.terminal.stop(old.sessionId);
    sessionRef.current = null;
    unbindRef.current = await start(term);
  };

  const stop = async () => {
    if (agent) await api.agents.release(agent.id);
    else if (sessionRef.current) await api.terminal.stop(sessionRef.current.sessionId);
    setStatus('exited');
  };

  const title = agent?.label ?? harness?.label ?? (harnessId ? harnessId : 'Терминал');

  return (
    <div className="terminal-artifact" style={agent ? { ['--agent' as string]: agent.color } : undefined}>
      <div className="terminal-bar" data-drag-handle="true">
        <span className={'terminal-dot terminal-dot--' + status} />
        <span className="terminal-title">{title}</span>
        {agent && (
          <span className="terminal-meta">
            MCP · {agent.toolCalls} {agent.lastTool ? '· ' + agent.lastTool : ''}
          </span>
        )}
        {!agent && cwd && <span className="terminal-meta">{cwd}</span>}
        <span className="terminal-spacer" />
        {status === 'running' && (
          <button className="chip" onPointerDown={(e) => e.stopPropagation()} onClick={() => void stop()}>
            Стоп
          </button>
        )}
        {(status === 'exited' || status === 'waiting') && (
          <button className="chip" onPointerDown={(e) => e.stopPropagation()} onClick={() => void restart()}>
            {status === 'waiting' ? 'Запустить' : 'Перезапустить'}
          </button>
        )}
      </div>
      <div
        ref={containerRef}
        className="terminal-host"
        data-interactive="true"
        onWheel={(e) => {
          // A selected terminal scrolls its own buffer; otherwise the wheel
          // belongs to the board.
          if (selected) e.stopPropagation();
        }}
      >
        <div
          ref={hostRef}
          className="terminal-scaled"
          style={{
            width: '100%',
            height: '100%',
            padding: '6px 0 0 8px',
          }}
        />
      </div>
      {status === 'waiting' && (
        <div className="terminal-overlay">
          <div>Сессия не запущена после перезапуска приложения.</div>
          <button className="btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => void restart()}>
            Запустить {title}
          </button>
        </div>
      )}
    </div>
  );
};
