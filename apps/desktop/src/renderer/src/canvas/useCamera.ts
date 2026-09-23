import type { Rect, Vec2, Viewport } from '@zmtki/shared';
import { useEffect, useRef } from 'react';

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;

/**
 * Silence after the last camera step before the gesture counts as over.
 *
 * Everything React does about the board — re-culling, swapping detail levels,
 * turning the overview on — waits for this. It is deliberately short: the whole
 * point of the loop below is that nothing expensive happens until it fires.
 */
const REST_MS = 130;

/*
 * The scene is deliberately never promoted to a compositor layer of its own.
 *
 * `will-change: transform` for the length of a gesture looks like the obvious
 * win — the compositor scales the raster it already has instead of drawing the
 * board again at every size. What it actually bought was a white flash: taking
 * the layer makes Chromium re-raster the whole board into it, and on a board of
 * embedded documents the tiles that had not finished showed as blank cards for
 * the first frames of the gesture. Measured over four runs on forty-two HTML
 * cards, toggling it flashed on roughly one gesture in three, and neither
 * holding the layer for ever nor dropping it flashed at all.
 *
 * Holding it for ever was the other candidate. It pans a little better and
 * zooms with fewer missed frames, but it re-rasters the whole layer now and
 * then — one run spent 467 ms in a single frame doing it — and it leaves text
 * rastered at the scale the layer was taken at. Not promoting is steadier
 * (worst frame 100 ms across runs), keeps text sharp at every zoom, and is one
 * less thing to time.
 */

/**
 * Quiet after the board stops before embedded documents refresh their stills.
 *
 * A still is cropped out of a capture of the window, so it must be taken once
 * the stills already on screen have faded away — otherwise a card photographs
 * its own cover. The hold and the fade are CSS on the still itself, which is
 * why nothing here toggles a class for them any more: the board used to wear a
 * third state for this, and every change of it restyled every embedded card.
 */
const STILL_REFRESH_MS = 380;

/**
 * Easing time constants for wheel notches: a click becomes a short glide.
 *
 * Both are far shorter than a gesture. A long tail is what reads as "the board
 * cannot keep up" — the transform was still catching up to the target hundreds
 * of milliseconds after the input, and every frame of that tail is another
 * re-raster of the scene at yet another scale.
 */
const PAN_TAU_MS = 55;
const ZOOM_TAU_MS = 50;

/** Fling friction as a time constant: velocity falls to 1/e every this many ms. */
const FLING_TAU_MS = 320;
/** Below this the glide stops, before it turns into a board that drifts on its own. */
const FLING_MIN_SPEED = 0.06; // px per ms
/** A flick harder than this is clamped: the board should not vanish off to another cluster. */
const FLING_MAX_SPEED = 4; // px per ms

/**
 * Floor on how often the view may ask React to re-cull, however fast it moves.
 *
 * It is the other half of the pop-in budget: the board mounted beyond the point
 * the cull fires at has to cover both the time this holds the call back and the
 * frame the render itself takes. Two frames at the hardest fling the camera
 * allows is what the canvas is sized for.
 */
const CULL_MIN_INTERVAL_MS = 32;

/**
 * Grid tile size, in viewports. The tile is a plain child of the scene, so the
 * board's own transform pans and scales it for free; it is only re-laid when
 * the view reaches its edge, which at four viewports across is rare.
 *
 * It used to be a single 1 000 000 px square parked at the origin. That square
 * is inside the layer the scene is promoted to, so Chromium had to tile and
 * re-raster a surface thousands of times larger than the window on every step
 * of a zoom.
 */
const GRID_SPAN = 4;

const clampZoom = (zoom: number): number => (zoom < MIN_ZOOM ? MIN_ZOOM : zoom > MAX_ZOOM ? MAX_ZOOM : zoom);
const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface Flight {
  logFrom: number;
  logTo: number;
  fromCx: number;
  fromCy: number;
  toCx: number;
  toCy: number;
  start: number;
  duration: number;
  width: number;
  height: number;
}

/**
 * What the camera tells React about, and when. Every one of these is a chance
 * for a re-render, so the loop fires them as rarely as it can get away with.
 */
