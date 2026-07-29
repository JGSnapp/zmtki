import { z } from 'zod';

export const SearchProviderIdSchema = z.enum([
  'searxng',
  'brave',
  'duckduckgo',
  'google_pse',
  'tavily',
  'serper',
  'disabled'
]);
export type SearchProviderId = z.infer<typeof SearchProviderIdSchema>;

/** One toggleable rule of the artifact etiquette injected into the agent prompt. */
export const ArtifactEtiquetteRuleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  enabled: z.boolean().default(true)
});
export type ArtifactEtiquetteRule = z.infer<typeof ArtifactEtiquetteRuleSchema>;

/**
 * Default etiquette. Lives in app settings so the user can toggle, edit, add
 * or remove rules; enabled ones are spliced into the agent system prompt.
 */
export const DEFAULT_ARTIFACT_ETIQUETTE: ArtifactEtiquetteRule[] = [
  {
    id: 'traceability',
    title: 'Прозрачность действий (Traceability)',
    body:
      'Сначала создай артефакт (terminal, browser и т.п.), затем запускай процесс. Пользователь должен видеть работу в реальном времени, а не только финальный результат. Не прячь долгие действия «за кулисами».',
    enabled: true
  },
  {
    id: 'decomposition',
    title: 'Максимальная декомпозиция (Decomposition)',
    body:
      'Выбирай kind строго под суть подзадачи и дроби работу. Вместо одного огромного markdown или file раскладывай задачу на набор fileFragment, todo, terminal, chart и других узлов внутри своей рамки — если явно не попросили иное.',
    enabled: true
  },
  {
    id: 'semantic-medium',
    title: 'Семантический формат (Semantic Medium)',
    body:
      'Никаких простыней текста. Код — diff или fileFragment; архитектура — mermaid; данные — chart или table; задачи — kanban или todo; интерфейсы — htmlWidget или demo; короткий пульс — status.',
    enabled: true
  },
  {
    id: 'aesthetics',
    title: 'Эстетика «доски детектива» (Aesthetics)',
    body:
      'Оформляй пространство структурно и читаемо: как доска расследования или аккуратный майндмап. Выравнивай элементы (board_arrange / board_place), не допускай наложений, компонуй вокруг смысловых центров. Если есть стрелки — оставляй воздух между узлами и раскладывай через board_arrange layout=flow.',
    enabled: true
  },
  {
    id: 'topology',
    title: 'Обязательная связность (Topology)',
    body:
      'Соединяй зависимые артефакты стрелками (board_connect). Если фиксишь баг — связь от лога/ошибки к коду. Не связывай «всех со всеми». После нескольких связей вызови board_arrange layout=flow: слои по направлению связей, больше отступы, минимум пересечений линий.',
    enabled: true
  },
  {
    id: 'edge-clarity',
    title: 'Чистые связи (Edge Clarity)',
    body:
      'Схемы со стрелками не должны выглядеть клубком. Давай узлам пространство; выстраивай поток слева направо или сверху вниз; избегай пересечений и длинных диагоналей. Предпочитай board_arrange layout=flow вместо ручных пикселей.',
    enabled: true
  },
  {
    id: 'context-notes',
    title: 'Текстовое сопровождение (Context Notes)',
    body:
      'Не оставляй артефакты немыми. Рядом со смысловыми узлами размещай короткие пояснения (sticker_place или небольшой markdown): зачем элемент здесь, что внутри происходит, к какому выводу ты пришёл.',
    enabled: true
  },
  {
    id: 'grouping',
    title: 'Локальность и группировка (Grouping)',
    body:
      'Артефакты одной задачи держи компактно (board_arrange / board_place) и объединяй в смысловые блоки с accent (board_group), чтобы их можно было двигать вместе.',
    enabled: true
  },
  {
    id: 'lifecycle',
    title: 'Чистота и свёртывание (Lifecycle)',
    body:
      'Завершил подзадачу — сверни узел (board_set_state: widget/icon/ghost), оставь компактный status или удали неактуальные временные логи/файлы (board_delete). Не копи мусор по мере продвижения.',
    enabled: true
  },
  {
    id: 'no-duplication',
    title: 'Фокус вместо дублирования (No Duplication)',
    body:
      'Сначала ищи (board_search / search_files / board_read). Если нужный файл или артефакт уже на доске — не создавай копию. Перемести к нему рамку (board_move_frame) или сфокусируй (board_focus) и обновляй существующий узел.',
    enabled: true
  },
  {
    id: 'non-destructive',
    title: 'Уважение к чужому (Non-Destructive)',
    body:
      'Не удаляй и не правь заблокированные (lock) или явно человеческие объекты. Нужны изменения — прикрепи стикер с предложением или ответь через board_comment_reply; попроси снять защиту, если без этого нельзя.',
    enabled: true
  },
  {
    id: 'portals',
    title: 'Пространственное делегирование (Portals)',
    body:
      'Передавая задачу другому агенту, не копируй файлы на свою доску. Используй portal_create, чтобы связать своё пространство с артефактом/контекстом нужного агента, и зови его через комнату (@mention / task_assign).',
    enabled: true
  },
  {
    id: 'signal-density',
    title: 'Информационная плотность (Signal)',
    body:
      'Не оставляй на доске бессодержательные узлы: пустые status/todo/markdown, «заглушки», артефакты без факта, вывода или следующего шага. Каждый видимый узел должен говорить человеку что-то важное; иначе сверни (board_set_state) или удали (board_delete).',
    enabled: true
  },
  {
    id: 'just-in-time',
    title: 'По этапу задачи (Just-in-time)',
    body:
      'Не раскладывай сходу каркас из status, kanban, todo «на всякий случай». Подключай их только когда по логике этапа это нужно: план — когда есть что дробить и отслеживать; status — когда идёт длительная работа с меняющимся состоянием; итог — когда есть результат. Короткий вопрос или один шаг — часто достаточно чата и одного целевого артефакта.',
    enabled: true
  }
];

