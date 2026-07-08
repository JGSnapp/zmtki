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
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const App = () => window.App;

  const panel = () => $("#agentPanel");
  const logEl = () => $("#agentLog");
  const channelsEl = () => $("#agentChannels");
  const pickRow = () => $("#agentPickRow");
  const targetSelect = () => $("#agentTargetSelect");
  const composeInput = () => $("#agentComposeInput");
  const composeSnapshot = () => $("#agentComposeSnapshot");
  const managerList = () => $("#agentManagerList");
  const editorEmpty = () => $("#agentEditorEmpty");
  const editorForm = () => $("#agentEditorForm");

  let activeChannel = "general";
  let activeTab = "chat";
  let editingAgentId = "";
  let pickedAgentIds = new Set();
  let editProviders = [];
  let editActiveId = "";

  function init() {
    $("#agentsChatBtn")?.addEventListener("click", () => openPanel("chat"));
    $("#agentCloseBtn")?.addEventListener("click", closePanel);
    $("#agentRefreshBtn")?.addEventListener("click", refresh);
    $("#agentCompose")?.addEventListener("submit", (e) => { e.preventDefault(); send(); });
    $("#settingsBtn")?.addEventListener("click", () => openSettings());
    $("#settingsAddProviderBtn")?.addEventListener("click", addProviderRow);
    $("#settingsApply")?.addEventListener("click", saveSettings);
    $$("[data-agent-panel-tab]").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.agentPanelTab));
    });

    bindAgentEditor();
    setInterval(() => { if (!panel()?.hidden) refresh(); }, 4000);
  }

  function bindAgentEditor() {
    const patch = (field, value) => {
      if (!editingAgentId) return;
      App()?.updateAgentMeta?.(editingAgentId, { [field]: value });
      renderAgentManager();
    };
    $("#agentPanelName")?.addEventListener("change", (e) => patch("name", e.target.value));
    $("#agentPanelRole")?.addEventListener("change", (e) => patch("role", e.target.value));
    $("#agentPanelDescription")?.addEventListener("change", (e) => patch("description", e.target.value));
    $("#agentPanelRegionTopic")?.addEventListener("change", (e) => patch("regionTopic", e.target.value));
    $("#agentPanelProvider")?.addEventListener("change", (e) => patch("providerId", e.target.value));
    $("#agentPanelModel")?.addEventListener("change", (e) => patch("model", e.target.value));
    $("#agentPanelPrompt")?.addEventListener("change", (e) => patch("systemPrompt", e.target.value));
    $("#agentPanelFieldVisible")?.addEventListener("change", (e) => patch("fieldVisible", e.target.checked));
    $("#agentPanelFocus")?.addEventListener("click", () => {
      if (!editingAgentId) return;
      App()?.selectElement?.(editingAgentId);
    });
    $("#agentPanelOpenChat")?.addEventListener("click", () => {
      if (!editingAgentId) return;
      openChatFor(editingAgentId);
    });
  }

  function openPanel(tab = "chat") {
    const p = panel();
    if (!p) return;
    p.hidden = false;
    switchTab(tab);
    renderChannels();
    renderAgentManager();
    refresh();
    composeInput()?.focus();
  }

  function closePanel() {
    if (panel()) panel().hidden = true;
  }

  function switchTab(tab) {
    activeTab = tab || "chat";
    $$("[data-agent-panel-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.agentPanelTab === activeTab);
    });
    $$("[data-agent-panel-section]").forEach((section) => {
      section.classList.toggle("active", section.dataset.agentPanelSection === activeTab);
    });
    if (activeTab === "providers") {
      loadProviders().then(renderProviderRows);
    }
    if (activeTab === "agents") {
      renderAgentManager();
    }
  }

  function toggleChat() {
    if (panel()?.hidden) openPanel("chat");
    else closePanel();
  }

  function openChatFor(agentId) {
    activeChannel = agentId || "general";
    if (agentId) editingAgentId = agentId;
    openPanel("chat");
  }

  function openSettings() {
    openPanel("providers");
  }

  function getAgents() {
    return App()?.getAgents?.() || [];
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
      btn.addEventListener("click", () => {
        activeChannel = channel;
        renderChannels();
        refresh();
      });
      return btn;
    };
    host.append(make("general", "Общий"));
    host.append(make("*", "Все"));
    for (const a of agents) host.append(make(a.id, a.meta?.name || "Agent"));

    renderAgentPick(agents);

    const sel = targetSelect();
    if (!sel) return;
    sel.innerHTML = "";
    [
      ["all", "▶ Запустить всех"],
      ["selected", "▶ Запустить выбранных"],
      ["general", "Общий чат"]
    ].forEach(([value, label]) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      sel.append(o);
    });
    for (const a of agents) {
      const o = document.createElement("option");
      o.value = a.id;
      o.textContent = a.meta?.name || "Agent";
      sel.append(o);
    }
    sel.value = activeChannel !== "general" && activeChannel !== "*" ? activeChannel : "general";
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
    label.textContent = "Выбранные агенты:";
    row.append(label);
    for (const a of agents) {
      const wrap = document.createElement("label");
      wrap.className = "agent-pick-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
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
      pickedAgentIds = new Set(agents.map((a) => a.id));
      renderAgentPick(agents);
    });
    row.append(allBtn);
  }

  function renderAgentManager() {
    const host = managerList();
    if (!host) return;
    const agents = getAgents();
    if (!editingAgentId && agents.length) {
      editingAgentId = agents[0].id;
    }
    if (editingAgentId && !agents.some((a) => a.id === editingAgentId)) {
      editingAgentId = agents[0]?.id || "";
    }
    host.innerHTML = "";
    for (const agent of agents) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "agent-manager-card" + (agent.id === editingAgentId ? " active" : "");
      card.addEventListener("click", () => {
        editingAgentId = agent.id;
        App()?.selectElement?.(agent.id);
        renderAgentManager();
      });
      const title = document.createElement("div");
      title.className = "agent-manager-title";
      title.textContent = agent.meta?.name || "Agent";
      const meta = document.createElement("div");
      meta.className = "agent-manager-meta";
      meta.textContent = [agent.meta?.role, agent.meta?.regionTopic, agent.meta?.status].filter(Boolean).join(" · ");
      card.append(title, meta);
      host.append(card);
    }
    syncAgentEditor();
  }

  function syncAgentEditor() {
    const agent = editingAgentId ? App()?.getAgentById?.(editingAgentId) : null;
    editorEmpty().hidden = !!agent;
    editorForm().hidden = !agent;
    if (!agent) return;

    $("#agentPanelName").value = agent.meta?.name || "";
    $("#agentPanelRole").value = agent.meta?.role || "";
    $("#agentPanelDescription").value = agent.meta?.description || "";
    $("#agentPanelRegionTopic").value = agent.meta?.regionTopic || "";
    $("#agentPanelModel").value = agent.meta?.model || "";
    $("#agentPanelPrompt").value = agent.meta?.systemPrompt || "";
    $("#agentPanelFieldVisible").checked = agent.meta?.fieldVisible !== false;

    ensureProvidersForAgentEditor(agent.meta?.providerId || "");
  }

  async function ensureProvidersForAgentEditor(selectedId = "") {
    await loadProviders();
    const sel = $("#agentPanelProvider");
    if (!sel) return;
    sel.innerHTML = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "Провайдер по умолчанию";
    sel.append(def);
    for (const p of editProviders) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name || p.id;
      sel.append(o);
    }
    sel.value = selectedId;
  }

  async function refresh() {
    renderChannels();
    renderAgentManager();
    try {
      const res = await fetch(`/api/chat?channel=${encodeURIComponent(activeChannel)}`, { cache: "no-store" });
      if (!res.ok) return;
      const payload = await res.json();
      renderLog(payload.messages || []);
    } catch {}
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
    const who = m.role === "agent" ? (agentName(m.author) || "Agent") : (m.author || "вы");
    meta.textContent = `${who}${channelLabel} · ${new Date(m.ts || Date.now()).toLocaleTimeString()}`;
    const text = document.createElement("div");
    text.className = "cm-text";
    text.textContent = m.text || "";
    node.append(meta, text);
    return node;
  }

  function agentName(id) {
    return getAgents().find((x) => x.id === id)?.meta?.name || id || "";
  }

  function onChatMessage(msg) {
    if (!panel()?.hidden && msg && (msg.channel === activeChannel || activeChannel === "*")) refresh();
  }

  async function send() {
    const input = composeInput();
    const text = (input?.value || "").trim();
    if (!text) return;
    const target = targetSelect()?.value || "general";
    const withSnapshot = !!composeSnapshot()?.checked;
    input.value = "";

    if (target === "all") {
      await postMessage("general", "user", "me", text);
      for (const a of getAgents()) await runAgent(a.id, text, { withSnapshot });
      activeChannel = "general";
      return refresh();
    }
    if (target === "selected") {
      await postMessage("general", "user", "me", text);
      const ids = pickedAgentIds.size ? [...pickedAgentIds] : getAgents().map((a) => a.id);
      for (const id of ids) await runAgent(id, text, { withSnapshot });
      activeChannel = "general";
      return refresh();
    }
    if (target === "general") {
      await postMessage("general", "user", "me", text);
      activeChannel = "general";
      return refresh();
    }
    await postMessage(target, "user", "me", text);
    activeChannel = target;
    await refresh();
    await runAgent(target, text, { withSnapshot });
  }

  async function postMessage(channel, role, author, text) {
    try {
      await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, role, author, text })
      });
    } catch {}
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
    } catch {}
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
    if (!host) return;
    host.innerHTML = "";
    if (!editProviders.length) {
      const empty = document.createElement("p");
      empty.className = "modal-hint";
      empty.textContent = "Провайдеров пока нет. Добавьте первый провайдер ниже.";
      host.append(empty);
    }
    for (const p of editProviders) host.append(providerRow(p));
    const sel = $("#settingsActiveSelect");
    if (sel) {
      sel.innerHTML = "";
      for (const p of editProviders) {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name || p.id;
        sel.append(o);
      }
      sel.value = editActiveId;
    }
  }

  function providerRow(p) {
    const row = document.createElement("div");
    row.className = "provider-row";

    const kind = document.createElement("select");
    for (const k of ["openai", "anthropic", "codex"]) {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = k;
      if (p.kind === k) o.selected = true;
      kind.append(o);
    }
    kind.addEventListener("change", () => { p.kind = kind.value; });
    row.append(kind);

    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = "Название";
    name.value = p.name || "";
    name.addEventListener("input", () => { p.name = name.value; });
    row.append(name);

    const baseUrl = document.createElement("input");
    baseUrl.type = "text";
    baseUrl.placeholder = "Base URL";
    baseUrl.value = p.baseUrl || "";
    baseUrl.addEventListener("input", () => { p.baseUrl = baseUrl.value; });
    row.append(baseUrl);

    const apiKey = document.createElement("input");
    apiKey.type = "password";
    apiKey.placeholder = "API key / OAuth token";
    apiKey.value = p.apiKey && !isMasked(p.apiKey) ? p.apiKey : "";
    apiKey.dataset.masked = isMasked(p.apiKey) ? "1" : "0";
    if (isMasked(p.apiKey)) apiKey.placeholder = `${p.apiKey} (не изменён)`;
    apiKey.addEventListener("input", () => { p.apiKey = apiKey.value; apiKey.dataset.masked = "0"; });
    row.append(apiKey);

    const model = document.createElement("input");
    model.type = "text";
    model.placeholder = "Модель (например gpt-4o-mini)";
    model.style.gridColumn = "1 / 3";
    model.value = p.model || "";
    model.addEventListener("input", () => { p.model = model.value; });
    row.append(model);

    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.textContent = "Тест";
    testBtn.style.gridColumn = "3 / 4";
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      testBtn.textContent = "…";
      try {
        const res = await fetch("/api/providers/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...p })
        });
        const r = await res.json();
        alert(r.ok ? `OK: ${r.content || "(пустой ответ)"}` : `Ошибка: ${r.error}`);
      } catch (e) {
        alert(`Ошибка: ${e.message}`);
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "Тест";
      }
    });
    row.append(testBtn);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "prov-del";
    del.textContent = "Удалить провайдер";
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
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(`Не удалось сохранить: ${e.error || res.status}`);
        return;
      }
      await loadProviders();
      App()?.setAgentProviders?.(editProviders);
      renderProviderRows();
      renderAgentManager();
    } catch (e) {
      alert(`Ошибка сохранения: ${e.message}`);
    }
  }

  function isMasked(key) {
    return typeof key === "string" && /^[•x]{2,}…[•x]{2,}$/.test(key);
  }

  window.Agents = Object.assign(window.Agents || {}, {
    init,
    toggleChat,
    closeChat: closePanel,
    openChatFor,
    onChatMessage,
    openSettings,
    refresh,
    runAgent
  });

  document.addEventListener("DOMContentLoaded", init);
})();
