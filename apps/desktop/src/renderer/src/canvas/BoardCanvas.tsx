import type { Artifact, Board, DetailLevel, Rect, Vec2, Viewport, Zone } from '@zmtki/shared';
import {
  SpatialIndex,
  arrowGeometryScope,
  artifactDefinition,
  computeArrowGeometries,
  boundsOf,
  detailLevel,
  findFreeSpot,
  isLiveArtifact,
  worldViewRect,
  zoneOutline,
} from '@zmtki/shared';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentInfo } from '../../../shared/ipc';
import { ARTIFACT_KINDS, MEDIA_EXTENSIONS, ReducedView } from '../artifacts/registry';
import { Logo } from '../components/Brand';
import { MOTION } from '../state/motion';
import { api, useStore } from '../state/store';
import { ArrowLayer } from './ArrowLayer';
import { runBench } from './bench';
import { OverviewLayer } from './OverviewLayer';
import type { CameraController } from './useCamera';
import { MAX_ZOOM, MIN_ZOOM, useCamera } from './useCamera';

/**
 * Screen pixels of pre-mounted board around the viewport, so panning never
 * shows pop-in. Every margin here is in screen pixels rather than board units,
 * so the band stays the same physical width at five per cent and at four times.
 */
const OVERSCAN = 260;

/**
 * How much board is mounted beyond the overscan band, as a multiple of the
 * view, and how much of it the view may take up before the set is rebuilt.
 *
 * The gap between the two is what a gesture spends in silence: the view may
 * grow by a fifth, or pan a couple of hundred pixels, with the cards already in
 * place. Culling used to run off a camera snapshot published eleven times a
 * second, so a two-second zoom rebuilt the visible set, the mounted list and
 * every card's props twenty times over.
 *
 * Both were half again as large in the first pass at this, which mounted five
 * times the area of the view: the benchmark's half-size pan held 168 cards for
 * a screen that showed sixty, and ran at 50 FPS with every other frame missed.
 * Trimming them to these left 120 cards and a steady 59.
 */
const MOUNT_ZOOM_SLACK = 1.4;
const SAFE_ZOOM_SLACK = 1.18;

/**
 * Most DOM cards mounted at once. Past this the canvas falls back to the
 * overview even at a readable zoom: a monitor cannot show more cards than this
 * legibly, and mounting them is where the frame budget goes.
 */
const DOM_BUDGET = 350;

/**
 * Cards held through a gesture after they leave the view, so nothing blinks.
 * A screenful or two costs nothing to keep; a whole dense board would, and a
 * long drag across one would collect exactly that.
 */
const KEEP_BUDGET = 120;

/** Stable empty set of line segments, so the overview redraws only on a change. */
const EMPTY_SEGMENTS = new Float32Array(0);

/**
 * Whether the lines stay drawn once the board is too small for cards.
 *
 * On by default, and it costs close to nothing: the overview draws every arrow
 * as one path on its canvas rather than as elements, so a board of 4 166 arrows
 * measured 59.3 FPS against 59.2 with them hidden, and the same 16.9 ms at the
 * 95th percentile. What is given up is exactness — the canvas runs each line
 * through its bends from centre to centre instead of from the port the router
 * picked, so a line can shift a pixel or two as the board crosses into the
 * overview. At that size a pixel is less of a loss than the shape of the graph.
 */
const OVERVIEW_ARROWS_KEY = 'overviewArrows';

/**
 * Arrows whose geometry is computed for the whole board at once. Past this the
 * board falls back to computing only what is mounted: the attachment points
 * then depend on the view, which is worse, but a board with this many arrows is
 * in the overview almost always anyway.
 */
const ARROW_GEOMETRY_BUDGET = 600;

type Gesture =
  | { kind: 'pan'; last: Vec2; samples: Array<{ t: number; x: number; y: number }> }
  | { kind: 'move'; origin: Vec2; start: Map<string, Rect>; moved: boolean; lastClient: Vec2 | null }
  | { kind: 'resize'; id: string; origin: Vec2; start: Rect; min: { w: number; h: number } }
  | { kind: 'connect'; fromId: string; point: Vec2 }
  | { kind: 'marquee'; origin: Vec2; point: Vec2; additive: boolean }
  | { kind: 'zone'; origin: Vec2; point: Vec2; subtract: boolean };

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

const noop = () => undefined;

/** Controls that take the pointer themselves: pressing on them must not start a drag. */
const isEditable = (el: Element | null): boolean =>
  !!el?.closest('input, textarea, select, button, [contenteditable="true"], .artifact-editor');

/**
 * Elements that take keystrokes. Narrower than `isEditable` on purpose: a
 * toolbar button keeps focus after a click, and treating it as a text field
 * silenced F, Delete and Ctrl+Z until the user clicked the board again.
 */
const isTyping = (el: Element | null): boolean =>
  !!el?.closest('input, textarea, select, [contenteditable="true"], .artifact-editor, .xterm, .browser-surface, .cm-editor');

const CODE_EXTENSIONS = [
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'json', 'html', 'htm', 'css', 'scss', 'go', 'rs', 'java', 'cs', 'c', 'cpp', 'h',
  'sh', 'ps1', 'yml', 'yaml', 'toml', 'sql', 'rb', 'php', 'kt', 'swift', 'lua', 'vue', 'svelte',
];

/** What a file dropped from the OS becomes: a picture, a player, an editor, or a file card. */
const blockForFile = (path: string): { type: Artifact['type']; props: Record<string, unknown> } => {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (MEDIA_EXTENSIONS.image.includes(ext)) return { type: 'image', props: { src: path, alt: name } };
  if (MEDIA_EXTENSIONS.video.includes(ext)) return { type: 'video', props: { src: path, title: name } };
  if (MEDIA_EXTENSIONS.audio.includes(ext)) return { type: 'audio', props: { src: path, title: name } };
  if (ext === 'md' || ext === 'markdown') return { type: 'markdown-doc', props: { path, title: name } };
  if (CODE_EXTENSIONS.includes(ext)) return { type: 'code-editor', props: { path, title: name, language: ext } };
  if (ext === 'txt' || ext === 'log' || ext === 'csv' || ext === 'ini' || ext === 'env') return { type: 'text-editor', props: { path, title: name } };
  return { type: 'file', props: { path } };
};

// --- Artifact node -----------------------------------------------------------

interface NodeProps {
  artifact: Artifact;
  boardId: string;
  selected: boolean;
  dragging: boolean;
  level: DetailLevel;
  hidden: boolean;
  renderScale: number;
  agent?: AgentInfo;
}

/**
 * One card on the board. Memoised on the artifact object and on the few flags
 * that change how it draws: an agent editing one card re-renders that card, not
 * the thousand next to it. Geometry overrides — a drag draft, a slide in
 * progress — are read through their own store selectors, so a frame of either
 * re-renders only the cards that move.
 */
const ArtifactNode = memo(({ artifact, boardId, selected, dragging, level, hidden, renderScale, agent }: NodeProps) => {
  const draft = useStore((s) => s.drafts[artifact.id]);
  const sliding = useStore((s) => s.motion[artifact.id]);
  const enterAt = useStore((s) => s.entering[artifact.id]);
  const patchProps = useStore((s) => s.patchProps);
  const kind = ARTIFACT_KINDS[artifact.type] ?? ARTIFACT_KINDS.note;
  const base = sliding ?? artifact;
  const x = draft?.x ?? base.x;
  const y = draft?.y ?? base.y;
  const width = draft?.width ?? base.width;
  const height = draft?.height ?? base.height;
  const live = isLiveArtifact(artifact.type);
  // Local HTML documents use a cached bitmap while the camera moves. Giving
  // every iframe its own promoted compositor layer exhausts GPU surfaces on a
  // board with dozens of pages and is precisely what makes them paint white.
  const promoteWhileMoving = live && artifact.type !== 'html' && artifact.type !== 'ui';
  const full = level === 'full' || live;
  const onPatch = useCallback((props: Record<string, unknown>) => void patchProps(artifact.id, props), [patchProps, artifact.id]);
  const enterDelay = enterAt ? Math.max(0, enterAt - performance.now()) : 0;

  return (
    <div
      className={
        'artifact type-' + artifact.type +
        (selected ? ' is-selected' : '') +
        (dragging ? ' is-dragging' : '') +
        (kind.bare ? ' is-bare' : '') +
        (kind.interactive ? ' is-interactive' : '') +
        (full ? '' : ' is-reduced') +
        (enterAt ? ' is-entering' : '')
      }
      data-artifact-id={artifact.id}
      style={{
        transform: 'translate(' + x + 'px,' + y + 'px)',
        width,
        height,
        zIndex: dragging ? 100000 : artifact.z,
        // An embedded document is never hidden this way. Hiding one parks its
        // out-of-process surface, so the card came back white for the frames it
        // took to produce another — and a pan brings cards into view constantly,
        // which is exactly when the board looked like it was flashing. Off the
        // viewport they cost nothing to leave visible: Chromium clips them.
        visibility: hidden && !live ? 'hidden' : undefined,
        ['--agent' as string]: agent?.color,
        ['--enter-delay' as string]: enterDelay + 'ms',
      }}
    >
      {/* `live-surface` is what the board-in-motion rules hang off: see
          styles.css for why they must not name a class every card carries. */}
      <div className={promoteWhileMoving ? 'artifact-body live-surface' : 'artifact-body'}>
        {/* Rendered as a component, never called as a function: block views keep
            their own hooks, and a card switching between full and reduced detail
            must not change the hook count of the card itself (React #310). */}
        {full ? (
          <kind.render artifact={artifact} boardId={boardId} selected={selected} visible={!hidden} level={level} renderScale={renderScale} onPatch={onPatch} />
        ) : (
          <ReducedView artifact={artifact} />
        )}
      </div>
      {agent && <div className="agent-badge">{agent.label}</div>}
      {selected && !dragging && (
        <>
          <div className="resize-handle" data-resize="true" />
          {SIDES.map((side) => (
            <div key={side} className={'anchor anchor-' + side} data-anchor={side} />
          ))}
        </>
      )}
    </div>
  );
});

