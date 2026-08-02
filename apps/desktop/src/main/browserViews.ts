import type { BrowserWindow } from 'electron';
import { AppViewHost, type ViewBounds } from './appViewHost.js';

export type { ViewBounds };

/**
 * Backward-compatible wrapper around {@link AppViewHost} for legacy `browser`
 * artifacts. New code should use AppViewHost / `appView` directly.
 */
export class BrowserArtifactHost {
  private readonly host: AppViewHost;

  constructor(window: BrowserWindow, sendFrame?: (nodeId: string, dataUrl: string) => void) {
    this.host = new AppViewHost(window, sendFrame ?? (() => undefined));
  }

  /** Expose the underlying host for appView wiring. */
  asAppViewHost(): AppViewHost {
    return this.host;
  }

  async navigate(nodeId: string, url: string): Promise<void> {
    await this.host.navigateBrowser(nodeId, url);
  }

  setBounds(nodeId: string, bounds: ViewBounds | null, visible: boolean): void {
    this.host.setBrowserBounds(nodeId, bounds, visible);
  }

  async capture(nodeId: string): Promise<string | null> {
    // Frames are pushed over IPC; pull one-shot via open headless capture if needed.
    void nodeId;
    return null;
  }

  destroy(nodeId: string): void {
    this.host.destroy(nodeId);
  }

  destroyAll(): void {
    this.host.destroyAll();
  }
}
