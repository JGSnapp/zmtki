import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppViewArtifactSpec,
  ChartArtifactSpec,
  ControlsArtifactSpec,
  DemoArtifactSpec,
  DiffArtifactSpec,
  FileArtifactSpec,
  FileFragmentArtifactSpec,
  HtmlWidgetArtifactSpec,
  ImageArtifactSpec,
  KanbanArtifactSpec,
  LinkArtifactSpec,
  MermaidArtifactSpec,
  PortalArtifactSpec,
  StatusArtifactSpec,
  TableArtifactSpec,
  TerminalArtifactSpec,
  TodoArtifactSpec
} from './specTypes.js';
import { registerArtifact, type ArtifactViewProps } from './registry.js';
import { subscribeAppViewFrame } from './appViewFrames.js';
import './editors.js';
import './media.js';
import { submit, useStore } from '../store.js';

// ------------------------------------------------------------------ primitives

function Empty({ text }: { text: string }): JSX.Element {
  return <div className="art-empty">{text}</div>;
}

/** Strips ANSI so terminal output is readable without a full emulator. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n');
}

// ------------------------------------------------------------------ renderers

registerArtifact<StatusArtifactSpec>('status', ({ spec }) => (
  <div className="art-status">
    <div className="art-status-headline">{spec.headline || spec.title}</div>
    {spec.detail && <div className="art-status-detail">{spec.detail}</div>}
    {spec.progress !== null && (
      <div className="art-progress">
        <div className="art-progress-bar" style={{ width: `${Math.round(spec.progress * 100)}%` }} />
      </div>
    )}
    {spec.fields.length > 0 && (
      <dl className="art-fields">
        {spec.fields.map((field, i) => (
          <div key={i}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    )}
  </div>
));

registerArtifact<TerminalArtifactSpec>('terminal', ({ nodeId, spec, detailed }) => {
  const live = useStore((s) => s.terminalBuffers.get(nodeId));
  const ref = useRef<HTMLPreElement>(null);
  const text = stripAnsi(live ?? spec.tail);

  // Follow the tail while the process runs, which is the point of watching it.
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);

  if (!detailed) {
    return <Empty text={`$ ${spec.command}`} />;
  }

  return (
    <div className="art-terminal">
      <div className="art-terminal-cmd">
        <span className="art-terminal-prompt">{spec.cwd || '.'} $</span> {spec.command}
      </div>
      <pre ref={ref} className="art-terminal-out nowheel">
        {text || (spec.running ? 'запуск…' : '(нет вывода)')}
      </pre>
      {spec.running && (
        <button className="art-btn danger" onClick={() => void submit({ type: 'terminal.kill', nodeId })}>
          Остановить
        </button>
      )}
    </div>
  );
});

registerArtifact<DiffArtifactSpec>('diff', ({ spec, detailed }) => {
  if (!detailed) return <Empty text={`${spec.path} +${spec.additions}/-${spec.deletions}`} />;
  return (
    <div className="art-diff">
      <div className="art-diff-head">
        <span className="art-path">{spec.path}</span>
        <span className="art-add">+{spec.additions}</span>
        <span className="art-del">-{spec.deletions}</span>
      </div>
      <pre className="art-diff-body nowheel">
        {spec.patch.split('\n').map((line, i) => (
          <div
            key={i}
            className={
              line.startsWith('+') && !line.startsWith('+++')
                ? 'dl add'
                : line.startsWith('-') && !line.startsWith('---')
                  ? 'dl del'
                  : line.startsWith('@@')
                    ? 'dl hunk'
                    : 'dl'
            }
          >
            {line}
          </div>
        ))}
      </pre>
    </div>
  );
});

registerArtifact<FileArtifactSpec>('file', ({ spec, detailed }) => (
  <div className="art-file">
    <div className="art-path">{spec.path}</div>
    {detailed && (
      <pre className="art-code scroll nowheel">
        <code>{spec.preview}</code>
      </pre>
    )}
    {spec.truncated && <div className="art-note">показано начало файла</div>}
  </div>
));

registerArtifact<FileFragmentArtifactSpec>('fileFragment', ({ spec, detailed }) => (
  <div className="art-file">
    <div className="art-path">
      {spec.path}:{spec.startLine}-{spec.endLine}
    </div>
    {detailed && (
      <pre className="art-code scroll nowheel">
        {spec.content.split('\n').map((line, i) => (
          <div key={i} className="cl">
            <span className="ln">{spec.startLine + i}</span>
            {line}
          </div>
        ))}
      </pre>
    )}
  </div>
));

registerArtifact<TableArtifactSpec>('table', ({ spec, detailed }) => {
  if (!detailed) return <Empty text={`${spec.rows.length} строк`} />;
  return (
    <div className="art-table-wrap nowheel">
      <table className="art-table">
        <thead>
          <tr>
            {spec.columns.map((col, i) => (
              <th key={i}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

registerArtifact<KanbanArtifactSpec>('kanban', ({ spec, detailed }) => {
  if (!detailed) {
    return <Empty text={spec.columns.map((c) => `${c.title}: ${c.cards.length}`).join(' · ')} />;
  }
  return (
    <div className="art-kanban nowheel">
      {spec.columns.map((column) => (
        <div key={column.id} className="art-kanban-col">
          <div className="art-kanban-title">
            {column.title} <span className="art-count">{column.cards.length}</span>
          </div>
          {column.cards.map((card) => (
            <div key={card.id} className={`art-card tone-${card.tone}`}>
              <div className="art-card-title">{card.title}</div>
              {card.body && <div className="art-card-body">{card.body}</div>}
              {card.assignee && <div className="art-card-assignee">{card.assignee}</div>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
});

registerArtifact<TodoArtifactSpec>('todo', ({ spec }) => (
  <ul className="art-todo">
    {spec.items.map((item) => (
      <li key={item.id} className={item.done ? 'done' : ''}>
        <span className="art-check">{item.done ? '✓' : '○'}</span>
        {item.text}
      </li>
    ))}
    {spec.items.length === 0 && <Empty text="пусто" />}
  </ul>
));

registerArtifact<LinkArtifactSpec>('link', ({ spec }) => (
  <button
    className="art-link"
    onClick={() => void window.zmtki.openExternal(spec.url)}
    title={spec.url}
  >
    <div className="art-link-title">{spec.title || spec.url}</div>
    <div className="art-link-url">{spec.url}</div>
    {spec.description && <div className="art-link-desc">{spec.description}</div>}
  </button>
));

registerArtifact<ImageArtifactSpec>('image', ({ nodeId, spec }) => (
  <div className="art-image">
    {/* Payload files are served through a custom protocol registered by main. */}
    <img src={`zmtki-artifact://${nodeId}/${spec.source.file}`} alt={spec.alt} style={{ objectFit: spec.fit }} />
  </div>
));

