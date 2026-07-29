import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, pathExists, readFileIfExists, writeFileAtomic } from '../util/fs.js';
import type { ExtensionScope, SkillMeta } from './types.js';

const SKILL_BUDGET = 7_500;

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw.trim() };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: raw.trim() };
  const yaml = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, '').trim();
  const meta: Record<string, string> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    meta[match[1]!] = match[2]!.replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body };
}

async function loadSkillDir(dir: string, scope: ExtensionScope): Promise<SkillMeta | null> {
  const file = path.join(dir, 'SKILL.md');
  if (!(await pathExists(file))) return null;
  const raw = await readFileIfExists(file);
  if (!raw) return null;
  const { meta, body } = parseFrontmatter(raw);
  const name = meta.name || path.basename(dir);
  const description = meta.description || '';
  return { name, description, dir, scope, body };
}

async function scanSkillsRoot(root: string, scope: ExtensionScope): Promise<SkillMeta[]> {
  if (!(await pathExists(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const skills: SkillMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = await loadSkillDir(path.join(root, entry.name), scope);
    if (skill) skills.push(skill);
  }
  return skills;
}

/**
 * Loads Cursor-compatible skills from the global app dir and the board folder.
 * Board skills with the same name override global ones.
 */
export class SkillLoader {
  private skills = new Map<string, SkillMeta>();

  constructor(
    private readonly globalDir: string,
    private boardDir: string | null = null
  ) {}

  setBoardDir(boardDir: string | null): void {
    this.boardDir = boardDir;
  }

  async reload(): Promise<SkillMeta[]> {
    await ensureDir(this.globalSkillsRoot());
    const global = await scanSkillsRoot(this.globalSkillsRoot(), 'global');
    const board = this.boardDir
      ? await scanSkillsRoot(path.join(this.boardDir, '.zmtki', 'skills'), 'board')
      : [];

    this.skills.clear();
    for (const skill of global) this.skills.set(skill.name, skill);
    for (const skill of board) this.skills.set(skill.name, skill);
    return this.list();
  }

  list(): SkillMeta[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillMeta | undefined {
    return this.skills.get(name);
  }

  /**
   * Compact index always; full bodies for skills whose description matches the
   * turn text, until the character budget is spent.
   */
  promptBlock(turnText: string): string {
    const all = this.list();
    if (all.length === 0) return '';

    const index = all
      .map((s) => `- ${s.name} (${s.scope}): ${s.description || 'без описания'}`)
      .join('\n');

    const query = turnText.toLowerCase();
    const ranked = [...all].sort((a, b) => score(b, query) - score(a, query));
    const bodies: string[] = [];
    let used = index.length;
    for (const skill of ranked) {
      if (score(skill, query) <= 0 && bodies.length > 0) continue;
      const chunk = `\n### skill:${skill.name}\n${skill.body}`;
      if (used + chunk.length > SKILL_BUDGET) break;
      bodies.push(chunk);
      used += chunk.length;
    }

    return [
      '# Skills',
      'Доступные навыки (читай целиком через skill_read при необходимости):',
      index,
      bodies.length > 0 ? '\n## Подгруженные навыки\n' + bodies.join('\n') : ''
    ]
      .filter(Boolean)
      .join('\n');
  }

  async upsert(input: {
    scope: ExtensionScope;
    name: string;
    description: string;
    body: string;
  }): Promise<SkillMeta> {
    const root =
      input.scope === 'global'
        ? this.globalSkillsRoot()
        : path.join(this.requireBoardDir(), '.zmtki', 'skills');
    const dir = path.join(root, sanitizeName(input.name));
    await ensureDir(dir);
    const content = [
      '---',
      `name: ${input.name}`,
      `description: ${JSON.stringify(input.description)}`,
      '---',
      '',
      input.body.trim(),
      ''
    ].join('\n');
    await writeFileAtomic(path.join(dir, 'SKILL.md'), content);
    await this.reload();
    const skill = this.skills.get(input.name);
    if (!skill) throw new Error('скилл не сохранился');
    return skill;
  }

  async remove(scope: ExtensionScope, name: string): Promise<void> {
    const root =
      scope === 'global'
        ? this.globalSkillsRoot()
        : path.join(this.requireBoardDir(), '.zmtki', 'skills');
    const dir = path.join(root, sanitizeName(name));
    if (await pathExists(dir)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    await this.reload();
  }

  private globalSkillsRoot(): string {
    return path.join(this.globalDir, 'skills');
  }

  private requireBoardDir(): string {
    if (!this.boardDir) throw new Error('нет активной доски для board-скиллов');
    return this.boardDir;
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

function score(skill: SkillMeta, query: string): number {
  if (!query) return 0;
  const hay = `${skill.name} ${skill.description}`.toLowerCase();
  let points = 0;
  for (const token of query.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2)) {
    if (hay.includes(token)) points += 1;
  }
  return points;
}