/**
 * A card that has already left the board state: deleted, or moved too far to
 * slide. It is drawn from its last known self and plays out, then the store
 * drops it. Live kinds are drawn reduced — a ghost must never start a PTY view
 * or load a page again.
 */
const GhostNode = memo(({ ghost }: { ghost: { artifact: Artifact; kind: 'exit' | 'teleport' } }) => {
  const { artifact, kind } = ghost;
  const def = ARTIFACT_KINDS[artifact.type] ?? ARTIFACT_KINDS.note;
  const heavy = isLiveArtifact(artifact.type) || def.interactive;
  return (
    <div
      className={'artifact artifact-ghost ghost-' + kind + ' type-' + artifact.type + (def.bare ? ' is-bare' : '')}
      style={{
        transform: 'translate(' + artifact.x + 'px,' + artifact.y + 'px)',
        width: artifact.width,
        height: artifact.height,
        zIndex: artifact.z,
        ['--exit-ms' as string]: (kind === 'exit' ? MOTION.exitMs : MOTION.teleportOutMs) + 'ms',
      }}
    >
      <div className="artifact-body">
        {heavy ? (
          <ReducedView artifact={artifact} />
        ) : (
          <def.render artifact={artifact} boardId="" selected={false} visible level="full" renderScale={1} onPatch={noop} />
        )}
      </div>
      {kind === 'exit' && <div className="poof" />}
    </div>
  );
});

// --- Zones -------------------------------------------------------------------

/** Palette for zones drawn by hand; agents bring their own colour. */
const ZONE_COLORS = ['#6b8cff', '#41c7a8', '#ffb547', '#ff7a8a', '#b98cff', '#8a94a6'];

/** Rectangle of a sweep, however it was dragged. */
const sweptRect = (a: Vec2, b: Vec2): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(b.x - a.x),
  height: Math.abs(b.y - a.y),
});

/**
 * One zone: its rectangles as flat fills, and a single outline stroked around
 * their union. Drawing the union rather than four borders per rectangle is what
 * makes two swept squares read as one region instead of two boxes side by side.
 *
 * The zone's name is not here but in the label layer — see `ZoneLabel`.
 */
const ZoneShape = memo(({ zone, selected }: { zone: Zone; selected: boolean }) => {
  const outline = useMemo(() => zoneOutline(zone.rects), [zone.rects]);
  return (
    <div
      className={'zone-group' + (selected ? ' is-selected' : '') + (zone.pending ? ' zone-group--pending' : '')}
      style={{ ['--zone' as string]: zone.color }}
    >
      {zone.rects.map((rect, i) => (
        <div
          key={i}
          className={'zone' + (zone.pending ? ' zone--pending' : '')}
          style={{
            transform: 'translate(' + rect.x + 'px,' + rect.y + 'px)',
            width: rect.width,
            height: rect.height,
          }}
        />
      ))}
      <svg className="zone-outline" style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible' }}>
        {outline.map((seg, i) => (
          <line key={i} x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} stroke={zone.color} />
        ))}
      </svg>
    </div>
  );
});

/**
 * A zone's name, drawn in the label layer.
 *
 * It keeps its size on screen while the board shrinks under it, and that
 * counter-scale changes on every frame of a zoom. It is written as one CSS
 * variable on the layer these labels live in, so the frame costs a dozen
 * elements — not a style invalidation of every card on the board, which is what
 * passing the scale down as a React prop used to cost.
 */
const ZoneLabel = memo(
  ({
    zone,
    boardId,
    selected,
    editing,
    onSelect,
  }: {
    zone: Zone;
    boardId: string;
    selected: boolean;
    editing: boolean;
    onSelect: (id: string | null) => void;
  }) => {
    const [renaming, setRenaming] = useState(false);
    const anchor = useMemo(
      () => zone.rects.reduce((best, r) => (r.y < best.y || (r.y === best.y && r.x < best.x) ? r : best), zone.rects[0]),
      [zone.rects],
    );
    if (!anchor) return null;
    const accept = () => void api.zones.accept(boardId, zone.id);
    const decline = () => void api.zones.remove(boardId, zone.id);

    return (
      <>
        <div
          className={'zone-title' + (zone.pending ? ' zone-title--pending' : '')}
          style={{
            ['--zone' as string]: zone.color,
            transform: 'translate(' + anchor.x + 'px,' + anchor.y + 'px) scale(var(--label-scale, 1))',
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            onSelect(selected ? null : zone.id);
          }}
          onDoubleClick={() => editing && setRenaming(true)}
        >
          {renaming ? (
            <input
              className="zone-rename"
              autoFocus
              defaultValue={zone.title}
              onPointerDown={(e) => e.stopPropagation()}
              onBlur={(e) => {
                setRenaming(false);
                const title = e.target.value.trim();
                if (title && title !== zone.title) void api.zones.update(boardId, zone.id, { title });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
          ) : (
            <span className="zone-name">{zone.title}</span>
          )}
          {zone.pending ? (
            <>
              <span className="zone-hint" title={zone.reason}>
                {zone.extendsZoneId ? 'агент просит расширить' : 'агент просит зону'}
              </span>
              <button className="chip chip--ok" onPointerDown={(e) => e.stopPropagation()} onClick={accept}>
                Принять
              </button>
              <button className="chip" onPointerDown={(e) => e.stopPropagation()} onClick={decline}>
                Отклонить
              </button>
            </>
          ) : (
            selected &&
            editing && (
              <>
                <span className="zone-swatches">
                  {ZONE_COLORS.map((color) => (
                    <button
                      key={color}
                      className={'zone-swatch' + (color === zone.color ? ' is-on' : '')}
                      style={{ background: color }}
                      title="Цвет зоны"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => void api.zones.update(boardId, zone.id, { color })}
                    />
                  ))}
                </span>
                <button
                  className="chip"
                  title="Переименовать"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setRenaming(true)}
                >
                  ✎
                </button>
                <button
                  className="chip chip--warn"
                  title="Удалить зону"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    onSelect(null);
                    void api.zones.remove(boardId, zone.id);
                  }}
                >
                  ✕
                </button>
              </>
            )
          )}
        </div>
      </>
    );
  },
);

const ZoneShapes = memo(({ zones, selectedId }: { zones: Zone[]; selectedId: string | null }) => {
  if (zones.length === 0) return null;
  return (
    <>
      {zones.map((zone) => (
        <ZoneShape key={zone.id} zone={zone} selected={zone.id === selectedId} />
      ))}
    </>
  );
});

const ZoneLabels = memo(
  ({
    zones,
    boardId,
    selectedId,
    editing,
    onSelect,
  }: {
    zones: Zone[];
    boardId: string;
    selectedId: string | null;
    editing: boolean;
    onSelect: (id: string | null) => void;
  }) => {
    if (zones.length === 0) return null;
    return (
      <>
        {zones.map((zone) => (
          <ZoneLabel
            key={zone.id}
            zone={zone}
            boardId={boardId}
            selected={zone.id === selectedId}
            editing={editing}
            onSelect={onSelect}
          />
        ))}
      </>
    );
  },
);

// --- Agent markers -----------------------------------------------------------

