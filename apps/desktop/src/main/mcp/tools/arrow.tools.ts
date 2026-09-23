import {
  ANCHOR_SIDES,
  MIN_MIXED_PORT,
  MIN_PORT_ANGLE_DEG,
  anchorPoint,
  centerOf,
  collectIntendedPorts,
  ensureHeadOnBends,
  findMixedPortConflict,
  freePortOffset,
  inspectRawPortAngles,
  intendedPortOf,
  type AnchorSide,
  type Arrow,
  type ArrowRouting,
  type Artifact,
  type Vec2,
} from '@zmtki/shared';
import {
  addBend,
  createArrow,
  deleteArrow,
  moveBend,
  removeBend,
  updateArrow,
} from '../../boards/operations.js';
import { bool, enumOf, int, num, objectSchema, str, type ToolSpec } from './types.js';

interface PortRepair {
  fromSide: AnchorSide;
  toSide: AnchorSide;
  fromOffset?: number;
  toOffset?: number;
  bends: Vec2[];
  /** Human readable list of what the tool fixed on its own. */
  adjustments: string[];
  refused?: {
    refused: true;
    reason: string;
    conflictArrowId?: string;
    conflictSide?: string;
  };
}

/**
 * Ports the agent asks for are often slightly wrong on a rough placement:
 * an entry meets an exit, or a line meets a side almost flat. Both have a
 * mechanical fix — a free offset on the same side, or a perpendicular stub —
 * so the tool applies it and says what it did.
 *
 * Refusing instead costs a full model round-trip and, as the run logs showed,
 * routinely burned ten or more iterations on a single arrow. A refusal is kept
 * only for the case where no side of the box has room left, which is a real
 * layout decision the agent has to make.
 */
const repairPorts = (
  artifacts: Artifact[],
  arrows: Arrow[],
  from: Artifact,
  to: Artifact,
  fromSide: AnchorSide,
  toSide: AnchorSide,
  bends: Vec2[],
  fromOffset?: number | null,
  toOffset?: number | null,
  excludeArrowId?: string,
): PortRepair => {
  const adjustments: string[] = [];
  const ports = collectIntendedPorts(artifacts, arrows, excludeArrowId);

  const settle = (
    artifact: Artifact,
    other: Artifact,
    side: AnchorSide,
    offset: number | null | undefined,
    end: 'from' | 'to',
    towards: Vec2,
  ): { side: AnchorSide; offset?: number; conflict?: { arrowId: string; side: string } } => {
    const intended = intendedPortOf(artifact, side, offset ?? undefined, towards);
    const hit = findMixedPortConflict(ports, {
      artifactId: artifact.id,
      end,
      point: intended.point,
    });
    if (!hit) return { side, offset: offset ?? undefined };

    const free = freePortOffset(artifact, intended.side, end, ports, intended.offset);
    if (free != null) {
      adjustments.push(
        `${end === 'from' ? 'Выход' : 'Вход'} на ${artifact.id}: сторона ${intended.side} уже занята концом стрелки ${hit.arrowId}, ` +
          `порт сдвинут на offset=${free.toFixed(2)}.`,
      );
      return { side: intended.side, offset: free };
    }

    // Nothing free on that side: try the remaining ones, nearest first.
    const centre = centerOf(artifact);
    const alternatives = (['top', 'right', 'bottom', 'left'] as const)
      .filter((candidate) => candidate !== intended.side)
      .sort((a, b) => {
        const pa = anchorPoint(artifact, a, 0.5);
        const pb = anchorPoint(artifact, b, 0.5);
        return (
          Math.hypot(towards.x - pa.x, towards.y - pa.y) -
          Math.hypot(towards.x - pb.x, towards.y - pb.y)
        );
      });
    for (const candidate of alternatives) {
      const offsetOnSide = freePortOffset(artifact, candidate, end, ports, 0.5);
      if (offsetOnSide == null) continue;
      adjustments.push(
        `${end === 'from' ? 'Выход' : 'Вход'} на ${artifact.id} перенесён на сторону ${candidate}: ` +
          `на ${intended.side} не осталось места рядом с концом стрелки ${hit.arrowId}.`,
      );
      return { side: candidate, offset: offsetOnSide };
    }
    void centre;
    void other;
    return { side, offset: offset ?? undefined, conflict: { arrowId: hit.arrowId, side: intended.side } };
  };

  const settledFrom = settle(from, to, fromSide, fromOffset, 'from', bends[0] ?? centerOf(to));
  const settledTo = settle(
    to,
    from,
    toSide,
    toOffset,
    'to',
    bends[bends.length - 1] ?? centerOf(from),
  );

  const conflict = settledFrom.conflict ?? settledTo.conflict;
  if (conflict) {
    return {
      fromSide,
      toSide,
      bends,
      adjustments,
      refused: {
        refused: true,
        reason:
          `На ${settledFrom.conflict ? from.id : to.id} не осталось ни одной стороны, где вход и выход не оказались бы ближе ` +
          `${MIN_MIXED_PORT}px (мешает стрелка ${conflict.arrowId}). Раздвинь узлы или уменьши число связей в этой точке.`,
        conflictArrowId: conflict.arrowId,
        conflictSide: conflict.side,
      },
    };
  }

  // Angles are checked against the ports we just settled on.
  const resolved = inspectRawPortAngles(
    from,
    to,
    settledFrom.side,
    settledTo.side,
    bends,
    settledFrom.offset,
    settledTo.offset,
  );
  let nextBends = bends;
  if (resolved.shallow) {
    nextBends = ensureHeadOnBends(
      from,
      to,
      resolved.fromSide,
      resolved.toSide,
      bends,
      settledFrom.offset ?? 0.5,
      settledTo.offset ?? 0.5,
      artifacts,
    );
    adjustments.push(
      `Стрелка подходила к стороне плашмя (${Math.round(Math.min(resolved.fromAngle, resolved.toAngle))}°, ` +
        `нужно от ${MIN_PORT_ANGLE_DEG}°): добавлен перпендикулярный изгиб. board_route_arrows или board_arrange_graph переложат её нормально.`,
    );
  }

  return {
    // Pinning the resolved sides: an `auto` side is re-derived from the first
    // bend at render time, which would undo the repair we just made.
    fromSide: adjustments.length > 0 ? resolved.fromSide : settledFrom.side,
    toSide: adjustments.length > 0 ? resolved.toSide : settledTo.side,
    fromOffset: settledFrom.offset,
    toOffset: settledTo.offset,
    bends: nextBends,
    adjustments,
  };
};

