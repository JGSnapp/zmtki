import type { MiniMapNodeProps } from '@xyflow/react';
import type { BoardNode } from '@zmtki/board-schema';
import { useStore } from '../store.js';

/**
 * Minimap glyphs that hint at content instead of flat squares.
 * Agent frames are thin outlines so the map stays readable.
 */
export function BoardMiniMapNode({
  id,
  x,
  y,
  width,
  height,
  color,
  strokeColor,
  selected,
  onClick
}: MiniMapNodeProps): JSX.Element {
  const boardNode = useStore((s) => s.activeBoard()?.nodes.get(id) ?? null);
  const stroke = strokeColor || color || '#5c677a';
  const fill = color && color !== 'transparent' ? color : '#3a4254';
  const handleClick = onClick
    ? (event: React.MouseEvent) => onClick(event.nativeEvent, id)
    : undefined;

  if (!boardNode) {
    return (
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={2}
        fill={fill}
        stroke={stroke}
        strokeWidth={0.5}
        className={selected ? 'minimap-node selected' : 'minimap-node'}
        onClick={handleClick}
      />
    );
  }

  return (
    <g
      transform={`translate(${x} ${y})`}
      className={selected ? 'minimap-node selected' : 'minimap-node'}
      onClick={handleClick}
    >
      {glyphFor(boardNode, width, height, fill, stroke)}
    </g>
  );
}

function glyphFor(
  node: BoardNode,
  w: number,
  h: number,
  fill: string,
  stroke: string
): JSX.Element {
  switch (node.type) {
    case 'frame': {
      const accent = node.style.stroke || stroke;
      return (
        <rect
          x={0.5}
          y={0.5}
          width={Math.max(1, w - 1)}
          height={Math.max(1, h - 1)}
          fill="none"
          stroke={accent}
          strokeWidth={1}
          rx={1.5}
          opacity={node.agentId ? 0.95 : 0.55}
          strokeDasharray={node.agentId ? undefined : '3 2'}
        />
      );
    }
    case 'sticky':
      return (
        <rect
          width={w}
          height={h}
          rx={1.5}
          fill={node.style.fill || '#e8c96a'}
          stroke="none"
          opacity={0.9}
        />
      );
    case 'text': {
      const y1 = h * 0.28;
      const y2 = h * 0.5;
      const y3 = h * 0.72;
      return (
        <g stroke={stroke} strokeWidth={1} strokeLinecap="round">
          <line x1={w * 0.12} y1={y1} x2={w * 0.88} y2={y1} />
          <line x1={w * 0.12} y1={y2} x2={w * 0.88} y2={y2} />
          <line x1={w * 0.12} y1={y3} x2={w * 0.55} y2={y3} />
        </g>
      );
    }
    case 'sticker': {
      const r = Math.max(2, Math.min(w, h) / 2);
      return <circle cx={w / 2} cy={h / 2} r={r} fill={fill} opacity={0.85} />;
    }
    case 'shape':
      return shapeGlyph(node.shape, w, h, fill, stroke);
    case 'group':
      return (
        <rect
          x={0.5}
          y={0.5}
          width={Math.max(1, w - 1)}
          height={Math.max(1, h - 1)}
          fill={`${node.accent || stroke}33`}
          stroke="none"
          rx={2}
        />
      );
    case 'freehand':
      return (
        <path
          d={`M ${w * 0.15} ${h * 0.55} Q ${w * 0.35} ${h * 0.15}, ${w * 0.55} ${h * 0.5} T ${w * 0.85} ${h * 0.4}`}
          fill="none"
          stroke={node.style.stroke || stroke}
          strokeWidth={1.2}
          strokeLinecap="round"
        />
      );
    case 'artifact':
      return artifactGlyph(node.artifact.kind, w, h, fill, stroke);
    default:
      return <rect width={w} height={h} rx={2} fill={fill} />;
  }
}

function shapeGlyph(
  shape: string,
  w: number,
  h: number,
  fill: string,
  stroke: string
): JSX.Element {
  switch (shape) {
    case 'ellipse':
      return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} fill={fill} opacity={0.85} />;
    case 'diamond': {
      const d = `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`;
      return <path d={d} fill={fill} opacity={0.85} />;
    }
    case 'arrowBlock': {
      const d = `M 0 ${h * 0.25} H ${w * 0.55} L ${w} ${h / 2} L ${w * 0.55} ${h * 0.75} H 0 Z`;
      return <path d={d} fill={fill} opacity={0.85} />;
    }
    default:
      return (
        <rect width={w} height={h} rx={1.5} fill={fill} stroke={stroke} strokeWidth={0.4} opacity={0.85} />
      );
  }
}