/** A small map pin marks the last place an agent touched. */
const AgentMarkers = memo(
  ({
    agents,
    onFocus,
  }: {
    agents: AgentInfo[];
    onFocus: (agent: AgentInfo) => void;
  }) => (
  <>
    {agents.map((agent) => {
      const target = agent.lastTarget;
      // An agent that has stopped is not working anywhere, so its pin goes too.
      if (!target || !agent.running) return null;
      return (
        <button
          key={agent.id}
          className="agent-beacon"
          style={{
            transform:
              'translate(' + (target.x + target.width / 2 - 11) + 'px,' + (target.y - 25) +
              'px) scale(var(--label-scale, 1))',
            ['--agent' as string]: agent.color,
          }}
          title={(agent.parentId ? 'Субагент · ' : '') + agent.label +
            (agent.lastTool ? ' · ' + agent.lastTool : '') + ' · к терминалу'}
          aria-label={'К терминалу агента ' + agent.label}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onFocus(agent)}
        >
          <svg viewBox="0 0 22 27" aria-hidden="true">
            <path d="M11 1.5a8.5 8.5 0 0 0-8.5 8.5c0 6.2 8.5 15.5 8.5 15.5s8.5-9.3 8.5-15.5A8.5 8.5 0 0 0 11 1.5Z" />
            <circle cx="11" cy="10" r="3.25" />
          </svg>
        </button>
      );
    })}
  </>
  ),
);

// --- Placement ghost ---------------------------------------------------------

const PlacementGhost = ({ rect, label }: { rect: Rect; label: string }) => (
  <div
    className="placement-ghost"
    style={{ transform: 'translate(' + rect.x + 'px,' + rect.y + 'px)', width: rect.width, height: rect.height }}
  >
    <span className="placement-label">{label}</span>
  </div>
);

// --- Canvas ------------------------------------------------------------------

