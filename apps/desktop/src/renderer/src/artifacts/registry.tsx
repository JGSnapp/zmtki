import type { Artifact, ArtifactType, DetailLevel } from '@zmtki/shared';
import { artifactDefinition } from '@zmtki/shared';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import cssLang from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import jsonLang from 'highlight.js/lib/languages/json';
import markdownLang from 'highlight.js/lib/languages/markdown';
import pythonLang from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import 'highlight.js/styles/github-dark.css';
import { createElement, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileStat } from '../../../shared/ipc';
import { fitSite } from './site';
import { api, useStore } from '../state/store';
import { AppStreamArtifact } from './AppStreamArtifact';
import { BrowserArtifact } from './BrowserArtifact';
import { CodeEditor } from './CodeEditor';
import { EditableText } from './EditableText';
import { TerminalArtifact } from './TerminalArtifact';

for (const [name, lang] of Object.entries({
  bash, cpp, csharp, css: cssLang, go, java, javascript, json: jsonLang, markdown: markdownLang,
  python: pythonLang, rust, sql, typescript, xml, yaml,
})) {
  hljs.registerLanguage(name, lang);
}
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python',
  sh: 'bash', shell: 'bash', ps1: 'bash', html: 'xml', htm: 'xml', svg: 'xml', md: 'markdown', yml: 'yaml',
  cs: 'csharp', 'c++': 'cpp', c: 'cpp', h: 'cpp', rs: 'rust',
};

export interface ArtifactViewProps {
  artifact: Artifact;
  boardId: string;
  selected: boolean;
  /** On screen now. Live cards pause their streams when not. */
  visible: boolean;
  level: DetailLevel;
  /** Settled board zoom, for renderers that draw their own pixels. */
  renderScale: number;
  onPatch: (props: Record<string, unknown>) => void;
}

export interface ArtifactKind {
  render: (props: ArtifactViewProps) => ReactNode;
  /**
   * The body handles its own pointer input once the artifact is selected —
   * a page, a stream, an editor. Unselected, the whole card drags, so the
   * first click on a page never gets swallowed by the page.
   */
  interactive?: boolean;
  /** Draws its own frame; the canvas adds no card chrome around it. */
  bare?: boolean;
}

const str = (props: Record<string, unknown>, key: string, fallback = ''): string => {
  const value = props[key];
  return typeof value === 'string' ? value : fallback;
};

const num = (props: Record<string, unknown>, key: string, fallback: number): number => {
  const value = props[key];
  return typeof value === 'number' ? value : fallback;
};

const stop = { onPointerDown: (e: React.PointerEvent) => e.stopPropagation() };

const fileName = (path: string): string => path.split(/[\\/]/).pop() || path;

/** A card source that can be a link, a data URL or a path on this computer. */
export const mediaSrc = (src: string): string => {
  if (!src) return '';
  if (/^(https?|data|blob|zmtki-file):/i.test(src)) return src;
  if (/^[a-z]:[\\/]/i.test(src) || src.startsWith('/') || src.startsWith('\\\\')) return api.files.url(src);
  return src;
};

export const MEDIA_EXTENSIONS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'],
};

/** Empty media and web cards ask for their source: a link, or a file from disk. */
const SourcePrompt = ({
  label,
  placeholder = 'https://…',
  extensions,
  onSubmit,
}: {
  label: string;
  placeholder?: string;
  extensions?: string[];
  onSubmit: (value: string) => void;
}) => {
  const [value, setValue] = useState('');
  return (
    <form
      className="url-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <span>{label}</span>
      <input {...stop} value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      {extensions && (
        <button
          type="button"
          className="chip"
          {...stop}
          onClick={async () => {
            const [path] = await api.pickFiles({ extensions });
            if (path) onSubmit(path);
          }}
        >
          Выбрать файл…
        </button>
      )}
    </form>
  );
};

const CardTitle = ({ children }: { children: ReactNode }) => (
  <div className="card-title" data-drag-handle="true">
    {children}
  </div>
);

// --- Text --------------------------------------------------------------------

const NoteView = ({ artifact, onPatch }: ArtifactViewProps) => (
  <div className={'artifact-note note-' + str(artifact.props, 'color', 'yellow')}>
    <EditableText value={str(artifact.props, 'text')} placeholder="Заметка" markdown onCommit={(text) => onPatch({ text })} />
  </div>
);

const TextView = ({ artifact, onPatch }: ArtifactViewProps) => (
  <EditableText
    value={str(artifact.props, 'text')}
    placeholder="Текст"
    className="artifact-plain-text"
    markdown
    style={{
      fontSize: num(artifact.props, 'fontSize', 24),
      fontWeight: num(artifact.props, 'weight', 600),
      textAlign: str(artifact.props, 'align', 'left') as 'left',
      color: str(artifact.props, 'color', '#e8e8ea'),
    }}
    onCommit={(text) => onPatch({ text })}
  />
);

