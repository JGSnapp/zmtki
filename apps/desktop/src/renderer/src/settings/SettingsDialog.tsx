import type { ChatGptStatusView } from '@zmtki/protocol';
import { useEffect, useMemo, useState } from 'react';
import { submit, useStore } from '../store.js';

interface EndpointView {
  id: string;
  label: string;
  baseUrl: string;
  provider: string;
  hasKey: boolean;
  models: string[];
  lastProbedAt: number;
  lastError: string;
}

interface EtiquetteRule {
  id: string;
  title: string;
  body: string;
  enabled: boolean;
}

interface Settings {
  defaultEndpointId: string | null;
  defaultModel: string | null;
  maxConcurrentTurns: number;
  maxRoundsPerTurn: number;
  temperature: number;
  maxTokens: number;
  approvalPolicy: 'never' | 'onRequest' | 'untrusted';
  sandboxPolicy: 'readOnly' | 'boardWrite' | 'fullAccess';
  searchProvider: string;
  searchUrl: string;
  searchResultCount: number;
  googlePseCx: string;
  defaultMaxHops: number;
  artifactEtiquette: EtiquetteRule[];
}

type SettingsTab = 'providers' | 'search' | 'agents' | 'extensions' | 'etiquette';

type ProviderPreset = {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  authFlow?: 'chatgpt';
};

const PROVIDERS: ProviderPreset[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT Subscription',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    needsKey: false,
    authFlow: 'chatgpt'
  },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', needsKey: true },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', needsKey: true },
  { id: 'google', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', needsKey: true },
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434', needsKey: false },
  { id: 'custom', label: 'Custom / Local', baseUrl: '', needsKey: true }
];

const SEARCH_PROVIDERS = [
  { id: 'duckduckgo', label: 'DuckDuckGo (без ключа)' },
  { id: 'searxng', label: 'SearXNG' },
  { id: 'brave', label: 'Brave' },
  { id: 'google_pse', label: 'Google PSE' },
  { id: 'tavily', label: 'Tavily' },
  { id: 'serper', label: 'Serper' },
  { id: 'disabled', label: 'Отключить' }
];

const NO_STATUS: ChatGptStatusView = {
  signedIn: false,
  email: '',
  plan: '',
  accountId: '',
  expiresAt: 0
};

const PLAN_NAMES: Record<string, string> = {
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
  free: 'Free'
};

type DeviceAuth = {
  userCode: string;
  verificationUri: string;
};

type ExtensionScope = 'global' | 'board';

interface ExtensionsSnapshot {
  skills: Array<{
    name: string;
    description: string;
    scope: ExtensionScope;
    dir: string;
  }>;
  mcpServers: Array<{
    name: string;
    scope: ExtensionScope;
    command: string;
    args: string[];
    disabled: boolean;
    status: 'stopped' | 'starting' | 'ready' | 'error';
    error: string;
    toolCount: number;
  }>;
}

const EMPTY_EXTENSIONS: ExtensionsSnapshot = { skills: [], mcpServers: [] };