export interface CameraHooks {
  /** The camera came to rest; write it to the board. */
  onPersist(viewport: Viewport): void;
  /** The view left the world rectangle React has mounted for. Fired mid-gesture. */
  onCull(camera: Viewport): void;
  /** The camera stopped. Detail levels and the overview switch here, never mid-gesture. */
  onRest(camera: Viewport): void;
  /** Motion started or stopped. Fired on the change only, not per frame. */
  onMovingChange(moving: boolean): void;
  /** The board's box on screen changed size. */
  onResize(screen: { width: number; height: number }): void;
}

export interface CameraController {
  /** Authoritative camera, mutated in place every frame. Read it in event handlers. */
  cameraRef: React.MutableRefObject<Viewport>;
  /** The board's box on screen, kept by the camera's own observer. */
  screenRef: React.MutableRefObject<{ width: number; height: number }>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  sceneRef: React.RefObject<HTMLDivElement | null>;
  /** The dot grid, a child of the scene so it scales with the board. */
  gridRef: React.RefObject<HTMLDivElement | null>;
  /**
   * The layer holding everything that keeps its size on screen while the board
   * shrinks under it: zone names, agent labels. It carries `--label-scale`,
   * written once per frame. It is a layer of its own precisely so that variable
   * reaches a dozen elements instead of every card on the board — an inherited
   * custom property invalidates the style of everything below it.
   */
  labelsRef: React.RefObject<HTMLDivElement | null>;
  /** The HUD's percentage, written as text so a zoom costs no React render. */
  zoomLabelRef: React.RefObject<HTMLSpanElement | null>;
  isMoving(): boolean;
  /**
   * The world rectangle React currently has cards mounted for. The loop fires
   * `onCull` as soon as the view is no longer inside it, and not before.
   */
  setSafeRect(rect: Rect | null): void;
  /** Immediate pan, applied on the next frame. Drag, trackpad and the benchmark use it. */
  panBy(dx: number, dy: number): void;
  /** Immediate zoom around a screen point. Trackpad pinch and the benchmark use it. */
  zoomAt(clientX: number, clientY: number, factor: number): void;
  /** Pan eased in over a few frames — for mouse-wheel notches. */
  smoothPanBy(dx: number, dy: number): void;
  /** Zoom eased in over a few frames around a screen point — for wheel notches and buttons. */
  smoothZoomAt(clientX: number, clientY: number, factor: number): void;
  /** Continue a released drag with the given velocity (px/ms) and friction. */
  fling(vx: number, vy: number): void;
  /** Fly to a camera: fit, focus, 100%. Interrupted by any input. */
  animateTo(next: Viewport, durationMs?: number): void;
  /** Stop inertia, easing and flights — the user has grabbed the board. */
  halt(): void;
  setCamera(next: Viewport): void;
  /** Screen point → world point, using the live camera. */
  toWorld(clientX: number, clientY: number): Vec2;
  /**
   * Called after every frame the camera moved in, for layers that draw
   * themselves — the overview canvas — and so must follow it per frame.
   */
  subscribeFrame(listener: (camera: Viewport) => void): () => void;
  /** Re-run the per-frame DOM writes after React put something new on the board. */
  sync(): void;
}

/**
 * Pan and zoom that never go through React.
 *
 * Every source of motion — pointer deltas, wheel notches, inertia, flights —
 * writes into one pending struct, and one animation-frame loop resolves all of
 * it into a single camera and a handful of DOM writes: the scene's transform,
 * the grid's box on the rare frame it has drifted, one CSS variable for the
 * labels, and the HUD's percentage. That is the whole cost of a frame.
 *
 * React hears about the camera exactly twice per gesture — when the view leaves
 * what is mounted, and when the board stops. There is no per-frame snapshot and
 * no throttled camera state, so a zoom across a full board reconciles nothing
 * at all. The previous loop published a snapshot eleven times a second, and
 * each one rebuilt the visible set, the mounted list, every card's props and
 * the whole arrow layer while the user was still turning the wheel.
 */
