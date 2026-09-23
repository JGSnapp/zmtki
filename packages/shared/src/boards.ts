import type { Arrow, Artifact } from './artifacts.js';
import type { Zone } from './zones.js';

export interface BoardState {
  artifacts: Artifact[];
  arrows: Arrow[];
  zones: Zone[];
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Board {
  id: string;
  title: string;
  description: string;
  /**
   * Directory the board is opened on. Files living here are surfaced as
   * artifacts automatically; artifacts pulled in from elsewhere keep an
   * absolute path. Empty for a scratch board with no folder behind it.
   */
  rootDir: string;
  state: BoardState;
  viewport: Viewport;
  /**
   * Incremented by every broadcast change. A receiver applying deltas uses it
   * to notice one it missed and fetch the board again instead of drifting.
   */
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface BoardSummary {
  id: string;
  title: string;
  description: string;
  rootDir: string;
  artifactCount: number;
  arrowCount: number;
  zoneCount: number;
  canUndo: boolean;
  canRedo: boolean;
  updatedAt: number;
}

export const emptyBoardState = (): BoardState => ({ artifacts: [], arrows: [], zones: [] });
