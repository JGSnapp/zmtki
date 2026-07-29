import type { ProviderId } from './types.js';

/**
 * Provider detection by hostname, following the odysseus design: endpoints are
 * registry rows rather than hardcoded provider classes, and anything
 * unrecognised is assumed to be OpenAI-compatible. That assumption is what
 * makes local servers (vLLM, LM Studio, llama.cpp) and new vendors work with
 * no code change.
 */

function hostMatches(url: string, domain: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  // Exact match or a real subdomain, so `anthropic.com.evil.test` never matches.
  return host === domain || host.endsWith(`.${domain}`);
}

export function detectProvider(baseUrl: string): ProviderId {
  if (isOllamaUrl(baseUrl)) return 'ollama';
  if (hostMatches(baseUrl, 'chatgpt.com')) return 'chatgpt';
  if (hostMatches(baseUrl, 'anthropic.com')) return 'anthropic';
  if (hostMatches(baseUrl, 'googleapis.com')) return 'google';
  if (hostMatches(baseUrl, 'openrouter.ai')) return 'openrouter';
  if (hostMatches(baseUrl, 'groq.com')) return 'groq';
  if (hostMatches(baseUrl, 'mistral.ai')) return 'mistral';
  if (hostMatches(baseUrl, 'deepseek.com')) return 'deepseek';
  if (hostMatches(baseUrl, 'x.ai')) return 'xai';
  if (hostMatches(baseUrl, 'together.ai') || hostMatches(baseUrl, 'together.xyz')) return 'together';
  if (hostMatches(baseUrl, 'openai.com')) return 'openai';
  if (isLocalHost(baseUrl)) return 'local';
  return 'openai';
}

export function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local')
    );
  } catch {
    return false;
  }
}

export function isOllamaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.includes('/api/chat') || parsed.pathname.includes('/api/generate')) return true;
    return parsed.port === '11434';
  } catch {
    return false;
  }
}

/** Turns a user-entered base URL into the actual chat endpoint. */
export function buildChatUrl(baseUrl: string, provider: ProviderId, model: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  switch (provider) {
    case 'chatgpt':
      return `${trimmed}/responses`;
    case 'anthropic':
      return trimmed.endsWith('/messages') ? trimmed : `${trimmed}/v1/messages`;
    case 'google':
      return `${trimmed}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    case 'ollama':
      if (trimmed.endsWith('/api/chat')) return trimmed;
      return `${trimmed.replace(/\/v1$/, '')}/api/chat`;
    default:
      if (trimmed.endsWith('/chat/completions')) return trimmed;
      if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
      return `${trimmed}/v1/chat/completions`;
  }
}

export function buildModelsUrl(baseUrl: string, provider: ProviderId): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  switch (provider) {
    case 'chatgpt':
      return `${trimmed}/models?client_version=1.0.0`;
    case 'anthropic':
      return `${trimmed}/v1/models`;
    case 'google':
      return `${trimmed}/v1beta/models`;
    case 'ollama':
      return `${trimmed.replace(/\/v1$/, '')}/api/tags`;
    default:
      return trimmed.endsWith('/v1') ? `${trimmed}/models` : `${trimmed}/v1/models`;
  }
}

export function buildHeaders(
  provider: ProviderId,
  apiKey: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extra
  };
  if (!apiKey) return headers;

  switch (provider) {
    case 'anthropic':
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      break;
    case 'google':
      headers['x-goog-api-key'] = apiKey;
      break;
    case 'openrouter':
      headers.Authorization = `Bearer ${apiKey}`;
      headers['HTTP-Referer'] = 'https://zmtki.dev';
      headers['X-Title'] = 'Artifact Board';
      break;
    default:
      headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Not every model accepts every knob. Reasoning models in particular reject a
 * custom temperature, and OpenAI renamed the token cap on newer families.
 */
export function omitsTemperature(model: string): boolean {
  const m = model.toLowerCase();
  return /^(o1|o3|o4|gpt-5)/.test(m) || m.includes('reasoner');
}

export function usesMaxCompletionTokens(model: string): boolean {
  const m = model.toLowerCase();
  return /^(o1|o3|o4|gpt-5)/.test(m);
}

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  needsKey: boolean;
  defaultBaseUrl: string;
}

export const PROVIDER_INFO: Record<ProviderId, ProviderMeta> = {
  openai: { id: 'openai', label: 'OpenAI', needsKey: true, defaultBaseUrl: 'https://api.openai.com' },
  chatgpt: {
    id: 'chatgpt',
    label: 'Подписка ChatGPT / Codex',
    // Authorised by OAuth sign-in rather than a key the user pastes.
    needsKey: false,
    defaultBaseUrl: 'https://chatgpt.com/backend-api/codex'
  },
  anthropic: { id: 'anthropic', label: 'Anthropic', needsKey: true, defaultBaseUrl: 'https://api.anthropic.com' },
  google: { id: 'google', label: 'Google Gemini', needsKey: true, defaultBaseUrl: 'https://generativelanguage.googleapis.com' },
  openrouter: { id: 'openrouter', label: 'OpenRouter', needsKey: true, defaultBaseUrl: 'https://openrouter.ai/api' },
  groq: { id: 'groq', label: 'Groq', needsKey: true, defaultBaseUrl: 'https://api.groq.com/openai' },
  mistral: { id: 'mistral', label: 'Mistral', needsKey: true, defaultBaseUrl: 'https://api.mistral.ai' },
  deepseek: { id: 'deepseek', label: 'DeepSeek', needsKey: true, defaultBaseUrl: 'https://api.deepseek.com' },
  xai: { id: 'xai', label: 'xAI Grok', needsKey: true, defaultBaseUrl: 'https://api.x.ai' },
  together: { id: 'together', label: 'Together', needsKey: true, defaultBaseUrl: 'https://api.together.xyz' },
  ollama: { id: 'ollama', label: 'Ollama', needsKey: false, defaultBaseUrl: 'http://localhost:11434' },
  local: { id: 'local', label: 'Локальный OpenAI-совместимый', needsKey: false, defaultBaseUrl: 'http://localhost:1234/v1' }
};
