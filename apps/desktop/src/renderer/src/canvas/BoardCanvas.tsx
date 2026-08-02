import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnect,
  type Viewport
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  anchorToSide,
  createEdge,
  nearestSides,
  type BoardNode,
  type EdgeSide,
  type Style
} from '@zmtki/board-schema';
import type { BoardOp } from '@zmtki/protocol';
import { submit, useStore, type ToolName } from '../store.js';
import { nodeTypes, type CanvasNodeData } from './nodeTypes.js';
import { BoardMiniMapNode } from './minimapNode.js';
import { boundsOfPoints, strokeToPath, type StrokePoint } from './freehand.js';
import { newNodeId } from './ids.js';
import { isStickerDrag, readStickerDragData } from '../stickers/drag.js';
import { isAgentDrag, readAgentDragData } from '../agents/drag.js';
import {
  ENTER_MS,
  EXIT_MS,
  TELEPORT_DISTANCE,
  TELEPORT_IN_MS,
  TELEPORT_OUT_MS,
  joinClassNames,
  motionDistance,
  type MotionClass
} from './nodeMotion.js';

/** Below this zoom the heavy artifact bodies are replaced with a summary line. */
const DETAIL_ZOOM = 0.42;
const SNAP_THRESHOLD = 6;

// Hoisted so React Flow does not see a new prop object on every render.
const PAN_BUTTONS = [1, 2];
const PRO_OPTIONS = { hideAttribution: true };
const DELETE_KEYS = ['Delete', 'Backspace'];
const MULTI_SELECT_KEY = 'Shift';
const SELECTION_KEY = 'Shift';

interface Guide {
  axis: 'x' | 'y';
  position: number;
}

/**
 * Cache of the `data` and `style` objects handed to React Flow.
 *
 * Node views are memoised, so they only stay memoised if these props keep
 * their identity between renders. Rebuilding them for every node on every
 * render would make the memo useless and re-render the whole board — including
 * the expensive artifact bodies — whenever anything at all changed.
 */
type NodeCache = Map<string, { node: BoardNode; detailed: boolean; data: CanvasNodeData; style: { width: number; height: number } }>;

function toFlowNodes(
  nodes: Iterable<BoardNode>,
  selected: ReadonlySet<string>,
  detailed: boolean,
  cache: NodeCache,
  motionClasses?: ReadonlyMap<string, string>
): Node[] {
  const out: Node[] = [];
  for (const node of nodes) {
    if (node.hidden) continue;

    let entry = cache.get(node.id);
    if (!entry || entry.node !== node || entry.detailed !== detailed) {
      entry = {
        node,
        detailed,
        data: { node, detailed } satisfies CanvasNodeData,
        style: { width: node.size.w, height: node.size.h }
      };
      cache.set(node.id, entry);
    }

    const baseClass =
      node.type === 'frame' ? 'rf-agent-frame' : node.type === 'group' ? 'rf-group' : 'rf-board-node';
    out.push({
      id: node.id,
      type: node.type,
      position: node.position,
      width: node.size.w,
      height: node.size.h,
      // NodeResizer starts from measured — if missing it treats size as 0 and
      // the box collapses to minWidth/minHeight on the first drag frame.
      measured: { width: node.size.w, height: node.size.h },
      selected: selected.has(node.id),
      draggable: !node.locked,
      selectable: !node.locked,
      // Frames sit *below* artifacts so the border never paints over cards.
      // Frame badge uses NodeToolbar (viewport portal) to stay readable on top.
      // Groups stay further back so their fill doesn't tint content.
      zIndex: node.type === 'frame' ? -200 + node.z : node.type === 'group' ? -1000 + node.z : node.z,
      className: joinClassNames(baseClass, motionClasses?.get(node.id)),
      data: entry.data,
      style: entry.style
    });
  }
  return out;
}

function minimapColor(node: Node): string {
  const data = node.data as CanvasNodeData;
  const boardNode = data.node;
  if (boardNode.type === 'frame') return 'transparent';
  if (boardNode.type === 'sticky') return boardNode.style.fill || '#e8c96a';
  if (boardNode.type === 'sticker') return '#7c9cff';
  if (boardNode.type === 'text') return 'transparent';
  if (boardNode.type === 'shape') return boardNode.style.fill || '#4a5268';
  if (boardNode.type === 'group') return 'transparent';
  if (boardNode.type === 'freehand') return 'transparent';
  if (boardNode.type === 'artifact') {
    switch (boardNode.artifact.kind) {
      case 'terminal':
        return '#1e2430';
      case 'browser':
      case 'appView':
      case 'demo':
        return '#243044';
      case 'file':
      case 'fileFragment':
      case 'diff':
        return '#3a4558';
      case 'image':
        return '#2a3348';
      case 'markdown':
      case 'todo':
      case 'status':
        return '#2c3344';
      default:
        return '#353d52';
    }
  }
  return '#4a5268';
}

