// Agent UI: side chat panel (general + per-agent channels, target a specific
// agent or run several) and the provider settings modal.
//
// The panel talks to the agent backend over REST:
//   GET    /api/chat?channel=...        — read messages
//   POST   /api/chat                    — append a message
//   POST   /api/agents/run              — kick off an agent run (async)
//   GET    /api/providers               — list (masked keys)
//   PUT    /api/providers               — save
//   POST   /api/providers/test          — connectivity probe
// Live updates arrive via the SSE events "chat:message" (a new message) and the
// board reload (agent status badge) wired in app.js.

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const App = () => window.App;

  const panel = () => $("#agentPanel");
  const logEl = () => $("#agentLog");
  const channelsEl = () => $("#agentChannels");
  const pickRow = () => $("#agentPickRow");
  const targetSelect = () => $("#agentTargetSelect");
  const composeInput = () => $("#agentComposeInput");
  const settingsModal = () => $("#settingsModal");

  // Active channel: "general", "*", or an agent element id.
  let activeChannel = "general";
  // Agent ids selected for multi-run from the pick row.
  let pickedAgentIds = new Set();
  // Cache of provider settings being edited in the modal.
  let editProviders = [];
  let editActiveId = "";

  function init() {
    $("#agentsChatBtn")?.addEventListener("click", () => toggleChat());
    $("#agentCloseBtn")?.addEventListener("click", () => closeChat());
    $("#agentRefreshBtn")?.addEventListener("click", () => refresh());
    $("#agentCompose")?.addEventListener("submit", (e) => { e.preventDefault(); send(); });

    $("#settingsBtn")?.addEventListener("click", () => openSettings());
    $("#settingsModalClose")?.addEventListener("click", () => closeSettings());
    settingsModal()?.addEventListener("mousedown", (e) => { if (e.target === settingsModal()) closeSettings(); });
    $("#settingsAddProviderBtn")?.addEventListener("click", () => addProviderRow());
    $("#settingsApply")?.addEventListener("click", () => saveSettings());

    // Poll chat periodically as a fallback when SSE isn't connected.
    setInterval(() => { if (!panel()?.hidden) refresh(); }, 4000);
  }

  // ---------- chat panel ----------
  function toggleChat() {
    const p = panel();
    if (!p) return;
    p.hidden = !p.hidden;
    if (!p.hidden) { renderChannels(); refresh(); composeInput()?.focus(); }
  }

  function closeChat() {
    const p = panel();
    if (p) p.hidden = true;
  }

  // Clicking an agent element on the canvas opens the panel on that agent's channel.
  function openChatFor(agentId) {
    const p = panel();
    if (!p) return;
    p.hidden = false;
    activeChannel = agentId || "general";
    renderChannels();
    refresh();
    composeInput()?.focus();
  }

  function renderChannels() {
    const host = channelsEl();
    if (!host) return;
    host.innerHTML = "";
    const agents = getAgents();
    const make = (channel, label) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "agent-channel" + (channel === activeChannel ? " active" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => { activeChannel = channel; renderChannels(); refresh(); });
      return btn;
    };
    host.append(make("general", "Общий"));
    host.append(make("*", "Все"));
    for (const a of agents) host.append(make(a.id, a.meta?.name || "Agent"));

    renderAgentPick(agents);

    const sel = targetSelect();
    if (sel) {
      sel.innerHTML = "";
      const optAll = document.createElement("option");
      optAll.value = "all"; optAll.textContent = "▶ Запустить всех";
      sel.append(optAll);
      const optSel = document.createElement("option");
      optSel.value = "selected"; optSel.textContent = "▶ Запустить выбранных";
      sel.append(optSel);
      const optGen = document.createElement("option");
      optGen.value = "general"; optGen.textContent = "Общий чат";
      sel.append(optGen);
      for (const a of agents) {
        const o = document.createElement("option");
        o.value = a.id; o.textContent = a.meta?.name || "Agent";
        sel.append(o);
      }
      if (activeChannel !== "general" && activeChannel !== "*") sel.value = activeChannel;
      else sel.value = "general";
    }
  }

  function renderAgentPick(agents) {
    const row = pickRow();
    if (!row) return;
    if (!agents.length) {
      row.hidden = true;
      row.innerHTML = "";
      return;
    }
    row.hidden = false;
    row.innerHTML = "";
    const label = document.createElement("span");
    label.className = "agent-pick-label";
    label.textContent = "Агенты:";
    row.append(label);
    for (const a of agents) {
      const wrap = document.createElement("label");
      wrap.className = "agent-pick-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = a.id;
      cb.checked = pickedAgentIds.has(a.id);
      cb.addEventListener("change", () => {
        if (cb.checked) pickedAgentIds.add(a.id);
        else pickedAgentIds.delete(a.id);
      });
      wrap.append(cb, document.createTextNode(a.meta?.name || "Agent"));
      row.append(wrap);
    }
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "agent-pick-all";
    allBtn.textContent = "Все";
    allBtn.addEventListener("click", () => {
      for (const a of agents) pickedAgentIds.add(a.id);
      renderAgentPick(agents);
    });
    row.append(allBtn);
  }

  function getAgents() {
    return App()?.getAgents?.() || [];
  }

  async function refresh() {
    renderChannels();
    try {
      const res = await fetch(`/api/chat?channel=${encodeURIComponent(activeChannel)}`, { cache: "no-store" });
      if (!res.ok) return;
      const payload = await res.json();
      renderLog(payload.messages || []);
    } catch { /* server offline */ }
  }

  function renderLog(messages) {
    const host = logEl();
    if (!host) return;
    host.innerHTML = "";
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "chat-empty";
      empty.textContent = activeChannel === "general"
        ? "Общий чат пуст. Напишите сообщение или инструкцию агенту."
        : activeChannel === "*"
          ? "Пока нет сообщений ни в одном канале."
          : "Нет сообщений с этим агентом.";
      host.append(empty);
      return;
    }
    for (const m of messages) host.append(renderMessage(m));
    host.scrollTop = host.scrollHeight;
  }

  function renderMessage(m) {
    const node = document.createElement("div");
    node.className = `chat-msg role-${m.role || "user"}`;
    const meta = document.createElement("div");
    meta.className = "cm-meta";
    const channelLabel = m.channel && m.channel !== "general" ? ` · #${agentName(m.channel) || m.channel}` : "";
    const who = m.role === "agent"
      ? (agentName(m.author) || "Agent")
      : (m.author || "вы");
    const time = new Date(m.ts || Date.now()).toLocaleTimeString();
    meta.textContent = `${who}${channelLabel} · ${time}`;
    const text = document.createElement("div");
    text.className = "cm-text";
    text.textContent = m.text || "";
    node.append(meta, text);
    return node;
  }

  function agentName(id) {
    const a = getAgents().find((x) => x.id === id);
    return a?.meta?.name || id || "";
  }

  // New message arrived via SSE — refresh if it belongs to the active channel.
  function onChatMessage(msg) {
    if (!panel()?.hidden && msg && (msg.channel === activeChannel || activeChannel === "*")) refresh();
  }

  async function send() {
    const input = composeInput();
    const text = (input?.value || "").trim();
    if (!text) return;
    const target = targetSelect()?.value || "general";
    input.value = "";

    if (target === "all") {
      await postMessage("general", "user", "me", text);
      const agents = getAgents();
      for (const a of agents) await runAgent(a.id, text);
      activeChannel = "general";
      renderChannels();
      refresh();
      return;
    }
    if (target === "selected") {
      await postMessage("general", "user", "me", text);
      const ids = pickedAgentIds.size ? [...pickedAgentIds] : getAgents().map((a) => a.id);
      for (const id of ids) await runAgent(id, text);
      activeChannel = "general";
      renderChannels();
      refresh();
      return;
    }
    if (target === "general") {
      await postMessage("general", "user", "me", text);
      activeChannel = "general";
      refresh();
      return;
    }
    await postMessage(target, "user", "me", text);
    activeChannel = target;
    renderChannels();
    refresh();
    await runAgent(target, text);
  }

  async function postMessage(channel, role, author, text) {
    try {
      await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, role, author, text })
      });
    } catch { /* ignore */ }
  }

  async function runAgent(agentId, input, { withSnapshot = false } = {}) {
    const body = { agentId, input };
    if (withSnapshot) {
      const agent = getAgents().find((a) => a.id === agentId);
      const images = App()?.captureFieldSnapshot?.(agent) || [];
      if (images.length) body.images = images;
    }
    try {
      await fetch("/api/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch { /* ignore */ }
  }

  // ---------- provider settings modal ----------
  async function openSettings() {
    const m = settingsModal();
    if (!m) return;
    await loadProviders();
    renderProviderRows();
    m.hidden = false;
  }

  function closeSettings() {
    settingsModal()?.setAttribute("hidden", "");
  }

  async function loadProviders() {
    try {
      const res = await fetch("/api/providers", { cache: "no-store" });
      const data = await res.json();
      editProviders = (data.providers || []).map((p) => ({ ...p }));
      editActiveId = data.activeId || (editProviders[0]?.id || "");
    } catch {
      editProviders = [];
      editActiveId = "";
    }
  }

  function renderProviderRows() {
    const host = $("#settingsProviders");
    host.innerHTML = "";
    if (!editProviders.length) {
      const empty = document.createElement("p");
      empty.className = "modal-hint";
      empty.textContent = "Провайдеров пока нет. Нажмите «+ Добавить провайдер».";
      host.append(empty);
    }
    for (const p of editProviders) host.append(providerRow(p));
    const sel = $("#settingsActiveSelect");
    sel.innerHTML = "";
    for (const p of editProviders) {
      const o = document.createElement("option");
      o.value = p.id; o.textContent = p.name || p.id;
      sel.append(o);
    }
    sel.value = editActiveId;
  }

  function providerRow(p) {
    const row = document.createElement("div");
    row.className = "provider-row";
    row.dataset.id = p.id;

    const kind = document.createElement("select");
    for (const k of ["openai", "anthropic", "codex"]) {
      const o = document.createElement("option");
      o.value = k; o.textContent = k; if (p.kind === k) o.selected = true;
      kind.append(o);
    }
    kind.addEventListener("change", () => { p.kind = kind.value; });
    row.append(kind);

    const name = document.createElement("input");
    name.type = "text"; name.placeholder = "Название"; name.value = p.name || "";
    name.addEventListener("input", () => { p.name = name.value; });
    row.append(name);

    const baseUrl = document.createElement("input");
    baseUrl.type = "text"; baseUrl.placeholder = "Base URL (оставьте пустым для дефолта)";
    baseUrl.value = p.baseUrl || "";
    baseUrl.addEventListener("input", () => { p.baseUrl = baseUrl.value; });
    row.append(baseUrl);

    const apiKey = document.createElement("input");
    apiKey.type = "password"; apiKey.placeholder = "API key / OAuth token";
    apiKey.value = p.apiKey && !isMasked(p.apiKey) ? p.apiKey : "";
    apiKey.dataset.masked = isMasked(p.apiKey) ? "1" : "0";
    if (isMasked(p.apiKey)) apiKey.placeholder = `${p.apiKey} (не изменён)`;
    apiKey.addEventListener("input", () => { p.apiKey = apiKey.value; apiKey.dataset.masked = "0"; });
    row.append(apiKey);

    const model = document.createElement("input");
    model.type = "text"; model.placeholder = "Модель (например gpt-4o-mini)";
    model.style.gridColumn = "1 / 3";
    model.value = p.model || "";
    model.addEventListener("input", () => { p.model = model.value; });
    row.append(model);

    const testBtn = document.createElement("button");
    testBtn.type = "button"; testBtn.textContent = "Тест"; testBtn.style.gridColumn = "3 / 4";
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true; testBtn.textContent = "…";
      try {
        const res = await fetch("/api/providers/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...p })
        });
        const r = await res.json();
        alert(r.ok ? `OK: ${r.content || "(пустой ответ)"}` : `Ошибка: ${r.error}`);
      } catch (e) { alert(`Ошибка: ${e.message}`); }
      finally { testBtn.disabled = false; testBtn.textContent = "Тест"; }
    });
    row.append(testBtn);

    const del = document.createElement("button");
    del.type = "button"; del.className = "prov-del"; del.textContent = "Удалить провайдер";
    del.addEventListener("click", () => {
      editProviders = editProviders.filter((x) => x.id !== p.id);
      if (editActiveId === p.id) editActiveId = editProviders[0]?.id || "";
      renderProviderRows();
    });
    row.append(del);

    return row;
  }

  function addProviderRow() {
    const id = `prov_${Date.now().toString(36)}`;
    editProviders.push({ id, kind: "openai", name: "Новый провайдер", baseUrl: "", apiKey: "", model: "" });
    if (!editActiveId) editActiveId = id;
    renderProviderRows();
  }

  async function saveSettings() {
    editActiveId = $("#settingsActiveSelect")?.value || "";
    try {
      const res = await fetch("/api/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: editProviders, activeId: editActiveId })
      });
      if (res.ok) {
        closeSettings();
      } else {
        const e = await res.json().catch(() => ({}));
        alert(`Не удалось сохранить: ${e.error || res.status}`);
      }
    } catch (e) { alert(`Ошибка сохранения: ${e.message}`); }
  }

  function isMasked(key) {
    return typeof key === "string" && /^[•x]{2,}…[•x]{2,}$/.test(key);
  }

  window.Agents = Object.assign(window.Agents || {}, {
    init,
    toggleChat,
    closeChat,
    openChatFor,
    onChatMessage,
    openSettings,
    refresh,
    runAgent
  });
  document.addEventListener("DOMContentLoaded", init);
})();