const MarkdownView = ({ artifact, onPatch, selected }: ArtifactViewProps) => (
  <div className="artifact-scroll" onWheel={(e) => selected && e.stopPropagation()}>
    {artifact.type === 'document' && (
      <CardTitle>
        <EditableText value={str(artifact.props, 'title')} placeholder="Без названия" onCommit={(title) => onPatch({ title })} />
      </CardTitle>
    )}
    <EditableText value={str(artifact.props, 'text')} placeholder="Markdown" markdown onCommit={(text) => onPatch({ text })} />
  </div>
);

/** Read-only code with highlighting; the language comes from props or is detected. */
const CodeView = ({ artifact, selected }: ArtifactViewProps) => {
  const code = str(artifact.props, 'code');
  const requested = str(artifact.props, 'language').toLowerCase();
  const language = LANGUAGE_ALIASES[requested] ?? requested;
  const highlighted = useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      return hljs.highlightAuto(code).value;
    } catch {
      return null;
    }
  }, [code, language]);
  return (
    <div className="artifact-code">
      <CardTitle>
        <span className="lang">{requested || 'code'}</span> {str(artifact.props, 'title')}
      </CardTitle>
      <pre className="hljs" onWheel={(e) => selected && e.stopPropagation()}>
        {highlighted !== null ? <code dangerouslySetInnerHTML={{ __html: highlighted }} /> : <code>{code}</code>}
      </pre>
    </div>
  );
};

// --- Web ---------------------------------------------------------------------

/**
 * A still of an embedded document, kept beside the live one.
 *
 * A sandboxed srcdoc iframe and a `<webview>` are both out-of-process frames:
 * their pixels are produced by another frame tree and reach the compositor late
 * while an ancestor's transform changes every frame. What shows until they
 * arrive is the frame's white background — the flash.
 *
 * What a still must not be is expensive. The first attempt gave every card an
 * `<img>` holding a PNG of the entire window, so a board of forty pages
 * composited forty window-sized bitmaps on every frame of a pan — more work
 * than the pages it was hiding, which is why the board got slower rather than
 * smoother. Each card now owns a canvas the size of the card, cropped out of
 * one shared capture of the board, and nothing is ever encoded: no PNG, no
 * base64, no per-card decode.
 */
interface BoardFrame {
  bitmap: ImageBitmap;
  rect: { x: number; y: number; width: number; height: number };
  /** Captured pixels per CSS pixel, so the crop is right at any display scale. */
  scale: number;
  /** Board furniture standing over the cards, which no still may copy. */
  obstacles: Array<{ left: number; top: number; right: number; bottom: number }>;
}

interface StillCard {
  /** True when the still is missing, or too small for how big the card now is. */
  wants(): boolean;
  draw(frame: BoardFrame): void;
}

const stillCards = new Set<StillCard>();

/**
 * Bumped whenever the camera starts moving. A capture is a round trip through
 * the main process; if the board moved while it was in flight, the pixels no
 * longer line up with any card and the whole frame is thrown away.
 */
let cameraEpoch = 0;
let refreshing = false;
let refreshTimer = 0;
let stillsBound = false;

const captureBoardFrame = async (): Promise<BoardFrame | null> => {
  const viewport = document.querySelector<HTMLElement>('.board-viewport:not(.is-moving)');
  if (!viewport) return null;
  const bounds = viewport.getBoundingClientRect();
  const rect = { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
  if (rect.width < 2 || rect.height < 2) return null;
  // A lossy still is indistinguishable at a glance and roughly halves what a
  // capture costs, most of it the encode on the main process.
  const url = await api.screen.capture(rect, { format: 'jpeg', quality: 78 });
  if (!url) return null;
  // Decoded through an image element rather than `fetch`: the page's own CSP
  // allows `data:` for images and not for connections.
  const image = new Image();
  image.src = url;
  await image.decode();
  const bitmap = await createImageBitmap(image);
  const obstacles = [...document.querySelectorAll('.hud')].map((el) => {
    const box = el.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  });
  return { bitmap, rect, scale: bitmap.width / rect.width, obstacles };
};

/**
 * One capture for the whole board, cropped into every card that asked for it.
 *
 * Capturing per card put a board with a few dozen pages seconds deep in a GPU
 * readback queue, and most cards had no still at all by the time motion began.
 */
const refreshStills = async (): Promise<void> => {
  if (refreshing) {
    scheduleStills(220);
    return;
  }
  const wanted = [...stillCards].filter((card) => card.wants());
  if (wanted.length === 0) return;
  refreshing = true;
  const epoch = cameraEpoch;
  try {
    const frame = await captureBoardFrame();
    if (!frame) return;
    if (epoch === cameraEpoch) for (const card of wanted) card.draw(frame);
    frame.bitmap.close();
  } catch {
    // A capture can fail while the window is hidden or being resized. The
    // stills already in hand stay as they are.
  } finally {
    refreshing = false;
  }
};

function scheduleStills(delay = 160): void {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    void refreshStills();
  }, delay);
}

