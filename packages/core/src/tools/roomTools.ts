import { DEFAULT_ARTIFACT_SIZE, createArtifactNode } from '@zmtki/board-schema';
import { defineTool, num, objectSchema, str, type ToolResult } from './registry.js';

defineTool({
  name: 'room_list',
  toolset: 'rooms',
  readOnly: true,
  description: 'Показать комнаты, в которых ты состоишь, вместе с участниками.',
  parameters: objectSchema({}),
  async handler(_args, ctx): Promise<ToolResult> {
    const rooms = ctx.services.rooms.listForAgent(ctx.agent.id);
    if (rooms.length === 0) return { content: 'ты пока не состоишь ни в одной комнате' };
    return {
      content: rooms
        .map((r) => `- ${r.id} [${r.kind}] ${r.title} — участники: ${r.members.join(', ')}`)
        .join('\n')
    };
  }
});

defineTool({
  name: 'room_read',
  toolset: 'rooms',
  readOnly: true,
  description: 'Прочитать последние сообщения комнаты.',
  parameters: objectSchema({ roomId: str('Id комнаты'), limit: num('Сколько сообщений, по умолчанию 40') }, [
    'roomId'
  ]),
  async handler(args, ctx): Promise<ToolResult> {
    const limit = typeof args.limit === 'number' ? args.limit : 40;
    const history = ctx.services.rooms.history(String(args.roomId), limit);
    if (history.length === 0) return { content: 'в комнате пока нет сообщений' };
    return {
      content: history.map((m) => `[${new Date(m.createdAt).toISOString()}] ${m.author}: ${m.body}`).join('\n')
    };
  }
});

defineTool({
  name: 'room_send',
  toolset: 'rooms',
  readOnly: false,
  description: [
    'Написать в комнату mid-turn: промежуточный апдейт, @упоминание другого агента, ссылка на артефакт.',
    'Финальный ответ хода публикуется сам — не дублируй его здесь.',
    'Чтобы адресовать конкретного агента, укажи его id в mentions — без этого он не возьмёт ход.',
    'Ссылайся на свои артефакты через artifactNodeIds, чтобы собеседник увидел, о чём речь.'
  ].join(' '),
  parameters: objectSchema(
    {
      roomId: str('Id комнаты'),
      body: str('Текст сообщения'),
      mentions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Id агентов, которым адресовано сообщение'
      },
      artifactNodeIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Id артефактов на твоей доске, на которые ты ссылаешься'
      }
    },
    ['roomId', 'body']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const refs = ((args.artifactNodeIds as string[]) ?? []).map((nodeId) => ({
      boardId: ctx.board.id,
      nodeId
    }));
    const result = await ctx.services.rooms.send({
      roomId: String(args.roomId),
      agentId: ctx.agent.id,
      body: String(args.body),
      mentions: (args.mentions as string[]) ?? [],
      artifactRefs: refs
    });
    if (!result.ok) return { content: result.error ?? 'сообщение не отправлено', isError: true };
    return { content: 'Сообщение отправлено.' };
  }
});

defineTool({
  name: 'room_yield',
  toolset: 'rooms',
  readOnly: false,
  description:
    'Передать слово следующему участнику. Работает в комнатах с политикой moderated, где ты назначен модератором.',
  parameters: objectSchema({ roomId: str('Id комнаты'), nextSpeaker: str('Id агента') }, [
    'roomId',
    'nextSpeaker'
  ]),
  async handler(args, ctx): Promise<ToolResult> {
    const result = await ctx.services.rooms.yieldTo(
      String(args.roomId),
      ctx.agent.id,
      String(args.nextSpeaker)
    );
    if (!result.ok) return { content: result.error ?? 'не удалось передать слово', isError: true };
    return { content: `Слово передано ${args.nextSpeaker}.` };
  }
});

defineTool({
  name: 'agent_directory_search',
  toolset: 'rooms',
  readOnly: true,
  description:
    'Найти других агентов по имени, проекту или специализации, в том числе в закрытых сейчас проектах. Нужен, чтобы понять, кого звать в комнату.',
  parameters: objectSchema({ query: str('Строка поиска; пустая строка вернёт всех') }),
  async handler(args, ctx): Promise<ToolResult> {
    const found = ctx.services.directory.search(String(args.query ?? ''));
    if (found.length === 0) return { content: 'агенты не найдены' };
    return {
      content: found
        .map(
          (a) =>
            `- ${a.agentId} @${a.handle} "${a.name}" — проект ${a.boardName}${a.persona ? `; ${a.persona.slice(0, 120)}` : ''}`
        )
        .join('\n')
    };
  }
});