export function SettingsDialog(): JSX.Element | null {
  const open = useStore((s) => s.settingsOpen);
  const toggle = useStore((s) => s.toggleSettings);
  const chatgpt = useStore((s) => s.chatgpt);
  const chatgptError = useStore((s) => s.chatgptError);
  const [tab, setTab] = useState<SettingsTab>('providers');
  const [endpoints, setEndpoints] = useState<EndpointView[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [extensions, setExtensions] = useState<ExtensionsSnapshot>(EMPTY_EXTENSIONS);
  const [extScope, setExtScope] = useState<ExtensionScope>('global');
  const [skillForm, setSkillForm] = useState({ name: '', description: '', body: '' });
  const [mcpForm, setMcpForm] = useState({
    name: '',
    command: '',
    args: '',
    env: '',
    disabled: false
  });
  const [extMsg, setExtMsg] = useState('');
  const [extBusy, setExtBusy] = useState(false);
  const [presetId, setPresetId] = useState('chatgpt');
  const [form, setForm] = useState({ label: '', baseUrl: PROVIDERS[0]!.baseUrl, apiKey: '' });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formMsg, setFormMsg] = useState('');
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuth | null>(null);
  const [copied, setCopied] = useState(false);

  const preset = useMemo(
    () => PROVIDERS.find((p) => p.id === presetId) ?? PROVIDERS[0]!,
    [presetId]
  );
  const status = chatgpt ?? NO_STATUS;

  const reloadExtensions = async (): Promise<void> => {
    const snap = await submit<ExtensionsSnapshot>({ type: 'extensions.list' });
    if (snap.ok) setExtensions(snap.value);
  };

  const reload = async (): Promise<void> => {
    const [list, current, snap] = await Promise.all([
      submit<EndpointView[]>({ type: 'provider.list' }),
      submit<Settings>({ type: 'settings.get' }),
      submit<ExtensionsSnapshot>({ type: 'extensions.list' })
    ]);
    if (list.ok) setEndpoints(list.value);
    if (current.ok) setSettings(current.value);
    if (snap.ok) setExtensions(snap.value);
  };

  useEffect(() => {
    if (open) void reload();
  }, [open]);

  useEffect(() => {
    if (status.signedIn) {
      setDeviceAuth(null);
      setBusy(false);
      void reload();
    }
  }, [status.signedIn]);

  useEffect(() => {
    if (chatgptError) setBusy(false);
  }, [chatgptError]);

  if (!open) return null;

  const selectPreset = (next: ProviderPreset): void => {
    setPresetId(next.id);
    setPickerOpen(false);
    setFormMsg('');
    setDeviceAuth(null);
    setForm({
      label: next.id === 'custom' ? '' : next.label,
      baseUrl: next.baseUrl,
      apiKey: ''
    });
  };

  const startChatGpt = async (): Promise<void> => {
    setBusy(true);
    setFormMsg('');
    useStore.setState({ chatgptError: '' });
    const result = await submit<{
      userCode: string;
      verificationUri: string;
      expiresIn: number;
    }>({ type: 'chatgpt.login' });
    if (!result.ok) {
      setBusy(false);
      setFormMsg(result.error);
      return;
    }
    setDeviceAuth({
      userCode: result.value.userCode,
      verificationUri: result.value.verificationUri
    });
    await window.zmtki.openExternal(result.value.verificationUri);
  };

  const cancelChatGpt = (): void => {
    setDeviceAuth(null);
    setBusy(false);
    void submit({ type: 'chatgpt.cancelLogin' });
  };

  const copyCode = async (): Promise<void> => {
    if (!deviceAuth) return;
    await navigator.clipboard.writeText(deviceAuth.userCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const addEndpoint = async (): Promise<void> => {
    if (preset.authFlow === 'chatgpt') {
      await startChatGpt();
      return;
    }
    if (!form.baseUrl.trim()) {
      setFormMsg('Укажите базовый URL');
      return;
    }
    if (preset.needsKey && !form.apiKey.trim()) {
      setFormMsg('Нужен API-ключ');
      return;
    }
    setBusy(true);
    setFormMsg('');
    const result = await submit({
      type: 'provider.upsert',
      endpoint: {
        label: form.label.trim() || preset.label || form.baseUrl,
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey,
        models: []
      }
    });
    setBusy(false);
    if (!result.ok) {
      setFormMsg(result.error);
      return;
    }
    setForm({ label: preset.label, baseUrl: preset.baseUrl, apiKey: '' });
    setFormMsg('Эндпоинт добавлен');
    await reload();
  };

  const signOut = async (): Promise<void> => {
    await submit({ type: 'chatgpt.logout' });
    await reload();
  };

  const patch = async (change: Partial<Settings>): Promise<void> => {
    const result = await submit<Settings>({ type: 'settings.set', patch: change });
    if (result.ok) setSettings(result.value);
  };

  const etiquetteRules = settings?.artifactEtiquette ?? [];

  const setEtiquette = async (next: EtiquetteRule[]): Promise<void> => {
    await patch({ artifactEtiquette: next });
  };

  const updateEtiquetteRule = async (id: string, change: Partial<EtiquetteRule>): Promise<void> => {
    await setEtiquette(etiquetteRules.map((rule) => (rule.id === id ? { ...rule, ...change } : rule)));
  };

  const addEtiquetteRule = async (): Promise<void> => {
    const id = `rule_${Date.now().toString(36)}`;
    await setEtiquette([
      ...etiquetteRules,
      {
        id,
        title: 'Новое правило',
        body: 'Опишите, как агент должен вести себя с артефактами на доске.',
        enabled: true
      }
    ]);
  };

  const removeEtiquetteRule = async (id: string): Promise<void> => {
    await setEtiquette(etiquetteRules.filter((rule) => rule.id !== id));
  };

  const resetEtiquette = async (): Promise<void> => {
    const result = await submit<Settings>({
      type: 'settings.set',
      patch: { artifactEtiquette: null }
    });
    if (result.ok) setSettings(result.value);
  };

  const parseEnvLines = (raw: string): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
  };

  const saveSkill = async (): Promise<void> => {
    if (!skillForm.name.trim() || !skillForm.body.trim()) {
      setExtMsg('Нужны имя и тело skill');
      return;
    }
    setExtBusy(true);
    setExtMsg('');
    const result = await submit<ExtensionsSnapshot>({
      type: 'extensions.skills.upsert',
      scope: extScope,
      name: skillForm.name.trim(),
      description: skillForm.description.trim(),
      body: skillForm.body
    });
    setExtBusy(false);
    if (!result.ok) {
      setExtMsg(result.error);
      return;
    }
    setExtensions(result.value);
    setSkillForm({ name: '', description: '', body: '' });
    setExtMsg('Skill сохранён');
  };

  const removeSkill = async (scope: ExtensionScope, name: string): Promise<void> => {
    setExtBusy(true);
    const result = await submit<ExtensionsSnapshot>({
      type: 'extensions.skills.remove',
      scope,
      name
    });
    setExtBusy(false);
    if (result.ok) setExtensions(result.value);
    else setExtMsg(result.error);
  };

  const saveMcp = async (): Promise<void> => {
    if (!mcpForm.name.trim() || !mcpForm.command.trim()) {
      setExtMsg('Нужны имя и команда MCP');
      return;
    }
    setExtBusy(true);
    setExtMsg('');
    const args = mcpForm.args
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const result = await submit<ExtensionsSnapshot>({
      type: 'extensions.mcp.upsert',
      scope: extScope,
      name: mcpForm.name.trim(),
      command: mcpForm.command.trim(),
      args,
      env: parseEnvLines(mcpForm.env),
      disabled: mcpForm.disabled
    });
    setExtBusy(false);
    if (!result.ok) {
      setExtMsg(result.error);
      return;
    }
    setExtensions(result.value);
    setMcpForm({ name: '', command: '', args: '', env: '', disabled: false });
    setExtMsg('MCP-сервер сохранён');
  };

  const removeMcp = async (scope: ExtensionScope, name: string): Promise<void> => {
    setExtBusy(true);
    const result = await submit<ExtensionsSnapshot>({
      type: 'extensions.mcp.remove',
      scope,
      name
    });
    setExtBusy(false);
    if (result.ok) setExtensions(result.value);
    else setExtMsg(result.error);
  };

  const testMcp = async (name: string): Promise<void> => {
    setExtBusy(true);
    setExtMsg('');
    const result = await submit<{ ok: boolean; tools: string[]; error: string }>({
      type: 'extensions.mcp.test',
      name
    });
    setExtBusy(false);
    if (!result.ok) {
      setExtMsg(result.error);
      return;
    }
    if (result.value.ok) {
      setExtMsg(
        result.value.tools.length
          ? `OK: ${result.value.tools.join(', ')}`
          : 'OK: подключено, tools пусты'
      );
    } else {
      setExtMsg(result.value.error || 'ошибка подключения');
    }
    await reloadExtensions();
  };

  const probe = async (id: string): Promise<void> => {
    setProbing(id);
    await submit({ type: 'provider.probe', endpointId: id });
    setProbing(null);
    await reload();
  };

  const chatgptEndpoint = endpoints.find((e) => e.provider === 'chatgpt');
  const apiEndpoints = endpoints.filter((e) => e.provider !== 'chatgpt');

  return (
    <div className="modal-backdrop" onClick={() => toggle(false)}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-layout">
          <aside className="settings-sidebar">
            <div className="settings-brand">Настройки</div>
            <button
              className={`settings-nav ${tab === 'providers' ? 'on' : ''}`}
              onClick={() => setTab('providers')}
            >
              Провайдеры
            </button>
            <button
              className={`settings-nav ${tab === 'search' ? 'on' : ''}`}
              onClick={() => setTab('search')}
            >
              Поиск
            </button>
            <button
              className={`settings-nav ${tab === 'agents' ? 'on' : ''}`}
              onClick={() => setTab('agents')}
            >
              Агенты
            </button>
            <button
              className={`settings-nav ${tab === 'extensions' ? 'on' : ''}`}
              onClick={() => setTab('extensions')}
            >
              Расширения
            </button>
            <button
              className={`settings-nav ${tab === 'etiquette' ? 'on' : ''}`}
              onClick={() => setTab('etiquette')}
            >
              Артефактный этикет
            </button>
          </aside>

          <div className="settings-panels">
            <header className="settings-panel-head">
              <h3>
                {tab === 'providers'
                  ? 'Модели'
                  : tab === 'search'
                    ? 'Поиск'
                    : tab === 'agents'
                      ? 'Агенты'
                      : tab === 'extensions'
                        ? 'Расширения'
                        : 'Артефактный этикет'}
              </h3>
              <button className="icon-btn" onClick={() => toggle(false)}>
                ×
              </button>
            </header>

            {tab === 'providers' && (
              <div className="settings-scroll">
                <section className="admin-card">
                  <div className="admin-card-head">
                    <div>
                      <div className="admin-card-title">Добавить провайдера</div>
                      <div className="admin-card-sub">
                        Облачный API-ключ или вход через подписку ChatGPT / Codex
                      </div>
                    </div>
                  </div>

                  <div className="admin-form">
                    <div className="admin-row">
                      <div className={`provider-combo ${pickerOpen ? 'open' : ''}`}>
                        <button
                          type="button"
                          className="provider-btn"
                          onClick={() => setPickerOpen((v) => !v)}
                        >
                          <span className="provider-mark">{preset.label.slice(0, 2).toUpperCase()}</span>
                          <span className="provider-name">{preset.label}</span>
                          <span className="provider-caret">▾</span>
                        </button>
                        {pickerOpen && (
                          <div className="provider-menu">
                            {PROVIDERS.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                className={`provider-item ${item.id === preset.id ? 'on' : ''}`}
                                onClick={() => selectPreset(item)}
                              >
                                <span className="provider-mark">
                                  {item.label.slice(0, 2).toUpperCase()}
                                </span>
                                <span>
                                  <span className="provider-item-name">{item.label}</span>
                                  {item.authFlow === 'chatgpt' && (
                                    <span className="provider-item-hint">без API-ключа</span>
                                  )}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                        <input
                          className="provider-url"
                          placeholder={
                            preset.authFlow === 'chatgpt'
                              ? 'Вход через аккаунт OpenAI'
                              : 'Базовый URL'
                          }
                          value={
                            preset.authFlow === 'chatgpt'
                              ? 'ChatGPT Subscription · OpenAI account'
                              : form.baseUrl
                          }
                          readOnly={preset.authFlow === 'chatgpt'}
                          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                        />
                      </div>
                    </div>

                    {preset.authFlow === 'chatgpt' ? (
                      <>
                        <div className="admin-row admin-row-end">
                          {status.signedIn ? (
                            <button className="art-btn danger" onClick={() => void signOut()}>
                              Выйти
                            </button>
                          ) : (
                            <button
                              className="art-btn primary"
                              disabled={busy}
                              onClick={() => void startChatGpt()}
                            >
                              {busy && !deviceAuth ? '…' : 'Подключить'}
                            </button>
                          )}
                          {deviceAuth && (
                            <button className="art-btn" onClick={cancelChatGpt}>
                              Отмена
                            </button>
                          )}
                        </div>

                        {status.signedIn && (
                          <div className="device-panel ok">
                            Подключено: {status.email || 'аккаунт'}
                            {status.plan ? ` · ${PLAN_NAMES[status.plan] ?? status.plan}` : ''}
                            {chatgptEndpoint?.models.length
                              ? ` · ${chatgptEndpoint.models.length} моделей`
                              : ''}
                          </div>
                        )}

                        {deviceAuth && (
                          <div className="device-panel">
                            <div className="device-label">Код подтверждения</div>
                            <div className="device-code-row">
                              <code className="device-code">{deviceAuth.userCode}</code>
                              <button className="art-btn" onClick={() => void copyCode()}>
                                {copied ? 'Скопировано' : 'Копировать'}
                              </button>
                            </div>
                            <div className="device-hint">
                              Откройте страницу входа, введите код и подтвердите доступ.
                            </div>
                            <button
                              className="art-btn"
                              onClick={() => void window.zmtki.openExternal(deviceAuth.verificationUri)}
                            >
                              Открыть auth.openai.com ↗
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="admin-row">
                        <input
                          type="password"
                          className="admin-grow"
                          placeholder={
                            preset.needsKey
                              ? 'API-ключ'
                              : 'API-ключ (необязательно для локальных)'
                          }
                          value={form.apiKey}
                          onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                        />
                        <input
                          className="admin-name"
                          placeholder="Название"
                          value={form.label}
                          onChange={(e) => setForm({ ...form, label: e.target.value })}
                        />
                        <button
                          className="art-btn primary"
                          disabled={busy}
                          onClick={() => void addEndpoint()}
                        >
                          Добавить
                        </button>
                      </div>
                    )}

                    {(formMsg || chatgptError) && (
                      <div className={`admin-msg ${chatgptError ? 'err' : ''}`}>
                        {chatgptError || formMsg}
                      </div>
                    )}
                  </div>
                </section>

                <section className="admin-card">
                  <div className="admin-card-head">
                    <div>
                      <div className="admin-card-title">Подключённые</div>
                      <div className="admin-card-sub">
                        Ключи шифруются средствами ОС и не покидают компьютер
                      </div>
                    </div>
                  </div>

                  {endpoints.length === 0 && (
                    <div className="admin-empty">Пока нет эндпоинтов</div>
                  )}

                  {status.signedIn && chatgptEndpoint && (
                    <EndpointCard
                      endpoint={chatgptEndpoint}
                      settings={settings}
                      probing={probing}
                      badge={
                        status.email
                          ? `${status.email}${status.plan ? ` · ${PLAN_NAMES[status.plan] ?? status.plan}` : ''}`
                          : 'ChatGPT'
                      }
                      onProbe={probe}
                      onDefault={(id) => void patch({ defaultEndpointId: id })}
                      onModel={(model) => void patch({ defaultModel: model })}
                      onDelete={() => void signOut()}
                      deleteLabel="Выйти"
                    />
                  )}

                  {apiEndpoints.map((endpoint) => (
                    <EndpointCard
                      key={endpoint.id}
                      endpoint={endpoint}
                      settings={settings}
                      probing={probing}
                      onProbe={probe}
                      onDefault={(id) => void patch({ defaultEndpointId: id })}
                      onModel={(model) => void patch({ defaultModel: model })}
                      onDelete={async () => {
                        await submit({ type: 'provider.delete', endpointId: endpoint.id });
                        await reload();
                      }}
                    />
                  ))}
                </section>
              </div>
            )}

            {tab === 'search' && settings && (
              <div className="settings-scroll">
                <section className="admin-card">
                  <label className="field">
                    Провайдер поиска
                    <select
                      value={settings.searchProvider}
                      onChange={(e) => void patch({ searchProvider: e.target.value })}
                    >
                      {SEARCH_PROVIDERS.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {settings.searchProvider === 'searxng' && (
                    <label className="field">
                      Адрес инстанса SearXNG
                      <input
                        value={settings.searchUrl}
                        onChange={(e) => void patch({ searchUrl: e.target.value })}
                      />
                    </label>
                  )}

                  {settings.searchProvider === 'google_pse' && (
                    <label className="field">
                      Google PSE cx
                      <input
                        value={settings.googlePseCx}
                        onChange={(e) => void patch({ googlePseCx: e.target.value })}
                      />
                    </label>
                  )}

                  {['brave', 'tavily', 'serper', 'google_pse'].includes(settings.searchProvider) && (
                    <label className="field">
                      API-ключ провайдера
                      <input
                        type="password"
                        placeholder="сохраняется в шифрованном виде"
                        onBlur={(e) => {
                          const key =
                            settings.searchProvider === 'google_pse'
                              ? 'googlePse'
                              : settings.searchProvider;
                          void window.zmtki.setSearchKey(key, e.target.value);
                        }}
                      />
                    </label>
                  )}

                  <label className="field">
                    Результатов на запрос
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={settings.searchResultCount}
                      onChange={(e) => void patch({ searchResultCount: Number(e.target.value) })}
                    />
                  </label>
                </section>
              </div>
            )}

            {tab === 'agents' && settings && (
              <div className="settings-scroll">
                <section className="admin-card">
                  <label className="field">
                    Одновременных ходов
                    <input
                      type="number"
                      min={1}
                      max={16}
                      value={settings.maxConcurrentTurns}
                      onChange={(e) => void patch({ maxConcurrentTurns: Number(e.target.value) })}
                    />
                  </label>
                  <label className="field">
                    Максимум раундов инструментов
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={settings.maxRoundsPerTurn}
                      onChange={(e) => void patch({ maxRoundsPerTurn: Number(e.target.value) })}
                    />
                  </label>
                  <label className="field">
                    Подтверждения
                    <select
                      value={settings.approvalPolicy}
                      onChange={(e) =>
                        void patch({ approvalPolicy: e.target.value as Settings['approvalPolicy'] })
                      }
                    >
                      <option value="never">Не спрашивать</option>
                      <option value="onRequest">Спрашивать перед записью и командами</option>
                      <option value="untrusted">Спрашивать всегда</option>
                    </select>
                  </label>
                  <label className="field">
                    Доступ к файлам
                    <select
                      value={settings.sandboxPolicy}
                      onChange={(e) =>
                        void patch({ sandboxPolicy: e.target.value as Settings['sandboxPolicy'] })
                      }
                    >
                      <option value="readOnly">Только чтение</option>
                      <option value="boardWrite">Запись внутри папки доски</option>
                      <option value="fullAccess">Полный доступ</option>
                    </select>
                  </label>
                  <label className="field">
                    Лимит цепочки агент→агент
                    <input
                      type="number"
                      min={0}
                      max={30}
                      value={settings.defaultMaxHops}
                      onChange={(e) => void patch({ defaultMaxHops: Number(e.target.value) })}
                    />
                  </label>
                  <label className="field">
                    Температура
                    <input
                      type="number"
                      step={0.1}
                      min={0}
                      max={2}
                      value={settings.temperature}
                      onChange={(e) => void patch({ temperature: Number(e.target.value) })}
                    />
                  </label>
                </section>
              </div>
            )}

            {tab === 'extensions' && (
              <div className="settings-scroll">
                <section className="admin-card">
                  <div className="admin-card-head">
                    <div>
                      <div className="admin-card-title">Слой хранения</div>
                      <div className="admin-card-sub">
                        Глобально (~/.zmtki) или только активная доска. При совпадении имён побеждает
                        доска.
                      </div>
                    </div>
                    <select
                      value={extScope}
                      onChange={(e) => setExtScope(e.target.value as ExtensionScope)}
                    >
                      <option value="global">Глобально</option>
                      <option value="board">Доска</option>
                    </select>
                  </div>
                  {extMsg && <div className="endpoint-error">{extMsg}</div>}
                </section>

                <section className="admin-card">
                  <div className="admin-card-head">
                    <div>
                      <div className="admin-card-title">Skills</div>
                      <div className="admin-card-sub">Папки с SKILL.md (как в Cursor)</div>
                    </div>
                  </div>
                  {extensions.skills.length === 0 ? (
                    <div className="admin-card-sub">Пока пусто</div>
                  ) : (
                    extensions.skills.map((skill) => (
                      <div key={`${skill.scope}:${skill.name}`} className="ep-row">
                        <div className="ep-row-main">
                          <div>
                            <div className="ep-name">
                              {skill.name}
                              <span className="ep-provider">{skill.scope}</span>
                            </div>
                            <div className="ep-url">{skill.description || skill.dir}</div>
                          </div>
                        </div>
                        <div className="ep-row-actions">
                          <button
                            className="art-btn danger"
                            disabled={extBusy}
                            onClick={() => void removeSkill(skill.scope, skill.name)}
                          >
                            Удалить
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                  <div className="admin-form" style={{ marginTop: 12 }}>
                    <label className="field">
                      Имя
                      <input
                        value={skillForm.name}
                        onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })}
                        placeholder="my-skill"
                      />
                    </label>
                    <label className="field">
                      Описание
                      <input
                        value={skillForm.description}
                        onChange={(e) =>
                          setSkillForm({ ...skillForm, description: e.target.value })
                        }
                        placeholder="когда применять этот skill"
                      />
                    </label>
                    <label className="field">
                      Тело (markdown)
                      <textarea
                        rows={5}
                        value={skillForm.body}
                        onChange={(e) => setSkillForm({ ...skillForm, body: e.target.value })}
                        placeholder="Инструкции для агента…"
                      />
                    </label>
                    <div className="admin-row admin-row-end">
                      <button
                        className="art-btn primary"
                        disabled={extBusy}
                        onClick={() => void saveSkill()}
                      >
                        Сохранить skill
                      </button>
                    </div>
                  </div>
                </section>

                <section className="admin-card">
                  <div className="admin-card-head">
                    <div>
                      <div className="admin-card-title">MCP-серверы</div>
                      <div className="admin-card-sub">stdio, формат как у Claude Desktop</div>
                    </div>
                  </div>
                  {extensions.mcpServers.length === 0 ? (
                    <div className="admin-card-sub">Пока пусто</div>
                  ) : (
                    extensions.mcpServers.map((server) => (
                      <div key={`${server.scope}:${server.name}`} className="ep-row">
                        <div className="ep-row-main">
                          <div>
                            <div className="ep-name">
                              {server.name}
                              <span className="ep-provider">{server.scope}</span>
                              <span className="ep-default">{server.status}</span>
                              {server.toolCount > 0 && (
                                <span className="ep-provider">{server.toolCount} tools</span>
                              )}
                            </div>
                            <div className="ep-url">
                              {server.command} {server.args.join(' ')}
                            </div>
                            {server.error && <div className="endpoint-error">{server.error}</div>}
                          </div>
                        </div>
                        <div className="ep-row-actions">
                          <button
                            className="art-btn"
                            disabled={extBusy}
                            onClick={() => void testMcp(server.name)}
                          >
                            Проверить
                          </button>
                          <button
                            className="art-btn danger"
                            disabled={extBusy}
                            onClick={() => void removeMcp(server.scope, server.name)}
                          >
                            Удалить
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                  <div className="admin-form" style={{ marginTop: 12 }}>
                    <label className="field">
                      Имя
                      <input
                        value={mcpForm.name}
                        onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })}
                        placeholder="filesystem"
                      />
                    </label>
                    <label className="field">
                      Команда
                      <input
                        value={mcpForm.command}
                        onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })}
                        placeholder="npx"
                      />
                    </label>
                    <label className="field">
                      Args (через пробел)
                      <input
                        value={mcpForm.args}
                        onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })}
                        placeholder="-y @modelcontextprotocol/server-filesystem ."
                      />
                    </label>
                    <label className="field">
                      Env (KEY=value по строкам)
                      <textarea
                        rows={3}
                        value={mcpForm.env}
                        onChange={(e) => setMcpForm({ ...mcpForm, env: e.target.value })}
                      />
                    </label>
                    <label className="field" style={{ flexDirection: 'row', gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={mcpForm.disabled}
                        onChange={(e) => setMcpForm({ ...mcpForm, disabled: e.target.checked })}
                      />
                      Отключён
                    </label>
                    <div className="admin-row admin-row-end">
                      <button
                        className="art-btn primary"
                        disabled={extBusy}
                        onClick={() => void saveMcp()}
                      >
                        Сохранить MCP
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {tab === 'etiquette' && settings && (
              <div className="settings-scroll">
                <section className="admin-card">
                  <div className="admin-card-head">
                    <div>
                      <div className="admin-card-title">Правила для агентов</div>
                      <div className="admin-card-sub">
                        Включённые пункты попадают в системный промпт. Можно выключить, править, удалить
                        или добавить свои.
                      </div>
                    </div>
                    <div className="etiquette-head-actions">
                      <button type="button" className="art-btn" onClick={() => void addEtiquetteRule()}>
                        + Правило
                      </button>
                      <button type="button" className="art-btn" onClick={() => void resetEtiquette()}>
                        Сбросить
                      </button>
                    </div>
                  </div>

                  <div className="etiquette-list">
                    {etiquetteRules.map((rule, index) => (
                      <article key={rule.id} className={`etiquette-card ${rule.enabled ? '' : 'off'}`}>
                        <div className="etiquette-card-head">
                          <label className="etiquette-toggle">
                            <input
                              type="checkbox"
                              checked={rule.enabled}
                              onChange={(e) =>
                                void updateEtiquetteRule(rule.id, { enabled: e.target.checked })
                              }
                            />
                            <span>
                              {index + 1}. {rule.enabled ? 'Вкл' : 'Выкл'}
                            </span>
                          </label>
                          <button
                            type="button"
                            className="art-btn danger"
                            title="Удалить правило"
                            onClick={() => void removeEtiquetteRule(rule.id)}
                          >
                            Удалить
                          </button>
                        </div>
                        <input
                          className="etiquette-title"
                          value={rule.title}
                          placeholder="Заголовок"
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              artifactEtiquette: etiquetteRules.map((r) =>
                                r.id === rule.id ? { ...r, title: e.target.value } : r
                              )
                            })
                          }
                          onBlur={(e) => void updateEtiquetteRule(rule.id, { title: e.target.value })}
                        />
                        <textarea
                          className="etiquette-body"
                          rows={4}
                          value={rule.body}
                          placeholder="Текст правила для агента"
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              artifactEtiquette: etiquetteRules.map((r) =>
                                r.id === rule.id ? { ...r, body: e.target.value } : r
                              )
                            })
                          }
                          onBlur={(e) => void updateEtiquetteRule(rule.id, { body: e.target.value })}
                        />
                      </article>
                    ))}
                    {etiquetteRules.length === 0 && (
                      <div className="hint">
                        Правил нет — агенты не получат блок этикета. Нажмите «+ Правило» или «Сбросить».
                      </div>
                    )}
                  </div>
                </section>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EndpointCard(props: {
  endpoint: EndpointView;
  settings: Settings | null;
  probing: string | null;
  badge?: string;
  deleteLabel?: string;
  onProbe: (id: string) => void;
  onDefault: (id: string) => void;
  onModel: (model: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const { endpoint, settings, probing, badge, deleteLabel, onProbe, onDefault, onModel, onDelete } =
    props;
  const isDefault = settings?.defaultEndpointId === endpoint.id;

  return (
    <div className="ep-row">
      <div className="ep-row-main">
        <div className="ep-row-title">
          <span className="provider-mark">{endpoint.label.slice(0, 2).toUpperCase()}</span>
          <div>
            <div className="ep-name">
              {endpoint.label}
              <span className="ep-provider">{endpoint.provider}</span>
              {isDefault && <span className="ep-default">default</span>}
            </div>
            <div className="ep-url">{badge || endpoint.baseUrl}</div>
            {endpoint.lastError && <div className="endpoint-error">{endpoint.lastError}</div>}
          </div>
        </div>
        {endpoint.models.length > 0 && (
          <select
            className="model-select"
            value={settings?.defaultModel ?? ''}
            onChange={(e) => onModel(e.target.value)}
          >
            <option value="">модель по умолчанию</option>
            {endpoint.models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="ep-row-actions">
        <button
          className="art-btn"
          disabled={probing === endpoint.id}
          onClick={() => onProbe(endpoint.id)}
        >
          {probing === endpoint.id ? '…' : 'Probe'}
        </button>
        {!isDefault && (
          <button className="art-btn" onClick={() => onDefault(endpoint.id)}>
            Default
          </button>
        )}
        <button className="art-btn danger" onClick={onDelete}>
          {deleteLabel ?? 'Delete'}
        </button>
      </div>
    </div>
  );
}