registerArtifact<ChartArtifactSpec>('chart', ({ spec, detailed }) => {
  const max = useMemo(
    () => Math.max(1, ...spec.series.flatMap((s) => s.values.map((v) => Math.abs(v)))),
    [spec.series]
  );
  if (!detailed || spec.series.length === 0) {
    return <Empty text={`${spec.chartType}, ${spec.series.length} серий`} />;
  }

  const palette = ['#7c9cff', '#a6da95', '#f5a97f', '#f5bde6', '#eed49f'];

  if (spec.chartType === 'pie') {
    const values = spec.series[0]?.values ?? [];
    const total = values.reduce((a, b) => a + b, 0) || 1;
    let angle = -90;
    return (
      <svg className="art-chart" viewBox="0 0 100 100">
        {values.map((value, i) => {
          const sweep = (value / total) * 360;
          const path = arcPath(50, 50, 45, angle, angle + sweep);
          angle += sweep;
          return <path key={i} d={path} fill={palette[i % palette.length]} />;
        })}
      </svg>
    );
  }

  const barWidth = 100 / Math.max(1, spec.labels.length * spec.series.length);
  return (
    <svg className="art-chart" viewBox="0 0 100 60" preserveAspectRatio="none">
      {spec.series.map((series, si) =>
        series.values.map((value, vi) => {
          const height = (Math.abs(value) / max) * 52;
          return (
            <rect
              key={`${si}-${vi}`}
              x={vi * spec.series.length * barWidth + si * barWidth + 0.5}
              y={56 - height}
              width={Math.max(0.6, barWidth - 1)}
              height={height}
              fill={palette[si % palette.length]}
            />
          );
        })
      )}
    </svg>
  );
});

function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(from));
  const y1 = cy + r * Math.sin(rad(from));
  const x2 = cx + r * Math.cos(rad(to));
  const y2 = cy + r * Math.sin(rad(to));
  const large = to - from > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

