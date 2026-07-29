import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnect,
  type Viewport
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createEdge, type BoardNode, type Style } from '@zmtki/board-schema';
import type { BoardOp } from '@zmtki/protocol';
import { submit, useStore, type ToolName } from '../store.js';
import { nodeTypes, type CanvasNodeData } from './nodeTypes.js';
import { boundsOfPoints, strokeToPath, type StrokePoint } from './freehand.js';
import { newNodeId } from './ids.js';

/** Below this zoom the heavy artifact bodies are replaced with a summary line. */
const DETAIL_ZOOM = 0.42;
const SNAP_THRESHOLD = 6;

// Hoisted so React Flow does not see a new prop object on every render.
const PAN_BUTTONS = [1, 2];
const PRO_OPTIONS = { hideAttribution: true };
const DELETE_KEYS = ['Delete', 'Backspace'];

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
  cache: NodeCache
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

    out.push({
      id: node.id,
      type: node.type,
      position: node.position,
      width: node.size.w,
      height: node.size.h,
      selected: selected.has(node.id),
      draggable: !node.locked,
      selectable: !node.locked,
      // Frames sit behind everything so artifacts placed inside stay reachable.
      zIndex: node.type === 'frame' ? -1000 + node.z : node.z,
      data: entry.data,
      style: entry.style
    });
  }
  return out;
}

function minimapColor(node: Node): string {
  const data = node.data as CanvasNodeData;
  if (data.node.type === 'frame') return data.node.style.stroke;
  if (data.node.type === 'artifact') return '#7c9cff';
  return '#4a5268';
}

function CanvasInner(): JSX.Element {
  const board = useStore((s) => s.activeBoard());
  const boardId = useStore((s) => s.activeBoardId);
  const selection = useStore((s) => s.selection);
  const setSelection = useStore((s) => s.setSelection);
  const tool = useStore((s) => s.tool);
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
    start: { x: number; y: number };
    current: { x: number; y: number };
  } | null>(null);
  const [stroke, setStroke] = useState<StrokePoint[]>([]);
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
  const nodes = useMemo(
    () => (boardNodes ? toFlowNodes(boardNodes.values(), selectedIds, detailed, nodeCache.current) : []),
    [boardNodes, selectedIds, detailed]
  );

  // Board edges can also anchor to a free point; React Flow only renders
  // node-to-node links, so floating ones are skipped here.
  const edges: Edge[] = useMemo(
    () =>
      boardEdges
        ? [...boardEdges.values()]
            .filter((edge) => edge.from.nodeId && edge.to.nodeId)
            .map((edge) => ({
              id: edge.id,
              source: edge.from.nodeId as string,
              target: edge.to.nodeId as string,
              label: edge.label,
              type: edge.routing === 'straight' ? 'straight' : edge.routing === 'orthogonal' ? 'step' : 'default',
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
            }))
        : [],
    [boardEdges]
  );

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

      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          const position = change.dragging ? snap(change.id, change.position) : change.position;
          // Only the drag end is committed; intermediate frames would flood the
          // board file and the agents' change stream.
          if (!change.dragging) moves.push({ id: change.id, position });
        }
        if (change.type === 'dimensions' && change.dimensions && change.resizing === false) {
          ops.push({
            op: 'resizeNode',
            id: change.id,
            size: { w: change.dimensions.width, h: change.dimensions.height }
          });
        }
        if (change.type === 'select') {
          if (change.selected) nextSelection.add(change.id);
          else nextSelection.delete(change.id);
        }
        if (change.type === 'remove') {
          ops.push({ op: 'removeNode', id: change.id });
        }
      }

      if (moves.length > 0) {
        setGuides([]);
        ops.push({ op: 'moveNodes', moves });
      }
      apply(ops, moves.length > 0 ? 'Перемещение' : undefined);

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

      if (tool === 'draw') {
        setStroke([[point.x, point.y, event.pressure || 0.5]]);
        (event.target as Element).setPointerCapture?.(event.pointerId);
        return;
      }
      if (tool === 'rect' || tool === 'ellipse' || tool === 'diamond' || tool === 'arrow' || tool === 'line') {
        setDraft({ kind: 'shape', start: point, current: point });
        return;
      }
      if (tool === 'frame') {
        setDraft({ kind: 'frame', start: point, current: point });
      }
    },
    [flow, tool]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (stroke.length === 0 && !draft) return;
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (stroke.length > 0) {
        setStroke((prev) => [...prev, [point.x, point.y, event.pressure || 0.5]]);
        return;
      }
      if (draft) setDraft({ ...draft, current: point });
    },
    [draft, flow, stroke.length]
  );

  const onPointerUp = useCallback(() => {
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
      setStroke([]);
      return;
    }
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

    setDraft(null);
    setTool('select');
  }, [apply, draft, stroke, setTool, tool]);

  const drawing = tool === 'draw' || tool === 'frame' || DRAW_TOOLS.has(tool);

  if (!board) {
    return <div className="canvas-empty">Откройте или создайте доску</div>;
  }

  // Overlay coordinates come from the live viewport. Everything drawn here is
  // transient — guides, the shape being dragged out, the current stroke — and
  // each already re-renders the component while it is on screen.
  const view = viewport.current;

  return (
    <div
      ref={wrapper}
      className={`canvas-wrap tool-${tool}`}
      onPointerDown={drawing ? onPointerDown : undefined}
      onPointerMove={drawing ? onPointerMove : undefined}
      onPointerUp={drawing ? onPointerUp : undefined}
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
        deleteKeyCode={DELETE_KEYS}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="#232733" />
        <MiniMap
          pannable
          zoomable
          className="board-minimap"
          nodeColor={minimapColor}
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
          <rect
            className="draft"
            x={Math.min(draft.start.x, draft.current.x) * view.zoom + view.x}
            y={Math.min(draft.start.y, draft.current.y) * view.zoom + view.y}
            width={Math.abs(draft.current.x - draft.start.x) * view.zoom}
            height={Math.abs(draft.current.y - draft.start.y) * view.zoom}
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

/**
 * The ReactFlowProvider lives at the app root rather than here, so panels
 * outside the canvas — the palette, notifications, the activity feed — share
 * the same flow instance and can move the camera.
 */
export const BoardCanvas = CanvasInner;