/** One listener for the whole board rather than one per card. */
const bindStills = (): void => {
  if (stillsBound) return;
  stillsBound = true;
  window.addEventListener('zmtki:camera-move', () => {
    cameraEpoch += 1;
  });
  window.addEventListener('zmtki:camera-rest', () => void refreshStills());
};

const drawStill = (
  surface: HTMLElement | null,
  canvas: HTMLCanvasElement | null,
  frame: BoardFrame,
  takenAt: { current: number },
): void => {
  if (!surface || !canvas) return;
  const box = surface.getBoundingClientRect();
  if (box.width < 8 || box.height < 8) return;

  /*
   * The whole card, or nothing.
   *
   * A partial still was the wrong kind of generous. The part the capture did
   * not reach stays transparent, and since the live document is hidden behind
   * a still for the length of a gesture, that transparent part showed as a
   * dark rectangle sitting inside the card and sliding out of it as the board
   * moved. A card that was only half on screen is simply left alone until it
   * is fully on screen, which the next gesture usually arranges.
   */
  const edge = 1;
  if (
    box.left < frame.rect.x - edge ||
    box.top < frame.rect.y - edge ||
    box.right > frame.rect.x + frame.rect.width + edge ||
    box.bottom > frame.rect.y + frame.rect.height + edge
  ) {
    return;
  }
  // Nor anything with the board's own furniture drawn over it: a still is a
  // picture of the window, and a card under the zoom controls would keep a
  // copy of them.
  for (const over of frame.obstacles) {
    if (box.left < over.right && box.right > over.left && box.top < over.bottom && box.bottom > over.top) return;
  }

  const context = canvas.getContext('2d');
  if (!context) return;
  const scale = frame.scale;
  const width = Math.max(1, Math.round(box.width * scale));
  const height = Math.max(1, Math.round(box.height * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  } else {
    context.clearRect(0, 0, width, height);
  }
  context.drawImage(
    frame.bitmap,
    Math.round((box.left - frame.rect.x) * scale),
    Math.round((box.top - frame.rect.y) * scale),
    width,
    height,
    0,
    0,
    width,
    height,
  );
  takenAt.current = box.width;
  // Only now may the document underneath be taken out of the picture for the
  // length of a gesture: there is a whole card to put in its place.
  surface.classList.add('has-still');
};

/** A reloaded document is no longer what the still shows. */
const clearStill = (canvas: HTMLCanvasElement | null): void => {
  if (!canvas) return;
  canvas.parentElement?.classList.remove('has-still');
  canvas.width = 0;
  canvas.height = 0;
};

/**
 * A card's markup, made into a page that fits the card.
 *
 * Agents hand in a fragment far more often than a whole document — one `<div>`
 * sized `width:100%;height:100%` and styled to be the card. Dropped into an
 * iframe as it stands, that fragment gets the browser's default page around it:
 * an 8px body margin and a white canvas. The margin is the white border seen
 * around every card, and it is also what pushes the 100%-tall content past the
 * viewport and raises a scrollbar inside a card that has nothing to scroll.
 *
 * The page is painted the board's own colour rather than left transparent.
 * Transparent looks right until you measure it: a sandboxed frame has an opaque
 * origin, and Chromium composites one over a white base background of its own,
 * which no CSS on the embedding element can reach. A card that rounds its
 * corners more than the board rounds its cards — most of them do — was showing
 * pure white in the gap, measured at rgb(255,255,255) three pixels in.
 *
 * The colour is read from the theme rather than written twice, so the page a
 * fragment gets and the board it sits on cannot drift apart.
 *
 * A whole document is left exactly as written. An agent that sent `<!doctype>`
 * has said what it wants the page to be.
 */
const DOCUMENT_START = /^\s*(?:<!doctype\b|<html[\s>]|<body[\s>])/i;

/** The board's own background and text colours, straight from the stylesheet. */
let theme: { canvas: string; text: string } | null = null;
const boardTheme = (): { canvas: string; text: string } => {
  if (!theme) {
    const style = getComputedStyle(document.documentElement);
    theme = {
      canvas: style.getPropertyValue('--canvas').trim() || '#12141a',
      text: style.getPropertyValue('--text').trim() || '#d7dae0',
    };
  }
  return theme;
};

const asDocument = (markup: string): string => {
  if (DOCUMENT_START.test(markup)) return markup;
  const { canvas, text } = boardTheme();
  return (
    '<!doctype html><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;width:100%;height:100%;background:' +
    canvas +
    ';color:' +
    text +
    ';font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    // A card is already a frame; a scrollbar inside one is chrome nobody asked
    // for. Scrolling still works for a card whose content really is long.
    'html{scrollbar-width:none}::-webkit-scrollbar{width:0;height:0}' +
    '</style>' +
    markup
  );
};

const HtmlView = ({ artifact, selected, onPatch }: ArtifactViewProps) => {
  const markup = str(artifact.props, 'html');
  const page = useMemo(() => asDocument(markup), [markup]);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const stillRef = useRef<HTMLCanvasElement>(null);
  /** Card width the still was taken at, so one that grew gets a sharper one. */
  const takenAt = useRef(0);

  useEffect(() => {
    bindStills();
    const card: StillCard = {
      wants: () => {
        const surface = surfaceRef.current;
        if (!surface) return false;
        const box = surface.getBoundingClientRect();
        if (box.width < 8 || box.height < 8) return false;
        // A card that only shrank keeps its still: it is drawn smaller, which
        // is free and looks right. Re-capturing every card after every gesture
        // is what the board could not afford.
        return takenAt.current === 0 || box.width > takenAt.current * 1.7;
      },
      draw: (frame) => drawStill(surfaceRef.current, stillRef.current, frame, takenAt),
    };
    stillCards.add(card);
    return () => {
      stillCards.delete(card);
    };
  }, []);

  if (!markup) {
    return (
      <div className="empty-card">
        <CardTitle>{artifactDefinition(artifact.type).label}</CardTitle>
        <EditableText value="" placeholder="двойной клик — вставить HTML" onCommit={(value) => onPatch({ html: value })} />
      </div>
    );
  }
  return (
    <div ref={surfaceRef} className="artifact-html-surface">
      <iframe
        className="artifact-frame"
        title={artifact.id}
        // Scripts run, but in an opaque origin: no cookies, no storage, no parent.
        sandbox="allow-scripts"
        srcDoc={page}
        style={{ pointerEvents: selected ? 'auto' : 'none' }}
        onLoad={() => {
          // A reload replaces the document, so whatever the still shows is no
          // longer this page.
          takenAt.current = 0;
          clearStill(stillRef.current);
          scheduleStills();
        }}
      />
      <canvas ref={stillRef} className="embed-still" aria-hidden="true" />
    </div>
  );
};

/** Electron's `<webview>` — a page to read on the board, in its own process. */
const WebviewView = ({ artifact, selected, visible, onPatch }: ArtifactViewProps) => {
  const url = str(artifact.props, 'url');
  const viewRef = useRef<Electron.WebviewTag>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState({ width: 0, height: 0 });
  const [snapshot, setSnapshot] = useState('');
  /** Card width the still was taken at; zero means there is no still yet. */
  const takenAt = useRef(0);
  const busy = useRef(false);

  /**
   * Unlike an HTML card, a guest is captured from its own contents rather than
   * from the window, so where it sits on the board does not matter — only that
   * it has something painted.
   */
  const capture = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !visible || busy.current) return;
    if (typeof view.isLoading !== 'function' || view.isLoading()) return;
    const viewport = view.closest('.board-viewport');
    if (viewport?.classList.contains('is-moving') || viewport?.classList.contains('is-gesturing')) return;
    const box = view.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) return;
    busy.current = true;
    try {
      const image = await view.capturePage();
      if (viewRef.current !== view || image.isEmpty()) return;
      takenAt.current = box.width;
      setSnapshot(image.toDataURL());
    } catch {
      // Navigation can replace the guest while capturePage is in flight. Keep
      // the preceding good frame until the next successful capture.
    } finally {
      busy.current = false;
    }
  }, [visible]);

  // The card's own box, which decides how much the page has to shrink by.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setSurface((current) => (current.width === width && current.height === height ? current : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let timer = 0;
    const queue = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        void capture();
      }, delay);
    };
    // The document changed, so the still no longer shows it.
    const onLoaded = () => {
      takenAt.current = 0;
      queue(120);
    };
    /**
     * A gesture on its own is no reason to capture again — the still is the
     * same page. Re-taking one per card after every gesture is what turned a
     * board of pages into a queue of screen readbacks. Only a card that has no
     * still, or one that has grown enough for its still to look soft, asks.
     */
    const onRest = () => {
      const box = view.getBoundingClientRect();
      if (box.width < 8) return;
      if (takenAt.current === 0 || box.width > takenAt.current * 1.4) queue(120);
    };
    const observer = new ResizeObserver(() => onRest());

    view.addEventListener('dom-ready', onLoaded);
    view.addEventListener('did-stop-loading', onLoaded);
    view.addEventListener('did-navigate-in-page', onLoaded);
    window.addEventListener('zmtki:camera-rest', onRest);
    observer.observe(view);
    queue(160);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      view.removeEventListener('dom-ready', onLoaded);
      view.removeEventListener('did-stop-loading', onLoaded);
      view.removeEventListener('did-navigate-in-page', onLoaded);
      window.removeEventListener('zmtki:camera-rest', onRest);
    };
  }, [capture, url]);

  if (!url) return <SourcePrompt label="Адрес страницы" onSubmit={(value) => onPatch({ url: /^https?:/.test(value) ? value : 'https://' + value })} />;
  // The guest lays out at a desktop width, then the whole thing is scaled into
  // the card — see `fitSite`.
  const { page, pageHeight, scale } = fitSite(surface.width, surface.height);
  return (
    <div className="artifact-web">
      <CardTitle>{str(artifact.props, 'title') || url}</CardTitle>
      <div ref={surfaceRef} className="artifact-webview-surface">
        {surface.width > 0 &&
          createElement('webview', {
            ref: viewRef,
            src: url,
            partition: 'persist:web',
            className: 'artifact-webview',
            style: {
              width: page,
              height: pageHeight,
              transform: scale === 1 ? undefined : 'scale(' + scale + ')',
              transformOrigin: '0 0',
              pointerEvents: selected ? 'auto' : 'none',
            },
          })}
        {snapshot && <img className="embed-still" src={snapshot} alt="" draggable={false} />}
      </div>
    </div>
  );
};

