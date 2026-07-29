import { parse as parseHtml } from 'node-html-parser';
import type { SearchProviderId } from '../app/settings.js';
import { safeFetch, safeFetchJson, safeFetchText } from './safeFetch.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface SearchContext {
  apiKey: string;
  instanceUrl: string;
  googleCx: string;
  count: number;
}

export interface SearchProviderMeta {
  id: SearchProviderId;
  label: string;
  needsKey: boolean;
  needsUrl: boolean;
}

/** Same registry shape as odysseus: a string key, not an interface hierarchy. */
export const SEARCH_PROVIDER_INFO: Record<SearchProviderId, SearchProviderMeta> = {
  searxng: { id: 'searxng', label: 'SearXNG', needsKey: false, needsUrl: true },
  brave: { id: 'brave', label: 'Brave Search', needsKey: true, needsUrl: false },
  duckduckgo: { id: 'duckduckgo', label: 'DuckDuckGo', needsKey: false, needsUrl: false },
  google_pse: { id: 'google_pse', label: 'Google PSE', needsKey: true, needsUrl: false },
  tavily: { id: 'tavily', label: 'Tavily', needsKey: true, needsUrl: false },
  serper: { id: 'serper', label: 'Serper', needsKey: true, needsUrl: false },
  disabled: { id: 'disabled', label: 'Отключён', needsKey: false, needsUrl: false }
};

type SearchFn = (query: string, ctx: SearchContext) => Promise<SearchResult[]>;

const searxng: SearchFn = async (query, ctx) => {
  const url = new URL('/search', ctx.instanceUrl || 'https://searx.be');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', '0');
  const data = await safeFetchJson<{ results?: Array<Record<string, string>> }>(url.toString(), {
    timeoutMs: 20_000
  });
  return (data.results ?? []).slice(0, ctx.count).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
    source: 'searxng'
  }));
};

const brave: SearchFn = async (query, ctx) => {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(ctx.count));
  const data = await safeFetchJson<{ web?: { results?: Array<Record<string, string>> } }>(url.toString(), {
    headers: { 'X-Subscription-Token': ctx.apiKey, Accept: 'application/json' }
  });
  return (data.web?.results ?? []).slice(0, ctx.count).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: stripTags(r.description ?? ''),
    source: 'brave'
  }));
};

/**
 * DuckDuckGo has no public API, so this scrapes the no-JS endpoint. It is the
 * keyless default, which matters: search should work before the user has
 * configured anything.
 */
const duckduckgo: SearchFn = async (query, ctx) => {
  const response = await safeFetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: query }).toString(),
    timeoutMs: 20_000
  });
  const root = parseHtml(response.body.toString('utf8'));
  const out: SearchResult[] = [];
  for (const el of root.querySelectorAll('.result')) {
    const link = el.querySelector('.result__a');
    if (!link) continue;
    const href = link.getAttribute('href') ?? '';
    out.push({
      title: link.text.trim(),
      url: unwrapDuckDuckGoUrl(href),
      snippet: el.querySelector('.result__snippet')?.text.trim() ?? '',
      source: 'duckduckgo'
    });
    if (out.length >= ctx.count) break;
  }
  return out;
};

const googlePse: SearchFn = async (query, ctx) => {
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', ctx.apiKey);
  url.searchParams.set('cx', ctx.googleCx);
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.min(10, ctx.count)));
  const data = await safeFetchJson<{ items?: Array<Record<string, string>> }>(url.toString());
  return (data.items ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
    source: 'google_pse'
  }));
};

const tavily: SearchFn = async (query, ctx) => {
  const data = await safeFetchJson<{ results?: Array<Record<string, string>> }>(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: ctx.apiKey,
        query,
        max_results: ctx.count,
        search_depth: 'basic'
      })
    }
  );
  return (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
    source: 'tavily'
  }));
};

const serper: SearchFn = async (query, ctx) => {
  const data = await safeFetchJson<{ organic?: Array<Record<string, string>> }>(
    'https://google.serper.dev/search',
    {
      method: 'POST',
      headers: { 'X-API-KEY': ctx.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: ctx.count })
    }
  );
  return (data.organic ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
    source: 'serper'
  }));
};

export const SEARCH_PROVIDERS: Partial<Record<SearchProviderId, SearchFn>> = {
  searxng,
  brave,
  duckduckgo,
  google_pse: googlePse,
  tavily,
  serper
};

function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ?? url.toString();
  } catch {
    return href;
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

/** Plain-text extraction for the page body an agent asked to read. */
export function extractReadableText(html: string, maxChars = 20_000): { title: string; text: string } {
  const root = parseHtml(html, { blockTextElements: { script: false, style: false, noscript: false } });
  for (const selector of ['script', 'style', 'noscript', 'svg', 'nav', 'footer', 'header', 'aside']) {
    for (const el of root.querySelectorAll(selector)) el.remove();
  }
  const title = root.querySelector('title')?.text.trim() ?? '';
  const main = root.querySelector('main') ?? root.querySelector('article') ?? root.querySelector('body') ?? root;
  const text = main.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { title, text: text.slice(0, maxChars) };
}

export async function fetchPageText(
  url: string,
  maxBytes?: number
): Promise<{ title: string; text: string; truncated: boolean; status: number }> {
  const result = await safeFetch(url, maxBytes === undefined ? {} : { maxBytes });
  const contentType = result.contentType.toLowerCase();
  if (contentType.includes('application/json')) {
    return {
      title: url,
      text: result.body.toString('utf8').slice(0, 20_000),
      truncated: result.truncated,
      status: result.status
    };
  }
  if (!contentType.includes('html') && !contentType.includes('text')) {
    return {
      title: url,
      text: `[двоичный контент ${contentType || 'неизвестного типа'}, ${result.body.byteLength} байт]`,
      truncated: result.truncated,
      status: result.status
    };
  }
  const extracted = extractReadableText(result.body.toString('utf8'));
  return { ...extracted, truncated: result.truncated, status: result.status };
}

export { safeFetchText };
