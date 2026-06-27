const svg = document.querySelector("#boardSvg");
const viewport = document.querySelector("#viewport");
const overlay = document.querySelector("#overlay");
const gridRect = document.querySelector("#gridRect");
const zoomLabel = document.querySelector("#zoomLabel");
const selectionLabel = document.querySelector("#selectionLabel");
const syncLabel = document.querySelector("#syncLabel");
const fillInput = document.querySelector("#fillInput");
const strokeInput = document.querySelector("#strokeInput");
const fontSizeInput = document.querySelector("#fontSizeInput");
const strokeWidthInput = document.querySelector("#strokeWidthInput");
const routeSwitch = document.querySelector("#routeSwitch");
const dashSwitch = document.querySelector("#dashSwitch");
const imageInput = document.querySelector("#imageInput");
const importInput = document.querySelector("#importInput");
const imageFitBtn = document.querySelector("#imageFitBtn");
const gradientPicker = document.querySelector("#gradientPicker");
const styleControls = [fillInput, strokeInput, strokeWidthInput, fontSizeInput]
  .map((input) => input.closest(".field"))
  .filter(Boolean);

const svgns = "http://www.w3.org/2000/svg";
const xlinkns = "http://www.w3.org/1999/xlink";
const minSize = 24;
const snapScreenRadius = 22;
const anchorNames = ["nw", "n", "ne", "e", "se", "s", "sw", "w", "c"];
const shapeTypes = new Set(["rect", "ellipse", "diamond", "sticky", "text", "frame", "image", "card", "file"]);
const connectorTypes = new Set(["line", "arrow"]);
const workspaceBoardPrefix = "codex-miro-plane";
const PLANE_FILE = "codex-miro-plane.json";
const TABS_STORAGE_KEY = "codex-miro-tabs-v1";
const FOLDER_DB_NAME = "codex-miro-folders";
const SERVER_DEFAULT_TAB_ID = "server-default";
const CARD_ASPECT = 2 / 3;
const GRADIENT_PRESETS = {
  sunset: { angle: 135, colors: ["#ff512f", "#dd2476"] },
  ocean: { angle: 180, colors: ["#2193b0", "#6dd5ed"] },
  neon: { angle: 90, colors: ["#12c2e9", "#c471ed", "#f64f59"] },
  lime: { angle: 45, colors: ["#a8e063", "#56ab2f"] },
  violet: { angle: 120, colors: ["#7f00ff", "#e100ff"] },
  fire: { angle: 160, colors: ["#f12711", "#f5af19"] },
  candy: { angle: 200, colors: ["#ff9a9e", "#fecfef", "#fecfef"] },
  aurora: { angle: 70, colors: ["#00c6ff", "#0072ff", "#7f00ff"] }
};

const boardTabsList = document.querySelector("#boardTabsList");
const addBoardTabBtn = document.querySelector("#addBoardTabBtn");

const tabsState = { tabs: [], activeId: null };
const tabUiCache = new Map();

const state = {
  board: { version: 1, name: "Local board", elements: [], selectedIds: [] },
  mode: "canvas",
  tool: "select",
  selectedId: null,
  selectedExtra: [],
  action: null,
  editor: null,
  view: { x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 },
  history: [],
  future: [],
  dirtyTimer: null,
  reloadTimer: null,
  syncFlashTimer: null,
  eventSource: null,
  pollTimer: null,
  remoteSignature: "",
  lastLocalWrite: 0,
  style: { fill: "#ffffff", stroke: "#1f2937", fontSize: 18, strokeWidth: 2 },
  spaceHeld: false,
  activeTouches: new Map(),
  boardKind: "server",
  workspace: { dirHandle: null, boardFileHandle: null, assetUrls: new Map(), fileHandles: new Map() },
};

const defaults = {
  rect: { width: 180, height: 110, fill: "#ffffff" },
  ellipse: { width: 180, height: 110, fill: "#ffffff" },
  diamond: { width: 160, height: 120, fill: "#ffffff" },
  sticky: { width: 190, height: 150, fill: "#fef08a", stroke: "#ca8a04", text: "Note" },
  frame: { width: 360, height: 240, fill: "transparent", stroke: "#475569", text: "Frame" },
  text: { width: 220, height: 80, fill: "transparent", stroke: "transparent", text: "Text" },
  line: { width: 180, height: 0, fill: "transparent" },
  arrow: { width: 180, height: 0, fill: "transparent" },
  image: { width: 240, height: 160, fill: "transparent", stroke: "transparent", strokeWidth: 0 },
  card: { width: 200, height: 300, fill: "#ffffff", stroke: "#cbd5e1", strokeWidth: 1, text: "# Карточка\n\nДважды кликните, чтобы открыть редактор." },
  file: { width: 150, height: 132, fill: "#ffffff", stroke: "#cbd5e1", strokeWidth: 1, text: "" }
};

init().catch((error) => {
  console.error("Codex Miro init failed:", error);
  applyMode("canvas");
  syncLabel.textContent = "Ошибка запуска";
  render();
});

async function init() {
  try {
    wireModes();
    wireToolbar();
    wireStage();
    wireKeyboard();
    wireBoardTabs();
    publishApp();
    connectEvents();
    setTool("select");
    applyMode("canvas");
    await bootstrapBoardTabs();
  } catch (error) {
    console.error("bootstrap failed:", error);
    resetTabsToServerDefault();
    await loadServerBoard();
    syncLabel.textContent = "Базовая доска";
    renderBoardTabs();
  } finally {
    render();
  }
}

function wireBoardTabs() {
  addBoardTabBtn?.addEventListener("click", () => openWorkspaceFolder());
  window.addEventListener("beforeunload", () => {
    stashActiveTabUi();
    persistTabsSession();
  });
}

function newTabId(prefix = "tab") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function readTabsSession() {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tabs) || !parsed.tabs.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistTabsSession() {
  localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({
    activeTabId: tabsState.activeId,
    tabs: tabsState.tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      kind: tab.kind
    }))
  }));
}

function stashActiveTabUi() {
  if (!tabsState.activeId) return;
  tabUiCache.set(tabsState.activeId, {
    view: { ...state.view },
    history: [...state.history],
    future: [...state.future],
    selectedId: state.selectedId,
    selectedExtra: [...state.selectedExtra],
    tool: state.tool,
    mode: state.mode
  });
}

function restoreTabUi(tabId) {
  const cached = tabUiCache.get(tabId);
  if (!cached) return;
  state.view = { ...cached.view };
  state.history = [...cached.history];
  state.future = [...cached.future];
  state.selectedId = cached.selectedId;
  state.selectedExtra = [...cached.selectedExtra];
  state.tool = cached.tool || "select";
  if (cached.mode) applyMode(cached.mode);
}

function resetTabsToServerDefault() {
  tabsState.tabs = [{ id: SERVER_DEFAULT_TAB_ID, name: "Базовая доска", kind: "server" }];
  tabsState.activeId = SERVER_DEFAULT_TAB_ID;
  state.boardKind = "server";
  persistTabsSession();
}

function renderBoardTabs() {
  if (!boardTabsList) return;
  boardTabsList.replaceChildren();
  for (const tab of tabsState.tabs) {
    const item = document.createElement("div");
    item.className = `board-tab${tab.id === tabsState.activeId ? " active" : ""}`;
    item.title = tab.name;
    item.setAttribute("role", "tab");
    item.tabIndex = tab.id === tabsState.activeId ? 0 : -1;
    item.setAttribute("aria-selected", tab.id === tabsState.activeId ? "true" : "false");
    const label = document.createElement("span");
    label.className = "board-tab-label";
    label.textContent = tab.name;
    item.append(label);
    if (tabsState.tabs.length > 1) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "board-tab-close";
      close.title = "Закрыть вкладку";
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeBoardTab(tab.id);
      });
      item.append(close);
    }
    item.addEventListener("click", () => activateBoardTab(tab.id));
    boardTabsList.append(item);
  }
}

async function bootstrapBoardTabs() {
  const saved = readTabsSession();
  if (!saved) {
    tabsState.tabs = [{ id: SERVER_DEFAULT_TAB_ID, name: "Базовая доска", kind: "server" }];
    tabsState.activeId = SERVER_DEFAULT_TAB_ID;
    persistTabsSession();
    await loadServerBoard();
    syncLabel.textContent = "Базовая доска";
    renderBoardTabs();
    return;
  }
  tabsState.tabs = saved.tabs.filter((tab) => tab.id && tab.name && tab.kind);
  if (!tabsState.tabs.length) {
    tabsState.tabs = [{ id: SERVER_DEFAULT_TAB_ID, name: "Базовая доска", kind: "server" }];
  }
  tabsState.activeId = saved.activeTabId && tabsState.tabs.some((tab) => tab.id === saved.activeTabId)
    ? saved.activeTabId
    : tabsState.tabs[0].id;
  renderBoardTabs();
  await activateBoardTab(tabsState.activeId, { initial: true });
  const active = tabsState.tabs.find((tab) => tab.id === tabsState.activeId);
  if (active?.kind === "folder") {
    const handle = await getFolderHandle(active.id);
    if (!handle) {
      resetTabsToServerDefault();
      renderBoardTabs();
      await activateBoardTab(SERVER_DEFAULT_TAB_ID, { initial: true });
    }
  }
}

async function activateBoardTab(tabId, options = {}) {
  const tab = tabsState.tabs.find((item) => item.id === tabId);
  if (!tab) return;
  if (!options.initial && tabId === tabsState.activeId) {
    if (tab.kind === "server") {
      await loadServerBoard({ preserveSelection: true, force: true });
      syncLabel.textContent = tab.name;
      render();
      if (state.mode === "docs" || state.mode === "editor") Docs.renderCatalog();
    }
    return;
  }
  if (!options.initial && tabsState.activeId) {
    stashActiveTabUi();
    await flushActiveBoardSave();
  }
  tabsState.activeId = tabId;
  persistTabsSession();
  finishTextEdit(true);
  resetWorkspaceState();
  state.boardKind = tab.kind;
  if (tab.kind === "server") {
    await loadServerBoard({ preserveSelection: true, force: true });
    syncLabel.textContent = tab.name;
  } else {
    try {
      const handle = await getFolderHandle(tab.id);
      if (!handle) {
        syncLabel.textContent = "Нажмите Файл, чтобы снова выбрать папку";
        state.board = { version: 1, name: tab.name, elements: [], selectedIds: [] };
      } else {
        const permission = await handle.requestPermission?.({ mode: "readwrite" });
        if (permission && permission !== "granted") {
          syncLabel.textContent = "Нет доступа к папке";
          state.board = { version: 1, name: tab.name, elements: [], selectedIds: [] };
        } else {
          await loadWorkspaceFolder(handle, { tab });
        }
      }
    } catch (error) {
      console.error("folder tab restore failed:", error);
      syncLabel.textContent = "Ошибка папки";
      state.board = { version: 1, name: tab.name, elements: [], selectedIds: [] };
    }
  }
  restoreTabUi(tabId);
  setTool(state.tool || "select");
  renderBoardTabs();
  render();
}

async function closeBoardTab(tabId) {
  if (tabsState.tabs.length <= 1) return;
  const index = tabsState.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return;
  if (tabId === tabsState.activeId) await flushActiveBoardSave();
  tabsState.tabs.splice(index, 1);
  tabUiCache.delete(tabId);
  await deleteFolderHandle(tabId);
  if (tabId === tabsState.activeId) {
    const next = tabsState.tabs[Math.min(index, tabsState.tabs.length - 1)];
    await activateBoardTab(next.id, { initial: true });
  } else {
    persistTabsSession();
    renderBoardTabs();
  }
}

async function openWorkspaceAsNewTab(dirHandle) {
  const existing = tabsState.tabs.find((tab) => tab.kind === "folder" && tab.name === dirHandle.name);
  if (existing) {
    await activateBoardTab(existing.id);
    return;
  }
  if (tabsState.activeId) {
    stashActiveTabUi();
    await flushActiveBoardSave();
  }
  const tab = { id: newTabId("folder"), name: dirHandle.name || "Папка", kind: "folder" };
  tabsState.tabs.push(tab);
  await saveFolderHandle(tab.id, dirHandle);
  tabsState.activeId = tab.id;
  persistTabsSession();
  resetWorkspaceState();
  state.boardKind = "folder";
  await loadWorkspaceFolder(dirHandle, { tab });
  restoreTabUi(tab.id);
  renderBoardTabs();
  render();
}