// --- Media -------------------------------------------------------------------

const ImageView = ({ artifact, onPatch }: ArtifactViewProps) => {
  const src = str(artifact.props, 'src');
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src) return <SourcePrompt label="Изображение: ссылка или файл" extensions={MEDIA_EXTENSIONS.image} onSubmit={(value) => onPatch({ src: value })} />;
  if (failed) return <SourcePrompt label={'Не открылось: ' + fileName(src)} extensions={MEDIA_EXTENSIONS.image} onSubmit={(value) => onPatch({ src: value })} />;
  return (
    <img
      className="artifact-image"
      src={mediaSrc(src)}
      alt={str(artifact.props, 'alt')}
      draggable={false}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      style={{ objectFit: str(artifact.props, 'fit', 'contain') as 'contain' }}
    />
  );
};

const VideoView = ({ artifact, selected, visible, onPatch }: ArtifactViewProps) => {
  const src = str(artifact.props, 'src');
  const ref = useRef<HTMLVideoElement>(null);
  // A video scrolled off screen stops playing rather than decode for nobody.
  useEffect(() => {
    if (!visible) ref.current?.pause();
  }, [visible]);
  if (!src) return <SourcePrompt label="Видео: ссылка или файл" extensions={MEDIA_EXTENSIONS.video} onSubmit={(value) => onPatch({ src: value })} />;
  return (
    <div className="artifact-media">
      <CardTitle>▶ {str(artifact.props, 'title') || fileName(src)}</CardTitle>
      <video ref={ref} className="artifact-video" src={mediaSrc(src)} controls preload="metadata" style={{ pointerEvents: selected ? 'auto' : 'none' }} />
    </div>
  );
};

