import { z } from 'zod';

/**
 * Artifacts are the product. Every visible thing an agent produces is one of
 * these, which is what lets the board double as the agent's report.
 *
 * Large or binary payloads are not inlined here: they live under
 * `.zmtki/artifacts/<nodeId>/` and are referenced by relative path, so the
 * main board file stays small and diffable in git.
 */

export const StatusToneSchema = z.enum([
  'idle',
  'running',
  'blocked',
  'success',
  'warning',
  'error'
]);
export type StatusTone = z.infer<typeof StatusToneSchema>;

/** Reference to a payload file under `.zmtki/artifacts/<nodeId>/`. */
export const PayloadRefSchema = z.object({
  file: z.string().min(1),
  bytes: z.number().int().nonnegative().optional(),
  mime: z.string().optional()
});
export type PayloadRef = z.infer<typeof PayloadRefSchema>;

/** Points at an artifact, possibly on a different board. */
export const ArtifactRefSchema = z.object({
  boardId: z.string(),
  nodeId: z.string(),
  rev: z.number().int().nonnegative().optional()
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

const base = {
  title: z.string().default(''),
  tone: StatusToneSchema.default('idle')
};

export const TerminalArtifactSchema = z.object({
  kind: z.literal('terminal'),
  ...base,
  cwd: z.string().default(''),
  command: z.string().default(''),
  shell: z.string().optional(),
  /** Set while the process is alive; cleared when it exits. */
  pid: z.number().int().optional(),
  exitCode: z.number().int().nullable().default(null),
  /** Scrollback is streamed live over IPC and persisted here on completion. */
  scrollback: PayloadRefSchema.optional(),
  /** Tail kept inline so a reloaded board shows something without a file read. */
  tail: z.string().default(''),
  running: z.boolean().default(false)
});

export const BrowserArtifactSchema = z.object({
  kind: z.literal('browser'),
  ...base,
  url: z.string().default('about:blank'),
  /** Rendered instead of the live view when zoomed out or when detached. */
  poster: PayloadRefSchema.optional(),
  /** A live WebContentsView is only attached for the focused board. */
  live: z.boolean().default(true)
});

export const FileArtifactSchema = z.object({
  kind: z.literal('file'),
  ...base,
  /** Board-relative path. */
  path: z.string(),
  language: z.string().optional(),
  /** Inline snapshot so the board renders without touching disk. */
  preview: z.string().default(''),
  truncated: z.boolean().default(false)
});

export const FileFragmentArtifactSchema = z.object({
  kind: z.literal('fileFragment'),
  ...base,
  path: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  language: z.string().optional(),
  content: z.string().default('')
});

export const DiffArtifactSchema = z.object({
  kind: z.literal('diff'),
  ...base,
  path: z.string(),
  /** Unified diff text. */
  patch: z.string().default(''),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  applied: z.boolean().default(false)
});

export const MarkdownArtifactSchema = z.object({
  kind: z.literal('markdown'),
  ...base,
  text: z.string().default('')
});

export const ImageArtifactSchema = z.object({
  kind: z.literal('image'),
  ...base,
  source: PayloadRefSchema,
  alt: z.string().default(''),
  fit: z.enum(['contain', 'cover']).default('contain')
});

export const TableArtifactSchema = z.object({
  kind: z.literal('table'),
  ...base,
  columns: z.array(z.string()).default([]),
  rows: z.array(z.array(z.string())).default([])
});

export const KanbanCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string().default(''),
  assignee: z.string().optional(),
  tone: StatusToneSchema.default('idle')
});
export type KanbanCard = z.infer<typeof KanbanCardSchema>;

export const KanbanColumnSchema = z.object({
  id: z.string(),
  title: z.string(),
  cards: z.array(KanbanCardSchema).default([])
});
export type KanbanColumn = z.infer<typeof KanbanColumnSchema>;

export const KanbanArtifactSchema = z.object({
  kind: z.literal('kanban'),
  ...base,
  columns: z.array(KanbanColumnSchema).default([])
});

export const StatusArtifactSchema = z.object({
  kind: z.literal('status'),
  ...base,
  headline: z.string().default(''),
  detail: z.string().default(''),
  progress: z.number().min(0).max(1).nullable().default(null),
  fields: z.array(z.object({ label: z.string(), value: z.string() })).default([])
});

export const TodoItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean().default(false)
});

export const TodoArtifactSchema = z.object({
  kind: z.literal('todo'),
  ...base,
  items: z.array(TodoItemSchema).default([])
});

export const MermaidArtifactSchema = z.object({
  kind: z.literal('mermaid'),
  ...base,
  source: z.string().default('graph TD;\n  A-->B;')
});

export const ChartArtifactSchema = z.object({
  kind: z.literal('chart'),
  ...base,
  chartType: z.enum(['bar', 'line', 'area', 'pie']).default('bar'),
  labels: z.array(z.string()).default([]),
  series: z
    .array(z.object({ name: z.string(), values: z.array(z.number()) }))
    .default([])
});

export const LinkArtifactSchema = z.object({
  kind: z.literal('link'),
  ...base,
  url: z.string(),
  description: z.string().default(''),
  favicon: z.string().optional()
});

/**
 * The escape hatch that makes "an agent can show anything" true. The HTML runs
 * in a sandboxed iframe with no node access and a narrow postMessage bridge.
 */
export const HtmlWidgetArtifactSchema = z.object({
  kind: z.literal('htmlWidget'),
  ...base,
  html: z.string().default(''),
  /** Large widgets spill to a file instead of bloating the board document. */
  source: PayloadRefSchema.optional(),
  height: z.number().int().positive().optional()
});

