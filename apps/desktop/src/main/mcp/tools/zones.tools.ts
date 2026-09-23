import type { Rect } from '@zmtki/shared';
import { normalizeRects, zoneArea, zoneContainsRect } from '@zmtki/shared';
import { createZone } from '../../boards/operations.js';
import { num, objectSchema, str, type ToolSpec } from './types.js';

const rectsFrom = (args: Record<string, unknown>): Rect[] => {
  const list = Array.isArray(args.rects) ? (args.rects as unknown[]) : [];
  const parsed = list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const numbers = ['x', 'y', 'width', 'height'].map((key) => (typeof row[key] === 'number' ? (row[key] as number) : null));
      if (numbers.some((value) => value === null)) return null;
      const [x, y, width, height] = numbers as number[];
      return { x, y, width: Math.abs(width), height: Math.abs(height) };
    })
    .filter((rect): rect is Rect => rect !== null && rect.width > 1 && rect.height > 1);
  if (parsed.length > 0) return parsed;
  const single = ['x', 'y', 'width', 'height'].map((key) => (typeof args[key] === 'number' ? (args[key] as number) : null));
  if (single.some((value) => value === null)) return [];
  const [x, y, width, height] = single as number[];
  return width > 1 && height > 1 ? [{ x, y, width: Math.abs(width), height: Math.abs(height) }] : [];
};

/**
 * Zones are the board's territory: an area claimed for one project or one
 * agent. An agent cannot claim one on its own — it asks, the request appears
 * highlighted on the board, and the user accepts or rejects it. An agent bound
 * to a zone may only place things inside it, so asking for more room is how it
 * gets more room.
 */
export const zoneList: ToolSpec = {
  name: 'zone_list',
  description:
    'Зоны доски: границы, чьи они, какие ещё ждут ответа пользователя. Если ты привязан к зоне, ставить артефакты можно только внутри неё.',
  parameters: objectSchema({}),
  run: (_args, ctx) => {
    const mine = ctx.agents?.get(ctx.agentId ?? '')?.zoneId;
    return ctx.boards.read(ctx.boardId, (state) => ({
      data: {
        myZoneId: mine ?? null,
        zones: state.zones.map((zone) => ({
          id: zone.id,
          title: zone.title,
          rects: zone.rects,
          area: zoneArea(zone),
          pending: zone.pending === true,
          mine: zone.id === mine,
          ownerId: zone.ownerId,
        })),
      },
    }));
  },
};

export const zoneRequest: ToolSpec = {
  name: 'zone_request',
  description:
    'Просит у пользователя область доски под свою работу. Можно передать один прямоугольник (x, y, width, height) ' +
    'или несколько в rects — они сложатся в одну фигуру. Зона появляется подсвеченной и ждёт ответа: не считай её своей, ' +
    'пока пользователь не принял. Если ты уже привязан к зоне и места мало — проси расширение через extendZoneId.',
  parameters: objectSchema(
    {
      title: str('Название зоны: что в ней будет'),
      reason: str('Зачем нужна зона — пользователь прочитает это, решая'),
      x: num('Левая граница'),
      y: num('Верхняя граница'),
      width: num('Ширина'),
      height: num('Высота'),
      rects: {
        type: 'array',
        description: 'Несколько прямоугольников зоны вместо одного',
        items: {
          type: 'object',
          properties: { x: num('Левая граница'), y: num('Верхняя'), width: num('Ширина'), height: num('Высота') },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
      },
      extendZoneId: str('Расширить существующую зону: при согласии прямоугольники добавятся к ней'),
    },
    ['title'],
  ),
  run: (args, ctx) => {
    const rects = normalizeRects(rectsFrom(args));
    if (rects.length === 0) {
      return { data: { refused: true, reason: 'Нужен прямоугольник: x, y, width, height (или список rects)' } };
    }
    const extendZoneId = typeof args.extendZoneId === 'string' ? args.extendZoneId : undefined;
    const zone = ctx.boards.mutate(ctx.boardId, (state) => {
      if (extendZoneId && !state.zones.some((z) => z.id === extendZoneId)) {
        throw new Error('Зона ' + extendZoneId + ' не найдена');
      }
      return createZone(state, {
        title: String(args.title),
        rects,
        pending: true,
        ownerId: ctx.agentId || undefined,
        reason: typeof args.reason === 'string' ? args.reason : undefined,
        extendsZoneId: extendZoneId,
      });
    });
    return {
      data: {
        id: zone.id,
        pending: true,
        note: 'Запрос показан пользователю. Продолжай работать в том, что уже разрешено; zone_list покажет, приняли ли зону.',
      },
      mutated: true,
    };
  },
};

/** Checks a placement against the agent's zone — used by the server before a tool runs. */
export const placementAllowed = (
  zone: Parameters<typeof zoneContainsRect>[0] | undefined,
  rect: Rect,
): boolean => (zone ? zoneContainsRect(zone, rect) : true);

export const zoneTools: ToolSpec[] = [zoneList, zoneRequest];