const AudioView = ({ artifact, selected, onPatch }: ArtifactViewProps) => {
  const src = str(artifact.props, 'src');
  return (
    <div className="artifact-audio">
      <CardTitle>♪ {str(artifact.props, 'title') || (src ? fileName(src) : 'Аудио')}</CardTitle>
      {src ? (
        <audio src={mediaSrc(src)} controls preload="metadata" style={{ pointerEvents: selected ? 'auto' : 'none' }} {...stop} />
      ) : (
        <SourcePrompt label="Аудио: ссылка или файл" extensions={MEDIA_EXTENSIONS.audio} onSubmit={(value) => onPatch({ src: value })} />
      )}
    </div>
  );
};

// --- Live --------------------------------------------------------------------

const TerminalView = ({ artifact, boardId, selected }: ArtifactViewProps) => (
  <TerminalArtifact artifact={artifact} boardId={boardId} selected={selected} />
);

const BrowserView = ({ artifact, boardId, selected, visible, renderScale }: ArtifactViewProps) => (
  <BrowserArtifact artifact={artifact} boardId={boardId} selected={selected} visible={visible} renderScale={renderScale} />
);

const AppStreamView = ({ artifact, selected, visible, onPatch }: ArtifactViewProps) => (
  <AppStreamArtifact artifact={artifact} selected={selected} visible={visible} onPatch={onPatch} />
);

// --- Interactive -------------------------------------------------------------

