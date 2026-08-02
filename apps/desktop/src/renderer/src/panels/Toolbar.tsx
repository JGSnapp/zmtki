import { useEffect, useState } from 'react';
import { setStickerDragData } from '../stickers/drag.js';
import { pickQuickStickers, type QuickSticker } from '../stickers/quickStickers.js';
import { submit, useStore, type ToolName } from '../store.js';
import { StickerPanel } from './StickerPanel.js';

const TOOLS: Array<{ id: ToolName; icon: string; label: string; key: string }> = [
  { id: 'select', icon: '⬚', label: 'Выделение', key: 'V' },
  { id: 'hand', icon: '✋', label: 'Рука', key: 'H' },
  { id: 'sticky', icon: '▤', label: 'Стикер-заметка', key: 'S' },
  { id: 'text', icon: 'T', label: 'Текст', key: 'T' },
  { id: 'rect', icon: '▭', label: 'Прямоугольник', key: 'R' },
  { id: 'ellipse', icon: '◯', label: 'Овал', key: 'O' },
  { id: 'diamond', icon: '◇', label: 'Ромб', key: 'D' },
  { id: 'arrow', icon: '→', label: 'Стрелка', key: 'A' },
  { id: 'draw', icon: '✎', label: 'Карандаш', key: 'P' },
  { id: 'frame', icon: '⬓', label: 'Рамка', key: 'F' },
  { id: 'comment', icon: '💬', label: 'Комментарий', key: 'C' }
];

export function Toolbar(): JSX.Element {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const boardId = useStore((s) => s.activeBoardId);
  const selection = useStore((s) => s.selection);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [quickStickers, setQuickStickers] = useState<QuickSticker[]>([]);

  useEffect(() => {
    void submit<Array<{ id: string; stickers: Array<{ id: string; src: string; emoji?: string }> }>>({
      type: 'stickers.list'
    }).then((result) => {
      if (result.ok) setQuickStickers(pickQuickStickers(result.value, 5));
    });
  }, []);

  const groupSelected = async (): Promise<void> => {
    if (!boardId || selection.length < 2) return;
    const label = window.prompt('Название группы', 'Группа') ?? 'Группа';
    const accent = window.prompt('Цвет (#hex)', '#6ea8fe') ?? '#6ea8fe';
    const { createGroupNode } = await import('@zmtki/board-schema');
    const board = useStore.getState().activeBoard();
    if (!board) return;
    const members = selection
      .map((id) => board.nodes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => Boolean(n));
    if (members.length < 2) return;
    const xs = members.map((n) => n.position.x);
    const ys = members.map((n) => n.position.y);
    const x2 = members.map((n) => n.position.x + n.size.w);
    const y2 = members.map((n) => n.position.y + n.size.h);
    const group = createGroupNode({
      label,
      accent,
      position: { x: Math.min(...xs) - 16, y: Math.min(...ys) - 40 },
      size: {
        w: Math.max(...x2) - Math.min(...xs) + 32,
        h: Math.max(...y2) - Math.min(...ys) + 56
      }
    });
    await submit({
      type: 'board.apply',
      boardId,
      label: 'Группа',
      ops: [
        { op: 'addNode', node: group },
        ...members.map((m) => ({
          op: 'updateNode' as const,
          id: m.id,
          patch: { parentId: group.id }
        }))
      ]
    });
  };

  const unlockSelected = async (): Promise<void> => {
    if (!boardId || selection.length === 0) return;
    for (const nodeId of selection) {
      await submit({
        type: 'node.setLock',
        boardId,
        nodeId,
        lock: { delete: false, move: false, edit: false }
      });
    }
  };

  return (
    <div className="toolbar">
      {TOOLS.map((entry) => (
        <button
          key={entry.id}
          className={`tool ${tool === entry.id ? 'active' : ''}`}
          title={`${entry.label} (${entry.key})`}
          onClick={() => setTool(entry.id)}
        >
          {entry.icon}
        </button>
      ))}

      <div className="tool-sep" />

      {quickStickers.map((s) => (
        <button
          key={`${s.packId}:${s.stickerId}`}
          type="button"
          className="tool tool-sticker"
          title={s.emoji ? `${s.emoji} — перетащите на доску` : 'Перетащите на доску'}
          disabled={!boardId}
          draggable={Boolean(boardId)}
          onDragStart={(e) => setStickerDragData(e, { packId: s.packId, stickerId: s.stickerId })}
        >
          <img src={s.src} alt={s.emoji ?? s.stickerId} draggable={false} />
        </button>
      ))}
      <button
        type="button"
        className={`tool ${stickersOpen ? 'active' : ''}`}
        title="Все стикеры"
        onClick={() => setStickersOpen((v) => !v)}
      >
        ⋯
      </button>

      <div className="tool-sep" />

      <button
        className="tool"
        title="Сгруппировать выделенное"
        disabled={selection.length < 2}
        onClick={() => void groupSelected()}
      >
        ⊞
      </button>
      <button
        className="tool"
        title="Снять lock с выделенного"
        disabled={selection.length === 0}
        onClick={() => void unlockSelected()}
      >
        🔓
      </button>

      <div className="tool-sep" />

      <button
        className="tool"
        title="Отменить (Ctrl+Z)"
        onClick={() => boardId && void submit({ type: 'board.undo', boardId })}
      >
        ↺
      </button>
      <button
        className="tool"
        title="Повторить (Ctrl+Shift+Z)"
        onClick={() => boardId && void submit({ type: 'board.redo', boardId })}
      >
        ↻
      </button>
      <button
        className="tool"
        title="Разложить свободные объекты"
        onClick={() => boardId && void submit({ type: 'board.tidy', boardId })}
      >
        ⌗
      </button>

      <StickerPanel open={stickersOpen} onClose={() => setStickersOpen(false)} />
    </div>
  );
}
