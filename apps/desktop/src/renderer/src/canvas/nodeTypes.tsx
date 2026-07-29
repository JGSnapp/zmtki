import { memo, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import type { BoardNode } from '@zmtki/board-schema';
import { artifactRenderer } from '../artifacts/registry.js';
import { submit, useStore } from '../store.js';
import { strokeToPath } from './freehand.js';

export interface CanvasNodeData extends Record<string, unknown> {
  node: BoardNode;
  detailed: boolean;
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
        <div className="node-body nodrag">
          {Renderer ? (
            <Renderer nodeId={id} spec={spec} detailed={detailed} selected={selected} />
          ) : (
            <div className="art-empty">нет рендерера для {spec.kind}</div>
          )}
        </div>
      )}
      {visualState === 'ghost' && <div className="ghost-label">архив · двойной клик</div>}
      <Handle type="target" position={Position.Left} className="handle" />
      <Handle type="source" position={Position.Right} className="handle" />
    </div>
  );
});
ArtifactNodeView.displayName = 'ArtifactNodeView';

/**
 * An agent's frame. Rendered behind everything and never captures pointer events
 * in its interior, so artifacts inside stay clickable and dragging the frame
 * only works from its title bar.
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

  return (
    <div
      className={`node frame ${selected ? 'selected' : ''} ${agent?.status === 'running' ? 'busy' : ''}`}
      style={{ borderColor: accent, boxShadow: selected ? `0 0 0 2px ${accent}55` : undefined }}
    >
      <NodeResizer minWidth={320} minHeight={240} isVisible={selected} lineClassName="resize-line" />
      <div className="frame-head" style={{ background: `${accent}22`, borderColor: accent }}>
        <span className="frame-avatar" style={{ background: accent }}>
          {(agent?.name ?? node.label).slice(0, 1).toUpperCase()}
        </span>
        <span className="frame-title">{node.label || 'Рамка'}</span>
        {agent && (
          <>
            <span className={`frame-status status-${agent.status}`}>{agent.status}</span>
            <button
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
      {(headline || live) && (
        <div className="frame-live nodrag">
          {live?.calls.at(-1)?.name ?? headline}
          {live && <span className="frame-spinner" />}
        </div>
      )}
    </div>
  );
});
FrameNodeView.displayName = 'FrameNodeView';

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
      <NodeResizer minWidth={100} minHeight={80} isVisible={selected} lineClassName="resize-line" />
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
      <Handle type="target" position={Position.Left} className="handle" />
      <Handle type="source" position={Position.Right} className="handle" />
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

  const dash =
    style.strokeStyle === 'dashed'
      ? `${style.strokeWidth * 4} ${style.strokeWidth * 3}`
      : style.strokeStyle === 'dotted'
        ? `1 ${style.strokeWidth * 2.5}`
        : undefined;

  const common = {
    fill: style.fill,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    strokeDasharray: dash,
    strokeLinecap: 'round' as const
  };

  return (
    <div className={`node shape ${selected ? 'selected' : ''}`} onDoubleClick={() => setEditing(id)}>
      <NodeResizer minWidth={24} minHeight={24} isVisible={selected} lineClassName="resize-line" />
      <svg width="100%" height="100%" viewBox={`0 0 ${node.size.w} ${node.size.h}`} preserveAspectRatio="none">
        {node.shape === 'rectangle' && (
          <rect
            x={style.strokeWidth / 2}
            y={style.strokeWidth / 2}
            width={Math.max(0, node.size.w - style.strokeWidth)}
            height={Math.max(0, node.size.h - style.strokeWidth)}
            rx={style.radius}
            {...common}
          />
        )}
        {node.shape === 'ellipse' && (
          <ellipse
            cx={node.size.w / 2}
            cy={node.size.h / 2}
            rx={Math.max(0, node.size.w / 2 - style.strokeWidth / 2)}
            ry={Math.max(0, node.size.h / 2 - style.strokeWidth / 2)}
            {...common}
          />
        )}
        {node.shape === 'diamond' && (
          <polygon
            points={`${node.size.w / 2},2 ${node.size.w - 2},${node.size.h / 2} ${node.size.w / 2},${node.size.h - 2} 2,${node.size.h / 2}`}
            {...common}
          />
        )}
        {node.shape === 'triangle' && (
          <polygon points={`${node.size.w / 2},2 ${node.size.w - 2},${node.size.h - 2} 2,${node.size.h - 2}`} {...common} />
        )}
        {node.shape === 'star' && <polygon points={starPoints(node.size.w, node.size.h)} {...common} />}
        {node.shape === 'arrowBlock' && (
          <polygon
            points={`2,${node.size.h * 0.3} ${node.size.w * 0.6},${node.size.h * 0.3} ${node.size.w * 0.6},2 ${node.size.w - 2},${node.size.h / 2} ${node.size.w * 0.6},${node.size.h - 2} ${node.size.w * 0.6},${node.size.h * 0.7} 2,${node.size.h * 0.7}`}
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
      <Handle type="target" position={Position.Left} className="handle" />
      <Handle type="source" position={Position.Right} className="handle" />
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
        borderColor: accent,
        background: node.style.fill || `${accent}14`,
        boxShadow: selected ? `0 0 0 2px ${accent}66` : undefined
      }}
    >
      <NodeResizer minWidth={200} minHeight={120} isVisible={selected} lineClassName="resize-line" />
      <span className="group-label" style={{ color: accent, borderColor: accent }}>
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
