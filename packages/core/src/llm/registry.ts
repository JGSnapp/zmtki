import { newId } from '@zmtki/board-schema';
import type { AppDatabase } from '../app/AppDatabase.js';
import { CHATGPT_BASE_URL, type ChatGptAuth } from './chatgpt.js';
import { buildHeaders, buildModelsUrl, detectProvider } from './providers.js';
import { extractChatGptModels } from './responses.js';
import type { ProviderId, ResolvedEndpoint } from './types.js';

/**
 * Encryption is delegated to the host so core stays free of Electron. The
 * desktop app supplies safeStorage, which is backed by DPAPI on Windows and
 * the Keychain on macOS — better than the key-file-next-to-the-database
 * approach odysseus uses.
 */
export interface SecretStore {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
  available(): boolean;
}

export const passthroughSecrets: SecretStore = {
  encrypt: (plain) => plain,
  decrypt: (cipher) => cipher,
  available: () => false
};

export interface ModelEndpoint {
  id: string;
  label: string;
  baseUrl: string;
  provider: ProviderId;
  /** Ciphertext. Never leaves the main process in this form. */
  apiKeyEnc: string;
  models: string[];
  lastProbedAt: number;
  lastError: string;
}

export interface EndpointInput {
  id?: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  models?: string[];
}

/** Public shape sent to the renderer: no key material, only whether one is set. */
export interface EndpointView {
  id: string;
  label: string;
  baseUrl: string;
  provider: ProviderId;
  hasKey: boolean;
  models: string[];
  lastProbedAt: number;
  lastError: string;
}

const KV_KEY = 'llm.endpoints';

export class EndpointRegistry {
  private endpoints: ModelEndpoint[];
  private chatgpt: ChatGptAuth | null = null;

  constructor(
    private readonly db: AppDatabase,
    private secrets: SecretStore = passthroughSecrets
  ) {
    this.endpoints = db.getKv<ModelEndpoint[]>(KV_KEY, []);
  }

  setSecretStore(secrets: SecretStore): void {
    this.secrets = secrets;
  }

  /**
   * Wires up subscription auth. Kept separate from the constructor so the
   * registry has no opinion on whether ChatGPT login exists at all.
   */
  useChatGpt(auth: ChatGptAuth): void {
    this.chatgpt = auth;
  }

  list(): ModelEndpoint[] {
    return [...this.endpoints];
  }

  views(): EndpointView[] {
    return this.endpoints.map((e) => ({
      id: e.id,
      label: e.label,
      baseUrl: e.baseUrl,
      provider: e.provider,
      hasKey: e.provider === 'chatgpt' ? (this.chatgpt?.signedIn() ?? false) : e.apiKeyEnc.length > 0,
      models: e.models,
      lastProbedAt: e.lastProbedAt,
      lastError: e.lastError
    }));
  }

  find(id: string): ModelEndpoint | undefined {
    return this.endpoints.find((e) => e.id === id);
  }

  upsert(input: EndpointInput): ModelEndpoint {
    const existing = input.id ? this.find(input.id) : undefined;
    const provider = detectProvider(input.baseUrl);
    const apiKeyEnc =
      input.apiKey === undefined
        ? (existing?.apiKeyEnc ?? '')
        : input.apiKey === ''
          ? ''
          : this.secrets.encrypt(input.apiKey);

    const endpoint: ModelEndpoint = {
      id: existing?.id ?? input.id ?? newId('agent').replace('agt_', 'ep_'),
      label: input.label,
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
      provider,
      apiKeyEnc,
      models: input.models ?? existing?.models ?? [],
      lastProbedAt: existing?.lastProbedAt ?? 0,
      lastError: existing?.lastError ?? ''
    };

    this.endpoints = existing
      ? this.endpoints.map((e) => (e.id === endpoint.id ? endpoint : e))
      : [...this.endpoints, endpoint];
    this.save();
    return endpoint;
  }

  remove(id: string): void {
    this.endpoints = this.endpoints.filter((e) => e.id !== id);
    this.save();
  }

  /** Decrypts the key at call time; plaintext is never persisted or cached. */
  resolve(id: string): ResolvedEndpoint | undefined {
    const endpoint = this.find(id);
    if (!endpoint) return undefined;
    let apiKey = '';
    if (endpoint.apiKeyEnc) {
      try {
        apiKey = this.secrets.decrypt(endpoint.apiKeyEnc);
      } catch {
        apiKey = '';
      }
    }
    const resolved: ResolvedEndpoint = {
      id: endpoint.id,
      label: endpoint.label,
      baseUrl: endpoint.baseUrl,
      apiKey,
      provider: endpoint.provider
    };
    if (endpoint.provider === 'chatgpt' && this.chatgpt) {
      const auth = this.chatgpt;
      resolved.auth = () => auth.token();
    }
    return resolved;
  }

  /**
   * The endpoint backed by the ChatGPT subscription, created on first sign-in.
   *
   * It is a normal registry row so agents can select it, fall back to it, and
   * mix it with key-based endpoints — it just carries no key.
   */
  ensureChatGptEndpoint(): ModelEndpoint {
    const existing = this.endpoints.find((e) => e.provider === 'chatgpt');
    if (existing) return existing;
    return this.upsert({ label: 'Подписка ChatGPT', baseUrl: CHATGPT_BASE_URL });
  }

  removeChatGptEndpoints(): void {
    this.endpoints = this.endpoints.filter((e) => e.provider !== 'chatgpt');
    this.save();
  }

  async probe(id: string): Promise<{ ok: boolean; models: string[]; error: string }> {
    const endpoint = this.find(id);
    const resolved = this.resolve(id);
    if (!endpoint || !resolved) return { ok: false, models: [], error: 'эндпоинт не найден' };

    try {
      const url = buildModelsUrl(resolved.baseUrl, resolved.provider);
      const response = await fetch(url, {
        headers: await probeHeaders(resolved),
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const body = (await response.json()) as Record<string, unknown>;
      const models =
        resolved.provider === 'chatgpt' ? extractChatGptModels(body) : extractModelNames(body);
      endpoint.models = models;
      endpoint.lastProbedAt = Date.now();
      endpoint.lastError = '';
      this.save();
      return { ok: true, models, error: '' };
    } catch (err) {
      endpoint.lastProbedAt = Date.now();
      endpoint.lastError = (err as Error).message;
      this.save();
      return { ok: false, models: [], error: endpoint.lastError };
    }
  }

  private save(): void {
    this.db.setKv(KV_KEY, this.endpoints);
  }
}

async function probeHeaders(endpoint: ResolvedEndpoint): Promise<Record<string, string>> {
  if (endpoint.provider !== 'chatgpt' || !endpoint.auth) {
    return buildHeaders(endpoint.provider, endpoint.apiKey);
  }
  const { token, accountId } = await endpoint.auth();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/codex',
    'User-Agent': 'Artifact Board ChatGPT Subscription'
  };
  if (accountId) headers['ChatGPT-Account-ID'] = accountId;
  return headers;
}

function extractModelNames(body: Record<string, unknown>): string[] {
  // OpenAI-compatible, Anthropic and Google all wrap a list in `data`/`models`.
  const list =
    (body.data as Array<Record<string, unknown>> | undefined) ??
    (body.models as Array<Record<string, unknown>> | undefined) ??
    [];
  const names = list
    .map((m) => (m.id ?? m.name ?? m.model) as string | undefined)
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.replace(/^models\//, ''));
  return [...new Set(names)].sort();
}
