import type { ArtifactType } from '@zmtki/shared';
import { ARTIFACT_DEFINITIONS } from '@zmtki/shared';
import { useEffect, useRef, useState } from 'react';
import { Logo } from '../components/Brand';
import { api, useStore } from '../state/store';

const GROUPS: Array<{ title: string; types: ArtifactType[] }> = [
  { title: 'Текст', types: ['note', 'text', 'markdown', 'document', 'markdown-doc'] },
  { title: 'Код и редакторы', types: ['code', 'code-editor', 'text-editor'] },
  { title: 'Веб', types: ['html', 'ui', 'webview', 'browser'] },
  { title: 'Медиа', types: ['image', 'video', 'audio'] },
  { title: 'Живое', types: ['terminal', 'app-stream'] },
  { title: 'Интерактив', types: ['button', 'kanban'] },
  { title: 'Свободное', types: ['shape', 'drawing', 'file'] },
];

const GLYPH: Partial<Record<ArtifactType, string>> = {
  note: '▤', text: 'T', markdown: '#', document: '▥', 'markdown-doc': '✎', code: '‹›', 'code-editor': '⌨',
  'text-editor': '¶', html: '</>', ui: '◧', webview: '◎', browser: '⌂', image: '▣', video: '▶', audio: '♪',
  terminal: '›_', 'app-stream': '▢', button: '◉', kanban: '☰', shape: '◆', drawing: '〰', file: '🗎',
};

const useOutside = (open: boolean, close: () => void) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open, close]);
  return ref;
};

export const Toolbar = () => {
  const board = useStore((s) => s.board);
  const boards = useStore((s) => s.boards);
  const tool = useStore((s) => s.tool);
  const { openBoard, createBoard, deleteBoard, createBenchBoard, beginPlacement, undo, redo, setTool } = useStore.getState();
  const [menu, setMenu] = useState<'add' | 'boards' | 'bench' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const close = () => {
    setMenu(null);
    setConfirmingDelete(null);
  };
  const addRef = useOutside(menu === 'add', close);
  const boardsRef = useOutside(menu === 'boards', close);
  const benchRef = useOutside(menu === 'bench', close);
  const [renaming, setRenaming] = useState(false);

  return (
    <header className="toolbar">
      <Logo className="toolbar-logo" />

      <div className="menu-wrap" ref={boardsRef}>
        {renaming && board ? (
          <input
            className="board-rename"
            autoFocus
            defaultValue={board.title}
            onBlur={(e) => {
              setRenaming(false);
              if (e.target.value.trim() && e.target.value !== board.title) {
                void api.boards.patch(board.id, { title: e.target.value.trim() });
              }
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        ) : (
          <button className="tb-btn tb-board" onClick={() => setMenu(menu === 'boards' ? null : 'boards')} onDoubleClick={() => setRenaming(true)}>
            {board?.title ?? '…'} ▾
          </button>
        )}
        {menu === 'boards' && (
          <div className="menu menu-pop">
            {[...boards].sort((a, b) => b.updatedAt - a.updatedAt).map((b) => (
              <div key={b.id} className="board-menu-row">
                <button className={'menu-item board-menu-open' + (b.id === board?.id ? ' is-active' : '')} onClick={() => { close(); void openBoard(b.id); }}>
                  <span>{b.title}</span>
                  <span className="menu-meta">{b.artifactCount} арт.{b.rootDir ? ' · ' + b.rootDir : ''}</span>
                </button>
                {confirmingDelete === b.id ? (
                  <button
                    className="board-delete-confirm"
                    title={'Подтвердить удаление «' + b.title + '»'}
                    onClick={async () => {
                      await deleteBoard(b.id);
                      close();
                    }}
                  >
                    Удалить
                  </button>
                ) : (
                  <button
                    className="board-delete"
                    title={'Удалить доску «' + b.title + '»'}
                    aria-label={'Удалить доску «' + b.title + '»'}
                    onClick={() => setConfirmingDelete(b.id)}
                  >
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                      <path d="M4.5 6h11M8 3.5h4M6.2 6l.6 10h6.4l.6-10M8.5 8.5v5M11.5 8.5v5" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => { close(); void createBoard(); }}>+ Новая доска</button>
            <button
              className="menu-item"
              onClick={async () => {
                close();
                const dir = await api.pickDirectory();
                if (dir) await createBoard(dir.split(/[\\/]/).pop() || dir, dir);
              }}
            >
              + Доска на папке…
            </button>
          </div>
        )}
      </div>

      {board?.rootDir && <span className="tb-path" title={board.rootDir}>{board.rootDir}</span>}

      <div className="tb-sep" />

      <div className="menu-wrap" ref={addRef}>
        <button className="tb-btn tb-primary" onClick={() => setMenu(menu === 'add' ? null : 'add')}>+ Блок</button>
        {menu === 'add' && (
          <div className="menu menu--grid menu-pop">
            <div className="menu-hint">Перетащите на доску или нажмите и укажите место</div>
            {GROUPS.map((group) => (
              <div key={group.title} className="menu-group">
                <div className="menu-title">{group.title}</div>
                {group.types.map((type) => (
                  <button
                    key={type}
                    className="menu-item menu-item--block"
                    title={ARTIFACT_DEFINITIONS[type].hint}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      beginPlacement(type, e.clientX, e.clientY);
                      close();
                    }}
                  >
                    <span className="block-glyph">{GLYPH[type]}</span>
                    {ARTIFACT_DEFINITIONS[type].label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        className={'tb-btn' + (tool === 'zone' ? ' is-on' : '')}
        title="Зоны (Z): протяните прямоугольник — появится зона, с Shift — вырез"
        onClick={() => setTool(tool === 'zone' ? 'select' : 'zone')}
      >
        ▧ Зоны
      </button>
      <button className={'tb-btn' + (tool === 'draw' ? ' is-on' : '')} title="Рисование в выделенном рисунке (D)" onClick={() => setTool(tool === 'draw' ? 'select' : 'draw')}>
        ✎ Рисовать
      </button>
      <button className="tb-btn" title="Отменить (Ctrl+Z)" onClick={() => void undo()}>↶</button>
      <button className="tb-btn" title="Повторить (Ctrl+Shift+Z)" onClick={() => void redo()}>↷</button>

      <div className="tb-spacer" />

      <div className="menu-wrap" ref={benchRef}>
        <button className="tb-btn" onClick={() => setMenu(menu === 'bench' ? null : 'bench')}>Бенч ▾</button>
        {menu === 'bench' && (
          <div className="menu menu--right menu-pop">
            {[1000, 5000, 10000].map((n) => (
              <button key={n} className="menu-item" onClick={() => { close(); void createBenchBoard(n); }}>
                Доска на {n.toLocaleString('ru')} артефактов
              </button>
            ))}
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => { close(); window.dispatchEvent(new Event('zmtki:bench')); }}>
              Прогнать замер FPS на текущей доске
            </button>
          </div>
        )}
      </div>
    </header>
  );
};
