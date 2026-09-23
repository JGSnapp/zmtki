import type { Artifact } from '@zmtki/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserFrame, BrowserInput, BrowserTabState } from '../../../shared/ipc';
import { fitSite } from './site';
import { api, useStore } from '../state/store';

type FrameHandler = (frame: BrowserFrame) => void;
type StateHandler = (state: BrowserTabState) => void;

/** One subscription per channel for every browser card, fanned out by artifact. */
const frameHandlers = new Map<string, FrameHandler>();
const stateHandlers = new Map<string, StateHandler>();
let subscribed = false;
const ensureSubscribed = () => {
  if (subscribed) return;
  subscribed = true;
  api.browser.onFrame((frame) => frameHandlers.get(frame.artifactId)?.(frame));
  api.browser.onState((state) => stateHandlers.get(state.artifactId)?.(state));
};

const modifiersOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

const BUTTONS = ['left', 'middle', 'right'] as const;

const BAR_HEIGHT = 36;

interface Props {
  artifact: Artifact;
  boardId: string;
  selected: boolean;
  visible: boolean;
  renderScale: number;
}

/**
 * A Google Chrome tab on the board.
 *
 * The page is rendered by the user's installed Chrome and arrives as frames;
 * the card draws them on a canvas and sends the pointer and keyboard back.
 * Nothing of the page runs in the board's process, so a heavy site cannot
 * stall panning, and the card is exactly what Chrome shows.
 */
