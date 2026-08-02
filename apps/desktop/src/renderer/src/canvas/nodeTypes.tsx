import { memo, useEffect, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Handle, NodeResizer, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import type { BoardNode, EdgeSide } from '@zmtki/board-schema';
import { artifactRenderer } from '../artifacts/registry.js';
import { submit, useStore } from '../store.js';
import { strokeToPath } from './freehand.js';

export interface CanvasNodeData extends Record<string, unknown> {
  node: BoardNode;
  detailed: boolean;
}

const SIDE_POSITION: Record<EdgeSide, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom
};

/** Four-side ports so edges can attach to nearest or explicit faces. */
function NodePorts({ connectable = true }: { connectable?: boolean } = {}): JSX.Element {
  return (
    <>
      {(Object.keys(SIDE_POSITION) as EdgeSide[]).map((side) => (
        <Handle
          key={`t-${side}`}
          id={side}
          type="target"
          position={SIDE_POSITION[side]}
          className="handle"
          isConnectable={connectable}
        />
      ))}
      {(Object.keys(SIDE_POSITION) as EdgeSide[]).map((side) => (
        <Handle
          key={`s-${side}`}
          id={side}
          type="source"
          position={SIDE_POSITION[side]}
          className="handle"
          isConnectable={connectable}
        />
      ))}
    </>
  );
}

const TONE_LABEL: Record<string, string> = {
  idle: 'ожидает',
  running: 'работает',
  blocked: 'заблокирован',
  success: 'готово',
  warning: 'внимание',
  error: 'ошибка'
};

function useCommitText(nodeId: string): (text: string, field: 'text' | 'label') => void {
  return (text, field) => {
    const boardId = useStore.getState().activeBoardId;
    if (!boardId) return;
    void submit({
      type: 'board.apply',
      boardId,
      label: 'Редактирование текста',
      ops: [{ op: 'updateNode', id: nodeId, patch: { [field]: text } }]
    });
  };
}

/** Inline editor shared by sticky, text and frame titles. */
function EditableText({
  value,
  editing,
  onCommit,
  className,
  style
}: {
  value: string;
  editing: boolean;
  onCommit: (next: string) => void;
  className?: string;
  style?: React.CSSProperties;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <div className={className} style={style}>
        {value || <span className="placeholder">Двойной клик для ввода</span>}
      </div>
    );
  }

  return (
    <textarea
      ref={ref}
      className={`${className ?? ''} editing`}
      style={style}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.currentTarget.blur();
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          onCommit(draft);
          e.currentTarget.blur();
        }
        e.stopPropagation();
      }}
    />
  );
}

