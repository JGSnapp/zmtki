// Sticker packs + quick access (Task 6).
//
// A sticker pack = { id, name, builtIn: boolean, stickers: [{ id, url, label }] }.
// The catalog lives in localStorage so it survives reloads; built-in packs are
// seeded once and can be removed like any user pack (their removal is also
// remembered so they don't reappear).
//
// Placing a sticker on the plane goes through window.App.placeSticker(url, meta),
// which creates a `sticker` element at the screen center (or the drop point).

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const App = () => window.App;

  const STORAGE_KEY = "zmtki-sticker-packs-v1";
  const FAV_STORAGE_KEY = "zmtki-sticker-favs-v1";
  const REMOVED_BUILTIN_KEY = "zmtki-sticker-removed-builtin-v1";

  // ----- built-in packs (SVG data URIs, no network) -----
  // Each built-in sticker is a small inline SVG so the app works fully offline.
  function emojiSvg(emoji, bg = "#fff4d6") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <rect width="128" height="128" rx="20" fill="${bg}"/>
      <text x="64" y="86" font-size="76" text-anchor="middle">${emoji}</text>
    </svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  const BUILTIN_PACKS = [
    {
      id: "builtin-smileys",
      name: "Смайлы",
      builtIn: true,
      stickers: ["😀", "😂", "😍", "😎", "🤔", "😭", "😡", "👍", "🙏"].map((e, i) => ({
        id: `smiley-${i}`,
        url: emojiSvg(e),
        label: e
      }))
    },
    {
      id: "builtin-arrows",
      name: "Стрелки/метки",
      builtIn: true,
      stickers: [
        { id: "arr-up", label: "↑", svg: `<text x="64" y="92" font-size="90" text-anchor="middle" fill="#0f766e">↑</text>` },
        { id: "arr-down", label: "↓", svg: `<text x="64" y="92" font-size="90" text-anchor="middle" fill="#b42318">↓</text>` },
        { id: "arr-right", label: "→", svg: `<text x="64" y="92" font-size="90" text-anchor="middle" fill="#0f766e">→</text>` },
        { id: "arr-left", label: "←", svg: `<text x="64" y="92" font-size="90" text-anchor="middle" fill="#0f766e">←</text>` },
        { id: "mk-star", label: "★", svg: `<text x="64" y="92" font-size="90" text-anchor="middle" fill="#f59e0b">★</text>` },
        { id: "mk-q", label: "?", svg: `<text x="64" y="92" font-size="90" text-anchor="middle" fill="#7c3aed">?</text>` },
        { id: "mk-bang", label: "!", svg: `<text x="64" y="92" font-size="90" text-anchor="middle" fill="#b42318">!</text>` },
        { id: "mk-heart", label: "♥", svg: `<text x="64" y="92" font-size="90" text-anchor="middle" fill="#ef4444">♥</text>` }
      ].map((s) => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="20" fill="#ffffff"/>${s.svg}</svg>`;
        return { id: s.id, label: s.label, url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` };
      })
    },
    {
      id: "builtin-shapes",
      name: "Фигуры",
      builtIn: true,
      stickers: [
        { id: "sh-circle", url: `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><circle cx="64" cy="64" r="50" fill="#fde68a" stroke="#f59e0b" stroke-width="6"/></svg>')}`, label: "Круг" },
        { id: "sh-star", url: `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><polygon points="64,8 79,48 122,50 88,76 100,118 64,93 28,118 40,76 6,50 49,48" fill="#fca5a5" stroke="#b91c1c" stroke-width="4"/></svg>')}`, label: "Звезда" },
        { id: "sh-check", url: `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="24" fill="#bbf7d0"/><path d="M30 66 L54 90 L98 38" stroke="#15803d" stroke-width="12" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`, label: "Галочка" },
        { id: "sh-cross", url: `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="24" fill="#fecaca"/><path d="M36 36 L92 92 M92 36 L36 92" stroke="#b91c1c" stroke-width="12" stroke-linecap="round"/></svg>')}`, label: "Крестик" }
      ]
    }
  ];

  let packs = [];
  let activePackId = null;
  let favorites = [];
  let removedBuiltins = [];

  const panel = () => $("#stickerPanel");
  const packsEl = () => $("#stickerPacks");
  const gridEl = () => $("#stickerGrid");
  const fileInput = () => $("#stickerFileInput");

  function load() {
    try { packs = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { packs = []; }
    try { favorites = JSON.parse(localStorage.getItem(FAV_STORAGE_KEY)) || []; } catch { favorites = []; }
    try { removedBuiltins = JSON.parse(localStorage.getItem(REMOVED_BUILTIN_KEY)) || []; } catch { removedBuiltins = []; }
    // Seed built-ins that haven't been removed.
    for (const pack of BUILTIN_PACKS) {
      if (removedBuiltins.includes(pack.id)) continue;
      if (!packs.some((p) => p.id === pack.id)) packs.unshift(JSON.parse(JSON.stringify(pack)));
    }
    // Sort: built-ins first, then user packs by creation order.
    packs.sort((a, b) => (Boolean(a.builtIn) === Boolean(b.builtIn) ? 0 : a.builtIn ? -1 : 1));
    if (!activePackId || !packs.some((p) => p.id === activePackId)) activePackId = packs[0]?.id || null;
    save();
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(packs)); } catch { /* quota */ }
    try { localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(favorites)); } catch { /* quota */ }
    try { localStorage.setItem(REMOVED_BUILTIN_KEY, JSON.stringify(removedBuiltins)); } catch { /* quota */ }
  }

  function activePack() {
    return packs.find((p) => p.id === activePackId) || packs[0] || null;
  }

  function init() {
    load();
    $("#stickerBtn")?.addEventListener("click", () => togglePanel());
    $("#stickerCloseBtn")?.addEventListener("click", () => closePanel());
    $("#stickerAddPackBtn")?.addEventListener("click", () => createPack());
    $("#stickerImportBtn")?.addEventListener("click", () => {
      if (!activePack()) { alert("Сначала создайте или выберите пак."); return; }
      fileInput().click();
    });
    fileInput().addEventListener("change", () => importStickerFiles(fileInput().files));
  }

  function togglePanel() {
    const p = panel();
    if (!p) return;
    p.hidden = !p.hidden;
    if (!p.hidden) render();
  }

  function closePanel() {
    const p = panel();
    if (p) p.hidden = true;
  }

  function render() {
    renderPacks();
    renderGrid();
  }

  function renderPacks() {
    const host = packsEl();
    host.innerHTML = "";
    for (const pack of packs) {
      const node = document.createElement("div");
      node.className = "sticker-pack" + (pack.id === activePackId ? " active" : "");
      node.title = pack.name;
      const name = document.createElement("span");
      name.className = "sp-name";
      name.textContent = pack.name;
      node.append(name);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "sp-del";
      del.title = "Удалить пак";
      del.textContent = "×";
      del.addEventListener("click", (e) => { e.stopPropagation(); removePack(pack.id); });
      node.append(del);
      node.addEventListener("click", () => { activePackId = pack.id; save(); render(); });
      host.append(node);
    }
  }

  function renderGrid() {
    const host = gridEl();
    host.innerHTML = "";
    const pack = activePack();

    // Quick access (favorites) section first, regardless of active pack.
    if (favorites.length) {
      const title = document.createElement("div");
      title.className = "sticker-section-title";
      title.textContent = "Быстрый доступ";
      host.append(title);
      for (const fav of favorites) host.append(renderCell(fav, true));
    }

    if (pack) {
      const title = document.createElement("div");
      title.className = "sticker-section-title";
      title.textContent = pack.name;
      host.append(title);
      const stickers = pack.stickers || [];
      if (!stickers.length) {
        const empty = document.createElement("div");
        empty.className = "sticker-empty";
        empty.textContent = "В паке пусто. Нажмите «＋ Картинки», чтобы добавить стикеры.";
        host.append(empty);
      } else {
        for (const s of stickers) host.append(renderCell(s, false));
      }
    } else {
      const empty = document.createElement("div");
      empty.className = "sticker-empty";
      empty.textContent = "Нет паков. Нажмите «+ Пак».";
      host.append(empty);
    }
  }

  function renderCell(sticker, isFav) {
    const cell = document.createElement("div");
    cell.className = "sticker-cell" + (isFav ? " fav" : "");
    cell.title = sticker.label || "Стикер";
    cell.draggable = true;
    const img = document.createElement("img");
    img.src = sticker.url;
    img.alt = sticker.label || "";
    cell.append(img);

    // click = stamp at screen center; drag = drop onto canvas.
    cell.addEventListener("click", () => placeAtCenter(sticker));
    cell.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-zmtki-sticker", JSON.stringify(sticker));
      e.dataTransfer.effectAllowed = "copy";
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "sc-del";
    del.title = isFav ? "Убрать из быстрого доступа" : "Удалить стикер";
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isFav) toggleFavorite(sticker, false);
      else deleteSticker(sticker);
    });
    cell.append(del);

    // double-click a non-fav sticker to add it to quick access
    if (!isFav) {
      cell.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        toggleFavorite(sticker, true);
      });
    }
    return cell;
  }

  function placeAtCenter(sticker) {
    App()?.placeSticker?.(sticker, null);
  }

  // Drop handler installed from app.js onto the SVG, so the canvas accepts the
  // custom MIME type and stamps at the cursor position.
  function handleCanvasDrop(event, worldPoint) {
    const raw = event.dataTransfer?.getData("application/x-zmtki-sticker");
    if (!raw) return false;
    try {
      const sticker = JSON.parse(raw);
      if (!sticker || !sticker.url) return false;
      App()?.placeSticker?.(sticker, worldPoint);
      return true;
    } catch {
      return false;
    }
  }

  function createPack() {
    const name = prompt("Название нового стикерпака:", "Мой пак");
    if (!name) return;
    const pack = { id: `pack_${Date.now().toString(36)}`, name: name.trim(), builtIn: false, stickers: [] };
    packs.push(pack);
    activePackId = pack.id;
    save();
    render();
  }

  function removePack(id) {
    const pack = packs.find((p) => p.id === id);
    if (!pack) return;
    if (!confirm(`Удалить пак «${pack.name}»?`)) return;
    packs = packs.filter((p) => p.id !== id);
    if (pack.builtIn) { removedBuiltins.push(id); }
    if (activePackId === id) activePackId = packs[0]?.id || null;
    save();
    render();
  }

  function deleteSticker(sticker) {
    for (const pack of packs) {
      const before = (pack.stickers || []).length;
      pack.stickers = (pack.stickers || []).filter((s) => s.id !== sticker.id && s.url !== sticker.url);
      if (pack.stickers.length !== before) { save(); render(); return; }
    }
    // not in any pack: maybe a favorite only
    toggleFavorite(sticker, false);
  }

  function toggleFavorite(sticker, on) {
    const exists = favorites.some((f) => f.url === sticker.url);
    if (on && !exists) favorites.unshift({ id: sticker.id || `fav_${Date.now().toString(36)}`, url: sticker.url, label: sticker.label || "" });
    if (!on) favorites = favorites.filter((f) => f.url !== sticker.url);
    save();
    render();
  }

  async function importStickerFiles(fileList) {
    const pack = activePack();
    if (!pack) { alert("Сначала создайте пак."); return; }
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) { fileInput().value = ""; return; }
    for (const file of files) {
      let url = "";
      try {
        const res = App()?.saveAssetFile ? await App().saveAssetFile(file) : await uploadRaw(file);
        url = res?.url || "";
      } catch { url = ""; }
      if (!url) {
        // Fall back to a data URL so import still works offline / on server board.
        url = await fileToDataUrl(file);
      }
      pack.stickers.push({
        id: `stk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        url,
        label: (file.name || "").replace(/\.[^.]+$/, "")
      });
    }
    save();
    render();
    fileInput().value = "";
  }

  function uploadRaw(file) {
    const fd = new FormData();
    fd.append("file", file);
    return fetch("/api/upload", { method: "POST", body: fd }).then((r) => r.json());
  }

  function fileToDataUrl(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => resolve("");
      reader.readAsDataURL(file);
    });
  }

  window.Stickers = {
    init,
    handleCanvasDrop,
    togglePanel,
    closePanel
  };
  document.addEventListener("DOMContentLoaded", init);
})();
