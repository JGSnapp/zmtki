import type { Arrow, ArrowGeometry, Artifact, Vec2 } from '@zmtki/shared';
import {
  LABEL_GAP,
  arrowHeadVertices,
  arrowPathData,
  computeArrowGeometries,
  labelAnchor,
} from '@zmtki/shared';
import { useMemo, useState } from 'react';

interface Props {
  arrows: Arrow[];
  artifacts: Map<string, Artifact>;
  zoom: number;
  selectedId?: string;
  onSelect: (arrowId: string) => void;
  onAddBend: (arrowId: string, index: number, point: Vec2) => void;
  onDragBend: (arrowId: string, index: number, point: Vec2, commit: boolean) => void;
  onRemoveBend: (arrowId: string, index: number) => void;
  /**
   * An end was dragged somewhere: onto another card, or to another side of the
   * one it is already on. `artifactId` is null when it was dropped on nothing.
   */
  onReattach: (arrowId: string, end: 'from' | 'to', artifactId: string | null, point: Vec2) => void;
  toWorld: (event: { clientX: number; clientY: number }) => Vec2;
}

/** SVG user units: the board transform scales this together with every artifact. */
const LABEL_FONT = 12;

const midpoint = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export const ArrowLayer = ({
  arrows,
  artifacts,
  zoom,
  selectedId,
  onSelect,
  onAddBend,
  onDragBend,
  onRemoveBend,
  onReattach,
  toWorld,
}: Props) => {
  /**
   * What the user is dragging right now, drawn without going through the board.
   *
   * A bend used to move only on release: the line stayed where it was under the
   * finger and jumped when it was let go, which reads as "this cannot be
   * adjusted" rather than as a delay.
   */
  const [drag, setDrag] = useState<{ arrowId: string; kind: 'bend'; index: number; point: Vec2 } | { arrowId: string; kind: 'end'; end: 'from' | 'to'; point: Vec2 } | null>(null);
  // Ports are distributed across every arrow sharing a side, so geometry is
  // computed for the whole board at once rather than per arrow.
  const geometries = useMemo(() => {
    const computed = computeArrowGeometries(artifacts, arrows);
    return arrows
      .map((arrow) => ({ arrow, geometry: computed.get(arrow.id) }))
      .filter((item): item is { arrow: Arrow; geometry: ArrowGeometry } => Boolean(item.geometry));
  }, [arrows, artifacts]);

  const handleSize = 8 / zoom;

  return (
    <svg className="arrow-layer" style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible' }}>
      {geometries.map(({ arrow, geometry }) => {
        const dragging = drag?.arrowId === arrow.id ? drag : null;
        // An end being dragged follows the finger. A bend does not need this:
        // the board is told about it as it moves, and the whole route is then
        // recomputed by the engine, which is the shape that matters.
        const points =
          dragging?.kind === 'end'
            ? geometry.points.map((point, i) =>
                (dragging.end === 'from' && i === 0) || (dragging.end === 'to' && i === geometry.points.length - 1)
                  ? dragging.point
                  : point,
              )
            : geometry.points;
        const d = arrowPathData(points, arrow.routing);
        const selected = arrow.id === selectedId;
        const color = selected ? '#ff7a3d' : (arrow.style.color ?? '#8b93a7');
        const label = arrow.label;
        const anchor = labelAnchor(points);
        const headSize = 10;
        const toHead = arrowHeadVertices(geometry.toPoint, geometry.toSide, headSize);
        const fromHead = arrow.style.bidirectional
          ? arrowHeadVertices(geometry.fromPoint, geometry.fromSide, headSize)
          : null;
        const poly = (verts: [Vec2, Vec2, Vec2]) =>
          `${verts[0].x},${verts[0].y} ${verts[1].x},${verts[1].y} ${verts[2].x},${verts[2].y}`;
        return (
          <g key={arrow.id} className={`arrow ${selected ? 'selected' : ''}`}>
            <path
              d={d}
              fill="none"
              stroke="transparent"
              // Widths are screen-space through `vector-effect` (see styles.css)
              // rather than divided by the zoom here: recomputing them per frame
              // rewrote every path's attributes as the board scaled, and the
              // whole arrow layer was re-rasterised on each step of a zoom.
              className="arrow-hit"
              style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelect(arrow.id);
              }}
            />
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={arrow.style.width ?? 1.8}
              className={'arrow-line' + (arrow.style.dashed ? ' is-dashed' : '')}
              // Board units, like the head: see styles.css for why they must match.
              style={{ pointerEvents: 'none' }}
            />
            <polygon points={poly(toHead)} fill={color} style={{ pointerEvents: 'none' }} />
            {fromHead && <polygon points={poly(fromHead)} fill={color} style={{ pointerEvents: 'none' }} />}
            {label && anchor && (
              <text
                x={anchor.horizontal ? anchor.point.x : anchor.point.x + LABEL_GAP}
                y={anchor.horizontal ? anchor.point.y - LABEL_GAP : anchor.point.y}
                fill="#c7ccd8"
                textAnchor={anchor.horizontal ? 'middle' : 'start'}
                dominantBaseline={anchor.horizontal ? 'auto' : 'middle'}
                stroke="#0e1014"
                strokeWidth={3}
                strokeLinejoin="round"
                paintOrder="stroke"
                fontSize={LABEL_FONT}
                className="arrow-label"
                style={{ pointerEvents: 'none' }}
              >
                {label}
              </text>
            )}
            {selected && (
              <>
                {/* The two ends: drag one onto another card to re-hang the
                    arrow, or to another side of the same card to change where
                    it leaves from. */}
                {(['from', 'to'] as const).map((end) => {
                  const at = end === 'from' ? points[0] : points[points.length - 1];
                  return (
                    <circle
                      key={'end-' + end}
                      cx={at.x}
                      cy={at.y}
                      r={handleSize * 0.7}
                      className="arrow-end-handle"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        const target = e.currentTarget;
                        target.setPointerCapture(e.pointerId);
                        setDrag({ arrowId: arrow.id, kind: 'end', end, point: toWorld(e) });
                        const move = (ev: PointerEvent) => setDrag({ arrowId: arrow.id, kind: 'end', end, point: toWorld(ev) });
                        const up = (ev: PointerEvent) => {
                          target.removeEventListener('pointermove', move);
                          target.removeEventListener('pointerup', up);
                          setDrag(null);
                          const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-artifact-id]');
                          onReattach(arrow.id, end, hit?.getAttribute('data-artifact-id') ?? null, toWorld(ev));
                        };
                        target.addEventListener('pointermove', move);
                        target.addEventListener('pointerup', up);
                      }}
                    />
                  );
                })}
                {points.slice(0, -1).map((point, index) => {
                  const mid = midpoint(point, points[index + 1]);
                  const insertAt = geometry.insertAt[index] ?? arrow.bends.length;
                  return (
                    <circle
                      key={`add-${index}`}
                      cx={mid.x}
                      cy={mid.y}
                      r={handleSize / 2}
                      className="bend-add"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        onAddBend(arrow.id, insertAt, toWorld(e));
                      }}
                    />
                  );
                })}
                {arrow.bends.map((bend, index) => (
                  <rect
                    key={`bend-${index}`}
                    x={bend.x - handleSize / 2}
                    y={bend.y - handleSize / 2}
                    width={handleSize}
                    height={handleSize}
                    className="bend-handle"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      onRemoveBend(arrow.id, index);
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      const target = e.currentTarget;
                      target.setPointerCapture(e.pointerId);
                      setDrag({ arrowId: arrow.id, kind: 'bend', index, point: toWorld(e) });
                      const move = (ev: PointerEvent) => {
                        const point = toWorld(ev);
                        setDrag({ arrowId: arrow.id, kind: 'bend', index, point });
                        onDragBend(arrow.id, index, point, false);
                      };
                      const up = (ev: PointerEvent) => {
                        target.removeEventListener('pointermove', move);
                        target.removeEventListener('pointerup', up);
                        setDrag(null);
                        onDragBend(arrow.id, index, toWorld(ev), true);
                      };
                      target.addEventListener('pointermove', move);
                      target.addEventListener('pointerup', up);
                    }}
                  />
                ))}
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
};
