import { join } from 'node:path';
import { JsonStore } from './store.js';

/**
 * Preferences about the view, kept beside the boards.
 *
 * Not `localStorage`, which is where this kind of thing would normally live:
 * the renderer is loaded from a `file://` URL, and Chromium treats that origin
 * as opaque and throws its storage away when the window closes. A preference
 * written there is remembered until the app is restarted, which is exactly when
 * remembering it matters — so it is kept in a file the main process owns, like
 * boards, skills and the MCP catalogue.
 */
export class SettingsService {
  private readonly store: JsonStore<Record<string, unknown>>;

  constructor(dataDir: string) {
    this.store = new JsonStore<Record<string, unknown>>(join(dataDir, 'settings.json'), () => ({}));
  }

  all(): Record<string, unknown> {
    return { ...this.store.get() };
  }

  /** Writes one preference and hands back the whole set, as the renderer holds it. */
  set(key: string, value: unknown): Record<string, unknown> {
    this.store.update((data) => {
      if (value === undefined || value === null) delete data[key];
      else data[key] = value;
    });
    return this.all();
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
}
