import { useEffect, useState, type JSX, type KeyboardEvent } from 'react';
import type {
  BlocksArtifactSpec,
  CodePadArtifactSpec,
  DocBlock,
  MarkdownArtifactSpec,
  NoteArtifactSpec
} from './specTypes.js';
import { registerArtifact } from './registry.js';
import { renderMarkdown } from '../markdown.js';
import { updateArtifact } from './updateArtifact.js';

function blockId(): string {
  return `blk_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function Empty({ text }: { text: string }): JSX.Element {
  return <div className="art-empty">{text}</div>;
}

registerArtifact<MarkdownArtifactSpec>('markdown', ({ nodeId, spec, detailed }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(spec.text);
  useEffect(() => {
    if (!editing) setDraft(spec.text);
  }, [spec.text, editing]);

  if (!detailed) return <Empty text={spec.text.slice(0, 120)} />;

  if (editing) {
    return (
      <div className="art-editor nowheel nodrag">
        <textarea
          className="art-editor-area"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft !== spec.text) updateArtifact(nodeId, { text: draft }, 'Правка markdown');
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="art-markdown nowheel"
      onDoubleClick={() => setEditing(true)}
      title="Двойной клик — редактировать"
    >
      {renderMarkdown(spec.text || '_пусто_')}
    </div>
  );
});

registerArtifact<NoteArtifactSpec>('note', ({ nodeId, spec, detailed }) => {
  const [draft, setDraft] = useState(spec.text);
  useEffect(() => setDraft(spec.text), [spec.text]);
  if (!detailed) return <Empty text={spec.text.slice(0, 120) || 'заметка'} />;
  return (
    <div className="art-editor nowheel nodrag">
      <textarea
        className="art-editor-area art-note-area"
        value={draft}
        placeholder="Текст…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== spec.text) updateArtifact(nodeId, { text: draft }, 'Правка заметки');
        }}
      />
    </div>
  );
});

registerArtifact<CodePadArtifactSpec>('codePad', ({ nodeId, spec, detailed }) => {
  const [content, setContent] = useState(spec.content);
  const [language, setLanguage] = useState(spec.language);
  useEffect(() => setContent(spec.content), [spec.content]);
  useEffect(() => setLanguage(spec.language), [spec.language]);
  if (!detailed) return <Empty text={`${spec.language}: ${spec.content.slice(0, 80)}`} />;
  return (
    <div className="art-editor art-codepad nowheel nodrag">
      <div className="art-codepad-bar">
        <input
          className="art-codepad-lang"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          onBlur={() => {
            if (language !== spec.language) updateArtifact(nodeId, { language }, 'Язык codePad');
          }}
        />
      </div>
      <textarea
        className="art-editor-area art-codepad-area"
        value={content}
        spellCheck={false}
        placeholder="// код"
        onChange={(e) => setContent(e.target.value)}
        onBlur={() => {
          if (content !== spec.content) updateArtifact(nodeId, { content }, 'Правка codePad');
        }}
      />
    </div>
  );
});

function blockLabel(type: DocBlock['type']): string {
  switch (type) {
    case 'heading':
      return 'H';
    case 'paragraph':
      return '¶';
    case 'bullet':
      return '•';
    case 'todo':
      return '☑';
    case 'code':
      return '</>';
    case 'divider':
      return '—';
  }
}

registerArtifact<BlocksArtifactSpec>('blocks', ({ nodeId, spec, detailed }) => {
  const [blocks, setBlocks] = useState<DocBlock[]>(spec.blocks);
  useEffect(() => setBlocks(spec.blocks), [spec.blocks]);

  const persist = (next: DocBlock[]) => {
    setBlocks(next);
    updateArtifact(nodeId, { blocks: next }, 'Правка blocks');
  };

  if (!detailed) {
    return <Empty text={blocks.map((b) => b.text).filter(Boolean).join(' · ').slice(0, 120) || 'документ'} />;
  }

  const updateBlock = (id: string, patch: Partial<DocBlock>, save = true) => {
    const next = blocks.map((b) => (b.id === id ? { ...b, ...patch } : b));
    setBlocks(next);
    if (save) updateArtifact(nodeId, { blocks: next }, 'Правка blocks');
  };

  const removeBlock = (id: string) => {
    const next = blocks.filter((b) => b.id !== id);
    persist(next.length ? next : [{ id: blockId(), type: 'paragraph', text: '' }]);
  };

  const addBlock = (afterId: string | null, type: DocBlock['type'] = 'paragraph') => {
    const block: DocBlock = {
      id: blockId(),
      type,
      text: '',
      ...(type === 'heading' ? { level: 2 } : {}),
      ...(type === 'todo' ? { checked: false } : {})
    };
    if (!afterId) {
      persist([...blocks, block]);
      return;
    }
    const idx = blocks.findIndex((b) => b.id === afterId);
    const next = [...blocks];
    next.splice(idx + 1, 0, block);
    persist(next);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>, block: DocBlock) => {
    if (e.key === 'Enter' && !e.shiftKey && block.type !== 'code') {
      e.preventDefault();
      addBlock(block.id, block.type === 'bullet' || block.type === 'todo' ? block.type : 'paragraph');
    }
    if (e.key === 'Backspace' && !block.text && blocks.length > 1) {
      e.preventDefault();
      removeBlock(block.id);
    }
  };

  return (
    <div className="art-blocks nowheel nodrag">
      {blocks.map((block) => (
        <div key={block.id} className={`art-block art-block-${block.type}`}>
          <button
            type="button"
            className="art-block-kind"
            title="Тип блока"
            onClick={() => {
              const order: DocBlock['type'][] = ['paragraph', 'heading', 'bullet', 'todo', 'code', 'divider'];
              const i = order.indexOf(block.type);
              const next = order[(i + 1) % order.length] ?? 'paragraph';
              updateBlock(block.id, {
                type: next,
                level: next === 'heading' ? block.level ?? 2 : undefined,
                checked: next === 'todo' ? Boolean(block.checked) : undefined
              });
            }}
          >
            {blockLabel(block.type)}
          </button>
          {block.type === 'todo' && (
            <input
              type="checkbox"
              checked={Boolean(block.checked)}
              onChange={(e) => updateBlock(block.id, { checked: e.target.checked })}
            />
          )}
          {block.type === 'divider' ? (
            <hr className="art-block-hr" />
          ) : (
            <textarea
              className={`art-block-input ${block.type === 'heading' ? 'is-heading' : ''} ${block.type === 'code' ? 'is-code' : ''}`}
              value={block.text}
              rows={block.type === 'code' ? 3 : 1}
              placeholder={
                block.type === 'heading'
                  ? 'Заголовок'
                  : block.type === 'bullet'
                    ? 'Пункт'
                    : block.type === 'todo'
                      ? 'Задача'
                      : block.type === 'code'
                        ? 'код'
                        : 'Текст'
              }
              onChange={(e) => updateBlock(block.id, { text: e.target.value }, false)}
              onBlur={() => {
                const current = blocks.find((b) => b.id === block.id);
                const persisted = spec.blocks.find((b) => b.id === block.id);
                if (current && current.text !== (persisted?.text ?? '')) {
                  updateArtifact(nodeId, { blocks }, 'Правка blocks');
                }
              }}
              onKeyDown={(e) => onKey(e, block)}
            />
          )}
        </div>
      ))}
      <div className="art-block-add">
        <button type="button" onClick={() => addBlock(blocks.at(-1)?.id ?? null, 'paragraph')}>
          + блок
        </button>
        <button type="button" onClick={() => addBlock(blocks.at(-1)?.id ?? null, 'heading')}>
          + заголовок
        </button>
        <button type="button" onClick={() => addBlock(blocks.at(-1)?.id ?? null, 'todo')}>
          + задача
        </button>
      </div>
    </div>
  );
});
