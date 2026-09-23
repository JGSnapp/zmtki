# Происхождение кода

Что откуда взято и на каких условиях. Заполняется при каждом переносе.

## `graph_playground` (teca) — наш код, переносится полностью

<https://github.com/JGSnapp/graph_playground> — собственный проект, движок графов.
VISION разрешает использовать наработки полностью; логика движка, скиллы и промпты
копируются 1 в 1. Файла лицензии в репозитории нет: для внешнего наблюдателя это
означает «все права защищены», но для нас ограничений нет, потому что это наш код.
В наш репозиторий лицензию стоит положить явно, чтобы вопрос не возникал.

Базовое состояние на момент переноса: коммит `67271d2`, `npm test` — 234 теста зелёные,
`npm run typecheck` чистый.

### `shared/` → `packages/shared/src/`

| Файл | Состояние |
| --- | --- |
| `geometry.ts`, `routing.ts`, `layout.ts`, `intersections.ts`, `ports.ts`, `quality.ts`, `placement.ts`, `skills.ts`, `suggest.ts` | 1:1 |
| `artifacts.ts` | 7 типов → 22, добавлен признак «живого» артефакта |
| `boards.ts` | убран `model`, добавлены `rootDir` и `zones` |

Новое у нас: `viewport.ts`, `zones.ts`, `defaults.ts` (подсказки `propsHint` для исходных
семи типов взяты из `server/modules/boards/artifact.defaults.ts` teca).

### `server/` → `apps/desktop/src/main/`

| teca | у нас | Состояние |
| --- | --- | --- |
| `core/errors.ts`, `ids.ts`, `store.ts` | `core/` | 1:1; в итерации 2 `store.ts` пишет JSON без отступов |
| `modules/boards/operations.ts` | `boards/operations.ts` | 1:1 + операции над зонами |
| `modules/boards/boards.service.ts` | `boards/boards.service.ts` | без `model`; добавлены `rootDir`, миграция зон, источник изменения (`renderer`/`agent`/`host`), `runAs`, `setViewport`, `createBench`. **Итерация 2:** снимки состояния в истории заменены патчами (`@zmtki/shared/changes.ts`), слушатели получают дельты с версией. Публичный API (`mutate`, `read`, `snapshot`, `restoreState`, `undo`, `redo`, `history`) и откат упавшей транзакции сохранены — тесты teca проходят без изменений |
| `modules/boards/artifact.defaults.ts` | `boards/artifact.defaults.ts` | теперь строится из `@zmtki/shared` |
| `modules/agent/tools/*.tools.ts`, `validate.ts`, `types.ts` | `mcp/tools/` | тулы 1:1; `ToolContext` без настроек LLM, базы знаний и SSE; `board_screenshot` через `capturePage` |
| `modules/agent/render.ts` | `mcp/render.ts` | 1:1, цвета под новые имена типов |
| `modules/skills/skills.service.ts`, `seed.ts` | `skills/` | 1:1 |
| `modules/settings/defaults.ts` → `DEFAULT_SYSTEM_PROMPT` | `mcp/prompt.ts` | промпт 1:1, отдаётся харнессам как MCP `instructions` |
| логика `boardContext`/`skillsContext` из `modules/agent/prompt.ts` | `mcp/server.ts` | та же сборка контекста |
| `test/boards`, `arrange`, `layout.tools`, `ports` | `apps/desktop/test/` | 1:1, другой хелпер окружения |

### `web/` → `apps/desktop/src/renderer/`

| teca | у нас | Состояние |
| --- | --- | --- |
| `components/Markdown.tsx` | `components/Markdown.tsx` | 1:1 |
| `artifacts/EditableText.tsx` | `artifacts/EditableText.tsx` | 1:1 |
| `components/board/ArrowLayer.tsx` | `canvas/ArrowLayer.tsx` | 1:1 |
| рендереры note/text и их CSS | `artifacts/registry.tsx`, `styles.css` | по мотивам, переписаны |
| `test/geometry`, `routing`, `intersections`, `quality` | `packages/shared/test/` | 1:1 |

`BoardCanvas` написан заново: у teca нет виртуализации.

### Не перенесено

| Что | Почему |
| --- | --- |
| `server/modules/llm`, `agent.service`, `chat`, `knowledge` | Встроенного чат-агента нет: агенты — CLI-харнессы через MCP |
| `bench/run.ts`, `report.ts` | LLM-прогоны с оплатой по токенам |

### Ждёт переноса
- Офлайн-часть `bench/` (`summary`, `offline`, `gate-sim`, `snapshot`) — меряет раскладку без LLM
- Стенд сравнения способов расстановки (`bench/placement-*.ts`) и картинки для README

### Журнал переносов
Что и когда перенесено из плейграунда — [UPSTREAM-PORTS.md](UPSTREAM-PORTS.md).

## `CanvasTTY` — сторонний код, только как ориентир

<https://github.com/howdeploy/CanvasTTY>, MIT, © 2026 howdeploy.

**Код не копировался.** Посмотрены и реализованы у нас заново идеи:

