import {
  ARTIFACT_KINDS,
  ArtifactSpecSchema,
  CameraSchema,
  DEFAULT_ARTIFACT_SIZE,
  ShapeKindSchema,
  createArtifactNode,
  createEdge,
  createShapeNode,
  createStickyNode,
  createTextNode,
  isAgentFrame,
  isArtifactNode,
  nearestSides,
  nodesInRect,
  outlineNode,
  parseEdgeSide,
  rectOf,
  renderPeripheralIndex,
  summarizeArtifact,
  type ArtifactKind,
  type BoardNode,
  type EdgeSide,
  type FrameNode,
  type ShapeKind
} from '@zmtki/board-schema';
import {
  collisionCandidates,
  edgeEndpoints,
  findEdgeCrossings,
  findOverlaps,
  formatSpatialWarning,
  lineHitsNodes
} from '../board/SpatialGuards.js';
import {
  bool,
  defineTool,
  num,
  objectSchema,
  str,
  type ToolContext,
  type ToolResult
} from './registry.js';

const MARK_KINDS = ['shape', 'text', 'sticky', 'sticker'] as const;
const SHAPE_KINDS = ShapeKindSchema.options;

function agentFrameOf(ctx: ToolContext): FrameNode | undefined {
  return ctx.board.nodes.find((n): n is FrameNode => isAgentFrame(n) && n.agentId === ctx.agent.id);
}

function requireArtifactNode(ctx: ToolContext, nodeId: string): BoardNode {
  const node = ctx.board.getNode(nodeId);
  if (!node) throw new Error(`узел не найден: ${nodeId}`);
  return node;
}

/** Smoothly keep the agent's frame wrapped around the nodes it is working on. */
function ensureFrameCovers(ctx: ToolContext, nodeIds: readonly string[]): void {
  const frame = agentFrameOf(ctx);
  if (!frame || !frame.autoGrow) return;
  const nodes = nodeIds
    .map((id) => ctx.board.getNode(id))
    .filter((n): n is BoardNode => Boolean(n) && n!.type !== 'frame');
  if (nodes.length === 0) return;
  const pad = 56;
  const minX = Math.min(...nodes.map((n) => n.position.x)) - pad;
  const minY = Math.min(...nodes.map((n) => n.position.y)) - pad - 28;
  const maxX = Math.max(...nodes.map((n) => n.position.x + n.size.w)) + pad;
  const maxY = Math.max(...nodes.map((n) => n.position.y + n.size.h)) + pad;
  const next = {
    position: { x: minX, y: minY },
    size: { w: Math.max(320, maxX - minX), h: Math.max(240, maxY - minY) }
  };
  const samePos =
    Math.abs(frame.position.x - next.position.x) < 1 &&
    Math.abs(frame.position.y - next.position.y) < 1;
  const sameSize =
    Math.abs(frame.size.w - next.size.w) < 1 && Math.abs(frame.size.h - next.size.h) < 1;
  if (samePos && sameSize) return;
  ctx.board.apply({
    origin: ctx.agent.id,
    ops: [
      { op: 'moveNodes', moves: [{ id: frame.id, position: next.position }] },
      { op: 'resizeNode', id: frame.id, size: next.size }
    ]
  });
}

/**
 * Spatial conflicts are decided by the agent in the next tool call — not by a
 * human approval card. Return a blocking tool error unless acceptSpatialRisk.
 */
function spatialRiskForAgent(
  detail: string,
  accept: boolean,
  howToFix: string
): ToolResult | null {
  if (accept) return null;
  return {
    content: [
      'Геометрический конфликт — действие не выполнено.',
      detail,
      '',
      'Реши сам:',
      `1) Исправь геометрию: ${howToFix}`,
      '2) Или повтори тот же вызов с acceptSpatialRisk=true, если осознанно оставляешь как есть.'
    ].join('\n'),
    isError: true
  };
}

const ARTIFACT_ENVELOPE_KEYS = new Set(['kind', 'title', 'tone', 'props']);

/**
 * Accepts artifact fields either nested under `props` or spread at the top
 * level.
 *
 * Models flatten nested argument objects often enough that treating the flat
 * form as an error would mean a silently empty artifact on the board and a
 * wasted round. Both shapes describe the same thing unambiguously, because the
 * envelope keys are fixed.
 */
function collectProps(
  args: Record<string, unknown>,
  extraEnvelopeKeys: readonly string[] = []
): Record<string, unknown> {
  const nested = (args.props as Record<string, unknown> | undefined) ?? {};
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (ARTIFACT_ENVELOPE_KEYS.has(key) || extraEnvelopeKeys.includes(key)) continue;
    flat[key] = value;
  }
  // Nested wins: if a model sent both, the explicit container is the intent.
  return { ...flat, ...nested };
}