function resetWorkspaceState() {
  revokeWorkspaceUrls();
  state.workspace = { dirHandle: null, boardFileHandle: null, assetUrls: new Map(), fileHandles: new Map() };
  state.board = { version: 1, name: "Local board", elements: [], selectedIds: [] };
  state.history = [];
  state.future = [];
  setSelection([]);
}

async function flushActiveBoardSave() {
  clearTimeout(state.dirtyTimer);
  state.dirtyTimer = null;
  if (state.boardKind === "server") return saveServerBoard({ immediate: true });
  if (state.workspace?.boardFileHandle) return saveBoard({ immediate: true });
  return null;
}

function normalizeBoardImages() {
  for (const element of state.board.elements) {
    if (element.type === "image") normalizeImageBox(element);
  }
}

async function loadServerBoard(options = {}) {
  try {
    const res = await fetch("/api/board", { cache: "no-store" });
    if (!res.ok) throw new Error(`board fetch failed: ${res.status}`);
    const board = await res.json();
    const remoteSig = boardSignature(board);
    if (options.remote && !options.force && remoteSig === boardSignature(state.board)) {
      return false;
    }
    const previousIds = options.preserveSelection ? selectedIds() : [];
    state.board = {
      version: board.version || 1,
      name: board.name || "Базовая доска",
      updatedAt: board.updatedAt || new Date().toISOString(),
      elements: Array.isArray(board.elements) ? board.elements : [],
      selectedIds: []
    };
    state.remoteSignature = remoteSig;
    if (options.preserveSelection && previousIds.length) {
      const keep = previousIds.filter((id) => state.board.elements.some((element) => element.id === id));
      setSelection(keep.length ? keep : []);
    } else if (!options.preserveSelection) {
      setSelection([]);
    }
    hideBootNotice();
    normalizeBoardImages();
    return true;
  } catch (error) {
    console.warn("loadServerBoard:", error);
    if (!options.remote) {
      state.board = { version: 1, name: "Базовая доска", elements: [], selectedIds: [] };
      setSelection([]);
      const offline = location.protocol === "file:" || error?.message?.includes("Failed to fetch");
      showBootNotice(offline
        ? "Откройте через сервер: npm start → http://localhost:8080"
        : "Сервер недоступен. Запустите: npm start");
      syncLabel.textContent = "Сервер недоступен";
    }
    throw error;
  }
}

function showBootNotice(message) {
  let node = document.querySelector("#bootNotice");
  if (!node) {
    node = document.createElement("div");
    node.id = "bootNotice";
    node.className = "boot-notice";
    document.body.append(node);
  }
  node.textContent = message;
  node.hidden = false;
}

function hideBootNotice() {
  const node = document.querySelector("#bootNotice");
  if (node) node.hidden = true;
}

async function saveServerBoard(options = {}) {
  syncLabel.textContent = "Saving";
  const delay = options.immediate ? 0 : 120;
  return new Promise((resolve) => {
    clearTimeout(state.dirtyTimer);
    state.dirtyTimer = setTimeout(async () => {
      state.dirtyTimer = null;
      try {
        const remoteRes = await fetch("/api/board", { cache: "no-store" });
        if (remoteRes.ok) {
          const remote = await remoteRes.json();
          const remoteTs = Date.parse(remote.updatedAt || 0);
          const localTs = Date.parse(state.board.updatedAt || 0);
          if (remoteTs > localTs) {
            await loadServerBoard({ preserveSelection: true, force: true });
            if (state.mode === "docs" || state.mode === "editor") Docs.renderCatalog();
            render();
            flashSyncLabel("Подгружено с сервера");
            resolve(state.board);
            return;
          }
        }
        state.board.elements.filter((element) => connectorTypes.has(element.type)).forEach(refreshConnectorCoordinates);
        const res = await fetch("/api/board", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(serializeWorkspaceBoard(state.board))
        });
        if (res.status === 409) {
          const payload = await res.json();
          if (payload.board) {
            state.board = {
              version: payload.board.version || 1,
              name: payload.board.name || state.board.name,
              updatedAt: payload.board.updatedAt || new Date().toISOString(),
              elements: Array.isArray(payload.board.elements) ? payload.board.elements : []
            };
            state.remoteSignature = boardSignature(state.board);
            normalizeBoardImages();
            if (state.mode === "docs" || state.mode === "editor") Docs.renderCatalog();
            render();
            flashSyncLabel("Сервер новее — подгружено");
          }
          resolve(state.board);
          return;
        }
        if (!res.ok) throw new Error("save failed");
        const saved = await res.json();
        state.board.updatedAt = saved.updatedAt || state.board.updatedAt;
        state.remoteSignature = boardSignature(state.board);
        state.lastLocalWrite = Date.now();
        syncLabel.textContent = "Saved";
        resolve(state.board);
      } catch {
        syncLabel.textContent = "Save error";
        resolve(null);
      }
    }, delay);
  });
}

function openFolderDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      resolve(null);
      return;
    }
    const request = indexedDB.open(FOLDER_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveFolderHandle(tabId, handle) {
  try {
    const db = await openFolderDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(handle, tabId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn("saveFolderHandle:", error);
  }
}

async function getFolderHandle(tabId) {
  try {
    const db = await openFolderDb();
    if (!db) return null;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readonly");
      const req = tx.objectStore("handles").get(tabId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.warn("getFolderHandle:", error);
    return null;
  }
}

async function deleteFolderHandle(tabId) {
  try {
    const db = await openFolderDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").delete(tabId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn("deleteFolderHandle:", error);
  }
}

function connectEvents() {
  let retryMs = 1000;
  const scheduleRemoteReload = () => {
    clearTimeout(state.reloadTimer);
    state.reloadTimer = setTimeout(() => applyRemoteReload({ force: true }), 120);
  };

  const open = () => {
    const es = new EventSource("/api/events");
    es.addEventListener("ready", () => {
      retryMs = 1000;
      applyRemoteReload({ force: true });
    });
    es.addEventListener("workspace:changed", scheduleRemoteReload);
    es.addEventListener("board:update", scheduleRemoteReload);
    es.onerror = () => {
      es.close();
      setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };
    state.eventSource = es;
  };

  open();
  startBoardPolling();
  pollServerRevision();

  window.addEventListener("focus", () => {
    applyRemoteReload({ force: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) applyRemoteReload({ force: true });
  });
}

function boardSignature(board) {
  const ids = (board?.elements || []).map((element) => element.id).sort().join(",");
  return `${board?.updatedAt || ""}|${ids}`;
}

function startBoardPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (state.boardKind !== "server") return;
    if (state.editor) return;
    pollServerRevision();
  }, 1200);
}

async function pollServerRevision() {
  try {
    const res = await fetch("/api/board/revision", { cache: "no-store" });
    if (res.ok) {
      const revision = await res.json();
      if (!revision.signature || revision.signature === state.remoteSignature) return;
      clearTimeout(state.dirtyTimer);
      state.dirtyTimer = null;
      await applyRemoteReload({ force: true });
      return;
    }
    if (state.boardKind === "server") await applyRemoteReload({ force: true });
  } catch {
    // server offline
  }
}

async function applyRemoteReload(options = {}) {
  if (state.editor) return;
  if (!options.force && state.dirtyTimer) return;

  let changed = false;
  try {
    if (state.boardKind === "server") {
      changed = await loadServerBoard({
        preserveSelection: true,
        remote: true,
        force: Boolean(options.force)
      });
    } else if (state.workspace?.dirHandle) {
      changed = await reloadWorkspaceFromFolder({ remote: true, silent: true, force: Boolean(options.force) });
    } else {
      return;
    }
  } catch {
    syncLabel.textContent = "Sync error";
    return;
  }

  if (!changed) return;
  if (state.mode === "docs" || state.mode === "editor") Docs.renderCatalog();
  render();
  flashSyncLabel("Обновлено с сервера");
}

function flashSyncLabel(message) {
  syncLabel.textContent = message;
  clearTimeout(state.syncFlashTimer);
  state.syncFlashTimer = setTimeout(() => {
    if (syncLabel.textContent !== message) return;
    syncLabel.textContent = state.boardKind === "server"
      ? (state.board.name || "Базовая доска")
      : (state.workspace?.dirHandle?.name || "Папка");
  }, 1800);
}

function wireModes() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });
}

function setMode(mode) {
  if (mode === "docs") {
    // committing a pending editor is handled inside Docs; just open catalog
    Docs.openCatalog();
    applyMode("docs");
    return;
  }
  if (mode === "editor") {
    applyMode("editor");
    return;
  }
  if (mode === "canvas") {
    applyMode("canvas");
    applyRemoteReload({ force: true });
    return;
  }
  applyMode(mode);
}

function applyMode(mode) {
  state.mode = mode;
  document.body.classList.remove("mode-canvas", "mode-docs", "mode-editor");
  document.body.classList.add(`mode-${mode}`);
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  if (mode === "docs") Docs.renderCatalog();
}

// Contract exposed to docs.js so it stays free of board internals.
function publishApp() {
  window.App = {
    getMode: () => state.mode,
    setMode,
    getCards: () => state.board.elements.filter((e) => e.type === "card"),
    createCard: () => createCardElement(),
    saveAssetFile,
    saveCard: async (card, options = {}) => {
      markCardUpdated(card);
      await saveWorkspaceCard(card);
      const saved = await saveBoard({ immediate: !!options.immediate });
      render();
      return saved;
    },
    deleteCard: (id) => {
      pushHistory();
      state.board.elements = state.board.elements.filter((e) => e.id !== id);
      saveBoard();
      render();
    },
    reloadFromFolder: () => (state.boardKind === "server"
      ? loadServerBoard().then(() => { if (state.mode === "docs") Docs.renderCatalog(); render(); })
      : reloadWorkspaceFromFolder()),
    openInExplorer: () => openWorkspaceInExplorer(),
    getFolderAssets: () => state.board.elements.filter((e) => e.type === "image" || e.type === "file"),
    openAsset: (id) => {
      const element = state.board.elements.find((e) => e.id === id);
      if (element) openFileElement(element);
    },
    getHiddenPlaneElements: () => state.board.elements.filter((e) => ["card", "image", "file"].includes(e.type) && e.meta?.planeHidden),
    setPlaneHidden: (id, hidden) => {
      const element = state.board.elements.find((e) => e.id === id);
      if (!element) return;
      element.meta = { ...(element.meta || {}), planeHidden: hidden };
      saveBoard();
      render();
      if (state.mode === "docs") Docs.renderCatalog();
    }
  };
}

