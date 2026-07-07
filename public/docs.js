// Document mode: card catalog + Notion-style block editor.
// Talks to the board through window.App contracts (getCards/saveCard/...).
// Kept dependency-free and intentionally compact.

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const docsView = $("#docsView");
  const editorView = $("#editorView");
  const catalogEl = $("#docsCatalog");
  const blocksEl = $("#editorBlocks");
  const slashMenu = $("#slashMenu");
  const fmtBar = $("#fmtBar");

  const titleInput = $("#editorTitle");

  // Card header modal elements.
  const headerModal = $("#headerModal");
  const headerPreview = $("#headerPreview");
  const headerImageInput = $("#headerImageInput");
  const headerTitleInput = $("#headerTitle");
  const headerCaptionInput = $("#headerCaption");
  const headerFileInput = $("#headerFileInput");

  // Currently edited card + its parsed block list.
  let editing = null; // card element
  let blocks = []; // [{kind, text, checked?}]
  let slashState = null; // { blockIndex, query, selected }
  let editorReturnMode = "docs";
  let persistTimer = null;
  let persistDirty = false;

  const SLASH_ITEMS = [
    { kind: "text", glyph: "¶", label: "Текст", desc: "Параграф" },
    { kind: "h1", glyph: "H₁", label: "Заголовок 1", desc: "# " },
    { kind: "h2", glyph: "H₂", label: "Заголовок 2", desc: "## " },
    { kind: "h3", glyph: "H₃", label: "Заголовок 3", desc: "### " },
    { kind: "bullet", glyph: "•", label: "Маркированный", desc: "- " },
    { kind: "todo", glyph: "☐", label: "Задача", desc: "- [ ] " },
    { kind: "quote", glyph: "❝", label: "Цитата", desc: "> " },
    { kind: "code", glyph: "</>", label: "Код", desc: "```" },
    { kind: "table", glyph: "▦", label: "Таблица", desc: "| a | b |" },
    { kind: "image", glyph: "🖼", label: "Изображение", desc: "![](url)" },
    { kind: "divider", glyph: "—", label: "Разделитель", desc: "---" }
  ];

  const FMT_ACTIONS = [
    { cmd: "bold", label: "B", title: "Жирный", style: "font-weight:700" },
    { cmd: "italic", label: "I", title: "Курсив", style: "font-style:italic" },
    { cmd: "strikeThrough", label: "S", title: "Зачёркнутый", style: "text-decoration:line-through" },
    { cmd: "code", label: "</>", title: "Код", style: "font-family:monospace" },
    { cmd: "createLink", label: "🔗", title: "Ссылка" },
    { kind: "align", align: "left", label: "⯇", title: "По левому краю" },
    { kind: "align", align: "center", label: "≡", title: "По центру" },
    { kind: "align", align: "right", label: "⯈", title: "По правому краю" }
  ];

  function init() {
    $("#docsNewBtn").addEventListener("click", () => createNew());
    $("#editorBackBtn").addEventListener("click", () => commitAndExit());
    $("#editorSaveBtn").addEventListener("click", async () => { await saveEditing(true); flashSaved(); });
    $("#docsOpenFolderBtn").addEventListener("click", () => App().openInExplorer?.());
    $("#docsReloadBtn").addEventListener("click", () => App().reloadFromFolder?.());

    titleInput.addEventListener("input", () => { if (editing) { ensureMeta(editing).title = titleInput.value; schedulePersist(); } });

    $("#editorAddBtn").addEventListener("click", () => appendTextBlock());

    // Header modal wiring (Task 5: card header is edited in a popup).
    $("#editorHeaderBtn").addEventListener("click", () => openHeaderModal());
    $("#headerModalClose").addEventListener("click", () => closeHeaderModal());
    headerModal.addEventListener("mousedown", (e) => { if (e.target === headerModal) closeHeaderModal(); });
    $("#headerApply").addEventListener("click", () => { applyHeaderModal(); closeHeaderModal(); });
    $("#headerClear").addEventListener("click", () => { clearHeaderModal(); });
    headerImageInput.addEventListener("input", () => updateHeaderDraft());
    headerTitleInput.addEventListener("input", () => updateHeaderDraft());
    headerCaptionInput.addEventListener("input", () => updateHeaderDraft());
    $("#headerPickImg").addEventListener("click", () => headerFileInput.click());
    headerFileInput.addEventListener("change", () => uploadHeaderImage(headerFileInput.files?.[0]));
    setInterval(() => flushAutosave(), 5000);
    window.addEventListener("beforeunload", () => flushAutosave());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushAutosave();
    });

    // Slash menu keyboard navigation
    slashMenu.addEventListener("mousedown", (e) => {
      const item = e.target.closest(".slash-item");
      if (!item) return;
      e.preventDefault();
      applySlash(Number(item.dataset.index));
    });

    // Floating format bar (Task 3): react to text selection changes inside the editor.
    document.addEventListener("selectionchange", () => onSelectionChange());

    // Build the format bar buttons once.
    buildFmtBar();

    document.addEventListener("click", (e) => {
      // Hide slash menu on outside click; keep fmt bar (managed by selection).
      if (!slashMenu.contains(e.target)) hideSlash();
    });

    // Image paste/drop into the editor (Task 4). Pasted or dropped image files
    // become new image blocks inserted after the currently-focused block.
    blocksEl.addEventListener("paste", (e) => onEditorPaste(e));
    blocksEl.addEventListener("dragover", (e) => {
      if (Array.from(e.dataTransfer?.types || []).includes("Files")) {
        e.preventDefault();
      }
    });
    blocksEl.addEventListener("drop", (e) => onEditorDrop(e));
  }

  function currentBlockIndexFromEvent(e) {
    const row = e.target?.closest?.(".block-row");
    if (row) return Number(row.dataset.index);
    return blocks.length - 1;
  }

  async function ingestImageFiles(files, afterIndex) {
    let idx = afterIndex;
    for (const file of Array.from(files || [])) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const res = App().saveAssetFile ? await App().saveAssetFile(file) : await uploadRaw(file);
        if (res && res.url) {
          insertImageBlockAfter(idx, { url: res.url, alt: res.fileName || file.name || "" });
          idx += 1;
        }
      } catch {
        // skip a failed file, keep going with the rest
      }
    }
  }

  function onEditorPaste(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((it) => it.kind === "file" && it.type.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    const after = currentBlockIndexFromEvent(e);
    const files = imageItems.map((it) => it.getAsFile()).filter(Boolean);
    ingestImageFiles(files, after);
  }

  function onEditorDrop(e) {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    ingestImageFiles(files, currentBlockIndexFromEvent(e));
  }

  // ---------- floating format bar (Task 3) ----------
  function buildFmtBar() {
    fmtBar.innerHTML = "";
    for (const act of FMT_ACTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = act.title;
      btn.textContent = act.label;
      if (act.style) btn.setAttribute("style", act.style);
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep the selection alive
        runFmt(act);
      });
      fmtBar.append(btn);
    }
  }

  function onSelectionChange() {
    if (!editing) { fmtBar.hidden = true; return; }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { fmtBar.hidden = true; return; }
    // Only show when the selection is inside an editable block.
    const anchor = sel.anchorNode;
    const blockEl = anchor && (anchor.nodeType === 3 ? anchor.parentElement : anchor)?.closest?.(".block-content");
    if (!blockEl || !blocksEl.contains(blockEl)) { fmtBar.hidden = true; return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { fmtBar.hidden = true; return; }
    fmtBar.hidden = false;
    fmtBar.style.left = `${Math.max(8, rect.left + rect.width / 2 - fmtBar.offsetWidth / 2)}px`;
    fmtBar.style.top = `${Math.max(8, rect.top - fmtBar.offsetHeight - 8)}px`;
  }

  function runFmt(act) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    if (act.kind === "align") {
      const blockEl = (sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode)?.closest?.(".block-content");
      if (blockEl) { blockEl.style.textAlign = act.align; blockEl.dataset.align = act.align; syncBlockFromDom(blockEl); }
      return;
    }
    // Link needs a URL first; everything else wraps the selection directly.
    if (act.cmd === "createLink") {
      const url = prompt("Адрес ссылки:", "https://");
      if (!url) return;
      wrapSelectionInline("a", url);
    } else if (act.cmd === "code") {
      wrapSelectionInline("code");
    } else if (act.cmd === "bold") {
      wrapSelectionInline("strong");
    } else if (act.cmd === "italic") {
      wrapSelectionInline("em");
    } else if (act.cmd === "strikeThrough") {
      wrapSelectionInline("s");
    }
    // Persist inline changes: re-read the edited block from the DOM.
    const blockEl = (sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode)?.closest?.(".block-content");
    if (blockEl) syncBlockFromDom(blockEl);
    schedulePersist();
    onSelectionChange();
  }

  // Wrap the current selection in an inline element. For <a>, set href.
  // execCommand is deprecated/buggy across browsers, so this is done by hand.
  function wrapSelectionInline(tag, href) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const node = document.createElement(tag);
    if (href) node.setAttribute("href", href);
    try {
      node.appendChild(range.extractContents());
      range.insertNode(node);
      sel.removeAllRanges();
      const r = document.createRange();
      r.selectNodeContents(node);
      r.collapse(false);
      sel.addRange(r);
    } catch { /* ignore malformed selections */ }
  }

  // Read the edited block DOM back into the `blocks` model so inline formatting
  // (bold/italic/strike/code/link) survives serialize + reopen.
  function syncBlockFromDom(blockEl) {
    const row = blockEl.closest(".block-row");
    if (!row) return;
    const index = Number(row.dataset.index);
    const b = blocks[index];
    if (!b) return;
    if (b.kind === "table") return; // tables manage their own DOM
    const editable = editableNode(blockEl);
    b.html = editable.innerHTML;
    b.text = editable.textContent;
  }

  // ---------- integration helpers ----------
  const App = () => window.App;

  // ---------- catalog ----------

  function openCatalog() {
    commitAndExit(true);
    renderCatalog();
  }

  function renderCatalog() {
    const cards = App().getCards ? App().getCards() : [];
    const assets = App().getFolderAssets ? App().getFolderAssets() : [];
    const folderAssets = assets.filter((item) => item.meta?.sourceFile);
    catalogEl.innerHTML = "";

    const visibleCards = cards.filter((c) => !c.meta?.planeHidden);
    const hiddenCards = cards.filter((c) => c.meta?.planeHidden);
    const hasContent = visibleCards.length || hiddenCards.length || folderAssets.length;

    if (!hasContent) {
      const empty = document.createElement("div");
      empty.className = "doc-empty";
      empty.innerHTML = `<div>Пока нет документов и файлов.</div>`;
      const btn = document.createElement("button");
      btn.textContent = "Создать первую карточку";
      btn.addEventListener("click", createNew);
      empty.append(btn);
      catalogEl.append(empty);
      return;
    }

    if (visibleCards.length) {
      const section = document.createElement("section");
      section.className = "docs-section";
      section.innerHTML = `<h2 class="docs-section-title">Документы</h2>`;
      const grid = document.createElement("div");
      grid.className = "docs-catalog-grid";
      const sorted = visibleCards.slice().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
      for (const card of sorted) grid.append(renderDocCard(card));
      section.append(grid);
      catalogEl.append(section);
    }

    if (hiddenCards.length) {
      const section = document.createElement("section");
      section.className = "docs-section";
      section.innerHTML = `<h2 class="docs-section-title">Скрытые документы</h2>`;
      const grid = document.createElement("div");
      grid.className = "docs-catalog-grid";
      for (const card of hiddenCards) grid.append(renderDocCard(card));
      section.append(grid);
      catalogEl.append(section);
    }

    if (folderAssets.length) {
      const section = document.createElement("section");
      section.className = "docs-section";
      section.innerHTML = `<h2 class="docs-section-title">Файлы из папки</h2>`;
      const grid = document.createElement("div");
      grid.className = "docs-catalog-grid";
      const sorted = folderAssets.slice().sort((a, b) => {
        const an = a.meta?.sourceFile || a.text || "";
        const bn = b.meta?.sourceFile || b.text || "";
        return an.localeCompare(bn);
      });
      for (const asset of sorted) grid.append(renderFolderAsset(asset));
      section.append(grid);
      catalogEl.append(section);
    }
  }

  function renderFolderAsset(item) {
    const node = document.createElement("article");
    node.className = "doc-card doc-asset";
    const meta = item.meta || {};
    const name = meta.sourceFile || meta.fileName || item.text || (item.type === "image" ? "Изображение" : "Файл");
    let html = "";
    if (item.type === "image" && item.url) {
      html += `<img class="dc-img" alt="" src="${escAttr(item.url)}" onerror="this.style.display='none'">`;
    }
    html += `<div class="dc-body">`;
    html += `<div class="dc-title">${escHtml(item.type === "image" ? "🖼 " : "📎 ")}${escHtml(name)}</div>`;
    if (item.type === "file" && meta.extension) {
      html += `<div class="dc-caption">.${escHtml(meta.extension)}</div>`;
    }
    if (item.meta?.planeHidden) {
      html += `<div class="dc-caption">Скрыто с плоскости</div>`;
    }
    html += `<div class="dc-meta"><span class="dc-actions">`;
    if (item.type === "file") {
      html += `<button title="Открыть файл" data-act="open-file">↗</button>`;
    }
    html += item.meta?.planeHidden
      ? `<button title="Показать на плоскости" data-act="show">👁</button>`
      : `<button title="Скрыть с плоскости" data-act="hide">🙈</button>`;
    html += `</span></div></div>`;
    node.innerHTML = html;
    const imgEl = node.querySelector(".dc-img");
    if (imgEl && item.url) {
      imgEl.addEventListener("click", (event) => {
        event.stopPropagation();
        openImageLightbox(item.url, name);
      });
    }
    $$("button[data-act]", node).forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "show") App().setPlaneHidden?.(item.id, false);
        else if (act === "hide") App().setPlaneHidden?.(item.id, true);
        else if (act === "open-file" && App().openAsset) App().openAsset(item.id);
      });
    });
    if (item.type === "image") {
      node.addEventListener("click", () => {
        if (item.meta?.planeHidden) App().setPlaneHidden?.(item.id, false);
      });
    }
    return node;
  }

  function renderDocCard(card) {
    const node = document.createElement("article");
    node.className = "doc-card";
    const meta = card.meta || {};
    const hasHeader = meta.image || meta.title || meta.caption;
    let html = "";
    if (meta.image) html += `<img class="dc-img" alt="" src="${escAttr(meta.image)}" onerror="this.style.display='none'">`;
    html += `<div class="dc-body">`;
    if (meta.title) html += `<div class="dc-title">${escHtml(meta.title)}</div>`;
    if (meta.caption) html += `<div class="dc-caption">${escHtml(meta.caption)}</div>`;
    if (!hasHeader) {
      // no header -> show markdown preview as primary content
      html += `<div class="dc-preview doc-md">${previewHtml(card.text)}</div>`;
    } else {
      html += `<div class="dc-preview doc-md">${previewHtml(card.text)}</div>`;
    }
    html += `<div class="dc-meta">
      <span class="dc-date">${fmtDate(card.updatedAt || card.createdAt)}</span>
      <span class="dc-actions">
        <button title="Открыть" data-act="open">✎</button>
        ${card.meta?.planeHidden ? `<button title="Показать на плоскости" data-act="show">👁</button>` : `<button title="Скрыть с плоскости" data-act="hide">🙈</button>`}
        <button title="Удалить" data-act="del">🗑</button>
      </span>
    </div></div>`;
    node.innerHTML = html;
    const imgEl = node.querySelector(".dc-img");
    if (imgEl && meta.image) {
      imgEl.addEventListener("click", (event) => {
        event.stopPropagation();
        openImageLightbox(meta.image, meta.title || "");
      });
    }
    node.addEventListener("click", () => openEditor(card));
    $$('button[data-act]', node).forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "open") openEditor(card);
        else if (act === "hide") App().setPlaneHidden?.(card.id, true);
        else if (act === "show") App().setPlaneHidden?.(card.id, false);
        else if (act === "del") deleteCard(card);
      });
    });
    return node;
  }

  function createNew() {
    const card = App().createCard();
    openEditor(card);
  }

  function deleteCard(card) {
    if (!confirm(`Удалить карточку «${card.meta?.title || "Без названия"}»?`)) return;
    App().deleteCard(card.id);
    if (editing && editing.id === card.id) { editing = null; }
    renderCatalog();
  }

  // ---------- editor ----------

  function openEditor(card) {
    editing = card;
    ensureMeta(editing);
    const currentMode = App().getMode ? App().getMode() : "docs";
    if (currentMode !== "editor") editorReturnMode = currentMode;
    blocks = md.parse(card.text || "");
    titleInput.value = card.meta?.title || "";
    renderBlocks();
    App().setMode("editor");
    // focus first block
    setTimeout(() => focusBlock(blocks.length - 1, "end"), 0);
  }

  function renderBlocks() {
    blocksEl.innerHTML = "";
    blocks.forEach((block, index) => blocksEl.append(renderBlockRow(block, index)));
  }

  function renderBlockRow(block, index) {
    const row = document.createElement("div");
    row.className = "block-row";
    row.dataset.index = String(index);

    const grip = document.createElement("button");
    grip.className = "block-grip";
    grip.type = "button";
    grip.tabIndex = -1;
    grip.title = "Переместить: Alt+↑/↓, удалить: пустой Backspace";
    grip.textContent = "⋮⋮";

    const content = document.createElement("div");
    content.className = "block-content";
    content.dataset.kind = block.kind;
    content.spellcheck = false;
    content.setAttribute("role", "textbox");
    if (block.align) { content.style.textAlign = block.align; content.dataset.align = block.align; }

    if (block.kind === "divider") {
      content.contentEditable = "false";
    } else if (block.kind === "table") {
      content.append(renderTable(block, index));
    } else if (block.kind === "image") {
      content.contentEditable = "false";
      content.append(renderImageBlock(block, index));
    } else if (block.kind === "todo") {
      content.contentEditable = "false";
      const box = document.createElement("span");
      box.className = "checkbox" + (block.checked ? " checked" : "");
      box.title = "Отметить";
      box.addEventListener("mousedown", (e) => { e.preventDefault(); toggleTodo(index); });
      const text = document.createElement("span");
      text.className = "todo-text";
      text.contentEditable = "true";
      text.spellcheck = false;
      // prefer saved inline HTML, fall back to plain text
      if (block.html) text.innerHTML = block.html;
      else text.textContent = block.text || "";
      text.dataset.role = "text";
      content.classList.toggle("done", !!block.checked);
      content.append(box, text);
    } else if (block.kind === "bullet") {
      content.contentEditable = "false";
      const text = document.createElement("span");
      text.className = "bullet-text";
      text.contentEditable = "true";
      text.spellcheck = false;
      if (block.html) text.innerHTML = block.html;
      else text.textContent = block.text || "";
      text.dataset.role = "text";
      content.append(text);
    } else {
      content.contentEditable = "true";
      if (block.html) content.innerHTML = block.html;
      else content.textContent = block.text || "";
    }

    wireBlockEvents(row, content, index);
    row.append(grip, content);

    // "Add block between" handle (Task 2): a thin + that appears on hover below
    // each row, inserting a new text block right after it.
    const addBetween = document.createElement("button");
    addBetween.type = "button";
    addBetween.className = "block-add-between";
    addBetween.title = "Добавить блок ниже";
    addBetween.textContent = "＋";
    addBetween.addEventListener("click", () => insertEmptyAfter(index));
    row.append(addBetween);

    return row;
  }

  // ---------- table blocks (Task 4) ----------
  // A table block stores its grid as block.rows = [["a","b"],["c","d"]]. The
  // editor renders a real <table contenteditable> with trailing add-row/add-col
  // controls; the markdown layer serializes it as a GFM table.
  function renderTable(block, index) {
    const wrap = document.createElement("div");
    wrap.className = "table-block";
    const rows = Array.isArray(block.rows) && block.rows.length ? block.rows : [["Заголовок", "Значение"], ["", ""]];
    block.rows = rows;
    const table = document.createElement("table");
    table.setAttribute("contenteditable", "true");
    table.spellcheck = false;
    // tag the table as the editable node so wireBlockEvents binds to it
    table.dataset.role = "text";
    const renderRow = (cells, isHeader) => {
      const tr = document.createElement("tr");
      cells.forEach((cell, ci) => {
        const td = document.createElement(isHeader ? "th" : "td");
        td.textContent = cell == null ? "" : String(cell);
        td.addEventListener("input", () => { syncTable(block); schedulePersist(); });
        tr.append(td);
      });
      return tr;
    };
    table.append(renderRow(rows[0], true));
    for (let r = 1; r < rows.length; r++) table.append(renderRow(rows[r], false));
    table.addEventListener("input", () => { syncTable(block); schedulePersist(); });

    const controls = document.createElement("div");
    controls.className = "table-controls";
    const addRow = document.createElement("button");
    addRow.type = "button";
    addRow.textContent = "+ строка";
    addRow.addEventListener("click", () => { block.rows.push(rows[0].map(() => "")); rerenderBlock(index, "keep"); schedulePersist(); });
    const addCol = document.createElement("button");
    addCol.type = "button";
    addCol.textContent = "+ столбец";
    addCol.addEventListener("click", () => { block.rows.forEach((r) => r.push("")); rerenderBlock(index, "keep"); schedulePersist(); });
    const delRow = document.createElement("button");
    delRow.type = "button";
    delRow.textContent = "− строка";
    delRow.addEventListener("click", () => { if (block.rows.length > 1) { block.rows.pop(); rerenderBlock(index, "keep"); schedulePersist(); } });
    const delCol = document.createElement("button");
    delCol.type = "button";
    delCol.textContent = "− столбец";
    delCol.addEventListener("click", () => { if (block.rows[0].length > 1) { block.rows.forEach((r) => r.pop()); rerenderBlock(index, "keep"); schedulePersist(); } });
    controls.append(addRow, addCol, delRow, delCol);

    wrap.append(table, controls);
    return wrap;
  }

  // Read the rendered table back into block.rows by walking the live <td>/<th>.
  function syncTable(block) {
    const row = blocksEl.querySelector(`.block-row[data-index]`);
    // find the row whose table-block matches this block by reference order:
    // table blocks are rare, so locate the table element via the block index.
    const idx = blocks.indexOf(block);
    const blockRow = blocksEl.querySelector(`.block-row[data-index="${idx}"]`);
    if (!blockRow) return;
    const table = blockRow.querySelector("table");
    if (!table) return;
    const rows = [];
    for (const tr of table.querySelectorAll("tr")) {
      const cells = Array.from(tr.querySelectorAll("th,td")).map((c) => c.textContent);
      rows.push(cells);
    }
    block.rows = rows;
  }

  // ---------- image blocks (Task 4) ----------
  // An image block stores { kind: "image", url, alt, title }. The editor renders
  // a preview plus upload/replace/remove controls. Pasting or dropping an image
  // file inserts a new image block right after the current one.
  function renderImageBlock(block, index) {
    const wrap = document.createElement("div");
    wrap.className = "image-block";
    if (block.url) {
      const img = document.createElement("img");
      img.className = "image-block-img";
      img.src = block.url;
      img.alt = block.alt || "";
      if (block.title) img.title = block.title;
      img.addEventListener("click", () => openImageLightbox(block.url, block.alt || block.title || ""));
      wrap.append(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "image-block-empty";
      placeholder.textContent = "Изображение не задано";
      wrap.append(placeholder);
    }
    const controls = document.createElement("div");
    controls.className = "image-block-controls";
    const upload = document.createElement("button");
    upload.type = "button";
    upload.textContent = block.url ? "Заменить файл" : "📎 Загрузить файл";
    upload.addEventListener("click", () => pickImageFile((file) => uploadImageBlockFile(block, file, index)));
    const urlBtn = document.createElement("button");
    urlBtn.type = "button";
    urlBtn.textContent = "Ссылка";
    urlBtn.title = "Вставить изображение по URL";
    urlBtn.addEventListener("click", () => {
      const url = prompt("Адрес изображения:", block.url || "https://");
      if (url == null) return;
      block.url = url.trim();
      block.alt = block.alt || "";
      rerenderBlock(index, "keep");
      schedulePersist();
    });
    const altBtn = document.createElement("button");
    altBtn.type = "button";
    altBtn.textContent = "Описание";
    altBtn.title = "Подпись (alt)";
    altBtn.addEventListener("click", () => {
      const alt = prompt("Описание (alt):", block.alt || "");
      if (alt == null) return;
      block.alt = alt;
      rerenderBlock(index, "keep");
      schedulePersist();
    });
    controls.append(upload, urlBtn, altBtn);
    wrap.append(controls);
    return wrap;
  }

  function pickImageFile(cb) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) cb(file);
    });
    input.click();
  }

  async function uploadImageBlockFile(block, file, index) {
    try {
      const res = App().saveAssetFile ? await App().saveAssetFile(file) : await uploadRaw(file);
      if (res && res.url) {
        block.url = res.url;
        if (!block.alt) block.alt = (res.fileName || file.name || "").replace(/\.[^.]+$/, "");
        rerenderBlock(index, "keep");
        schedulePersist();
      } else {
        alert("Не удалось сохранить изображение.");
      }
    } catch {
      alert("Ошибка загрузки изображения.");
    }
  }

  // Fallback upload when running on the server board (no folder handle).
  function uploadRaw(file) {
    const fd = new FormData();
    fd.append("file", file);
    return fetch("/api/upload", { method: "POST", body: fd }).then((r) => r.json());
  }

  // Insert a new image block after `index`, using an already-resolved url.
  function insertImageBlockAfter(index, { url, alt = "", fileName = "" }) {
    blocks.splice(index + 1, 0, { kind: "image", url, alt: alt || fileName || "", title: "" });
    renderBlocks();
    focusBlock(index + 1, "keep");
    schedulePersist();
  }

  function textNode(row) {
    const role = row.querySelector('[data-role="text"]');
    return role || row.querySelector(".block-content");
  }

  // The editable node lives inside `content` (a span for todo/bullet, the
  // content div itself otherwise). Resolve it from `content` rather than the
  // row, because renderBlockRow wires events *before* appending content to row
  // — at which point row.querySelector would still return null.
  function editableNode(content) {
    return content.querySelector('[data-role="text"]') || content;
  }

  function wireBlockEvents(row, content, index) {
    const editable = editableNode(content);

    editable.addEventListener("input", () => onBlockInput(index, editable));
    editable.addEventListener("keydown", (e) => onBlockKeydown(e, index, editable));
    editable.addEventListener("blur", () => { hideSlash(); setActive(index, false); });
    editable.addEventListener("focus", () => setActive(index, true));
  }

  function setActive(index, on) {
    const row = blocksEl.querySelector(`.block-row[data-index="${index}"]`);
    if (row) row.classList.toggle("active", on);
  }

  function onBlockInput(index, editable) {
    const block = blocks[index];
    if (!block) return;
    // Persist both the plain text (for shortcuts/serialization fallback) and
    // the rich HTML (so inline formatting survives round-trips).
    block.text = editable.textContent;
    block.html = editable.innerHTML;
    const value = editable.textContent;

    // slash menu trigger when "/" is the first char
    if (value.startsWith("/")) {
      showSlash(index, value.slice(1));
    } else {
      hideSlash();
      // markdown shortcuts on the fly (only at start)
      maybeConvertShortcut(index, value);
    }
  }

  function maybeConvertShortcut(index, value) {
    const block = blocks[index];
    const m = value.match(/^(#{1,3})\s(.*)$/);
    if (m) return setBlockKind(index, "h" + m[1].length, m[2]);
    if (/^>\s(.*)$/.test(value)) return setBlockKind(index, "quote", value.replace(/^>\s/, ""));
    const todo = value.match(/^-\s+\[([ xX])\]\s?(.*)$/);
    if (todo) return setTodoKind(index, todo[1].toLowerCase() === "x", todo[2]);
    if (/^-\s+(.*)$/.test(value)) return setBlockKind(index, "bullet", value.replace(/^-\s+/, ""));
    if (/^```/.test(value)) return setBlockKind(index, "code", value.replace(/^`+/, "").replace(/^\n/, ""));
    if (/^---+$/.test(value.trim())) return setBlockKind(index, "divider", "");
  }

  function setBlockKind(index, kind, text) {
    const prev = blocks[index] || {};
    const next = { kind, text, checked: undefined };
    // preserve alignment across kind changes
    if (prev.align) next.align = prev.align;
    delete next.checked;
    blocks[index] = next;
    rerenderBlock(index, "end");
    schedulePersist();
  }

  function setTodoKind(index, checked, text) {
    blocks[index] = { kind: "todo", checked, text };
    rerenderBlock(index, "end");
    schedulePersist();
  }

  function toggleTodo(index) {
    const b = blocks[index];
    if (!b || b.kind !== "todo") return;
    b.checked = !b.checked;
    rerenderBlock(index, "keep");
    schedulePersist();
  }

  function rerenderBlock(index, caret) {
    const oldRow = blocksEl.querySelector(`.block-row[data-index="${index}"]`);
    if (!oldRow) return;
    const newRow = renderBlockRow(blocks[index], index);
    oldRow.replaceWith(newRow);
    focusBlock(index, caret);
  }

  function onBlockKeydown(e, index, editable) {
    // slash menu navigation
    if (slashState && slashState.blockIndex === index) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveSlash(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveSlash(-1); return; }
      if (e.key === "Enter") { e.preventDefault(); applySlash(slashState.selected); return; }
      if (e.key === "Escape") { hideSlash(); return; }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const b = blocks[index];
      // Tables: plain Enter inserts a new block after the table (not a new row);
      // use the +строка control to add rows.
      if (b.kind === "table") {
        blocks.splice(index + 1, 0, { kind: "text", text: "" });
        renderBlocks();
        focusBlock(index + 1, "start");
        schedulePersist();
        return;
      }
      // empty bullet/todo -> convert to text (Notion behaviour)
      if ((b.kind === "bullet" || b.kind === "todo") && !(b.text || "").trim()) {
        setBlockKind(index, "text", "");
        return;
      }
      // insert a new block; lists continue, code does not
      const nextKind = (b.kind === "bullet") ? "bullet" : (b.kind === "todo" ? "todo" : "text");
      const next = { kind: nextKind, text: "" };
      if (nextKind === "todo") next.checked = false;
      blocks.splice(index + 1, 0, next);
      renderBlocks();
      focusBlock(index + 1, "start");
      schedulePersist();
      return;
    }

    if (e.key === "Backspace") {
      const text = editable.textContent;
      const atStart = caretOffset(editable) === 0;
      if (text === "" && atStart && blocks.length > 1) {
        e.preventDefault();
        blocks.splice(index, 1);
        renderBlocks();
        focusBlock(Math.max(0, index - 1), "end");
        schedulePersist();
        return;
      }
      // backspace at start of non-text block -> demote to text
      if (atStart && blocks[index].kind !== "text") {
        e.preventDefault();
        setBlockKind(index, "text", blocks[index].text || "");
        return;
      }
    }

    if (e.key === "ArrowUp" && caretOffset(editable) === 0) {
      e.preventDefault();
      focusBlock(index - 1, "end");
      return;
    }
    if (e.key === "ArrowDown" && caretAtEnd(editable)) {
      e.preventDefault();
      focusBlock(index + 1, "end");
      return;
    }

    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const dir = e.key === "ArrowUp" ? -1 : 1;
      const target = index + dir;
      if (target >= 0 && target < blocks.length) {
        e.preventDefault();
        [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
        renderBlocks();
        focusBlock(target, "keep");
        schedulePersist();
      }
    }
  }

  function focusBlock(index, caret) {
    if (index < 0 || index >= blocks.length) return;
    const row = blocksEl.querySelector(`.block-row[data-index="${index}"]`);
    if (!row) return;
    const node = textNode(row);
    node.focus();
    placeCaret(node, caret);
  }

  function appendTextBlock() {
    blocks.push({ kind: "text", text: "" });
    renderBlocks();
    focusBlock(blocks.length - 1, "start");
    schedulePersist();
  }

  // Insert an empty text block after the given index (Task 2 "+" between blocks).
  function insertEmptyAfter(index) {
    blocks.splice(index + 1, 0, { kind: "text", text: "" });
    renderBlocks();
    focusBlock(index + 1, "start");
    schedulePersist();
  }

  // ---------- slash menu ----------

  function showSlash(blockIndex, query) {
    slashState = { blockIndex, query, selected: 0 };
    const items = SLASH_ITEMS.filter((it) => !query || (it.label + " " + it.kind).toLowerCase().includes(query.toLowerCase()));
    slashMenu.innerHTML = "";
    if (!items.length) { hideSlash(); return; }
    items.forEach((it, i) => {
      const node = document.createElement("div");
      node.className = "slash-item" + (i === 0 ? " selected" : "");
      node.dataset.index = String(i);
      node.innerHTML = `<span class="slash-glyph">${it.glyph}</span><span>${escHtml(it.label)}</span><span class="slash-desc">${escHtml(it.desc)}</span>`;
      slashMenu.append(node);
    });
    slashState.items = items;
    positionSlash(blockIndex);
    slashMenu.hidden = false;
  }

  function positionSlash(blockIndex) {
    const row = blocksEl.querySelector(`.block-row[data-index="${blockIndex}"]`);
    if (!row) return;
    const r = row.getBoundingClientRect();
    slashMenu.style.left = `${r.left + 24}px`;
    slashMenu.style.top = `${r.bottom + 4}px`;
  }

  function moveSlash(dir) {
    if (!slashState) return;
    slashState.selected = (slashState.selected + dir + slashState.items.length) % slashState.items.length;
    $$(".slash-item", slashMenu).forEach((n, i) => n.classList.toggle("selected", i === slashState.selected));
  }

  function applySlash(i) {
    if (!slashState || !slashState.items[i]) return;
    const item = slashState.items[i];
    if (item.kind === "table") {
      blocks[slashState.blockIndex] = {
        kind: "table",
        rows: [["Заголовок", "Значение"], ["", ""]]
      };
      rerenderBlock(slashState.blockIndex, "keep");
      schedulePersist();
    } else if (item.kind === "image") {
      blocks[slashState.blockIndex] = { kind: "image", url: "", alt: "", title: "" };
      rerenderBlock(slashState.blockIndex, "keep");
      schedulePersist();
      // immediately prompt for a file so the user doesn't have to hunt for the button
      pickImageFile((file) => uploadImageBlockFile(blocks[slashState.blockIndex], file, slashState.blockIndex));
    } else {
      setBlockKind(slashState.blockIndex, item.kind, "");
    }
    hideSlash();
  }

  function hideSlash() {
    slashMenu.hidden = true;
    slashState = null;
  }

  // ---------- persistence ----------

  function schedulePersist() {
    persistDirty = true;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(saveEditing, 400);
  }

  function flushAutosave() {
    if (!editing || !persistDirty) return Promise.resolve(null);
    return saveEditing(true);
  }

  function ensureMeta(card) {
    if (!card.meta || typeof card.meta !== "object") card.meta = {};
    card.meta.title = card.meta.title || "";
    card.meta.caption = card.meta.caption || "";
    card.meta.image = card.meta.image || "";
    return card.meta;
  }

  function syncAllTables() {
    blocks.forEach((block) => {
      if (block.kind === "table") syncTable(block);
    });
  }

  function saveEditing(immediate = false) {
    if (!editing) return Promise.resolve(null);
    clearTimeout(persistTimer);
    persistTimer = null;
    persistDirty = false;
    syncAllTables();
    const meta = ensureMeta(editing);
    editing.text = md.toMarkdown(blocks);
    meta.title = titleInput.value.trim();
    // caption/image are now edited in the header modal and stored directly on
    // editing.meta — don't clobber them from the (removed) inline inputs.
    if (App().saveCard) return Promise.resolve(App().saveCard(editing, { immediate }));
    return Promise.resolve(null);
  }

  async function commitAndExit(silent = false) {
    if (!editing) return;
    const targetMode = editorReturnMode || "docs";
    await saveEditing(true);
    editing = null;
    blocks = [];
    hideSlash();
    if (!silent) App().setMode(targetMode);
    editorReturnMode = "docs";
  }

  function flashSaved() {
    // reuse app sync label if present
    const label = document.querySelector("#syncLabel");
    if (!label) return;
    const prev = label.textContent;
    label.textContent = "Saved";
    setTimeout(() => { label.textContent = prev; }, 800);
  }

  // ---------- card header modal (Task 5) ----------

  function openHeaderModal() {
    if (!editing) return;
    saveEditing(true);
    const meta = ensureMeta(editing);
    headerTitleInput.value = meta.title || "";
    headerCaptionInput.value = meta.caption || "";
    headerImageInput.value = meta.image || "";
    updateHeaderPreview();
    headerModal.hidden = false;
    headerTitleInput.focus();
  }

  function closeHeaderModal() {
    headerModal.hidden = true;
    headerFileInput.value = "";
  }

  function readHeaderModal() {
    return {
      title: headerTitleInput.value.trim(),
      caption: headerCaptionInput.value.trim(),
      image: headerImageInput.value.trim()
    };
  }

  function updateHeaderDraft(options = {}) {
    updateHeaderPreview();
    if (!editing) return;
    const vals = readHeaderModal();
    const previousImage = editing.meta?.image || "";
    editing.meta = { ...ensureMeta(editing), ...vals };
    if (!vals.image || vals.image !== previousImage) delete editing.meta.imageFile;
    titleInput.value = vals.title;
    if (options.immediate) saveEditing(true);
    else schedulePersist();
  }

  function applyHeaderModal() {
    if (!editing) return;
    updateHeaderDraft({ immediate: true });
  }

  function clearHeaderModal() {
    headerTitleInput.value = "";
    headerCaptionInput.value = "";
    headerImageInput.value = "";
    updateHeaderPreview();
    applyHeaderModal();
  }

  function updateHeaderPreview() {
    const { image, title, caption } = readHeaderModal();
    headerPreview.innerHTML = "";
    if (image) {
      const img = document.createElement("img");
      img.src = image;
      img.alt = "";
      img.onerror = () => { img.style.display = "none"; };
      headerPreview.append(img);
    }
    const text = document.createElement("div");
    text.className = "header-preview-text";
    if (title) { const t = document.createElement("div"); t.className = "hp-title"; t.textContent = title; text.append(t); }
    if (caption) { const c = document.createElement("div"); c.className = "hp-caption"; c.textContent = caption; text.append(c); }
    if (!image && !title && !caption) text.textContent = "Шапка пуста — на холсте будет показан контент.";
    headerPreview.append(text);
  }

  // Upload the picked file to the server and put the returned URL into the field.
  function uploadHeaderImage(file) {
    if (!file) return;
    if (App().saveAssetFile) {
      const btn = $("#headerPickImg");
      const prev = btn.textContent;
      btn.disabled = true; btn.textContent = "Загрузка...";
      App().saveAssetFile(file)
        .then((res) => {
          if (res && res.url) {
            headerImageInput.value = res.url;
            if (editing) {
              const meta = ensureMeta(editing);
              meta.image = res.url;
              meta.imageFile = res.fileName;
              schedulePersist();
            }
            updateHeaderPreview();
          } else {
            alert("Не удалось сохранить изображение в папку.");
          }
        })
        .catch(() => alert("Ошибка сохранения изображения."))
        .finally(() => { btn.disabled = false; btn.textContent = prev; headerFileInput.value = ""; });
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    const btn = $("#headerPickImg");
    const prev = btn.textContent;
    btn.disabled = true; btn.textContent = "Загрузка…";
    fetch("/api/upload", { method: "POST", body: fd })
      .then((r) => r.json())
      .then((res) => {
        if (res && res.url) {
          headerImageInput.value = res.url;
          if (editing) {
            const meta = ensureMeta(editing);
            meta.image = res.url;
            meta.imageFile = res.filename || "";
            schedulePersist();
          }
          updateHeaderPreview();
        } else {
          alert("Не удалось загрузить изображение.");
        }
      })
      .catch(() => alert("Ошибка загрузки изображения."))
      .finally(() => { btn.disabled = false; btn.textContent = prev; headerFileInput.value = ""; });
  }

  // ---------- helpers ----------

  function previewHtml(mdText) {
    // clamp length so the catalog preview stays cheap
    const text = String(mdText || "");
    return md.markdownToHtml(text.length > 1200 ? text.slice(0, 1200) + "…" : text);
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString();
  }

  function escHtml(s) {
    return md.escapeHtml(s);
  }
  function escAttr(s) {
    return String(s == null ? "" : s).replace(/"/g, "&quot;");
  }

  function ensureImageLightbox() {
    let overlay = $("#imageLightbox");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "imageLightbox";
    overlay.className = "image-lightbox";
    overlay.innerHTML = `<button type="button" class="image-lightbox-close" aria-label="Закрыть">×</button><img alt=""><div class="image-lightbox-caption"></div>`;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay || event.target.classList.contains("image-lightbox-close")) closeImageLightbox();
    });
    document.body.append(overlay);
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeImageLightbox();
    });
    return overlay;
  }

  function openImageLightbox(url, caption = "") {
    if (!url) return;
    const overlay = ensureImageLightbox();
    overlay.querySelector("img").src = url;
    overlay.querySelector(".image-lightbox-caption").textContent = caption || "";
    overlay.classList.add("open");
  }

  function closeImageLightbox() {
    const overlay = $("#imageLightbox");
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.querySelector("img").removeAttribute("src");
  }

  // caret helpers
  function caretOffset(node) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return 0;
    const range = sel.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(node);
    pre.setEnd(range.endContainer, range.endOffset);
    return pre.toString().length;
  }
  function caretAtEnd(node) {
    return caretOffset(node) >= (node.textContent || "").length;
  }
  function placeCaret(node, mode) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    if (mode === "start") range.collapse(true);
    else if (mode === "end" || mode === "keep") range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // public API used by app.js
  window.Docs = { init, openCatalog, openEditor, renderCatalog };
  document.addEventListener("DOMContentLoaded", init);
})();