export const useCamera = (initial: Viewport, hooks: CameraHooks): CameraController => {
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  const cameraRef = useRef<Viewport>({ x: initial.x, y: initial.y, zoom: clampZoom(initial.zoom) });
  const screenRef = useRef({ width: 1, height: 1 });

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const labelsRef = useRef<HTMLDivElement | null>(null);
  const zoomLabelRef = useRef<HTMLSpanElement | null>(null);

  /**
   * Where the board sits on screen, cached.
   *
   * `getBoundingClientRect` forces the browser to settle layout before it can
   * answer, and both the zoom and every pointer-to-board conversion ask for it.
   * The board only moves when the window or the panels do, which is what the
   * observer below watches.
   */
  const origin = useRef({ left: 0, top: 0, valid: false });

  const raf = useRef(0);
  const lastTick = useRef(0);
  const moving = useRef(false);
  const restTimer = useRef(0);
  const stillTimer = useRef(0);

  /** Input waiting for the next frame. Several events collapse into one step. */
  const stepPan = useRef({ x: 0, y: 0 });
  const stepZoom = useRef<{ zoom: number; cx: number; cy: number } | null>(null);
  const easePan = useRef({ x: 0, y: 0 });
  const easeZoom = useRef<{ target: number; cx: number; cy: number } | null>(null);
  const velocity = useRef<{ x: number; y: number } | null>(null);
  const flight = useRef<Flight | null>(null);

  const safeRect = useRef<Rect | null>(null);
  const lastCullAt = useRef(0);

  const listeners = useRef(new Set<(camera: Viewport) => void>());

  /** Last thing written to each element, so a frame that changes nothing writes nothing. */
  const painted = useRef({ transform: '', labelScale: -1 });
  const grid = useRef({ step: 0, x: 0, y: 0, width: 0, height: 0 });

  const controller = useRef<CameraController | null>(null);
  if (!controller.current) {
    const bounds = (): { left: number; top: number } => {
      const box = origin.current;
      if (!box.valid) {
        const rect = viewportRef.current?.getBoundingClientRect();
        box.left = rect?.left ?? 0;
        box.top = rect?.top ?? 0;
        box.valid = true;
      }
      return box;
    };

    /** Moves the camera to `nextZoom` keeping the world point under the cursor still. */
    const zoomAround = (cam: Viewport, clientX: number, clientY: number, nextZoom: number): void => {
      const box = bounds();
      const localX = clientX - box.left;
      const localY = clientY - box.top;
      const worldX = (localX - cam.x) / cam.zoom;
      const worldY = (localY - cam.y) / cam.zoom;
      cam.zoom = nextZoom;
      cam.x = localX - worldX * nextZoom;
      cam.y = localY - worldY * nextZoom;
    };

    /**
     * The dot tile, re-laid only when the view reaches its edge or the spacing
     * doubles. Both are rare, so panning and zooming cost nothing here.
     */
    const paintGrid = (cam: Viewport): void => {
      const el = gridRef.current;
      if (!el) return;
      const zoom = cam.zoom;
      // Spacing in whole doublings, so the dots stay between 14 and 56 px apart
      // on screen whatever the zoom, and never crawl between two steps.
      let step = 20;
      while (step * zoom < 14) step *= 2;
      while (step * zoom > 56) step /= 2;
      const viewW = screenRef.current.width / zoom;
      const viewH = screenRef.current.height / zoom;
      const viewX = -cam.x / zoom;
      const viewY = -cam.y / zoom;
      const tile = grid.current;
      if (
        step === tile.step &&
        viewX >= tile.x &&
        viewY >= tile.y &&
        viewX + viewW <= tile.x + tile.width &&
        viewY + viewH <= tile.y + tile.height
      ) {
        return;
      }
      const width = Math.ceil((viewW * GRID_SPAN) / step) * step;
      const height = Math.ceil((viewH * GRID_SPAN) / step) * step;
      const margin = (GRID_SPAN - 1) / 2;
      // Snapped to whole steps, so the pattern stays locked to the world origin
      // however often the tile is moved.
      const x = Math.floor((viewX - viewW * margin) / step) * step;
      const y = Math.floor((viewY - viewH * margin) / step) * step;
      if (step !== tile.step) el.style.setProperty('--grid-step', step + 'px');
      tile.step = step;
      tile.x = x;
      tile.y = y;
      tile.width = width;
      tile.height = height;
      el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      el.style.width = width + 'px';
      el.style.height = height + 'px';
    };

    /**
     * Zone names and agent labels are the map's legend: they keep their size on
     * screen while the board shrinks under them, up to a point past which they
     * would cover what they label.
     */
    const paintLabels = (cam: Viewport): void => {
      const el = labelsRef.current;
      if (!el) return;
      const scale = cam.zoom >= 1 ? 1 : cam.zoom <= 0.25 ? 4 : 1 / cam.zoom;
      if (Math.abs(scale - painted.current.labelScale) < 0.002) return;
      painted.current.labelScale = scale;
      el.style.setProperty('--label-scale', String(scale));
    };

    const paintZoomLabel = (cam: Viewport): void => {
      const el = zoomLabelRef.current;
      if (!el) return;
      // Compared against the element rather than a remembered value: React also
      // writes this span on the two renders a gesture causes, and a cache would
      // then believe a stale percentage was already on screen.
      const text = Math.round(cam.zoom * 100) + '%';
      if (el.textContent !== text) el.textContent = text;
    };

    const writeDom = (): void => {
      const cam = cameraRef.current;
      const scene = sceneRef.current;
      if (scene) {
        const transform = 'translate(' + cam.x + 'px,' + cam.y + 'px) scale(' + cam.zoom + ')';
        if (transform !== painted.current.transform) {
          painted.current.transform = transform;
          scene.style.transform = transform;
        }
      }
      paintGrid(cam);
      paintLabels(cam);
      paintZoomLabel(cam);
      for (const listener of listeners.current) listener(cam);
    };

    const checkCull = (now: number): void => {
      const safe = safeRect.current;
      if (!safe || now - lastCullAt.current < CULL_MIN_INTERVAL_MS) return;
      const cam = cameraRef.current;
      const viewX = -cam.x / cam.zoom;
      const viewY = -cam.y / cam.zoom;
      const viewW = screenRef.current.width / cam.zoom;
      const viewH = screenRef.current.height / cam.zoom;
      if (
        viewX >= safe.x &&
        viewY >= safe.y &&
        viewX + viewW <= safe.x + safe.width &&
        viewY + viewH <= safe.y + safe.height
      ) {
        return;
      }
      lastCullAt.current = now;
      // Cleared until React acknowledges the new set, so one escape asks once.
      safeRect.current = null;
      hooksRef.current.onCull({ ...cam });
    };

    const settle = (): void => {
      restTimer.current = 0;
      if (!moving.current) return;
      moving.current = false;
      viewportRef.current?.classList.remove('is-moving');
      if (stillTimer.current) window.clearTimeout(stillTimer.current);
      stillTimer.current = window.setTimeout(() => {
        stillTimer.current = 0;
        window.dispatchEvent(new Event('zmtki:camera-rest'));
      }, STILL_REFRESH_MS);
      // One last frame: the overview canvas draws its captions only at rest.
      writeDom();
      const settled = { ...cameraRef.current };
      hooksRef.current.onMovingChange(false);
      hooksRef.current.onRest(settled);
      hooksRef.current.onPersist(settled);
    };

    const markMoving = (): void => {
      if (!moving.current) {
        moving.current = true;
        // Announced before the class, so a still capture already in flight is
        // thrown away rather than cropped against a board that has since moved.
        window.dispatchEvent(new Event('zmtki:camera-move'));
        viewportRef.current?.classList.add('is-moving');
        if (stillTimer.current) {
          window.clearTimeout(stillTimer.current);
          stillTimer.current = 0;
        }
        hooksRef.current.onMovingChange(true);
      }
      if (restTimer.current) window.clearTimeout(restTimer.current);
      restTimer.current = window.setTimeout(settle, REST_MS);
    };

    const tick = (now: number): void => {
      raf.current = 0;
      const dt = lastTick.current ? Math.min(64, now - lastTick.current) : 16;
      lastTick.current = now;
      const cam = cameraRef.current;
      let active = false;

      // Raw pan first, so a zoom in the same frame is anchored against where
      // the board actually is rather than where it was a frame ago.
      const pan = stepPan.current;
      if (pan.x !== 0 || pan.y !== 0) {
        cam.x += pan.x;
        cam.y += pan.y;
        pan.x = 0;
        pan.y = 0;
      }

      const step = stepZoom.current;
      if (step) {
        stepZoom.current = null;
        zoomAround(cam, step.cx, step.cy, step.zoom);
      }

      const glide = easePan.current;
      if (glide.x !== 0 || glide.y !== 0) {
        if (Math.abs(glide.x) > 0.25 || Math.abs(glide.y) > 0.25) {
          const k = 1 - Math.exp(-dt / PAN_TAU_MS);
          cam.x += glide.x * k;
          cam.y += glide.y * k;
          glide.x -= glide.x * k;
          glide.y -= glide.y * k;
          active = true;
        } else {
          cam.x += glide.x;
          cam.y += glide.y;
          glide.x = 0;
          glide.y = 0;
        }
      }

      const zoom = easeZoom.current;
      if (zoom) {
        const k = 1 - Math.exp(-dt / ZOOM_TAU_MS);
        const ratio = zoom.target / cam.zoom;
        const done = Math.abs(ratio - 1) < 0.0015;
        zoomAround(cam, zoom.cx, zoom.cy, done ? zoom.target : cam.zoom * ratio ** k);
        if (done) easeZoom.current = null;
        else active = true;
      }

      const speed = velocity.current;
      if (speed) {
        cam.x += speed.x * dt;
        cam.y += speed.y * dt;
        const decay = Math.exp(-dt / FLING_TAU_MS);
        speed.x *= decay;
        speed.y *= decay;
        if (Math.hypot(speed.x, speed.y) < FLING_MIN_SPEED) velocity.current = null;
        else active = true;
      }

      const trip = flight.current;
      if (trip) {
        const t = Math.min(1, (now - trip.start) / trip.duration);
        const eased = easeInOutCubic(t);
        // Centre and log-zoom are interpolated, not the translate: lerping the
        // translate of two different zooms swings the view sideways mid-flight.
        const z = Math.exp(trip.logFrom + (trip.logTo - trip.logFrom) * eased);
        const cx = trip.fromCx + (trip.toCx - trip.fromCx) * eased;
        const cy = trip.fromCy + (trip.toCy - trip.fromCy) * eased;
        cam.zoom = z;
        cam.x = trip.width / 2 - cx * z;
        cam.y = trip.height / 2 - cy * z;
        if (t >= 1) flight.current = null;
        else active = true;
      }

      markMoving();
      writeDom();
      checkCull(now);
      if (active) raf.current = requestAnimationFrame(tick);
      else lastTick.current = 0;
    };

    const requestFrame = (): void => {
      if (raf.current === 0) raf.current = requestAnimationFrame(tick);
    };

    const halt = (): void => {
      velocity.current = null;
      flight.current = null;
      easeZoom.current = null;
      easePan.current.x = 0;
      easePan.current.y = 0;
    };

    const panBy = (dx: number, dy: number): void => {
      flight.current = null;
      stepPan.current.x += dx;
      stepPan.current.y += dy;
      requestFrame();
    };

    const zoomAt = (clientX: number, clientY: number, factor: number): void => {
      flight.current = null;
      easeZoom.current = null;
      // A trackpad sends pinch steps far faster than the screen refreshes. They
      // compound into one step and are applied once, so the number of camera
      // solves and style writes follows the frame rate, not the event rate.
      const pending = stepZoom.current;
      const base = pending ? pending.zoom : cameraRef.current.zoom;
      stepZoom.current = { zoom: clampZoom(base * factor), cx: clientX, cy: clientY };
      requestFrame();
    };

    const smoothPanBy = (dx: number, dy: number): void => {
      flight.current = null;
      velocity.current = null;
      // A step that turns against what is still easing in lands at once, with
      // the leftover applied on the spot. Otherwise the tail of the previous
      // direction keeps pulling, and a gesture that changed axis reads as a
      // board that only moves one way at a time.
      const rest = easePan.current;
      const turned =
        (dx !== 0 && rest.x !== 0 && Math.sign(dx) !== Math.sign(rest.x)) ||
        (dy !== 0 && rest.y !== 0 && Math.sign(dy) !== Math.sign(rest.y));
      if (turned) {
        stepPan.current.x += rest.x;
        stepPan.current.y += rest.y;
        rest.x = dx;
        rest.y = dy;
      } else {
        rest.x += dx;
        rest.y += dy;
      }
      requestFrame();
    };

    const smoothZoomAt = (clientX: number, clientY: number, factor: number): void => {
      flight.current = null;
      velocity.current = null;
      const base = easeZoom.current?.target ?? stepZoom.current?.zoom ?? cameraRef.current.zoom;
      easeZoom.current = { target: clampZoom(base * factor), cx: clientX, cy: clientY };
      requestFrame();
    };

    const fling = (vx: number, vy: number): void => {
      const speed = Math.hypot(vx, vy);
      if (speed < FLING_MIN_SPEED * 3) return;
      const k = speed > FLING_MAX_SPEED ? FLING_MAX_SPEED / speed : 1;
      flight.current = null;
      velocity.current = { x: vx * k, y: vy * k };
      requestFrame();
    };

    const animateTo = (next: Viewport, durationMs = 460): void => {
      halt();
      const cam = cameraRef.current;
      const { width, height } = screenRef.current;
      const toZoom = clampZoom(next.zoom);
      flight.current = {
        logFrom: Math.log(cam.zoom),
        logTo: Math.log(toZoom),
        fromCx: (width / 2 - cam.x) / cam.zoom,
        fromCy: (height / 2 - cam.y) / cam.zoom,
        toCx: (width / 2 - next.x) / toZoom,
        toCy: (height / 2 - next.y) / toZoom,
        start: performance.now(),
        duration: durationMs,
        width,
        height,
      };
      requestFrame();
    };

    const sync = (): void => {
      // Anything React has just mounted carries none of the per-frame writes,
      // so the cache is dropped and every one of them is made again.
      painted.current.transform = '';
      painted.current.labelScale = -1;
      grid.current.step = 0;
      writeDom();
    };

    const setCamera = (next: Viewport): void => {
      halt();
      stepPan.current.x = 0;
      stepPan.current.y = 0;
      stepZoom.current = null;
      const cam = cameraRef.current;
      cam.x = next.x;
      cam.y = next.y;
      cam.zoom = clampZoom(next.zoom);
      writeDom();
      const placed = { ...cam };
      hooksRef.current.onCull(placed);
      hooksRef.current.onRest(placed);
      hooksRef.current.onPersist(placed);
    };

    const toWorld = (clientX: number, clientY: number): Vec2 => {
      const box = bounds();
      const cam = cameraRef.current;
      return { x: (clientX - box.left - cam.x) / cam.zoom, y: (clientY - box.top - cam.y) / cam.zoom };
    };

    const subscribeFrame = (listener: (camera: Viewport) => void): (() => void) => {
      listeners.current.add(listener);
      return () => {
        listeners.current.delete(listener);
      };
    };

    controller.current = {
      cameraRef,
      screenRef,
      viewportRef,
      sceneRef,
      gridRef,
      labelsRef,
      zoomLabelRef,
      isMoving: () => moving.current,
      setSafeRect: (rect) => {
        safeRect.current = rect;
      },
      panBy,
      zoomAt,
      smoothPanBy,
      smoothZoomAt,
      fling,
      animateTo,
      halt,
      setCamera,
      toWorld,
      subscribeFrame,
      sync,
    };
  }

  const cam = controller.current;

  useEffect(() => {
    const el = cam.viewportRef.current;
    if (!el) return;
    const invalidate = () => {
      origin.current.valid = false;
    };
    const observer = new ResizeObserver((entries) => {
      invalidate();
      const box = entries[entries.length - 1]?.contentRect;
      if (!box) return;
      const screen = screenRef.current;
      if (Math.abs(screen.width - box.width) < 0.5 && Math.abs(screen.height - box.height) < 0.5) return;
      screen.width = box.width;
      screen.height = box.height;
      cam.sync();
      hooksRef.current.onResize({ width: box.width, height: box.height });
    });
    observer.observe(el);
    window.addEventListener('resize', invalidate);
    window.addEventListener('scroll', invalidate, true);
    cam.sync();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', invalidate);
      window.removeEventListener('scroll', invalidate, true);
    };
  }, [cam]);

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      if (restTimer.current) window.clearTimeout(restTimer.current);
      if (stillTimer.current) window.clearTimeout(stillTimer.current);
    },
    [],
  );

  return cam;
};