const ButtonView = ({ artifact }: ArtifactViewProps) => {
  const notify = useStore((s) => s.notify);
  const [pressed, setPressed] = useState(false);
  const [asking, setAsking] = useState(false);
  const props = artifact.props;
  const action = str(props, 'action');
  const target = str(props, 'target');
  const note = str(props, 'note');
  // Buttons from before actions had a kind, and hand-made ones, are read from
  // the action itself: a link opens, anything else goes to a terminal.
  const kind = (str(props, 'actionKind') || (/^https?:\/\//.test(action) ? 'url' : 'command')) as
    | 'url'
    | 'command'
    | 'agent';
  // An agent may leave a button here, but never a press: anything it wrote that
  // runs somewhere asks first, and the user sees the whole action before saying yes.
  const needsConfirm = props.confirm === true || (kind !== 'url' && !!str(props, 'createdBy'));

  const perform = async () => {
    setPressed(true);
    window.setTimeout(() => setPressed(false), 400);
    if (kind === 'url') {
      window.open(action, '_blank');
      return;
    }
    if (kind === 'agent') {
      const agent = useStore.getState().agents.find((a) => a.id === target);
      if (!agent) {
        notify('Субагент не найден — возможно, он уже завершён');
        return;
      }
      const session = await api.terminal.attach(agent.artifactId);
      if (!session) {
        notify('Терминал субагента закрыт');
        return;
      }
      api.terminal.write(session.sessionId, action + '\r');
      return;
    }
    const session = target ? await api.terminal.attach(target) : null;
    if (!session) {
      notify('Команда «' + action + '»: выберите терминал в свойствах кнопки');
      return;
    }
    api.terminal.write(session.sessionId, action + '\r');
  };

  const press = () => {
    if (!action) {
      notify('Задайте кнопке действие в панели «Свойства»');
      return;
    }
    if (needsConfirm && !asking) {
      setAsking(true);
      return;
    }
    setAsking(false);
    void perform();
  };

  return (
    <div className="artifact-button-wrap" {...stop}>
      <button
        className={'artifact-button' + (pressed ? ' is-pressed' : '') + (asking ? ' is-asking' : '')}
        title={action}
        onClick={press}
      >
        {str(props, 'label', 'Кнопка')}
      </button>
      {note && !asking && <span className="button-note">{note}</span>}
      {asking && (
        <div className="button-confirm">
          <span className="button-what">
            {kind === 'agent' ? 'Отправить субагенту: ' : 'Выполнить: '}
            <code>{action}</code>
          </span>
          <span className="agent-actions">
            <button className="chip chip--ok" onClick={press}>
              Выполнить
            </button>
            <button className="chip" onClick={() => setAsking(false)}>
              Отмена
            </button>
          </span>
        </div>
      )}
    </div>
  );
};

interface KanbanCard {
  id: string;
  text: string;
}
interface KanbanColumn {
  id: string;
  title: string;
  cards: KanbanCard[];
}

const newId = () => Math.random().toString(36).slice(2, 10);

const InlineInput = ({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) => {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      className="kanban-input"
      {...stop}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(value.trim() || null);
        if (e.key === 'Escape') onDone(null);
      }}
      onBlur={() => onDone(value.trim() || null)}
    />
  );
};

const KanbanView = ({ artifact, onPatch, selected }: ArtifactViewProps) => {
  const columns = (Array.isArray(artifact.props.columns) ? artifact.props.columns : []) as KanbanColumn[];
  const [adding, setAdding] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const update = (next: KanbanColumn[]) => onPatch({ columns: next });
  const move = (cardId: string, toColumn: string, beforeCard?: string) => {
    let card: KanbanCard | undefined;
    const without = columns.map((c) => {
      const found = c.cards.find((k) => k.id === cardId);
      if (found) card = found;
      return { ...c, cards: c.cards.filter((k) => k.id !== cardId) };
    });
    if (!card) return;
    update(
      without.map((c) => {
        if (c.id !== toColumn) return c;
        const at = beforeCard ? c.cards.findIndex((k) => k.id === beforeCard) : -1;
        const cards = [...c.cards];
        cards.splice(at < 0 ? cards.length : at, 0, card!);
        return { ...c, cards };
      }),
    );
  };
  return (
    <div className="artifact-kanban" onWheel={(e) => selected && e.stopPropagation()}>
      {columns.map((column) => (
        <div key={column.id} className="kanban-column" onDragOver={(e) => e.preventDefault()} onDrop={(e) => move(e.dataTransfer.getData('text/card'), column.id)}>
          <div className="kanban-title" data-drag-handle="true" onDoubleClick={(e) => { e.stopPropagation(); setEditing('col:' + column.id); }}>
            {editing === 'col:' + column.id ? (
              <InlineInput
                initial={column.title}
                onDone={(value) => {
                  setEditing(null);
                  if (value) update(columns.map((c) => (c.id === column.id ? { ...c, title: value } : c)));
                }}
              />
            ) : (
              <>
                <span>{column.title}</span>
                <span className="kanban-count">{column.cards.length}</span>
                {column.cards.length === 0 && columns.length > 1 && (
                  <button className="kanban-x" title="Удалить колонку" {...stop} onClick={() => update(columns.filter((c) => c.id !== column.id))}>
                    ×
                  </button>
                )}
              </>
            )}
          </div>
          {column.cards.map((card) =>
            editing === card.id ? (
              <InlineInput
                key={card.id}
                initial={card.text}
                onDone={(value) => {
                  setEditing(null);
                  if (value) update(columns.map((c) => ({ ...c, cards: c.cards.map((k) => (k.id === card.id ? { ...k, text: value } : k)) })));
                }}
              />
            ) : (
              <div
                key={card.id}
                className="kanban-card"
                draggable
                {...stop}
                onDragStart={(e) => e.dataTransfer.setData('text/card', card.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.stopPropagation();
                  move(e.dataTransfer.getData('text/card'), column.id, card.id);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditing(card.id);
                }}
              >
                <span className="kanban-text">{card.text}</span>
                <button
                  className="kanban-x"
                  title="Удалить"
                  {...stop}
                  onClick={() => update(columns.map((c) => ({ ...c, cards: c.cards.filter((k) => k.id !== card.id) })))}
                >
                  ×
                </button>
              </div>
            ),
          )}
          {adding === column.id ? (
            <InlineInput
              initial=""
              onDone={(value) => {
                setAdding(null);
                if (value) update(columns.map((c) => (c.id === column.id ? { ...c, cards: [...c.cards, { id: newId(), text: value }] } : c)));
              }}
            />
          ) : (
            <button className="kanban-add" {...stop} onClick={() => setAdding(column.id)}>
              + карточка
            </button>
          )}
        </div>
      ))}
      <button className="kanban-add-column" {...stop} onClick={() => update([...columns, { id: newId(), title: 'Новая колонка', cards: [] }])}>
        + колонка
      </button>
    </div>
  );
};