export const ArtifactNodeView = memo(({ id, data, selected }: NodeProps): JSX.Element => {
  const { node, detailed } = data as CanvasNodeData;
  // Hooks run before the type guard: bailing out early would change the hook
  // count between renders and corrupt React's hook state for this node.
  const threads = useStore(useShallow((s) => s.threads.filter((t) => t.nodeId === id && !t.resolved)));
  const setCommentTarget = useStore((s) => s.setCommentTarget);
  const agent = useStore((s) => s.agents.find((a) => a.id === node.createdBy));
  const boardId = useStore((s) => s.activeBoardId);

  if (node.type !== 'artifact') return <div />;

  const spec = node.artifact;
  const visualState = node.visualState ?? 'expanded';
  const Renderer = artifactRenderer(spec.kind);
  const locked = Boolean(node.lock?.delete || node.lock?.move || node.locked);

  const cycleState = (): void => {
    if (!boardId) return;
    const order = ['expanded', 'widget', 'icon', 'ghost'] as const;
    const idx = order.indexOf(visualState as (typeof order)[number]);
    const next = order[(idx + 1) % order.length]!;
    void submit({ type: 'node.setVisualState', boardId, nodeId: id, visualState: next });
  };

  if (visualState === 'icon') {
    return (
      <div
        className={`node artifact icon-state tone-${spec.tone} ${selected ? 'selected' : ''}`}
        title={spec.title || spec.kind}
        onDoubleClick={(e) => {
          e.stopPropagation();
          cycleState();
        }}
      >
        <span className={`tone-dot tone-${spec.tone}`} />
        <span className="icon-kind">{spec.kind.slice(0, 2).toUpperCase()}</span>
        {locked && <span className="lock-badge" title="защищён">🔒</span>}
      </div>
    );
  }

  if (visualState === 'widget') {
    return (
      <div
        className={`node artifact widget-state tone-${spec.tone} ${selected ? 'selected' : ''}`}
        onDoubleClick={(e) => {
          e.stopPropagation();
          cycleState();
        }}
      >
        <span className={`tone-dot tone-${spec.tone}`} />
        <span className="node-title">{spec.title || spec.kind}</span>
        {spec.kind === 'status' && 'progress' in spec && typeof spec.progress === 'number' && (
          <div className="widget-progress">
            <i style={{ width: `${Math.round(spec.progress * 100)}%` }} />
          </div>
        )}
        {locked && <span className="lock-badge">🔒</span>}
      </div>
    );
  }

  return (
    <div
      className={`node artifact tone-${spec.tone} state-${visualState} ${selected ? 'selected' : ''} ${visualState === 'ghost' ? 'ghost-state' : ''}`}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.node-body')) return;
        e.stopPropagation();
        cycleState();
      }}
    >
      <NodeResizer minWidth={160} minHeight={100} isVisible={selected && visualState === 'expanded'} lineClassName="resize-line" />
      <header className="node-head">
        <span className={`tone-dot tone-${spec.tone}`} title={TONE_LABEL[spec.tone]} />
        <span className="node-title">{spec.title || spec.kind}</span>
        <span className="node-kind">{spec.kind}</span>
        {locked && <span className="lock-badge" title="lock">🔒</span>}
        {agent && (
          <span className="node-author" style={{ background: agent.avatarColor }} title={agent.name}>
            {agent.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <button
          className="node-comment"
          title="Состояние / комментарий"
          onClick={(e) => {
            e.stopPropagation();
            if (e.shiftKey) {
              cycleState();
              return;
            }
            setCommentTarget(id);
          }}
        >
          💬{threads.length > 0 && <b>{threads.length}</b>}
        </button>
      </header>
      {visualState !== 'ghost' && (
        <div
          className="node-body"
          onPointerDownCapture={(e) => {
            // React Flow only skips drag for `.nodrag` — tag interactive targets.
            const el = e.target as HTMLElement | null;
            if (!el?.closest) return;
            if (
              el.closest(
                'input, textarea, button, select, a, audio, video, iframe, .nodrag, .nowheel'
              )
            ) {
              el.classList?.add?.('nodrag');
              const host = el.closest(
                'input, textarea, button, select, a, audio, video, iframe, .nodrag, .nowheel'
              ) as HTMLElement | null;
              host?.classList.add('nodrag');
            }
          }}
        >
          {/* Body is draggable; interactive widgets use `.nodrag`. */}
          {Renderer ? (
            <Renderer nodeId={id} spec={spec} detailed={detailed} selected={selected} />
          ) : (
            <div className="art-empty">нет рендерера для {spec.kind}</div>
          )}
        </div>
      )}
      {visualState === 'ghost' && <div className="ghost-label">архив · двойной клик</div>}
      <NodePorts />
    </div>
  );
});
ArtifactNodeView.displayName = 'ArtifactNodeView';

/**
 * An agent's frame. Border sits under artifacts (low RF z-index). The badge is
 * portaled via NodeToolbar so it stays readable above cards. Interior never
 * captures pointer events — drag only from the toolbar / resizer.
 */
export const FrameNodeView = memo(({ data, selected }: NodeProps): JSX.Element => {
  const { node } = data as CanvasNodeData;
  const agentId = node.type === 'frame' ? node.agentId : null;

  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const headline = useStore((s) => (agentId ? s.agentHeadlines[agentId] : ''));
  const live = useStore((s) => (agentId ? s.liveTurns.get(agentId) : undefined));
  const setFollow = useStore((s) => s.setFollow);

  if (node.type !== 'frame') return <div />;
  const accent = node.style.stroke;
  const working = !!agent && isWorking(agent.status);
  const softBorder = `color-mix(in srgb, ${accent} ${working ? 42 : 28}%, transparent)`;

  return (
    <div
      className={`node frame ${selected ? 'selected' : ''} ${working ? 'busy' : 'idle'} ${agentId ? 'agent-owned' : ''}`}
      style={{
        borderColor: softBorder,
        boxShadow: selected ? `0 0 0 1px ${accent}40` : undefined
      }}
    >
      <NodeResizer minWidth={320} minHeight={240} isVisible={selected} lineClassName="resize-line" />
      <NodeToolbar isVisible position={Position.Top} offset={6} align="start" className="frame-toolbar">
        <div
          className="frame-head"
          style={{
            background: `color-mix(in srgb, ${accent} 14%, #161a22)`,
            borderColor: `color-mix(in srgb, ${accent} 45%, transparent)`
          }}
        >
          <span className="frame-avatar" style={{ background: accent }}>
            {(agent?.name ?? node.label).slice(0, 1).toUpperCase()}
          </span>
          <span className="frame-title">{node.label || 'Рамка'}</span>
          {agent && (
            <>
              {working && <span className={`frame-status status-${agent.status}`}>{agent.status}</span>}
              <button
                type="button"
                className="frame-follow nodrag"
                title="Следить за агентом"
                onClick={(e) => {
                  e.stopPropagation();
                  setFollow(agent.id);
                }}
              >
                ⌖
              </button>
            </>
          )}
        </div>
        {(headline || live) && working && (
          <div className="frame-live nodrag">
            {live?.calls.at(-1)?.name ?? headline}
            {live && <span className="frame-spinner" />}
          </div>
        )}
      </NodeToolbar>
    </div>
  );
});
FrameNodeView.displayName = 'FrameNodeView';

function isWorking(status: string): boolean {
  return (
    status === 'thinking' ||
    status === 'running' ||
    status === 'waitingApproval' ||
    status === 'waitingInput'
  );
}

export const StickyNodeView = memo(({ id, data, selected }: NodeProps): JSX.Element => {
  const { node } = data as CanvasNodeData;
  const editing = useStore((s) => s.editingNodeId === id);
  const setEditing = useStore((s) => s.setEditingNode);
  const commit = useCommitText(id);

  if (node.type !== 'sticky') return <div />;

  return (
    <div
      className={`node sticky ${selected ? 'selected' : ''}`}
      style={{ background: node.style.fill, color: node.style.color }}
      onDoubleClick={() => setEditing(id)}
    >
      <EditableText
        className="sticky-text nodrag"
        value={node.text}
        editing={editing}
        onCommit={(next) => {
          commit(next, 'text');
          setEditing(null);
        }}
        style={{ fontSize: node.style.fontSize, textAlign: node.style.align }}
      />
      <NodePorts connectable={!selected} />
      <NodeResizer minWidth={100} minHeight={80} isVisible={selected} lineClassName="resize-line" />
    </div>
  );
});
StickyNodeView.displayName = 'StickyNodeView';

export const TextNodeView = memo(({ id, data, selected }: NodeProps): JSX.Element => {
  const { node } = data as CanvasNodeData;
  const editing = useStore((s) => s.editingNodeId === id);
  const setEditing = useStore((s) => s.setEditingNode);
  const commit = useCommitText(id);

  if (node.type !== 'text') return <div />;

  return (
    <div className={`node text ${selected ? 'selected' : ''}`} onDoubleClick={() => setEditing(id)}>
      <NodeResizer minWidth={60} minHeight={28} isVisible={selected} lineClassName="resize-line" />
      <EditableText
        className="text-body nodrag"
        value={node.text}
        editing={editing}
        onCommit={(next) => {
          commit(next, 'text');
          setEditing(null);
        }}
        style={{
          fontSize: node.style.fontSize,
          fontWeight: node.style.fontWeight,
          color: node.style.color,
          textAlign: node.style.align
        }}
      />
    </div>
  );
});
TextNodeView.displayName = 'TextNodeView';

export const ShapeNodeView = memo(({ id, data, selected }: NodeProps): JSX.Element => {
  const { node } = data as CanvasNodeData;
  const editing = useStore((s) => s.editingNodeId === id);
  const setEditing = useStore((s) => s.setEditingNode);
  const commit = useCommitText(id);

  if (node.type !== 'shape') return <div />;
  const { style } = node;
  // Unit square viewBox — the node box owns size/position, so resize cannot
  // desync the SVG geometry from the React Flow wrapper.
  const sw = Math.min(8, Math.max(1, style.strokeWidth));
  const inset = sw / 2;
  const radius = Math.min(50, Math.max(0, (style.radius / Math.max(node.size.w, 1)) * 100));

  const dash =
    style.strokeStyle === 'dashed'
      ? `${sw * 4} ${sw * 3}`
      : style.strokeStyle === 'dotted'
        ? `1 ${sw * 2.5}`
        : undefined;

  const common = {
    fill: style.fill,
    stroke: style.stroke,
    strokeWidth: sw,
    strokeDasharray: dash,
    strokeLinecap: 'round' as const,
    vectorEffect: 'non-scaling-stroke' as const
  };

  return (
    <div className={`node shape ${selected ? 'selected' : ''}`} onDoubleClick={() => setEditing(id)}>
      <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
        {node.shape === 'rectangle' && (
          <rect
            x={inset}
            y={inset}
            width={100 - sw}
            height={100 - sw}
            rx={radius}
            {...common}
          />
        )}
        {node.shape === 'ellipse' && (
          <ellipse cx={50} cy={50} rx={50 - inset} ry={50 - inset} {...common} />
        )}
        {node.shape === 'diamond' && (
          <polygon points={`50,${inset} ${100 - inset},50 50,${100 - inset} ${inset},50`} {...common} />
        )}
        {node.shape === 'triangle' && (
          <polygon points={`50,${inset} ${100 - inset},${100 - inset} ${inset},${100 - inset}`} {...common} />
        )}
        {node.shape === 'star' && <polygon points={starPoints(100, 100)} {...common} />}
        {node.shape === 'arrowBlock' && (
          <polygon
            points={`${inset},30 60,30 60,${inset} ${100 - inset},50 60,${100 - inset} 60,70 ${inset},70`}
            {...common}
          />
        )}
      </svg>
      {(node.text || editing) && (
        <EditableText
          className="shape-text nodrag"
          value={node.text}
          editing={editing}
          onCommit={(next) => {
            commit(next, 'text');
            setEditing(null);
          }}
          style={{ color: style.color, fontSize: style.fontSize }}
        />
      )}
      {/* Ports share edge midpoints with the resizer — disable while selected. */}
      <NodePorts connectable={!selected} />
      <NodeResizer minWidth={24} minHeight={24} isVisible={selected} lineClassName="resize-line" />
    </div>
  );
});
ShapeNodeView.displayName = 'ShapeNodeView';

function starPoints(w: number, h: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const points: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? 1 : 0.42;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    points.push(`${cx + Math.cos(angle) * cx * radius},${cy + Math.sin(angle) * cy * radius}`);
  }
  return points.join(' ');
}