export const BoardCanvas = ({ board }: { board: Board }) => {
  const boardId = board.id;
  const camRef = useRef<CameraController | null>(null);

  /**
   * Where the mounted set was last worked out from, and the zoom the board was
   * last drawn at. Both change when the camera stops, and `cullCamera` also
   * mid-gesture on the rare frame the view leaves what is mounted — those two
   * are the only re-renders a pan or a zoom can cause.
   */
  const [cullCamera, setCullCamera] = useState<Viewport>(() => ({ ...board.viewport }));
  const [restZoom, setRestZoom] = useState(board.viewport.zoom);
  const [screen, setScreen] = useState({ width: 1, height: 1 });

  /** The camera as the rest of the app sees it: used to decide what to animate. */
  const publishView = useCallback((camera: Viewport, moving: boolean) => {
    const size = camRef.current?.screenRef.current ?? { width: 1, height: 1 };
    useStore.getState().setView({
      rect: worldViewRect(camera, size, 0),
      zoom: camera.zoom,
      screen: { width: size.width, height: size.height },
      moving,
    });
  }, []);

  const cam = useCamera(board.viewport, {
    onPersist: (viewport) => void api.boards.setViewport(boardId, viewport),
    onResize: setScreen,
    onCull: (camera) => {
      setCullCamera(camera);
      publishView(camera, true);
    },
    onRest: (camera) => {
      setCullCamera(camera);
      setRestZoom(camera.zoom);
      publishView(camera, false);
    },
    onMovingChange: (moving) => {
      if (camRef.current) publishView(camRef.current.cameraRef.current, moving);
    },
  });
  camRef.current = cam;
  const {
    viewportRef,
    sceneRef,
    gridRef,
    labelsRef,
    zoomLabelRef,
    cameraRef,
    isMoving,
    setSafeRect,
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
  } = cam;

  const selection = useStore((s) => s.selection);
  const selectedArrow = useStore((s) => s.selectedArrow);
  const drafts = useStore((s) => s.drafts);
  const motion = useStore((s) => s.motion);
  const ghosts = useStore((s) => s.ghosts);
  const agentsAll = useStore((s) => s.agents);
  const tool = useStore((s) => s.tool);
  const zoneSelection = useStore((s) => s.zoneSelection);
  const focusRequest = useStore((s) => s.focusRequest);
  const placement = useStore((s) => s.placement);
  const store = useStore.getState;

  const overviewArrows = useStore((s) => s.settings[OVERVIEW_ARROWS_KEY] !== false);
  const setSetting = useStore((s) => s.setSetting);
  const toggleOverviewArrows = useCallback(
    () => void setSetting(OVERVIEW_ARROWS_KEY, !overviewArrows),
    [setSetting, overviewArrows],
  );

  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const spaceDown = useRef(false);
  const [stats, setStats] = useState<{ fps: number; worst: number; dropped: number } | null>(null);
  /**
   * What the last wheel event carried, shown beside the frame counter.
   *
   * A touchpad that reports only one axis at a time and a board that ignores an
   * axis look identical from the outside; this says which it is.
   */
  const [wheelInfo, setWheelInfo] = useState<{ dx: number; dy: number; notch: boolean } | null>(null);

  const artifacts = board.state.artifacts;
  const agents = useMemo(() => agentsAll.filter((a) => a.boardId === board.id), [agentsAll, board.id]);
  const agentByArtifact = useMemo(() => new Map(agents.map((a) => [a.artifactId, a])), [agents]);

  // Rebuilt only when the artifact list itself changes — never during a drag.
  const index = useMemo(() => new SpatialIndex(artifacts), [artifacts]);
  const byId = useMemo(() => new Map(artifacts.map((a) => [a.id, a])), [artifacts]);

  /**
   * Detail level follows the zoom only once a gesture settles: switching
   * renderers mid-zoom would remount every card on the way through. The camera
   * hands us the zoom it stopped at, so nothing here is recomputed per frame.
   */
  const level = detailLevel(restZoom);

  /**
   * The two rectangles the culling runs on.
   *
   * `mount` is what is put in the DOM: the view with a band of overscan around
   * it, then grown by half again so a zoom out has somewhere to go. `safe` is
   * the part of it the view may wander inside without anything being rebuilt —
   * the camera watches the live view against it and only calls back when it is
   * left behind. Between the two sits enough board for roughly a screen of
   * panning or a fifth of a zoom out, which is what buys a gesture its silence.
   */
  const { mountRect, safeRect } = useMemo(() => {
    const view = worldViewRect(cullCamera, screen, 0);
    const grow = (px: number, factor: number): Rect => {
      const width = view.width * factor + (px * 2) / cullCamera.zoom;
      const height = view.height * factor + (px * 2) / cullCamera.zoom;
      return {
        x: view.x + view.width / 2 - width / 2,
        y: view.y + view.height / 2 - height / 2,
        width,
        height,
      };
    };
    return { mountRect: grow(OVERSCAN, MOUNT_ZOOM_SLACK), safeRect: grow(OVERSCAN * 0.3, SAFE_ZOOM_SLACK) };
  }, [cullCamera, screen]);

  const inView = useMemo(() => index.query(mountRect), [index, mountRect]);
  const inViewIds = useMemo(() => new Set(inView.map((a) => a.id)), [inView]);

  // Told after the render that put these cards in the DOM, never before: the
  // camera must not report an escape from a set React has not drawn yet.
  useEffect(() => {
    setSafeRect(safeRect);
  }, [safeRect, setSafeRect, inView]);

  // A board that is merely opened moves no camera, and the motion planner needs
  // to know what is on screen before the first agent edit arrives — otherwise
  // the first card to appear does so without its animation.
  useEffect(() => {
    publishView(cam.cameraRef.current, cam.isMoving());
  }, [cam, publishView, screen, cullCamera]);

  /**
   * Cards or the overview canvas — decided at rest, and during a gesture only
   * ever in the direction that costs nothing.
   *
   * Switching freely mid-gesture is what the flicker was: a zoom crossed the
   * threshold and thirty cards left the DOM, crossed back and they returned.
   * Holding the verdict for the whole gesture cured the flicker and bought a
   * worse problem — a zoom out grows the view without bound while the board is
   * still in card mode, and the benchmark caught it mounting 2 556 cards at 15
   * frames a second.
   *
   * So the switch is one-way while the board moves: it may turn on, never off.
   * Turning on unmounts, which is cheap and cannot oscillate because a gesture
   * only crosses the threshold in one direction from here; turning off is the
   * expensive half — hundreds of cards mounting mid-zoom — and it waits for the
   * board to stop.
   */
  const moving = isMoving();
  const settledOverview = useRef(false);
  const restOverview = level !== 'full' || inView.length > DOM_BUDGET;
  // Mid-gesture the live zoom counts too, not just the card budget: below the
  // readable threshold a card is a coloured rectangle either way, and the
  // canvas draws it for a fraction of what the DOM charges. Without this the
  // switch waited on density — a sparse board carried real cards all the way
  // down to five per cent and only swapped once the wheel stopped.
  if (!moving) settledOverview.current = restOverview;
  else if (restOverview || detailLevel(cameraRef.current.zoom) !== 'full') settledOverview.current = true;
  const overview = settledOverview.current;

  /**
   * What is in the DOM. In detail mode: everything near the viewport. In
   * overview: only what must stay interactive — the selection, anything being
   * dragged or animated. Live artifacts are always mounted, merely hidden when
   * out of view, because a PTY view or a webview cannot be rebuilt from JSON.
   */
  /**
   * Cards that are kept mounted wherever the camera goes.
   *
   * Live ones must be: a PTY or an embedded page cannot be rebuilt from JSON.
   * HTML cards are here for a plainer reason — their content is an iframe, and
   * an iframe that is unmounted and mounted again paints white while it parses
   * the document, so scrolling out to the overview and back made every HTML
   * card flash blank.
   */
  const liveArtifacts = useMemo(() => artifacts.filter((a) => isLiveArtifact(a.type)), [artifacts]);

  const mountedList = useMemo(() => {
    const out = new Map<string, Artifact>();
    if (!overview) for (const a of inView) out.set(a.id, a);
    for (const id of [...selection, ...Object.keys(drafts), ...Object.keys(motion)]) {
      const a = byId.get(id);
      if (a) out.set(id, a);
    }
    for (const a of liveArtifacts) out.set(a.id, a);
    /*
     * Always in the same order, whatever put a card in the list.
     *
     * Moving a DOM node that holds an `<iframe>` reloads the document inside
     * it — the element is taken out and put back, and Chromium starts the page
     * again. React reorders children to match the array, so the order here is
     * not a detail: the spatial query returns cards in whatever order the grid
     * cells come out, which changes as the view moves, and the overview builds
     * the list from a different source entirely. Every cull and every crossing
     * into the overview was therefore reloading embedded cards — they went
     * blank, lost the still that would have covered them, and painted again a
     * few frames later. That is the flashing, and it is why it came in bursts
     * at the start and end of a gesture.
     *
     * Order costs nothing to fix: depth on the board is `z-index`, set from the
     * artifact itself, so DOM order decides nothing about what is drawn on top.
     */
    return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }, [overview, inView, selection, drafts, motion, byId, liveArtifacts]);

  /**
   * Nothing leaves the DOM while the camera is moving.
   *
   * A card that scrolls off the edge mid-gesture used to be unmounted at once
   * and mounted again on the way back, which reads as blinking. Cards may still
   * join — a new one has to appear from somewhere — but the ones already drawn
   * stay until the board comes to rest, and the leftovers are dropped then.
   */
  const keptRef = useRef<Map<string, Artifact>>(new Map());
  const mountedWithKept = useMemo(() => {
    // Nothing is held over into the overview: the canvas is already drawing
    // every one of those cards, and the gesture that took the board there is
    // the one that could least afford to carry them.
    if (!moving || overview) {
      keptRef.current = new Map(mountedList.map((a) => [a.id, a]));
      return mountedList;
    }
    const out = new Map(keptRef.current);
    for (const a of mountedList) out.set(a.id, a);
    // A long drag across a dense board would otherwise keep collecting cards
    // for as long as the finger is down. Past this the held ones go and only
    // what is in view stays: holding a screenful or two costs nothing, holding
    // a whole dense board costs the frame rate.
    if (out.size > KEEP_BUDGET) {
      keptRef.current = new Map(mountedList.map((a) => [a.id, a]));
      return mountedList;
    }
    keptRef.current = out;
    // Sorted for the same reason the list above is: a card that joins mid-drag
    // must not push the ones already drawn into new DOM positions.
    return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }, [moving, overview, mountedList]);

  /**
   * The same cards in the same order yield the same array, so the arrow layer
   * and every memo below it stand still.
   *
   * The comparison is element by element on identity — the board hands out a
   * new object for a card it has changed, so that is exactly the test. It used
   * to be a joined string of every id and timestamp, built on every render of
   * the canvas whether anything had moved or not.
   */
  const mountedRef = useRef<Artifact[]>([]);
  const previous = mountedRef.current;
  let same = previous.length === mountedWithKept.length;
  if (same) {
    for (let i = 0; i < previous.length; i += 1) {
      if (previous[i] !== mountedWithKept[i]) {
        same = false;
        break;
      }
    }
  }
  if (!same) mountedRef.current = mountedWithKept;
  const mounted = mountedRef.current;
  const mountedIds = useMemo(() => new Set(mounted.map((a) => a.id)), [mounted]);
  const selectedIds = useMemo(() => new Set(selection), [selection]);

  // Arrows are drawn for mounted cards only, with drafts and slides folded in
  // so a moving card brings its arrows along.
  // Arrows by the artifacts they touch, built once per board change, so finding
  // the arrows of the mounted cards costs the mounted cards — not a scan of
  // every arrow on the board at each camera snapshot, which was what held the
  // 10 000-card board below the frame rate while panning at half size.
  const arrowsByArtifact = useMemo(() => {
    const map = new Map<string, Board['state']['arrows']>();
    for (const arrow of board.state.arrows) {
      for (const id of [arrow.from.artifactId, arrow.to.artifactId]) {
        const list = map.get(id);
        if (list) list.push(arrow);
        else map.set(id, [arrow]);
      }
    }
    return map;
  }, [board.state.arrows]);
  const visibleArrows = useMemo(() => {
    // Zoomed out far enough for the overview, the arrows are not drawn at all.
    //
    // Drawing them a second way — as canvas segments — meant the same board had
    // two different pictures of its own lines, and crossing the threshold
    // redrew every one of them. A line whose shape cannot be read at that size
    // is better absent than approximated.
    if (overview) return [];
    // Every arrow on the board, not the ones whose cards happen to be mounted.
    //
    // Ports are shared out between the arrows meeting at a side, so the set an
    // arrow is computed with decides where it attaches. Tying that set to what
    // is on screen meant the attachment changed as the board was zoomed — lines
    // stepping sideways and settling against a block. The set only shrinks on a
    // board too big for real lines anyway, where the overview has taken over.
    if (board.state.arrows.length <= ARROW_GEOMETRY_BUDGET) return board.state.arrows;
    const out = new Set<Board['state']['arrows'][number]>();
    for (const id of mountedIds) for (const arrow of arrowsByArtifact.get(id) ?? []) out.add(arrow);
    return [...out];
  }, [overview, arrowsByArtifact, mountedIds, board.state.arrows]);

  // Only the artifacts that can change these arrows' geometry, with drafts and
  // slides folded in so a moving card brings its arrows along. Identical
  // geometry to passing the whole board (see arrowGeometryScope), at a cost
  // that follows the arrows drawn rather than the size of the board.
  const arrowArtifacts = useMemo(() => {
    const lookup = (id: string): Artifact | undefined => {
      const a = byId.get(id);
      if (!a) return undefined;
      const slide = motion[id];
      const draft = drafts[id];
      return slide || draft ? { ...a, ...(slide ?? {}), ...(draft ?? {}) } : a;
    };
    return arrowGeometryScope(visibleArrows, lookup, (area) => index.query(area), [
      ...Object.keys(drafts),
      ...Object.keys(motion),
    ]);
    // `byId` is the board's own map; the scope picks from it what these arrows
    // can possibly touch, which is what keeps this cheap on a big board.
  }, [visibleArrows, byId, drafts, motion, index]);

  /**
   * The arrows as the overview draws them: every polyline flattened into one
   * typed array, which the canvas strokes as a single path.
   *
   * The shape is the one the router laid, not a line from centre to centre. An
   * orthogonal arrow that goes right and then down is two segments, and drawing
   * it as one diagonal would make the board change shape as it crossed into the
   * overview — the drawing would stop being the same drawing.
   *
   * Exactness has a price, so it is bought only where it is affordable: the
   * geometry of a whole board costs about 15 ms at 400 arrows, 33 ms at 1 000
   * and 496 ms at 4 166. Past the budget the lines fall back to their stored
   * bends, which is what a board of that many arrows shows at this size anyway.
   */
  const overviewSegments = useMemo(() => {
    const arrows = board.state.arrows;
    if (!overviewArrows || !overview || arrows.length === 0) return EMPTY_SEGMENTS;
    const points: number[] = [];
    const push = (ax: number, ay: number, bx: number, by: number) => {
      points.push(ax, ay, bx, by);
    };
    if (arrows.length <= ARROW_GEOMETRY_BUDGET) {
      const geometries = computeArrowGeometries(byId, arrows);
      for (const arrow of arrows) {
        const geometry = geometries.get(arrow.id);
        if (!geometry) continue;
        for (let i = 1; i < geometry.points.length; i += 1) {
          const from = geometry.points[i - 1];
          const to = geometry.points[i];
          push(from.x, from.y, to.x, to.y);
        }
      }
    } else {
      for (const arrow of arrows) {
        const from = byId.get(arrow.from.artifactId);
        const to = byId.get(arrow.to.artifactId);
        if (!from || !to) continue;
        let x = from.x + from.width / 2;
        let y = from.y + from.height / 2;
        for (const bend of arrow.bends) {
          push(x, y, bend.x, bend.y);
          x = bend.x;
          y = bend.y;
        }
        push(x, y, to.x + to.width / 2, to.y + to.height / 2);
      }
    }
    return Float32Array.from(points);
  }, [overviewArrows, overview, board.state.arrows, byId]);

  // --- Camera helpers --------------------------------------------------------

  const cameraFor = useCallback(
    (rect: Rect, zoom?: number): Viewport => {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom ?? cameraRef.current.zoom));
      return {
        zoom: z,
        x: screen.width / 2 - (rect.x + rect.width / 2) * z,
        y: screen.height / 2 - (rect.y + rect.height / 2) * z,
      };
    },
    [cameraRef, screen],
  );

  const fitCamera = useCallback((): Viewport => {
    if (artifacts.length === 0) return { x: screen.width / 2, y: screen.height / 2, zoom: 1 };
    const b = boundsOf(artifacts);
    const zoom = Math.min(1, (screen.width * 0.9) / b.width, (screen.height * 0.9) / b.height);
    return cameraFor(b, zoom);
  }, [artifacts, cameraFor, screen]);

  const fitContent = useCallback(() => animateTo(fitCamera()), [animateTo, fitCamera]);

  const zoomToCenter = useCallback(
    (factor: number) => {
      const bounds = viewportRef.current?.getBoundingClientRect();
      smoothZoomAt((bounds?.left ?? 0) + screen.width / 2, (bounds?.top ?? 0) + screen.height / 2, factor);
    },
    [screen, smoothZoomAt, viewportRef],
  );

  useEffect(() => {
    if (!focusRequest) return;
    const a = byId.get(focusRequest.id);
    if (a) animateTo(cameraFor(a, Math.max(cameraRef.current.zoom, 0.8)), 560);
    // Only a new request moves the camera, not later edits to the artifact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  useEffect(() => {
    const onFocusRect = (e: Event) => {
      const rect = (e as CustomEvent<Rect>).detail;
      if (rect) animateTo(cameraFor(rect, Math.max(cameraRef.current.zoom, 0.8)), 560);
    };
    window.addEventListener('zmtki:focus-rect', onFocusRect);
    return () => window.removeEventListener('zmtki:focus-rect', onFocusRect);
  }, [animateTo, cameraFor, cameraRef]);

  // A fresh board opens centred on its content, or on the origin when empty.
  const initialised = useRef(false);
  useEffect(() => {
    if (initialised.current || screen.width < 2) return;
    initialised.current = true;
    const v = board.viewport;
    if (v.x === 0 && v.y === 0 && v.zoom === 1) setCamera(fitCamera());
  }, [screen, board.viewport, fitCamera, setCamera]);

  // --- Screenshots for agents ------------------------------------------------

  useEffect(
    () =>
      api.screen.onLocate((region, boardId) => {
        const el = viewportRef.current;
        if (boardId !== board.id || !el) return null;
        const bounds = el.getBoundingClientRect();
        const { x, y, zoom } = cameraRef.current;
        const rect = {
          x: bounds.left + x + region.x * zoom,
          y: bounds.top + y + region.y * zoom,
          width: region.width * zoom,
          height: region.height * zoom,
        };
        const inside =
          rect.x >= bounds.left - 1 &&
          rect.y >= bounds.top - 1 &&
          rect.x + rect.width <= bounds.right + 1 &&
          rect.y + rect.height <= bounds.bottom + 1;
        return inside ? rect : null;
      }),
    [board.id, cameraRef, viewportRef],
  );

  // --- Wheel -----------------------------------------------------------------

  /** Milliseconds of quiet that end a wheel gesture, so the next one is judged afresh. */
  const WHEEL_GESTURE_GAP_MS = 120;
  const lastWheelAt = useRef(0);
  const wheelIsNotch = useRef(false);
  /** Events in the current burst, counted to correct the verdict above. */
  const wheelCount = useRef(0);
  /**
   * Whose wheel it is, decided once per element the pointer is over.
   *
   * The answer is two `closest` walks and a `contains` against the focused
   * node, and a trackpad asks it a hundred and twenty times a second while the
   * pointer sits perfectly still. It only changes when the pointer crosses into
   * a different element, so that is when it is worked out again.
   */
  const wheelOwner = useRef<{ target: Element | null; entered: boolean }>({ target: null, entered: false });

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    // Native and non-passive: React's wheel listener is passive, and a board
    // that cannot preventDefault lets Chromium scroll or zoom the page instead.
    const onWheel = (e: WheelEvent) => {
      const target = e.target as Element | null;
      // A card owns the wheel only once the user has gone into it — selected it
      // and put the caret or the focus inside. Being selected was not enough: a
      // terminal an agent had been working in swallowed every wheel event the
      // moment the pointer crossed it, and the board stopped under the fingers.
      const owner = wheelOwner.current;
      if (owner.target !== target) {
        const card = target?.closest('.artifact.is-selected');
        owner.target = target;
        owner.entered = card != null && document.activeElement != null && card.contains(document.activeElement);
      }
      if (!e.ctrlKey && !e.metaKey && owner.entered) return;
      e.preventDefault();
      // Taken in the capture phase, before the card's own content sees it: a
      // terminal scrolls its buffer on wheel and swallowed the event, so the
      // board stopped dead whenever the pointer crossed an agent's terminal.
      // Until a card is selected it is part of the board, so the board moves.
      e.stopPropagation();
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? cam.screenRef.current.height : 1;
      // A mouse wheel sends whole notches of about a hundred pixels; a
      // precision touchpad sends small fractional steps and brings its own
      // momentum. Notches are eased in so they glide; touchpad input is applied
      // as it comes, or it would feel laggy under the fingers.
      //
      // Size, not integrality, tells them apart: with display scaling Chromium
      // reports a notch as 125 or 100.0000xx, and treating that as touchpad
      // input zoomed 2.7× per notch in the first end-to-end run.
      // Wheel or touchpad, decided once per gesture.
      //
      // A single event cannot tell them apart reliably: a touchpad flick sends
      // a burst where some events have no horizontal part and a size a notch
      // would have, so judging each event on its own switched modes mid-gesture
      // and the board moved in one axis at a time. Rhythm is the honest signal
      // — a touchpad streams every few milliseconds, a wheel clicks — and the
      // verdict is held until the stream stops.
      const now = performance.now();
      const gap = now - lastWheelAt.current;
      lastWheelAt.current = now;
      if (gap > WHEEL_GESTURE_GAP_MS) {
        wheelIsNotch.current = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50 || Math.abs(e.deltaX) >= 50;
        wheelCount.current = 1;
      } else {
        wheelCount.current += 1;
      }
      // A flick on a touchpad opens with a step as big as a wheel click, so the
      // first event alone cannot tell them apart. A third event inside the same
      // burst can: wheels do not click three times in a tenth of a second. The
      // verdict is corrected mid-gesture, and the easing that was already in
      // flight is handed over so nothing is lost or dragged on.
      if (wheelIsNotch.current && wheelCount.current >= 3 && e.deltaMode === 0) {
        wheelIsNotch.current = false;
        halt();
      }
      const notch = wheelIsNotch.current;
      if (statsRef.current) setWheelInfo({ dx: Math.round(e.deltaX), dy: Math.round(e.deltaY), notch });
      if (e.ctrlKey || e.metaKey) {
        const delta = e.deltaY * unit;
        // Pinch steps are a few units; anything bigger is a wheel with Ctrl held.
        if (e.deltaMode !== 0 || Math.abs(delta) >= 25) smoothZoomAt(e.clientX, e.clientY, Math.exp(-Math.sign(delta) * Math.min(Math.abs(delta), 240) * 0.0022));
        else zoomAt(e.clientX, e.clientY, Math.exp(-delta * 0.01));
        return;
      }
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      if (notch) smoothPanBy(-dx, -dy);
      else panBy(-dx, -dy);
    };
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
    // The camera's functions and refs are stable for the life of the board, so
    // the listener is bound once and never swapped under a gesture.
  }, [cam, viewportRef, panBy, zoomAt, smoothPanBy, smoothZoomAt, halt]);

  // --- Placement -------------------------------------------------------------

  const insideViewport = useCallback(
    (clientX: number, clientY: number) => {
      const b = viewportRef.current?.getBoundingClientRect();
      if (!b) return false;
      if (clientX < b.left || clientX > b.right || clientY < b.top || clientY > b.bottom) return false;
      // Over the HUD or a zone button it is not a drop onto the board.
      const hit = document.elementFromPoint(clientX, clientY);
      return !!hit && !!hit.closest('.board-viewport') && !hit.closest('.hud');
    },
    [viewportRef],
  );

  /** Where a carried block of this type would land if it were released here. */
  const spotAt = useCallback(
    (type: Artifact['type'], clientX: number, clientY: number): Rect | null => {
      if (!insideViewport(clientX, clientY)) return null;
      const def = artifactDefinition(type);
      const center = toWorld(clientX, clientY);
      const wanted = { x: center.x - def.width / 2, y: center.y - def.height / 2, width: def.width, height: def.height };
      const spot = findFreeSpot(wanted, (area) => index.query(area), { gap: 40 });
      return { ...spot, width: def.width, height: def.height };
    },
    [insideViewport, toWorld, index],
  );

  const placementRect = useMemo(
    (): Rect | null =>
      !placement || placement.mode === 'press' ? null : spotAt(placement.type, placement.clientX, placement.clientY),
    // cullCamera: the world point under the pointer moves when the board does,
    // and the spot is read from the live camera whenever this runs again.
    [placement, spotAt, cullCamera],
  );

  useEffect(() => {
    if (!placement) return;
    let frame = 0;
    let pending: { x: number; y: number } | null = null;
    // The landing spot is worked out from the release point itself, not from
    // the ghost: the ghost is a rendered thing, and a window that is not
    // painting — covered by another, minimised — renders no frame to read.
    const drop = (clientX: number, clientY: number) => {
      const current = store().placement;
      store().endPlacement();
      if (!current) return;
      const rect = spotAt(current.type, clientX, clientY);
      if (rect) void store().createAt(current.type, rect, current.props);
    };
    const onMove = (e: PointerEvent) => {
      pending = { x: e.clientX, y: e.clientY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (pending) store().movePlacement(pending.x, pending.y);
      });
    };
    const onUp = (e: PointerEvent) => {
      const current = store().placement;
      if (!current) return;
      store().movePlacement(e.clientX, e.clientY);
      if (current.mode === 'press') store().setPlacementMode('click');
      else if (current.mode === 'drag') {
        if (insideViewport(e.clientX, e.clientY)) drop(e.clientX, e.clientY);
        else store().endPlacement();
      }
    };
    const onDown = (e: PointerEvent) => {
      const current = store().placement;
      if (!current || current.mode !== 'click') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.button === 0 && insideViewport(e.clientX, e.clientY)) drop(e.clientX, e.clientY);
      else store().endPlacement();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store().endPlacement();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [placement !== null, insideViewport, spotAt, store]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Pointer ---------------------------------------------------------------

  const beginGesture = (next: Gesture) => {
    gestureRef.current = next;
    setGesture(next);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (store().placement) return;
    const target = e.target as Element;
    const artifactEl = target.closest('[data-artifact-id]');
    const panRequested = e.button === 1 || (e.button === 0 && spaceDown.current);
    // Grabbing the board stops whatever the camera was doing on its own.
    halt();

    // In zone mode a drag on empty board sweeps a rectangle: it grows the zone
    // being edited, cuts it with Shift, or starts a new zone when none is held.
    if (tool === 'zone' && e.button === 0 && !panRequested && !artifactEl && !isEditable(target)) {
      const p = toWorld(e.clientX, e.clientY);
      e.currentTarget.setPointerCapture(e.pointerId);
      beginGesture({ kind: 'zone', origin: p, point: p, subtract: e.shiftKey });
      return;
    }

    if (panRequested || (e.button === 0 && !artifactEl && !e.shiftKey)) {
      if (e.button === 0 && !panRequested && !target.closest('.zone-title, .arrow')) store().select([]);
      e.currentTarget.setPointerCapture(e.pointerId);
      beginGesture({ kind: 'pan', last: { x: e.clientX, y: e.clientY }, samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }] });
      return;
    }

    if (e.button === 0 && !artifactEl && e.shiftKey) {
      const p = toWorld(e.clientX, e.clientY);
      e.currentTarget.setPointerCapture(e.pointerId);
      beginGesture({ kind: 'marquee', origin: p, point: p, additive: true });
      return;
    }

    if (e.button !== 0 || !artifactEl) return;
    const id = artifactEl.getAttribute('data-artifact-id')!;
    const artifact = byId.get(id);
    if (!artifact) return;
    const kind = ARTIFACT_KINDS[artifact.type];
    const selected = selection.includes(id);
    const onHandle = !!target.closest('[data-drag-handle]');

    if (target.closest('[data-resize]')) {
      e.currentTarget.setPointerCapture(e.pointerId);
      const d = drafts[id];
      beginGesture({
        kind: 'resize',
        id,
        origin: toWorld(e.clientX, e.clientY),
        start: { x: artifact.x, y: artifact.y, width: d?.width ?? artifact.width, height: d?.height ?? artifact.height },
        min: { w: 40, h: 32 },
      });
      return;
    }
    if (target.closest('[data-anchor]')) {
      e.currentTarget.setPointerCapture(e.pointerId);
      beginGesture({ kind: 'connect', fromId: id, point: toWorld(e.clientX, e.clientY) });
      return;
    }
    // Interactive content of a selected card receives its own input.
    if (selected && kind.interactive && !onHandle) return;
    if (isEditable(target) && !onHandle) return;
    if (tool === 'draw' && selected && artifact.type === 'drawing') return;

    const nextSelection = e.shiftKey
      ? selected
        ? selection.filter((s) => s !== id)
        : [...selection, id]
      : selected
        ? selection
        : [id];
    store().select(nextSelection);
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = new Map<string, Rect>();
    for (const sid of nextSelection) {
      const a = byId.get(sid);
      if (!a) continue;
      // A card still settling from a previous drop is picked up where it is drawn.
      const drawn = store().motion[sid] ?? a;
      start.set(sid, { x: drawn.x, y: drawn.y, width: a.width, height: a.height });
    }
    // A card still settling from its previous drop stops where it is drawn.
    store().stopMotion([...start.keys()]);
    beginGesture({
      kind: 'move',
      origin: toWorld(e.clientX, e.clientY),
      start,
      moved: false,
      lastClient: { x: e.clientX, y: e.clientY },
    });
  };

  const dragFrame = useRef(0);
  /** Throttles the board update while an arrow's corner is dragged. */
  const bendFrame = useRef(0);
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g) return;
    if (g.kind === 'pan') {
      panBy(e.clientX - g.last.x, e.clientY - g.last.y);
      g.last = { x: e.clientX, y: e.clientY };
      g.samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
      if (g.samples.length > 8) g.samples.shift();
      return;
    }
    const p = toWorld(e.clientX, e.clientY);
    if (g.kind === 'move') {
      const dx = p.x - g.origin.x;
      const dy = p.y - g.origin.y;
      g.lastClient = { x: e.clientX, y: e.clientY };
      if (!g.moved && Math.hypot(dx, dy) * cameraRef.current.zoom < 3) return;
      if (!g.moved) {
        g.moved = true;
        setGesture({ ...g });
      }
      const next: Record<string, Partial<Rect>> = {};
      for (const [id, r] of g.start) next[id] = { x: r.x + dx, y: r.y + dy };
      cancelAnimationFrame(dragFrame.current);
      dragFrame.current = requestAnimationFrame(() => store().setDrafts(next));
    } else if (g.kind === 'resize') {
      const width = Math.max(g.min.w, g.start.width + p.x - g.origin.x);
      const height = Math.max(g.min.h, g.start.height + p.y - g.origin.y);
      cancelAnimationFrame(dragFrame.current);
      dragFrame.current = requestAnimationFrame(() => store().setDrafts({ [g.id]: { width, height } }));
    } else if (g.kind === 'connect' || g.kind === 'marquee' || g.kind === 'zone') {
      const next = { ...g, point: p };
      gestureRef.current = next;
      setGesture(next);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    setGesture(null);
    cancelAnimationFrame(dragFrame.current);
    if (!g) return;
    // A cancelled pointer — Chromium taking the gesture over for a native drag
    // of a link or selected text, a lost capture — reports (0, 0). Positions
    // computed from it threw the card to the window's top-left corner.
    const cancelled = e.type === 'pointercancel';
    if (g.kind === 'pan') {
      if (cancelled) return;
      // Release velocity over the last ~100 ms. A pause before release means
      // the user stopped the board: no glide. A slow drag is not a throw
      // either — gliding after it read as the board drifting on its own.
      const now = performance.now();
      const last = g.samples[g.samples.length - 1];
      const first = g.samples.find((s) => now - s.t <= 100) ?? last;
      const dt = last ? last.t - first.t : 0;
      if (last && now - last.t < 40 && dt >= 16) {
        const vx = (last.x - first.x) / dt;
        const vy = (last.y - first.y) / dt;
        if (Math.hypot(vx, vy) > 0.35) fling(vx, vy);
      }
    } else if (g.kind === 'move' && g.moved) {
      const client = cancelled ? g.lastClient : { x: e.clientX, y: e.clientY };
      if (client) {
        const p = toWorld(client.x, client.y);
        const dx = p.x - g.origin.x;
        const dy = p.y - g.origin.y;
        const next: Record<string, Partial<Rect>> = {};
        for (const [id, r] of g.start) next[id] = { x: r.x + dx, y: r.y + dy };
        store().setDrafts(next);
      }
      void store().commitDrafts();
    } else if (g.kind === 'resize') {
      void store().commitDrafts();
    } else if (cancelled) {
      return;
    } else if (g.kind === 'connect') {
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-artifact-id]');
      const toId = hit?.getAttribute('data-artifact-id');
      if (toId && toId !== g.fromId) void store().connect(g.fromId, toId);
    } else if (g.kind === 'zone') {
      const rect = sweptRect(g.origin, g.point);
      // A sweep that is only a click is how a zone is deselected, not a 2x2 zone.
      if (rect.width * cameraRef.current.zoom < 12 || rect.height * cameraRef.current.zoom < 12) {
        store().selectZone(null);
        return;
      }
      const held = store().zoneSelection;
      if (held && g.subtract) void api.zones.carve(board.id, held, rect).then(() => store().selectZone(null));
      else if (held) void api.zones.grow(board.id, held, rect);
      else {
        const used = board.state.zones.length;
        void api.zones
          .create(board.id, {
            title: 'Зона ' + (used + 1),
            color: ZONE_COLORS[used % ZONE_COLORS.length],
            rects: [rect],
          })
          .then((zone) => store().selectZone(zone.id));
      }
    } else if (g.kind === 'marquee') {
      const rect = {
        x: Math.min(g.origin.x, g.point.x),
        y: Math.min(g.origin.y, g.point.y),
        width: Math.abs(g.point.x - g.origin.x),
        height: Math.abs(g.point.y - g.origin.y),
      };
      const hits = index.query(rect).map((a) => a.id);
      store().select([...new Set([...selection, ...hits])]);
    }
  };

  /** Creates a block at a board point, moved off anything it would land on. */
  const createNear = useCallback(
    (type: Artifact['type'], center: Vec2, props?: Record<string, unknown>) => {
      const def = artifactDefinition(type);
      const wanted = { x: center.x - def.width / 2, y: center.y - def.height / 2, width: def.width, height: def.height };
      const spot = findFreeSpot(wanted, (area) => index.query(area), { gap: 40 });
      void store().createAt(type, spot, props);
    },
    [index, store],
  );

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('[data-artifact-id], .zone-title, .hud')) return;
    createNear('note', toWorld(e.clientX, e.clientY));
  };

  // --- Files dropped from the OS ---------------------------------------------

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes('text/card')) return;
    const files = [...e.dataTransfer.files];
    if (files.length === 0) return;
    e.preventDefault();
    const at = toWorld(e.clientX, e.clientY);
    const taken: Rect[] = [];
    for (const file of files) {
      const path = api.pathForFile(file);
      if (!path) continue;
      const { type, props } = blockForFile(path);
      const def = artifactDefinition(type);
      const wanted = { x: at.x - def.width / 2, y: at.y - def.height / 2 + taken.reduce((h, t) => h + t.height + 40, 0), width: def.width, height: def.height };
      const spot = findFreeSpot(
        wanted,
        (area) => [...index.query(area), ...taken.filter((t) => t.x < area.x + area.width && t.x + t.width > area.x && t.y < area.y + area.height && t.y + t.height > area.y)],
        { gap: 40 },
      );
      taken.push({ ...spot, width: def.width, height: def.height });
      void store().createAt(type, spot, props);
    }
  };

  // --- Keyboard --------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = isTyping(document.activeElement);
      if (e.code === 'Space' && !typing) {
        spaceDown.current = e.type === 'keydown';
        if (e.type === 'keydown') e.preventDefault();
        return;
      }
      if (e.type !== 'keydown' || typing) return;
      const mod = e.ctrlKey || e.metaKey;
      if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) void store().removeSelection();
      else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) void store().undo();
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) void store().redo();
      else if (e.key === 'Escape') {
        store().select([]);
        store().setTool('select');
      } else if (e.key.toLowerCase() === 'f' && !mod) fitContent();
      else if (e.key === '0' && !mod) {
        const bounds = viewportRef.current?.getBoundingClientRect();
        const c = cameraRef.current;
        const cx = (screen.width / 2 - c.x) / c.zoom;
        const cy = (screen.height / 2 - c.y) / c.zoom;
        animateTo({ zoom: 1, x: screen.width / 2 - cx, y: screen.height / 2 - cy });
        void bounds;
      } else if (e.key.toLowerCase() === 'd' && !mod) store().setTool(store().tool === 'draw' ? 'select' : 'draw');
      else if (e.key.toLowerCase() === 'z' && !mod) store().setTool(store().tool === 'zone' ? 'select' : 'zone');
      else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        store().select(artifacts.map((a) => a.id));
      } else if (e.key === 'F3') setStats((s) => (s ? null : { fps: 0, worst: 0, dropped: 0 }));
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [artifacts, animateTo, cameraRef, fitContent, screen, store, viewportRef]);

  // --- Stats and bench -------------------------------------------------------

  const statsOn = stats !== null;
  const statsRef = useRef(false);
  statsRef.current = statsOn;
  useEffect(() => {
    if (!statsOn) return;
    let frames = 0;
    let last = performance.now();
    let previous = last;
    let worst = 0;
    let dropped = 0;
    let raf = 0;
    const tick = (t: number) => {
      frames += 1;
      // The gap between frames, not just their count: an average of 60 with one
      // 200 ms stall in it is what a stutter actually looks like, and the count
      // alone hides it.
      const gap = t - previous;
      previous = t;
      if (gap > worst) worst = gap;
      if (gap > 32) dropped += 1;
      if (t - last >= 500) {
        setStats({ fps: Math.round((frames * 1000) / (t - last)), worst: Math.round(worst), dropped });
        frames = 0;
        worst = 0;
        dropped = 0;
        last = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [statsOn]);

  useEffect(() => {
    const run = () => {
      void runBench({ artifacts: artifacts.length, panBy, zoomAt, setCamera, viewport: viewportRef.current, fit: fitContent }).then(
        (report) => {
          api.bench.report(report);
          store().notify(
            'Бенч: ' + report.avgFps + ' FPS в среднем, p95 кадра ' + report.p95FrameMs + ' мс, максимум в DOM ' + report.maxMounted,
          );
        },
      );
    };
    window.addEventListener('zmtki:bench', run);
    return () => window.removeEventListener('zmtki:bench', run);
  }, [artifacts.length, panBy, zoomAt, setCamera, viewportRef, fitContent, store]);

  useEffect(() => {
    if (api.bench.autorun > 0 && board.title.startsWith('Бенч') && screen.width > 2) {
      const timer = window.setTimeout(() => window.dispatchEvent(new Event('zmtki:bench')), 1200);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [board.title, screen.width]);

  // --- Render ----------------------------------------------------------------

  // The transform, the grid tile, the label scale and the HUD's percentage are
  // written by the camera itself and inherited by anything React adds later, so
  // there is nothing about the view to compute here.
  const connectFrom = gesture?.kind === 'connect' ? byId.get(gesture.fromId) : undefined;
  const draggingIds = gesture?.kind === 'move' && gesture.moved ? gesture.start : null;
  const empty = artifacts.length === 0 && ghosts.length === 0 && !placementRect;

  return (
    <div
      ref={viewportRef}
      // `is-moving` is not here: the camera adds and removes it on the element
      // itself, so a gesture starting or ending costs no render of the board.
      className={
        'board-viewport' +
        (gesture?.kind === 'pan' ? ' is-panning' : '') +
        (gesture && gesture.kind !== 'pan' ? ' is-gesturing' : '') +
        (tool === 'draw' ? ' tool-draw' : '') +
        (tool === 'zone' ? ' tool-zone' : '') +
        (placement && placement.mode !== 'press' ? ' is-placing' : '')
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      // Native HTML drag of a link, an image or selected text inside a card
      // would take the pointer away mid-move; only kanban cards use it.
      onDragStart={(e) => {
        if (!(e.target as Element).closest?.('.kanban-card')) e.preventDefault();
      }}
    >
      <OverviewLayer
        active={overview}
        isMoving={isMoving}
        index={index}
        segments={overviewSegments}
        cameraRef={cameraRef}
        screen={screen}
        subscribeFrame={subscribeFrame}
      />
      <div ref={sceneRef} className="board-scene">
        {/* Drawn in board units and carried by the scene's transform: the dots
            stay put relative to the work instead of being repainted per frame. */}
        <div ref={gridRef} className="board-grid" />
        <ZoneShapes zones={board.state.zones} selectedId={zoneSelection} />
        {visibleArrows.length > 0 && (
          <ArrowLayer
            arrows={visibleArrows}
            artifacts={arrowArtifacts}
            zoom={restZoom}
            selectedId={selectedArrow ?? undefined}
            onSelect={(id) => store().selectArrow(id)}
            onAddBend={(arrowId, index, point) => {
              const arrow = board.state.arrows.find((a) => a.id === arrowId);
              if (!arrow) return;
              // Where along the line it was added, not at the end: appending put
              // the new corner after the last one and the arrow doubled back.
              const bends = [...arrow.bends];
              bends.splice(Math.min(index, bends.length), 0, point);
              void api.arrows.update(board.id, arrowId, { bends });
            }}
            onDragBend={(arrowId, bendIndex, point, commit) => {
              const arrow = board.state.arrows.find((a) => a.id === arrowId);
              if (!arrow) return;
              const bends = arrow.bends.map((b, i) => (i === bendIndex ? point : b));
              // While it is moving the board is updated once per frame, so the
              // line follows the finger; the release writes the last position.
              if (!commit) {
                cancelAnimationFrame(bendFrame.current);
                bendFrame.current = requestAnimationFrame(() => void api.arrows.update(board.id, arrowId, { bends }));
                return;
              }
              cancelAnimationFrame(bendFrame.current);
              void api.arrows.update(board.id, arrowId, { bends });
            }}
            onReattach={(arrowId, end, artifactId, point) => {
              const arrow = board.state.arrows.find((a) => a.id === arrowId);
              if (!arrow) return;
              const current = end === 'from' ? arrow.from.artifactId : arrow.to.artifactId;
              const targetId = artifactId ?? current;
              const target = byId.get(targetId);
              if (!target) return;
              const other = end === 'from' ? arrow.to.artifactId : arrow.from.artifactId;
              if (targetId === other) return;
              // Which side it now leaves from: the one the release point is
              // nearest to, and how far along that side it landed.
              const left = point.x - target.x;
              const right = target.x + target.width - point.x;
              const top = point.y - target.y;
              const bottom = target.y + target.height - point.y;
              const nearest = Math.min(left, right, top, bottom);
              const side = nearest === left ? 'left' : nearest === right ? 'right' : nearest === top ? 'top' : 'bottom';
              const offset =
                side === 'left' || side === 'right'
                  ? Math.min(1, Math.max(0, (point.y - target.y) / Math.max(1, target.height)))
                  : Math.min(1, Math.max(0, (point.x - target.x) / Math.max(1, target.width)));
              void api.arrows.update(
                board.id,
                arrowId,
                end === 'from'
                  ? { fromId: targetId, fromSide: side, fromOffset: offset, bends: [] }
                  : { toId: targetId, toSide: side, toOffset: offset, bends: [] },
              );
            }}
            onRemoveBend={(arrowId, bendIndex) => {
              const arrow = board.state.arrows.find((a) => a.id === arrowId);
              if (arrow) void api.arrows.update(board.id, arrowId, { bends: arrow.bends.filter((_, i) => i !== bendIndex) });
            }}
            toWorld={(ev) => toWorld(ev.clientX, ev.clientY)}
          />
        )}
        {mounted.map((artifact) => (
          <ArtifactNode
            key={artifact.id}
            artifact={artifact}
            boardId={board.id}
            selected={selectedIds.has(artifact.id)}
            dragging={!!draggingIds?.has(artifact.id)}
            level={level}
            hidden={!inViewIds.has(artifact.id) && !selectedIds.has(artifact.id) && !drafts[artifact.id] && !motion[artifact.id]}
            renderScale={1}
            agent={agentByArtifact.get(artifact.id)}
          />
        ))}
        {ghosts.map((ghost) => (
          <GhostNode key={ghost.key} ghost={ghost} />
        ))}
        {placementRect && placement && <PlacementGhost rect={placementRect} label={placement.label} />}
        {connectFrom && gesture?.kind === 'connect' && (
          <svg className="connect-preview" style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible' }}>
            <line
              x1={connectFrom.x + connectFrom.width / 2}
              y1={connectFrom.y + connectFrom.height / 2}
              x2={gesture.point.x}
              y2={gesture.point.y}
              // Screen-sized through `vector-effect` rather than divided by the
              // zoom here, so the preview does not rewrite its own attributes
              // on every frame of a zoom.
              stroke="#ff7a3d"
              strokeWidth={2}
              strokeDasharray="6 4"
            />
          </svg>
        )}
        {gesture?.kind === 'zone' && (
          <div
            className={'zone-sweep' + (gesture.subtract ? ' zone-sweep--cut' : '')}
            style={{
              transform:
                'translate(' + Math.min(gesture.origin.x, gesture.point.x) + 'px,' + Math.min(gesture.origin.y, gesture.point.y) + 'px)',
              width: Math.abs(gesture.point.x - gesture.origin.x),
              height: Math.abs(gesture.point.y - gesture.origin.y),
            }}
          />
        )}
        {gesture?.kind === 'marquee' && (
          <div
            className="marquee"
            style={{
              transform:
                'translate(' + Math.min(gesture.origin.x, gesture.point.x) + 'px,' + Math.min(gesture.origin.y, gesture.point.y) + 'px)',
              width: Math.abs(gesture.point.x - gesture.origin.x),
              height: Math.abs(gesture.point.y - gesture.origin.y),
            }}
          />
        )}

        {/* The legend: zone names and agent labels, which keep their size on
            screen while the board shrinks. `--label-scale` is written on this
            one element per frame, and only what is inside it is invalidated —
            an inherited variable on the scene would have cost a style recalc of
            every card on the board on every frame of a zoom. */}
        <div ref={labelsRef} className="board-labels">
          <ZoneLabels
            zones={board.state.zones}
            boardId={board.id}
            selectedId={zoneSelection}
            editing={tool === 'zone'}
            onSelect={(id) => store().selectZone(id)}
          />
          <AgentMarkers agents={agents} onFocus={(agent) => store().focusArtifact(agent.artifactId)} />
        </div>
      </div>

      {/* Shown by CSS while the board moves or is dragged. Everything under it
          stops being hit-tested and stops reacting to hover for the length of
          the gesture, at the cost of one element — the rules it replaces set
          `pointer-events` and a cursor on every mounted card and every one of
          their descendants, twice per gesture. */}
      <div className="gesture-shield" />

      {empty && (
        <div className="empty-board">
          <Logo className="empty-logo" />
          <div className="empty-text">
            Перетащите блок из «+ Блок» на доску
            <br />
            или запустите агента в панели справа
          </div>
        </div>
      )}

      <div className="hud" onPointerDown={(e) => e.stopPropagation()}>
        <button className="hud-btn" title="Отдалить" onClick={() => zoomToCenter(1 / 1.3)}>−</button>
        <button
          className="hud-btn hud-zoom"
          title="Масштаб 100% (0)"
          onClick={() => {
            const c = cameraRef.current;
            const cx = (screen.width / 2 - c.x) / c.zoom;
            const cy = (screen.height / 2 - c.y) / c.zoom;
            animateTo({ zoom: 1, x: screen.width / 2 - cx, y: screen.height / 2 - cy });
          }}
        >
          {/* Written as text by the camera loop: the percentage follows every
              frame of a zoom without React hearing about the camera at all. */}
          <span ref={zoomLabelRef}>{Math.round(restZoom * 100)}%</span>
        </button>
        <button className="hud-btn" title="Приблизить" onClick={() => zoomToCenter(1.3)}>+</button>
        <button className="hud-btn" title="Вписать всё (F)" onClick={fitContent}>⤢</button>
        <button
          className={'hud-btn hud-toggle' + (overviewArrows ? ' is-on' : '')}
          title={
            overviewArrows
              ? 'Стрелки видны и при отдалении. Выключить — они пропадают вместе с карточками'
              : 'Стрелки пропадают при отдалении. Включить — остаются видны на общем плане'
          }
          aria-pressed={overviewArrows}
          onClick={toggleOverviewArrows}
        >
          ↗
        </button>
        <span className="hud-sep" />
        <span className="hud-info" title="Смонтировано в DOM / всего артефактов (F3 — FPS)">
          {overview ? 'обзор' : level === 'full' ? 'детально' : 'упрощённо'} · DOM {mounted.length}/{artifacts.length}
          {stats ? ' · ' + stats.fps + ' FPS · худший кадр ' + stats.worst + ' мс · просадок ' + stats.dropped : ''}
          {stats && wheelInfo
            ? ' · колесо ' + wheelInfo.dx + '/' + wheelInfo.dy + (wheelInfo.notch ? ' (щелчки)' : ' (тачпад)')
            : ''}
        </span>
      </div>
    </div>
  );
};
