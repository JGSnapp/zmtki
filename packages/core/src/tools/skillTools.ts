import { defineTool, objectSchema, str } from './registry.js';
import type { ExtensionHost } from '../extensions/McpHub.js';

let host: ExtensionHost | null = null;

/** Wired once from Workspace so skill tools can reach the loader. */
export function bindExtensionHost(next: ExtensionHost): void {
  host = next;
}

function requireHost(): ExtensionHost {
  if (!host) throw new Error('расширения ещё не инициализированы');
  return host;
}

defineTool({
  name: 'skill_list',
  toolset: 'skills',
  readOnly: true,
  description: 'Список доступных skills (глобальные и доски).',
  parameters: objectSchema({}),
  async handler() {
    const skills = requireHost().skills.list();
    if (skills.length === 0) return { content: 'скиллов нет' };
    return {
      content: skills
        .map((s) => `${s.name} [${s.scope}] — ${s.description || 'без описания'}`)
        .join('\n')
    };
  }
});

defineTool({
  name: 'skill_read',
  toolset: 'skills',
  readOnly: true,
  description: 'Прочитать полный текст skill по имени.',
  parameters: objectSchema({ name: str('Имя skill') }, ['name']),
  async handler(args) {
    const skill = requireHost().skills.get(String(args.name));
    if (!skill) return { content: `скилл не найден: ${args.name}`, isError: true };
    return {
      content: `# ${skill.name}\n${skill.description}\n\n${skill.body}`
    };
  }
});
