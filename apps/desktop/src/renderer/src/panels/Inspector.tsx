import type { Artifact } from '@zmtki/shared';
import { artifactDefinition } from '@zmtki/shared';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { MEDIA_EXTENSIONS } from '../artifacts/registry';
import { api, useStore } from '../state/store';

const str = (props: Record<string, unknown>, key: string, fallback = ''): string =>
  typeof props[key] === 'string' ? (props[key] as string) : fallback;
const num = (props: Record<string, unknown>, key: string, fallback: number): number =>
  typeof props[key] === 'number' ? (props[key] as number) : fallback;

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="inspector-row">
    <span className="inspector-label">{label}</span>
    {children}
  </label>
);

/** A text field that commits on Enter or blur, so typing is one undo step, not one per key. */
const Field = ({ value, onCommit, placeholder, multiline }: { value: string; onCommit: (v: string) => void; placeholder?: string; multiline?: boolean }) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  const common = {
    className: 'inspector-input' + (multiline ? ' inspector-textarea' : ''),
    value: draft,
    placeholder,
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) (e.currentTarget as HTMLElement).blur();
    },
  };
  return multiline ? (
    <textarea {...common} onChange={(e) => setDraft(e.target.value)} rows={6} />
  ) : (
    <input {...common} onChange={(e) => setDraft(e.target.value)} />
  );
};

const Choice = <T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) => (
  <div className="inspector-choice">
    {options.map(([key, label]) => (
      <button key={key} className={'inspector-option' + (key === value ? ' is-on' : '')} onClick={() => onChange(key)}>
        {label}
      </button>
    ))}
  </div>
);

const Color = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
  <input className="inspector-color" type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#888888'} onChange={(e) => onChange(e.target.value)} />
);

const NOTE_COLORS: Array<[string, string]> = [
  ['yellow', '#f2d680'], ['blue', '#a9c4ff'], ['green', '#b9e08f'], ['pink', '#f5a8bd'], ['purple', '#cdb4f6'], ['gray', '#c9ced8'],
];

const FilePick = ({ value, extensions, onPick }: { value: string; extensions?: string[]; onPick: (path: string) => void }) => (
  <div className="inspector-file">
    <span className="inspector-path" title={value}>{value ? value.split(/[\\/]/).pop() : 'не выбран'}</span>
    <button
      className="chip"
      onClick={async () => {
        const [path] = await api.pickFiles({ extensions });
        if (path) onPick(path);
      }}
    >
      Выбрать…
    </button>
  </div>
);

/**
 * Settings of the one selected block. Everything a block can be told — colour,
 * language, source, action — without writing JSON, and the same props an agent
 * sets through `artifact_update`, so what a user tunes here an agent can read.
 */
