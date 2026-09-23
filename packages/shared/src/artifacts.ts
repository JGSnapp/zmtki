export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Artifact kinds are open by design: the renderer registry on the client and the
 * schema registry on the server are both keyed by this string, so a new kind is
 * added by registering it in one place on each side.
 */
export type ArtifactType =
  // Text and documents
  | 'note'
  | 'text'
  | 'markdown'
  | 'document'
  | 'markdown-doc'
  // Code
  | 'code'
  | 'code-editor'
  | 'text-editor'
  // Web
  | 'html'
  | 'webview'
  | 'browser'
  // Media
  | 'image'
  | 'video'
  | 'audio'
  // Live surfaces
  | 'terminal'
  | 'app-stream'
  // Interactive
  | 'button'
  | 'kanban'
  | 'ui'
  // Freeform
  | 'shape'
  | 'drawing'
  | 'file';

export const ARTIFACT_TYPES: ArtifactType[] = [
  'note',
  'text',
  'markdown',
  'document',
  'markdown-doc',
  'code',
  'code-editor',
  'text-editor',
  'html',
  'webview',
  'browser',
  'image',
  'video',
  'audio',
  'terminal',
  'app-stream',
  'button',
  'kanban',
  'ui',
  'shape',
  'drawing',
  'file',
];

/**
 * Artifacts backed by a live host-side resource: a PTY, an embedded
 * `WebContentsView`, a capture stream. They are expensive to create and cannot
 * be re-created from board JSON alone, so the canvas may hide them when they
 * scroll out of view but must never unmount them, and the persistence layer
 * stores a handle rather than the content itself.
 */
/**
 * Surfaces whose DOM/process state must survive camera detail changes.
 *
 * `html` and `ui` are local srcDoc iframes rather than external processes, but
 * replacing either with a reduced card destroys the document. Zooming back in
 * then loads it from scratch and exposes a white/black frame while it paints.
 */
export const LIVE_ARTIFACT_TYPES: ArtifactType[] = ['terminal', 'browser', 'webview', 'app-stream', 'html', 'ui'];

export const isLiveArtifact = (type: ArtifactType): boolean => LIVE_ARTIFACT_TYPES.includes(type);

export type ArtifactProps = Record<string, unknown>;

export interface Artifact extends Rect {
  id: string;
  type: ArtifactType;
  /** Stacking order inside the board. */
  z: number;
  rotation?: number;
  props: ArtifactProps;
  /**
   * Set when the overlap with a neighbour is deliberate — a stack of photos, a
   * badge on a card. Without it the quality metric fights the user: asked for
   * overlapping cards, the agent produced them and the board scored 11/100
   * because every pair cost 15 penalty points. Marked artifacts are excluded
   * from the overlap and the crowding checks — proximity is the whole point —
   * and from nothing else.
   */
  allowOverlap?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AnchorSide = 'top' | 'right' | 'bottom' | 'left' | 'auto';

export const ANCHOR_SIDES: AnchorSide[] = ['top', 'right', 'bottom', 'left', 'auto'];

export interface ArrowEndpoint {
  artifactId: string;
  side: AnchorSide;
  /**
   * Position of the port along the chosen side, 0..1 (0.5 is the middle).
   * Undefined means the port is distributed automatically among every arrow
   * that shares this side, so parallel connections never merge into one line.
   */
  offset?: number;
}

export interface ArrowStyle {
  color?: string;
  dashed?: boolean;
  width?: number;
  /** Arrow head at the source end as well. */
  bidirectional?: boolean;
}

/**
 * How the arrow is drawn between its ports.
 *
 * `orthogonal` and `curved` share one route: the same ports, the same stored
 * bends, the same polyline. They differ only in how the corners are drawn, so a
 * board can be switched between them without re-routing anything, and every
 * measurement — crossings, turns, clearances — keeps its meaning.
 */
export type ArrowRouting = 'straight' | 'orthogonal' | 'curved';

/** True when the polyline was computed by the router rather than drawn by hand. */
export const isRouted = (routing: ArrowRouting | undefined): boolean =>
  routing === 'orthogonal' || routing === 'curved';

export interface Arrow {
  id: string;
  from: ArrowEndpoint;
  to: ArrowEndpoint;
  /** User/agent controlled bend points in world coordinates. */
  bends: Vec2[];
  /** How the polyline between the ports is drawn. Defaults to orthogonal. */
  routing?: ArrowRouting;
  /**
   * True when the attachment points were chosen by the router rather than
   * asked for. Such ports belong to one particular arrangement: after a node
   * moves they are stale, and because a pinned port skips the distribution
   * pass, arrows into the same node kept crossing right next to it — most of
   * the crossings left on the bench boards were of exactly this kind.
   */
  autoPorts?: boolean;
  label?: string;
  style: ArrowStyle;
  createdAt: number;
  updatedAt: number;
}
