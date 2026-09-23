import { artifactDefinition, findFreeSpot, rectsIntersect } from '@zmtki/shared';
import { createArtifact, updateArtifact } from '../../boards/operations.js';
import { bool, enumOf, num, objectSchema, str, type ToolSpec } from './types.js';

/**
 * Buttons are how an agent leaves something for the user to press: run the
 * build, open the report, hand the next task to a subagent. The action is
 * data, never code — one of a few kinds with a value — so a button can do only
 * what these kinds allow, and the user sees exactly what will happen before
 * pressing.
 *
 * A command a user has not written themselves asks for confirmation on the
 * first press; `confirm: false` is only honoured for links.
 */
export const buttonSet: ToolSpec = {
  name: 'button_set',
  description:
    'Создаёт кнопку на доске или перенастраивает существующую (id). Виды действия: ' +
    'url — открыть ссылку в браузере пользователя; ' +
    'command — отправить команду в терминал (targetId — артефакт терминала из board_get_region); ' +
    'agent — отправить текст своему субагенту (targetId — его agentId из agent_list). ' +
    'Пользователь видит надпись и само действие и нажимает сам.',
  parameters: objectSchema(
    {
      id: str('Идентификатор существующей кнопки, если нужно её изменить'),
      label: str('Надпись на кнопке'),
      kind: enumOf(['url', 'command', 'agent'], 'Что делает кнопка'),
      value: str('Ссылка, команда или текст задания — смотря какой kind'),
      targetId: str('Терминал (для command) или субагент (для agent)'),
      x: num('Где поставить новую кнопку'),
      y: num('Где поставить новую кнопку'),
      confirm: bool('Спрашивать подтверждение перед выполнением. Для команд всегда включено'),
      note: str('Пояснение под надписью: что именно произойдёт'),
    },
    ['label', 'kind', 'value'],
  ),
  run: (args, ctx) => {
    const kind = String(args.kind) as 'url' | 'command' | 'agent';
    const value = String(args.value ?? '').trim();
    if (!value) return { data: { refused: true, reason: 'Пустое действие' } };
    if (kind === 'url' && !/^https?:\/\//i.test(value)) {
      return { data: { refused: true, reason: 'Для kind=url нужна ссылка http(s)://' } };
    }
    const targetId = typeof args.targetId === 'string' ? args.targetId : '';
    if (kind !== 'url' && !targetId) {
      return {
        data: {
          refused: true,
          reason:
            kind === 'command'
              ? 'Для kind=command укажи targetId — артефакт терминала (board_get_region покажет терминалы доски)'
              : 'Для kind=agent укажи targetId — agentId субагента из agent_list',
        },
      };
    }
    if (kind === 'agent') {
      const me = ctx.agents?.get(ctx.agentId ?? '');
      if (!me?.subagentIds.includes(targetId)) {
        return { data: { refused: true, reason: 'Кнопка может писать только твоему субагенту' } };
      }
    }

    const props = {
      label: String(args.label),
      actionKind: kind,
      action: value,
      target: targetId || undefined,
      note: typeof args.note === 'string' ? args.note : undefined,
      // A command put there by an agent always asks before it runs.
      confirm: kind === 'url' ? args.confirm === true : true,
      createdBy: ctx.agentId || undefined,
    };

    const definition = artifactDefinition('button');
    const id = typeof args.id === 'string' ? args.id : '';
    const artifact = ctx.boards.mutate(ctx.boardId, (state) => {
      if (id) return updateArtifact(state, id, { props }).artifact;
      const wanted = {
        x: typeof args.x === 'number' ? args.x : 0,
        y: typeof args.y === 'number' ? args.y : 0,
        width: definition.width,
        height: definition.height,
      };
      const spot = findFreeSpot(wanted, (area) => state.artifacts.filter((a) => rectsIntersect(a, area)), { gap: 40 });
      return createArtifact(state, { type: 'button', x: spot.x, y: spot.y, props });
    });

    return {
      data: {
        id: artifact.id,
        x: artifact.x,
        y: artifact.y,
        label: props.label,
        kind,
        confirm: props.confirm,
        note: 'Кнопка на доске. Нажимает её пользователь; команды спрашивают подтверждение.',
      },
      mutated: true,
    };
  },
};

export const buttonTools: ToolSpec[] = [buttonSet];