export const Inspector = () => {
  const selection = useStore((s) => s.selection);
  const board = useStore((s) => s.board);
  const patchProps = useStore((s) => s.patchProps);
  const [collapsed, setCollapsed] = useState(false);

  const artifact: Artifact | undefined = useMemo(
    () => (selection.length === 1 ? board?.state.artifacts.find((a) => a.id === selection[0]) : undefined),
    [selection, board],
  );
  const terminals = useMemo(() => board?.state.artifacts.filter((a) => a.type === 'terminal') ?? [], [board]);
  const allAgents = useStore((s) => s.agents);
  const agents = useMemo(() => allAgents.filter((a) => a.boardId === board?.id), [allAgents, board?.id]);

  if (!artifact || !board) return null;
  const p = artifact.props;
  const set = (props: Record<string, unknown>) => void patchProps(artifact.id, props);
  const def = artifactDefinition(artifact.type);

  let body: ReactNode = null;
  switch (artifact.type) {
    case 'note':
      body = (
        <Row label="Цвет">
          <div className="inspector-swatches">
            {NOTE_COLORS.map(([key, color]) => (
              <button key={key} className={'swatch' + (str(p, 'color', 'yellow') === key ? ' is-on' : '')} style={{ background: color }} onClick={() => set({ color: key })} />
            ))}
          </div>
        </Row>
      );
      break;
    case 'text':
      body = (
        <>
          <Row label="Размер">
            <input className="inspector-range" type="range" min={12} max={96} value={num(p, 'fontSize', 24)} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
            <span className="inspector-value">{num(p, 'fontSize', 24)}</span>
          </Row>
          <Row label="Жирность">
            <Choice value={String(num(p, 'weight', 600))} options={[['400', 'Обычный'], ['600', 'Полужирный'], ['800', 'Жирный']]} onChange={(v) => set({ weight: Number(v) })} />
          </Row>
          <Row label="Выравнивание">
            <Choice value={str(p, 'align', 'left')} options={[['left', 'Слева'], ['center', 'Центр'], ['right', 'Справа']]} onChange={(v) => set({ align: v })} />
          </Row>
          <Row label="Цвет">
            <Color value={str(p, 'color', '#e8e8ea')} onChange={(v) => set({ color: v })} />
          </Row>
        </>
      );
      break;
    case 'shape':
      body = (
        <>
          <Row label="Форма">
            <Choice value={str(p, 'shape', 'rect')} options={[['rect', '▭'], ['ellipse', '◯'], ['diamond', '◇'], ['triangle', '△']]} onChange={(v) => set({ shape: v })} />
          </Row>
          <Row label="Заливка">
            <Color value={str(p, 'fill', '#1f2430')} onChange={(v) => set({ fill: v })} />
          </Row>
          <Row label="Обводка">
            <Color value={str(p, 'stroke', '#5b6478')} onChange={(v) => set({ stroke: v })} />
          </Row>
          <Row label="Подпись">
            <Field value={str(p, 'label')} onCommit={(v) => set({ label: v })} />
          </Row>
        </>
      );
      break;
    case 'code':
      body = (
        <>
          <Row label="Язык">
            <Field value={str(p, 'language')} placeholder="ts, python, bash…" onCommit={(v) => set({ language: v })} />
          </Row>
          <Row label="Заголовок">
            <Field value={str(p, 'title')} onCommit={(v) => set({ title: v })} />
          </Row>
          <Row label="Код">
            <Field value={str(p, 'code')} multiline onCommit={(v) => set({ code: v })} />
          </Row>
        </>
      );
      break;
    case 'code-editor':
    case 'text-editor':
    case 'markdown-doc':
      body = (
        <>
          <Row label="Файл">
            <FilePick value={str(p, 'path')} onPick={(path) => set({ path, title: path.split(/[\\/]/).pop() })} />
          </Row>
          {artifact.type === 'code-editor' && (
            <Row label="Язык">
              <Field value={str(p, 'language')} placeholder="по расширению" onCommit={(v) => set({ language: v })} />
            </Row>
          )}
        </>
      );
      break;
    case 'button': {
      // Buttons made before actions had a kind are read the way the card reads
      // them: a link opens, anything else is a command.
      const kind = str(p, 'actionKind') || (/^https?:\/\//.test(str(p, 'action')) ? 'url' : 'command');
      body = (
        <>
          <Row label="Надпись">
            <Field value={str(p, 'label', 'Кнопка')} onCommit={(v) => set({ label: v })} />
          </Row>
          <Row label="Что делает">
            <Choice
              value={kind}
              options={[
                ['url', 'Ссылка'],
                ['command', 'Команда'],
                ['agent', 'Субагенту'],
              ]}
              onChange={(v) => set({ actionKind: v })}
            />
          </Row>
          <Row label={kind === 'agent' ? 'Задание' : 'Действие'}>
            <Field
              value={str(p, 'action')}
              placeholder={kind === 'url' ? 'https://…' : kind === 'agent' ? 'что сделать' : 'команда'}
              onCommit={(v) => set({ action: v })}
            />
          </Row>
          {kind !== 'url' && (
            <Row label={kind === 'agent' ? 'Агент' : 'Терминал'}>
              <select className="inspector-input" value={str(p, 'target')} onChange={(e) => set({ target: e.target.value })}>
                <option value="">— не выбран —</option>
                {kind === 'agent'
                  ? agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))
                  : terminals.map((t) => (
                      <option key={t.id} value={t.id}>
                        {str(t.props, 'title', 'Терминал')}
                      </option>
                    ))}
              </select>
            </Row>
          )}
          <Row label="Пояснение">
            <Field value={str(p, 'note')} placeholder="что именно произойдёт" onCommit={(v) => set({ note: v })} />
          </Row>
          <Row label="Спрашивать">
            <input
              className="inspector-check"
              type="checkbox"
              // A button an agent left always asks: that is not the user's to switch off.
              checked={p.confirm === true || (kind !== 'url' && !!str(p, 'createdBy'))}
              disabled={kind !== 'url' && !!str(p, 'createdBy')}
              onChange={(e) => set({ confirm: e.target.checked })}
            />
          </Row>
          {str(p, 'createdBy') && <Row label="Поставил"><span className="inspector-static">агент</span></Row>}
        </>
      );
      break;
    }
    case 'drawing':
      body = (
        <>
          <Row label="Цвет">
            <Color value={str(p, 'color', '#e8e8ea')} onChange={(v) => set({ color: v })} />
          </Row>
          <Row label="Толщина">
            <input className="inspector-range" type="range" min={1} max={16} value={num(p, 'width', 3)} onChange={(e) => set({ width: Number(e.target.value) })} />
            <span className="inspector-value">{num(p, 'width', 3)}</span>
          </Row>
          <Row label="">
            <button className="chip" onClick={() => set({ strokes: [] })}>
              Очистить рисунок
            </button>
          </Row>
        </>
      );
      break;
    case 'image':
      body = (
        <>
          <Row label="Источник">
            <Field value={str(p, 'src')} placeholder="https://… или путь" onCommit={(v) => set({ src: v })} />
          </Row>
          <Row label="">
            <FilePick value={str(p, 'src')} extensions={MEDIA_EXTENSIONS.image} onPick={(src) => set({ src })} />
          </Row>
          <Row label="Вписать">
            <Choice value={str(p, 'fit', 'contain')} options={[['contain', 'Целиком'], ['cover', 'Заполнить']]} onChange={(v) => set({ fit: v })} />
          </Row>
        </>
      );
      break;
    case 'video':
    case 'audio':
      body = (
        <>
          <Row label="Источник">
            <Field value={str(p, 'src')} placeholder="https://… или путь" onCommit={(v) => set({ src: v })} />
          </Row>
          <Row label="">
            <FilePick value={str(p, 'src')} extensions={MEDIA_EXTENSIONS[artifact.type]} onPick={(src) => set({ src, title: src.split(/[\\/]/).pop() })} />
          </Row>
        </>
      );
      break;
    case 'webview':
    case 'browser':
      body = (
        <Row label="Адрес">
          <Field value={str(p, 'url')} onCommit={(v) => set({ url: v })} />
        </Row>
      );
      break;
    case 'html':
    case 'ui':
      body = (
        <Row label="HTML">
          <Field value={str(p, 'html')} multiline onCommit={(v) => set({ html: v })} />
        </Row>
      );
      break;
    case 'file':
      body = (
        <Row label="Файл">
          <FilePick value={str(p, 'path')} onPick={(path) => set({ path })} />
        </Row>
      );
      break;
    case 'document':
      body = (
        <Row label="Название">
          <Field value={str(p, 'title')} onCommit={(v) => set({ title: v })} />
        </Row>
      );
      break;
    case 'terminal':
      body = (
        <>
          <Row label="Название">
            <Field value={str(p, 'title', 'Терминал')} onCommit={(v) => set({ title: v })} />
          </Row>
          <Row label="Папка">
            <span className="inspector-path" title={str(p, 'cwd')}>{str(p, 'cwd') || 'домашняя'}</span>
          </Row>
        </>
      );
      break;
    default:
      body = <div className="inspector-empty">Настроек нет — блок настраивается прямо на доске.</div>;
  }

  return (
    <div className={'inspector' + (collapsed ? ' is-collapsed' : '')} onPointerDown={(e) => e.stopPropagation()}>
      <button className="inspector-head" onClick={() => setCollapsed((c) => !c)}>
        <span>Свойства · {def.label}</span>
        <span>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && <div className="inspector-body">{body}</div>}
    </div>
  );
};