function createCardElement() {
  const center = screenToWorld({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const element = createElement("card", center);
  state.board.elements.push(element);
  saveBoard();
  return element;
}

function markCardUpdated(card) {
  card.updatedAt = new Date().toISOString();
  const idx = state.board.elements.findIndex((e) => e.id === card.id);
  if (idx >= 0) state.board.elements[idx] = card;
}

async function openWorkspaceFolder() {
  if (!window.showDirectoryPicker) {
    alert("Выбор папки поддерживается в Chromium/Edge через File System Access API.");
    return;
  }
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    const permission = await dirHandle.requestPermission?.({ mode: "readwrite" });
    if (permission && permission !== "granted") return;
    await openWorkspaceAsNewTab(dirHandle);
  } catch (error) {
    if (error?.name !== "AbortError") alert("Не удалось открыть папку.");
  }
}

async function openWorkspaceInExplorer() {
  if (!state.workspace?.dirHandle) {
    await openWorkspaceFolder();
    return;
  }
  try {
    const res = await fetch("/api/open-folder", { method: "POST" });
    if (!res.ok) throw new Error("open failed");
    syncLabel.textContent = "Проводник";
  } catch {
    alert("Не удалось открыть папку в проводнике. Убедитесь, что WORKSPACE_DIR на сервере совпадает с выбранной папкой.");
  }
}

async function reloadWorkspaceFromFolder(options = {}) {
  if (state.boardKind === "server") {
    if (!options.silent) syncLabel.textContent = "Обновление…";
    const changed = await loadServerBoard({
      preserveSelection: true,
      remote: Boolean(options.remote),
      force: Boolean(options.force)
    });
    if (changed) {
      if (state.mode === "docs" || state.mode === "editor") Docs.renderCatalog();
      render();
      if (!options.silent) flashSyncLabel("Обновлено");
    }
    return changed;
  }
  if (!state.workspace?.dirHandle) {
    if (!options.remote) alert("Сначала выберите рабочую папку.");
    return false;
  }
  if (!options.silent) syncLabel.textContent = "Обновление…";
  try {
    const planeFile = await state.workspace.boardFileHandle.getFile();
    if (planeFile.size > 2) {
      const parsed = JSON.parse(await planeFile.text());
      if (Array.isArray(parsed.elements)) {
        const remoteTs = Date.parse(parsed.updatedAt || 0);
        const localTs = Date.parse(state.board.updatedAt || 0);
        if (options.remote && !options.force) {
          if (Date.now() - state.lastLocalWrite < 900 && remoteTs <= localTs) return false;
          if (remoteTs === localTs && state.board.elements.length === parsed.elements.length) return false;
        }
        const previousIds = selectedIds();
        state.board = {
          version: parsed.version || state.board.version || 1,
          name: parsed.name || state.board.name,
          updatedAt: parsed.updatedAt || new Date().toISOString(),
          elements: parsed.elements,
          selectedIds: state.board.selectedIds || []
        };
        hydrateElementUrls(state.board.elements);
        const keep = previousIds.filter((id) => state.board.elements.some((element) => element.id === id));
        setSelection(keep.length ? keep : []);
      }
    }
  } catch {
    // keep current in-memory board and merge folder files
  }
  await syncWorkspaceFromFolder({ merge: true });
  normalizeBoardImages();
  if (!options.silent) await saveBoard({ immediate: true });
  if (state.mode === "docs" || state.mode === "editor") Docs.renderCatalog();
  if (!options.silent) flashSyncLabel("Обновлено");
  render();
  return true;
}

async function loadWorkspaceFolder(dirHandle, options = {}) {
  revokeWorkspaceUrls();
  state.workspace = { dirHandle, boardFileHandle: null, assetUrls: new Map(), fileHandles: new Map() };
  state.boardKind = "folder";
  const tab = options.tab || tabsState.tabs.find((item) => item.id === tabsState.activeId);
  if (tab && tab.name !== dirHandle.name) {
    tab.name = dirHandle.name || tab.name;
    persistTabsSession();
    renderBoardTabs();
  }
  const files = await listWorkspaceFiles(dirHandle);
  state.workspace.boardFileHandle = await resolvePlaneFileHandle(dirHandle, files);
  await registerWorkspaceAssets(files);

  let loadedFromPlane = false;
  try {
    const planeFile = await state.workspace.boardFileHandle.getFile();
    if (planeFile.size > 2) {
      const parsed = JSON.parse(await planeFile.text());
      if (Array.isArray(parsed.elements)) {
        state.board = {
          version: parsed.version || 1,
          name: parsed.name || dirHandle.name || "Local folder",
          updatedAt: parsed.updatedAt || new Date().toISOString(),
          elements: parsed.elements,
          selectedIds: []
        };
        hydrateElementUrls(state.board.elements);
        loadedFromPlane = true;
      }
    }
  } catch {
    // start fresh from folder contents
  }

  if (!loadedFromPlane) {
    state.board = {
      version: 1,
      name: dirHandle.name || "Local folder",
      updatedAt: new Date().toISOString(),
      elements: [],
      selectedIds: []
    };
  }

  await syncWorkspaceFromFolder({ merge: loadedFromPlane });
  setSelection([]);
  normalizeBoardImages();
  applyMode("canvas");
  await saveBoard({ immediate: true });
  render();
}

async function listWorkspaceFiles(dirHandle) {
  const files = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file") files.push(entry);
  }
  return files;
}

async function resolvePlaneFileHandle(dirHandle, files) {
  const exact = files.find((handle) => handle.name === PLANE_FILE);
  if (exact) return exact;
  const legacy = files
    .filter((handle) => handle.name.startsWith(workspaceBoardPrefix) && handle.name.endsWith(".json"))
    .sort((a, b) => b.name.localeCompare(a.name));
  if (legacy.length) return legacy[0];
  return dirHandle.getFileHandle(PLANE_FILE, { create: true });
}

function isPlaneFileName(name) {
  return name === PLANE_FILE || (name.startsWith(workspaceBoardPrefix) && name.endsWith(".json"));
}

async function registerWorkspaceAssets(files) {
  for (const handle of files) {
    if (isPlaneFileName(handle.name)) continue;
    if (isImageName(handle.name)) await registerAssetHandle(handle);
    else state.workspace.fileHandles.set(handle.name, handle);
  }
}

async function registerAssetHandle(handle) {
  const file = await handle.getFile();
  const prev = state.workspace.assetUrls.get(handle.name);
  if (prev) URL.revokeObjectURL(prev);
  const url = URL.createObjectURL(file);
  state.workspace.assetUrls.set(handle.name, url);
  state.workspace.fileHandles.set(handle.name, handle);
  return url;
}

function hydrateElementUrls(elements) {
  for (const element of elements) {
    if (element.type === "image" && element.meta?.sourceFile) {
      const url = state.workspace.assetUrls.get(element.meta.sourceFile);
      if (url) element.url = url;
      else if (typeof element.url === "string" && !element.url.startsWith("blob:")) {
        const local = state.workspace.assetUrls.get(normalizeLocalRef(element.url));
        if (local) element.url = local;
      }
    }
    if (element.type === "card") {
      const imageFile = element.meta?.imageFile || normalizeLocalRef(element.meta?.image);
      if (imageFile && state.workspace.assetUrls.has(imageFile)) {
        element.meta.image = state.workspace.assetUrls.get(imageFile);
        element.meta.imageFile = imageFile;
      }
    }
  }
}

function collectMdImageRefs(mdItems) {
  const refs = new Set();
  for (const { meta, body } of mdItems) {
    if (meta?.image) refs.add(normalizeLocalRef(meta.image));
    const text = String(body || "");
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) refs.add(normalizeLocalRef(match[1]));
    for (const match of text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) refs.add(normalizeLocalRef(match[1]));
  }
  return refs;
}

async function syncWorkspaceFromFolder({ merge = false } = {}) {
  const dirHandle = state.workspace?.dirHandle;
  if (!dirHandle) return;
  const files = await listWorkspaceFiles(dirHandle);
  await registerWorkspaceAssets(files);

  const mdFiles = files.filter((handle) => extensionOf(handle.name) === "md");
  const imageFiles = files.filter((handle) => isImageName(handle.name));
  const otherFiles = files.filter((handle) => {
    if (isPlaneFileName(handle.name)) return false;
    return extensionOf(handle.name) !== "md" && !isImageName(handle.name);
  });

  const mdItems = [];
  for (const handle of mdFiles) {
    const parsed = parseMdFile(await (await handle.getFile()).text());
    mdItems.push({ handle, parsed });
    state.workspace.fileHandles.set(handle.name, handle);
  }
  const referencedImages = collectMdImageRefs(mdItems.map((item) => item.parsed));

  const bySource = new Map();
  const freehand = [];
  for (const element of state.board.elements) {
    const key = element.meta?.sourceFile;
    if (key) bySource.set(key, element);
    else freehand.push(element);
  }

  const next = merge ? [...freehand] : [];
  let index = next.length;

  for (const { handle, parsed } of mdItems) {
    const imageRef = normalizeLocalRef(parsed.meta.image);
    const imageFile = imageRef && state.workspace.assetUrls.has(imageRef) ? imageRef : "";
    const existing = bySource.get(handle.name);
    const point = existing ? { x: existing.x, y: existing.y } : layoutPoint(index++);
    const card = existing && existing.type === "card"
      ? existing
      : { ...createElement("card", point), id: existing?.id };
    card.x = point.x;
    card.y = point.y;
    if (existing) {
      card.width = existing.width;
      card.height = existing.height;
      card.rotation = existing.rotation || 0;
    }
    card.text = parsed.body;
    card.meta = {
      ...(card.meta || {}),
      title: parsed.meta.title || firstMarkdownHeading(parsed.body) || stripExtension(handle.name),
      caption: parsed.meta.caption || "",
      image: imageFile ? state.workspace.assetUrls.get(imageFile) : (parsed.meta.image || ""),
      imageFile,
      sourceFile: handle.name,
      planeHidden: existing?.meta?.planeHidden || false
    };
    next.push(card);
    bySource.delete(handle.name);
  }

  for (const handle of imageFiles) {
    const referenced = referencedImages.has(handle.name);
    const existing = bySource.get(handle.name);
    const url = state.workspace.assetUrls.get(handle.name);
    const point = existing ? { x: existing.x, y: existing.y } : layoutPoint(index++);
    const image = existing && existing.type === "image"
      ? existing
      : { ...createElement("image", point), id: existing?.id };
    image.x = point.x;
    image.y = point.y;
    if (existing) {
      image.width = existing.width;
      image.height = existing.height;
      image.rotation = existing.rotation || 0;
    }
    image.url = url;
    image.text = handle.name;
    image.meta = {
      ...(image.meta || {}),
      sourceFile: handle.name,
      planeHidden: existing ? Boolean(existing.meta?.planeHidden) : referenced
    };
    next.push(image);
    bySource.delete(handle.name);
  }

  for (const handle of otherFiles) {
    const existing = bySource.get(handle.name);
    const point = existing ? { x: existing.x, y: existing.y } : layoutPoint(index++);
    const fileEl = existing && existing.type === "file"
      ? existing
      : { ...createElement("file", point), id: existing?.id };
    fileEl.x = point.x;
    fileEl.y = point.y;
    if (existing) {
      fileEl.width = existing.width;
      fileEl.height = existing.height;
      fileEl.rotation = existing.rotation || 0;
    }
    fileEl.text = handle.name;
    fileEl.meta = {
      ...(fileEl.meta || {}),
      fileName: handle.name,
      extension: extensionOf(handle.name),
      sourceFile: handle.name,
      planeHidden: existing?.meta?.planeHidden || false
    };
    next.push(fileEl);
    bySource.delete(handle.name);
  }

  if (merge) {
    for (const orphan of bySource.values()) next.push(orphan);
  }

  state.board.elements = next;
  hydrateElementUrls(state.board.elements);
}

function visibleOnPlane(element) {
  return !element.meta?.planeHidden;
}

function setPlaneHiddenForSelection(hidden) {
  const ids = selectedIds();
  if (!ids.length) return;
  pushHistory();
  for (const id of ids) {
    const element = state.board.elements.find((e) => e.id === id);
    if (!element || !["card", "image", "file"].includes(element.type)) continue;
    element.meta = { ...(element.meta || {}), planeHidden: hidden };
  }
  saveBoard();
  render();
  if (state.mode === "docs") Docs.renderCatalog();
}

function revokeWorkspaceUrls() {
  for (const url of state.workspace?.assetUrls?.values?.() || []) URL.revokeObjectURL(url);
}

function layoutPoint(index) {
  const cols = 4;
  const x = -360 + (index % cols) * 220;
  const y = -240 + Math.floor(index / cols) * 180;
  return { x, y };
}

function parseMdFile(text) {
  const raw = String(text || "").replace(/\r\n?/g, "\n");
  if (!raw.startsWith("---\n")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end < 0) return { meta: {}, body: raw };
  const fm = raw.slice(4, end).trim();
  const meta = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    meta[m[1]] = parseFrontmatterScalar(m[2]);
  }
  return { meta, body: raw.slice(end + 4).replace(/^\n/, "") };
}

