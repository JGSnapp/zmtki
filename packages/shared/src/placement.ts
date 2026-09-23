import type { Arrow, Artifact, Rect } from './artifacts.js';
import { rectsIntersect } from './geometry.js';
import { boardQuality, type LayoutQuality } from './quality.js';
import { routeArrows, tooTightToRoute, type RoutedArrow } from './routing.js';

const MAX_PLACEMENTS = 8;

export interface PlacementVariant {
  x: number;
  y: number;
  width?: number;
  height?: number;
  label?: string;
}

export const overlappingNeighbors = (
  rect: Rect,
  artifacts: Artifact[],
  excludeId?: string,
): Artifact[] =>
  artifacts.filter((item) => item.id !== excludeId && rectsIntersect(item, rect));

export const artifactCaption = (artifact: Artifact): string => {
  const props = artifact.props as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = props[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  const raw = pick('title', 'label', 'text', 'alt');
  const line = raw.split('\n').find((row) => row.replace(/[#*_`]/g, '').trim()) ?? '';
  const flat = line.replace(/[#*_`]+/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > 48 ? `${flat.slice(0, 45)}…` : flat;
};

const applyRoutes = (arrows: Arrow[], routed: RoutedArrow[]): Arrow[] =>
  arrows.map((arrow) => {
    const match = routed.find((item) => item.arrowId === arrow.id);
    if (!match) return arrow;
    return {
      ...arrow,
      bends: match.bends,
      routing: 'orthogonal' as const,
      from: { ...arrow.from, side: match.fromSide, offset: match.fromOffset },
      to: { ...arrow.to, side: match.toSide, offset: match.toOffset },
    };
  });

export interface PlacementRank {
  index: number;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  overlaps: Array<{ id: string; caption: string }>;
  routerRefused: boolean;
  routed: boolean;
  quality: Pick<LayoutQuality, 'score' | 'cost' | 'grade'>;
  arrowHits: number;
  detour: number;
  verdict: string;
}

const sortKey = (row: PlacementRank): number[] => [
  row.overlaps.length,
  row.routerRefused ? 1 : 0,
  row.arrowHits,
  row.quality.cost,
  row.detour,
];

const better = (a: PlacementRank, b: PlacementRank): boolean => {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] < kb[i];
  }
  return false;
};

export const rankArtifactPlacements = (
  artifacts: Artifact[],
  arrows: Arrow[],
  artifactId: string,
  placements: PlacementVariant[],
): { ranked: PlacementRank[]; bestIndex: number | null; truncated: number } => {
  const current = artifacts.find((item) => item.id === artifactId);
  if (!current) return { ranked: [], bestIndex: null, truncated: 0 };

  const limited = placements.slice(0, MAX_PLACEMENTS);
  const ranked: PlacementRank[] = limited.map((placement, index) => {
    const moved: Artifact = {
      ...current,
      x: Math.round(placement.x),
      y: Math.round(placement.y),
      width: Math.max(24, Math.round(placement.width ?? current.width)),
      height: Math.max(24, Math.round(placement.height ?? current.height)),
    };
    const next = artifacts.map((item) => (item.id === artifactId ? moved : item));
    const overlaps = overlappingNeighbors(moved, next, artifactId).map((item) => ({
      id: item.id,
      caption: artifactCaption(item),
    }));
    const gate = tooTightToRoute(next, arrows);
    let evaluated = arrows;
    let routed = false;
    let routerRefused = !gate.ready;
    if (gate.ready) {
      const outcome = routeArrows(next, arrows);
      if (!outcome.refused && outcome.routed.length > 0) {
        evaluated = applyRoutes(arrows, outcome.routed);
        routed = true;
      } else {
        routerRefused = true;
      }
    }
    const quality = boardQuality(next, evaluated);
    const arrowHits = quality.counts.arrowArtifact;
    const detour = quality.metrics.detour;
    const label = placement.label?.trim() || `вариант ${index + 1}`;
    let verdict: string;
    if (overlaps.length > 0) {
      verdict = `Наложение на ${overlaps.map((item) => item.caption || item.id).join(', ')}.`;
    } else if (routerRefused) {
      verdict = 'Роутер не проложит стрелки: узлы слишком тесно или порты внутри соседа.';
    } else if (arrowHits > 0) {
      verdict = `Стрелки режут блоки (${arrowHits}).`;
    } else {
      verdict = `Стрелки проходят, оценка ${quality.grade} (cost ${quality.cost}).`;
    }
    return {
      index,
      label,
      x: moved.x,
      y: moved.y,
      width: moved.width,
      height: moved.height,
      overlaps,
      routerRefused,
      routed,
      quality: { score: quality.score, cost: quality.cost, grade: quality.grade },
      arrowHits,
      detour,
      verdict,
    };
  });

  ranked.sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : a.index - b.index));
  return {
    ranked,
    bestIndex: ranked[0]?.index ?? null,
    truncated: Math.max(0, placements.length - limited.length),
  };
};
