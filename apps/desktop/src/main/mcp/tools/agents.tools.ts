import { int, objectSchema, str, type ToolSpec } from './types.js';

/**
 * Tools for working with other agents.
 *
 * An agent never puts another agent on the board by itself: `agent_spawn`
 * raises a request, the user answers it, and only then does a terminal appear.
 * The limit and whether the question is asked at all are the user's settings
 * per agent — an agent can read them but not change them.
 */
export const agentSpawn: ToolSpec = {
  name: 'agent_spawn',
  description:
    'Просит у пользователя разрешение запустить субагента — отдельного CLI-агента в своём терминале на этой доске. ' +
    'Вызов ждёт ответа до полутора минут: если пользователь не ответил, вернётся requestId, и можно продолжить своё дело, ' +
    'а позже проверить через agent_status. Субагент получает ту же доску и (если ты привязан к зоне) ту же зону. ' +
    'Пиши в purpose, зачем он нужен: пользователь видит именно этот текст, когда решает.',
  parameters: objectSchema(
    {
      purpose: str('Зачем нужен субагент: какую часть работы он возьмёт. Одна фраза.'),
      harnessId: str('Какой CLI запустить: claude, codex, opencode. По умолчанию тот же, что у тебя.'),
      cwd: str('Рабочая папка субагента. По умолчанию твоя.'),
    },
    ['purpose'],
  ),
  run: async (args, ctx) => {
    if (!ctx.agents || !ctx.agentId) {
      return { data: { refused: true, reason: 'Субагенты доступны только агенту, запущенному на доске' } };
    }
    const outcome = await ctx.agents.requestSubagent(ctx.agentId, {
      purpose: String(args.purpose ?? '').trim() || 'без описания',
      harnessId: typeof args.harnessId === 'string' ? args.harnessId : undefined,
      cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
    });
    if (outcome.status === 'refused') return { data: { refused: true, reason: outcome.reason } };
    if (outcome.status === 'pending') {
      return {
        data: {
          status: 'pending',
          requestId: outcome.requestId,
          note: 'Пользователь пока не ответил. Не жди его: делай, что можешь сам, и проверь позже через agent_status.',
        },
      };
    }
    return {
      data: {
        status: 'started',
        artifactId: outcome.artifactId,
        note: 'Пользователь разрешил. Терминал субагента появился на доске рядом с твоим; когда он поднимется, он появится в agent_list. Ставь ему задачу через agent_send.',
      },
      mutated: true,
    };
  },
};

export const agentStatus: ToolSpec = {
  name: 'agent_status',
  description: 'Что стало с запросом на субагента: ждёт ответа или уже решён (тогда смотри agent_list).',
  parameters: objectSchema({ requestId: str('Идентификатор запроса из agent_spawn') }, ['requestId']),
  run: (args, ctx) => {
    if (!ctx.agents) return { data: { refused: true, reason: 'Нет доступа к агентам' } };
    const state = ctx.agents.requestStatus(String(args.requestId));
    return {
      data: {
        requestId: args.requestId,
        status: state,
        note:
          state === 'pending'
            ? 'Всё ещё ждёт пользователя.'
            : 'Запрос закрыт: либо субагент запущен (ищи его в agent_list), либо пользователь отказал.',
      },
    };
  },
};

export const agentList: ToolSpec = {
  name: 'agent_list',
  description:
    'Кто работает на этой доске: ты сам (твоя зона, лимит субагентов), твои субагенты и остальные агенты. ' +
    'Идентификаторы отсюда нужны для agent_send и agent_stop.',
  parameters: objectSchema({}),
  run: (_args, ctx) => {
    if (!ctx.agents) return { data: { agents: [] } };
    const all = ctx.agents.list().filter((agent) => agent.boardId === ctx.boardId);
    const me = all.find((agent) => agent.id === ctx.agentId);
    const describe = (agent: (typeof all)[number]) => ({
      id: agent.id,
      label: agent.label,
      harness: agent.harnessId,
      running: agent.running,
      purpose: agent.purpose,
      artifactId: agent.artifactId,
      zoneId: agent.zoneId,
      toolCalls: agent.toolCalls,
      lastTool: agent.lastTool,
    });
    return {
      data: {
        me: me
          ? {
              ...describe(me),
              subagentLimit: me.subagentLimit,
              subagentsRunning: me.subagentIds.filter((id) => all.some((a) => a.id === id && a.running)).length,
              approvalNeeded: me.requireApproval,
              parentId: me.parentId,
            }
          : null,
        subagents: me ? all.filter((agent) => me.subagentIds.includes(agent.id)).map(describe) : [],
        others: all.filter((agent) => agent.id !== ctx.agentId && !me?.subagentIds.includes(agent.id)).map(describe),
      },
    };
  },
};

export const agentSend: ToolSpec = {
  name: 'agent_send',
  description:
    'Пишет строку в терминал своего субагента — так ему ставится задача или передаётся уточнение. ' +
    'Текст уходит как введённый с клавиатуры, с переводом строки. Чужим агентам писать нельзя.',
  parameters: objectSchema({ agentId: str('Идентификатор субагента из agent_list'), text: str('Что написать') }, [
    'agentId',
    'text',
  ]),
  run: (args, ctx) => {
    if (!ctx.agents || !ctx.agentId) return { data: { refused: true, reason: 'Нет доступа к агентам' } };
    const result = ctx.agents.sendTo(ctx.agentId, String(args.agentId), String(args.text ?? ''));
    return result.ok ? { data: { sent: true } } : { data: { refused: true, reason: result.reason } };
  },
};

export const agentStop: ToolSpec = {
  name: 'agent_stop',
  description:
    'Останавливает своего субагента и освобождает место в лимите. Его терминал остаётся на доске — пользователь может ' +
    'посмотреть, что там было, и удалить карточку сам.',
  parameters: objectSchema({ agentId: str('Идентификатор субагента из agent_list') }, ['agentId']),
  run: (args, ctx) => {
    if (!ctx.agents || !ctx.agentId) return { data: { refused: true, reason: 'Нет доступа к агентам' } };
    const me = ctx.agents.get(ctx.agentId);
    const id = String(args.agentId);
    if (!me?.subagentIds.includes(id)) return { data: { refused: true, reason: 'Это не твой субагент' } };
    ctx.agents.release(id);
    return { data: { stopped: id } };
  },
};

/** Not a tool: shared with the spawn tool's schema helpers. */
void int;

export const agentTools: ToolSpec[] = [agentSpawn, agentStatus, agentList, agentSend, agentStop];
