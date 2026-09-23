export type SkillSource = 'builtin' | 'user';

/**
 * A skill is a playbook the agent pulls in on demand: the catalog (name +
 * `when`) is always in the system prompt, the full body is fetched with a tool
 * call only when the task matches.
 */
export interface Skill {
  id: string;
  /** Stable handle the agent passes to skill_get, e.g. `graph-layout`. */
  slug: string;
  name: string;
  /** Short trigger description: when this skill should be used. */
  when: string;
  /** Full instructions, markdown. */
  body: string;
  enabled: boolean;
  source: SkillSource;
  createdAt: number;
  updatedAt: number;
}

export interface SkillSummary {
  slug: string;
  name: string;
  when: string;
}
