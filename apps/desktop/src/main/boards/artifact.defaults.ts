import type { ArtifactProps, ArtifactType } from '@zmtki/shared';
import { ARTIFACT_DEFINITIONS } from '@zmtki/shared';

export interface ArtifactBlueprint {
  width: number;
  height: number;
  props: ArtifactProps;
  /** Documented for the agent so it knows which props each type accepts. */
  propsHint: string;
}

/**
 * Server-side view of the artifact kinds. The definitions themselves live in
 * `@zmtki/shared` so the add-menu in the renderer and the agent's tool schema
 * can never disagree about a default size or a prop name.
 */
export const ARTIFACT_BLUEPRINTS = Object.fromEntries(
  Object.values(ARTIFACT_DEFINITIONS).map((d) => [
    d.type,
    { width: d.width, height: d.height, props: d.props, propsHint: d.propsHint },
  ]),
) as Record<ArtifactType, ArtifactBlueprint>;

export const blueprintFor = (type: ArtifactType): ArtifactBlueprint =>
  ARTIFACT_BLUEPRINTS[type] ?? ARTIFACT_BLUEPRINTS.note;