export const BrowserArtifact = ({ artifact, boardId, selected, visible, renderScale }: Props) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<BrowserTabState | null>(null);
  const [address, setAddress] = useState('');
  const [editingAddress, setEditingAddress] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const openRef = useRef(false);
  /** What the card wants right now, readable from callbacks that outlive a render. */
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const url = typeof artifact.props.url === 'string' ? artifact.props.url : '';
  const id = artifact.id;
  // The stream is rendered for this display, not for the board's zoom: tying it
  // to the zoom re-sized the tab after every gesture, and the page redrew.
  const scale = Math.min(3, Math.max(0.5, window.devicePixelRatio || 1));
  void renderScale;

  /**
   * The viewport the tab is told to be, which is not the size of the card: a
   * site laid out at a card's width collapses into its phone layout. The frames
   * come back at this size and the canvas stretches them into the card — see
   * `fitSite`.
   */
  const applyStream = useCallback(() => {
    if (openRef.current) api.browser.stream(id, visibleRef.current);
  }, [id]);

  const sizeOf = () => {
    const el = surfaceRef.current;
    const fit = fitSite(el?.offsetWidth ?? artifact.width, el?.offsetHeight ?? artifact.height - BAR_HEIGHT);
    return { width: fit.page, height: fit.pageHeight };
  };

  // Open the tab once; frames and state are routed here from then on.
  useEffect(() => {
    ensureSubscribed();
    let cancelled = false;
    let drawing = false;
    frameHandlers.set(id, (frame) => {
      if (drawing) return;
      // While the board is being scrolled the page is a picture sliding past:
      // decoding it costs a JPEG decode and a full-size draw per frame on the
      // thread that moves the board. The frame is dropped and acknowledged, so
      // the stream keeps flowing and the next one arrives once the board stops.
      if (movingRef.current) {
        api.browser.ack(id);
        return;
      }
      drawing = true;
      void createImageBitmap(new Blob([frame.data as BlobPart], { type: 'image/jpeg' }))
        .then((bitmap) => {
          const canvas = canvasRef.current;
          if (canvas) {
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
            }
            canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
            setHasFrame(true);
          }
          bitmap.close();
        })
        .catch(() => undefined)
        .finally(() => {
          drawing = false;
          api.browser.ack(id);
        });
    });
    stateHandlers.set(id, (next) => setState(next));

    void (async () => {
      const info = await api.browser.info();
      if (cancelled) return;
      if (!info.available) {
        setUnavailable('Google Chrome не найден на компьютере. Установите Chrome или укажите путь в переменной ZMTKI_CHROME.');
        return;
      }
      try {
        const { width, height } = sizeOf();
        const opened = await api.browser.open(boardId, id, url || 'https://www.google.com/', width, height, scale);
        if (cancelled) return;
        openRef.current = true;
        setState(opened);
        applyStream();
      } catch (error) {
        setUnavailable('Не удалось запустить Chrome: ' + (error instanceof Error ? error.message : String(error)));
      }
    })();

    return () => {
      cancelled = true;
      frameHandlers.delete(id);
      stateHandlers.delete(id);
      if (openRef.current) api.browser.stream(id, false);
    };
    // The tab lives as long as the card; props changes reach it through main.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // The camera's state, read once per change and kept in a ref: the frame
  // handler runs outside React and must not be re-created for it.
  const movingRef = useRef(false);
  movingRef.current = useStore((s) => s.view?.moving === true);

  /**
   * Frames only while the card is on screen.
   *
   * Asked for through a ref rather than from the effect's own closure. Opening
   * a tab is a round trip to Chrome, and a card that came on screen while that
   * was in flight lost its request twice over: the effect ran before the tab
   * existed and did nothing, and the open finished with the visibility captured
   * when the card mounted — false. Nothing changed after that, so the effect
   * never ran again and the card sat on "Chrome is opening…" for ever.
   */
  useEffect(() => {
    applyStream();
  }, [applyStream, visible]);

  // The tab follows the card's size and the board's zoom (sharp when zoomed in).
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    let frame = 0;
    const push = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!openRef.current) return;
        const { width, height } = sizeOf();
        api.browser.resize(id, width, height, scale);
      });
    };
    const observer = new ResizeObserver(push);
    observer.observe(el);
    push();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, scale]);

  useEffect(() => {
    if (!editingAddress) setAddress(state?.url ?? url);
  }, [state?.url, url, editingAddress]);

  useEffect(() => {
    if (selected) canvasRef.current?.focus({ preventScroll: true });
  }, [selected]);

  // --- Input ----------------------------------------------------------------

  const send = (event: BrowserInput) => api.browser.input(id, event);

  const pagePoint = (clientX: number, clientY: number) => {
    const el = canvasRef.current;
    const rect = el?.getBoundingClientRect();
    if (!el || !rect || rect.width === 0) return { x: 0, y: 0 };
    // Screen pixels → the page's CSS pixels, whatever the board zoom and
    // whatever the card was shrunk by. Measured against the viewport the tab
    // was given rather than the canvas on screen: those are no longer the same
    // number, and using the canvas put every click at a fraction of where the
    // user aimed.
    const page = sizeOf();
    return {
      x: ((clientX - rect.left) / rect.width) * page.width,
      y: ((clientY - rect.top) / rect.height) * page.height,
    };
  };

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || !selected) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return; // board zoom stays on Ctrl+wheel
      e.preventDefault();
      e.stopPropagation();
      const p = pagePoint(e.clientX, e.clientY);
      const unit = e.deltaMode === 1 ? 40 : 1;
      send({ kind: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX * unit, deltaY: e.deltaY * unit, modifiers: modifiersOf(e) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, id]);

  const moveFrame = useRef(0);
  const pendingMove = useRef<BrowserInput | null>(null);

  const mouse = (e: React.MouseEvent, type: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => {
    if (!selected) return;
    const p = pagePoint(e.clientX, e.clientY);
    const event: BrowserInput = {
      kind: 'mouse',
      type,
      x: p.x,
      y: p.y,
      button: type === 'mouseMoved' ? (e.buttons & 1 ? 'left' : 'none') : (BUTTONS[e.button] ?? 'left'),
      buttons: e.buttons,
      clickCount: type === 'mouseMoved' ? 0 : Math.max(1, e.detail),
      modifiers: modifiersOf(e),
    };
    if (type !== 'mouseMoved') {
      send(event);
      return;
    }
    // Moves are coalesced to a frame; presses and releases go at once.
    pendingMove.current = event;
    if (moveFrame.current) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = 0;
      if (pendingMove.current) send(pendingMove.current);
      pendingMove.current = null;
    });
  };

  const key = (e: React.KeyboardEvent, down: boolean) => {
    if (!selected) return;
    e.preventDefault();
    e.stopPropagation();
    const mod = e.ctrlKey || e.metaKey;
    if (down && mod && e.key.toLowerCase() === 'v') {
      send({ kind: 'paste' });
      return;
    }
    if (down && mod && e.key.toLowerCase() === 'c') {
      send({ kind: 'copy' });
      return;
    }
    const printable = e.key.length === 1 && !mod;
    send({
      kind: 'key',
      type: down ? (printable ? 'keyDown' : 'rawKeyDown') : 'keyUp',
      key: e.key,
      code: e.code,
      text: down && printable ? e.key : down && e.key === 'Enter' ? '\r' : undefined,
      keyCode: e.keyCode,
      modifiers: modifiersOf(e),
    });
  };

  const host = (() => {
    try {
      return new URL(state?.url || url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();

  return (
    <div className="artifact-web browser-card">
      <div className="browser-bar" data-drag-handle="true">
        <span className="chrome-badge" title="Google Chrome">
          <span className="chrome-dot" />
        </span>
        <button className="icon-btn" disabled={!state?.canGoBack} onPointerDown={(e) => e.stopPropagation()} onClick={() => void api.browser.history(id, -1)}>
          ‹
        </button>
        <button className="icon-btn" disabled={!state?.canGoForward} onPointerDown={(e) => e.stopPropagation()} onClick={() => void api.browser.history(id, 1)}>
          ›
        </button>
        <button className={'icon-btn' + (state?.loading ? ' is-loading' : '')} onPointerDown={(e) => e.stopPropagation()} onClick={() => void api.browser.reload(id)}>
          ↻
        </button>
        <form
          className="browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            setEditingAddress(false);
            (document.activeElement as HTMLElement | null)?.blur();
            void api.browser.navigate(id, address);
          }}
        >
          <input
            value={editingAddress ? address : address}
            placeholder="Поиск в Google или адрес"
            title={state?.title}
            onPointerDown={(e) => e.stopPropagation()}
            onFocus={(e) => {
              setEditingAddress(true);
              e.currentTarget.select();
            }}
            onBlur={() => setEditingAddress(false)}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur();
            }}
          />
        </form>
        <button className="icon-btn" title="Открыть в Chrome" onPointerDown={(e) => e.stopPropagation()} onClick={() => void api.browser.openExternal(id)}>
          ⧉
        </button>
      </div>
      <div ref={surfaceRef} className="browser-surface-wrap">
        <canvas
          ref={canvasRef}
          className="browser-surface"
          tabIndex={0}
          onMouseDown={(e) => {
            if (!selected) return;
            e.currentTarget.focus({ preventScroll: true });
            mouse(e, 'mousePressed');
          }}
          onMouseUp={(e) => mouse(e, 'mouseReleased')}
          onMouseMove={(e) => mouse(e, 'mouseMoved')}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => key(e, true)}
          onKeyUp={(e) => key(e, false)}
        />
        {!hasFrame && !unavailable && <div className="browser-loading">Chrome открывает {host || 'страницу'}…</div>}
        {unavailable && <div className="browser-loading browser-error">{unavailable}</div>}
        {!selected && hasFrame && <div className="browser-hint">Кликните, чтобы работать со страницей</div>}
      </div>
    </div>
  );
};
