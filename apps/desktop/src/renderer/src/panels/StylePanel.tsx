import type { StrokeStyle, Style } from '@zmtki/board-schema';
import type { BoardOp } from '@zmtki/protocol';
import { submit, useStore } from '../store.js';

const SWATCHES = [
  '#e6e8ee',
  '#7c9cff',
  '#a6da95',
  '#eed49f',
  '#f5a97f',
  '#ed8796',
  '#c6a0f6',
  '#8bd5ca',
  '#5b6478'
];

const FILLS = ['transparent', '#7c9cff33', '#a6da9533', '#f5d97a', '#ed879633', '#1b1d24'];

/**
 * Edits the selection when there is one, otherwise the style that new objects
 * will be created with. Same panel either way, so there is no mode to learn.
 */
export function StylePanel(): JSX.Element | null {
  const selection = useStore((s) => s.selection);
  const board = useStore((s) => s.activeBoard());
  const boardId = useStore((s) => s.activeBoardId);
  const drawStyle = useStore((s) => s.drawStyle);
  const setDrawStyle = useStore((s) => s.setDrawStyle);
  const tool = useStore((s) => s.tool);

  const styled = selection
    .map((id) => board?.nodes.get(id))
    .filter((node) => node !== undefined && 'style' in node);

  const showForTool = tool !== 'select' && tool !== 'hand' && tool !== 'comment';
  if (styled.length === 0 && !showForTool) return null;

  const current: Style = styled.length > 0 && 'style' in styled[0]! ? styled[0]!.style : drawStyle;

  const patch = (change: Partial<Style>): void => {
    if (styled.length === 0) {
      setDrawStyle(change);
      return;
    }
    if (!boardId) return;
    const ops: BoardOp[] = styled.map((node) => ({
      op: 'updateNode' as const,
      id: node!.id,
      patch: { style: { ...(node as { style: Style }).style, ...change } }
    }));
    void submit({ type: 'board.apply', boardId, ops, label: 'Стиль' });
  };

  return (
    <div className="style-panel">
      <div className="style-row">
        <span className="style-label">Контур</span>
        <div className="swatches">
          {SWATCHES.map((color) => (
            <button
              key={color}
              className={`swatch ${current.stroke === color ? 'on' : ''}`}
              style={{ background: color }}
              onClick={() => patch({ stroke: color })}
            />
          ))}
        </div>
      </div>

      <div className="style-row">
        <span className="style-label">Заливка</span>
        <div className="swatches">
          {FILLS.map((color) => (
            <button
              key={color}
              className={`swatch ${current.fill === color ? 'on' : ''} ${color === 'transparent' ? 'none' : ''}`}
              style={color === 'transparent' ? undefined : { background: color }}
              onClick={() => patch({ fill: color })}
            />
          ))}
        </div>
      </div>

      <div className="style-row">
        <span className="style-label">Толщина</span>
        <input
          type="range"
          min={1}
          max={24}
          value={current.strokeWidth}
          onChange={(e) => patch({ strokeWidth: Number(e.target.value) })}
        />
        <span className="style-value">{current.strokeWidth}</span>
      </div>

      <div className="style-row">
        <span className="style-label">Линия</span>
        <div className="seg">
          {(['solid', 'dashed', 'dotted'] as StrokeStyle[]).map((value) => (
            <button
              key={value}
              className={current.strokeStyle === value ? 'on' : ''}
              onClick={() => patch({ strokeStyle: value })}
            >
              {value === 'solid' ? '—' : value === 'dashed' ? '- -' : '···'}
            </button>
          ))}
        </div>
      </div>

      <div className="style-row">
        <span className="style-label">Текст</span>
        <input
          type="range"
          min={8}
          max={64}
          value={current.fontSize}
          onChange={(e) => patch({ fontSize: Number(e.target.value) })}
        />
        <span className="style-value">{current.fontSize}</span>
      </div>

      <div className="style-row">
        <span className="style-label">Прозрачность</span>
        <input
          type="range"
          min={10}
          max={100}
          value={Math.round(current.opacity * 100)}
          onChange={(e) => patch({ opacity: Number(e.target.value) / 100 })}
        />
      </div>

      {styled.length > 0 && (
        <button
          className="art-btn danger full"
          onClick={() => {
            if (!boardId) return;
            void submit({
              type: 'board.apply',
              boardId,
              label: 'Удаление',
              ops: styled.map((node) => ({ op: 'removeNode' as const, id: node!.id }))
            });
            useStore.getState().setSelection([]);
          }}
        >
          Удалить выделенное
        </button>
      )}
    </div>
  );
}
