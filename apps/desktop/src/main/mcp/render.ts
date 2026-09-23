import type { Artifact, BoardState, Rect } from '@zmtki/shared';
import { arrowHeadVertices, computeArrowGeometries, rectsIntersect } from '@zmtki/shared';

const shortId = (id: string): string => id.split('_')[1]?.slice(0, 4) ?? id.slice(0, 4);

const summaryOf = (artifact: Artifact): string => {
  const p = artifact.props as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = p[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  const text = pick('text', 'label', 'title', 'url', 'src', 'code', 'alt');
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
};

/**
 * ASCII floor plan of a board region. Cheap for the model to read and it keeps
 * relative positions, gaps and overlaps visible without a vision model.
 */
export const renderAsciiSchema = (
  state: BoardState,
  region: Rect,
  cols = 68,
  rows = 30,
): string => {
  const grid: string[][] = Array.from({ length: rows }, () => new Array<string>(cols).fill(' '));
  const scaleX = cols / Math.max(region.width, 1);
  const scaleY = rows / Math.max(region.height, 1);

  const toCol = (x: number) => Math.max(0, Math.min(cols - 1, Math.round((x - region.x) * scaleX)));
  const toRow = (y: number) => Math.max(0, Math.min(rows - 1, Math.round((y - region.y) * scaleY)));

  const visible = state.artifacts
    .filter((a) => rectsIntersect(a, region))
    .sort((a, b) => a.z - b.z);

  const geometries = computeArrowGeometries(state.artifacts, state.arrows);
  const put = (row: number, col: number, char: string) => {
    if (row < 0 || row >= rows || col < 0 || col >= cols) return;
    grid[row][col] = char;
  };

  // Arrows first so boxes stay readable on top of them.
  for (const arrow of state.arrows) {
    const geometry = geometries.get(arrow.id);
    if (!geometry) continue;
    for (let i = 0; i < geometry.points.length - 1; i++) {
      const a = geometry.points[i];
      const b = geometry.points[i + 1];
      const steps = Math.max(
        Math.abs(toCol(b.x) - toCol(a.x)),
        Math.abs(toRow(b.y) - toRow(a.y)),
        1,
      );
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        put(toRow(a.y + (b.y - a.y) * t), toCol(a.x + (b.x - a.x) * t), '·');
      }
    }
    const last = geometry.points[geometry.points.length - 1];
    put(toRow(last.y), toCol(last.x), '>');
  }

  for (const artifact of visible) {
    const c0 = toCol(artifact.x);
    const c1 = toCol(artifact.x + artifact.width);
    const r0 = toRow(artifact.y);
    const r1 = toRow(artifact.y + artifact.height);
    for (let c = c0; c <= c1; c++) {
      put(r0, c, '-');
      put(r1, c, '-');
    }
    for (let r = r0; r <= r1; r++) {
      put(r, c0, '|');
      put(r, c1, '|');
    }
    put(r0, c0, '+');
    put(r0, c1, '+');
    put(r1, c0, '+');
    put(r1, c1, '+');

    const label = `${artifact.type[0]}:${shortId(artifact.id)}`;
    const labelRow = Math.min(r0 + 1, r1);
    for (let i = 0; i < label.length; i++) put(labelRow, c0 + 1 + i, label[i]);
  }

  const canvas = grid.map((row) => row.join('').replace(/\s+$/, '')).join('\n');
  const legend = visible
    .map((a) => {
      const text = summaryOf(a);
      return `  ${a.type[0]}:${shortId(a.id)} = ${a.id} [${a.type}] @(${a.x},${a.y}) ${a.width}x${a.height}${text ? ` "${text}"` : ''}`;
    })
    .join('\n');

  const arrowLegend = state.arrows
    .filter((arrow) => visible.some((a) => a.id === arrow.from.artifactId || a.id === arrow.to.artifactId))
    .map(
      (arrow) =>
        `  ${arrow.id}: ${arrow.from.artifactId}(${arrow.from.side}) -> ${arrow.to.artifactId}(${arrow.to.side})` +
        `${arrow.bends.length ? ` bends=${arrow.bends.map((b) => `(${b.x},${b.y})`).join(' ')}` : ''}` +
        `${arrow.label ? ` "${arrow.label}"` : ''}`,
    )
    .join('\n');

  return [
    `region: x=${region.x} y=${region.y} w=${region.width} h=${region.height} (1 char ≈ ${Math.round(1 / scaleX)}x${Math.round(1 / scaleY)} px)`,
    canvas || '(пусто)',
    visible.length ? `artifacts:\n${legend}` : 'artifacts: (нет в этой области)',
    arrowLegend ? `arrows:\n${arrowLegend}` : 'arrows: (нет)',
  ].join('\n');
};

const escapeXml = (value: string): string =>
  value.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&apos;',
  );

const FILL_BY_TYPE: Record<string, string> = {
  note: '#3a3320',
  text: '#232733',
  shape: '#1f2430',
  image: '#26303a',
  webview: '#2a2438',
  browser: '#2a2438',
  terminal: '#1b1f1b',
  code: '#20242e',
};

/** Vector rendering of a region; used as the screenshot fallback. */
export const renderSvgSchema = (state: BoardState, region: Rect, maxSize = 1024): string => {
  const scale = Math.min(maxSize / Math.max(region.width, 1), maxSize / Math.max(region.height, 1), 2);
  const width = Math.round(region.width * scale);
  const height = Math.round(region.height * scale);

  const boxes = state.artifacts
    .filter((a) => rectsIntersect(a, region))
    .sort((a, b) => a.z - b.z)
    .map((a) => {
      const label = escapeXml(`${a.type} ${shortId(a.id)}`);
      const text = escapeXml(summaryOf(a));
      return `<g>
  <rect x="${a.x}" y="${a.y}" width="${a.width}" height="${a.height}" rx="8" fill="${FILL_BY_TYPE[a.type] ?? '#232733'}" stroke="#5b6478" stroke-width="1.5"/>
  <text x="${a.x + 10}" y="${a.y + 22}" font-family="monospace" font-size="13" fill="#8b93a7">${label}</text>
  <text x="${a.x + 10}" y="${a.y + 44}" font-family="sans-serif" font-size="14" fill="#e8e8ea">${text}</text>
</g>`;
    })
    .join('\n');

  const geometries = computeArrowGeometries(state.artifacts, state.arrows);
  const arrows = state.arrows
    .map((arrow) => {
      const geometry = geometries.get(arrow.id);
      if (!geometry) return '';
      const color = arrow.style.color ?? '#7c8aa5';
      const points = geometry.points.map((p) => `${p.x},${p.y}`).join(' ');
      const [a, b, c] = arrowHeadVertices(geometry.toPoint, geometry.toSide, 10);
      const dash = arrow.style.dashed ? ' stroke-dasharray="6 5"' : '';
      return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${arrow.style.width ?? 2}"${dash}/><polygon points="${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y}" fill="${color}"/>`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${region.x} ${region.y} ${region.width} ${region.height}">
<rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" fill="#101216"/>
${arrows}
${boxes}
</svg>`;
};
