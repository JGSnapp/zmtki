import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

const plugins = [remarkGfm, remarkBreaks];

const components = {
  a: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} target="_blank" rel="noreferrer" />,
};

/**
 * Renders agent/user authored text as markdown. Raw HTML stays disabled,
 * so untrusted model output can never inject markup.
 */
export const Markdown = ({ text, className }: { text: string; className?: string }) => (
  <div className={className ? `markdown ${className}` : 'markdown'}>
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {text}
    </ReactMarkdown>
  </div>
);
