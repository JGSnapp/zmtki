import type { AppSettings, SearchProviderId } from '../app/settings.js';
import { SEARCH_PROVIDERS, type SearchContext, type SearchResult } from './providers.js';

export interface SearchKeys {
  brave: string;
  tavily: string;
  serper: string;
  googlePse: string;
}

export const EMPTY_SEARCH_KEYS: SearchKeys = { brave: '', tavily: '', serper: '', googlePse: '' };

export interface SearchOutcome {
  results: SearchResult[];
  provider: SearchProviderId;
  /** Providers that were tried and failed, with their reason. */
  attempts: Array<{ provider: SearchProviderId; error: string }>;
}

/**
 * Runs the configured provider, then walks the fallback chain. A missing key
 * is a skip rather than an error, so a half-configured install still searches.
 */
export class SearchService {
  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly getKeys: () => SearchKeys
  ) {}

  private keyFor(provider: SearchProviderId): string {
    const keys = this.getKeys();
    switch (provider) {
      case 'brave':
        return keys.brave;
      case 'tavily':
        return keys.tavily;
      case 'serper':
        return keys.serper;
      case 'google_pse':
        return keys.googlePse;
      default:
        return '';
    }
  }

  async search(query: string, limit?: number): Promise<SearchOutcome> {
    const settings = this.getSettings();
    if (settings.searchProvider === 'disabled') {
      return { results: [], provider: 'disabled', attempts: [] };
    }

    const chain: SearchProviderId[] = [
      settings.searchProvider,
      ...settings.searchFallbackChain.filter((p) => p !== settings.searchProvider)
    ];

    const attempts: SearchOutcome['attempts'] = [];
    for (const provider of chain) {
      const fn = SEARCH_PROVIDERS[provider];
      if (!fn) continue;

      const apiKey = this.keyFor(provider);
      if (needsKey(provider) && !apiKey) {
        attempts.push({ provider, error: 'нет API-ключа' });
        continue;
      }

      const ctx: SearchContext = {
        apiKey,
        instanceUrl: settings.searchUrl,
        googleCx: settings.googlePseCx,
        count: limit ?? settings.searchResultCount
      };

      try {
        const results = await fn(query, ctx);
        if (results.length > 0) return { results, provider, attempts };
        attempts.push({ provider, error: 'пустая выдача' });
      } catch (err) {
        attempts.push({ provider, error: (err as Error).message });
      }
    }

    return { results: [], provider: chain[0] ?? 'disabled', attempts };
  }
}

function needsKey(provider: SearchProviderId): boolean {
  return provider === 'brave' || provider === 'tavily' || provider === 'serper' || provider === 'google_pse';
}
