import type { ArtifactSpec, DocBlock } from '@zmtki/board-schema';

/** Narrowed aliases so renderers can be typed per kind without repeating Extract. */
type Of<K extends ArtifactSpec['kind']> = Extract<ArtifactSpec, { kind: K }>;

export type { DocBlock };

export type TerminalArtifactSpec = Of<'terminal'>;
export type BrowserArtifactSpec = Of<'browser'>;
export type FileArtifactSpec = Of<'file'>;
export type FileFragmentArtifactSpec = Of<'fileFragment'>;
export type DiffArtifactSpec = Of<'diff'>;
export type MarkdownArtifactSpec = Of<'markdown'>;
export type NoteArtifactSpec = Of<'note'>;
export type BlocksArtifactSpec = Of<'blocks'>;
export type CodePadArtifactSpec = Of<'codePad'>;
export type ImageArtifactSpec = Of<'image'>;
export type MapArtifactSpec = Of<'map'>;
export type MusicArtifactSpec = Of<'music'>;
export type VideoArtifactSpec = Of<'video'>;
export type TableArtifactSpec = Of<'table'>;
export type KanbanArtifactSpec = Of<'kanban'>;
export type StatusArtifactSpec = Of<'status'>;
export type TodoArtifactSpec = Of<'todo'>;
export type MermaidArtifactSpec = Of<'mermaid'>;
export type ChartArtifactSpec = Of<'chart'>;
export type LinkArtifactSpec = Of<'link'>;
export type HtmlWidgetArtifactSpec = Of<'htmlWidget'>;
export type ControlsArtifactSpec = Of<'controls'>;
export type DemoArtifactSpec = Of<'demo'>;
export type AppViewArtifactSpec = Of<'appView'>;
export type PortalArtifactSpec = Of<'portal'>;