// --- Freeform ----------------------------------------------------------------

const ShapeView = ({ artifact, onPatch }: ArtifactViewProps) => {
  const { width: w, height: h } = artifact;
  const shape = str(artifact.props, 'shape', 'rect');
  const fill = str(artifact.props, 'fill', '#1f2430');
  const strokeColor = str(artifact.props, 'stroke', '#5b6478');
  const common = { fill, stroke: strokeColor, strokeWidth: 2, vectorEffect: 'non-scaling-stroke' as const };
  return (
    <div className="artifact-shape">
      <svg width="100%" height="100%" viewBox={'0 0 ' + w + ' ' + h} preserveAspectRatio="none">
        {shape === 'ellipse' && <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - 2} ry={h / 2 - 2} {...common} />}
        {shape === 'diamond' && <polygon points={w / 2 + ',2 ' + (w - 2) + ',' + h / 2 + ' ' + w / 2 + ',' + (h - 2) + ' 2,' + h / 2} {...common} />}
        {shape === 'triangle' && <polygon points={w / 2 + ',2 ' + (w - 2) + ',' + (h - 2) + ' 2,' + (h - 2)} {...common} />}
        {shape === 'rect' && <rect x={1} y={1} width={w - 2} height={h - 2} rx={10} {...common} />}
      </svg>
      <div className="shape-label">
        <EditableText value={str(artifact.props, 'label')} placeholder="" onCommit={(label) => onPatch({ label })} />
      </div>
    </div>
  );
};