function parseFrontmatterScalar(value) {
  const v = String(value || "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  return v;
}

function firstMarkdownHeading(text) {
  const line = String(text || "").split(/\n/).find((item) => /^#\s+/.test(item));
  return line ? line.replace(/^#\s+/, "").trim() : "";
}

function extensionOf(name) {
  const m = String(name || "").toLowerCase().match(/\.([^.]+)$/);
  return m ? m[1] : "";
}

function stripExtension(name) {
  return String(name || "file").replace(/\.[^.]+$/, "");
}

function isImageName(name) {
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(extensionOf(name));
}

function normalizeLocalRef(value) {
  return String(value || "").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function compactTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function wireToolbar() {
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => setTool(button.dataset.tool));
    if (button.dataset.tool === "select") {
      button.addEventListener("dblclick", (event) => {
        event.preventDefault();
        setTool("pan");
      });
    }
  });
  document.querySelector("#imageBtn").addEventListener("click", () => imageInput.click());
  imageInput.addEventListener("change", handleImage);
  importInput.addEventListener("change", handleImport);
  document.querySelector("#undoBtn").addEventListener("click", undo);
  document.querySelector("#redoBtn").addEventListener("click", redo);
  document.querySelector("#copyBtn").addEventListener("click", duplicateSelected);
  document.querySelector("#deleteBtn").addEventListener("click", deleteSelected);
  document.querySelector("#fileBtn").addEventListener("click", openWorkspaceFolder);
  document.querySelector("#openFolderBtn").addEventListener("click", openWorkspaceInExplorer);
  document.querySelector("#reloadBtn").addEventListener("click", () => reloadWorkspaceFromFolder());
  document.querySelector("#hidePlaneBtn").addEventListener("click", () => setPlaneHiddenForSelection(true));
  document.querySelector("#showPlaneBtn").addEventListener("click", () => setPlaneHiddenForSelection(false));
  imageFitBtn?.addEventListener("click", toggleImageFit);
  document.querySelector("#importBtn").addEventListener("click", () => importInput.click());
  document.querySelector("#resetBtn").addEventListener("click", resetBoard);
  fillInput.addEventListener("input", () => applyStyle({ fill: fillInput.value, clearGradient: true }));
  strokeInput.addEventListener("input", () => applyStyle({ stroke: strokeInput.value }));
  fontSizeInput.addEventListener("input", () => applyStyle({ fontSize: Number(fontSizeInput.value) || 18 }));
  strokeWidthInput.addEventListener("input", () => applyStyle({ strokeWidth: Math.max(0, Number(strokeWidthInput.value) || 0) }));
  routeSwitch.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => setConnectorRoute(btn.dataset.route));
  });
  dashSwitch?.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => setConnectorDash(btn.dataset.dash));
  });
  gradientPicker?.querySelectorAll("[data-grad]").forEach((btn) => {
    btn.addEventListener("click", () => applyGradientPreset(btn.dataset.grad));
  });
}

// Switch the selected connector's routing (straight / elbow / orthogonal).
function setConnectorRoute(route) {
  const selected = getSelected();
  if (!selected || !connectorTypes.has(selected.type)) return;
  pushHistory();
  selected.meta = { ...selected.meta, route };
  saveBoard();
  render();
}

function setConnectorDash(dash) {
  const selected = getSelected();
  if (!selected || !connectorTypes.has(selected.type)) return;
  pushHistory();
  selected.meta = { ...selected.meta, strokeDash: dash };
  saveBoard();
  render();
}

function wireStage() {
  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("pointermove", onPointerMove);
  svg.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("pointercancel", onPointerUp);
  svg.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
  });
  svg.addEventListener("selectstart", (event) => {
    if (state.tool === "select" || state.tool === "pan" || state.spaceHeld) event.preventDefault();
  });
  svg.addEventListener("dragstart", (event) => event.preventDefault());
  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("dblclick", onDoubleClick);
  window.addEventListener("resize", () => {
    positionEditor();
    render();
  });
}

function wireKeyboard() {
  window.addEventListener("keydown", (event) => {
    if (state.editor || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.code === "Space" && !event.repeat) {
      event.preventDefault();
      state.spaceHeld = true;
      svg.classList.add("space-pan");
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") deleteSelected();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
      event.preventDefault();
      undo();
    }
    if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) {
      event.preventDefault();
      redo();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      duplicateSelected();
    }
    if (event.key === "Escape") {
      setSelection([]);
      state.action = null;
      render();
    }
  });
  window.addEventListener("keyup", (event) => {
    if (event.code !== "Space") return;
    state.spaceHeld = false;
    svg.classList.remove("space-pan");
    if (state.action?.type === "pan" && state.tool !== "pan") {
      state.action = null;
      svg.classList.remove("panning");
      render();
    }
  });
}

function setTool(tool) {
  finishTextEdit(true);
  state.tool = tool;
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === tool);
  });
  svg.className.baseVal = tool;
  render();
}

function render() {
  viewport.setAttribute("transform", `translate(${state.view.x} ${state.view.y}) scale(${state.view.zoom})`);
  gridRect.setAttribute("transform", `translate(${state.view.x % 32} ${state.view.y % 32}) scale(${state.view.zoom})`);
  renderGradientDefs();
  const ids = new Set(selectedIds());
  const planeElements = state.board.elements.filter(visibleOnPlane);
  viewport.replaceChildren(...planeElements.map((e) => renderElement(e, ids.has(e.id))));
  overlay.replaceChildren(...renderOverlay());
  zoomLabel.textContent = `${Math.round(state.view.zoom * 100)}%`;
  const selected = getSelected();
  const count = ids.size;
  selectionLabel.textContent = count > 1 ? `${count} selected` : (selected ? `${selected.type} ${selected.id}` : "No selection");
  styleControls.forEach((control) => {
    control.hidden = !count;
  });
  if (selected) {
    fillInput.value = colorToInput(selected.fill, state.style.fill);
    strokeInput.value = colorToInput(selected.stroke, state.style.stroke);
    fontSizeInput.value = selected.fontSize || state.style.fontSize;
    strokeWidthInput.value = selected.strokeWidth ?? state.style.strokeWidth;
  }
  // Route switch is only relevant for connectors (line/arrow).
  const isConnector = selected ? connectorTypes.has(selected.type) : false;
  routeSwitch.hidden = !isConnector;
  if (isConnector) {
    const route = selected.meta?.route || "straight";
    routeSwitch.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.route === route);
    });
    const dash = selected.meta?.strokeDash || "solid";
    dashSwitch?.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.dash === dash);
    });
  }
  if (dashSwitch) dashSwitch.hidden = !isConnector;
  const hideBtn = document.querySelector("#hidePlaneBtn");
  const showBtn = document.querySelector("#showPlaneBtn");
  const canTogglePlane = count > 0 && selectedIds().some((id) => {
    const element = state.board.elements.find((e) => e.id === id);
    return element && ["card", "image", "file"].includes(element.type);
  });
  if (hideBtn) hideBtn.disabled = !canTogglePlane;
  if (showBtn) showBtn.disabled = !canTogglePlane;
  if (imageFitBtn) {
    const isImage = selected?.type === "image";
    imageFitBtn.hidden = !isImage;
    imageFitBtn.classList.toggle("active", isImage && selected.meta?.fit === "stretch");
    imageFitBtn.title = selected?.meta?.fit === "stretch" ? "Вписать изображение" : "Растянуть изображение";
  }
  if (gradientPicker) {
    const canGradient = selected && shapeTypes.has(selected.type) && !["image", "file"].includes(selected.type);
    gradientPicker.hidden = !canGradient;
    gradientPicker.querySelectorAll("[data-grad]").forEach((btn) => {
      const preset = GRADIENT_PRESETS[btn.dataset.grad];
      if (preset) {
        btn.style.background = `linear-gradient(${preset.angle}deg, ${preset.colors.join(", ")})`;
      }
    });
  }
  positionEditor();
}

function renderElement(element, isSelected = element.id === state.selectedId) {
  if (connectorTypes.has(element.type)) return renderConnector(element, isSelected);
  const group = el("g", {
    class: `element ${isSelected ? "selected" : ""}`,
    "data-id": element.id,
    transform: `translate(${element.x} ${element.y}) rotate(${element.rotation || 0})`
  });
  group.addEventListener("pointerdown", (event) => beginMove(event, element));

  if (element.type === "rect" || element.type === "frame") {
    group.append(el("rect", shapeAttrs(element, { rx: element.type === "frame" ? 2 : 6 })));
    if (element.type === "frame" && element.text) group.append(textForeignObject(element, "text-box"));
  } else if (element.type === "ellipse") {
    group.append(el("ellipse", {
      ...shapeAttrs(element),
      cx: element.width / 2,
      cy: element.height / 2,
      rx: Math.abs(element.width / 2),
      ry: Math.abs(element.height / 2)
    }));
  } else if (element.type === "diamond") {
    group.append(el("polygon", {
      ...shapeAttrs(element),
      points: `${element.width / 2},0 ${element.width},${element.height / 2} ${element.width / 2},${element.height} 0,${element.height / 2}`
    }));
  } else if (element.type === "sticky") {
    group.append(el("rect", shapeAttrs(element, { rx: 4 })));
    group.append(textForeignObject(element, "sticky-text"));
  } else if (element.type === "text") {
    group.append(textForeignObject(element, "text-box"));
  } else if (element.type === "image") {
    const stretch = element.meta?.fit === "stretch";
    const fillBox = stretch || Boolean(element.meta?.aspectRatio);
    const image = el("image", {
      x: 0,
      y: 0,
      width: element.width,
      height: element.height,
      preserveAspectRatio: fillBox ? "none" : "xMidYMid meet"
    });
    image.setAttributeNS(xlinkns, "href", element.url || "");
    image.setAttribute("href", element.url || "");
    group.append(image);
  } else if (element.type === "file") {
    group.append(fileForeignObject(element));
    group.append(el("rect", {
      class: "card-hit",
      x: 0,
      y: 0,
      width: Math.max(1, element.width),
      height: Math.max(1, element.height),
      rx: 8,
      ry: 8,
      fill: "#ffffff"
    }));
  } else if (element.type === "card") {
    group.append(cardForeignObject(element));
    // Transparent hit-target on top: HTML inside <foreignObject> does not bubble
    // pointer events into the SVG <g> reliably, so this rect is what actually
    // receives clicks and forwards them to beginMove via the group listener.
    // NOTE: fill:"transparent" is NOT hit-tested in SVG (treated as having no
    // paint), so pointerdown never reached the rect and clicks fell through to
    // the canvas. Use a real (opaque) fill and hide it via CSS opacity instead.
    group.append(el("rect", {
      class: "card-hit",
      x: 0,
      y: 0,
      width: Math.max(1, element.width),
      height: Math.max(1, element.height),
      rx: 12,
      ry: 12,
      fill: "#ffffff"
    }));
  } else if (element.type === "pen") {
    group.append(el("path", {
      class: "line-shape",
      d: pointsToPath(element.points || []),
      fill: "none",
      stroke: element.stroke,
      "stroke-width": element.strokeWidth || 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round"
    }));
  }
  return group;
}

function fileForeignObject(element) {
  const fo = el("foreignObject", {
    x: 0,
    y: 0,
    width: Math.max(1, element.width),
    height: Math.max(1, element.height)
  });
  const body = document.createElement("div");
  body.className = "file-body";
  body.style.background = element.fill || "#ffffff";
  body.style.border = `${Math.max(0, Number(element.strokeWidth) || 1)}px solid ${element.stroke || "#cbd5e1"}`;
  const ext = (element.meta?.extension || extensionOf(element.meta?.fileName || element.text || "") || "file").toUpperCase();
  const name = element.meta?.fileName || element.text || "file";
  const icon = document.createElement("div");
  icon.className = "file-icon";
  icon.textContent = ext.slice(0, 5);
  const title = document.createElement("div");
  title.className = "file-name";
  title.textContent = name;
  const sub = document.createElement("div");
  sub.className = "file-ext";
  sub.textContent = element.meta?.extension ? `.${element.meta.extension}` : "";
  body.append(icon, title, sub);
  fo.append(body);
  return fo;
}