defineTool({
  name: 'portal_create',
  toolset: 'rooms',
  readOnly: false,
  description:
    'Создать на своей доске живое зеркало артефакта с чужой доски. Так кросс-проектная связь видна визуально. Зеркало доступно только для чтения.',
  parameters: objectSchema({ boardId: str('Id чужой доски'), nodeId: str('Id артефакта на ней') }, [
    'boardId',
    'nodeId'
  ]),
  async handler(args, ctx): Promise<ToolResult> {
    const boardId = String(args.boardId);
    const nodeId = String(args.nodeId);
    const remote = await ctx.services.boards.readRemoteArtifact(boardId, nodeId);
    if (!remote) return { content: `артефакт ${nodeId} на доске ${boardId} не найден`, isError: true };

    const size = DEFAULT_ARTIFACT_SIZE.portal;
    const node = createArtifactNode({
      artifact: {
        kind: 'portal',
        title: remote.title,
        tone: 'idle',
        target: { boardId, nodeId },
        snapshot: remote.summary,
        remoteBoardName: remote.boardName
      },
      position: ctx.board.placeForAgent(ctx.agent.id, size),
      size,
      createdBy: ctx.agent.id
    });
    ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });
    return { content: `Портал на ${remote.boardName}/${nodeId} создан.`, nodeId: node.id };
  }
});

defineTool({
  name: 'task_assign',
  toolset: 'rooms',
  readOnly: false,
  description:
    'Поставить задачу другому агенту: создаёт карточку на канбан-доске и кладёт задачу ему во входящие. Используй вместо простого сообщения, когда нужен отслеживаемый результат.',
  parameters: objectSchema(
    {
      roomId: str('Комната, через которую идёт координация'),
      agentId: str('Id исполнителя'),
      title: str('Краткое название задачи'),
      brief: str('Подробная постановка')
    },
    ['roomId', 'agentId', 'title', 'brief']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const assignee = ctx.services.directory.get(String(args.agentId));
    if (!assignee) return { content: `агент ${args.agentId} не найден`, isError: true };

    const size = DEFAULT_ARTIFACT_SIZE.kanban;
    const cardId = `card_${Date.now().toString(36)}`;
    const node = createArtifactNode({
      artifact: {
        kind: 'kanban',
        title: `Задача: ${String(args.title)}`,
        tone: 'running',
        columns: [
          {
            id: 'todo',
            title: 'К выполнению',
            cards: [
              {
                id: cardId,
                title: String(args.title),
                body: String(args.brief),
                assignee: assignee.name,
                tone: 'idle'
              }
            ]
          },
          { id: 'doing', title: 'В работе', cards: [] },
          { id: 'done', title: 'Готово', cards: [] }
        ]
      },
      position: ctx.board.placeForAgent(ctx.agent.id, size),
      size,
      createdBy: ctx.agent.id
    });
    ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });

    const sent = await ctx.services.rooms.send({
      roomId: String(args.roomId),
      agentId: ctx.agent.id,
      body: `Задача для @${assignee.name}: ${String(args.title)}\n\n${String(args.brief)}`,
      mentions: [String(args.agentId)],
      artifactRefs: [{ boardId: ctx.board.id, nodeId: node.id }]
    });
    if (!sent.ok) return { content: sent.error ?? 'не удалось поставить задачу', isError: true };

    return { content: `Задача поставлена агенту ${assignee.name}, карточка ${node.id}.`, nodeId: node.id };
  }
});

defineTool({
  name: 'delegate_task',
  toolset: 'core',
  readOnly: false,
  description:
    'Запустить одноразового подагента на изолированную подзадачу. Его внутренние шаги не попадут к тебе в контекст — вернётся только итог. Подходит для объёмного исследования или рутины.',
  parameters: objectSchema(
    {
      brief: str('Что именно должен сделать подагент, со всем нужным контекстом'),
      contextNodeIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Артефакты, которые надо показать подагенту'
      }
    },
    ['brief']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    if (!ctx.services.delegate) {
      return { content: 'делегирование недоступно', isError: true };
    }
    const result = await ctx.services.delegate.run({
      parent: ctx.agent,
      brief: String(args.brief),
      contextNodeIds: (args.contextNodeIds as string[]) ?? []
    });
    if (result.error) return { content: `подагент завершился с ошибкой: ${result.error}`, isError: true };
    return { content: result.summary };
  }
});