function cloneEtiquette(rules: readonly ArtifactEtiquetteRule[]): ArtifactEtiquetteRule[] {
  return rules.map((r) => ({ ...r }));
}

/** Append factory rules whose ids are missing (does not overwrite user edits). */
export function mergeMissingEtiquetteDefaults(
  current: readonly ArtifactEtiquetteRule[]
): { rules: ArtifactEtiquetteRule[]; added: boolean } {
  const have = new Set(current.map((r) => r.id));
  const missing = DEFAULT_ARTIFACT_ETIQUETTE.filter((r) => !have.has(r.id)).map((r) => ({ ...r }));
  if (missing.length === 0) return { rules: cloneEtiquette(current), added: false };
  return { rules: [...current.map((r) => ({ ...r })), ...missing], added: true };
}

export const AppSettingsSchema = z.object({
  /** Endpoint id used by agents that do not override it. */
  defaultEndpointId: z.string().nullable().default(null),
  defaultModel: z.string().nullable().default(null),

  /**
   * Global cap on turns running at once. Without it, five open projects with
   * three agents each will saturate the machine and the budget.
   */
  maxConcurrentTurns: z.number().int().min(1).max(32).default(3),

  /**
   * Rounds of model call -> tool execution inside a single turn. A turn that
   * hits this limit is paused rather than killed, so nothing is lost.
   */
  maxRoundsPerTurn: z.number().int().min(1).max(200).default(40),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().default(8192),

  approvalPolicy: z.enum(['never', 'onRequest', 'untrusted']).default('onRequest'),
  sandboxPolicy: z.enum(['readOnly', 'boardWrite', 'fullAccess']).default('boardWrite'),

  searchProvider: SearchProviderIdSchema.default('duckduckgo'),
  searchFallbackChain: z.array(SearchProviderIdSchema).default(['duckduckgo']),
  searchUrl: z.string().default('https://searx.be'),
  searchResultCount: z.number().int().min(1).max(50).default(8),
  googlePseCx: z.string().default(''),

  /** Notifications: quiet everything but the active board and blockers. */
  focusMode: z.boolean().default(false),
  soundOnBlocking: z.boolean().default(true),

  theme: z.enum(['dark', 'light']).default('dark'),
  locale: z.enum(['ru', 'en']).default('ru'),

  /** Default room guards, copied into each new room. */
  defaultMaxHops: z.number().int().min(0).max(50).default(6),
  defaultStallThreshold: z.number().int().min(1).max(20).default(4),
  defaultRoomTokenBudget: z.number().int().positive().nullable().default(400_000),

  /**
   * Artifact etiquette rules injected into the agent system prompt.
   * Missing key → factory defaults; empty array → etiquette section omitted.
   */
  artifactEtiquette: z
    .array(ArtifactEtiquetteRuleSchema)
    .default(cloneEtiquette(DEFAULT_ARTIFACT_ETIQUETTE))
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = AppSettingsSchema.parse({});

/** Markdown block for the stable system prompt; empty if nothing is enabled. */
export function formatArtifactEtiquette(rules: readonly ArtifactEtiquetteRule[]): string {
  const enabled = rules.filter((r) => r.enabled && r.title.trim() && r.body.trim());
  if (enabled.length === 0) return '';

  const lines = [
    '# Артефактный этикет',
    '',
    'Доска — твой отчёт и рабочее пространство, которое человек видит в реальном времени. Следуй включённым правилам:',
    ''
  ];

  enabled.forEach((rule, index) => {
    lines.push(`${index + 1}. **${rule.title.trim()}**`);
    lines.push(`   ${rule.body.trim()}`);
    lines.push('');
  });

  return lines.join('\n').trimEnd();
}

/**
 * Project settings are sparse overrides; unset keys inherit from app level.
 */
export function resolveSettings(
  app: AppSettings,
  board: Partial<Record<string, unknown>> | undefined
): AppSettings {
  if (!board) return app;
  const merged: Record<string, unknown> = { ...app };
  for (const [key, value] of Object.entries(board)) {
    if (value !== null && value !== undefined && key in app) merged[key] = value;
  }
  const parsed = AppSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : app;
}
