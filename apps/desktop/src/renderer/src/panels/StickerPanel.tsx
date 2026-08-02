import { useEffect, useState } from 'react';
import { setStickerDragData } from '../stickers/drag.js';
import { stickerImgSrc } from '../stickers/quickStickers.js';
import { submit, useStore } from '../store.js';

interface StickerView {
  id: string;
  emoji?: string;
  src: string;
}

interface PackView {
  id: string;
  name: string;
  scope: 'global' | 'board';
  stickers: StickerView[];
}

export function StickerPanel({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const boardId = useStore((s) => s.activeBoardId);
  const [packs, setPacks] = useState<PackView[]>([]);
  const [packName, setPackName] = useState('');
  const [msg, setMsg] = useState('');

  const reload = async (): Promise<void> => {
    const result = await submit<PackView[]>({ type: 'stickers.list' });
    if (result.ok) setPacks(result.value);
  };

  useEffect(() => {
    if (open) void reload();
  }, [open]);

  if (!open) return null;

  const createPack = async (): Promise<void> => {
    if (!packName.trim()) return;
    const id = packName.trim().toLowerCase().replace(/\s+/g, '-');
    const result = await submit({
      type: 'stickers.upsertPack',
      scope: 'global',
      id,
      name: packName.trim()
    });
    if (!result.ok) {
      setMsg(result.error);
      return;
    }
    setPackName('');
    setMsg('Пак создан — добавьте PNG через addSticker (путь к файлу)');
    await reload();
  };

  const addFromPath = async (packId: string): Promise<void> => {
    const sourcePath = window.prompt('Путь к PNG/WebP файлу стикера');
    if (!sourcePath) return;
    const id = `s${Date.now().toString(36)}`;
    const result = await submit({
      type: 'stickers.addSticker',
      scope: 'global',
      packId,
      id,
      sourcePath
    });
    if (!result.ok) setMsg(result.error);
    else {
      setMsg('Стикер добавлен');
      await reload();
    }
  };

  return (
    <div className="sticker-panel">
      <div className="sticker-panel-head">
        <span>Стикеры</span>
        <button className="icon-btn" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="hint">Перетащите стикер на доску</div>
      {msg && <div className="hint">{msg}</div>}
      <div className="sticker-create">
        <input
          value={packName}
          onChange={(e) => setPackName(e.target.value)}
          placeholder="Новый пак"
        />
        <button className="art-btn" onClick={() => void createPack()}>
          Создать
        </button>
      </div>
      <div className="sticker-packs">
        {packs.length === 0 && <div className="hint">Паков пока нет</div>}
        {packs.map((pack) => (
          <div key={pack.id} className="sticker-pack">
            <div className="sticker-pack-head">
              <strong>{pack.name}</strong>
              <span className="ep-provider">{pack.scope}</span>
              <button className="art-btn" onClick={() => void addFromPath(pack.id)}>
                + файл
              </button>
            </div>
            <div className="sticker-grid">
              {pack.stickers.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="sticker-cell"
                  title={`${s.emoji ?? s.id} — перетащите на доску`}
                  disabled={!boardId}
                  draggable={Boolean(boardId)}
                  onDragStart={(e) =>
                    setStickerDragData(e, { packId: pack.id, stickerId: s.id })
                  }
                >
                  <img src={stickerImgSrc(pack.id, s.id, s.src)} alt={s.emoji ?? s.id} draggable={false} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
