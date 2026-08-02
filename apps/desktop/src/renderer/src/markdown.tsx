import type { JSX } from 'react';

/**
 * Small Markdown support for chat and markdown artifacts: headings, lists,
 * code fences, bold/italic, inline code, links. Richer content belongs in
 * htmlWidget / a dedicated viewer.
 */
export function renderMarkdown(text: string): JSX.Element[] {
  const lines = text.split('\n');
  const out: JSX.Element[] = [];
  let codeBuffer: string[] | null = null;
  let listBuffer: { ordered: boolean; items: string[] } | null = null;

  const flushList = (key: number): void => {
    if (!listBuffer) return;
    const Tag = listBuffer.ordered ? 'ol' : 'ul';
    out.push(
      <Tag key={`list${key}`}>
        {listBuffer.items.map((item, i) => (
          <li key={i} dangerouslySetInnerHTML={{ __html: inlineMd(item) }} />
        ))}
      </Tag>
    );
    listBuffer = null;
  };

  lines.forEach((line, index) => {
    if (line.startsWith('```')) {
      if (codeBuffer) {
        out.push(
          <pre key={`code${index}`} className="md-code">
            <code>{codeBuffer.join('\n')}</code>
          </pre>
        );
        codeBuffer = null;
      } else {
        flushList(index);
        codeBuffer = [];
      }
      return;
    }
    if (codeBuffer) {
      codeBuffer.push(line);
      return;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushList(index);
      const level = heading[1]?.length ?? 1;
      const Tag = `h${Math.min(4, level + 2)}` as 'h3' | 'h4' | 'h5' | 'h6';
      out.push(<Tag key={index} dangerouslySetInnerHTML={{ __html: inlineMd(heading[2] ?? '') }} />);
      return;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (listBuffer?.ordered) flushList(index);
      listBuffer ??= { ordered: false, items: [] };
      listBuffer.items.push(bullet[1] ?? '');
      return;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (listBuffer && !listBuffer.ordered) flushList(index);
      listBuffer ??= { ordered: true, items: [] };
      listBuffer.items.push(numbered[1] ?? '');
      return;
    }

    flushList(index);
    if (line.trim()) {
      out.push(<p key={index} dangerouslySetInnerHTML={{ __html: inlineMd(line) }} />);
    }
  });

  flushList(lines.length);
  if (codeBuffer) {
    out.push(
      <pre key="code-tail" className="md-code">
        <code>{codeBuffer.join('\n')}</code>
      </pre>
    );
  }
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMd(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}
