import {
  ARTIFACT_TYPES,
  artifactCaption,
  overlappingNeighbors,
  rankArtifactPlacements,
  type Artifact,
  type ArtifactType,
  type Rect,
} from '@zmtki/shared';
import { ARTIFACT_BLUEPRINTS } from '../../boards/artifact.defaults.js';
import {
  createArtifact,
  deleteArtifact,
  updateArtifact,
} from '../../boards/operations.js';
import { bool, enumOf, num, objectSchema, str, type ToolSpec } from './types.js';

const typeCatalog = ARTIFACT_TYPES.map(
  (type) => `${type} — ${ARTIFACT_BLUEPRINTS[type].propsHint}`,
).join('; ');

/**
 * The closest spot that clears every neighbour, along whichever axis moves the
 * block least.
 *
 * A refusal that only says "no" makes the agent guess, and guessing costs a
 * whole iteration each time: asked to pack blocks into a tight row it was
 * refused three times running and spent a third of the run's tokens on that one
 * board. Naming the nearest free position turns three round trips into one.
 */
const nearestFree = (rect: Rect, hits: Artifact[]): { x: number; y: number } => {
  const gap = 24;
  let { x, y } = rect;
  // Nudge out of each obstacle in turn, the short way; later obstacles may
  // reintroduce an overlap, so the sweep repeats until it settles.
  for (let pass = 0; pass < hits.length + 1; pass++) {
    let moved = false;
    for (const hit of hits) {
      const clash =
        x < hit.x + hit.width && hit.x < x + rect.width &&
        y < hit.y + hit.height && hit.y < y + rect.height;
      if (!clash) continue;
      const right = hit.x + hit.width + gap - x;
      const left = x - (hit.x - rect.width - gap);
      const down = hit.y + hit.height + gap - y;
      const up = y - (hit.y - rect.height - gap);
      const best = Math.min(right, left, down, up);
      if (best === right) x = hit.x + hit.width + gap;
      else if (best === left) x = hit.x - rect.width - gap;
      else if (best === down) y = hit.y + hit.height + gap;
      else y = hit.y - rect.height - gap;
      moved = true;
    }
    if (!moved) break;
  }
  return { x: Math.round(x), y: Math.round(y) };
};

const overlapRefuse = (hits: Artifact[], acceptOverlap: boolean, rect?: Rect) => {
  if (hits.length === 0 || acceptOverlap) return null;
  const free = rect ? nearestFree(rect, hits) : null;
  const names = hits
    .map((item) => {
      const caption = artifactCaption(item);
      return caption ? `${item.id} («${caption}»)` : item.id;
    })
    .join(', ');
  return {
    refused: true,
    needsConfirmation: true,
    reason:
      `Блок наложится на ${names}. Если так и задумано — вызови тул снова с acceptOverlap=true ` +
      `(наложение останется на твоей ответственности).` +
      (free ? ` Ближайшее свободное место: x=${free.x}, y=${free.y}.` : ' Иначе выбери другие x, y.'),
    freeSpot: free,
    overlapping: hits.map((item) => ({
      id: item.id,
      caption: artifactCaption(item),
      x: item.x,
      y: item.y,
    })),
  };
};

const proposedRect = (base: Rect, patch: Partial<Rect>): Rect => ({
  x: patch.x ?? base.x,
  y: patch.y ?? base.y,
  width: patch.width ?? base.width,
  height: patch.height ?? base.height,
});

