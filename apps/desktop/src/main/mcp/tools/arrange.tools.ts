import { boardQuality, type ArrangeOptions } from '@zmtki/shared';
import { applyRoute } from '../../boards/operations.js';
import { bool, enumOf, int, num, objectSchema, str, type ToolSpec } from './types.js';

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? (value as unknown[]).filter((item): item is string => typeof item === 'string') : [];

/**
 * Placement, not routing, decides how many arrows cross. Measurements on real
 * boards: 12 arrows over 11 hand-placed nodes gave 50 crossings, and no routing
 * parameter moved that number; the same graph laid out in layers gave 0.
 */
export const boardArrangeGraph: ToolSpec = {
  name: 'board_arrange_graph',
  description:
    // Why layering beats bending is the skill's argument, and `direction` and
    // `lockIds` explain themselves below. This schema rides in every request;
    // the reasoning is fetched once.
    'Раскладывает созданные артефакты как граф: слои вдоль потока, порядок внутри слоя против ' +
    'пересечений, и сразу прокладывает стрелки. Вызывай, когда созданы все узлы и все стрелки. ' +
    'Только двигает — ничего не создаёт и не удаляет. Результат дальше правится обычными ' +
    'artifact_move / arrow_create.',
  parameters: objectSchema({
    nodeIds: {
      type: 'array',
      description:
        'Какие артефакты раскладывать. Без него — все артефакты доски. Перечисленные вне списка не двигаются, и композиция отодвигается от них.',
      items: { type: 'string' },
    },
    direction: enumOf(
      ['auto', 'LR', 'TB', 'RL', 'BT'],
      'Направление потока: LR слева направо, TB сверху вниз, auto — выбрать лучшее по оценке (по умолчанию auto)',
    ),
    groups: {
      type: 'array',
      description:
        'Смысловые группы: узлы одной группы держатся рядом внутри слоя. Задавай их, если у схемы есть подсистемы.',
      items: {
        type: 'object',
        properties: {
          id: str('Имя группы'),
          nodeIds: { type: 'array', description: 'Артефакты группы', items: { type: 'string' } },
        },
        required: ['id', 'nodeIds'],
        additionalProperties: false,
      },
    },
    lockIds: {
      type: 'array',
      description: 'Артефакты, которые обязаны остаться на своих координатах; композиция строится относительно них.',
      items: { type: 'string' },
    },
    nodeSpacing: int('Воздух между соседями внутри слоя, по умолчанию 80px'),
    layerSpacing: int('Расстояние между слоями, по умолчанию 220px'),
    groupSpacing: int('Дополнительный воздух между разными группами, по умолчанию 170px'),
    originX: num('Левый край композиции. Без origin композиция остаётся примерно на месте.'),
    originY: num('Верхний край композиции'),
    dryRun: bool('true — только посчитать и вернуть отчёт, доску не менять'),
  }),
  run: async (args, ctx) => {
    const options: ArrangeOptions = {
      nodeIds: stringList(args.nodeIds),
      lockIds: stringList(args.lockIds),
      direction: (args.direction as ArrangeOptions['direction']) ?? 'auto',
      spacing: {
        node: typeof args.nodeSpacing === 'number' ? args.nodeSpacing : undefined,
        layer: typeof args.layerSpacing === 'number' ? args.layerSpacing : undefined,
        group: typeof args.groupSpacing === 'number' ? args.groupSpacing : undefined,
      },
      groups: Array.isArray(args.groups)
        ? (args.groups as unknown[])
            .map((item) => {
              if (!item || typeof item !== 'object') return null;
              const row = item as Record<string, unknown>;
              if (typeof row.id !== 'string') return null;
              return { id: row.id, nodeIds: stringList(row.nodeIds) };
            })
            .filter((item): item is { id: string; nodeIds: string[] } => item != null)
        : undefined,
      origin:
        typeof args.originX === 'number' && typeof args.originY === 'number'
          ? { x: args.originX, y: args.originY }
          : undefined,
    };

    const graph = ctx.boards.read(ctx.boardId, (state) =>
      state.arrows.length === 0 ? null : { artifacts: state.artifacts.map((a) => ({ ...a })), arrows: state.arrows.map((a) => ({ ...a })) },
    );

    // The search runs on its own thread: it is seconds of CPU on a middling
    // graph, and the window has to keep answering while it does.
    let outcome: Awaited<ReturnType<NonNullable<typeof ctx.arrange>['arrange']>> | null = null;
    if (graph) {
      if (!ctx.arrange) return { data: { refused: true, reason: 'Движок раскладки недоступен' } };
      outcome = await ctx.arrange.arrange(graph.artifacts, graph.arrows, options);
    }
    const preview = outcome?.result ?? null;

    if (!preview) {
      return {
        data: {
          refused: true,
          reason:
            'На доске нет стрелок — раскладывать нечего. Этот тул расставляет связный граф; для набора карточек используй скилл artifact-set и обычный artifact_create.',
        },
        mutated: false,
      };
    }

    const report = {
      direction: preview.chosen.direction,
      searchMs: outcome?.ms,
      // Fewer candidates than planned means the time budget stopped the search;
      // the layout is the best of those that were weighed, not of all of them.
      candidatesTried: outcome ? outcome.tried + '/' + outcome.planned : undefined,
      spacingScale: preview.chosen.spacingScale,
      layers: preview.layout.layers.length,
      layerSizes: preview.layout.layers.map((layer) => layer.length),
      crossings: preview.layout.crossings,
      crossingsBefore: preview.layout.crossingsBefore,
      reversedEdges: preview.layout.reversedEdges.length,
      moved: preview.layout.nodes.length,
      bounds: preview.layout.bounds,
      qualityBefore: preview.qualityBefore,
      qualityAfter: preview.qualityAfter,
      candidates: preview.candidates,
    };

    if (args.dryRun === true) {
      return {
        data: {
          ...report,
          applied: false,
          verdict: `Расчёт: ${preview.qualityBefore.score} → ${preview.qualityAfter.score}/100. Доска не менялась, вызови без dryRun чтобы применить.`,
        },
        mutated: false,
      };
    }

    ctx.boards.mutate(ctx.boardId, (state) => {
      const at = new Map(preview.artifacts.map((item) => [item.id, item]));
      for (const artifact of state.artifacts) {
        const next = at.get(artifact.id);
        if (!next || (next.x === artifact.x && next.y === artifact.y)) continue;
        artifact.x = next.x;
        artifact.y = next.y;
        artifact.updatedAt = Date.now();
      }
      for (const routed of preview.arrows) {
        applyRoute(state, routed.id, {
          bends: routed.bends,
          fromSide: routed.from.side === 'auto' ? 'right' : routed.from.side,
          toSide: routed.to.side === 'auto' ? 'left' : routed.to.side,
          fromOffset: routed.from.offset ?? 0.5,
          toOffset: routed.to.offset ?? 0.5,
        });
      }
      return null;
    });

    const after = ctx.boards.read(ctx.boardId, (state) => boardQuality(state.artifacts, state.arrows));
    ctx.boards.rememberQuality(ctx.boardId, after.cost);

    return {
      data: {
        ...report,
        applied: true,
        qualityAfter: { score: after.score, cost: after.cost, grade: after.grade },
        hints: after.hints,
        // The knobs, spelled out. Run logs showed the agent answering a layout
        // it disliked by hand-moving every node and rebuilding every arrow —
        // five times in one run, for 56% of a whole experiment's tokens. It
        // needs to be told that re-running the layout with other parameters is
        // the way out.
        tuning: {
          подсистемы: 'groups: [{ id, nodeIds }] — узлы одной темы встанут рядом',
          направление: 'direction: LR или TB вместо auto, если нужен конкретный поток',
          воздух: 'nodeSpacing / layerSpacing больше, если тесно или подписям не хватает места',
          частично: 'nodeIds — разложить только часть; lockIds — не двигать то, что уже стоит',
        },
        verdict:
          after.counts.arrowArtifact === 0 && after.counts.artifactArtifact === 0
            ? `Граф разложен по слоям (${report.direction}): ${report.layers} слоёв, пересечений рёбер ${report.crossings}. Оценка ${preview.qualityBefore.score} → ${after.score}/100. ` +
              `Если раскладка не нравится — вызови этот же тул с другими groups / direction / spacing. ` +
              `Двигать узлы руками и пересоздавать связи не нужно: это дороже и обычно хуже.`
            : `Разложено, но конфликты остались: ${JSON.stringify(after.counts)}. ` +
              `Сначала попробуй тот же тул с другими параметрами (см. tuning), и только потом точечные правки. ` +
              `Удалять и создавать связи заново не надо — структура графа от этого не меняется.`,
      },
      mutated: true,
    };
  },
};

export const arrangeTools: ToolSpec[] = [boardArrangeGraph];