| Идея | Где у нас |
| --- | --- |
| Камера в ref, пан копится и применяется раз в кадр, зум относительно курсора | `renderer/src/canvas/useCamera.ts` |
| Флаг жеста с «хвостом» тишины после последнего шага | там же, `REST_MS` |
| `will-change: transform` только во время пана/зума, чтобы текст перерастеризовался | `useCamera.ts`, слой держится ещё `LAYER_KEEP_MS` после остановки |
| Батчинг вывода PTY по кадру, ограниченный скроллбэк со смещением для переподключения | `main/terminal/manager.ts` |
| Реестр CLI-провайдеров с поиском исполняемого файла | `main/harness/registry.ts` |
| Electron + electron-vite + React + xterm как стек | весь `apps/desktop` |

Если когда-нибудь возьмём оттуда фрагмент кода — он попадает сюда отдельной строкой вместе с
указанием авторства, как требует MIT.

### Движок стрелок и производительность

`computeArrowGeometries` из teca не менялся. Рендерер передаёт ему не всю доску, а выборку
`arrowGeometryScope` (`packages/shared/src/arrowScope.ts`) — концы стрелок и соседей в пределах
`PORT_STUB + 9`. Равенство результата с полной доской проверяется тестом.

## Отступления от «1:1»

| Что | Почему |
| --- | --- |
| `layout.ts`: в `ArrangeOptions` добавлено поле `portSearch` | Проброс бюджета в `searchPorts`, чьи настройки уже были в `ports.ts`. По умолчанию ничего не меняется: без поля движок работает как раньше. Нужно, потому что на 30 узлах раскладка занимала 229 с и вешала приложение. |
| Бюджет поиска портов при прокладке (`ROUTE_BUDGET_MS`) | Считается по размеру доски. На досках, которые меряли в плейграунде (десяток узлов), допуск выходит выше собственного потолка движка и не срабатывает — раскладка совпадает. На 30 узлах с новым обходом снизу прокладка иначе идёт 53 с и не влезает в таймаут вызова агента. |
| Из трёх режимов расстановки оставлен один — `choice` | Промпт и скилл `graph-layout` только в варианте «способ выбирает агент». Два других нужны плейграунду для сравнения в замерах; здесь они были бы настройкой без ответа. Текст самого `choice` — побайтово теки. |
| Раскладка и прокладка вызываются через воркер, а не напрямую | Движок не менялся; менялось место, где он крутится: в главном процессе это вешало окно. |

## Наше поверх teca

То, чего в teca нет и что написано здесь с нуля (идей CanvasTTY тоже не касается):

| Что | Где |
| --- | --- |
| Геометрия зон: объединение протяжек, вычитание, контур объединения | `packages/shared/src/zoneGeometry.ts` |
| Права агента на субагентов: лимит, разрешение человека, дерево родитель — субагент | `main/harness/agents.ts` |
| Привязка агента к зоне и откат вызова, вышедшего за её границы | `main/mcp/server.ts`, `enforceZone` |
| MCP-инструменты зон, субагентов и кнопок | `main/mcp/tools/{zones,agents,button}.tools.ts` |
| Поток для раскладки, бюджет времени и прерываемый перебор вариантов | `main/layout/` |

## Иконки харнессов

Метки CLI в панели «Запустить на доске» — официальные, чтобы ряд читался так же, как эти
инструменты выглядят везде. Пути вшиты в `renderer/src/components/HarnessIcon.tsx` (никаких
запросов в рантайме), перекрашиваются через `currentColor`.

| Метка | Откуда | Лицензия пути | Права на знак |
| --- | --- | --- | --- |
| Claude | [simple-icons](https://github.com/simple-icons/simple-icons), `icons/claude.svg` | CC0 1.0 | Anthropic |
| OpenAI (Codex) | simple-icons, `icons/openai.svg` | CC0 1.0 | OpenAI |
| OpenCode | `https://opencode.ai/favicon.svg` | — | SST (opencode.ai) |
| Приглашение оболочки | наше | — | — |

Знаки используются только для того, чтобы назвать соответствующий CLI (номинативное
использование); принадлежность и внешний вид не меняются, окраска — один цвет на метку.

## Сторонние пакеты с особенностями

- `playwright-core` (Apache-2.0) — только для `npm run e2e`, `e2e:blocks` и `e2e:zones`: управление окном Electron и снимки
- `ws` (MIT) — соединение с Google Chrome по DevTools Protocol. Сам Chrome не входит в проект:
  используется установленный у пользователя
- CodeMirror 6 (MIT) — редакторы кода, текста и markdown; `highlight.js` (BSD-3) — подсветка в блоке кода

CanvasTTY встраивает браузер через Electron `WebContentsView` — это Chromium внутри Electron.
У нас браузер — отдельный процесс установленного Google Chrome со скринкастом в карточку;
этот подход написан заново и в CanvasTTY не встречается.

- `@homebridge/node-pty-prebuilt-multiarch` (MIT) — форк node-pty на N-API с готовыми
  бинарниками. Сборка под Node подходит и Electron. На машине без Visual Studio Build Tools
  бинарник подтягивает `apps/desktop/scripts/ensure-pty.cjs`
- `@modelcontextprotocol/sdk` — низкоуровневый `Server` и Streamable HTTP транспорт