const DrawingView = ({ artifact, selected, onPatch }: ArtifactViewProps) => {
  const tool = useStore((s) => s.tool);
  const strokes = (Array.isArray(artifact.props.strokes) ? artifact.props.strokes : []) as number[][];
  const [current, setCurrent] = useState<number[] | null>(null);
  const color = str(artifact.props, 'color', '#e8e8ea');
  const width = num(artifact.props, 'width', 3);
  const drawing = selected && tool === 'draw';
  const toLocal = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [
      Math.round(((e.clientX - rect.left) / rect.width) * artifact.width),
      Math.round(((e.clientY - rect.top) / rect.height) * artifact.height),
    ];
  };
  const path = (points: number[]) => points.reduce((d, v, i) => (i % 2 === 0 ? d + (i === 0 ? 'M' : 'L') + v : d + ' ' + v + ' '), '');
  return (
    <svg
      className={'artifact-drawing' + (drawing ? ' artifact-drawing--active' : '')}
      viewBox={'0 0 ' + artifact.width + ' ' + artifact.height}
      onPointerDown={(e) => {
        if (!drawing) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        setCurrent(toLocal(e));
      }}
      onPointerMove={(e) => {
        if (current) setCurrent([...current, ...toLocal(e)]);
      }}
      onPointerUp={() => {
        if (current && current.length > 2) onPatch({ strokes: [...strokes, current] });
        setCurrent(null);
      }}
    >
      {[...strokes, ...(current ? [current] : [])].map((points, index) => (
        <path key={index} d={path(points)} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {strokes.length === 0 && !current && (
        <text x="50%" y="50%" textAnchor="middle" fill="#5b6478" fontSize="14">
          {selected ? (drawing ? 'Ведите мышью' : 'Нажмите D или «Рисовать»') : 'Рисунок'}
        </text>
      )}
    </svg>
  );
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  if (bytes < 1024 ** 3) return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
  return (bytes / 1024 ** 3).toFixed(1) + ' ГБ';
};

const FileView = ({ artifact, onPatch }: ArtifactViewProps) => {
  const path = str(artifact.props, 'path');
  const [stat, setStat] = useState<FileStat | null>(null);
  const notify = useStore((s) => s.notify);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    void api.files.stat(path).then((s) => alive && setStat(s));
    return () => {
      alive = false;
    };
  }, [path]);
  if (!path) {
    return (
      <div className="artifact-file">
        <button
          className="chip"
          {...stop}
          onClick={async () => {
            const [chosen] = await api.pickFiles({});
            if (chosen) onPatch({ path: chosen });
          }}
        >
          Выбрать файл…
        </button>
      </div>
    );
  }
  const name = fileName(path);
  const ext = name.includes('.') ? name.split('.').pop() : stat?.isDirectory ? 'dir' : '';
  const open = async () => {
    const problem = await api.files.open(path);
    if (problem) notify('Не удалось открыть: ' + problem);
  };
  return (
    <div className={'artifact-file' + (stat && !stat.exists ? ' is-missing' : '')} onDoubleClick={(e) => { e.stopPropagation(); void open(); }} title={path}>
      <div className="file-icon">{stat?.isDirectory ? '📁' : ext ? ext.slice(0, 4) : '📄'}</div>
      <div className="file-meta">
        <div className="file-name">{name}</div>
        <div className="file-path">
          {stat ? (stat.exists ? (stat.isDirectory ? 'папка' : formatSize(stat.size)) + ' · ' + new Date(stat.mtime).toLocaleString('ru') : 'файл не найден') : '…'}
        </div>
        <div className="file-actions">
          <button className="chip" {...stop} onClick={() => void open()}>
            Открыть
          </button>
          <button className="chip" {...stop} onClick={() => api.files.reveal(path)}>
            В папке
          </button>
        </div>
      </div>
    </div>
  );
};

export const ARTIFACT_KINDS: Record<ArtifactType, ArtifactKind> = {
  note: { render: NoteView, bare: true },
  text: { render: TextView, bare: true },
  markdown: { render: MarkdownView },
  document: { render: MarkdownView },
  'markdown-doc': { render: (p) => <CodeEditor artifact={p.artifact} selected={p.selected} mode="markdown" onPatch={p.onPatch} />, interactive: true },
  code: { render: CodeView },
  'code-editor': { render: (p) => <CodeEditor artifact={p.artifact} selected={p.selected} mode="code" onPatch={p.onPatch} />, interactive: true },
  'text-editor': { render: (p) => <CodeEditor artifact={p.artifact} selected={p.selected} mode="text" onPatch={p.onPatch} />, interactive: true },
  // `bare`: the markup draws the whole card, so the board adds no plate,
  // border or shadow of its own behind it — that chrome only ever showed as a
  // pale edge in the corners of a card that rounds itself more than the board.
  html: { render: HtmlView, interactive: true, bare: true },
  ui: { render: HtmlView, interactive: true, bare: true },
  webview: { render: WebviewView, interactive: true },
  browser: { render: BrowserView, interactive: true },
  image: { render: ImageView },
  video: { render: VideoView, interactive: true },
  audio: { render: AudioView, interactive: true },
  terminal: { render: TerminalView, interactive: true, bare: true },
  'app-stream': { render: AppStreamView, interactive: true },
  button: { render: ButtonView, bare: true },
  kanban: { render: KanbanView, interactive: true },
  shape: { render: ShapeView, bare: true },
  drawing: { render: DrawingView },
  file: { render: FileView },
};

/** First words of whatever text an artifact carries, for reduced views and the overview. */
export const artifactCaption = (artifact: Artifact): string => {
  const p = artifact.props;
  for (const key of ['title', 'label', 'text', 'path', 'url', 'code', 'src']) {
    const value = p[key];
    if (typeof value === 'string' && value.trim()) {
      return value.replace(/[#*`>_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }
  return artifactDefinition(artifact.type).label;
};

/**
 * What a card shows between full detail and the overview canvas: the type and a
 * caption, no markdown parse, no iframe, no media element. At that zoom the
 * text would be unreadable anyway; this is where the frame budget is won.
 */
export const ReducedView = memo(({ artifact }: { artifact: Artifact }) => (
  <div className={'artifact-reduced reduced-' + artifact.type}>
    <div className="reduced-type">{artifactDefinition(artifact.type).label}</div>
    <div className="reduced-caption">{artifactCaption(artifact)}</div>
  </div>
));