defineTool({
  name: 'board_create_artifact',
  toolset: 'board',
  readOnly: false,
  description: [
    'Создать артефакт в своей рамке. Следуй артефактному этикету из системного промпта.',
    'Сначала ищи существующий узел (board_search) — update предпочтительнее create; не дублируй то, что уже на доске.',
    'Дроби работу по kind: код — diff/fileFragment/codePad, задачи — todo/kanban, данные — table/chart, схемы — mermaid, медиа — map/music/video, UI — htmlWidget/appView/demo, текст — note/blocks/markdown.',
    'Не дублируй terminal/diff — их создают shell и write_file/apply_patch.',
    'props по kind: markdown {text}; note {text}; blocks {blocks:[{id,type,text,level?,checked?,language?}]};',
    'codePad {language,content}; map {lat,lng,zoom,label}; music {url,track,artist,coverUrl}; video {url,poster};',
    'status {headline,detail,progress,fields}; table {columns,rows}; kanban {columns}; todo {items}; mermaid {source};',
    'chart {chartType,labels,series}; link {url,description}; htmlWidget {html};',
    'controls {heading,items:[{id,type,label,action,...}]};',
    'fileFragment {path,startLine,endLine,content}; demo {url,command};',
    'appView {mode:web|headless|mirror, url?, sourceId?, sourceName?, fps?, live?} — лучше через board_app_embed.',
    'Для размещения относительно других узлов используй board_place вместо пикселей.'
  ].join(' '),
  parameters: objectSchema(
    {
      kind: str('Вид артефакта', { enum: [...ARTIFACT_KINDS] }),
      title: str('Заголовок артефакта'),
      props: {
        type: 'object',
        description: 'Поля артефакта, зависят от kind',
        additionalProperties: true
      },
      tone: str('Цвет статуса', {
        enum: ['idle', 'running', 'blocked', 'success', 'warning', 'error']
      })
    },
    ['kind', 'title']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const kind = String(args.kind) as ArtifactKind;
    if (!ARTIFACT_KINDS.includes(kind)) {
      return { content: `неизвестный вид артефакта: ${kind}`, isError: true };
    }

    const parsed = ArtifactSpecSchema.safeParse({
      ...collectProps(args),
      kind,
      title: String(args.title ?? ''),
      tone: args.tone ?? 'idle'
    });
    if (!parsed.success) {
      return {
        content: `props не подходят для kind=${kind}: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
        isError: true
      };
    }

    const size = DEFAULT_ARTIFACT_SIZE[kind];
    const position = ctx.board.placeForAgent(ctx.agent.id, size);
    const node = createArtifactNode({
      artifact: parsed.data,
      position,
      size,
      createdBy: ctx.agent.id
    });
    ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });
    ensureFrameCovers(ctx, [node.id]);

    return {
      content: `Создан артефакт ${node.id} (${kind}) в позиции ${Math.round(position.x)},${Math.round(position.y)}.`,
      nodeId: node.id
    };
  }
});

defineTool({
  name: 'board_create_mark',
  toolset: 'board',
  readOnly: false,
  description: [
    'Создать на доске визуальный элемент: фигуру, текст, sticky-заметку или стикер из пака.',
    'Это тоже часть отчёта на доске — используй для подписей, акцентов, схем и пояснений рядом с артефактами.',
    'kind=shape: нужен shape (rectangle|ellipse|triangle|diamond|star|arrowBlock), опционально text на фигуре.',
    'kind=text|sticky: нужен text.',
    'kind=sticker: packId + stickerId (сначала stickers_list); стартовый пак basics.',
    'Размещение: по умолчанию в своей рамке; можно relativeTo + relation (rightOf/leftOf/below/above/inside).'
  ].join(' '),
  parameters: objectSchema(
    {
      kind: str('Тип элемента', { enum: [...MARK_KINDS] }),
      text: str('Текст для text/sticky или подпись на shape'),
      shape: str('Форма при kind=shape', { enum: [...SHAPE_KINDS] }),
      packId: str('Пак стикера при kind=sticker'),
      stickerId: str('Id стикера при kind=sticker'),
      relativeTo: str('Опорный узел для размещения'),
      relation: str('Отношение к опорному узлу', {
        enum: ['rightOf', 'leftOf', 'below', 'above', 'inside']
      }),
      w: num('Ширина (опционально)'),
      h: num('Высота (опционально)')
    },
    ['kind']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const kind = String(args.kind);
    if (!(MARK_KINDS as readonly string[]).includes(kind)) {
      return { content: `неизвестный kind: ${kind}`, isError: true };
    }

    const { relativePosition } = await import('../board/SpatialLayoutEngine.js');
    const frame = agentFrameOf(ctx);
    const text = String(args.text ?? '').trim();

    let size = { w: 160, h: 100 };
    if (kind === 'text') size = { w: 240, h: 48 };
    if (kind === 'sticky') size = { w: 180, h: 140 };
    if (kind === 'sticker') size = { w: 128, h: 128 };
    if (typeof args.w === 'number') size.w = Math.max(24, args.w);
    if (typeof args.h === 'number') size.h = Math.max(24, args.h);

    let position = ctx.board.placeForAgent(ctx.agent.id, size);
    let parentId: string | null = frame?.id ?? null;

    if (args.relativeTo && args.relation) {
      const relation = String(args.relation) as
        | 'rightOf'
        | 'leftOf'
        | 'below'
        | 'above'
        | 'inside';
      const anchor = ctx.board.getNode(String(args.relativeTo));
      if (!anchor) return { content: `опорный узел ${args.relativeTo} не найден`, isError: true };
      if (relation === 'inside') {
        if (anchor.type !== 'frame' && anchor.type !== 'group') {
          return { content: 'inside требует frame или group', isError: true };
        }
        parentId = anchor.id;
        position = ctx.board.placeForAgent(ctx.agent.id, size);
        if (parentId === frame?.id) {
          // keep placeForAgent; otherwise nudge inside container
        } else {
          position = {
            x: anchor.position.x + 24,
            y: anchor.position.y + 48
          };
        }
      } else {
        position = relativePosition(anchor, relation, size);
        parentId = anchor.parentId ?? frame?.id ?? null;
      }
    }

    if (kind === 'sticker') {
      const packId = String(args.packId ?? '');
      const stickerId = String(args.stickerId ?? '');
      if (!packId || !stickerId) {
        return { content: 'для sticker нужны packId и stickerId (см. stickers_list)', isError: true };
      }
      const placed = await ctx.services.stickers?.place({
        boardId: ctx.board.id,
        packId,
        stickerId,
        agentId: ctx.agent.id,
        position,
        // Placement already resolved above; only pass inside-parent when needed.
        relativeTo: args.relation === 'inside' && args.relativeTo ? String(args.relativeTo) : undefined,
        relation: args.relation === 'inside' ? 'inside' : undefined
      });
      if (!placed?.ok) return { content: placed?.error ?? 'стикер не размещён', isError: true };
      return { content: `Стикер ${packId}/${stickerId} → ${placed.nodeId}`, nodeId: placed.nodeId };
    }

    if (kind === 'shape') {
      const shapeRaw = String(args.shape ?? 'rectangle');
      const parsedShape = ShapeKindSchema.safeParse(shapeRaw);
      if (!parsedShape.success) {
        return {
          content: `shape должен быть одним из: ${SHAPE_KINDS.join(', ')}`,
          isError: true
        };
      }
      const node = createShapeNode({
        shape: parsedShape.data as ShapeKind,
        text,
        position,
        size,
        createdBy: ctx.agent.id,
        parentId
      });
      ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });
      return { content: `Фигура ${node.shape} → ${node.id}`, nodeId: node.id };
    }

    if (kind === 'text') {
      if (!text) return { content: 'для text нужен text', isError: true };
      const node = createTextNode({
        text,
        position,
        size,
        createdBy: ctx.agent.id,
        parentId
      });
      ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });
      return { content: `Текст → ${node.id}`, nodeId: node.id };
    }

    // sticky
    if (!text) return { content: 'для sticky нужен text', isError: true };
    const node = createStickyNode({
      text,
      position,
      size,
      createdBy: ctx.agent.id,
      parentId
    });
    ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });
    return { content: `Sticky → ${node.id}`, nodeId: node.id };
  }
});

defineTool({
  name: 'board_update_artifact',
  toolset: 'board',
  readOnly: false,
  description:
    'Обновить существующий артефакт (предпочтительнее create). Передай только меняющиеся поля — так держат status/kanban/todo без копий.',
  parameters: objectSchema(
    {
      nodeId: str('Id артефакта'),
      props: { type: 'object', description: 'Меняющиеся поля артефакта', additionalProperties: true },
      title: str('Новый заголовок'),
      tone: str('Цвет статуса', {
        enum: ['idle', 'running', 'blocked', 'success', 'warning', 'error']
      })
    },
    ['nodeId']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const nodeId = String(args.nodeId);
    const node = requireArtifactNode(ctx, nodeId);
    if (node.type !== 'artifact') return { content: `${nodeId} не артефакт`, isError: true };

    const patch: Record<string, unknown> = collectProps(args, ['nodeId']);
    if (args.title !== undefined) patch.title = String(args.title);
    if (args.tone !== undefined) patch.tone = args.tone;

    const merged = ArtifactSpecSchema.safeParse({ ...node.artifact, ...patch });
    if (!merged.success) {
      return {
        content: `обновление невалидно: ${merged.error.issues.map((i) => i.message).join('; ')}`,
        isError: true
      };
    }

    await ctx.board.snapshotRevision(nodeId);
    ctx.board.apply({
      origin: ctx.agent.id,
      ops: [{ op: 'updateNode', id: nodeId, patch: { artifact: patch } }]
    });
    ensureFrameCovers(ctx, [nodeId]);
    return { content: `Артефакт ${nodeId} обновлён.`, nodeId };
  }
});

defineTool({
  name: 'board_read',
  toolset: 'board',
  readOnly: true,
  description:
    'Прочитать доску. scope=frame — полное содержимое своей рамки; scope=outside — компактный индекс всего вне рамки; scope=node — один артефакт целиком.',
  parameters: objectSchema(
    {
      scope: str('Что читать', { enum: ['frame', 'outside', 'node', 'all'] }),
      nodeId: str('Id узла для scope=node')
    },
    ['scope']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const doc = ctx.board.toDoc();
    const scope = String(args.scope);

    if (scope === 'node') {
      const nodeId = String(args.nodeId ?? '');
      const node = ctx.board.getNode(nodeId);
      if (!node) return { content: `узел не найден: ${nodeId}`, isError: true };
      ensureFrameCovers(ctx, [nodeId]);
      if (node.type !== 'artifact') {
        return { content: JSON.stringify(outlineNode(node), null, 2), nodeId };
      }
      return { content: JSON.stringify(node.artifact, null, 2), nodeId };
    }

    const frame = agentFrameOf(ctx);
    if (scope === 'frame') {
      if (!frame) return { content: 'у тебя пока нет рамки на доске.' };
      const inside = nodesInRect(doc, rectOf(frame));
      return { content: `Внутри рамки (${inside.length}):\n${renderPeripheralIndex(inside)}` };
    }

    if (scope === 'outside') {
      const frameRect = frame ? rectOf(frame) : null;
      const insideIds = new Set(frameRect ? nodesInRect(doc, frameRect).map((n) => n.id) : []);
      const outside = doc.nodes.filter((n) => !insideIds.has(n.id) && n.id !== frame?.id);
      return { content: `Вне рамки (${outside.length}):\n${renderPeripheralIndex(outside)}` };
    }

    return { content: renderPeripheralIndex(doc.nodes) };
  }
});

defineTool({
  name: 'board_screenshot',
  toolset: 'board',
  readOnly: true,
  description: [
    'Сделать скриншот видимой области доски и вернуть картинку в контекст (vision).',
    'Используй, чтобы проверить раскладку, зазоры между блоками и читаемость стрелок.',
    'После скрина при необходимости поправь через board_arrange / board_place / board_connect.'
  ].join(' '),
  parameters: objectSchema({
    scope: str('Что снимать', { enum: ['viewport', 'window'] }),
    reason: str('Зачем смотришь снимок (кратко)')
  }),
  async handler(args, ctx): Promise<ToolResult> {
    const capture = ctx.services.desktop?.captureBoard;
    if (!capture) {
      return {
        content: 'Скриншот доски недоступен в этом окружении (нет desktop capture).',
        isError: true
      };
    }
    const scope = args.scope === 'window' ? 'window' : 'viewport';
    const shot = await capture({ scope });
    if (!shot) {
      return { content: 'Не удалось снять доску (окно не готово).', isError: true };
    }
    const reason = args.reason ? String(args.reason) : 'проверка раскладки';
    const size =
      shot.width && shot.height ? `${shot.width}×${shot.height}` : `${Math.round(shot.base64.length / 1024)}KB`;
    return {
      content: `Скриншот доски (${scope}, ${size}). Причина: ${reason}. Картинка приложена следующим сообщением — оцени визуал.`,
      images: [{ mime: shot.mime, base64: shot.base64 }]
    };
  }
});

defineTool({
  name: 'board_move_frame',
  toolset: 'board',
  readOnly: false,
  description:
    'Переместить или изменить размер своей рамки. Всё, что окажется внутри, попадёт к тебе в контекст на следующем ходу — так ты переезжаешь к нужной части доски.',
  parameters: objectSchema({
    x: num('Новая координата X левого верхнего угла'),
    y: num('Новая координата Y левого верхнего угла'),
    w: num('Новая ширина'),
    h: num('Новая высота'),
    aroundNodeIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Вместо координат: охватить рамкой эти узлы'
    }
  }),
  async handler(args, ctx): Promise<ToolResult> {
    const frame = agentFrameOf(ctx);
    if (!frame) return { content: 'у тебя нет рамки на доске', isError: true };

    const around = args.aroundNodeIds as string[] | undefined;
    if (around?.length) {
      const nodes = around
        .map((id) => ctx.board.getNode(id))
        .filter((n): n is BoardNode => n !== undefined);
      if (nodes.length === 0) return { content: 'узлы не найдены', isError: true };
      const pad = 48;
      const minX = Math.min(...nodes.map((n) => n.position.x)) - pad;
      const minY = Math.min(...nodes.map((n) => n.position.y)) - pad - 24;
      const maxX = Math.max(...nodes.map((n) => n.position.x + n.size.w)) + pad;
      const maxY = Math.max(...nodes.map((n) => n.position.y + n.size.h)) + pad;
      ctx.board.apply({
        origin: ctx.agent.id,
        ops: [
          { op: 'moveNodes', moves: [{ id: frame.id, position: { x: minX, y: minY } }] },
          { op: 'resizeNode', id: frame.id, size: { w: maxX - minX, h: maxY - minY } }
        ]
      });
      return { content: `Рамка охватила ${nodes.length} узлов.`, nodeId: frame.id };
    }

    const position = {
      x: typeof args.x === 'number' ? args.x : frame.position.x,
      y: typeof args.y === 'number' ? args.y : frame.position.y
    };
    const size = {
      w: typeof args.w === 'number' ? Math.max(240, args.w) : frame.size.w,
      h: typeof args.h === 'number' ? Math.max(180, args.h) : frame.size.h
    };
    ctx.board.apply({
      origin: ctx.agent.id,
      ops: [
        { op: 'moveNodes', moves: [{ id: frame.id, position }] },
        { op: 'resizeNode', id: frame.id, size }
      ]
    });
    const doc = ctx.board.toDoc();
    const inside = nodesInRect(doc, { ...position, ...size });
    return {
      content: `Рамка перемещена. Теперь внутри ${inside.length} объектов:\n${renderPeripheralIndex(inside, 40)}`,
      nodeId: frame.id
    };
  }
});

defineTool({
  name: 'board_connect',
  toolset: 'board',
  readOnly: false,
  description: [
    'Соединить два узла стрелкой с подписью (причинно-следственные связи).',
    'fromSide/toSide: left|right|top|bottom — явная грань крепления; auto (по умолчанию) — ближайшие грани.',
    'После набора связей вызови board_arrange layout=graph (как Mermaid) — воздух под подписи стрелок.',
    'Не связывай «всех со всеми».',
    'Если стрелка пересекает блоки/другие связи — инструмент вернёт конфликт тебе (не человеку): исправь геометрию или повтори с acceptSpatialRisk=true.'
  ].join(' '),
  parameters: objectSchema(
    {
      fromNodeId: str('Id исходного узла'),
      toNodeId: str('Id целевого узла'),
      label: str('Подпись связи'),
      fromSide: str('Грань выхода', { enum: ['auto', 'left', 'right', 'top', 'bottom'] }),
      toSide: str('Грань входа', { enum: ['auto', 'left', 'right', 'top', 'bottom'] }),
      acceptSpatialRisk: bool(
        'true = осознанно создать связь несмотря на пересечение блоков/стрелок (после предупреждения инструмента)'
      )
    },
    ['fromNodeId', 'toNodeId']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const from = String(args.fromNodeId);
    const to = String(args.toNodeId);
    const fromNode = ctx.board.getNode(from);
    const toNode = ctx.board.getNode(to);
    if (!fromNode) return { content: `узел не найден: ${from}`, isError: true };
    if (!toNode) return { content: `узел не найден: ${to}`, isError: true };

    const parsedFrom = parseEdgeSide(args.fromSide);
    const parsedTo = parseEdgeSide(args.toSide);
    if (parsedFrom === null) {
      return { content: 'fromSide: auto|left|right|top|bottom', isError: true };
    }
    if (parsedTo === null) {
      return { content: 'toSide: auto|left|right|top|bottom', isError: true };
    }

    let fromSide: EdgeSide | null = parsedFrom === 'auto' ? null : parsedFrom;
    let toSide: EdgeSide | null = parsedTo === 'auto' ? null : parsedTo;
    // If both auto — leave null (renderer picks nearest as nodes move).
    // If only one side given, snap the other to the nearest pair partner.
    if ((fromSide && !toSide) || (!fromSide && toSide)) {
      const nearest = nearestSides(fromNode, toNode);
      fromSide ??= nearest.from;
      toSide ??= nearest.to;
    }

    const ends = edgeEndpoints(fromNode, toNode, fromSide, toSide);
    fromSide = ends.fromSide;
    toSide = ends.toSide;
    const exclude = new Set([from, to]);
    const candidates = collisionCandidates(ctx.board.nodes, exclude);
    const lineHits = lineHitsNodes(ends.from, ends.to, candidates, exclude);
    const byId = new Map(ctx.board.nodes.map((n) => [n.id, n]));
    const crossings = findEdgeCrossings(ends.from, ends.to, ctx.board.edges, byId, exclude);
    if (lineHits.length > 0 || crossings.length > 0) {
      const detail = formatSpatialWarning({ lineHits, crossings });
      const blocked = spatialRiskForAgent(
        detail,
        args.acceptSpatialRisk === true,
        'board_place / board_arrange или другие fromSide/toSide'
      );
      if (blocked) return blocked;
    }

    const edge = createEdge(from, to, {
      label: String(args.label ?? ''),
      createdBy: ctx.agent.id,
      fromSide,
      toSide
    });
    ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addEdge', edge }] });
    const sideNote = ` (${fromSide} → ${toSide})`;
    return {
      content: `Связь ${from} -> ${to}${sideNote}. Для схемы со стрелками: board_arrange layout=graph (direction=tb|lr) — как Mermaid, с местом под подписи.`
    };
  }
});

defineTool({
  name: 'board_arrange',
  toolset: 'board',
  readOnly: false,
  description: [
    'Разложить узлы внутри своей рамки (или группы).',
    'Режимы: column, row, grid, stack, flow, graph.',
    'graph — как Mermaid: слои по связям, воздух под подписи. direction=tb (сверху вниз) или lr.',
    'flow — линейный DAG слева→направо. column/row/grid — упаковка без учёта стрелок.',
    'Отступы: gap, gapX, gapY. Для graph по умолчанию крупные (gapY≈140 при tb).'
  ].join(' '),
  parameters: objectSchema({
    layout: str('Режим раскладки', {
      enum: ['column', 'row', 'grid', 'stack', 'flow', 'graph']
    }),
    gap: num('Общий отступ между узлами'),
    gapX: num('Горизонтальный отступ (между соседями / колонками)'),
    gapY: num('Вертикальный отступ (между рядами / слоями)'),
    columns: num('Число колонок для grid'),
    direction: str('Для graph: tb или lr', { enum: ['tb', 'lr'] }),
    containerId: str('Id рамки или группы; по умолчанию твоя рамка')
  }),
  async handler(args, ctx): Promise<ToolResult> {
    const { layoutChildren } = await import('../board/SpatialLayoutEngine.js');
    const frame = agentFrameOf(ctx);
    const containerId = args.containerId ? String(args.containerId) : frame?.id;
    if (!containerId) return { content: 'у тебя нет рамки на доске', isError: true };
    const container = ctx.board.getNode(containerId);
    if (!container || (container.type !== 'frame' && container.type !== 'group')) {
      return { content: 'контейнер должен быть frame или group', isError: true };
    }

    const byParent = ctx.board.nodes.filter((n) => n.parentId === containerId);
    const doc = ctx.board.toDoc();
    // Prefer explicit children. Geometric fallback must NOT pull nodes that
    // already belong to another group/frame — that left orphan group fills
    // while members were packed into a line on the parent frame.
    const geometric =
      byParent.length > 0
        ? byParent
        : nodesInRect(doc, rectOf(container)).filter(
            (n) =>
              n.id !== containerId &&
              (n.parentId == null || n.parentId === containerId) &&
              n.type !== 'group' &&
              n.type !== 'frame'
          );
    const inside = geometric.filter((n) => !n.locked && n.visualState !== 'ghost');
    if (inside.length === 0) return { content: 'внутри контейнера нечего раскладывать' };

    const mode = String(args.layout ?? 'grid') as
      | 'column'
      | 'row'
      | 'grid'
      | 'stack'
      | 'flow'
      | 'graph';
    const gap =
      typeof args.gap === 'number'
        ? args.gap
        : mode === 'graph'
          ? 120
          : mode === 'flow'
            ? 80
            : 24;
    const gapX = typeof args.gapX === 'number' ? args.gapX : undefined;
    const gapY = typeof args.gapY === 'number' ? args.gapY : undefined;
    const direction = args.direction === 'lr' ? 'lr' : 'tb';
    const columns =
      typeof args.columns === 'number' ? args.columns : Math.ceil(Math.sqrt(inside.length));
    const insideIds = new Set(inside.map((n) => n.id));
    const edges = ctx.board.edges
      .filter(
        (e) =>
          e.from.nodeId &&
          e.to.nodeId &&
          insideIds.has(e.from.nodeId) &&
          insideIds.has(e.to.nodeId)
      )
      .map((e) => ({ from: e.from.nodeId as string, to: e.to.nodeId as string }));

    const { moves, containerSize, containerPosition } = layoutChildren(
      {
        id: container.id,
        position: container.position,
        size: container.size,
        layout: container.layout
      },
      inside,
      { mode, gap, gapX, gapY, columns, edges, direction }
    );

    const persistGap = gapY ?? gapX ?? gap;
    // graph/flow are arrange-only — keep free so later place-inside won't restack.
    const persistMode = mode === 'flow' || mode === 'graph' ? 'free' : mode;
    const ops = [
      ...inside
        .filter((n) => n.parentId !== containerId)
        .map((n) => ({
          op: 'updateNode' as const,
          id: n.id,
          patch: { parentId: containerId }
        })),
      {
        op: 'updateNode' as const,
        id: containerId,
        patch: { layout: { mode: persistMode, gap: persistGap } }
      },
      ...(moves.length ? [{ op: 'moveNodes' as const, moves }] : []),
      ...(containerPosition
        ? [{ op: 'moveNodes' as const, moves: [{ id: container.id, position: containerPosition }] }]
        : []),
      {
        op: 'resizeNode' as const,
        id: container.id,
        size: containerSize
      }
    ];
    ctx.board.apply({ origin: ctx.agent.id, ops });
    const gapNote = [
      `gap=${persistGap}`,
      gapX != null ? `gapX=${gapX}` : null,
      gapY != null ? `gapY=${gapY}` : null,
      mode === 'graph' ? `direction=${direction}` : null
    ]
      .filter(Boolean)
      .join(', ');
    return {
      content: `Разложено ${moves.length} узлов (${mode}, ${gapNote}).`,
      nodeId: container.id
    };
  }
});

defineTool({
  name: 'board_focus',
  toolset: 'board',
  readOnly: false,
  description:
    'Навести камеру пользователя на узел или свою рамку. Используй экономно — только когда хочешь показать что-то важное прямо сейчас.',
  parameters: objectSchema({
    nodeId: str('Id узла; если не задан, наводит на твою рамку')
  }),
  async handler(args, ctx): Promise<ToolResult> {
    const target = args.nodeId ? ctx.board.getNode(String(args.nodeId)) : agentFrameOf(ctx);
    if (!target) return { content: 'цель для фокуса не найдена', isError: true };
    const rect = rectOf(target);
    const zoom = Math.min(1.2, Math.max(0.3, 900 / Math.max(rect.w, rect.h, 1)));
    ctx.board.apply({
      origin: ctx.agent.id,
      ops: [
        {
          op: 'setCamera',
          camera: CameraSchema.parse({
            x: -(rect.x + rect.w / 2) * zoom + 600,
            y: -(rect.y + rect.h / 2) * zoom + 400,
            zoom
          })
        }
      ]
    });
    return { content: `Камера наведена на ${target.id}.`, nodeId: target.id };
  }
});

defineTool({
  name: 'board_delete',
  toolset: 'board',
  readOnly: false,
  description:
    'Удалить артефакт с доски. Предпочтительный способ убрать ненужное — не архивируй (ghost), если пользователь не просил сохранить в архиве. Чужие и locked-for-delete узлы недоступны без снятия защиты.',
  parameters: objectSchema({ nodeId: str('Id артефакта') }, ['nodeId']),
  async handler(args, ctx): Promise<ToolResult> {
    const { checkNodeAction } = await import('../board/OwnershipLocks.js');
    const nodeId = String(args.nodeId);
    const node = ctx.board.getNode(nodeId);
    if (!node) return { content: `узел не найден: ${nodeId}`, isError: true };
    const decision = checkNodeAction(node, ctx.agent.id, 'delete');
    if (!decision.ok) {
      if (decision.needsApproval) {
        const approved = await ctx.requestApproval({
          kind: 'write',
          title: `Удалить защищённый узел`,
          detail: decision.reason ?? nodeId,
          subject: nodeId
        });
        if (!approved) return { content: decision.reason ?? 'удаление отклонено', isError: true };
      } else {
        return { content: decision.reason ?? 'удаление запрещено', isError: true };
      }
    }
    ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'removeNode', id: nodeId }] });
    return { content: `Артефакт ${nodeId} удалён.` };
  }
});

defineTool({
  name: 'board_comment_reply',
  toolset: 'board',
  readOnly: false,
  description:
    'Ответить в треде комментария, который тебе адресовали. Отвечай на каждый адресованный комментарий, прежде чем завершить ход.',
  parameters: objectSchema(
    { threadId: str('Id треда'), body: str('Текст ответа') },
    ['threadId', 'body']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    await ctx.services.comments.reply(
      ctx.board.id,
      String(args.threadId),
      ctx.agent.id,
      String(args.body)
    );
    return { content: 'Ответ добавлен в тред.' };
  }
});

defineTool({
  name: 'board_search',
  toolset: 'board',
  readOnly: true,
  description: 'Найти артефакты на доске по тексту заголовка или содержимого.',
  parameters: objectSchema({ query: str('Поисковый запрос') }, ['query']),
  async handler(args, ctx): Promise<ToolResult> {
    const query = String(args.query).toLowerCase();
    const matches = ctx.board.nodes.filter((n) => {
      const outline = outlineNode(n);
      return (
        outline.title.toLowerCase().includes(query) ||
        outline.summary.toLowerCase().includes(query) ||
        (n.type === 'artifact' && summarizeArtifact(n.artifact).toLowerCase().includes(query))
      );
    });
    if (matches.length === 0) return { content: `ничего не найдено по запросу "${args.query}"` };
    return { content: `Найдено ${matches.length}:\n${renderPeripheralIndex(matches, 40)}` };
  }
});

defineTool({
  name: 'board_place',
  toolset: 'board',
  readOnly: false,
  description: [
    'Создать или переместить артефакт относительно другого узла / внутрь рамки или группы.',
    'relation: inside | rightOf | leftOf | below | above. Не задавай пиксели.',
    'gap — расстояние до опоры (для связанных узлов лучше ≥48).',
    'При перекрытии блоков инструмент вернёт конфликт тебе: смени place/gap или повтори с acceptSpatialRisk=true.'
  ].join(' '),
  parameters: objectSchema(
    {
      kind: str('Вид артефакта при создании', { enum: [...ARTIFACT_KINDS] }),
      title: str('Заголовок'),
      props: { type: 'object', additionalProperties: true },
      tone: str('Tone', { enum: ['idle', 'running', 'blocked', 'success', 'warning', 'error'] }),
      nodeId: str('Существующий узел для перемещения (вместо создания)'),
      relativeTo: str('Id опорного узла'),
      relation: str('Отношение', {
        enum: ['inside', 'rightOf', 'leftOf', 'below', 'above']
      }),
      gap: num('Отступ до опорного узла (px); по умолчанию 24, для схем ≥48'),
      containerId: str('Явный контейнер (frame/group) для inside'),
      slot: str('Имя слота layout'),
      acceptSpatialRisk: bool(
        'true = осознанно разместить поверх других блоков (после предупреждения инструмента)'
      )
    },
    ['relation']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const { relativePosition, wrapBounds } = await import('../board/SpatialLayoutEngine.js');
    const { createGroupNode } = await import('@zmtki/board-schema');
    void createGroupNode;
    const relation = String(args.relation) as
      | 'inside'
      | 'rightOf'
      | 'leftOf'
      | 'below'
      | 'above';
    const frame = agentFrameOf(ctx);
    let nodeId = args.nodeId ? String(args.nodeId) : null;

    if (!nodeId) {
      const kind = String(args.kind ?? '') as ArtifactKind;
      if (!ARTIFACT_KINDS.includes(kind)) {
        return { content: 'для создания укажи kind', isError: true };
      }
      const parsed = ArtifactSpecSchema.safeParse({
        ...collectProps(args, ['nodeId', 'relativeTo', 'relation', 'containerId', 'slot', 'gap']),
        kind,
        title: String(args.title ?? ''),
        tone: args.tone ?? 'idle'
      });
      if (!parsed.success) {
        return { content: `props: ${parsed.error.message}`, isError: true };
      }
      const size = DEFAULT_ARTIFACT_SIZE[kind];
      const position = ctx.board.placeForAgent(ctx.agent.id, size);
      const node = createArtifactNode({
        artifact: parsed.data,
        position,
        size,
        createdBy: ctx.agent.id,
        parentId: frame?.id ?? null
      });
      ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });
      nodeId = node.id;
    }

    const node = ctx.board.getNode(nodeId!);
    if (!node) return { content: 'узел не создался', isError: true };

    if (relation === 'inside') {
      const containerId = String(
        args.containerId ?? args.relativeTo ?? frame?.id ?? ''
      );
      if (!containerId) return { content: 'нет контейнера для inside', isError: true };
      const container = ctx.board.getNode(containerId);
      if (!container || (container.type !== 'frame' && container.type !== 'group')) {
        return { content: 'inside требует frame или group', isError: true };
      }
      const siblings = [
        ...ctx.board.nodes.filter((n) => n.parentId === containerId && n.id !== node.id),
        { ...node, parentId: containerId }
      ];
      const placeGap = typeof args.gap === 'number' ? args.gap : container.layout?.gap ?? 24;
      // Never restack siblings here — that turned mindmaps into a vertical line.
      // Packing is opt-in via board_arrange / board_group layout=….
      const others = siblings.filter((n) => n.id !== node.id);
      let nextPos = node.position;
      if (others.length > 0) {
        const anchor = others[others.length - 1]!;
        nextPos = relativePosition(anchor, 'below', node.size, placeGap);
      }
      const working = siblings.map((n) =>
        n.id === node.id ? { ...n, position: nextPos } : n
      ) as BoardNode[];
      const ops: Parameters<typeof ctx.board.apply>[0]['ops'] = [
        {
          op: 'updateNode',
          id: node.id,
          patch: {
            parentId: containerId,
            layout: {
              ...(node.layout ?? { mode: 'free' }),
              slot: args.slot ? String(args.slot) : undefined
            }
          }
        },
        { op: 'moveNodes', moves: [{ id: node.id, position: nextPos }] }
      ];
      if (container.type === 'group') {
        const wrapped = wrapBounds(working);
        if (wrapped) {
          ops.push({
            op: 'moveNodes',
            moves: [{ id: container.id, position: wrapped.position }]
          });
          ops.push({ op: 'resizeNode', id: container.id, size: wrapped.size });
        }
      } else {
        const childRight = nextPos.x + node.size.w + 24;
        const childBottom = nextPos.y + node.size.h + 24;
        const needW = Math.max(container.size.w, childRight - container.position.x);
        const needH = Math.max(container.size.h, childBottom - container.position.y);
        if (needW !== container.size.w || needH !== container.size.h) {
          ops.push({
            op: 'resizeNode',
            id: container.id,
            size: { w: needW, h: needH }
          });
        }
      }
      ctx.board.apply({ origin: ctx.agent.id, ops });
      ensureFrameCovers(ctx, [node.id]);
      return { content: `Узел ${node.id} внутри ${containerId}.`, nodeId: node.id };
    }

    const anchorId = args.relativeTo ? String(args.relativeTo) : frame?.id;
    if (!anchorId) return { content: 'нужен relativeTo', isError: true };
    const anchor = ctx.board.getNode(anchorId);
    if (!anchor) return { content: `опора не найдена: ${anchorId}`, isError: true };
    const placeGap = typeof args.gap === 'number' ? args.gap : 24;
    const pos = relativePosition(anchor, relation, node.size, placeGap);

    const placed = { id: node.id, position: pos, size: node.size };
    const overlaps = findOverlaps(
      placed,
      collisionCandidates(ctx.board.nodes, new Set([node.id, anchorId]))
    );
    if (overlaps.length > 0) {
      const detail = formatSpatialWarning({ overlaps });
      const blocked = spatialRiskForAgent(
        detail,
        args.acceptSpatialRisk === true,
        'другое relation/gap или board_arrange'
      );
      if (blocked) return blocked;
    }

    ctx.board.apply({
      origin: ctx.agent.id,
      ops: [{ op: 'moveNodes', moves: [{ id: node.id, position: pos }] }]
    });
    ensureFrameCovers(ctx, [node.id]);
    return {
      content: `Узел ${node.id} размещён ${relation} относительно ${anchorId}.`,
      nodeId: node.id
    };
  }
});

defineTool({
  name: 'board_group',
  toolset: 'board',
  readOnly: false,
  description: [
    'Сгруппировать узлы в цветную подложку (accent). По умолчанию НЕ двигает узлы — только parentId и размер по их bbox.',
    'layout=keep (по умолчанию) | column | row | grid | stack | flow — явная перекладка только если нужно.'
  ].join(' '),
  parameters: objectSchema(
    {
      label: str('Название группы'),
      accent: str('Цвет акцента (#hex)'),
      nodeIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Id узлов для группировки'
      },
      layout: str('keep — сохранить позиции (по умолчанию); иначе режим упаковки', {
        enum: ['keep', 'column', 'row', 'grid', 'stack', 'flow']
      })
    },
    ['label', 'nodeIds']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const { createGroupNode } = await import('@zmtki/board-schema');
    const { layoutChildren, wrapBounds } = await import('../board/SpatialLayoutEngine.js');
    const ids = (args.nodeIds as string[]) ?? [];
    const members = ids
      .map((id) => ctx.board.getNode(id))
      .filter((n): n is BoardNode => Boolean(n));
    if (members.length === 0) return { content: 'нет узлов для группы', isError: true };
    const layoutArg = String(args.layout ?? 'keep');
    const wrapped = wrapBounds(members) ?? {
      position: { x: members[0]!.position.x - 16, y: members[0]!.position.y - 40 },
      size: { w: 400, h: 300 }
    };
    const group = createGroupNode({
      label: String(args.label),
      accent: String(args.accent ?? '#6ea8fe'),
      position: wrapped.position,
      size: wrapped.size,
      createdBy: ctx.agent.id
    });

    if (layoutArg === 'keep') {
      ctx.board.apply({
        origin: ctx.agent.id,
        ops: [
          { op: 'addNode', node: group },
          ...members.map((m) => ({
            op: 'updateNode' as const,
            id: m.id,
            patch: { parentId: group.id }
          }))
        ]
      });
      return {
        content: `Группа «${group.label}» ${group.id} из ${members.length} узлов (позиции сохранены).`,
        nodeId: group.id
      };
    }

    const packMode = layoutArg as 'column' | 'row' | 'grid' | 'stack' | 'flow';
    const { moves, containerSize, containerPosition } = layoutChildren(
      { id: group.id, position: group.position, size: group.size, layout: group.layout },
      members.map((m) => ({ ...m, parentId: group.id })),
      { mode: packMode, gap: 16 }
    );
    const finalPos = containerPosition ?? group.position;
    ctx.board.apply({
      origin: ctx.agent.id,
      ops: [
        {
          op: 'addNode',
          node: {
            ...group,
            position: finalPos,
            size: containerSize,
            layout: {
              mode: packMode === 'flow' ? 'column' : packMode,
              gap: 16
            }
          }
        },
        ...members.map((m) => ({
          op: 'updateNode' as const,
          id: m.id,
          patch: { parentId: group.id }
        })),
        ...(moves.length ? [{ op: 'moveNodes' as const, moves }] : [])
      ]
    });
    return {
      content: `Группа «${group.label}» ${group.id} из ${members.length} узлов (${packMode}).`,
      nodeId: group.id
    };
  }
});

defineTool({
  name: 'board_ungroup',
  toolset: 'board',
  readOnly: false,
  description: 'Снять группировку: обнулить parentId детей и удалить group-узел.',
  parameters: objectSchema({ groupId: str('Id группы') }, ['groupId']),
  async handler(args, ctx): Promise<ToolResult> {
    const groupId = String(args.groupId);
    const group = ctx.board.getNode(groupId);
    if (!group || group.type !== 'group') return { content: 'это не группа', isError: true };
    const kids = ctx.board.nodes.filter((n) => n.parentId === groupId);
    ctx.board.apply({
      origin: ctx.agent.id,
      ops: [
        ...kids.map((k) => ({ op: 'updateNode' as const, id: k.id, patch: { parentId: null } })),
        { op: 'removeNode', id: groupId }
      ]
    });
    return { content: `Группа ${groupId} снята.` };
  }
});

defineTool({
  name: 'board_set_state',
  toolset: 'board',
  readOnly: false,
  description: [
    'Переключить visualState узла: expanded | widget | icon | ghost.',
    'Чтобы убрать узел с доски — по умолчанию board_delete.',
    'ghost (архив) только если пользователь явно просит сохранить «в архиве», иначе удаляй.'
  ].join(' '),
  parameters: objectSchema(
    {
      nodeId: str('Id узла'),
      visualState: str('Состояние', { enum: ['expanded', 'widget', 'icon', 'ghost'] })
    },
    ['nodeId', 'visualState']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const nodeId = String(args.nodeId);
    const node = ctx.board.getNode(nodeId);
    if (!node) return { content: `узел не найден: ${nodeId}`, isError: true };
    const visualState = String(args.visualState) as 'expanded' | 'widget' | 'icon' | 'ghost';
    if (visualState === 'ghost') {
      const approved = await ctx.requestApproval({
        kind: 'write',
        title: 'Архивировать узел (ghost)?',
        detail:
          'По умолчанию ненужные узлы удаляй через board_delete. Архив — только по явной просьбе сохранить.',
        subject: `ghost:${nodeId}`
      });
      if (!approved) {
        return {
          content: 'Архивирование отклонено. Чтобы убрать узел — вызови board_delete.',
          isError: true
        };
      }
    }
    const patch: Record<string, unknown> = { visualState };
    const meta = { ...(node.meta ?? {}) };
    if (visualState !== 'expanded' && node.visualState === 'expanded') {
      meta.expandedSize = { ...node.size };
      patch.meta = meta;
      if (visualState === 'widget') patch.size = { w: Math.min(node.size.w, 280), h: 72 };
      if (visualState === 'icon') patch.size = { w: 64, h: 64 };
    }
    if (visualState === 'expanded' && meta.expandedSize) {
      patch.size = meta.expandedSize;
      delete meta.expandedSize;
      patch.meta = meta;
    }
    ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'updateNode', id: nodeId, patch }] });
    return { content: `${nodeId} → ${visualState}`, nodeId };
  }
});

defineTool({
  name: 'board_lock',
  toolset: 'board',
  readOnly: false,
  description: 'Взять soft-lock на узел (heldBy) или выставить флаги delete/move/edit.',
  parameters: objectSchema(
    {
      nodeId: str('Id'),
      hold: { type: 'boolean', description: 'Взять/снять soft hold' },
      delete: { type: 'boolean' },
      move: { type: 'boolean' },
      edit: { type: 'boolean' }
    },
    ['nodeId']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const { withHeldBy, clearHeldBy } = await import('../board/OwnershipLocks.js');
    const nodeId = String(args.nodeId);
    const node = ctx.board.getNode(nodeId);
    if (!node) return { content: 'узел не найден', isError: true };
    let lock = { ...(node.lock ?? { delete: false, move: false, edit: false }) };
    if (typeof args.delete === 'boolean') lock.delete = args.delete;
    if (typeof args.move === 'boolean') lock.move = args.move;
    if (typeof args.edit === 'boolean') lock.edit = args.edit;
    if (args.hold === true) lock = withHeldBy({ ...node, lock }, ctx.agent.id);
    if (args.hold === false) lock = clearHeldBy({ ...node, lock });
    ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'updateNode', id: nodeId, patch: { lock } }] });
    return { content: `lock обновлён для ${nodeId}` };
  }
});

defineTool({
  name: 'board_app_list_sources',
  toolset: 'board',
  readOnly: true,
  description:
    'Список окон и экранов ОС для трансляции (appView mode=mirror). Вернёт id/name/kind — потом board_app_embed.',
  parameters: objectSchema({}),
  async handler(_args, ctx): Promise<ToolResult> {
    if (!ctx.services.appView) {
      return { content: 'appView host недоступен', isError: true };
    }
    const sources = await ctx.services.appView.listSources();
    if (sources.length === 0) return { content: 'Источники не найдены (права экрана / нет окон).' };
    const lines = sources.slice(0, 40).map((s, i) => `${i + 1}. [${s.kind}] ${s.name} — ${s.id}`);
    return {
      content: `Доступно ${sources.length} источников (показаны до 40):\n${lines.join('\n')}`
    };
  }
});

defineTool({
  name: 'board_app_embed',
  toolset: 'board',
  readOnly: false,
  description: [
    'Встроить или транслировать приложение на доску (kind=appView).',
    'mode=web — интерактивное веб-окно поверх узла (localhost/сайт).',
    'mode=headless — скрытый браузер + видеопоток кадров на узел (агентский браузер без оверлея).',
    'mode=mirror — трансляция реального окна/экрана ОС (сначала board_app_list_sources).',
    'Если передан nodeId — перенастроить существующий appView; иначе создать новый.'
  ].join(' '),
  parameters: objectSchema(
    {
      mode: str('Режим', { enum: ['web', 'headless', 'mirror'] }),
      title: str('Заголовок артефакта'),
      url: str('URL для web/headless'),
      sourceId: str('Id источника из board_app_list_sources (mirror)'),
      sourceName: str('Имя окна/экрана (mirror)'),
      fps: num('Кадры/сек для headless/mirror (1–30, по умолчанию 8)'),
      live: str('web: true=оверлей, false=только кадры', { enum: ['true', 'false'] }),
      nodeId: str('Существующий appView для обновления')
    },
    ['mode']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    if (!ctx.services.appView) {
      return { content: 'appView host недоступен (нужен desktop)', isError: true };
    }
    const mode = String(args.mode) as 'web' | 'headless' | 'mirror';
    const url = String(args.url ?? (mode === 'mirror' ? '' : 'about:blank'));
    const sourceId = String(args.sourceId ?? '');
    const sourceName = String(args.sourceName ?? '');
    const fps = typeof args.fps === 'number' ? Math.max(1, Math.min(30, args.fps)) : 8;
    const live = args.live === 'false' ? false : true;

    if (mode === 'mirror' && !sourceId) {
      return {
        content: 'для mirror нужен sourceId — вызови board_app_list_sources',
        isError: true
      };
    }
    if ((mode === 'web' || mode === 'headless') && !url) {
      return { content: 'для web/headless нужен url', isError: true };
    }

    const frame = agentFrameOf(ctx);
    let nodeId = args.nodeId ? String(args.nodeId) : null;
    const title =
      String(args.title ?? '') ||
      (mode === 'mirror' ? sourceName || 'Окно' : url) ||
      'App';

    if (!nodeId) {
      const size = DEFAULT_ARTIFACT_SIZE.appView;
      const position = ctx.board.placeForAgent(ctx.agent.id, size);
      const parsed = ArtifactSpecSchema.safeParse({
        kind: 'appView',
        title,
        tone: 'running',
        mode,
        url,
        sourceId,
        sourceName,
        fps,
        live,
        running: true
      });
      if (!parsed.success) {
        return { content: `spec: ${parsed.error.message}`, isError: true };
      }
      const node = createArtifactNode({
        artifact: parsed.data,
        position,
        size,
        createdBy: ctx.agent.id,
        parentId: frame?.id ?? null
      });
      ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });
      nodeId = node.id;
    } else {
      const node = ctx.board.getNode(nodeId);
      if (!node || !isArtifactNode(node) || node.artifact.kind !== 'appView') {
        return { content: 'nodeId должен быть appView', isError: true };
      }
      ctx.board.apply({
        origin: ctx.agent.id,
        ops: [
          {
            op: 'updateNode',
            id: nodeId,
            patch: {
              artifact: {
                ...node.artifact,
                title,
                tone: 'running',
                mode,
                url,
                sourceId,
                sourceName,
                fps,
                live,
                running: true,
                error: ''
              }
            }
          }
        ]
      });
    }

    try {
      await ctx.services.appView.open({
        nodeId,
        mode,
        url,
        sourceId,
        sourceName,
        fps,
        live
      });
    } catch (err) {
      return {
        content: `host error: ${err instanceof Error ? err.message : String(err)}`,
        nodeId,
        isError: true
      };
    }

    return {
      content: `appView ${nodeId} (${mode}${mode === 'mirror' ? `: ${sourceName || sourceId}` : `: ${url}`}).`,
      nodeId
    };
  }
});

defineTool({
  name: 'board_app_navigate',
  toolset: 'board',
  readOnly: false,
  description: 'Перейти по URL в appView / browser (web или headless).',
  parameters: objectSchema(
    {
      nodeId: str('Id узла appView или browser'),
      url: str('Новый URL')
    },
    ['nodeId', 'url']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    if (!ctx.services.appView) {
      return { content: 'appView host недоступен', isError: true };
    }
    const nodeId = String(args.nodeId);
    const url = String(args.url);
    const node = ctx.board.getNode(nodeId);
    if (!node || !isArtifactNode(node)) {
      return { content: 'узел не найден', isError: true };
    }
    if (node.artifact.kind === 'appView') {
      ctx.board.apply({
        origin: ctx.agent.id,
        ops: [
          {
            op: 'updateNode',
            id: nodeId,
            patch: { artifact: { ...node.artifact, url, error: '' } }
          }
        ]
      });
    } else if (node.artifact.kind === 'browser' || node.artifact.kind === 'demo') {
      ctx.board.apply({
        origin: ctx.agent.id,
        ops: [
          {
            op: 'updateNode',
            id: nodeId,
            patch: { artifact: { ...node.artifact, url } }
          }
        ]
      });
    } else {
      return { content: 'нужен appView, browser или demo', isError: true };
    }
    await ctx.services.appView.navigate(nodeId, url);
    return { content: `Навигация ${nodeId} → ${url}`, nodeId };
  }
});

defineTool({
  name: 'board_app_close',
  toolset: 'board',
  readOnly: false,
  description: 'Остановить сессию appView (освободить WebContents / захват) и пометить running=false.',
  parameters: objectSchema({ nodeId: str('Id appView') }, ['nodeId']),
  async handler(args, ctx): Promise<ToolResult> {
    const nodeId = String(args.nodeId);
    await ctx.services.appView?.stop(nodeId);
    const node = ctx.board.getNode(nodeId);
    if (node && isArtifactNode(node) && node.artifact.kind === 'appView') {
      ctx.board.apply({
        origin: ctx.agent.id,
        ops: [
          {
            op: 'updateNode',
            id: nodeId,
            patch: { artifact: { ...node.artifact, running: false, tone: 'idle' } }
          }
        ]
      });
    }
    return { content: `Сессия ${nodeId} остановлена.`, nodeId };
  }
});

defineTool({
  name: 'board_subscribe',
  toolset: 'board',
  readOnly: false,
  description: [
    'Подписаться на пространственные события доски.',
    'Типы: human.moved_into_frame, human.moved_out_of_frame, human.drew_edge,',
    'artifact.state_changed, artifact.control_invoked, terminal.exited, node.locked_changed, *'
  ].join(' '),
  parameters: objectSchema(
    {
      event: str('Тип события или *'),
      frameId: str('Фильтр по рамке'),
      nodeId: str('Фильтр по узлу')
    },
    ['event']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const filter: Record<string, unknown> = {};
    if (args.frameId) filter.frameId = String(args.frameId);
    if (args.nodeId) filter.nodeId = String(args.nodeId);
    await ctx.services.boardEvents?.subscribe(ctx.board.id, ctx.agent.id, String(args.event), filter);
    return { content: `Подписка на ${args.event} активна.` };
  }
});

defineTool({
  name: 'board_unsubscribe',
  toolset: 'board',
  readOnly: false,
  description: 'Снять подписку на событие.',
  parameters: objectSchema({ event: str('Тип события') }, ['event']),
  async handler(args, ctx): Promise<ToolResult> {
    await ctx.services.boardEvents?.unsubscribe(ctx.board.id, ctx.agent.id, String(args.event));
    return { content: `Подписка на ${args.event} снята.` };
  }
});

defineTool({
  name: 'stickers_list',
  toolset: 'board',
  readOnly: true,
  description: 'Список стикерпаков и стикеров (packId / stickerId / emoji). Перед sticker_place посмотри, что есть.',
  parameters: objectSchema({}),
  async handler(_args, ctx): Promise<ToolResult> {
    const packs = ctx.services.stickers?.list() ?? [];
    if (packs.length === 0) return { content: 'стикерпаков нет' };
    return {
      content: packs
        .map(
          (p) =>
            `### ${p.name} (${p.id}, ${p.scope})\n` +
            p.stickers.map((s) => `- ${s.id}${s.emoji ? ` ${s.emoji}` : ''}`).join('\n')
        )
        .join('\n\n')
    };
  }
});

defineTool({
  name: 'sticker_place',
  toolset: 'board',
  readOnly: false,
  description:
    'Поставить стикер из пака на доску (то же, что board_create_mark kind=sticker). Сначала stickers_list. Стартовый пак basics: ok, fire, check, think, rocket, heart, clap, party.',
  parameters: objectSchema(
    {
      packId: str('Id пака'),
      stickerId: str('Id стикера'),
      relativeTo: str('Опционально — рядом с узлом'),
      relation: str('rightOf|leftOf|below|above|inside', {
        enum: ['rightOf', 'leftOf', 'below', 'above', 'inside']
      })
    },
    ['packId', 'stickerId']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const placed = await ctx.services.stickers?.place({
      boardId: ctx.board.id,
      packId: String(args.packId),
      stickerId: String(args.stickerId),
      agentId: ctx.agent.id,
      relativeTo: args.relativeTo ? String(args.relativeTo) : undefined,
      relation: args.relation ? String(args.relation) : undefined
    });
    if (!placed?.ok) return { content: placed?.error ?? 'стикер не размещён', isError: true };
    return { content: `Стикер ${args.packId}/${args.stickerId} → ${placed.nodeId}`, nodeId: placed.nodeId };
  }
});