/**
 * Same checks as `repairPorts`, but reports instead of changing anything.
 *
 * A deliberate placement the user asked for must survive the tool. Quality is
 * the default, not a rule the agent cannot step outside of, so `exact` keeps
 * the geometry and downgrades the gate to a warning.
 */
const describePortIssues = (
  artifacts: Artifact[],
  arrows: Arrow[],
  from: Artifact,
  to: Artifact,
  fromSide: AnchorSide,
  toSide: AnchorSide,
  bends: Vec2[],
  fromOffset?: number | null,
  toOffset?: number | null,
  excludeArrowId?: string,
): string[] => {
  const warnings: string[] = [];
  const angles = inspectRawPortAngles(from, to, fromSide, toSide, bends, fromOffset, toOffset);
  if (angles.shallow) {
    warnings.push(
      `Стрелка подходит к стороне плашмя (${Math.round(Math.min(angles.fromAngle, angles.toAngle))}°, ` +
        `обычно нужно от ${MIN_PORT_ANGLE_DEG}°). Оставлено как задано.`,
    );
  }
  const ports = collectIntendedPorts(artifacts, arrows, excludeArrowId);
  const fromPort = intendedPortOf(from, fromSide, fromOffset ?? undefined, bends[0] ?? centerOf(to));
  const toPort = intendedPortOf(
    to,
    toSide,
    toOffset ?? undefined,
    bends[bends.length - 1] ?? centerOf(from),
  );
  const hit =
    findMixedPortConflict(ports, { artifactId: from.id, end: 'from', point: fromPort.point }) ??
    findMixedPortConflict(ports, { artifactId: to.id, end: 'to', point: toPort.point });
  if (hit) {
    warnings.push(
      `Вход и выход сходятся ближе ${MIN_MIXED_PORT}px рядом со стрелкой ${hit.arrowId} — ` +
        `линии могут слиться. Оставлено как задано.`,
    );
  }
  return warnings;
};

const pointSchema = {
  type: 'object',
  properties: { x: num('X изгиба'), y: num('Y изгиба') },
  required: ['x', 'y'],
  additionalProperties: false,
};

const routingSchema = enumOf(
  ['orthogonal', 'curved', 'straight'],
  'Как рисовать линию: orthogonal — прямые углы (по умолчанию), curved — те же углы, но скруглённые, straight — отрезок напрямую. На маршрут не влияет, только на рисунок.',
);

const styleSchema = {
  type: 'object',
  description: 'Оформление стрелки',
  properties: {
    color: str('CSS-цвет линии'),
    dashed: bool('Пунктирная линия'),
    width: num('Толщина линии'),
    bidirectional: bool('Наконечники с обеих сторон'),
  },
  additionalProperties: false,
};

