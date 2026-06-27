# Codex Miro

Легковесная локальная whiteboard-доска без фронтенд-сборки и без базы данных. Данные лежат в одном JSON-файле, поэтому веб-интерфейс, REST API и MCP-сервер работают с одним состоянием.

## Возможности

- Фигуры: прямоугольник, эллипс, ромб, sticky note, frame, **карточка**.
- Карточки — markdown-документы; на холсте видны в маленьком масштабе, по двойному клику открывается блочный Notion-style редактор.
- Шапка карточки: название, картинка и подпись. Если шапка настроена, на холсте показывается она, а не содержимое.
- Каталог документов (режим «Документы»): просмотр и редактирование всех карточек.
- Экспорт карточек: одна — в `.md` (с YAML frontmatter), все — в `.zip` с `.md` файлами.
- Множественный выбор: рамка (rubber-band) на пустом холсте, Shift-клик, выделение нескольких объектов для перемещения/стиля/удаления.
- Текстовые блоки с быстрым редактированием.
- Линии, стрелки и свободное рисование.
- Изображения через вставку файла в браузере.
- Выбор, перемещение, изменение размера, удаление, копирование, undo/redo.
- Панорамирование, zoom, сетка, импорт/экспорт JSON и экспорт SVG.
- REST API для локальной автоматизации.
- MCP stdio-сервер для агентов: чтение, поиск, создание, правка и удаление элементов и карточек.

## Запуск веб-доски

```bash
docker compose up --build
```

Откройте:

```text
http://localhost:8080
```

## Подключение MCP

MCP-сервер использует тот же Docker volume `codex_miro_board_data`, что и веб-доска.

Пример конфигурации MCP-клиента:

```json
{
  "mcpServers": {
    "codex-miro": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-v",
        "codex_miro_board_data:/app/data",
        "codex-miro:local",
        "node",
        "src/mcp.js"
      ]
    }
  }
}
```

Перед подключением MCP один раз соберите образ через `docker compose up --build`.

## REST API

- `GET /api/board` - текущая доска.
- `PUT /api/board` - заменить доску целиком.
- `POST /api/elements` - создать элемент.
- `PATCH /api/elements/:id` - частично обновить элемент.
- `DELETE /api/elements/:id` - удалить элемент.
- `POST /api/reset` - очистить доску.
- `GET /api/events` - SSE-уведомления об изменениях.

## MCP tools

- `get_board`
- `set_board`
- `list_elements`
- `get_element`
- `create_element`
- `update_element`
- `delete_element`
- `list_cards` — список всех карточек с шапкой и коротким превью markdown.
- `get_card` — одна карточка целиком (с полным markdown-телом).
- `create_card` — создать карточку (`markdown` + опционально `title`/`caption`/`image`/`x`/`y`/`width`/`height`/`id`).
- `update_card` — частично обновить тело и/или шапку карточки (передаются только нужные поля).
- `delete_card` — удалить карточку по id.
- `clear_board`
- `search_text`
- `select_in_area` — выделить все объекты, пересекающие прямоугольную область (`x`/`y`/`width`/`height`, `mode`: `intersect` по умолчанию или `contain`). Выделение сохраняется на доске в `board.selectedIds`.
- `create_connector` - поддерживает координаты `x1/y1/x2/y2` и привязки `startElementId/startAnchor/endElementId/endAnchor`.

Типы элементов: `rect`, `ellipse`, `diamond`, `sticky`, `text`, `frame`, `line`, `arrow`, `pen`, `image`, `card`.

Якоря для коннекторов: `nw`, `n`, `ne`, `e`, `se`, `s`, `sw`, `w`, `c`.
