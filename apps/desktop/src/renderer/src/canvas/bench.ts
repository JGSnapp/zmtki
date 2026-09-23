import type { Viewport } from '@zmtki/shared';
import type { BenchReport } from '../../../shared/ipc';

interface BenchOptions {
  artifacts: number;
  panBy(dx: number, dy: number): void;
  zoomAt(clientX: number, clientY: number, factor: number): void;
  setCamera(next: Viewport): void;
  viewport: HTMLElement | null;
  fit(): void;
}

interface Phase {
  name: string;
  frames: number;
  /** Applied once per frame through the same camera path a user's input takes. */
  step(center: { x: number; y: number }): void;
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
};

const round = (value: number, digits = 1): number => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

/**
 * Flies the camera over the board and measures frame times.
 *
 * The moves go through `panBy` and `zoomAt`, the same functions wheel and drag
 * call, so what is measured is what a user gets — including the throttled
 * culling and the switch between DOM cards and the overview canvas. Frame time
 * is the gap between consecutive animation frames; a long one is a dropped
 * frame whatever caused it.
 */
export const runBench = async (options: BenchOptions): Promise<BenchReport> => {
  const el = options.viewport;
  const bounds = el?.getBoundingClientRect();
  const center = {
    x: (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2,
    y: (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2,
  };

  // Start at full size over the densest corner of the board.
  options.setCamera({ x: 80, y: 80, zoom: 1 });
  await nextFrame();
  await new Promise((resolve) => setTimeout(resolve, 400));

  // The route stays over the board: at 5% zoom a few screen pixels per frame
  // already cross whole clusters. Zoom steps are sized to end where the next
  // phase needs to be — 1 → ~5% → ~50%.
  const phases: Phase[] = [
    { name: 'pan 100%', frames: 240, step: () => options.panBy(-14, -5) },
    { name: 'zoom out', frames: 150, step: (c) => options.zoomAt(c.x, c.y, 0.98) },
    { name: 'pan overview', frames: 240, step: () => options.panBy(-3, -2) },
    { name: 'zoom in', frames: 150, step: (c) => options.zoomAt(c.x, c.y, 1.0155) },
    { name: 'pan 50%', frames: 180, step: () => options.panBy(10, 5) },
  ];

  const all: number[] = [];
  let maxMounted = 0;
  const report: BenchReport['phases'] = [];
  const started = performance.now();

  for (const phase of phases) {
    // A pause between gestures, as a user makes: the camera settles, the
    // detail level catches up, and the next phase starts from a rested board.
    // The settle itself is not measured — it happens while nothing moves.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const times: number[] = [];
    let mounted = 0;
    let last = await nextFrame();
    for (let i = 0; i < phase.frames; i += 1) {
      phase.step(center);
      const now = await nextFrame();
      times.push(now - last);
      last = now;
      if (i % 15 === 0) mounted = Math.max(mounted, document.querySelectorAll('.artifact').length);
    }
    maxMounted = Math.max(maxMounted, mounted);
    all.push(...times);
    const avg = times.reduce((sum, t) => sum + t, 0) / times.length;
    report.push({ name: phase.name, avgFps: round(1000 / avg), p95FrameMs: round(percentile(times, 95)), maxMounted: mounted });
  }

  const durationMs = performance.now() - started;
  const avg = all.reduce((sum, t) => sum + t, 0) / all.length;
  return {
    artifacts: options.artifacts,
    frames: all.length,
    durationMs: Math.round(durationMs),
    avgFps: round(1000 / avg),
    p95FrameMs: round(percentile(all, 95)),
    maxFrameMs: round(Math.max(...all)),
    maxMounted,
    phases: report,
  };
};