registerArtifact<MermaidArtifactSpec>('mermaid', ({ nodeId, spec, detailed }) => {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!detailed) return;
    let cancelled = false;
    // Loaded on demand: mermaid is large and most boards never show a diagram.
    void import('mermaid').then(async (module) => {
      const mermaid = module.default;
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
      try {
        const result = await mermaid.render(`m_${nodeId.replace(/[^a-z0-9]/gi, '')}`, spec.source);
        if (!cancelled) {
          setSvg(result.svg);
          setError('');
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [nodeId, spec.source, detailed]);

  if (!detailed) return <Empty text="схема" />;
  if (error) return <pre className="art-error">{error}</pre>;
  return <div className="art-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
});

/**
 * The escape hatch that makes "an agent can display anything" true.
 *
 * Sandboxed with allow-scripts but no allow-same-origin, so the widget can run
 * its own code but cannot read the app, its storage, or reach the preload
 * bridge. Height is reported back over postMessage.
 */
registerArtifact<HtmlWidgetArtifactSpec>('htmlWidget', ({ nodeId, spec, detailed }) => {
  const ref = useRef<HTMLIFrameElement>(null);
  const boardId = useStore((s) => s.activeBoardId);

  const srcDoc = useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8"><style>
      :root{color-scheme:dark}
      body{margin:0;padding:12px;background:#11141b;color:#e6e8ee;
        font:13px/1.5 "Inter",system-ui,-apple-system,sans-serif}
      a{color:#7c9cff} table{border-collapse:collapse;width:100%}
      th,td{border:1px solid #2a3040;padding:4px 8px;text-align:left}
      [data-zmtki-action]{cursor:pointer}
      </style></head><body>${spec.html}
      <script>
        const send = () => parent.postMessage(
          { type: 'zmtki:height', height: document.body.scrollHeight }, '*');
        new ResizeObserver(send).observe(document.body);
        send();
        document.addEventListener('click', (e) => {
          const el = e.target && e.target.closest && e.target.closest('[data-zmtki-action]');
          if (!el) return;
          parent.postMessage({
            type: 'zmtki:action',
            action: el.getAttribute('data-zmtki-action') || '',
            controlId: el.getAttribute('data-zmtki-id') || el.id || 'action',
            value: el.getAttribute('data-zmtki-value') || el.value || true
          }, '*');
        });
      </script></body></html>`,
    [spec.html]
  );

  useEffect(() => {
    const onMessage = (ev: MessageEvent): void => {
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'zmtki:action' && boardId) {
        void submit({
          type: 'artifact.control',
          boardId,
          nodeId,
          controlId: String(data.controlId ?? 'action'),
          action: String(data.action ?? ''),
          value: data.value
        });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [boardId, nodeId]);

  if (!detailed) return <Empty text={spec.title || 'виджет'} />;

  return (
    <iframe
      ref={ref}
      className="art-widget nowheel"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      title={spec.title}
    />
  );
});

registerArtifact<ControlsArtifactSpec>('controls', ({ nodeId, spec }) => {
  const boardId = useStore((s) => s.activeBoardId);

  const invoke = (controlId: string, action: string, value?: unknown): void => {
    if (!boardId) return;
    void submit({
      type: 'artifact.control',
      boardId,
      nodeId,
      controlId,
      action,
      value
    });
  };

  return (
    <div className="art-controls nowheel nodrag">
      {(spec.heading || spec.title) && <div className="art-controls-head">{spec.heading || spec.title}</div>}
      {spec.items.map((item) => {
        if (item.type === 'button') {
          return (
            <button
              key={item.id}
              className={`art-btn ${item.variant === 'primary' ? 'primary' : ''} ${item.variant === 'danger' ? 'danger' : ''}`}
              onClick={() => invoke(item.id, item.action, true)}
            >
              {item.label}
            </button>
          );
        }
        if (item.type === 'toggle') {
          return (
            <label key={item.id} className="art-control-row">
              <input
                type="checkbox"
                checked={item.value}
                onChange={(e) => invoke(item.id, item.action, e.target.checked)}
              />
              {item.label}
            </label>
          );
        }
        if (item.type === 'slider') {
          return (
            <label key={item.id} className="art-control-row">
              {item.label}
              <input
                type="range"
                min={item.min}
                max={item.max}
                step={item.step}
                value={item.value}
                onChange={(e) => invoke(item.id, item.action, Number(e.target.value))}
              />
              <span>{item.value}</span>
            </label>
          );
        }
        if (item.type === 'textField') {
          return (
            <label key={item.id} className="art-control-row">
              {item.label}
              <input
                type="text"
                defaultValue={item.value}
                placeholder={item.placeholder}
                onBlur={(e) => invoke(item.id, item.action, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') invoke(item.id, item.action, (e.target as HTMLInputElement).value);
                }}
              />
            </label>
          );
        }
        if (item.type === 'select') {
          return (
            <label key={item.id} className="art-control-row">
              {item.label}
              <select
                value={item.value}
                onChange={(e) => invoke(item.id, item.action, e.target.value)}
              >
                {item.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        return null;
      })}
    </div>
  );
});

function AppViewSurface({
  nodeId,
  mode,
  url,
  sourceId,
  sourceName,
  fps,
  live,
  detailed,
  label
}: {
  nodeId: string;
  mode: 'web' | 'headless' | 'mirror';
  url: string;
  sourceId: string;
  sourceName: string;
  fps: number;
  live: boolean;
  detailed: boolean;
  label?: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const overlay = mode === 'web' && live && detailed;

  useEffect(() => {
    void submit({
      type: 'appView.open',
      nodeId,
      mode,
      url,
      sourceId,
      sourceName,
      fps,
      live
    });
    // Do not stop on unmount — React Flow remounts nodes often; sessions are
    // torn down via board_app_close / host destroyAll on quit.
  }, [nodeId, mode, sourceId, fps, live]);

  useEffect(() => {
    if (mode === 'mirror') return;
    void submit({ type: 'appView.navigate', nodeId, url });
  }, [nodeId, mode, url]);

  useEffect(() => subscribeAppViewFrame(nodeId, setFrame), [nodeId]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const report = (): void => {
      const rect = element.getBoundingClientRect();
      const visible = overlay && rect.width > 80 && rect.height > 80;
      void submit({
        type: 'appView.setBounds',
        boardId: useStore.getState().activeBoardId ?? '',
        nodeId,
        bounds: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        visible
      });
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener('scroll', report, true);
    const interval = window.setInterval(report, 250);

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', report, true);
      window.clearInterval(interval);
      void submit({
        type: 'appView.setBounds',
        boardId: useStore.getState().activeBoardId ?? '',
        nodeId,
        bounds: null,
        visible: false
      });
    };
  }, [nodeId, overlay]);

  const modeLabel =
    mode === 'web' ? 'WEB' : mode === 'headless' ? 'HEADLESS' : 'MIRROR';
  const title =
    label ||
    (mode === 'mirror' ? sourceName || sourceId || 'window' : url || 'about:blank');

  return (
    <div className="art-appview nowheel nodrag" ref={ref}>
      <div className="art-appview-bar">
        <span className={`art-appview-mode mode-${mode}`}>{modeLabel}</span>
        <span className="art-appview-title" title={title}>
          {title}
        </span>
        {(mode === 'web' || mode === 'headless') && url.startsWith('http') && (
          <button
            type="button"
            className="art-btn"
            onClick={() => void window.zmtki.openExternal(url)}
          >
            ↗
          </button>
        )}
      </div>
      <div className="art-appview-body">
        {overlay ? (
          <div className="art-appview-slot" />
        ) : frame ? (
          <img className="art-appview-frame" src={frame} alt={title} draggable={false} />
        ) : (
          <Empty text={mode === 'mirror' ? 'Ожидание кадра окна…' : 'Загрузка…'} />
        )}
      </div>
    </div>
  );
}

registerArtifact<DemoArtifactSpec>('demo', ({ nodeId, spec, detailed }) => (
  <AppViewSurface
    nodeId={nodeId}
    mode="web"
    url={spec.url}
    sourceId=""
    sourceName=""
    fps={8}
    live
    detailed={detailed}
    label={spec.url}
  />
));

registerArtifact<AppViewArtifactSpec>('appView', ({ nodeId, spec, detailed }) => (
  <AppViewSurface
    nodeId={nodeId}
    mode={spec.mode}
    url={spec.url}
    sourceId={spec.sourceId}
    sourceName={spec.sourceName}
    fps={spec.fps}
    live={spec.live}
    detailed={detailed}
  />
));

registerArtifact<PortalArtifactSpec>('portal', ({ spec }) => (
  <div className="art-portal">
    <div className="art-portal-head">
      ↗ {spec.remoteBoardName} / {spec.target.nodeId}
    </div>
    <pre className="art-portal-body nowheel">{spec.snapshot}</pre>
  </div>
));

/**
 * Legacy browser artifact — same live overlay host as appView mode=web.
 */
registerArtifact('browser', ({ nodeId, spec, detailed }: ArtifactViewProps) => {
  const browser = spec as unknown as { url: string; live: boolean };
  return (
    <AppViewSurface
      nodeId={nodeId}
      mode="web"
      url={browser.url}
      sourceId=""
      sourceName=""
      fps={8}
      live={browser.live !== false}
      detailed={detailed}
      label={browser.url}
    />
  );
});