const offsetSchema = (end: string) =>
  num(
    `Точка присоединения на стороне ${end}: 0..1 вдоль стороны (0.5 — строго центр, 0 — верхний/левый край). ` +
      'Не указывай, если хочешь, чтобы доска сама развела порты и стрелки не слипались.',
  );

const exactSchema = bool(
  'true — оставить стороны, порты и изгибы ровно такими, как заданы, без автоматических ' +
    'поправок. Ставь, когда пользователь попросил конкретное крепление: тул тогда ничего не ' +
    'меняет, а только предупреждает, если получилось некрасиво.',
);

export const arrowCreate: ToolSpec = {
  name: 'arrow_create',
  description:
    'Соединяет артефакты стрелками. Одна связь — fromId/toId, несколько сразу — links (так дешевле: граф из десяти связей это один вызов). Сторона — явная (top/right/bottom/left) или auto по взаимному расположению; без fromOffset/toOffset порты распределяются сами, чтобы параллельные линии не слились. Плохое крепление тул чинит молча и перечисляет правки в adjustments. exact=true — крепление задал пользователь, менять нельзя: тул сохранит как есть и только предупредит.',
  parameters: objectSchema(
    {
      fromId: str('Идентификатор артефакта-источника'),
      toId: str('Идентификатор артефакта-приёмника'),
      fromSide: enumOf(ANCHOR_SIDES, 'Сторона источника'),
      toSide: enumOf(ANCHOR_SIDES, 'Сторона приёмника'),
      fromOffset: offsetSchema('источника'),
      toOffset: offsetSchema('приёмника'),
      bends: { type: 'array', description: 'Точки изгиба по порядку', items: pointSchema },
      label: str('Подпись на стрелке'),
      links: {
        type: 'array',
        description:
          'Несколько стрелок за один вызов. Каждая проходит ту же проверку креплений, что и одиночная.',
        items: objectSchema(
          {
            fromId: str('Источник'),
            toId: str('Приёмник'),
            label: str('Подпись'),
            fromSide: enumOf(ANCHOR_SIDES, 'Сторона источника'),
            toSide: enumOf(ANCHOR_SIDES, 'Сторона приёмника'),
          },
          ['fromId', 'toId'],
        ),
      },
      routing: routingSchema,
      style: styleSchema,
      exact: exactSchema,
    },
    [],
  ),
  run: (args, ctx) => {
    // One call, many arrows.
    //
    // Each link still goes through the same port repair as a single one: the
    // batch is about round trips, not about skipping checks.
    const list = Array.isArray(args.links)
      ? (args.links as Array<Record<string, unknown>>)
      : args.fromId != null && args.toId != null
        ? [args]
        : [];
    if (list.length === 0) {
      return {
        data: { created: false, refused: true, reason: 'Нужны либо fromId и toId, либо непустой links.' },
        mutated: false,
      };
    }

    const exact = args.exact === true;
    const made: unknown[] = [];
    const blocked: Array<Record<string, unknown>> = [];

    for (const spec of list) {
      const fromId = spec.fromId as string;
      const toId = spec.toId as string;
      const fromSide = (spec.fromSide as AnchorSide | undefined) ?? 'auto';
      const toSide = (spec.toSide as AnchorSide | undefined) ?? 'auto';
      const bends = (spec.bends as Vec2[] | undefined) ?? [];
      const fromOffset = spec.fromOffset as number | undefined;
      const toOffset = spec.toOffset as number | undefined;

      const inspected = ctx.boards.read(ctx.boardId, (state) => {
        const from = state.artifacts.find((item) => item.id === fromId);
        const to = state.artifacts.find((item) => item.id === toId);
        if (!from || !to) return null;
        if (exact) {
          return {
            warnings: describePortIssues(
              state.artifacts,
              state.arrows,
              from,
              to,
              fromSide,
              toSide,
              bends,
              fromOffset,
              toOffset,
            ),
          };
        }
        return {
          repair: repairPorts(
            state.artifacts,
            state.arrows,
            from,
            to,
            fromSide,
            toSide,
            bends,
            fromOffset,
            toOffset,
          ),
        };
      });

      // An id that does not exist stays an error when it is the whole call, as
      // it has always been; inside a batch it is recorded and the rest proceed.
      if (inspected === null && list.length > 1) {
        blocked.push({ refused: true, reason: `Нет артефакта ${fromId} или ${toId}.` });
        continue;
      }

      const repair = inspected && 'repair' in inspected ? inspected.repair : null;
      const warnings = (inspected && 'warnings' in inspected ? inspected.warnings : []) ?? [];
      if (repair?.refused) {
        if (list.length === 1) return { data: { created: false, ...repair.refused }, mutated: false };
        blocked.push(repair.refused as unknown as Record<string, unknown>);
        continue;
      }

      const arrow = ctx.boards.mutate(ctx.boardId, (state) =>
        createArrow(state, {
          fromId,
          toId,
          fromSide: repair?.fromSide ?? fromSide,
          toSide: repair?.toSide ?? toSide,
          fromOffset: repair?.fromOffset ?? fromOffset,
          toOffset: repair?.toOffset ?? toOffset,
          bends: repair?.bends ?? bends,
          label: spec.label as string | undefined,
          routing: (spec.routing ?? args.routing) as ArrowRouting | undefined,
          style: (spec.style ?? args.style) as Record<string, never> | undefined,
        }),
      );

      if (list.length === 1) {
        if (repair && repair.adjustments.length > 0) {
          return { data: { ...arrow, adjustments: repair.adjustments }, mutated: true };
        }
        if (warnings.length > 0) {
          return {
            data: {
              ...arrow,
              exact: true,
              warnings,
              note: 'Крепление сохранено ровно как задано. Оценка раскладки может это отметить — это ожидаемо.',
            },
            mutated: true,
          };
        }
        return { data: arrow, mutated: true };
      }

      made.push(
        repair && repair.adjustments.length > 0
          ? { ...arrow, adjustments: repair.adjustments }
          : warnings.length > 0
            ? { ...arrow, exact: true, warnings }
            : arrow,
      );
    }

    if (made.length === 0) {
      return { data: { created: false, ...(blocked[0] ?? {}), blocked }, mutated: false };
    }
    return {
      data: { created: made.length, arrows: made, ...(blocked.length ? { blocked } : {}) },
      mutated: true,
    };
  },
};

