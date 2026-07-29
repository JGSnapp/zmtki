import type { AppDatabase } from '../app/AppDatabase.js';
import type { SecretStore } from './registry.js';
import { passthroughSecrets } from './registry.js';

/**
 * ChatGPT / Codex subscription auth via OpenAI's device-code flow.
 *
 * Same path Odysseus uses: no localhost callback, no fixed port. The user
 * opens auth.openai.com/codex/device, types a short code, and we poll until
 * OpenAI hands back an authorization_code + code_verifier to exchange.
 */

export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEVICE_REDIRECT_URI = `${CHATGPT_ISSUER}/deviceauth/callback`;
const DEFAULT_VERIFY_URI = `${CHATGPT_ISSUER}/codex/device`;

const REFRESH_WINDOW_MS = 2 * 60 * 1000;
const MAX_TOKEN_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface ChatGptTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  lastRefresh: number;
}

export interface ChatGptStatus {
  signedIn: boolean;
  email: string;
  plan: string;
  accountId: string;
  expiresAt: number;
}

export interface DeviceLoginStart {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

interface PendingDevice {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
  cancelled: boolean;
  settle: (tokens: ChatGptTokens) => void;
  fail: (err: Error) => void;
  completed: Promise<ChatGptTokens>;
}

function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64').toString(
      'utf8'
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function authClaims(idToken: string): Record<string, unknown> {
  const claims = jwtPayload(idToken)['https://api.openai.com/auth'];
  return typeof claims === 'object' && claims !== null ? (claims as Record<string, unknown>) : {};
}

export function accountIdOf(idToken: string): string {
  const value = authClaims(idToken).chatgpt_account_id;
  return typeof value === 'string' ? value : '';
}

export function planOf(idToken: string): string {
  const value = authClaims(idToken).chatgpt_plan_type;
  return typeof value === 'string' ? value : '';
}

export function emailOf(idToken: string): string {
  const payload = jwtPayload(idToken);
  if (typeof payload.email === 'string') return payload.email;
  const profile = payload['https://api.openai.com/profile'];
  if (typeof profile === 'object' && profile !== null) {
    const email = (profile as Record<string, unknown>).email;
    if (typeof email === 'string') return email;
  }
  return '';
}

export function expiryOf(accessToken: string): number {
  const exp = jwtPayload(accessToken).exp;
  return typeof exp === 'number' ? exp * 1000 : 0;
}

async function requestDeviceCode(): Promise<{
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresIn: number;
}> {
  const response = await fetch(`${CHATGPT_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error(`не удалось начать вход: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  const deviceAuthId = String(data.device_auth_id ?? '');
  const userCode = String(data.user_code ?? '');
  if (!deviceAuthId || !userCode) throw new Error('ответ device-auth без кода');
  return {
    deviceAuthId,
    userCode,
    verificationUri: String(data.verification_uri ?? DEFAULT_VERIFY_URI),
    intervalMs: Math.max(3_000, (Number(data.interval) || 5) * 1000),
    expiresIn: Number(data.expires_in) || 900
  };
}

async function pollDeviceAuth(
  deviceAuthId: string,
  userCode: string
): Promise<{ pending: true } | { authorizationCode: string; codeVerifier: string }> {
  const response = await fetch(`${CHATGPT_ISSUER}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    signal: AbortSignal.timeout(15_000)
  });

  // Still waiting for the user to approve in the browser.
  if (response.status === 403 || response.status === 404) return { pending: true };
  if (!response.ok) {
    throw new Error(`опрос входа не удался: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (data.error === 'authorization_pending' || data.status === 'pending') {
    return { pending: true };
  }
  const authorizationCode = String(data.authorization_code ?? '');
  const codeVerifier = String(data.code_verifier ?? '');
  if (!authorizationCode || !codeVerifier) return { pending: true };
  return { authorizationCode, codeVerifier };
}

async function exchangeCode(authorizationCode: string, codeVerifier: string): Promise<ChatGptTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: DEVICE_REDIRECT_URI,
    client_id: CHATGPT_CLIENT_ID,
    code_verifier: codeVerifier
  });
  const response = await fetch(`${CHATGPT_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`обмен кода не удался: ${response.status} ${await response.text()}`);
  }
  const json = (await response.json()) as Record<string, unknown>;
  const accessToken = String(json.access_token ?? '');
  const refreshToken = String(json.refresh_token ?? '');
  const idToken = String(json.id_token ?? '');
  if (!accessToken || !refreshToken) throw new Error('ответ авторизации без токенов');
  return {
    idToken,
    accessToken,
    refreshToken,
    accountId: accountIdOf(idToken),
    lastRefresh: Date.now()
  };
}

async function refresh(tokens: ChatGptTokens): Promise<ChatGptTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: CHATGPT_CLIENT_ID
  });
  const response = await fetch(`${CHATGPT_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`обновление токена не удалось: ${response.status} ${await response.text()}`);
  }
  const json = (await response.json()) as Record<string, unknown>;
  const idToken = String(json.id_token ?? tokens.idToken);
  return {
    idToken,
    accessToken: String(json.access_token ?? tokens.accessToken),
    refreshToken: String(json.refresh_token ?? tokens.refreshToken),
    accountId: accountIdOf(idToken) || tokens.accountId,
    lastRefresh: Date.now()
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts a device-code login and polls in the background until the user
 * finishes (or cancels / times out).
 */
export async function startDeviceLogin(): Promise<{
  start: DeviceLoginStart;
  completed: Promise<ChatGptTokens>;
  cancel(): void;
}> {
  const code = await requestDeviceCode();
  let settle: (tokens: ChatGptTokens) => void = () => undefined;
  let fail: (err: Error) => void = () => undefined;
  const completed = new Promise<ChatGptTokens>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const pending: PendingDevice = {
    deviceAuthId: code.deviceAuthId,
    userCode: code.userCode,
    intervalMs: code.intervalMs || DEFAULT_POLL_INTERVAL_MS,
    expiresAt: Date.now() + code.expiresIn * 1000,
    cancelled: false,
    settle,
    fail,
    completed
  };

  void (async () => {
    while (!pending.cancelled) {
      if (Date.now() > pending.expiresAt) {
        fail(new Error('время на вход истекло — попробуйте ещё раз'));
        return;
      }
      try {
        const result = await pollDeviceAuth(pending.deviceAuthId, pending.userCode);
        if ('authorizationCode' in result) {
          const tokens = await exchangeCode(result.authorizationCode, result.codeVerifier);
          settle(tokens);
          return;
        }
      } catch (err) {
        if (pending.cancelled) return;
        fail(err as Error);
        return;
      }
      await sleep(pending.intervalMs);
    }
  })();

  return {
    start: {
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      expiresIn: code.expiresIn
    },
    completed,
    cancel: () => {
      pending.cancelled = true;
      const aborted = new Error('вход отменён');
      aborted.name = 'AbortError';
      fail(aborted);
    }
  };
}

const KV_KEY = 'llm.chatgpt';

export class ChatGptAuth {
  private tokens: ChatGptTokens | null;
  private refreshing: Promise<ChatGptTokens> | null = null;

  constructor(
    private readonly db: AppDatabase,
    private secrets: SecretStore = passthroughSecrets
  ) {
    this.tokens = this.load();
  }

  setSecretStore(secrets: SecretStore): void {
    this.secrets = secrets;
    this.tokens = this.load();
  }

  signedIn(): boolean {
    return this.tokens !== null;
  }

  status(): ChatGptStatus {
    if (!this.tokens) {
      return { signedIn: false, email: '', plan: '', accountId: '', expiresAt: 0 };
    }
    return {
      signedIn: true,
      email: emailOf(this.tokens.idToken),
      plan: planOf(this.tokens.idToken),
      accountId: this.tokens.accountId,
      expiresAt: expiryOf(this.tokens.accessToken)
    };
  }

  save(tokens: ChatGptTokens): void {
    this.tokens = tokens;
    this.db.setKv(KV_KEY, this.secrets.encrypt(JSON.stringify(tokens)));
  }

  clear(): void {
    this.tokens = null;
    this.db.setKv(KV_KEY, '');
  }

  async token(): Promise<{ token: string; accountId: string }> {
    const current = this.tokens;
    if (!current) throw new Error('нет входа в ChatGPT — авторизуйтесь в настройках');

    if (!this.stale(current)) {
      return { token: current.accessToken, accountId: current.accountId };
    }

    this.refreshing ??= refresh(current)
      .then((next) => {
        this.save(next);
        return next;
      })
      .finally(() => {
        this.refreshing = null;
      });

    const next = await this.refreshing;
    return { token: next.accessToken, accountId: next.accountId };
  }

  private stale(tokens: ChatGptTokens): boolean {
    const expiresAt = expiryOf(tokens.accessToken);
    if (expiresAt > 0) return expiresAt - Date.now() <= REFRESH_WINDOW_MS;
    return Date.now() - tokens.lastRefresh > MAX_TOKEN_AGE_MS;
  }

  private load(): ChatGptTokens | null {
    const stored = this.db.getKv<string>(KV_KEY, '');
    if (!stored) return null;
    try {
      return JSON.parse(this.secrets.decrypt(stored)) as ChatGptTokens;
    } catch {
      return null;
    }
  }
}
