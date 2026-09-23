import type { Artifact, SpatialIndex, Viewport } from '@zmtki/shared';
import { worldViewRect } from '@zmtki/shared';
import { useEffect, useRef } from 'react';
import { artifactCaption } from '../artifacts/registry';

/**
 * Note colours, exactly as the cards are painted (see `.note-*` in styles.css).
 * A board of coloured notes keeps its colours when it is zoomed out: darkening
 * them turned every note the same brown and the picture lost its meaning.
 */
const NOTE_FILL: Record<string, string> = {
  yellow: '#f2d680',
  blue: '#a9c4ff',
  green: '#b9e08f',
  pink: '#f5a8bd',
  purple: '#cdb4f6',
  gray: '#c9ced8',
};

/** Fill per type on the overview. Close to each card's own colour so the switch reads as a zoom, not a swap. */
const FILL: Record<string, string> = {
  note: NOTE_FILL.yellow,
  text: '#1a1d24',
  markdown: '#20242e',
  document: '#20242e',
  'markdown-doc': '#20242e',
  code: '#1b2130',
  'code-editor': '#1b2130',
  'text-editor': '#1f232c',
  html: '#262236',
  ui: '#262236',
  webview: '#2a2438',
  browser: '#2a2438',
  image: '#23303a',
  video: '#2b2530',
  audio: '#2b2530',
  terminal: '#0b0d11',
  'app-stream': '#22262e',
  button: '#2e3f6b',
  kanban: '#1e2430',
  shape: '#1f2430',
  drawing: '#1a1d24',
  file: '#1f232b',
};
const DEFAULT_FILL = '#20242e';