export const arrowUpdate: ToolSpec = {
  name: 'arrow_update',
  description:
    'Меняет стороны присоединения, точки портов, подпись, оформление или сразу весь список изгибов существующей стрелки. Передай fromOffset/toOffset = -1, чтобы вернуть порт в автоматический режим.',
  parameters: objectSchema(
    {
      id: str('Идентификатор стрелки'),
      fromSide: enumOf(ANCHOR_SIDES, 'Сторона источника'),
      toSide: enumOf(ANCHOR_SIDES, 'Сторона приёмника'),
      fromOffset: offsetSchema('источника'),
      toOffset: offsetSchema('приёмника'),
      label: str('Подпись на стрелке'),
      routing: routingSchema,
      style: styleSchema,
      bends: { type: 'array', description: 'Полная замена списка изгибов', items: pointSchema },
      exact: exactSchema,
    },
    ['id'],
  ),
  run: (args, ctx) => {
    // Negative offsets are the escape hatch back to automatic port placement.
    const offset = (value: unknown): number | null | undefined => {
      if (typeof value !== 'number') return undefined;
      return value < 0 ? null : value;
    };
    const fromSide = args.fromSide as AnchorSide | undefined;
    const toSide = args.toSide as AnchorSide | undefined;
    const bends = args.bends as Vec2[] | undefined;
    const fromOffset = offset(args.fromOffset);
    const toOffset = offset(args.toOffset);
    const portsTouched =
      fromSide != null || toSide != null || fromOffset !== undefined || toOffset !== undefined || bends != null;

    const exact = args.exact === true;
    const updateWarnings = portsTouched && exact
      ? ctx.boards.read(ctx.boardId, (state) => {
          const arrow = state.arrows.find((item) => item.id === args.id);
          if (!arrow) return [];
          const from = state.artifacts.find((item) => item.id === arrow.from.artifactId);
          const to = state.artifacts.find((item) => item.id === arrow.to.artifactId);
          if (!from || !to) return [];
          return describePortIssues(
            state.artifacts,
            state.arrows,
            from,
            to,
            fromSide ?? arrow.from.side,
            toSide ?? arrow.to.side,
            bends ?? arrow.bends,
            fromOffset === undefined ? (arrow.from.offset ?? 0.5) : (fromOffset ?? 0.5),
            toOffset === undefined ? (arrow.to.offset ?? 0.5) : (toOffset ?? 0.5),
            arrow.id,
          );
        })
      : [];

    const repair = portsTouched && !exact
      ? ctx.boards.read(ctx.boardId, (state) => {
          const arrow = state.arrows.find((item) => item.id === args.id);
          if (!arrow) return null;
          const from = state.artifacts.find((item) => item.id === arrow.from.artifactId);
          const to = state.artifacts.find((item) => item.id === arrow.to.artifactId);
          if (!from || !to) return null;
          const nextFromOffset =
            fromOffset === undefined ? (arrow.from.offset ?? 0.5) : (fromOffset ?? 0.5);
          const nextToOffset = toOffset === undefined ? (arrow.to.offset ?? 0.5) : (toOffset ?? 0.5);
          return repairPorts(
            state.artifacts,
            state.arrows,
            from,
            to,
            fromSide ?? arrow.from.side,
            toSide ?? arrow.to.side,
            bends ?? arrow.bends,
            nextFromOffset,
            nextToOffset,
            arrow.id,
          );
        })
      : null;
    if (repair?.refused) return { data: { updated: false, ...repair.refused }, mutated: false };

    const adjusted = repair != null && repair.adjustments.length > 0;
    const arrow = ctx.boards.mutate(ctx.boardId, (state) =>
      updateArrow(state, args.id as string, {
        fromSide: adjusted ? repair!.fromSide : fromSide,
        toSide: adjusted ? repair!.toSide : toSide,
        fromOffset: adjusted ? repair!.fromOffset : fromOffset,
        toOffset: adjusted ? repair!.toOffset : toOffset,
        label: args.label as string | undefined,
        routing: args.routing as ArrowRouting | undefined,
        style: args.style as Record<string, never> | undefined,
        bends: adjusted ? repair!.bends : bends,
      }),
    );
    if (adjusted) return { data: { ...arrow, adjustments: repair!.adjustments }, mutated: true };
    if (updateWarnings.length > 0) {
      return {
        data: {
          ...arrow,
          exact: true,
          warnings: updateWarnings,
          note: 'Крепление сохранено ровно как задано. Оценка раскладки может это отметить — это ожидаемо.',
        },
        mutated: true,
      };
    }
    return { data: arrow, mutated: true };
  },
};

