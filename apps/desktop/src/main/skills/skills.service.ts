import type { Skill, SkillSummary } from '@zmtki/shared';
import path from 'node:path';
import { badRequest, notFound } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { JsonStore } from '../core/store.js';
import { SEED_SKILLS } from './seed.js';

interface SkillsData {
  skills: Skill[];
  seeded: boolean;
  /**
   * Seed text every built-in skill was installed from, by slug. Lets a shipped
   * skill be updated on startup while leaving one the user has edited alone.
   */
  seedBodies?: Record<string, string>;
}

export interface AddSkillInput {
  slug?: string;
  name: string;
  when: string;
  body: string;
  enabled?: boolean;
}

export interface UpdateSkillInput {
  slug?: string;
  name?: string;
  when?: string;
  body?: string;
  enabled?: boolean;
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'skill';

export class SkillsService {
  private readonly store: JsonStore<SkillsData>;

  constructor(dataDir: string) {
    this.store = new JsonStore<SkillsData>(path.join(dataDir, 'skills.json'), () => ({
      skills: [],
      seeded: false,
      seedBodies: {},
    }));
    this.syncBuiltins();
  }

  /**
   * Installs the built-in skills, and on later starts refreshes the ones that
   * still hold their shipped text. A built-in the user has edited is theirs
   * now and is never overwritten — only `restoreBuiltins` does that.
   */
  private syncBuiltins(): void {
    const now = Date.now();
    this.store.update((data) => {
      const seedBodies = data.seedBodies ?? {};
      for (const seed of SEED_SKILLS) {
        const existing = data.skills.find((skill) => skill.slug === seed.slug);
        if (!existing) {
          // Missing because the user deleted it — `seedBodies` remembers every
          // slug this install has ever been shipped, so a slug it has not seen
          // is new in this version and belongs on the board. Without that
          // distinction no built-in added after the first run ever arrived.
          if (data.seeded && seedBodies[seed.slug] !== undefined) continue;
          data.skills.push({
            id: newId('skl'),
            slug: seed.slug,
            name: seed.name,
            when: seed.when,
            body: seed.body,
            enabled: true,
            source: 'builtin',
            createdAt: now,
            updatedAt: now,
          });
        } else if (existing.source === 'builtin') {
          const shipped = seedBodies[seed.slug];
          const untouched = shipped == null || shipped === existing.body;
          if (untouched && existing.body !== seed.body) {
            existing.name = seed.name;
            existing.when = seed.when;
            existing.body = seed.body;
            existing.updatedAt = now;
          }
        }
        seedBodies[seed.slug] = seed.body;
      }
      data.seedBodies = seedBodies;
      data.seeded = true;
    });
  }

  list(): Skill[] {
    return this.store.get().skills;
  }

  /** Catalog for the system prompt: only what the agent needs to pick a skill. */
  catalog(): SkillSummary[] {
    return this.list()
      .filter((skill) => skill.enabled)
      .map(({ slug, name, when }) => ({ slug, name, when }));
  }

  get(slugOrId: string): Skill {
    const key = slugOrId.trim().toLowerCase();
    const skill = this.list().find(
      (item) => item.slug.toLowerCase() === key || item.id.toLowerCase() === key,
    );
    if (!skill) throw notFound(`Skill ${slugOrId}`);
    return skill;
  }

  private uniqueSlug(base: string, ignoreId?: string): string {
    const taken = new Set(
      this.list()
        .filter((skill) => skill.id !== ignoreId)
        .map((skill) => skill.slug),
    );
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw badRequest('Cannot allocate a unique slug');
  }

  add(input: AddSkillInput): Skill {
    const now = Date.now();
    const skill: Skill = {
      id: newId('skl'),
      slug: this.uniqueSlug(slugify(input.slug || input.name)),
      name: input.name.trim(),
      when: input.when.trim(),
      body: input.body,
      enabled: input.enabled ?? true,
      source: 'user',
      createdAt: now,
      updatedAt: now,
    };
    this.store.update((data) => {
      data.skills.push(skill);
    });
    return skill;
  }

  update(id: string, patch: UpdateSkillInput): Skill {
    const skill = this.get(id);
    if (patch.slug != null) skill.slug = this.uniqueSlug(slugify(patch.slug), skill.id);
    if (patch.name != null) skill.name = patch.name.trim();
    if (patch.when != null) skill.when = patch.when.trim();
    if (patch.body != null) skill.body = patch.body;
    if (patch.enabled != null) skill.enabled = patch.enabled;
    skill.updatedAt = Date.now();
    this.store.update(() => undefined);
    return skill;
  }

  remove(id: string): void {
    this.store.update((data) => {
      const index = data.skills.findIndex((skill) => skill.id === id || skill.slug === id);
      if (index < 0) throw notFound(`Skill ${id}`);
      data.skills.splice(index, 1);
    });
  }

  /** Restores the built-in skills that were deleted or edited. */
  restoreBuiltins(): Skill[] {
    const now = Date.now();
    this.store.update((data) => {
      data.seedBodies = Object.fromEntries(SEED_SKILLS.map((seed) => [seed.slug, seed.body]));
      for (const seed of SEED_SKILLS) {
        const existing = data.skills.find((skill) => skill.slug === seed.slug);
        if (existing) {
          existing.name = seed.name;
          existing.when = seed.when;
          existing.body = seed.body;
          existing.enabled = true;
          existing.source = 'builtin';
          existing.updatedAt = now;
        } else {
          data.skills.push({
            id: newId('skl'),
            slug: seed.slug,
            name: seed.name,
            when: seed.when,
            body: seed.body,
            enabled: true,
            source: 'builtin',
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    });
    return this.list();
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
}
