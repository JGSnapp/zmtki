import { objectSchema, str, type ToolSpec } from './types.js';

export const skillList: ToolSpec = {
  name: 'skill_list',
  description:
    'Список доступных скиллов: slug, название и когда каждый применять. Каталог уже есть в системном промпте, вызывай этот тул, только если нужно свериться заново.',
  parameters: objectSchema({}),
  run: (_args, ctx) => ({ data: { skills: ctx.skills.catalog() } }),
};

export const skillGet: ToolSpec = {
  name: 'skill_get',
  description:
    'Полная инструкция скилла по его slug. Вызывай в самом начале работы, до создания артефактов, и дальше следуй описанному порядку действий.',
  parameters: objectSchema({ slug: str('Идентификатор скилла, например graph-layout') }, ['slug']),
  run: (args, ctx) => {
    const skill = ctx.skills.get(args.slug as string);
    return {
      data: {
        slug: skill.slug,
        name: skill.name,
        when: skill.when,
        body: skill.body,
      },
    };
  },
};

export const skillTools: ToolSpec[] = [skillList, skillGet];
