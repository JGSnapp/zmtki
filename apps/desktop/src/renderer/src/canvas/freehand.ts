import getStroke from 'perfect-freehand';

export type StrokePoint = [number, number, number];

const OPTIONS = {
  smoothing: 0.52,
  thinning: 0.62,
  streamline: 0.42,
  easing: (t: number): number => t,
  simulatePressure: true,
  last: true
};

/**
 * Converts raw input points into a filled outline.
 *
 * Strokes are stored as points rather than as an SVG path so the same data can
 * be re-rendered at a different width later; a baked path would freeze the
 * style at draw time.
 */
export function strokeToPath(points: readonly StrokePoint[], size: number): string {
  if (points.length === 0) return '';
  const outline = getStroke(points.map((p) => [...p]), { ...OPTIONS, size: Math.max(1, size * 2) });
  if (outline.length === 0) return '';

  const parts: string[] = [];
  for (let i = 0; i < outline.length; i += 1) {
    const point = outline[i];
    const next = outline[(i + 1) % outline.length];
    if (!point || !next) continue;
    if (i === 0) parts.push(`M ${point[0]?.toFixed(2)} ${point[1]?.toFixed(2)}`);
    parts.push(
      `Q ${point[0]?.toFixed(2)} ${point[1]?.toFixed(2)} ${(((point[0] ?? 0) + (next[0] ?? 0)) / 2).toFixed(2)} ${(((point[1] ?? 0) + (next[1] ?? 0)) / 2).toFixed(2)}`
    );
  }
  parts.push('Z');
  return parts.join(' ');
}

export function boundsOfPoints(points: readonly StrokePoint[], padding: number): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs) - padding;
  const minY = Math.min(...ys) - padding;
  return {
    x: minX,
    y: minY,
    w: Math.max(1, Math.max(...xs) + padding - minX),
    h: Math.max(1, Math.max(...ys) + padding - minY)
  };
}
