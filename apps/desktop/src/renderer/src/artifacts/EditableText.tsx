import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../components/Markdown';

interface Props {
  value: string;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  /** Render the committed value as markdown; editing always shows the raw source. */
  markdown?: boolean;
  onCommit: (value: string) => void;
}

/**
 * Shared inline editor: double click to edit, Escape cancels, blur or
 * Ctrl+Enter commits. Used by every text-bearing artifact.
 */
export const EditableText = ({ value, placeholder, className, style, markdown, onCommit }: Props) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <textarea
        ref={ref}
        className={`artifact-editor ${className ?? ''}`}
        style={style}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={() => {
          setEditing(false);
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.blur();
          e.stopPropagation();
        }}
      />
    );
  }

  return (
    <div
      className={`artifact-text ${className ?? ''}`}
      style={style}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {value ? (
        markdown ? (
          <Markdown text={value} />
        ) : (
          value
        )
      ) : (
        <span className="placeholder">{placeholder ?? 'двойной клик — редактировать'}</span>
      )}
    </div>
  );
};
