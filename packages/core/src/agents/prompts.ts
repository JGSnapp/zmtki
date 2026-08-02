import type { Agent } from '@zmtki/board-schema';
import type { ChatMessage } from '../llm/types.js';

const COLLABORATION = `# Работа с людьми и другими агентами

- Комнаты — единственный канал общения. Человек видит всю переписку, скрытых каналов нет.
- Финальный текст хода сам публикуется в комнату запроса. Не дублируй его через room_send.
- room_send — для промежуточных апдейтов, @упоминаний других агентов и ссылок на артефакты mid-turn.
- Другой агент возьмёт ход, только если ты укажешь его id в mentions у room_send. Без упоминания сообщение останется просто репликой в ленте.
- Прежде чем звать кого-то, найди его через agent_directory_search и посмотри, чем он занимается.
- Когда нужен отслеживаемый результат, а не просто ответ, ставь задачу через task_assign.
- Не переписывайся ради переписки: у комнат есть лимит на число ответов агентов подряд, и при его исчерпании обсуждение встанет на паузу до вмешательства человека. Каждое твоё сообщение должно двигать дело.
- Писать можно только на свою доску. Чтобы что-то изменилось на чужой, попроси её агента-резидента.
- На комментарии, адресованные тебе, отвечай через board_comment_reply до завершения хода.`;

const WORKING_RULES = `# Как работать

- Сначала посмотри, что уже есть: board_read со scope=frame, потом при необходимости outside.
- Не выдумывай содержимое файлов, читай их через read_file.
- Проверяй результат: если что-то запустил или починил, покажи работающий вывод, а не утверждение, что всё хорошо.
- Независимые действия запускай одним ответом с несколькими вызовами инструментов — они выполнятся параллельно.
- Если задача неоднозначна, спроси в комнате, а не угадывай.
- Заканчивай ход коротким финальным текстом (он уйдёт в чат сам): что сделано и где смотреть на доске. Не повторяй этот же текст через room_send.
- Визуальные элементы доски (фигуры, текст, sticky, стикеры) создавай через board_create_mark — они тоже часть отчёта, не только «артефакты» kind=markdown/status/….
- Раскладка: схемы со стрелками (вики, деревья, DAG) — после связей вызови board_arrange layout=graph (как Mermaid; direction=tb по умолчанию, lr при необходимости). Свободная доска без стрелок — board_place. Линейный пайплайн — layout=flow. Группа (board_group) по умолчанию только подложка. Стороны: fromSide/toSide или auto.
- После каждого размещения артефактов проверяй эстетику: пересечения, расстояния, выравнивание. При сомнении или после схемы из нескольких узлов — board_screenshot (картинка уйдёт в vision) и поправь раскладку.
- Приложения на доске: board_app_embed mode=web (интерактивный сайт/localhost), mode=headless (скрытый браузер + поток кадров), mode=mirror (трансляция окна ОС — сначала board_app_list_sources). Навигация: board_app_navigate; стоп: board_app_close.
- Текст для человека: note / blocks / codePad / markdown — их можно править на доске.`;

export interface PromptTiers {
  /** Identity, protocol, tool guidance. Never changes within a session. */
  stable: string;
  /** Board and project context. Changes when the workspace changes. */
  context: string;
  /** Inbox, comments, timestamp. Changes every turn. */
  volatile: string;
}

export interface BuildPromptInput {
  agent: Agent;
  boardName: string;
  boardPath: string;
  boardDescription: string;
  /** Full content of what is inside the agent's frame. */
  frameContext: string;
  /** Compact index of everything outside the frame. */
  peripheralContext: string;
  /** Rooms the agent belongs to, with recent traffic. */
  roomsContext: string;
  /** Undelivered mentions and comment threads. */
  inboxDigest: string;
  /** Compact roster of sibling agents on this board. */
  agentRoster?: string;
  skillsContext?: string;
  /**
   * Formatted artifact etiquette from app settings (enabled rules only).
   * Empty string omits the section.
   */
  artifactEtiquette?: string;
}

/**
 * Three tiers exist to keep the provider's prefix cache warm: the stable tier
 * is byte-identical across turns, so everything before the first change is a
 * cache hit. Rebuilding one big prompt each turn would throw that away.
 */
export function buildPromptTiers(input: BuildPromptInput): PromptTiers {
  const etiquette = input.artifactEtiquette?.trim() ?? '';
  const stableParts = [
    `Ты — ${input.agent.name}, агент в системе Artifact Board.`,
    input.agent.persona ? `\n${input.agent.persona}\n` : '',
    'Ты работаешь на интерактивной доске: рабочая область с артефактами, которую человек видит в реальном времени.',
    `Твой id: ${input.agent.id}. Твой handle: @${input.agent.handle}.`
  ];
  if (etiquette) stableParts.push('', etiquette);
  stableParts.push('', COLLABORATION, '', WORKING_RULES);
  const stable = stableParts.join('\n');

  const context = [
    '# Проект',
    `Название: ${input.boardName}`,
    `Папка: ${input.boardPath}`,
    input.boardDescription ? `Описание: ${input.boardDescription}` : '',
    '',
    '# Другие агенты',
    input.agentRoster || '(ты один на этой доске)',
    input.skillsContext ? `\n${input.skillsContext}` : '',
    '',
    '# Комнаты',
    input.roomsContext || '(нет комнат)'
  ]
    .filter(Boolean)
    .join('\n');

  const volatile = [
    '# Твоя рамка',
    input.frameContext || '(рамка пуста — обставь её)',
    '',
    '# Остальная доска',
    input.peripheralContext || '(пусто)',
    input.inboxDigest ? `\n# Входящие\n${input.inboxDigest}` : '',
    '',
    `Текущее время: ${new Date().toISOString()}`
  ]
    .filter(Boolean)
    .join('\n');

  return { stable, context, volatile };
}

export function tiersToMessages(tiers: PromptTiers): ChatMessage[] {
  return [
    // The breakpoint tells Anthropic where the cacheable prefix ends.
    { role: 'system', content: tiers.stable, cacheBreakpoint: true },
    { role: 'system', content: tiers.context },
    { role: 'system', content: tiers.volatile }
  ];
}

export function buildSubagentPrompt(brief: string, context: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'Ты — одноразовый подагент. Тебе поручена узкая задача.',
        'Работай самостоятельно, не задавай уточняющих вопросов.',
        'Твои промежуточные шаги не увидит родительский агент — важен только итоговый ответ.',
        'Заверши работу кратким, но полным отчётом: что выяснил, что сделал, какие остались риски.',
        context ? `\n# Контекст\n${context}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    },
    { role: 'user', content: brief }
  ];
}