function renderConnector(element, isSelected = element.id === state.selectedId) {
  const endpoints = connectorEndpoints(element);
  const group = el("g", {
    class: `element connector ${isSelected ? "selected" : ""}`,
    "data-id": element.id
  });
  group.addEventListener("pointerdown", (event) => beginMove(event, element));
  const route = element.meta?.route || "straight";
  const dashAttrs = connectorDashAttrs(element);
  const d = connectorPath(endpoints.start, endpoints.end, route);
  // The arrowhead marker only rotates correctly on the final segment, so attach
  // it to a short straight "stub" line drawn from the last bend to the end and
  // make the main path markerless.
  const pts = pathPoints(endpoints.start, endpoints.end, route);
  if (pts.length >= 2) {
    group.append(el("path", {
      class: "line-shape",
      d,
      fill: "none",
      stroke: element.stroke,
      "stroke-width": element.strokeWidth || 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      ...dashAttrs
    }));
    if (element.type === "arrow") {
      const stubPts = connectorStubPoints(endpoints.start, endpoints.end, route);
      const a = stubPts[0];
      const b = stubPts[1];
      group.append(el("line", {
        class: "line-shape arrow-stub",
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        stroke: element.stroke,
        "stroke-width": element.strokeWidth || 2,
        "stroke-linecap": "round",
        "marker-end": "url(#arrowHead)",
        ...dashAttrs
      }));
    }
  }
  return group;
}

// Points (in board/world coordinates) the connector path passes through for a
// given routing mode. straight = endpoints; elbow = one bend; orthogonal = 90°;
// curve = quadratic bezier.
function pathPoints(start, end, route) {
  const s = { x: start.x, y: start.y };
  const e = { x: end.x, y: end.y };
  if (route === "elbow") {
    const midX = (s.x + e.x) / 2;
    return [s, { x: midX, y: s.y }, { x: midX, y: e.y }, e];
  }
  if (route === "orthogonal") {
    const horizontal = Math.abs(e.x - s.x) >= Math.abs(e.y - s.y);
    if (horizontal) return [s, { x: e.x, y: s.y }, e];
    return [s, { x: s.x, y: e.y }, e];
  }
  if (route === "curve") {
    const c = curveControlPoint(s, e);
    return [s, c, e];
  }
  return [s, e];
}

function curveControlPoint(start, end) {
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return { x: midX - dy * 0.35, y: midY + dx * 0.35 };
}

function connectorPath(start, end, route) {
  const s = { x: start.x, y: start.y };
  const e = { x: end.x, y: end.y };
  if (route === "curve") {
    const c = curveControlPoint(s, e);
    return `M ${s.x} ${s.y} Q ${c.x} ${c.y} ${e.x} ${e.y}`;
  }
  const pts = pathPoints(start, end, route);
  return pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

function connectorStubPoints(start, end, route) {
  const s = { x: start.x, y: start.y };
  const e = { x: end.x, y: end.y };
  if (route === "curve") {
    const c = curveControlPoint(s, e);
    const t = 0.88;
    const u = 1 - t;
    const px = u * u * s.x + 2 * u * t * c.x + t * t * e.x;
    const py = u * u * s.y + 2 * u * t * c.y + t * t * e.y;
    return [{ x: px, y: py }, e];
  }
  const pts = pathPoints(start, end, route);
  if (pts.length < 2) return [s, e];
  return [pts[pts.length - 2], pts[pts.length - 1]];
}

function connectorDashAttrs(element) {
  const dash = element.meta?.strokeDash || "solid";
  if (dash === "dashed") return { "stroke-dasharray": "12 7" };
  if (dash === "dotted") return { "stroke-dasharray": "2 7" };
  return {};
}

function shapeAttrs(element, extra = {}) {
  return {
    class: "shape",
    x: 0,
    y: 0,
    width: Math.max(1, element.width),
    height: Math.max(1, element.height),
    fill: resolveSvgFill(element),
    stroke: element.stroke || "#1f2937",
    "stroke-width": element.strokeWidth || 2,
    opacity: element.opacity ?? 1,
    ...extra
  };
}

function resolveSvgFill(element) {
  if (element.meta?.gradient) return `url(#grad-${element.id})`;
  return element.fill || "transparent";
}

function cssFill(element) {
  const gradient = element.meta?.gradient;
  if (gradient) {
    return `linear-gradient(${gradient.angle || 0}deg, ${gradient.colors.join(", ")})`;
  }
  return element.fill || "#ffffff";
}

function elementAspectLock(element) {
  if (element.type === "image") {
    if (element.meta?.aspectRatio) return element.meta.aspectRatio;
    if (element.width > 0 && element.height > 0) return element.width / element.height;
    return null;
  }
  if (element.type === "card") return CARD_ASPECT;
  return null;
}

function resizeHandlesFor(element) {
  return elementAspectLock(element) ? ["nw", "ne", "se", "sw"] : ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
}

function syncTouchPointer(event) {
  if (event.pointerType !== "touch") return;
  if (event.type === "pointerdown" || event.type === "pointermove") {
    state.activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    return;
  }
  if (event.type === "pointerup" || event.type === "pointercancel") {
    state.activeTouches.delete(event.pointerId);
  }
}

function touchCount() {
  return state.activeTouches.size;
}

function touchCentroid() {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const point of state.activeTouches.values()) {
    x += point.x;
    y += point.y;
    n += 1;
  }
  if (!n) return { x: 0, y: 0 };
  return { x: x / n, y: y / n };
}

function effectiveTool(event) {
  if (event.pointerType === "touch") return touchCount() >= 2 ? "pan" : "select";
  return state.tool;
}

function beginTouchPan() {
  state.action = { type: "touch-pan", lastCentroid: touchCentroid() };
  svg.classList.add("panning");
}

function isPanGesture(event) {
  if (event.pointerType === "touch") return touchCount() >= 2;
  return state.tool === "pan" || state.spaceHeld || event.button === 1;
}

function startPan(event) {
  state.action = {
    type: "pan",
    start: { x: event.clientX, y: event.clientY },
    original: { ...state.view }
  };
  svg.classList.add("panning");
  svg.setPointerCapture(event.pointerId);
}

function loadImageAspectRatio(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve(img.naturalWidth / img.naturalHeight);
      } else resolve(null);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function isCanvasBackground(target) {
  if (!target) return false;
  if (target === svg || target === gridRect || target === overlay) return true;
  const tag = target.tagName?.toLowerCase();
  if (tag === "svg" || tag === "rect" && target.id === "gridRect") return true;
  return target.classList?.contains("selection-box") || target.classList?.contains("resize-handle");
}

function imageDisplayRect(element) {
  const boxW = Math.max(1, element.width);
  const boxH = Math.max(1, element.height);
  if (element.meta?.fit === "stretch" || !element.meta?.aspectRatio) {
    return { x: 0, y: 0, width: boxW, height: boxH };
  }
  const ratio = element.meta.aspectRatio;
  const boxRatio = boxW / boxH;
  if (Math.abs(boxRatio - ratio) < 0.01) {
    return { x: 0, y: 0, width: boxW, height: boxH };
  }
  if (boxRatio > ratio) {
    const h = boxH;
    const w = h * ratio;
    return { x: (boxW - w) / 2, y: 0, width: w, height: h };
  }
  const w = boxW;
  const h = w / ratio;
  return { x: 0, y: (boxH - h) / 2, width: w, height: h };
}

async function fitImageElement(element) {
  const ratio = await loadImageAspectRatio(element.url);
  if (!ratio) return;
  element.meta = { ...(element.meta || {}), aspectRatio: ratio };
  const width = element.width || defaults.image.width;
  element.width = width;
  element.height = width / ratio;
  element.x -= element.width / 2;
  element.y -= element.height / 2;
  normalizeImageBox(element);
}

function normalizeImageBox(element) {
  if (element.type !== "image" || !element.meta?.aspectRatio) return;
  const ratio = element.meta.aspectRatio;
  const inner = imageDisplayRect(element);
  if (inner.x < 0.5 && inner.y < 0.5 && Math.abs(inner.width - element.width) < 1) return;
  element.x += inner.x;
  element.y += inner.y;
  element.width = inner.width;
  element.height = inner.height;
  if (Math.abs(element.width / element.height - ratio) > 0.02) {
    element.height = element.width / ratio;
  }
}

function renderGradientDefs() {
  let defs = svg.querySelector("#gradientDefs");
  if (!defs) {
    defs = el("defs");
    defs.id = "gradientDefs";
    svg.insertBefore(defs, gridRect);
  }
  const nodes = state.board.elements
    .filter((element) => element.meta?.gradient)
    .map((element) => buildLinearGradient(element));
  defs.replaceChildren(...nodes);
}

function buildLinearGradient(element) {
  const gradient = element.meta.gradient;
  const angle = (gradient.angle || 0) - 90;
  const rad = (angle * Math.PI) / 180;
  const x = Math.cos(rad);
  const y = Math.sin(rad);
  const grad = el("linearGradient", {
    id: `grad-${element.id}`,
    gradientUnits: "objectBoundingBox",
    x1: `${50 - x * 50}%`,
    y1: `${50 - y * 50}%`,
    x2: `${50 + x * 50}%`,
    y2: `${50 + y * 50}%`
  });
  const colors = gradient.colors || [];
  colors.forEach((color, index) => {
    const offset = colors.length === 1 ? 0 : (index / (colors.length - 1)) * 100;
    grad.append(el("stop", { offset: `${offset}%`, "stop-color": color }));
  });
  return grad;
}

function applyGradientPreset(presetKey) {
  const preset = GRADIENT_PRESETS[presetKey];
  if (!preset) return;
  const ids = selectedIds();
  if (!ids.length) return;
  pushHistory();
  for (const id of ids) {
    const target = state.board.elements.find((element) => element.id === id);
    if (!target || !shapeTypes.has(target.type) || target.type === "image" || target.type === "file") continue;
    target.meta = { ...(target.meta || {}), gradient: { ...preset, colors: [...preset.colors] } };
  }
  saveBoard();
  render();
}

function textForeignObject(element, className) {
  const fo = el("foreignObject", {
    x: 0,
    y: 0,
    width: Math.max(1, element.width),
    height: Math.max(1, element.height)
  });
  const div = document.createElement("div");
  div.className = className;
  div.style.fontSize = `${element.fontSize || 18}px`;
  div.style.fontFamily = element.fontFamily || "Inter, Arial, sans-serif";
  div.textContent = element.text || "";
  fo.append(div);
  return fo;
}

// Card renders a portrait header (2:3) on the board. Markdown body lives in the editor.
function cardForeignObject(element) {
  const fo = el("foreignObject", {
    x: 0,
    y: 0,
    width: Math.max(1, element.width),
    height: Math.max(1, element.height)
  });
  const body = document.createElement("div");
  body.className = "card-body card-portrait";
  const meta = element.meta || {};

  body.style.background = cssFill(element);
  const sw = Math.max(0, Number(element.strokeWidth) || 0);
  body.style.border = sw > 0 ? `${sw}px solid ${element.stroke || "#cbd5e1"}` : "none";
  body.style.borderRadius = "12px";

  const photo = document.createElement("div");
  photo.className = "card-portrait-photo";
  if (meta.image) {
    const img = document.createElement("img");
    img.src = meta.image;
    img.alt = "";
    img.draggable = false;
    photo.append(img);
  }
  body.append(photo);

  const info = document.createElement("div");
  info.className = "card-portrait-info";
  if (meta.title) {
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = meta.title;
    info.append(title);
  }
  if (meta.caption) {
    const caption = document.createElement("div");
    caption.className = "card-caption";
    caption.textContent = meta.caption;
    info.append(caption);
  }
  body.append(info);

  fo.append(body);
  return fo;
}

function renderCardMd(text) {
  if (window.md) return window.md.markdownToHtml(text);
  return escapeHtmlLite(text);
}

function escapeHtmlLite(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderOverlay() {
  const nodes = [];
  const selected = getSelected();
  const ids = selectedIds();
  if (state.tool === "line" || state.tool === "arrow" || state.action?.type === "draw-connector" || selected) {
    for (const element of state.board.elements) {
      if (!shapeTypes.has(element.type)) continue;
      if (state.tool === "select" && !ids.includes(element.id) && !state.action?.type?.includes("connector")) continue;
      nodes.push(...renderAnchors(element));
    }
  }
  if (state.action?.snap) nodes.push(renderSnapHint(state.action.snap));

  // marquee rectangle while rubber-band selecting
  if (state.action?.type === "marquee" && state.action.current) {
    const a = clientToOverlay(state.action.start);
    const b = clientToOverlay(state.action.current);
    nodes.push(el("rect", {
      class: "marquee",
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y)
    }));
  }

  // secondary selections: outline without handles (keeps the UX light)
  for (const id of state.selectedExtra) {
    const el2 = state.board.elements.find((e) => e.id === id);
    if (el2) nodes.push(...renderSecondarySelection(el2));
  }
  if (selected) nodes.push(...renderSelection(selected));
  return nodes;
}