function minimapStroke(node: Node): string {
  const data = node.data as CanvasNodeData;
  const boardNode = data.node;
  if (boardNode.type === 'frame') return boardNode.style.stroke || '#6b8afd';
  if (boardNode.type === 'text') return '#8b919d';
  if (boardNode.type === 'group') return boardNode.accent || '#6ea8fe';
  if (boardNode.type === 'freehand') return boardNode.style.stroke || '#8b919d';
  return 'transparent';
}

function CanvasInner(): JSX.Element {
  const board = useStore((s) => s.activeBoard());
  const boardId = useStore((s) => s.activeBoardId);
  const selection = useStore((s) => s.selection);
  const setSelection = useStore((s) => s.setSelection);
  const tool = useStore((s) => s.tool);
  const overlayOpen = useStore((s) => s.overlayOpen);
  const setTool = useStore((s) => s.setTool);
  const setEditingNode = useStore((s) => s.setEditingNode);
  const setCameraLocal = useStore((s) => s.setCameraLocal);
  const nodeCache = useRef<NodeCache>(new Map());
  const setCommentTarget = useStore((s) => s.setCommentTarget);

  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [draft, setDraft] = useState<{
    kind: 'shape' | 'frame';
    tool: ToolName;
    start: { x: number; y: number };
    current: { x: number; y: number };
  } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [stroke, setStroke] = useState<StrokePoint[]>([]);
  const strokeRef = useRef(stroke);
  strokeRef.current = stroke;
  const drawStyle = useStore((s) => s.drawStyle);
  const styleRef = useRef<Style>(drawStyle);
  styleRef.current = drawStyle;

  /**
   * The live viewport lives in a ref, not in the store.
   *
   * Panning fires continuously, and routing every frame through the store
   * replaced the whole board object, which rebuilt every node and re-rendered
   * every artifact at 60fps. The store copy is refreshed only when panning
   * settles, which is all the rest of the app needs.
   */
  const viewport = useRef<Viewport>(board?.camera ?? { x: 0, y: 0, zoom: 1 });
  const [detailed, setDetailed] = useState((board?.camera.zoom ?? 1) >= DETAIL_ZOOM);

  // Depending on the collections rather than the board keeps unrelated board
  // changes, such as a camera write, from rebuilding every node.
  const boardNodes = board?.nodes;
  const boardEdges = board?.edges;

  const selectedIds = useMemo(() => new Set(selection), [selection]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const nodesRef = useRef<Node[]>([]);
  nodesRef.current = nodes;
  /** Ids currently mid-drag; board sync must not clobber their live positions. */
  const draggingIds = useRef(new Set<string>());
  const resizingIds = useRef(new Set<string>());
  /** Keep live geometry until the board document catches up after resize. */
  const pendingResize = useRef(
    new Map<string, { position: { x: number; y: number }; width: number; height: number }>
  );
  /** Last known board positions — used to detect enter / teleport. */
  const prevBoardPos = useRef(new Map<string, { x: number; y: number }>());
  /** Board node ids from the previous successful sync (exit detection source). */
  const prevBoardIds = useRef(new Set<string>());
  /** Nodes kept briefly after removeNode so exit animation can play. */
  const exitingNodes = useRef(
    new Map<string, { node: Node; until: number }>()
  );
  /** Large moves: hold old position while fading out, then jump + fade in. */
  const teleportHold = useRef(
    new Map<
      string,
      { from: { x: number; y: number }; to: { x: number; y: number }; phase: 'out' | 'in'; until: number }
    >()
  );
  const motionClass = useRef(new Map<string, MotionClass>());
  const motionTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [motionTick, setMotionTick] = useState(0);

  const scheduleMotionClear = useCallback((id: string, ms: number, after?: () => void) => {
    const prev = motionTimers.current.get(id);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      motionTimers.current.delete(id);
      after?.();
      setMotionTick((t) => t + 1);
    }, ms);
    motionTimers.current.set(id, timer);
  }, []);

  // Reset motion bookkeeping when switching boards so exits don't replay.
  useEffect(() => {
    for (const timer of motionTimers.current.values()) clearTimeout(timer);
    motionTimers.current.clear();
    prevBoardIds.current = new Set();
    prevBoardPos.current.clear();
    exitingNodes.current.clear();
    teleportHold.current.clear();
    motionClass.current.clear();
    nodeCache.current.clear();
    setNodes([]);
  }, [boardId]);

  // Mirror the board document into React Flow nodes. While a drag is active we
  // keep the live positions from local state so a store re-render (guides,
  // agent status, …) cannot snap the node back to its start point.
  // Enter / exit / long-range teleport animations are layered on top.
  useEffect(() => {
    const now = Date.now();
    // Drop finished exit ghosts.
    for (const [id, ghost] of [...exitingNodes.current]) {
      if (ghost.until <= now) {
        exitingNodes.current.delete(id);
        motionClass.current.delete(id);
        nodeCache.current.delete(id);
        prevBoardPos.current.delete(id);
      }
    }
    // Advance teleport phases.
    for (const [id, hold] of [...teleportHold.current]) {
      if (hold.until > now) continue;
      if (hold.phase === 'out') {
        hold.phase = 'in';
        hold.until = now + TELEPORT_IN_MS;
        motionClass.current.set(id, 'rf-teleport-in');
        scheduleMotionClear(id, TELEPORT_IN_MS, () => {
          teleportHold.current.delete(id);
          if (motionClass.current.get(id) === 'rf-teleport-in') {
            motionClass.current.delete(id);
          }
        });
      } else {
        teleportHold.current.delete(id);
        if (motionClass.current.get(id) === 'rf-teleport-in') {
          motionClass.current.delete(id);
        }
      }
    }

    const next = boardNodes
      ? toFlowNodes(
          boardNodes.values(),
          selectedIds,
          detailed,
          nodeCache.current,
          motionClass.current
        )
      : [];
    const nextById = new Map(next.map((n) => [n.id, n]));
    const nextIds = new Set(nextById.keys());

    // Exits: compare previous *board* ids — never RF prev (ghosts would re-exit forever).
    setNodes((prev) => {
      const prevRf = new Map(prev.map((n) => [n.id, n]));
      for (const id of prevBoardIds.current) {
        if (nextIds.has(id) || exitingNodes.current.has(id)) continue;
        if (draggingIds.current.has(id)) continue;
        const old = prevRf.get(id);
        if (!old) {
          prevBoardPos.current.delete(id);
          continue;
        }
        const baseClass =
          old.type === 'frame' ? 'rf-agent-frame' : old.type === 'group' ? 'rf-group' : 'rf-board-node';
        exitingNodes.current.set(id, {
          node: {
            ...old,
            className: joinClassNames(baseClass, 'rf-exit'),
            draggable: false,
            selectable: false
          },
          until: now + EXIT_MS
        });
        motionClass.current.set(id, 'rf-exit');
        scheduleMotionClear(id, EXIT_MS, () => {
          exitingNodes.current.delete(id);
          motionClass.current.delete(id);
          nodeCache.current.delete(id);
          prevBoardPos.current.delete(id);
        });
      }

      // Enters + teleports against previous board positions.
      for (const n of next) {
        if (draggingIds.current.has(n.id) || resizingIds.current.has(n.id)) {
          prevBoardPos.current.set(n.id, { ...n.position });
          continue;
        }
        const prevPos = prevBoardPos.current.get(n.id);
        if (!prevPos) {
          // Only animate enter when the board already had nodes (not first paint).
          if (!motionClass.current.has(n.id) && prevBoardIds.current.size > 0) {
            motionClass.current.set(n.id, 'rf-enter');
            scheduleMotionClear(n.id, ENTER_MS, () => {
              if (motionClass.current.get(n.id) === 'rf-enter') {
                motionClass.current.delete(n.id);
              }
            });
          }
        } else {
          const dist = motionDistance(prevPos, n.position);
          if (
            dist >= TELEPORT_DISTANCE &&
            !teleportHold.current.has(n.id) &&
            motionClass.current.get(n.id) !== 'rf-teleport-out'
          ) {
            teleportHold.current.set(n.id, {
              from: { ...prevPos },
              to: { ...n.position },
              phase: 'out',
              until: now + TELEPORT_OUT_MS
            });
            motionClass.current.set(n.id, 'rf-teleport-out');
            scheduleMotionClear(n.id, TELEPORT_OUT_MS);
          }
        }
        const hold = teleportHold.current.get(n.id);
        if (!hold || hold.phase === 'in') {
          prevBoardPos.current.set(n.id, { ...n.position });
        }
      }

      prevBoardIds.current = new Set(nextIds);

      const decorated = next.map((n) => {
        const hold = teleportHold.current.get(n.id);
        const cls = motionClass.current.get(n.id);
        let position = n.position;
        if (hold?.phase === 'out') position = hold.from;
        const baseClass =
          n.type === 'frame' ? 'rf-agent-frame' : n.type === 'group' ? 'rf-group' : 'rf-board-node';
        return {
          ...n,
          position,
          className: joinClassNames(baseClass, cls)
        };
      });

      const ghosts = [...exitingNodes.current.values()].map((g) => {
        const baseClass =
          g.node.type === 'frame'
            ? 'rf-agent-frame'
            : g.node.type === 'group'
              ? 'rf-group'
              : 'rf-board-node';
        return {
          ...g.node,
          className: joinClassNames(baseClass, 'rf-exit')
        };
      });

      let merged = [...decorated, ...ghosts];
      if (
        draggingIds.current.size > 0 ||
        resizingIds.current.size > 0 ||
        pendingResize.current.size > 0
      ) {
        const live = new Map(prev.map((n) => [n.id, n]));
        merged = merged.map((n) => {
          const prevNode = live.get(n.id);
          const pending = pendingResize.current.get(n.id);
          // Drop pending once the board document matches what we committed.
          if (pending && boardNodes) {
            const boardNode = boardNodes.get(n.id);
            if (
              boardNode &&
              Math.abs(boardNode.position.x - pending.position.x) < 0.5 &&
              Math.abs(boardNode.position.y - pending.position.y) < 0.5 &&
              Math.abs(boardNode.size.w - pending.width) < 0.5 &&
              Math.abs(boardNode.size.h - pending.height) < 0.5
            ) {
              pendingResize.current.delete(n.id);
            }
          }
          if (draggingIds.current.has(n.id) && prevNode) {
            return {
              ...n,
              position: prevNode.position,
              measured: prevNode.measured ?? n.measured
            };
          }
          if (resizingIds.current.has(n.id) && prevNode) {
            const width = prevNode.width ?? prevNode.measured?.width;
            const height = prevNode.height ?? prevNode.measured?.height;
            return {
              ...n,
              position: prevNode.position,
              width,
              height,
              measured: prevNode.measured ?? { width, height },
              style: {
                ...n.style,
                width,
                height
              },
              className: joinClassNames(n.className, 'resizing')
            };
          }
          const hold = pendingResize.current.get(n.id);
          if (hold) {
            return {
              ...n,
              position: hold.position,
              width: hold.width,
              height: hold.height,
              measured: { width: hold.width, height: hold.height },
              style: { ...n.style, width: hold.width, height: hold.height }
            };
          }
          return n;
        });
      }
      return merged;
    });
  }, [boardNodes, selectedIds, detailed, motionTick, scheduleMotionClear]);

  // Board edges can also anchor to a free point; React Flow only renders
  // node-to-node links, so floating ones are skipped here.
  // Missing anchors → nearest faces between current node boxes.
  const edges: Edge[] = useMemo(() => {
    if (!boardEdges) return [];
    const nodes = boardNodes ? [...boardNodes.values()] : [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return [...boardEdges.values()]
      .filter((edge) => {
        const s = edge.from.nodeId;
        const t = edge.to.nodeId;
        // Skip orphan arrows (endpoint node already gone).
        return Boolean(s && t && byId.has(s) && byId.has(t));
      })
      .map((edge) => {
        const sourceId = edge.from.nodeId as string;
        const targetId = edge.to.nodeId as string;
        const fromNode = byId.get(sourceId)!;
        const toNode = byId.get(targetId)!;
        let sourceHandle: EdgeSide | undefined = anchorToSide(edge.from.anchor) ?? undefined;
        let targetHandle: EdgeSide | undefined = anchorToSide(edge.to.anchor) ?? undefined;
        if ((!sourceHandle || !targetHandle) && fromNode && toNode) {
          const nearest = nearestSides(fromNode, toNode);
          sourceHandle ??= nearest.from;
          targetHandle ??= nearest.to;
        }
        return {
          id: edge.id,
          source: sourceId,
          target: targetId,
          sourceHandle,
          targetHandle,
          label: edge.label,
          type:
            edge.routing === 'straight'
              ? 'straight'
              : edge.routing === 'orthogonal'
                ? 'step'
                : 'default',
          markerEnd: edge.endArrow === 'none' ? undefined : { type: MarkerType.ArrowClosed },
          style: {
            stroke: edge.style.stroke,
            strokeWidth: edge.style.strokeWidth,
            strokeDasharray:
              edge.style.strokeStyle === 'dashed'
                ? '8 6'
                : edge.style.strokeStyle === 'dotted'
                  ? '1 5'
                  : undefined
          }
        };
      });
  }, [boardEdges, boardNodes]);

  const apply = useCallback(
    (ops: BoardOp[], label?: string) => {
      if (!boardId || ops.length === 0) return;
      void submit({ type: 'board.apply', boardId, ops, ...(label ? { label } : {}) });
    },
    [boardId]
  );

  /**
   * Alignment guides. Computed against node edges and centres while dragging,
   * and the drag position is nudged onto a guide when it is close enough.
   */
  const snap = useCallback(
    (id: string, position: { x: number; y: number }): { x: number; y: number } => {
      if (!board) return position;
      const moving = board.nodes.get(id);
      if (!moving) return position;

      const candidatesX: number[] = [];
      const candidatesY: number[] = [];
      for (const other of board.nodes.values()) {
        if (other.id === id || other.hidden) continue;
        candidatesX.push(other.position.x, other.position.x + other.size.w / 2, other.position.x + other.size.w);
        candidatesY.push(other.position.y, other.position.y + other.size.h / 2, other.position.y + other.size.h);
      }

      const found: Guide[] = [];
      let { x, y } = position;
      const { zoom } = viewport.current;

      for (const edgeX of [x, x + moving.size.w / 2, x + moving.size.w]) {
        const hit = candidatesX.find((c) => Math.abs(c - edgeX) < SNAP_THRESHOLD / zoom);
        if (hit === undefined) continue;
        x += hit - edgeX;
        found.push({ axis: 'x', position: hit });
        break;
      }
      for (const edgeY of [y, y + moving.size.h / 2, y + moving.size.h]) {
        const hit = candidatesY.find((c) => Math.abs(c - edgeY) < SNAP_THRESHOLD / zoom);
        if (hit === undefined) continue;
        y += hit - edgeY;
        found.push({ axis: 'y', position: hit });
        break;
      }

      setGuides(found);
      return { x, y };
    },
    [board]
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!board) return;
      const ops: BoardOp[] = [];
      const moves: Array<{ id: string; position: { x: number; y: number } }> = [];
      const nextSelection = new Set(selection);
      const resizeEnded = new Map<string, { w: number; h: number }>();

      // NodeResizer emits position + dimensions together. Mark the whole batch
      // first so we never treat a resize nudge as a finished drag/move.
      for (const change of changes) {
        if (change.type !== 'dimensions') continue;
        if (change.resizing) resizingIds.current.add(change.id);
        else {
          resizingIds.current.delete(change.id);
          if (change.dimensions) {
            resizeEnded.set(change.id, {
              w: change.dimensions.width,
              h: change.dimensions.height
            });
          }
        }
      }

      const adjusted: NodeChange[] = changes.map((change) => {
        if (change.type !== 'position' || !change.position) return change;

        // While resizing (or finishing a resize), keep the raw position from
        // NodeResizer — snapping against the pre-resize size makes the box jump.
        if (resizingIds.current.has(change.id) || resizeEnded.has(change.id)) {
          return change;
        }

        const position = snap(change.id, change.position);
        if (change.dragging) {
          draggingIds.current.add(change.id);
        } else {
          draggingIds.current.delete(change.id);
          moves.push({ id: change.id, position });
        }
        return { ...change, position };
      });

      // Ensure NodeResizer never starts from measured=0: seed from width/height
      // before applying dimension changes for this frame.
      const seeded = nodesRef.current.map((n) => {
        if (n.measured?.width && n.measured?.height) return n;
        const width = n.width ?? n.style?.width;
        const height = n.height ?? n.style?.height;
        if (typeof width !== 'number' || typeof height !== 'number') return n;
        return { ...n, measured: { width, height } };
      });

      // Apply against the latest nodes synchronously so the commit below reads
      // the same geometry the pointer just produced (esp. top/left handles).
      const next = applyNodeChanges(adjusted, seeded).map((n) => {
        const isResizing = resizingIds.current.has(n.id);
        const hasFlag = typeof n.className === 'string' && /\bresizing\b/.test(n.className);
        if (isResizing && !hasFlag) {
          return { ...n, className: joinClassNames(n.className, 'resizing') };
        }
        if (!isResizing && hasFlag) {
          return { ...n, className: n.className!.replace(/\bresizing\b/g, '').trim() || undefined };
        }
        return n;
      });
      nodesRef.current = next;
      setNodes(next);

      for (const [id, size] of resizeEnded) {
        const live = next.find((n) => n.id === id);
        const position = live?.position ?? { x: 0, y: 0 };
        const width = live?.width ?? live?.measured?.width ?? size.w;
        const height = live?.height ?? live?.measured?.height ?? size.h;
        pendingResize.current.set(id, { position, width, height });
        // One atomic op: size + origin. Splitting into resize+move let the
        // board snap back with the new size at the old origin (looks inverted).
        ops.push({
          op: 'resizeNode',
          id,
          size: { w: width, h: height },
          position
        });
      }

      for (const change of changes) {
        if (change.type === 'select') {
          if (change.selected) nextSelection.add(change.id);
          else nextSelection.delete(change.id);
        }
        if (change.type === 'remove') {
          ops.push({ op: 'removeNode', id: change.id });
          pendingResize.current.delete(change.id);
        }
      }

      if (moves.length > 0) {
        setGuides([]);
        ops.push({ op: 'moveNodes', moves });
      }
      const label =
        resizeEnded.size > 0 ? 'Размер' : moves.length > 0 ? 'Перемещение' : undefined;
      apply(ops, label);

      const selectionChanged =
        nextSelection.size !== selection.length || selection.some((id) => !nextSelection.has(id));
      if (selectionChanged) setSelection([...nextSelection]);
    },
    [apply, board, selection, setSelection, snap]
  );

  const onConnect: OnConnect = useCallback(
    (connection) => {
      if (!connection.source || !connection.target) return;
      apply([{ op: 'addEdge', edge: createEdge(connection.source, connection.target) }], 'Связь');
    },
    [apply]
  );

  const settleTimer = useRef(0);

  const onMove = useCallback(
    (_event: unknown, next: Viewport) => {
      viewport.current = next;

      // Semantic zoom flips on a threshold, so nodes are only rebuilt when the
      // detail level actually changes rather than on every wheel tick.
      const nextDetailed = next.zoom >= DETAIL_ZOOM;
      setDetailed((prev) => (prev === nextDetailed ? prev : nextDetailed));

      if (!boardId) return;
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        const camera = { x: next.x, y: next.y, zoom: next.zoom };
        setCameraLocal(boardId, camera);
        void submit({ type: 'camera.set', boardId, camera });
      }, 400);
    },
    [boardId, setCameraLocal]
  );

  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  const screenToBoard = useCallback(
    (event: React.MouseEvent): { x: number; y: number } =>
      flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    [flow]
  );

  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      const point = screenToBoard(event);

      if (tool === 'sticky') {
        const id = newNodeId();
        apply(
          [
            {
              op: 'addNode',
              node: {
                id,
                type: 'sticky',
                text: '',
                position: { x: point.x - 90, y: point.y - 70 },
                size: { w: 180, h: 140 },
                rotation: 0,
                layerId: 'lyr_default',
                z: 0,
                locked: false,
                hidden: false,
                parentId: null,
                createdBy: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                rev: 0,
                meta: {},
                style: { ...styleRef.current, fill: '#f5d97a', color: '#1b1d24' }
              }
            }
          ],
          'Стикер'
        );
        setEditingNode(id);
        setTool('select');
        return;
      }

      if (tool === 'text') {
        const id = newNodeId();
        apply(
          [
            {
              op: 'addNode',
              node: {
                id,
                type: 'text',
                text: '',
                position: point,
                size: { w: 220, h: 40 },
                rotation: 0,
                layerId: 'lyr_default',
                z: 0,
                locked: false,
                hidden: false,
                parentId: null,
                createdBy: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                rev: 0,
                meta: {},
                style: { ...styleRef.current, fontSize: 18 }
              }
            }
          ],
          'Текст'
        );
        setEditingNode(id);
        setTool('select');
        return;
      }

      setSelection([]);
      setCommentTarget(null);
    },
    [apply, screenToBoard, setCommentTarget, setEditingNode, setSelection, setTool, tool]
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);

      if (tool === 'draw') {
        const next: StrokePoint[] = [[point.x, point.y, event.pressure || 0.5]];
        strokeRef.current = next;
        setStroke(next);
        return;
      }
      if (tool === 'rect' || tool === 'ellipse' || tool === 'diamond' || tool === 'arrow' || tool === 'line') {
        const next = { kind: 'shape' as const, tool, start: point, current: point };
        draftRef.current = next;
        setDraft(next);
        return;
      }
      if (tool === 'frame') {
        const next = { kind: 'frame' as const, tool, start: point, current: point };
        draftRef.current = next;
        setDraft(next);
      }
    },
    [flow, tool]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const activeDraft = draftRef.current;
      const activeStroke = strokeRef.current;
      if (activeStroke.length === 0 && !activeDraft) return;
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (activeStroke.length > 0) {
        const next: StrokePoint[] = [...activeStroke, [point.x, point.y, event.pressure || 0.5]];
        strokeRef.current = next;
        setStroke(next);
        return;
      }
      if (activeDraft) {
        const next = { ...activeDraft, current: point };
        draftRef.current = next;
        setDraft(next);
      }
    },
    [flow]
  );

  const onPointerUp = useCallback(() => {
    const stroke = strokeRef.current;
    const draft = draftRef.current;
    if (stroke.length > 1) {
      const style = styleRef.current;
      const bounds = boundsOfPoints(stroke, style.strokeWidth * 2 + 4);
      apply(
        [
          {
            op: 'addNode',
            node: {
              id: newNodeId(),
              type: 'freehand',
              points: stroke.map(([x, y, p]) => [x - bounds.x, y - bounds.y, p] as StrokePoint),
              position: { x: bounds.x, y: bounds.y },
              size: { w: bounds.w, h: bounds.h },
              rotation: 0,
              layerId: 'lyr_default',
              z: 0,
              locked: false,
              hidden: false,
              parentId: null,
              createdBy: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              rev: 0,
              meta: {},
              style
            }
          }
        ],
        'Рисунок'
      );
      strokeRef.current = [];
      setStroke([]);
      return;
    }
    strokeRef.current = [];
    setStroke([]);

    if (!draft) return;
    const x = Math.min(draft.start.x, draft.current.x);
    const y = Math.min(draft.start.y, draft.current.y);
    const w = Math.max(24, Math.abs(draft.current.x - draft.start.x));
    const h = Math.max(24, Math.abs(draft.current.y - draft.start.y));
    const base = {
      id: newNodeId(),
      position: { x, y },
      size: { w, h },
      rotation: 0,
      layerId: 'lyr_default',
      z: 0,
      locked: false,
      hidden: false,
      parentId: null,
      createdBy: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rev: 0,
      meta: {},
      style: styleRef.current
    };

    if (draft.kind === 'frame') {
      apply([{ op: 'addNode', node: { ...base, type: 'frame', label: 'Рамка', agentId: null, autoGrow: false } }], 'Рамка');
    } else {
      const shape =
        tool === 'ellipse'
          ? 'ellipse'
          : tool === 'diamond'
            ? 'diamond'
            : tool === 'arrow' || tool === 'line'
              ? 'arrowBlock'
              : 'rectangle';
      apply([{ op: 'addNode', node: { ...base, type: 'shape', shape, text: '' } }], 'Фигура');
    }

    draftRef.current = null;
    setDraft(null);
    setTool('select');
  }, [apply, setTool, tool]);

  const drawing = tool === 'draw' || tool === 'frame' || DRAW_TOOLS.has(tool);

  const onStickerDragOver = useCallback((event: DragEvent) => {
    if (!isStickerDrag(event) && !isAgentDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onStickerDrop = useCallback(
    (event: DragEvent) => {
      if (!boardId) return;
      const agentPayload = readAgentDragData(event);
      if (agentPayload) {
        event.preventDefault();
        const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        void submit({
          type: 'agent.placeFrame',
          agentId: agentPayload.agentId,
          position: { x: point.x - 200, y: point.y - 120 }
        });
        return;
      }
      const payload = readStickerDragData(event);
      if (!payload) return;
      event.preventDefault();
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      void submit({
        type: 'stickers.place',
        boardId,
        packId: payload.packId,
        stickerId: payload.stickerId,
        position: { x: point.x - 64, y: point.y - 64 }
      });
    },
    [boardId, flow]
  );

  if (!board) {
    return <div className="canvas-empty">Откройте или создайте доску</div>;
  }

  // Prefer the live React Flow viewport so draft/guides stay under the cursor
  // even before the first pan updates the ref.
  const view = flow.getViewport();
  viewport.current = view;

  return (
    <div
      ref={wrapper}
      className={`canvas-wrap tool-${tool}`}
      onPointerDown={drawing ? onPointerDown : undefined}
      onPointerMove={drawing ? onPointerMove : undefined}
      onPointerUp={drawing ? onPointerUp : undefined}
      onPointerCancel={drawing ? onPointerUp : undefined}
      onDragOver={onStickerDragOver}
      onDrop={onStickerDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onMove={onMove}
        onPaneClick={onPaneClick}
        defaultViewport={board.camera}
        minZoom={0.05}
        maxZoom={3}
        panOnDrag={tool === 'hand' ? true : PAN_BUTTONS}
        selectionOnDrag={tool === 'select'}
        nodesDraggable={tool === 'select'}
        elementsSelectable={tool === 'select' || tool === 'comment'}
        proOptions={PRO_OPTIONS}
        deleteKeyCode={overlayOpen ? null : DELETE_KEYS}
        multiSelectionKeyCode={overlayOpen ? null : MULTI_SELECT_KEY}
        selectionKeyCode={overlayOpen ? null : SELECTION_KEY}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="#232733" />
        <MiniMap
          pannable
          zoomable
          className="board-minimap"
          nodeColor={minimapColor}
          nodeStrokeColor={minimapStroke}
          nodeStrokeWidth={1}
          nodeComponent={BoardMiniMapNode}
          maskColor="rgb(13 15 20 / 65%)"
          style={{ width: 180, height: 120 }}
        />
      </ReactFlow>

      <svg className="overlay">
        {guides.map((guide, i) =>
          guide.axis === 'x' ? (
            <line
              key={i}
              x1={guide.position * view.zoom + view.x}
              y1={0}
              x2={guide.position * view.zoom + view.x}
              y2="100%"
              className="guide"
            />
          ) : (
            <line
              key={i}
              x1={0}
              y1={guide.position * view.zoom + view.y}
              x2="100%"
              y2={guide.position * view.zoom + view.y}
              className="guide"
            />
          )
        )}
        {draft && (
          <DraftPreview
            draft={draft}
            view={view}
            stroke={styleRef.current.stroke}
            fill={styleRef.current.fill}
          />
        )}
        {stroke.length > 1 && (
          <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
            <path d={strokeToPath(stroke, styleRef.current.strokeWidth)} fill={styleRef.current.stroke} />
          </g>
        )}
      </svg>
    </div>
  );
}

const DRAW_TOOLS = new Set<ToolName>(['rect', 'ellipse', 'diamond', 'arrow', 'line']);

function DraftPreview({
  draft,
  view,
  stroke,
  fill
}: {
  draft: {
    kind: 'shape' | 'frame';
    tool: ToolName;
    start: { x: number; y: number };
    current: { x: number; y: number };
  };
  view: Viewport;
  stroke: string;
  fill: string;
}): JSX.Element {
  const x = Math.min(draft.start.x, draft.current.x) * view.zoom + view.x;
  const y = Math.min(draft.start.y, draft.current.y) * view.zoom + view.y;
  const w = Math.abs(draft.current.x - draft.start.x) * view.zoom;
  const h = Math.abs(draft.current.y - draft.start.y) * view.zoom;
  const common = {
    className: 'draft',
    fill: fill === 'transparent' || !fill ? 'rgba(124, 156, 255, 0.12)' : fill,
    stroke,
    strokeWidth: 1.5,
    strokeDasharray: '5 4',
    fillOpacity: fill === 'transparent' || !fill ? 1 : 0.2
  };

  if (draft.kind === 'frame' || draft.tool === 'rect') {
    return <rect x={x} y={y} width={w} height={h} rx={6} {...common} />;
  }
  if (draft.tool === 'ellipse') {
    return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
  }
  if (draft.tool === 'diamond') {
    const points = `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`;
    return <polygon points={points} {...common} />;
  }
  // arrow / line — stretch a simple shaft with a head
  const x1 = draft.start.x * view.zoom + view.x;
  const y1 = draft.start.y * view.zoom + view.y;
  const x2 = draft.current.x * view.zoom + view.x;
  const y2 = draft.current.y * view.zoom + view.y;
  return (
    <g className="draft-line">
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={1.5} strokeDasharray="5 4" />
      {draft.tool === 'arrow' && w + h > 0 && (
        <polygon
          points={arrowHeadPoints(x1, y1, x2, y2)}
          fill={stroke}
          stroke="none"
          opacity={0.9}
        />
      )}
    </g>
  );
}

function arrowHeadPoints(x1: number, y1: number, x2: number, y2: number): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = 10;
  const a = angle + Math.PI * 0.82;
  const b = angle - Math.PI * 0.82;
  return `${x2},${y2} ${x2 + Math.cos(a) * size},${y2 + Math.sin(a) * size} ${x2 + Math.cos(b) * size},${y2 + Math.sin(b) * size}`;
}

/**
 * The ReactFlowProvider lives at the app root rather than here, so panels
 * outside the canvas — the palette, notifications, the activity feed — share
 * the same flow instance and can move the camera.
 */
export const BoardCanvas = CanvasInner;