export const artifactCreate: ToolSpec = {
  name: 'artifact_create',
  description: `Создаёт артефакты на доске. Один блок — type/x/y, несколько сразу — items (так дешевле: схема из десяти блоков это один вызов, а не десять). Доступные типы и их props: ${typeCatalog}. Если размеры не заданы, берутся значения по умолчанию для типа. Блок, который наложился бы на уже стоящий, не создаётся, и тул называет ближайшее свободное место; остальные из items создаются всё равно. Наложение делается через acceptOverlap=true.`,
  parameters: objectSchema(
    {
      type: enumOf(ARTIFACT_TYPES, 'Тип артефакта (для одного блока)'),
      x: num('Координата левого края'),
      y: num('Координата верхнего края'),
      width: num('Ширина, необязательно'),
      height: num('Высота, необязательно'),
      props: {
        type: 'object',
        description: 'Содержимое артефакта, набор полей зависит от типа',
        additionalProperties: true,
      },
      items: {
        type: 'array',
        description: 'Несколько блоков за один вызов',
        items: objectSchema(
          {
            type: enumOf(ARTIFACT_TYPES, 'Тип'),
            x: num('x'),
            y: num('y'),
            width: num('Ширина'),
            height: num('Высота'),
            props: {
              type: 'object',
              description: 'Содержимое',
              additionalProperties: true,
            },
          },
          ['type', 'x', 'y'],
        ),
      },
      acceptOverlap: bool(
        'true — создавать даже при наложении на другой блок, на свою ответственность. Без флага наложившийся блок пропускается.',
      ),
    },
    [],
  ),
  run: (args, ctx) => {
    // One call, many blocks.
    //
    // A block is cheap to create and expensive to ask for: every call is a whole
    // model iteration with the system prompt, the tool schemas and the growing
    // history behind it. A schema of ten nodes used to cost ten of those.
    const list = Array.isArray(args.items)
      ? (args.items as Array<Record<string, unknown>>)
      : args.type != null
        ? [args]
        : [];
    if (list.length === 0) {
      return {
        data: { created: false, refused: true, reason: 'Нужен либо type с x,y, либо непустой items.' },
        mutated: false,
      };
    }

    const accept = args.acceptOverlap === true;
    const made: unknown[] = [];
    const blocked: Array<Record<string, unknown>> = [];

    for (const spec of list) {
      const type = spec.type as ArtifactType;
      const blueprint = ARTIFACT_BLUEPRINTS[type];
      if (!blueprint) {
        blocked.push({ refused: true, reason: `Неизвестный тип ${String(type)}.` });
        continue;
      }
      const rect: Rect = {
        x: spec.x as number,
        y: spec.y as number,
        width: (spec.width as number | undefined) ?? blueprint.width,
        height: (spec.height as number | undefined) ?? blueprint.height,
      };
      const refused = ctx.boards.read(ctx.boardId, (state) =>
        overlapRefuse(overlappingNeighbors(rect, state.artifacts), accept, rect),
      );
      if (refused) {
        // The rest are still created: one clash used to cost another round trip
        // for every block that was fine.
        blocked.push(refused as unknown as Record<string, unknown>);
        continue;
      }
      made.push(
        ctx.boards.mutate(ctx.boardId, (state) =>
          createArtifact(state, {
            type,
            x: rect.x,
            y: rect.y,
            width: spec.width as number | undefined,
            height: spec.height as number | undefined,
            props: (spec.props as Record<string, unknown>) ?? {},
            // Confirming an overlap records it as deliberate, so the quality
            // metric stops calling it a defect on every later check.
            allowOverlap: accept,
          }),
        ),
      );
    }

    if (made.length === 0) {
      return { data: { created: false, ...(blocked[0] ?? {}), blocked }, mutated: false };
    }
    if (list.length === 1 && blocked.length === 0) return { data: made[0], mutated: true };
    return {
      data: { created: made.length, artifacts: made, ...(blocked.length ? { blocked } : {}) },
      mutated: true,
    };
  },
};