function renderSecondarySelection(element) {
  const box = bounds(element);
  const a = worldToOverlay({ x: box.x, y: box.y });
  const b = worldToOverlay({ x: box.x + box.width, y: box.y + box.height });
  return [el("rect", {
    class: "selection-box",
    x: a.x,
    y: a.y,
    width: b.x - a.x,
    height: b.y - a.y
  })];
}

function renderSelection(element) {
  if (connectorTypes.has(element.type)) return renderConnectorSelection(element);
  const box = bounds(element);
  const a = worldToOverlay({ x: box.x, y: box.y });
  const b = worldToOverlay({ x: box.x + box.width, y: box.y + box.height });
  const width = b.x - a.x;
  const height = b.y - a.y;
  const nodes = [
    el("rect", {
      class: "selection-box",
      x: a.x,
      y: a.y,
      width,
      height
    })
  ];
  for (const handle of resizeHandlesFor(element)) {
    const p = handleScreenPoint(handle, a, b);
    const node = el("rect", {
      class: `resize-handle handle-${handle}`,
      x: p.x - 5,
      y: p.y - 5,
      width: 10,
      height: 10,
      "data-handle": handle
    });
    node.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      pushHistory();
      state.action = {
        type: "resize-box",
        id: element.id,
        handle,
        original: bounds(element)
      };
      svg.setPointerCapture(event.pointerId);
    });
    nodes.push(node);
  }
  return nodes;
}

function renderConnectorSelection(element) {
  const endpoints = connectorEndpoints(element);
  const route = element.meta?.route || "straight";
  let d;
  if (route === "curve") {
    const s = worldToOverlay(endpoints.start);
    const e = worldToOverlay(endpoints.end);
    const c = worldToOverlay(curveControlPoint(endpoints.start, endpoints.end));
    d = `M ${s.x} ${s.y} Q ${c.x} ${c.y} ${e.x} ${e.y}`;
  } else {
    const pts = pathPoints(endpoints.start, endpoints.end, route).map(worldToOverlay);
    d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  }
  const startPt = worldToOverlay(endpoints.start);
  const endPt = worldToOverlay(endpoints.end);
  const nodes = [
    el("path", {
      class: "selection-box connector-selection",
      d,
      fill: "none"
    })
  ];
  for (const [endName, point] of [["start", startPt], ["end", endPt]]) {
    const node = el("circle", {
      class: "endpoint-handle",
      cx: point.x,
      cy: point.y,
      r: 6,
      "data-end": endName
    });
    node.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      pushHistory();
      state.action = {
        type: "drag-endpoint",
        id: element.id,
        end: endName
      };
      clearBinding(element, endName);
      svg.setPointerCapture(event.pointerId);
    });
    nodes.push(node);
  }
  return nodes;
}

function renderAnchors(element) {
  return anchorPoints(element).map((anchor) => {
    const screen = worldToOverlay(anchor);
    const node = el("circle", {
      class: "anchor-point",
      cx: screen.x,
      cy: screen.y,
      r: anchor.name === "c" ? 4 : 5,
      "data-element-id": element.id,
      "data-anchor": anchor.name
    });
    node.addEventListener("pointerdown", (event) => {
      if (state.tool !== "line" && state.tool !== "arrow") return;
      event.stopPropagation();
      beginConnectorFromAnchor(event, element, anchor);
    });
    return node;
  });
}

function renderSnapHint(anchor) {
  const screen = worldToOverlay(anchor);
  return el("circle", {
    class: "snap-hint",
    cx: screen.x,
    cy: screen.y,
    r: 12
  });
}

function beginMove(event, element) {
  syncTouchPointer(event);
  if (state.editor) return;
  if (touchCount() >= 2) {
    event.stopPropagation();
    beginTouchPan();
    return;
  }
  if (isPanGesture(event)) {
    event.stopPropagation();
    startPan(event);
    return;
  }
  const tool = effectiveTool(event);
  if (event.button !== 0 || tool !== "select") return;
  event.preventDefault();
  event.stopPropagation();
  const isSelected = selectedIds().includes(element.id);
  if (event.shiftKey) {
    // toggle membership in the current selection
    if (isSelected) setSelection(selectedIds().filter((id) => id !== element.id));
    else setSelection([...selectedIds(), element.id]);
  } else if (!isSelected) {
    setSelection([element.id]);
  }
  pushHistory();
  const point = pointerWorld(event);
  const ids = selectedIds();
  state.action = {
    type: "move",
    ids,
    start: point,
    startScreen: { x: event.clientX, y: event.clientY },
    originals: Object.fromEntries(ids.map((id) => {
      const el = state.board.elements.find((e) => e.id === id);
      return [id, { x: el?.x || 0, y: el?.y || 0 }];
    })),
    clearConnectorBindings: ids.some((id) => connectorTypes.has((state.board.elements.find((e) => e.id === id) || {}).type)),
    openOnClick: effectiveTool(event) === "select" && (element.type === "file" || element.type === "card") && !event.shiftKey
  };
  svg.setPointerCapture(event.pointerId);
}

// Unified selection set: selectedId is the primary (for handles), the rest live
// in selectedExtra. Keeping a primary preserves the existing single-element UX.
function selectedIds() {
  const ids = [];
  if (state.selectedId) ids.push(state.selectedId);
  for (const id of state.selectedExtra) if (!ids.includes(id)) ids.push(id);
  return ids;
}

function setSelection(ids) {
  const unique = [];
  for (const id of ids) if (!unique.includes(id)) unique.push(id);
  state.selectedId = unique[0] || null;
  state.selectedExtra = unique.slice(1);
}

function onPointerDown(event) {
  if (state.editor) return;
  syncTouchPointer(event);
  if (touchCount() >= 2) {
    event.preventDefault();
    beginTouchPan();
    return;
  }
  if (isPanGesture(event)) {
    event.preventDefault();
    startPan(event);
    return;
  }
  if (event.button !== 0) return;
  const point = pointerWorld(event);
  const tool = effectiveTool(event);
  if (tool === "select") {
    if (event.detail >= 2 && isCanvasBackground(event.target)) {
      startPan(event);
      return;
    }
    state.action = {
      type: "marquee",
      start: { x: event.clientX, y: event.clientY },
      worldStart: point,
      shift: event.shiftKey,
      baseSelection: event.shiftKey ? selectedIds() : []
    };
    render();
    svg.setPointerCapture(event.pointerId);
    return;
  }
  if (tool === "line" || tool === "arrow") {
    pushHistory();
    beginConnector(point, event);
    return;
  }
  pushHistory();
  const element = createElement(state.tool, point);
  state.board.elements.push(element);
  setSelection([element.id]);
  if (state.tool === "card") {
    // cards drop at default size; drawing them by drag is awkward at small scale
    state.action = null;
    saveBoard();
    render();
    return;
  }
  if (state.tool === "pen") {
    state.action = { type: "draw-pen", id: element.id };
  } else {
    element.width = 1;
    element.height = 1;
    state.action = { type: "create-box", id: element.id, start: point };
  }
  svg.setPointerCapture(event.pointerId);
  render();
}

function beginConnectorFromAnchor(event, element, anchor) {
  pushHistory();
  beginConnector(anchor, event, { elementId: element.id, anchor: anchor.name });
}

function beginConnector(point, event, startBinding = null) {
  const snap = startBinding ? point : nearestAnchor(point);
  const start = snap || { ...point };
  const element = createElement(state.tool, start);
  element.x = start.x;
  element.y = start.y;
  element.width = 0;
  element.height = 0;
  element.meta = {
    ...element.meta,
    startBinding: startBinding || bindingFromAnchor(snap),
    endBinding: null
  };
  state.board.elements.push(element);
  setSelection([element.id]);
  state.action = {
    type: "draw-connector",
    id: element.id,
    start,
    startBinding: element.meta.startBinding,
    snap: null
  };
  svg.setPointerCapture(event.pointerId);
  render();
}

function onPointerMove(event) {
  syncTouchPointer(event);
  if (touchCount() >= 2 && state.action?.type !== "touch-pan") {
    beginTouchPan();
  }
  if (!state.action || state.editor) return;
  const point = pointerWorld(event);
  const action = state.action;
  if (action.type === "touch-pan") {
    const centroid = touchCentroid();
    state.view.x += centroid.x - action.lastCentroid.x;
    state.view.y += centroid.y - action.lastCentroid.y;
    action.lastCentroid = centroid;
    render();
    return;
  }
  if (action.type === "pan") {
    state.view.x = action.original.x + event.clientX - action.start.x;
    state.view.y = action.original.y + event.clientY - action.start.y;
    render();
    return;
  }
  if (action.type === "marquee") {
    action.current = { x: event.clientX, y: event.clientY };
    updateMarqueeSelection(point, action);
    render();
    return;
  }
  if (action.type === "move") {
    const dx = point.x - action.start.x;
    const dy = point.y - action.start.y;
    for (const id of action.ids) {
      const element = state.board.elements.find((e) => e.id === id);
      if (!element) continue;
      if (action.clearConnectorBindings && connectorTypes.has(element.type)) {
        element.meta = { ...element.meta, startBinding: null, endBinding: null };
      }
      const orig = action.originals[id] || action.original;
      element.x = orig.x + dx;
      element.y = orig.y + dy;
      refreshBoundConnectors(id);
    }
    action.clearConnectorBindings = false;
    render();
    return;
  }
  const element = state.board.elements.find((item) => item.id === action.id);
  if (!element) return;
  if (action.type === "create-box") {
    applyBox(element, boxFromPoints(action.start, point));
  } else if (action.type === "resize-box") {
    const aspect = elementAspectLock(element);
    const next = aspect
      ? resizedBoxAspect(action.original, action.handle, point, aspect)
      : resizedBox(action.original, action.handle, point);
    applyBox(element, next);
    refreshBoundConnectors(element.id);
  } else if (action.type === "draw-connector") {
    const snap = nearestAnchor(point, action.startBinding?.elementId || null);
    const end = snap || point;
    element.x = action.start.x;
    element.y = action.start.y;
    element.width = end.x - action.start.x;
    element.height = end.y - action.start.y;
    element.meta = {
      ...element.meta,
      startBinding: action.startBinding,
      endBinding: bindingFromAnchor(snap)
    };
    action.snap = snap;
  } else if (action.type === "drag-endpoint") {
    const otherEnd = action.end === "start" ? connectorEndpoints(element).end : connectorEndpoints(element).start;
    const snap = nearestAnchor(point);
    const next = snap || point;
    if (action.end === "start") {
      element.x = next.x;
      element.y = next.y;
      element.width = otherEnd.x - next.x;
      element.height = otherEnd.y - next.y;
    } else {
      element.width = next.x - element.x;
      element.height = next.y - element.y;
    }
    element.meta = {
      ...element.meta,
      [`${action.end}Binding`]: bindingFromAnchor(snap)
    };
    action.snap = snap;
  } else if (action.type === "draw-pen") {
    const last = element.points[element.points.length - 1];
    if (!last || Math.hypot(last.x - point.x + element.x, last.y - point.y + element.y) > 2) {
      element.points.push({ x: point.x - element.x, y: point.y - element.y });
    }
  }
  render();
}

