import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mcpInstructions, systemPrompt } from '../src/main/mcp/prompt.js';
import { SkillsService } from '../src/main/skills/skills.service.js';
import { makeEnv } from './helpers.js';

/**
 * The skills and the prompt are teca's, carried over unchanged, and what they
 * say decides how an agent works on the board. These check that what arrives
 * is that text — the one that leaves the choice of placement to the model —
 * and that a skill never leaks into the prompt instead of being fetched.
 */
describe('skills and instructions', () => {
  it('seeds the two built-in layout skills', async () => {
    const env = makeEnv();
    try {
      const slugs = env.ctx.skills.list().map((skill) => skill.slug);
      expect(slugs).toEqual(expect.arrayContaining(['artifact-set', 'graph-layout', 'embedded-page']));

      const graph = env.ctx.skills.get('graph-layout');
      expect(graph.source).toBe('builtin');
      // By default the skill is the one that leaves the choice to the model:
      // place by hand on a small graph, call the layout on a tangled one, and
      // check afterwards that the layout drew what was meant.
      expect(graph.body).toMatch(/board_arrange_graph/);
      expect(graph.body).toMatch(/board_route_arrows/);
      expect(graph.body).toMatch(/Выбери способ расстановки/);
      expect(graph.body).toMatch(/Проверь, что вышло задуманное/);
      // The layout defaults must never read as a ban: an explicit user request wins.
      expect(graph.body).toMatch(/exact=true/);
      expect(graph.body).toMatch(/lockIds/);
    } finally {
      await env.dispose();
    }
  });

  it('hands a connecting agent the choice prompt and the catalogue, not the skill bodies', async () => {
    const env = makeEnv();
    try {
      const prompt = systemPrompt();
      expect(prompt).toMatch(/Расстановку ты выбираешь сам/);

      const catalogue = env.ctx.skills
        .catalog()
        .map((skill) => skill.slug + ' — ' + skill.name)
        .join('\n');
      const instructions = mcpInstructions('доска пуста', catalogue);
      expect(instructions).toContain('graph-layout');
      expect(instructions).toContain('доска пуста');
      // The body is fetched with skill_get; carrying it here would cost every
      // agent the whole text on every connect.
      expect(instructions).not.toContain('Шаг 4. Проверь, что вышло задуманное');
    } finally {
      await env.dispose();
    }
  });

  /**
   * A built-in added in a later version has to reach a board that has already
   * been seeded. Until `seedBodies` was consulted, the seeding could not tell
   * "new in this version" from "the user threw it away", assumed the latter for
   * everything, and no built-in added after the first run ever arrived.
   */
  it('delivers a built-in added after the first run, and respects a deleted one', async () => {
    const env = makeEnv();
    try {
      const file = path.join(env.dir, 'skills.json');
      await env.ctx.skills.flush();
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));

      // A board seeded by an older version: it never shipped `embedded-page`,
      // and the user has deleted `artifact-set`.
      data.skills = data.skills.filter((skill: { slug: string }) => skill.slug !== 'embedded-page' && skill.slug !== 'artifact-set');
      delete data.seedBodies['embedded-page'];
      fs.writeFileSync(file, JSON.stringify(data), 'utf8');

      const reopened = new SkillsService(env.dir);
      const slugs = reopened.list().map((skill) => skill.slug);
      expect(slugs).toContain('embedded-page');
      expect(slugs).not.toContain('artifact-set');
      await reopened.flush();
    } finally {
      await env.dispose();
    }
  });

  it('tells an agent how to write a card that has no scrollbar and no pale edge', async () => {
    const env = makeEnv();
    try {
      const skill = env.ctx.skills.get('embedded-page');
      expect(skill.source).toBe('builtin');
      expect(skill.body).toMatch(/box-sizing:border-box/);
      expect(skill.body).toMatch(/margin:0/);
      // The reason, not just the rule: an agent that knows where the 8px comes
      // from can recognise the same mistake in a shape this text did not list.
      expect(skill.body).toMatch(/8px/);

      // And the short form reaches every agent on connect, without the body.
      const instructions = mcpInstructions('доска пуста', 'embedded-page — Карточки с разметкой');
      expect(instructions).toMatch(/box-sizing:border-box/);
      expect(instructions).not.toContain('## Быстрая проверка');
    } finally {
      await env.dispose();
    }
  });

  it('adds, edits and removes user skills with unique slugs', async () => {
    const env = makeEnv();
    try {
      const first = env.ctx.skills.add({ name: 'Мой скилл', when: 'иногда', body: 'текст' });
      const second = env.ctx.skills.add({ name: 'Мой скилл', when: 'иногда', body: 'текст' });
      expect(first.slug).not.toBe(second.slug);
      expect(first.source).toBe('user');

      const updated = env.ctx.skills.update(first.id, { name: 'Переименован', enabled: false });
      expect(updated.name).toBe('Переименован');
      expect(env.ctx.skills.catalog().some((s) => s.slug === first.slug)).toBe(false);

      env.ctx.skills.remove(second.id);
      expect(() => env.ctx.skills.get(second.slug)).toThrow();
    } finally {
      await env.dispose();
    }
  });
});
