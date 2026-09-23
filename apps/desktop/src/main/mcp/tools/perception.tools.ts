import type { Rect } from '@zmtki/shared';
import { boardQuality, boundsOf, checkIntersections, suggestMoves } from '@zmtki/shared';
import { queryRegion } from '../../boards/operations.js';
import { renderAsciiSchema, renderSvgSchema } from '../render.js';
import { bool, enumOf, num, objectSchema, type ToolContext, type ToolSpec } from './types.js';

const regionProps = {
  x: num('Левая граница области в координатах доски'),
  y: num('Верхняя граница области в координатах доски'),
  width: num('Ширина области'),
  height: num('Высота области'),
};

/** Falls back to the bounding box of everything on the board (plus padding). */
const resolveRegion = (args: Record<string, unknown>, ctx: ToolContext): Rect => {
  const has = ['x', 'y', 'width', 'height'].every((k) => typeof args[k] === 'number');
  if (has) {
    return {
      x: args.x as number,
      y: args.y as number,
      width: Math.max(1, args.width as number),
      height: Math.max(1, args.height as number),
    };
  }
  const state = ctx.boards.read(ctx.boardId, (s) => s);
  if (state.artifacts.length === 0) return { x: -400, y: -300, width: 1600, height: 1000 };
  const bounds = boundsOf(state.artifacts);
  const pad = 120;
  return {
    x: bounds.x - pad,
    y: bounds.y - pad,
    width: bounds.width + pad * 2,
    height: bounds.height + pad * 2,
  };
};

const hasRegion = (args: Record<string, unknown>): boolean =>
  ['x', 'y', 'width', 'height'].every((k) => typeof args[k] === 'number');

export const boardGetRegion: ToolSpec = {
  name: 'board_get_region',
  description:
    'Возвращает точные данные об артефактах и стрелках в области доски: id, тип, координаты, размеры и свойства. Вызывай перед любыми изменениями, чтобы не накладывать артефакты друг на друга. Без аргументов возвращает всю занятую область.',
  parameters: objectSchema(regionProps),
  run: (args, ctx) => {
    const region = resolveRegion(args, ctx);
    const result = ctx.boards.read(ctx.boardId, (state) => queryRegion(state, region));
    return { data: result };
  },
};

export const boardGetSchema: ToolSpec = {
  name: 'board_get_schema',
  description:
    'Схематическое изображение области доски: ASCII-план с рамками артефактов и линиями стрелок (format=ascii) или векторный SVG (format=svg). Дешевле скриншота и показывает взаимное расположение.',
  parameters: objectSchema({
    ...regionProps,
    format: enumOf(['ascii', 'svg'], 'Формат схемы, по умолчанию ascii'),
  }),
  run: (args, ctx) => {
    const region = resolveRegion(args, ctx);
    const format = args.format === 'svg' ? 'svg' : 'ascii';
    const schema = ctx.boards.read(ctx.boardId, (state) =>
      format === 'svg' ? renderSvgSchema(state, region) : renderAsciiSchema(state, region),
    );
    return { data: { format, region, schema } };
  },
};

export const boardScreenshot: ToolSpec = {
  name: 'board_screenshot',
  description:
    'Настоящий скриншот области доски в том виде, в котором её видит пользователь. Используй, когда нужно оценить визуальный результат: читаемость, наложения, композицию. Если клиент недоступен, вернётся схема.',
  parameters: objectSchema(regionProps),
  run: async (args, ctx) => {
    const region = resolveRegion(args, ctx);
    const dataUrl = ctx.screenshots ? await ctx.screenshots.request(ctx.boardId, region) : null;
    if (!dataUrl) {
      const schema = ctx.boards.read(ctx.boardId, (state) => renderAsciiSchema(state, region));
      return {
        data: {
          region,
          captured: false,
          note: 'Область не видна на экране пользователя или окно недоступно — возвращена ASCII-схема. Скриншот снимается только с того, что сейчас на экране.',
          schema,
        },
      };
    }
    return {
      data: { region, captured: true, note: 'Скриншот приложен следующим сообщением.' },
      image: {
        dataUrl,
        caption: `Скриншот области x=${region.x} y=${region.y} w=${region.width} h=${region.height}`,
      },
    };
  },
};

/** Caps the payload so a messy board does not blow up the context window. */
const MAX_FINDINGS = 40;