function onPointerUp(event) {
  syncTouchPointer(event);
  if (state.action?.type === "touch-pan") {
    if (touchCount() < 2) {
      state.action = null;
      svg.classList.remove("panning");
      render();
    }
    return;
  }
  if (!state.action) return;
  if (state.action.type === "pan") {
    state.action = null;
    svg.classList.remove("panning");
    render();
    return;
  }
  if (state.action.type === "marquee") {
    // a click (no drag) clears selection; a drag already set it during move
    const dx = Math.abs(event.clientX - state.action.start.x);
    const dy = Math.abs(event.clientY - state.action.start.y);
    if (dx < 3 && dy < 3 && !state.action.shift) setSelection([]);
    state.action = null;
    render();
    return;
  }
  if (state.action.type === "move") {
    const action = state.action;
    for (const id of state.action.ids) {
      const el = state.board.elements.find((e) => e.id === id);
      if (el && connectorTypes.has(el.type)) refreshConnectorCoordinates(el);
    }
    const dx = Math.abs(event.clientX - action.startScreen.x);
    const dy = Math.abs(event.clientY - action.startScreen.y);
    if (action.openOnClick && dx < 3 && dy < 3 && action.ids.length === 1) {
      const target = state.board.elements.find((e) => e.id === action.ids[0]);
      if (target?.type === "file") openFileElement(target);
      else if (target?.type === "card") {
        Docs.openEditor(target);
        applyMode("editor");
      }
    }
  }
  const current = state.action.id ? state.board.elements.find((item) => item.id === state.action.id) : null;
  if (current?.type === "image") normalizeImageBox(current);
  if (current && connectorTypes.has(current.type)) refreshConnectorCoordinates(current);
  const shouldSave = shouldPersistAction(state.action, event);
  state.action = null;
  svg.classList.remove("panning");
  if (shouldSave) saveBoard();
  render();
}

function shouldPersistAction(action, event) {
  if (!action) return false;
  if (action.type === "move") {
    const dx = Math.abs(event.clientX - action.startScreen.x);
    const dy = Math.abs(event.clientY - action.startScreen.y);
    return dx >= 3 || dy >= 3;
  }
  return ["create-box", "resize-box", "draw-pen", "draw-connector", "drag-endpoint"].includes(action.type);
}

// Rubber-band: select every visible element whose bounding box intersects the marquee.
function updateMarqueeSelection(point, action) {
  const box = {
    x: Math.min(action.worldStart.x, point.x),
    y: Math.min(action.worldStart.y, point.y),
    width: Math.abs(point.x - action.worldStart.x),
    height: Math.abs(point.y - action.worldStart.y)
  };
  const hit = state.board.elements
    .filter((e) => visibleOnPlane(e))
    .map((e) => ({ id: e.id, b: marqueeHitBounds(e) }))
    .filter(({ b }) => b.x < box.x + box.width && b.x + b.width > box.x && b.y < box.y + box.height && b.y + b.height > box.y)
    .map(({ id }) => id);
  if (action.shift) {
    const set = new Set(action.baseSelection);
    for (const id of hit) set.add(id);
    setSelection([...set]);
  } else {
    setSelection(hit);
  }
}

function zoomAtWheelPointer(event) {
  const before = pointerWorld(event);
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  state.view.zoom = clamp(state.view.zoom * factor, 0.15, 4);
  const after = pointerWorld(event);
  state.view.x += (after.x - before.x) * state.view.zoom;
  state.view.y += (after.y - before.y) * state.view.zoom;
  render();
}

function onWheel(event) {
  if (state.editor) return;
  event.preventDefault();

  // Pinch-to-zoom on trackpad (Ctrl+scroll)
  if (event.ctrlKey || event.metaKey) {
    zoomAtWheelPointer(event);
    return;
  }

  // Two-finger trackpad scroll pans the plane
  const isPixel = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL;
  const hasHorizontal = Math.abs(event.deltaX) > 0;
  if (isPixel || hasHorizontal) {
    state.view.x -= event.deltaX;
    state.view.y -= event.deltaY;
    render();
    return;
  }

  // Mouse wheel: zoom
  zoomAtWheelPointer(event);
}

function onDoubleClick(event) {
  const group = event.target.closest?.(".element");
  if (!group) return;
  const element = state.board.elements.find((item) => item.id === group.dataset.id);
  if (!element) return;
  if (element.type === "card") {
    event.stopPropagation();
    Docs.openEditor(element);
    applyMode("editor");
    return;
  }
  if (element.type === "file") {
    event.stopPropagation();
    openFileElement(element);
    return;
  }
  if (!isTextEditable(element)) return;
  event.stopPropagation();
  beginTextEdit(element);
}

function beginTextEdit(element) {
  finishTextEdit(true);
  setSelection([element.id]);
  const editor = document.createElement("textarea");
  editor.className = "text-editor";
  editor.value = element.text || "";
  editor.spellcheck = false;
  editor.style.fontSize = `${element.fontSize || 18}px`;
  editor.style.fontFamily = element.fontFamily || "Inter, Arial, sans-serif";
  editor.addEventListener("pointerdown", (event) => event.stopPropagation());
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finishTextEdit(false);
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      finishTextEdit(true);
    }
  });
  editor.addEventListener("blur", () => finishTextEdit(true));
  document.body.append(editor);
  state.editor = { elementId: element.id, node: editor, originalText: element.text || "" };
  positionEditor();
  editor.focus();
  editor.select();
  render();
}

function finishTextEdit(save) {
  if (!state.editor) return;
  const { elementId, node, originalText } = state.editor;
  state.editor = null;
  const element = state.board.elements.find((item) => item.id === elementId);
  if (save && element && node.value !== originalText) {
    pushHistory();
    element.text = node.value;
    saveBoard();
  }
  node.remove();
  render();
}

function positionEditor() {
  if (!state.editor) return;
  const element = state.board.elements.find((item) => item.id === state.editor.elementId);
  if (!element) {
    finishTextEdit(false);
    return;
  }
  const box = bounds(element);
  const a = worldToScreen({ x: box.x, y: box.y });
  const b = worldToScreen({ x: box.x + box.width, y: box.y + box.height });
  const node = state.editor.node;
  node.style.left = `${a.x}px`;
  node.style.top = `${a.y}px`;
  node.style.width = `${Math.max(80, b.x - a.x)}px`;
  node.style.height = `${Math.max(40, b.y - a.y)}px`;
}

function createElement(type, point) {
  const def = defaults[type] || defaults.rect;
  const id = `${type}_${Math.random().toString(16).slice(2, 10)}`;
  const element = {
    id,
    type,
    x: point.x,
    y: point.y,
    width: def.width,
    height: def.height,
    rotation: 0,
    fill: def.fill ?? state.style.fill,
    stroke: type === "text" ? "transparent" : state.style.stroke,
    strokeWidth: 2,
    opacity: 1,
    text: def.text || "",
    fontSize: state.style.fontSize,
    fontFamily: "Inter, Arial, sans-serif",
    points: type === "pen" ? [{ x: 0, y: 0 }] : [],
    url: "",
    meta: type === "card" ? { title: "", caption: "", image: "" } : {}
  };
  if (type === "file") element.meta = { fileName: "", extension: "", sourceFile: "" };
  if (type === "image") {
    element.stroke = "transparent";
    element.strokeWidth = 0;
    element.meta = { sourceFile: "", fit: "contain" };
  }
  if (!["sticky", "frame", "text", "image", "card", "file"].includes(type)) element.fill = state.style.fill;
  if (connectorTypes.has(type) || type === "pen") {
    element.fill = "transparent";
    element.stroke = state.style.stroke;
  }
  if (def.strokeWidth != null) element.strokeWidth = def.strokeWidth;
  if (type === "card") element.height = element.width / CARD_ASPECT;
  return element;
}

function toggleImageFit() {
  const selected = getSelected();
  if (!selected || selected.type !== "image") return;
  pushHistory();
  const next = selected.meta?.fit === "stretch" ? "contain" : "stretch";
  selected.meta = { ...(selected.meta || {}), fit: next };
  saveBoard();
  render();
}

function applyStyle(patch) {
  const { clearGradient, ...stylePatch } = patch;
  Object.assign(state.style, stylePatch);
  const ids = selectedIds();
  if (!ids.length) return;
  pushHistory();
  for (const id of ids) {
    const target = state.board.elements.find((e) => e.id === id);
    if (!target) continue;
    Object.assign(target, stylePatch);
    if (clearGradient && target.meta?.gradient) {
      target.meta = { ...target.meta };
      delete target.meta.gradient;
    }
  }
  saveBoard();
  render();
}

function selectElement(id) {
  setSelection([id]);
  const selected = getSelected();
  if (selected) {
    state.style.fill = colorToInput(selected.fill, state.style.fill);
    state.style.stroke = colorToInput(selected.stroke, state.style.stroke);
    state.style.fontSize = selected.fontSize || state.style.fontSize;
  }
  render();
}

function getSelected() {
  return state.board.elements.find((element) => element.id === state.selectedId) || null;
}

function deleteSelected() {
  const ids = selectedIds();
  if (!ids.length) return;
  pushHistory();
  const doomed = new Set(ids);
  for (const element of state.board.elements) {
    if (!connectorTypes.has(element.type)) continue;
    if (doomed.has(element.meta?.startBinding?.elementId)) element.meta.startBinding = null;
    if (doomed.has(element.meta?.endBinding?.elementId)) element.meta.endBinding = null;
  }
  state.board.elements = state.board.elements.filter((element) => !doomed.has(element.id));
  setSelection([]);
  saveBoard();
  render();
}

function duplicateSelected() {
  const ids = selectedIds();
  if (!ids.length) return;
  pushHistory();
  const copies = [];
  for (const id of ids) {
    const src = state.board.elements.find((e) => e.id === id);
    if (!src) continue;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = `${copy.type}_${Math.random().toString(16).slice(2, 10)}`;
    copy.x += 24;
    copy.y += 24;
    if (connectorTypes.has(copy.type)) {
      copy.meta = { ...copy.meta, startBinding: null, endBinding: null };
    }
    state.board.elements.push(copy);
    copies.push(copy.id);
  }
  setSelection(copies);
  saveBoard();
  render();
}

function pushHistory() {
  state.history.push(JSON.stringify(state.board));
  if (state.history.length > 80) state.history.shift();
  state.future = [];
}

function undo() {
  if (!state.history.length) return;
  finishTextEdit(true);
  state.future.push(JSON.stringify(state.board));
  state.board = JSON.parse(state.history.pop());
  setSelection([]);
  saveBoard();
  render();
}

function redo() {
  if (!state.future.length) return;
  finishTextEdit(true);
  state.history.push(JSON.stringify(state.board));
  state.board = JSON.parse(state.future.pop());
  setSelection([]);
  saveBoard();
  render();
}

function saveBoard(options = {}) {
  if (state.boardKind === "server") return saveServerBoard(options);
  clearTimeout(state.dirtyTimer);
  if (!state.workspace?.boardFileHandle) {
    syncLabel.textContent = "Выберите папку";
    return Promise.resolve(null);
  }
  syncLabel.textContent = "Saving";
  const delay = options.immediate ? 0 : 120;
  return new Promise((resolve) => {
    state.dirtyTimer = setTimeout(async () => {
      state.dirtyTimer = null;
      try {
        state.board.elements.filter((element) => connectorTypes.has(element.type)).forEach(refreshConnectorCoordinates);
        await saveWorkspaceBoard();
        syncLabel.textContent = "Saved";
        resolve(state.board);
      } catch {
        syncLabel.textContent = "Folder error";
        resolve(null);
      }
    }, delay);
  });
}

async function saveWorkspaceBoard() {
  const dirHandle = state.workspace?.dirHandle;
  if (!dirHandle) return;
  let handle = state.workspace.boardFileHandle;
  if (!handle || handle.name !== PLANE_FILE) {
    handle = await dirHandle.getFileHandle(PLANE_FILE, { create: true });
    state.workspace.boardFileHandle = handle;
  }
  try {
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(serializeWorkspaceBoard(state.board), null, 2));
    await writable.close();
    state.lastLocalWrite = Date.now();
  } catch {
    syncLabel.textContent = "Folder error";
  }
}

function serializeWorkspaceBoard(board) {
  return {
    ...board,
    elements: board.elements.map((element) => {
      const copy = JSON.parse(JSON.stringify(element));
      if (copy.type === "image" && copy.meta?.sourceFile) copy.url = copy.meta.sourceFile;
      if (copy.type === "card" && copy.meta?.imageFile) copy.meta.image = copy.meta.imageFile;
      return copy;
    })
  };
}