export const artifactUpdate: ToolSpec = {
  name: 'artifact_update',
  description:
    'Меняет содержимое и/или геометрию существующего артефакта. props по умолчанию объединяются с текущими; передай replaceProps=true, чтобы заменить их целиком. Сдвиг или ресайз с наложением на другой блок отменяется, пока не передашь acceptOverlap=true.',
  parameters: objectSchema(
    {
      id: str('Идентификатор артефакта'),
      x: num('Новая координата X'),
      y: num('Новая координата Y'),
      width: num('Новая ширина'),
      height: num('Новая высота'),
      props: { type: 'object', description: 'Изменяемые поля содержимого', additionalProperties: true },
      replaceProps: bool('Заменить props целиком вместо слияния'),
      acceptOverlap: bool('true — сохранить даже при наложении на другой блок, на свою ответственность'),
    },
    ['id'],
  ),
  run: (args, ctx) => {
    const geometryTouched =
      typeof args.x === 'number' ||
      typeof args.y === 'number' ||
      typeof args.width === 'number' ||
      typeof args.height === 'number';
    if (geometryTouched) {
      const refused = ctx.boards.read(ctx.boardId, (state) => {
        const current = state.artifacts.find((item) => item.id === args.id);
        if (!current) return null;
        const rect = proposedRect(current, {
          x: args.x as number | undefined,
          y: args.y as number | undefined,
          width: args.width as number | undefined,
          height: args.height as number | undefined,
        });
        return overlapRefuse(
          overlappingNeighbors(rect, state.artifacts, current.id),
          args.acceptOverlap === true,
          rect,
        );
      });
      if (refused) return { data: { updated: false, ...refused }, mutated: false };
    }

    const { artifact, arrowsReset } = ctx.boards.mutate(ctx.boardId, (state) =>
      updateArtifact(state, args.id as string, {
        x: args.x as number | undefined,
        y: args.y as number | undefined,
        width: args.width as number | undefined,
        height: args.height as number | undefined,
        props: args.props as Record<string, unknown> | undefined,
        replaceProps: args.replaceProps === true,
      }),
    );
    return { data: { ...artifact, ...routeNotice(arrowsReset) }, mutated: true };
  },
};

/** Tells the agent that a move invalidated auto-routed polylines. */
const routeNotice = (arrowsReset: number) =>
  arrowsReset === 0
    ? {}
    : {
        arrowsReset,
        note: `Изгибы ${arrowsReset} автоматически проложенных стрелок сброшены: они были рассчитаны для прежнего положения. Не вызывай роутер после каждого сдвига — закончи расстановку узлов и сторон, затем один раз board_route_arrows.`,
      };

export const artifactMove: ToolSpec = {
  name: 'artifact_move',
  description:
    'Перемещает артефакты. Один блок — id/x/y, несколько сразу — moves (так дешевле: ряд из восьми блоков это один вызов, а не восемь). Если место накрывает другой блок, тул его не двигает и называет ближайшую свободную точку; наложение делается через acceptOverlap=true. Остальные блоки из moves при этом всё равно переезжают.',
  parameters: objectSchema(
    {
      id: str('Идентификатор артефакта (для одного блока)'),
      x: num('Новая координата левого края'),
      y: num('Новая координата верхнего края'),
      moves: {
        type: 'array',
        description: 'Несколько перемещений за раз',
        items: objectSchema({ id: str('id'), x: num('x'), y: num('y') }, ['id', 'x', 'y']),
      },
      acceptOverlap: bool('true — двигать даже при наложении, на свою ответственность'),
    },
    [],
  ),
  run: (args, ctx) => {
    // One call, many moves.
    //
    // Building a row meant ten `artifact_move` calls, and every call is a whole
    // model iteration with the system prompt, the tool schemas and the growing
    // history resent behind it. The moves themselves are trivial; what they
    // cost is the round trips.
    const list = Array.isArray(args.moves)
      ? (args.moves as Array<{ id: string; x: number; y: number }>)
      : args.id != null
        ? [{ id: args.id as string, x: args.x as number, y: args.y as number }]
        : [];
    if (list.length === 0) {
      return {
        data: { moved: false, refused: true, reason: 'Нужен либо id с x,y, либо непустой moves.' },
        mutated: false,
      };
    }

    const accept = args.acceptOverlap === true;
    const moved: Array<{ id: string; x: number; y: number }> = [];
    const blocked: Array<Record<string, unknown>> = [];
    let arrowsReset = 0;

    for (const step of list) {
      const refused = ctx.boards.read(ctx.boardId, (state) => {
        const current = state.artifacts.find((item) => item.id === step.id);
        // An id that does not exist stays an error, as it has always been —
        // the model should hear that it named something wrong, not that the
        // block would not fit. In a batch it is recorded and the rest proceed.
        if (!current) return null;
        const rect = proposedRect(current, { x: step.x, y: step.y });
        return overlapRefuse(overlappingNeighbors(rect, state.artifacts, current.id), accept, rect);
      });
      if (refused) {
        // The rest still move: a single clash used to cost another round trip
        // for every block that was fine.
        blocked.push({ id: step.id, ...refused });
        continue;
      }
      const apply = () =>
        ctx.boards.mutate(ctx.boardId, (state) =>
          updateArtifact(state, step.id, {
            x: step.x,
            y: step.y,
            allowOverlap: accept ? true : undefined,
          }),
        );
      let result: ReturnType<typeof apply>;
      if (list.length === 1) {
        result = apply();
      } else {
        try {
          result = apply();
        } catch (error) {
          blocked.push({ id: step.id, refused: true, reason: String((error as Error).message) });
          continue;
        }
      }
      arrowsReset += result.arrowsReset;
      moved.push({ id: result.artifact.id, x: result.artifact.x, y: result.artifact.y });
    }

    if (moved.length === 0) {
      return { data: { moved: false, ...(blocked[0] ?? {}), blocked }, mutated: false };
    }
    return {
      data: {
        moved: moved.length,
        artifacts: moved,
        ...(blocked.length ? { blocked } : {}),
        ...routeNotice(arrowsReset),
      },
      mutated: true,
    };
  },
};