export const arrowBendAdd: ToolSpec = {
  name: 'arrow_bend_add',
  description:
    'Добавляет точку изгиба стрелке, чтобы обойти другие артефакты. index задаёт позицию в цепочке изгибов, по умолчанию — в конец.',
  parameters: objectSchema(
    {
      id: str('Идентификатор стрелки'),
      x: num('Координата X изгиба'),
      y: num('Координата Y изгиба'),
      index: int('Позиция в списке изгибов'),
    },
    ['id', 'x', 'y'],
  ),
  run: (args, ctx) => {
    const arrow = ctx.boards.mutate(ctx.boardId, (state) =>
      addBend(
        state,
        args.id as string,
        { x: args.x as number, y: args.y as number },
        args.index as number | undefined,
      ),
    );
    return { data: arrow, mutated: true };
  },
};

export const arrowBendMove: ToolSpec = {
  name: 'arrow_bend_move',
  description: 'Двигает существующую точку изгиба стрелки.',
  parameters: objectSchema(
    {
      id: str('Идентификатор стрелки'),
      index: int('Индекс изгиба, начиная с 0'),
      x: num('Новая координата X'),
      y: num('Новая координата Y'),
    },
    ['id', 'index', 'x', 'y'],
  ),
  run: (args, ctx) => {
    const arrow = ctx.boards.mutate(ctx.boardId, (state) =>
      moveBend(state, args.id as string, args.index as number, {
        x: args.x as number,
        y: args.y as number,
      }),
    );
    return { data: arrow, mutated: true };
  },
};

export const arrowBendRemove: ToolSpec = {
  name: 'arrow_bend_remove',
  description: 'Удаляет точку изгиба стрелки.',
  parameters: objectSchema(
    { id: str('Идентификатор стрелки'), index: int('Индекс изгиба') },
    ['id', 'index'],
  ),
  run: (args, ctx) => {
    const arrow = ctx.boards.mutate(ctx.boardId, (state) =>
      removeBend(state, args.id as string, args.index as number),
    );
    return { data: arrow, mutated: true };
  },
};

export const arrowDelete: ToolSpec = {
  name: 'arrow_delete',
  description: 'Удаляет стрелку.',
  parameters: objectSchema({ id: str('Идентификатор стрелки') }, ['id']),
  run: (args, ctx) => {
    ctx.boards.mutate(ctx.boardId, (state) => deleteArrow(state, args.id as string));
    return { data: { deleted: args.id }, mutated: true };
  },
};

export const arrowTools: ToolSpec[] = [
  arrowCreate,
  arrowUpdate,
  arrowBendAdd,
  arrowBendMove,
  arrowBendRemove,
  arrowDelete,
];
