import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import type { Artifact } from '@zmtki/shared';
import { basicSetup } from 'codemirror';
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../components/Markdown';
import { api } from '../state/store';

export type EditorMode = 'code' | 'text' | 'markdown';

const fileName = (path: string): string => path.split(/[\\/]/).pop() || path;

/** Language by explicit name or by file extension; plain text when unknown. */
export const languageFor = (language: string, path: string): Extension => {
  const key = (language || path.split('.').pop() || '').toLowerCase();
  switch (key) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'javascript':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
    case 'typescript':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'py':
    case 'python':
      return python();
    case 'json':
      return json();
    case 'html':
    case 'htm':
      return html();
    case 'css':
      return css();
    case 'md':
    case 'markdown':
      return markdown();
    default:
      return [];
  }
};

interface Props {
  artifact: Artifact;
  selected: boolean;
  mode: EditorMode;
  onPatch: (props: Record<string, unknown>) => void;
}

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: '#141821' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
  '.cm-gutters': { backgroundColor: '#141821', borderRight: '1px solid rgba(255,255,255,0.06)' },
  '&.cm-focused': { outline: 'none' },
});

const textTheme = EditorView.theme({
  '.cm-scroller': { fontFamily: 'var(--font)', lineHeight: '1.6' },
  '.cm-content': { padding: '10px 4px' },
});

/**
 * A real editor on the board. With a `path` it edits that file on disk —
 * Ctrl+S or "Сохранить" writes it, and a change made outside is picked up when
 * the window regains focus (or offered, if the card has unsaved edits). Without
 * a path the text lives in the card itself and saves on blur.
 *
 * Editing needs the card selected: unselected, a press on it moves the card,
 * exactly like every other card on the board.
 */
export const CodeEditor = ({ artifact, selected, mode, onPatch }: Props) => {
  const path = typeof artifact.props.path === 'string' ? artifact.props.path : '';
  const language = typeof artifact.props.language === 'string' ? artifact.props.language : '';
  const propKey = mode === 'code' ? 'code' : 'text';
  const inline = typeof artifact.props[propKey] === 'string' ? (artifact.props[propKey] as string) : '';

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const lang = useRef(new Compartment());
  const loadedMtime = useRef(0);
  const savedText = useRef('');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  const [preview, setPreview] = useState(mode === 'markdown');
  const [previewText, setPreviewText] = useState(inline);

  const text = () => viewRef.current?.state.doc.toString() ?? '';

  const replaceDoc = (next: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    savedText.current = next;
    setPreviewText(next);
    setDirty(false);
  };

  const save = async () => {
    const current = text();
    try {
      if (path) {
        const stat = await api.files.write(path, current);
        loadedMtime.current = stat.mtime;
      } else {
        onPatch({ [propKey]: current });
      }
      savedText.current = current;
      setDirty(false);
      setChangedOnDisk(false);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  const load = async () => {
    if (!path) return;
    try {
      const { text: content, stat } = await api.files.read(path);
      loadedMtime.current = stat.mtime;
      replaceDoc(content);
      setError('');
      setChangedOnDisk(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // The editor is created once; content, language and editability are swapped in.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: path ? '' : inline,
        extensions: [
          basicSetup,
          oneDark,
          editorTheme,
          mode === 'code' ? [] : [EditorView.lineWrapping, textTheme],
          lang.current.of(languageFor(mode === 'markdown' ? 'md' : language, path)),
          editable.current.of(EditorView.editable.of(selected)),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                void saveRef.current();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const current = update.state.doc.toString();
            setDirty(current !== savedText.current);
            setPreviewText(current);
          }),
        ],
      }),
    });
    viewRef.current = view;
    savedText.current = path ? '' : inline;
    void load();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(selected)) });
    if (selected && !preview) viewRef.current?.focus();
    // Leaving the card saves inline text; files wait for an explicit save.
    if (!selected && !path && text() !== savedText.current) void save();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: lang.current.reconfigure(languageFor(mode === 'markdown' ? 'md' : language, path)) });
  }, [language, path, mode]);

  // Inline text changed from outside (an agent, undo): show it unless mid-edit.
  useEffect(() => {
    if (path || dirty) return;
    if (inline !== text()) replaceDoc(inline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, path]);

  // A file edited elsewhere is noticed when the user comes back to the window.
  useEffect(() => {
    if (!path) return;
    const onFocus = async () => {
      const stat = await api.files.stat(path).catch(() => null);
      if (!stat?.exists || stat.mtime <= loadedMtime.current + 1) return;
      if (text() === savedText.current) void load();
      else setChangedOnDisk(true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const pick = async () => {
    const [chosen] = await api.pickFiles({ title: 'Открыть файл' });
    if (chosen) onPatch({ path: chosen, title: fileName(chosen) });
  };

  const label = path ? fileName(path) : mode === 'code' ? 'Код без файла' : 'Текст без файла';
  const glyph = mode === 'code' ? '‹/›' : mode === 'markdown' ? 'M↓' : '¶';

  return (
    <div className="artifact-editor-card">
      <div className="card-title" data-drag-handle="true" title={path}>
        <span className="lang">{glyph}</span>
        <span className="editor-name">{label}</span>
        {dirty && <span className="dirty" title="Не сохранено">●</span>}
        <span className="card-title-spacer" />
        {mode === 'markdown' && (
          <button className="chip" onPointerDown={(e) => e.stopPropagation()} onClick={() => setPreview((p) => !p)}>
            {preview ? 'Править' : 'Просмотр'}
          </button>
        )}
        <button className="chip" onPointerDown={(e) => e.stopPropagation()} onClick={() => void pick()}>
          {path ? 'Другой файл' : 'Открыть файл…'}
        </button>
        {(dirty || (path && changedOnDisk)) && (
          <button className="chip chip--ok" onPointerDown={(e) => e.stopPropagation()} onClick={() => void save()}>
            Сохранить
          </button>
        )}
      </div>
      {changedOnDisk && (
        <div className="editor-banner">
          Файл изменён на диске.
          <button className="chip" onPointerDown={(e) => e.stopPropagation()} onClick={() => void load()}>
            Загрузить с диска
          </button>
        </div>
      )}
      {error && <div className="editor-banner editor-banner--error">{error}</div>}
      <div
        className={'editor-host' + (preview ? ' is-hidden' : '')}
        ref={hostRef}
        onPointerDown={(e) => selected && e.stopPropagation()}
        onWheel={(e) => selected && e.stopPropagation()}
      />
      {preview && (
        <div
          className="artifact-scroll markdown-preview"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setPreview(false);
          }}
          onWheel={(e) => selected && e.stopPropagation()}
        >
          {previewText.trim() ? <Markdown text={previewText} /> : <span className="placeholder">Пусто — «Править» или двойной клик</span>}
        </div>
      )}
    </div>
  );
};