export const ControlItemSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('button'),
    label: z.string(),
    action: z.string(),
    variant: z.enum(['default', 'primary', 'danger']).default('default')
  }),
  z.object({
    id: z.string(),
    type: z.literal('toggle'),
    label: z.string(),
    action: z.string(),
    value: z.boolean().default(false)
  }),
  z.object({
    id: z.string(),
    type: z.literal('slider'),
    label: z.string(),
    action: z.string(),
    min: z.number().default(0),
    max: z.number().default(100),
    step: z.number().default(1),
    value: z.number().default(0)
  }),
  z.object({
    id: z.string(),
    type: z.literal('textField'),
    label: z.string(),
    action: z.string(),
    value: z.string().default(''),
    placeholder: z.string().optional()
  }),
  z.object({
    id: z.string(),
    type: z.literal('select'),
    label: z.string(),
    action: z.string(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
    value: z.string().default('')
  })
]);
export type ControlItem = z.infer<typeof ControlItemSchema>;

/** Declarative dashboard of interactive controls for project steering. */
export const ControlsArtifactSchema = z.object({
  kind: z.literal('controls'),
  ...base,
  heading: z.string().default(''),
  items: z.array(ControlItemSchema).default([])
});

export const DemoArtifactSchema = z.object({
  kind: z.literal('demo'),
  ...base,
  url: z.string().default('http://localhost:3000'),
  /** Command that serves the demo, so the board can restart it. */
  command: z.string().default(''),
  running: z.boolean().default(false)
});

/** A live, read-only mirror of an artifact that lives on another board. */
export const PortalArtifactSchema = z.object({
  kind: z.literal('portal'),
  ...base,
  target: ArtifactRefSchema,
  /** Cached textual projection, used when the remote board is closed. */
  snapshot: z.string().default(''),
  remoteBoardName: z.string().default('')
});

export const ArtifactSpecSchema = z.discriminatedUnion('kind', [
  TerminalArtifactSchema,
  BrowserArtifactSchema,
  FileArtifactSchema,
  FileFragmentArtifactSchema,
  DiffArtifactSchema,
  MarkdownArtifactSchema,
  ImageArtifactSchema,
  TableArtifactSchema,
  KanbanArtifactSchema,
  StatusArtifactSchema,
  TodoArtifactSchema,
  MermaidArtifactSchema,
  ChartArtifactSchema,
  LinkArtifactSchema,
  HtmlWidgetArtifactSchema,
  ControlsArtifactSchema,
  DemoArtifactSchema,
  PortalArtifactSchema
]);

export type ArtifactSpec = z.infer<typeof ArtifactSpecSchema>;
export type ArtifactKind = ArtifactSpec['kind'];

export const ARTIFACT_KINDS = [
  'terminal',
  'browser',
  'file',
  'fileFragment',
  'diff',
  'markdown',
  'image',
  'table',
  'kanban',
  'status',
  'todo',
  'mermaid',
  'chart',
  'link',
  'htmlWidget',
  'controls',
  'demo',
  'portal'
] as const satisfies readonly ArtifactKind[];

export const DEFAULT_ARTIFACT_SIZE: Record<ArtifactKind, { w: number; h: number }> = {
  terminal: { w: 560, h: 340 },
  browser: { w: 720, h: 480 },
  file: { w: 520, h: 400 },
  fileFragment: { w: 480, h: 260 },
  diff: { w: 560, h: 380 },
  markdown: { w: 420, h: 260 },
  image: { w: 420, h: 300 },
  table: { w: 520, h: 300 },
  kanban: { w: 720, h: 400 },
  status: { w: 320, h: 200 },
  todo: { w: 320, h: 260 },
  mermaid: { w: 520, h: 360 },
  chart: { w: 460, h: 300 },
  link: { w: 320, h: 120 },
  htmlWidget: { w: 520, h: 360 },
  controls: { w: 360, h: 320 },
  demo: { w: 640, h: 440 },
  portal: { w: 420, h: 280 }
};

/**
 * One-line description used in the peripheral index an agent sees for parts of
 * the board outside its frame, and in search results.
 */
export function summarizeArtifact(spec: ArtifactSpec): string {
  switch (spec.kind) {
    case 'terminal':
      return spec.command
        ? `$ ${spec.command}${spec.running ? ' (running)' : ` (exit ${spec.exitCode ?? '?'})`}`
        : 'terminal';
    case 'browser':
      return spec.url;
    case 'file':
      return spec.path;
    case 'fileFragment':
      return `${spec.path}:${spec.startLine}-${spec.endLine}`;
    case 'diff':
      return `${spec.path} (+${spec.additions}/-${spec.deletions})`;
    case 'markdown':
      return spec.text.slice(0, 120).replace(/\s+/g, ' ');
    case 'image':
      return spec.alt || spec.source.file;
    case 'table':
      return `${spec.rows.length} rows x ${spec.columns.length} cols`;
    case 'kanban':
      return spec.columns.map((c) => `${c.title}:${c.cards.length}`).join(', ');
    case 'status':
      return spec.headline || spec.detail.slice(0, 100);
    case 'todo': {
      const done = spec.items.filter((i) => i.done).length;
      return `${done}/${spec.items.length} done`;
    }
    case 'mermaid':
      return spec.source.split('\n', 1)[0] ?? 'diagram';
    case 'chart':
      return `${spec.chartType} chart, ${spec.series.length} series`;
    case 'link':
      return spec.url;
    case 'htmlWidget':
      return spec.title || 'custom widget';
    case 'controls':
      return `${spec.heading || spec.title || 'controls'} (${spec.items.length})`;
    case 'demo':
      return `${spec.url}${spec.running ? ' (running)' : ''}`;
    case 'portal':
      return `-> ${spec.remoteBoardName}/${spec.target.nodeId}`;
  }
}