export const FreehandNodeView = memo(({ data, selected }: NodeProps): JSX.Element => {
  const { node } = data as CanvasNodeData;
  if (node.type !== 'freehand') return <div />;

  // Outlines are computed at render time rather than stored, so stroke width
  // and thinning stay editable after the stroke was drawn.
  const path = strokeToPath(node.points, node.style.strokeWidth);

  return (
    <div className={`node freehand ${selected ? 'selected' : ''}`}>
      <svg width="100%" height="100%" viewBox={`0 0 ${node.size.w} ${node.size.h}`}>
        <path d={path} fill={node.style.stroke} stroke="none" />
      </svg>
    </div>
  );
});
FreehandNodeView.displayName = 'FreehandNodeView';

export const GroupNodeView = memo(({ data, selected }: NodeProps): JSX.Element => {
  const { node } = data as CanvasNodeData;
  if (node.type !== 'group') return <div />;
  const accent = node.accent || node.style.stroke || '#6ea8fe';
  return (
    <div
      className={`node group ${selected ? 'selected' : ''}`}
      style={{
        border: 'none',
        outline: 'none',
        background: 'rgb(20 24 32 / 55%)',
        boxShadow: selected ? `inset 0 0 0 1px ${accent}40` : 'none'
      }}
    >
      <NodeResizer minWidth={200} minHeight={120} isVisible={selected} lineClassName="resize-line" />
      <span className="group-label nodrag" style={{ color: accent, background: '#141820' }}>
        {node.label || 'Группа'}
      </span>
    </div>
  );
});
GroupNodeView.displayName = 'GroupNodeView';

export const StickerNodeView = memo(({ data, selected }: NodeProps): JSX.Element => {
  const { node } = data as CanvasNodeData;
  if (node.type !== 'sticker') return <div />;
  const src =
    node.src.startsWith('zmtki-sticker:') || node.src.startsWith('data:') || node.src.startsWith('http')
      ? node.src
      : `zmtki-sticker://${encodeURIComponent(node.packId)}/${encodeURIComponent(node.stickerId)}`;
  return (
    <div className={`node sticker ${selected ? 'selected' : ''}`} title={node.emoji ?? node.stickerId}>
      <NodeResizer minWidth={48} minHeight={48} keepAspectRatio isVisible={selected} lineClassName="resize-line" />
      <img className="sticker-img nodrag" src={src} alt={node.emoji ?? node.stickerId} draggable={false} />
    </div>
  );
});
StickerNodeView.displayName = 'StickerNodeView';

export const nodeTypes = {
  artifact: ArtifactNodeView,
  frame: FrameNodeView,
  sticky: StickyNodeView,
  text: TextNodeView,
  shape: ShapeNodeView,
  freehand: FreehandNodeView,
  group: GroupNodeView,
  sticker: StickerNodeView
};
