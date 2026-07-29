import { DEFAULT_ARTIFACT_SIZE, createArtifactNode } from '@zmtki/board-schema';
import { bool, defineTool, num, objectSchema, str, type ToolResult } from './registry.js';
import { fetchPageText } from '../search/providers.js';

defineTool({
  name: 'web_search',
  toolset: 'web',
  readOnly: true,
  description:
    'Поиск в интернете. Возвращает список результатов. Если результаты важны для отчёта, вынеси их на доску артефактом table через board_create_artifact.',
  parameters: objectSchema(
    {
      query: str('Поисковый запрос'),
      limit: num('Сколько результатов вернуть'),
      showOnBoard: bool('Сразу создать таблицу с результатами на доске')
    },
    ['query']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const query = String(args.query);
    const limit = typeof args.limit === 'number' ? args.limit : undefined;
    const outcome = await ctx.services.search.search(query, limit);

    if (outcome.results.length === 0) {
      const why = outcome.attempts.map((a) => `${a.provider}: ${a.error}`).join('; ');
      return { content: `ничего не найдено. Провайдеры: ${why || 'нет доступных'}`, isError: true };
    }

    const lines = outcome.results.map(
      (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 300)}`
    );

    let nodeId: string | null = null;
    if (args.showOnBoard === true) {
      const size = DEFAULT_ARTIFACT_SIZE.table;
      const node = createArtifactNode({
        artifact: {
          kind: 'table',
          title: `Поиск: ${query}`,
          tone: 'success',
          columns: ['#', 'Заголовок', 'Ссылка', 'Фрагмент'],
          rows: outcome.results.map((r, i) => [
            String(i + 1),
            r.title,
            r.url,
            r.snippet.slice(0, 200)
          ])
        },
        position: ctx.board.placeForAgent(ctx.agent.id, size),
        size,
        createdBy: ctx.agent.id
      });
      ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });
      nodeId = node.id;
    }

    return {
      content: `Провайдер: ${outcome.provider}\n\n${lines.join('\n\n')}`,
      nodeId
    };
  }
});

defineTool({
  name: 'web_fetch',
  toolset: 'web',
  readOnly: true,
  description:
    'Загрузить страницу и извлечь читаемый текст. Приватные адреса и локальная сеть заблокированы.',
  parameters: objectSchema(
    {
      url: str('Полный URL страницы'),
      maxBytes: num('Лимит загрузки в байтах, по умолчанию 2 МБ'),
      showOnBoard: bool('Создать артефакт link с описанием страницы')
    },
    ['url']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const url = String(args.url);
    try {
      const page = await fetchPageText(
        url,
        typeof args.maxBytes === 'number' ? args.maxBytes : undefined
      );

      let nodeId: string | null = null;
      if (args.showOnBoard === true) {
        const size = DEFAULT_ARTIFACT_SIZE.link;
        const node = createArtifactNode({
          artifact: {
            kind: 'link',
            title: page.title || url,
            tone: 'idle',
            url,
            description: page.text.slice(0, 300)
          },
          position: ctx.board.placeForAgent(ctx.agent.id, size),
          size,
          createdBy: ctx.agent.id
        });
        ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });
        nodeId = node.id;
      }

      return {
        content: `# ${page.title || url}\n(HTTP ${page.status}${page.truncated ? ', обрезано' : ''})\n\n${page.text}`,
        nodeId
      };
    } catch (err) {
      return { content: `не удалось загрузить ${url}: ${(err as Error).message}`, isError: true };
    }
  }
});