/** Whether a fill is light enough that a caption on it has to be dark. */
const lightFills = new Map<string, boolean>();
const isLight = (hex: string): boolean => {
  let known = lightFills.get(hex);
  if (known === undefined) {
    const value = hex.slice(1);
    const full = value.length === 3 ? value.replace(/./g, (c) => c + c) : value.slice(0, 6);
    const n = Number.parseInt(full, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    known = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
    lightFills.set(hex, known);
  }
  return known;
};

/** What colour a card shows from far away: its own, when it has one. */
const fillOf = (artifact: Artifact): string => {
  const own = artifact.props.color;
  if (typeof own === 'string') {
    const named = NOTE_FILL[own];
    if (named) return named;
    // Shapes and drawings carry a colour of their own as plain CSS.
    if (/^#[0-9a-f]{3,8}$/i.test(own)) return own;
  }
  return FILL[artifact.type] ?? DEFAULT_FILL;
};

interface Props {
  active: boolean;
  /**
   * Whether the camera is in motion, asked per frame rather than passed as a
   * prop. Rounded corners, borders and captions are drawn only at rest: mid-zoom
   * they cost thousands of path and text operations a frame and are a pixel or a
   * blur at that speed; they appear the moment the camera stops. Reading it
   * inside the draw is what keeps a gesture from re-subscribing this layer.
   */
  isMoving(): boolean;
  index: SpatialIndex<Artifact>;
  /**
   * Every arrow flattened into one typed array of segments, in board units:
   * x1, y1, x2, y2 repeated. Worked out by the canvas that owns the board, so
   * the lines drawn here are the ones the router laid rather than a second,
   * straighter picture of the same graph.
   */
  segments: Float32Array;
  cameraRef: React.MutableRefObject<Viewport>;
  screen: { width: number; height: number };
  subscribeFrame: (listener: (camera: Viewport) => void) => () => void;
}

/** Captions are computed once per artifact version, not once per frame. */
const captions = new WeakMap<Artifact, string>();
const captionOf = (artifact: Artifact): string => {
  let caption = captions.get(artifact);
  if (caption === undefined) {
    caption = artifactCaption(artifact);
    captions.set(artifact, caption);
  }
  return caption;
};

/**
 * The board drawn as rectangles on one canvas, in screen space.
 *
 * Used when the board is zoomed out far enough that cards are unreadable or too
 * many to mount. It redraws on every camera frame without React, so its cost is
 * the frame budget. What keeps it inside:
 *
 * - rectangles are batched into one path per fill colour — a fill call per
 *   colour instead of per card, which the first measurement showed to be the
 *   difference between 36 ms and a few ms at 5000 cards;
 * - borders and rounded corners are drawn only while a card is big enough on
 *   screen for them to be visible;
 * - arrow segments are flattened into one typed array when the board changes,
 *   and stroked as a single path.
 */
export const OverviewLayer = ({ active, isMoving, index, segments, cameraRef, screen, subscribeFrame }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(screen.width * dpr);
    canvas.height = Math.round(screen.height * dpr);
    const byColor = new Map<string, Artifact[]>();

    const draw = (camera: Viewport) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!active) return;
      const { x, y, zoom } = camera;
      ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * x, dpr * y);
      const view = worldViewRect(camera, screen, 40);
      const visible = index.query(view);

      if (segments.length > 0) {
        ctx.strokeStyle = 'rgba(139,147,167,0.5)';
        ctx.lineWidth = 1.2 / zoom;
        ctx.beginPath();
        const right = view.x + view.width;
        const bottom = view.y + view.height;
        for (let i = 0; i < segments.length; i += 4) {
          const x1 = segments[i];
          const y1 = segments[i + 1];
          const x2 = segments[i + 2];
          const y2 = segments[i + 3];
          // Cheap reject of segments wholly off one side of the view.
          if ((x1 < view.x && x2 < view.x) || (x1 > right && x2 > right)) continue;
          if ((y1 < view.y && y2 < view.y) || (y1 > bottom && y2 > bottom)) continue;
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
        }
        ctx.stroke();
      }

      for (const bucket of byColor.values()) bucket.length = 0;
      for (const artifact of visible) {
        const color = fillOf(artifact);
        let bucket = byColor.get(color);
        if (!bucket) {
          bucket = [];
          byColor.set(color, bucket);
        }
        bucket.push(artifact);
      }

      const moving = isMoving();
      const detailed = zoom > 0.12 && !moving;
      const radius = 6;
      for (const [color, bucket] of byColor) {
        if (bucket.length === 0) continue;
        ctx.fillStyle = color;
        if (!detailed) {
          // Far out, cards are a few pixels across and corners are invisible.
          // fillRect goes to the GPU as plain quads; the same rects gathered
          // into one path had to be tessellated first, and on a 5 000-card
          // board that alone pushed every tenth overview frame past budget.
          for (const a of bucket) ctx.fillRect(a.x, a.y, a.width, a.height);
          continue;
        }
        ctx.beginPath();
        for (const a of bucket) ctx.roundRect(a.x, a.y, a.width, a.height, radius);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 1 / zoom;
        ctx.stroke();
      }

      // Captions only while they can be read: a 12px line needs the card to be
      // at least that tall on screen.
      if (zoom > 0.1 && !moving) {
        ctx.font = 12 / zoom + 'px system-ui, sans-serif';
        ctx.textBaseline = 'top';
        const pad = 8 / zoom;
        // Two passes so the fill colour is set twice, not once per card: dark
        // text on the light cards, light text on the dark ones.
        for (const pass of [false, true]) {
          ctx.fillStyle = pass ? 'rgba(24,26,32,0.85)' : 'rgba(215,218,224,0.85)';
          for (const artifact of visible) {
            if (artifact.height * zoom < 22 || artifact.width * zoom < 40) continue;
            if (isLight(fillOf(artifact)) !== pass) continue;
            const caption = captionOf(artifact);
            const maxChars = Math.max(4, Math.floor((artifact.width * zoom - 16) / 6.5));
            ctx.fillText(
              caption.length > maxChars ? caption.slice(0, maxChars - 1) + '…' : caption,
              artifact.x + pad,
              artifact.y + pad,
            );
          }
        }
      }
    };

    draw(cameraRef.current);
    // Inactive, the canvas is cleared once and stops following the camera:
    // clearing a screen-sized canvas every frame for nothing still costs a
    // raster pass while the board is in card mode.
    if (!active) return undefined;
    return subscribeFrame(draw);
  }, [active, isMoving, index, segments, cameraRef, screen, subscribeFrame]);

  return (
    <canvas
      ref={canvasRef}
      className="overview-layer"
      style={{ width: screen.width, height: screen.height, display: active ? 'block' : 'none' }}
    />
  );
};
