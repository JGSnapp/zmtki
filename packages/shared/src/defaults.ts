import type { ArtifactProps, ArtifactType } from './artifacts.js';

export interface ArtifactDefinition {
  type: ArtifactType;
  /** Shown in the add menu and in the agent's tool description. */
  label: string;
  /** One line telling an agent what this type is for. */
  hint: string;
  width: number;
  height: number;
  props: ArtifactProps;
  /** Which props the type accepts, documented for the agent. */
  propsHint: string;
  /** Smallest size that still renders sensibly, enforced on resize. */
  minWidth: number;
  minHeight: number;
}

/**
 * Default geometry and props per artifact type.
 *
 * Sizes are multiples of 20 to match the grid the layout skills place on, so an
 * agent that asks for a default-sized artifact lands on the grid without doing
 * arithmetic. They are also honest about content: a kanban board opened at the
 * size of a sticky note would be useless, and an agent has no way to know that.
 */
export const ARTIFACT_DEFINITIONS: Record<ArtifactType, ArtifactDefinition> = {
  note: {
    type: 'note',
    label: 'Заметка',
    hint: 'Короткая мысль, комментарий, вывод. Markdown.',
    width: 240,
    height: 180,
    minWidth: 120,
    minHeight: 80,
    props: { text: '', color: 'yellow' },
    propsHint: 'text: string (markdown), color: yellow|blue|green|pink|purple|gray',
  },
  text: {
    type: 'text',
    label: 'Текст',
    hint: 'Подпись, заголовок раздела или пояснение без рамки.',
    width: 320,
    height: 64,
    minWidth: 100,
    minHeight: 40,
    props: { text: '', fontSize: 24, weight: 600, align: 'left', color: '#e8e8ea' },
    propsHint: 'text: string, fontSize: number, weight: 400|600|700, align: left|center|right, color: css color',
  },
  markdown: {
    type: 'markdown',
    label: 'Markdown',
    hint: 'Отрендеренный markdown: отчёт, выжимка, статья.',
    width: 420,
    height: 340,
    minWidth: 200,
    minHeight: 120,
    props: { text: '' },
    propsHint: 'text: string (markdown)',
  },
  document: {
    type: 'document',
    label: 'Документ',
    hint: 'Длинный документ со своей прокруткой.',
    width: 520,
    height: 640,
    minWidth: 280,
    minHeight: 200,
    props: { text: '' },
    propsHint: 'title: string, text: string (markdown, длинный)',
  },
  'markdown-doc': {
    type: 'markdown-doc',
    label: 'Markdown-документ',
    hint: 'Файл .md на диске, редактируется прямо на доске.',
    width: 520,
    height: 640,
    minWidth: 280,
    minHeight: 200,
    props: { path: '', text: '' },
    propsHint: 'path: абсолютный путь к .md, text: string (содержимое)',
  },
  code: {
    type: 'code',
    label: 'Код',
    hint: 'Фрагмент кода для чтения, с подсветкой. Не редактируется.',
    width: 440,
    height: 280,
    minWidth: 200,
    minHeight: 100,
    props: { language: 'ts', code: '', title: '' },
    propsHint: 'language: string, code: string, title: string',
  },
  'code-editor': {
    type: 'code-editor',
    label: 'Редактор кода',
    hint: 'Редактор файла с диска для пользователя.',
    width: 640,
    height: 520,
    minWidth: 320,
    minHeight: 200,
    props: { path: '', language: '' },
    propsHint: 'path: абсолютный путь к файлу (редактируется на диске) или пусто и code: string, language: по расширению',
  },
  'text-editor': {
    type: 'text-editor',
    label: 'Редактор текста',
    hint: 'Простой редактор текстового файла для пользователя.',
    width: 520,
    height: 440,
    minWidth: 260,
    minHeight: 160,
    props: { path: '', text: '' },
    propsHint: 'path: string, text: string',
  },
  html: {
    type: 'html',
    label: 'HTML',
    hint: 'Своя разметка: диаграмма, график, таблица, мини-визуализация.',
    width: 480,
    height: 360,
    minWidth: 200,
    minHeight: 120,
    props: { html: '' },
    propsHint:
      'html: string — полный документ или фрагмент на всю карточку ' +
      '(width/height 100%, box-sizing:border-box, свой фон и цвет текста: доска тёмная). ' +
      'Размер карточки подбирай так, чтобы не было полосы прокрутки. Скрипты в песочнице разрешены.',
  },
  webview: {
    type: 'webview',
    label: 'Вебвью',
    hint: 'Страница сайта, встроенная в доску для чтения.',
    width: 520,
    height: 400,
    minWidth: 240,
    minHeight: 180,
    props: { url: '', title: '' },
    propsHint:
      'url: https url, title: string. Страница всегда раскладывается в настольное окно ' +
      '1280px и ужимается под карточку, так что узкая карточка показывает сайт мелко, а не ломает его.',
  },
  browser: {
    type: 'browser',
    label: 'Браузер',
    hint: 'Настоящий Google Chrome на доске: страница транслируется в карточку, с ней можно работать.',
    width: 720,
    height: 540,
    minWidth: 360,
    minHeight: 240,
    props: { url: 'https://www.google.com/' },
    propsHint:
      'url: адрес или поисковый запрос; вкладка настоящего Google Chrome, смена url переводит её ' +
      'на новую страницу. Раскладка — настольное окно 1280px, ужатое под карточку.',
  },
  image: {
    type: 'image',
    label: 'Изображение',
    hint: 'Фото, скриншот, диаграмма-картинка.',
    width: 320,
    height: 240,
    minWidth: 80,
    minHeight: 60,
    props: { src: '', alt: '', fit: 'contain' },
    propsHint: 'src: image url or data url, alt: string, fit: contain|cover',
  },
  video: {
    type: 'video',
    label: 'Видео',
    hint: 'Проигрыватель видео: запись работы, демо.',
    width: 480,
    height: 300,
    minWidth: 240,
    minHeight: 160,
    props: { src: '' },
    propsHint: 'src: url видео',
  },
  audio: {
    type: 'audio',
    label: 'Аудио',
    hint: 'Проигрыватель звука.',
    width: 360,
    height: 120,
    minWidth: 220,
    minHeight: 80,
    props: { src: '', title: '' },
    propsHint: 'src: url аудио, title: string',
  },
  terminal: {
    type: 'terminal',
    label: 'Терминал',
    hint: 'Живой терминал. С harnessId в нём запускается CLI-агент.',
    width: 640,
    height: 420,
    minWidth: 320,
    minHeight: 180,
    props: { title: 'terminal', cwd: '', harnessId: '' },
    propsHint: 'title: string, cwd: рабочая папка, harnessId: claude|codex|opencode или пусто для shell',
  },
  'app-stream': {
    type: 'app-stream',
    label: 'Стрим приложения',
    hint: 'Живая трансляция окна другой программы или экрана.',
    width: 640,
    height: 420,
    minWidth: 280,
    minHeight: 180,
    props: { sourceId: '', title: '' },
    propsHint: 'sourceId: id окна из захвата экрана (выбирается пользователем), title: название окна',
  },
  button: {
    type: 'button',
    label: 'Кнопка',
    hint: 'Интерактивная кнопка: запустить команду, открыть ссылку.',
    width: 200,
    height: 80,
    minWidth: 100,
    minHeight: 48,
    props: { label: 'Кнопка', action: '' },
    propsHint: 'label: string, action: url (откроется) или команда (отправится в терминал из target), target: id терминала',
  },
  kanban: {
    type: 'kanban',
    label: 'Канбан',
    hint: 'Доска задач с колонками.',
    width: 720,
    height: 480,
    minWidth: 360,
    minHeight: 240,
    props: { columns: [{ id: 'todo', title: 'Сделать', cards: [] }, { id: 'doing', title: 'В работе', cards: [] }, { id: 'done', title: 'Готово', cards: [] }] },
    propsHint: 'columns: [{ id, title, cards: [{ id, text }] }]',
  },
  ui: {
    type: 'ui',
    label: 'Интерфейс',
    hint: 'Собранный агентом интерактивный мини-интерфейс.',
    width: 480,
    height: 360,
    minWidth: 200,
    minHeight: 140,
    props: { html: '' },
    propsHint:
      'html: string — интерактивный интерфейс со своими скриптами в песочнице. ' +
      'Фрагмент на всю карточку (width/height 100%, box-sizing:border-box), фон и цвет текста ' +
      'задай явно, размер карточки — под содержимое, без полосы прокрутки.',
  },
  shape: {
    type: 'shape',
    label: 'Фигура',
    hint: 'Прямоугольник, овал или ромб — рамка и акцент.',
    width: 200,
    height: 140,
    minWidth: 40,
    minHeight: 40,
    props: { shape: 'rect', fill: '#1f2430', stroke: '#5b6478', label: '' },
    propsHint: 'shape: rect|ellipse|diamond|triangle, fill: css color, stroke: css color, label: string',
  },
  drawing: {
    type: 'drawing',
    label: 'Рисунок',
    hint: 'Нарисованные от руки штрихи.',
    width: 360,
    height: 280,
    minWidth: 80,
    minHeight: 80,
    props: { strokes: [], color: '#e8e8ea', width: 3 },
    propsHint: 'strokes: [[x,y,x,y,…]] в локальных координатах, color, width',
  },
  file: {
    type: 'file',
    label: 'Файл',
    hint: 'Ссылка на файл с диска: имя, тип, размер.',
    width: 220,
    height: 110,
    minWidth: 140,
    minHeight: 80,
    props: { path: '' },
    propsHint: 'path: string (путь к файлу)',
  },
};

export const artifactDefinition = (type: ArtifactType): ArtifactDefinition =>
  ARTIFACT_DEFINITIONS[type] ?? ARTIFACT_DEFINITIONS.note;

/** Compact catalog handed to an agent so it can pick a type without guessing. */
export const artifactCatalog = (): string =>
  Object.values(ARTIFACT_DEFINITIONS)
    .map((d) => '  ' + d.type + ' — ' + d.hint + ' (по умолчанию ' + d.width + 'x' + d.height + ')')
    .join('\n');