function artifactGlyph(
  kind: string,
  w: number,
  h: number,
  fill: string,
  stroke: string
): JSX.Element {
  const pad = Math.min(w, h) * 0.08;
  switch (kind) {
    case 'terminal':
      return (
        <g>
          <rect width={w} height={h} rx={1.5} fill={fill} opacity={0.9} />
          <rect x={0} y={0} width={w} height={Math.max(2, h * 0.22)} fill="#1a2030" />
          <circle cx={w * 0.18} cy={h * 0.11} r={Math.max(0.6, h * 0.05)} fill="#d47a86" />
          <line
            x1={pad}
            y1={h * 0.55}
            x2={w * 0.55}
            y2={h * 0.55}
            stroke="#7dba74"
            strokeWidth={1}
          />
        </g>
      );
    case 'browser':
    case 'appView':
    case 'demo':
      return (
        <g>
          <rect width={w} height={h} rx={1.5} fill={fill} opacity={0.9} />
          <rect x={0} y={0} width={w} height={Math.max(2, h * 0.22)} fill="#243044" />
          <circle cx={w * 0.15} cy={h * 0.11} r={Math.max(0.5, h * 0.045)} fill="#d47a86" />
          <circle cx={w * 0.28} cy={h * 0.11} r={Math.max(0.5, h * 0.045)} fill="#c9a85a" />
          <circle cx={w * 0.41} cy={h * 0.11} r={Math.max(0.5, h * 0.045)} fill="#7dba74" />
        </g>
      );
    case 'file':
    case 'fileFragment':
    case 'diff': {
      const fold = Math.min(w, h) * 0.28;
      return (
        <path
          d={`M ${pad} ${pad} H ${w - fold} L ${w - pad} ${pad + fold} V ${h - pad} H ${pad} Z`}
          fill={fill}
          stroke={stroke}
          strokeWidth={0.4}
          opacity={0.9}
        />
      );
    }
    case 'markdown':
    case 'note':
    case 'blocks':
    case 'codePad':
    case 'map':
    case 'music':
    case 'video':
    case 'todo':
    case 'status':
      return (
        <g>
          <rect width={w} height={h} rx={1.5} fill={fill} opacity={0.75} />
          <line x1={pad} y1={h * 0.3} x2={w - pad} y2={h * 0.3} stroke="#c5cce0" strokeWidth={0.8} />
          <line x1={pad} y1={h * 0.5} x2={w - pad} y2={h * 0.5} stroke="#c5cce0" strokeWidth={0.8} />
          <line x1={pad} y1={h * 0.7} x2={w * 0.55} y2={h * 0.7} stroke="#c5cce0" strokeWidth={0.8} />
        </g>
      );
    case 'image':
      return (
        <g>
          <rect width={w} height={h} rx={1.5} fill={fill} opacity={0.8} />
          <path
            d={`M ${pad} ${h * 0.72} L ${w * 0.35} ${h * 0.4} L ${w * 0.55} ${h * 0.58} L ${w * 0.72} ${h * 0.35} L ${w - pad} ${h * 0.72} Z`}
            fill="#8b919d"
            opacity={0.9}
          />
          <circle cx={w * 0.28} cy={h * 0.28} r={Math.max(1, Math.min(w, h) * 0.08)} fill="#c5cce0" />
        </g>
      );
    case 'chart':
    case 'mermaid':
      return (
        <g>
          <rect width={w} height={h} rx={1.5} fill={fill} opacity={0.7} />
          <polyline
            points={`${pad},${h * 0.75} ${w * 0.35},${h * 0.45} ${w * 0.55},${h * 0.6} ${w - pad},${h * 0.25}`}
            fill="none"
            stroke="#6b8afd"
            strokeWidth={1}
          />
        </g>
      );
    case 'kanban':
      return (
        <g>
          <rect width={w} height={h} rx={1.5} fill={fill} opacity={0.7} />
          <rect x={pad} y={pad} width={w * 0.25} height={h - pad * 2} rx={0.8} fill="#4a5568" />
          <rect x={w * 0.38} y={pad} width={w * 0.25} height={h - pad * 2} rx={0.8} fill="#4a5568" />
          <rect x={w * 0.7} y={pad} width={w * 0.22} height={h - pad * 2} rx={0.8} fill="#4a5568" />
        </g>
      );
    case 'link':
    case 'portal':
      return (
        <g>
          <rect width={w} height={h} rx={1.5} fill={fill} opacity={0.65} />
          <circle
            cx={w * 0.38}
            cy={h / 2}
            r={Math.min(w, h) * 0.18}
            fill="none"
            stroke="#6b8afd"
            strokeWidth={1}
          />
          <circle
            cx={w * 0.62}
            cy={h / 2}
            r={Math.min(w, h) * 0.18}
            fill="none"
            stroke="#6b8afd"
            strokeWidth={1}
          />
        </g>
      );
    default:
      return <rect width={w} height={h} rx={2} fill={fill} opacity={0.85} />;
  }
}