export const artifactDelete: ToolSpec = {
  name: 'artifact_delete',
  description: 'Удаляет артефакт вместе со всеми присоединёнными к нему стрелками.',
  parameters: objectSchema({ id: str('Идентификатор артефакта') }, ['id']),
  run: (args, ctx) => {
    const result = ctx.boards.mutate(ctx.boardId, (state) =>
      deleteArtifact(state, args.id as string),
    );
    return { data: { deleted: args.id, ...result }, mutated: true };
  },
};

export const artifactRankPlacements: ToolSpec = {
  name: 'artifact_rank_placements',
  description:
    'Не двигает блок: принимает несколько вариантов его координат и говорит, при каком стрелки лягут удачнее (меньше наложений, резки блоков, крюков). Доска не меняется. После выбора вызови artifact_move. Не больше 8 вариантов за раз.',
  parameters: objectSchema(
    {
      id: str('Идентификатор артефакта, который хочешь переставить'),
      placements: {
        type: 'array',
        description: 'Варианты положения. У каждого x, y; width/height и label по желанию.',
        items: {
          type: 'object',
          properties: {
            x: num('Левый край'),
            y: num('Верхний край'),
            width: num('Ширина, если меняется'),
            height: num('Высота, если меняется'),
            label: str('Как назвать вариант в ответе'),
          },
          required: ['x', 'y'],
          additionalProperties: false,
        },
      },
    },
    ['id', 'placements'],
  ),
  run: (args, ctx) => {
    const id = args.id as string;
    const raw = Array.isArray(args.placements) ? args.placements : [];
    const placements = raw
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const row = item as Record<string, unknown>;
        if (typeof row.x !== 'number' || typeof row.y !== 'number') return null;
        return {
          x: row.x,
          y: row.y,
          width: typeof row.width === 'number' ? row.width : undefined,
          height: typeof row.height === 'number' ? row.height : undefined,
          label: typeof row.label === 'string' ? row.label : undefined,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item != null);

    if (placements.length === 0) {
      return {
        data: {
          refused: true,
          reason: 'Передай хотя бы один вариант с x и y.',
        },
      };
    }

    const result = ctx.boards.read(ctx.boardId, (state) => {
      if (!state.artifacts.some((item) => item.id === id)) {
        return { missing: true as const };
      }
      return rankArtifactPlacements(state.artifacts, state.arrows, id, placements);
    });

    if ('missing' in result) {
      return { data: { refused: true, reason: `Артефакт ${id} не найден.` } };
    }

    const best = result.ranked[0];
    const verdict = best
      ? `Лучше для стрелок: «${best.label}» (x=${best.x}, y=${best.y}). ${best.verdict} Доска не менялась — сдвинь блок через artifact_move, если согласен.`
      : 'Нечего сравнивать.';

    return {
      data: {
        id,
        ranked: result.ranked,
        bestIndex: result.bestIndex,
        best: best
          ? { index: best.index, label: best.label, x: best.x, y: best.y, reason: best.verdict }
          : null,
        truncated: result.truncated,
        verdict,
      },
      mutated: false,
    };
  },
};

export const artifactTools: ToolSpec[] = [
  artifactCreate,
  artifactUpdate,
  artifactMove,
  artifactRankPlacements,
  artifactDelete,
];