async function saveWorkspaceCard(card) {
  const dirHandle = state.workspace?.dirHandle;
  if (!dirHandle || !card || card.type !== "card") return;
  const meta = card.meta || {};
  const fileName = meta.sourceFile || uniqueWorkspaceName(`${safeFileBase(meta.title || card.id || "card")}.md`);
  meta.sourceFile = fileName;
  let handle = state.workspace.fileHandles.get(fileName);
  if (!handle) {
    handle = await dirHandle.getFileHandle(fileName, { create: true });
    state.workspace.fileHandles.set(fileName, handle);
  }
  const writable = await handle.createWritable();
  await writable.write(cardToMarkdownFile(card));
  await writable.close();
  state.lastLocalWrite = Date.now();
}

function cardToMarkdownFile(card) {
  const meta = card.meta || {};
  const lines = ["---"];
  if (meta.title) lines.push(`title: ${JSON.stringify(meta.title)}`);
  if (meta.caption) lines.push(`caption: ${JSON.stringify(meta.caption)}`);
  if (meta.imageFile || meta.image) lines.push(`image: ${JSON.stringify(meta.imageFile || meta.image)}`);
  lines.push("---", "");
  return `${lines.join("\n")}${card.text || ""}\n`;
}

async function saveAssetFile(file) {
  const dirHandle = state.workspace?.dirHandle;
  if (!dirHandle || !file) return null;
  const fileName = uniqueWorkspaceName(file.name || `asset-${Date.now()}`);
  const handle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();
  state.workspace.fileHandles.set(fileName, handle);
  const savedFile = await handle.getFile();
  const url = URL.createObjectURL(savedFile);
  state.workspace.assetUrls.set(fileName, url);
  return { fileName, url };
}

function uniqueWorkspaceName(name) {
  const dirHandles = state.workspace?.fileHandles;
  const clean = sanitizeFileName(name || "file");
  if (!dirHandles || !dirHandles.has(clean)) return clean;
  const ext = clean.includes(".") ? clean.slice(clean.lastIndexOf(".")) : "";
  const base = ext ? clean.slice(0, -ext.length) : clean;
  let i = 2;
  while (dirHandles.has(`${base}-${i}${ext}`)) i++;
  return `${base}-${i}${ext}`;
}

function safeFileBase(name) {
  return sanitizeFileName(String(name || "card")).replace(/\.[^.]+$/, "").slice(0, 60) || "card";
}

function sanitizeFileName(name) {
  return String(name || "file").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "file";
}

async function openFileElement(element) {
  const sourceFile = element.meta?.sourceFile || element.meta?.fileName;
  let url = sourceFile ? state.workspace?.assetUrls?.get(sourceFile) : "";
  const handle = sourceFile ? state.workspace?.fileHandles?.get(sourceFile) : null;
  if (!url && handle) {
    const file = await handle.getFile();
    url = URL.createObjectURL(file);
    state.workspace.assetUrls.set(sourceFile, url);
  }
  if (url) window.open(url, "_blank", "noopener");
}

async function resetBoard() {
  if (!confirm("Clear the board?")) return;
  pushHistory();
  state.board = { version: 1, name: state.workspace?.dirHandle?.name || "Local folder", elements: [], selectedIds: [] };
  setSelection([]);
  saveBoard({ immediate: true });
  render();
}

async function handleImage() {
  const file = imageInput.files?.[0];
  if (!file) return;
  if (state.boardKind === "server") {
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const payload = await res.json();
      if (!res.ok || !payload.url) throw new Error("upload failed");
      pushHistory();
      const center = screenToWorld({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      const element = createElement("image", center);
      element.url = payload.url;
      element.text = payload.filename || file.name;
      element.meta = { ...(element.meta || {}), sourceFile: payload.filename || file.name };
      state.board.elements.push(element);
      setSelection([element.id]);
      await fitImageElement(element);
      saveBoard();
      render();
    } catch {
      alert("Не удалось загрузить изображение на серверную доску.");
    } finally {
      imageInput.value = "";
    }
    return;
  }
  const savedAsset = await saveAssetFile(file);
  if (!savedAsset) {
    alert("Сначала выберите рабочую папку через кнопку Файл.");
    imageInput.value = "";
    return;
  }
  pushHistory();
  const center = screenToWorld({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const element = createElement("image", center);
  element.url = savedAsset.url;
  element.text = savedAsset.fileName;
  element.meta = { ...(element.meta || {}), sourceFile: savedAsset.fileName };
  state.board.elements.push(element);
  setSelection([element.id]);
  await fitImageElement(element);
  saveBoard();
  render();
  imageInput.value = "";
}

function handleImport() {
  const file = importInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      pushHistory();
      const imported = JSON.parse(String(reader.result || "{}"));
      state.board = {
        version: imported.version || 1,
        name: imported.name || "Imported board",
        elements: Array.isArray(imported.elements) ? imported.elements : []
      };
      setSelection([]);
      saveBoard();
      render();
    } catch {
      alert("Invalid JSON");
    } finally {
      importInput.value = "";
    }
  };
  reader.readAsText(file);
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function connectorEndpoints(element) {
  const start = pointFromBinding(element.meta?.startBinding) || { x: element.x, y: element.y };
  const end = pointFromBinding(element.meta?.endBinding) || { x: element.x + element.width, y: element.y + element.height };
  return { start, end };
}

function refreshBoundConnectors(elementId) {
  for (const connector of state.board.elements) {
    if (!connectorTypes.has(connector.type)) continue;
    if (connector.meta?.startBinding?.elementId === elementId || connector.meta?.endBinding?.elementId === elementId) {
      refreshConnectorCoordinates(connector);
    }
  }
}

function refreshConnectorCoordinates(connector) {
  const endpoints = connectorEndpoints(connector);
  connector.x = endpoints.start.x;
  connector.y = endpoints.start.y;
  connector.width = endpoints.end.x - endpoints.start.x;
  connector.height = endpoints.end.y - endpoints.start.y;
}

function clearBinding(element, endName) {
  element.meta = {
    ...element.meta,
    [`${endName}Binding`]: null
  };
}

function nearestAnchor(point, excludeElementId = null) {
  let best = null;
  const maxDistance = snapScreenRadius / state.view.zoom;
  for (const element of state.board.elements) {
    if (!shapeTypes.has(element.type) || element.id === excludeElementId) continue;
    for (const anchor of anchorPoints(element)) {
      const distance = Math.hypot(anchor.x - point.x, anchor.y - point.y);
      if (distance <= maxDistance && (!best || distance < best.distance)) {
        best = { ...anchor, distance };
      }
    }
  }
  return best;
}

function bindingFromAnchor(anchor) {
  if (!anchor?.elementId || !anchor?.name) return null;
  return { elementId: anchor.elementId, anchor: anchor.name };
}

function pointFromBinding(binding) {
  if (!binding?.elementId || !binding?.anchor) return null;
  const element = state.board.elements.find((item) => item.id === binding.elementId);
  if (!element) return null;
  return anchorPoints(element).find((anchor) => anchor.name === binding.anchor) || null;
}

function anchorPoints(element) {
  const box = bounds(element);
  const x = box.x;
  const y = box.y;
  const w = box.width;
  const h = box.height;
  const map = {
    nw: { x, y },
    n: { x: x + w / 2, y },
    ne: { x: x + w, y },
    e: { x: x + w, y: y + h / 2 },
    se: { x: x + w, y: y + h },
    s: { x: x + w / 2, y: y + h },
    sw: { x, y: y + h },
    w: { x, y: y + h / 2 },
    c: { x: x + w / 2, y: y + h / 2 }
  };
  return anchorNames.map((name) => ({ ...map[name], name, elementId: element.id }));
}

function applyBox(element, box) {
  element.x = box.x;
  element.y = box.y;
  element.width = box.width;
  element.height = box.height;
}

function boxFromPoints(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.max(minSize, Math.abs(b.x - a.x)),
    height: Math.max(minSize, Math.abs(b.y - a.y))
  };
}

function resizedBox(original, handle, point) {
  let left = original.x;
  let right = original.x + original.width;
  let top = original.y;
  let bottom = original.y + original.height;
  if (handle.includes("w")) left = point.x;
  if (handle.includes("e")) right = point.x;
  if (handle.includes("n")) top = point.y;
  if (handle.includes("s")) bottom = point.y;
  if (right - left < minSize) {
    if (handle.includes("w")) left = right - minSize;
    else right = left + minSize;
  }
  if (bottom - top < minSize) {
    if (handle.includes("n")) top = bottom - minSize;
    else bottom = top + minSize;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function resizedBoxAspect(original, handle, point, ratio) {
  const fixedX = handle.includes("w") ? original.x + original.width : original.x;
  const fixedY = handle.includes("n") ? original.y + original.height : original.y;
  let width = Math.abs(point.x - fixedX);
  let height = Math.abs(point.y - fixedY);
  if (width / Math.max(height, 0.001) > ratio) width = height * ratio;
  else height = width / ratio;
  width = Math.max(minSize, width);
  height = Math.max(minSize / ratio, height);
  width = height * ratio;
  const x = handle.includes("w") ? fixedX - width : fixedX;
  const y = handle.includes("n") ? fixedY - height : fixedY;
  return { x, y, width, height };
}

function handleScreenPoint(handle, a, b) {
  const x = handle.includes("w") ? a.x : handle.includes("e") ? b.x : (a.x + b.x) / 2;
  const y = handle.includes("n") ? a.y : handle.includes("s") ? b.y : (a.y + b.y) / 2;
  return { x, y };
}

function isTextEditable(element) {
  return ["text", "sticky", "frame", "rect", "ellipse", "diamond"].includes(element.type);
}

function pointerWorld(event) {
  return screenToWorld({ x: event.clientX, y: event.clientY });
}

function screenToWorld(point) {
  const rect = svg.getBoundingClientRect();
  return {
    x: (point.x - rect.left - state.view.x) / state.view.zoom,
    y: (point.y - rect.top - state.view.y) / state.view.zoom
  };
}

function worldToScreen(point) {
  const rect = svg.getBoundingClientRect();
  return {
    x: rect.left + state.view.x + point.x * state.view.zoom,
    y: rect.top + state.view.y + point.y * state.view.zoom
  };
}

function worldToOverlay(point) {
  return {
    x: state.view.x + point.x * state.view.zoom,
    y: state.view.y + point.y * state.view.zoom
  };
}

function clientToOverlay(point) {
  const rect = svg.getBoundingClientRect();
  return {
    x: point.x - rect.left,
    y: point.y - rect.top
  };
}

function bounds(element) {
  if (element.type === "image") {
    const inner = imageDisplayRect(element);
    return {
      x: element.x + inner.x,
      y: element.y + inner.y,
      width: inner.width,
      height: inner.height
    };
  }
  if (connectorTypes.has(element.type)) {
    const endpoints = connectorEndpoints(element);
    return {
      x: Math.min(endpoints.start.x, endpoints.end.x),
      y: Math.min(endpoints.start.y, endpoints.end.y),
      width: Math.max(1, Math.abs(endpoints.end.x - endpoints.start.x)),
      height: Math.max(1, Math.abs(endpoints.end.y - endpoints.start.y))
    };
  }
  if (element.type === "pen") {
    const points = element.points || [];
    if (!points.length) return { x: element.x, y: element.y, width: 1, height: 1 };
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      x: element.x + minX,
      y: element.y + minY,
      width: Math.max(1, Math.max(...xs) - minX),
      height: Math.max(1, Math.max(...ys) - minY)
    };
  }
  return {
    x: element.x,
    y: element.y,
    width: Math.max(1, element.width),
    height: Math.max(1, element.height)
  };
}

function marqueeHitBounds(element) {
  const box = bounds(element);
  if (!connectorTypes.has(element.type)) return box;
  const pad = Math.max(8, (Number(element.strokeWidth) || 2) * 2);
  return {
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2
  };
}

function pointsToPath(points) {
  if (!points.length) return "";
  return points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
}

function colorToInput(color, fallback) {
  return /^#[0-9a-f]{6}$/i.test(color || "") ? color : fallback;
}

function el(name, attrs = {}) {
  const node = document.createElementNS(svgns, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
