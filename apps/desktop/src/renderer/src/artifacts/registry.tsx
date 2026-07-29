import type { ComponentType } from 'react';
import type { ArtifactKind, ArtifactSpec } from '@zmtki/board-schema';

export interface ArtifactViewProps<T extends ArtifactSpec = ArtifactSpec> {
  nodeId: string;
  spec: T;
  /** False when the camera is zoomed out; heavy views render a summary instead. */
  detailed: boolean;
  selected: boolean;
}

type Renderer = ComponentType<ArtifactViewProps>;

const renderers = new Map<ArtifactKind, Renderer>();

/**
 * Artifacts are open-ended by design: an agent can invent a way to show
 * something and the board renders it. Registering by kind keeps that extensible
 * without a switch statement that every new kind has to be threaded through.
 */
export function registerArtifact<T extends ArtifactSpec>(
  kind: T['kind'],
  component: ComponentType<ArtifactViewProps<T>>
): void {
  renderers.set(kind, component as Renderer);
}

export function artifactRenderer(kind: ArtifactKind): Renderer | undefined {
  return renderers.get(kind);
}