export const boardCheckIntersections: ToolSpec = {
  name: 'board_check_intersections',
  description:
    'Ищет всё, что портит раскладку: линии сквозь блоки, пересечения, слипшиеся стрелки, тесноту, наложения, подписи без места. Возвращает метрику качества и сравнение с прошлой проверкой. Вызывай после расстановки и после каждой правки.',
  parameters: objectSchema({
    ...regionProps,
    includeArrowArrow: bool('Проверять пересечения стрелок между собой (по умолчанию true)'),
    includeArtifactOverlaps: bool('Проверять наложения артефактов (по умолчанию true)'),
    includeArrowOverlaps: bool('Проверять слипание параллельных стрелок (по умолчанию true)'),
    includeClearance: bool('Проверять зазоры между стрелками и артефактами (по умолчанию true)'),
    includeLabels: bool('Проверять наложения подписей (по умолчанию true)'),
    minArtifactGap: num('Минимальный воздух между артефактами, по умолчанию 40px'),
  }),
  run: (args, ctx) => {
    const region = hasRegion(args) ? resolveRegion(args, ctx) : null;
    const options = {
      region,
      includeArrowArrow: args.includeArrowArrow !== false,
      includeArtifactOverlaps: args.includeArtifactOverlaps !== false,
      includeArrowOverlaps: args.includeArrowOverlaps !== false,
      includeClearance: args.includeClearance !== false,
      includeLabels: args.includeLabels !== false,
      minArtifactGap: typeof args.minArtifactGap === 'number' ? args.minArtifactGap : undefined,
    };

    const { report, quality, moves } = ctx.boards.read(ctx.boardId, (state) => {
      const found = checkIntersections(state.artifacts, state.arrows, options);
      return {
        report: found,
        quality: boardQuality(state.artifacts, state.arrows, { ...options, report: found }),
        // Some crossings cannot be routed away: every attachment and every route
        // meets the same corridor, and the port search exhausts itself finding
        // nothing. What fixes those is moving one block, and the agent cannot
        // find out which without spending a round trip per guess. The engine
        // tries the moves itself and only speaks when one actually helps.
        moves: suggestMoves(state.artifacts, state.arrows),
      };
    });

    const previous = ctx.boards.previousQuality(ctx.boardId);
    ctx.boards.rememberQuality(ctx.boardId, quality.cost);
    const improvedBy = previous == null ? null : Math.round((previous - quality.cost) * 10) / 10;

    const verdict = report.ok
      ? report.counts.arrowArrow > 0
        ? `Жёстких конфликтов нет. Осталось ${report.counts.arrowArrow} пересечений стрелок при допустимых ${report.crossingBudget} — для графа такой плотности это нормально, планарной укладки у него нет. Заканчивай и опиши результат.`
        : 'Жёстких конфликтов нет. Если оценка устраивает — заканчивай и опиши результат.'
      : improvedBy == null
        ? 'Есть конфликты. Если узлы тесно или накладываются — сначала раздвинь их: в тесной раскладке роутер откажется. Потом стороны присоединения, потом один раз board_route_arrows.'
        : improvedBy > 0.5
          ? `Стало лучше на ${improvedBy}. Продолжай тем же способом.`
          : 'Лучше не стало. Сначала раздвинь узлы или поменяй стороны присоединения; намеренные ручные изгибы допустимы, если после них метрика улучшается.';

    return {
      data: {
        region,
        ok: report.ok,
        counts: report.counts,
        crossingBudget: report.crossingBudget,
        quality: {
          score: quality.score,
          cost: quality.cost,
          grade: quality.grade,
          previousCost: previous,
          improvedBy,
        },
        metrics: quality.metrics,
        hints: quality.hints,
        verdict,
        // Only present when a move was actually found to help; an empty list
        // would read as advice to move something.
        ...(moves.length > 0 ? { suggestedMoves: moves } : {}),
        // Crossings with no block worth moving: the fix is where the lines
        // attach, not where the blocks stand. The router tries both ends of a
        // tangled arrow at once and can take one round the bottom — which is
        // exactly the "swap these two lines" a person sees and cannot express
        // as a move.
        ...(report.counts.arrowArrow > 0 && moves.length === 0
          ? {
              crossingAdvice:
                'Пересекаются стрелки, а не блоки. Вызови board_route_arrows: он перебирает точки крепления обоих концов и умеет увести линию другой стороной — так снимаются пересечения, которые переносом блока не чинятся. Если после этого пересечения остались, поменяй местами два узла внутри слоя (artifact_move со списком moves) и переложи стрелки ещё раз.',
            }
          : {}),
        findings: report.findings.slice(0, MAX_FINDINGS),
        truncated: Math.max(0, report.findings.length - MAX_FINDINGS),
      },
    };
  },
};

export const perceptionTools: ToolSpec[] = [
  boardGetRegion,
  boardGetSchema,
  boardScreenshot,
  boardCheckIntersections,
];
