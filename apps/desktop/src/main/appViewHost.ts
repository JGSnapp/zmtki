import {
  WebContentsView,
  desktopCapturer,
  type BrowserWindow,
  type NativeImage
} from 'electron';

function jpegDataUrl(image: NativeImage, quality = 72): string {
  const buf = image.toJPEG(quality);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

export interface ViewBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AppViewMode = 'web' | 'headless' | 'mirror';

export interface AppViewOpenOpts {
  mode: AppViewMode;
  url?: string;
  sourceId?: string;
  sourceName?: string;
  fps?: number;
  live?: boolean;
}

export interface AppViewSourceInfo {
  id: string;
  name: string;
  kind: 'window' | 'screen';
  thumbnailDataUrl: string;
}

interface Session {
  mode: AppViewMode;
  view: WebContentsView | null;
  sourceId: string;
  sourceName: string;
  fps: number;
  live: boolean;
  bounds: ViewBounds | null;
  overlayVisible: boolean;
  captureTimer: ReturnType<typeof setInterval> | null;
  capturing: boolean;
}

/**
 * Hosts live application surfaces for board artifacts:
 * - web: interactive WebContentsView overlaid on the node
 * - headless: hidden WebContents + frame stream
 * - mirror: desktopCapturer thumbnails of a real OS window/screen
 */
export class AppViewHost {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly window: BrowserWindow,
    private readonly sendFrame: (nodeId: string, dataUrl: string) => void
  ) {}

  async listSources(): Promise<AppViewSourceInfo[]> {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      thumbnailDataUrl: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL()
    }));
  }

  async open(nodeId: string, opts: AppViewOpenOpts): Promise<void> {
    const prev = this.sessions.get(nodeId);
    if (prev) this.destroy(nodeId);

    const session: Session = {
      mode: opts.mode,
      view: null,
      sourceId: opts.sourceId ?? '',
      sourceName: opts.sourceName ?? '',
      fps: Math.max(1, Math.min(30, opts.fps ?? 8)),
      live: opts.live !== false,
      bounds: null,
      overlayVisible: false,
      captureTimer: null,
      capturing: false
    };
    this.sessions.set(nodeId, session);

    if (opts.mode === 'web' || opts.mode === 'headless') {
      session.view = this.createView(opts.mode === 'web' && session.live);
      const url = opts.url && opts.url.length > 0 ? opts.url : 'about:blank';
      try {
        await session.view.webContents.loadURL(url);
      } catch {
        // Leave the error page; agent/human can navigate again.
      }
    }

    if (opts.mode === 'headless' || opts.mode === 'mirror') {
      this.startCapture(nodeId);
    } else if (opts.mode === 'web' && !session.live) {
      this.startCapture(nodeId);
    }
  }

  async navigate(nodeId: string, url: string): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (!session) {
      await this.open(nodeId, { mode: 'web', url, live: true });
      return;
    }
    if (!session.view) {
      session.view = this.createView(session.mode === 'web' && session.live);
    }
    try {
      await session.view.webContents.loadURL(url);
    } catch {
      // Keep prior content on failure.
    }
  }

  setBounds(nodeId: string, bounds: ViewBounds | null, visible: boolean): void {
    const session = this.sessions.get(nodeId);
    if (!session) return;
    session.bounds = bounds;
    session.overlayVisible = visible && session.mode === 'web' && session.live;

    if (session.view && session.mode === 'web' && session.live) {
      if (!visible || !bounds || bounds.w < 40 || bounds.h < 40) {
        session.view.setVisible(false);
      } else {
        session.view.setBounds({
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.w),
          height: Math.round(bounds.h)
        });
        session.view.setVisible(true);
      }
    } else if (session.view) {
      session.view.setVisible(false);
    }

    // Stream frames when overlay is off (zoomed out web, headless, mirror).
    const needsCapture =
      session.mode === 'headless' ||
      session.mode === 'mirror' ||
      (session.mode === 'web' && (!session.live || !session.overlayVisible));
    if (needsCapture) this.startCapture(nodeId);
    else this.stopCapture(nodeId);
  }

  /** Compatibility shim for legacy `browser` artifacts. */
  async navigateBrowser(nodeId: string, url: string): Promise<void> {
    const existing = this.sessions.get(nodeId);
    if (!existing) {
      await this.open(nodeId, { mode: 'web', url, live: true });
      return;
    }
    await this.navigate(nodeId, url);
  }

  setBrowserBounds(nodeId: string, bounds: ViewBounds | null, visible: boolean): void {
    if (!this.sessions.has(nodeId)) {
      // Lazy session so first bounds report still attaches a view.
      void this.open(nodeId, { mode: 'web', url: 'about:blank', live: true }).then(() => {
        this.setBounds(nodeId, bounds, visible);
      });
      return;
    }
    this.setBounds(nodeId, bounds, visible);
  }

  destroy(nodeId: string): void {
    const session = this.sessions.get(nodeId);
    if (!session) return;
    this.stopCapture(nodeId);
    if (session.view) {
      try {
        this.window.contentView.removeChildView(session.view);
        session.view.webContents.close();
      } catch {
        // View may already be detached.
      }
    }
    this.sessions.delete(nodeId);
  }

  destroyAll(): void {
    for (const id of [...this.sessions.keys()]) this.destroy(id);
  }

  private createView(attachVisible: boolean): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    this.window.contentView.addChildView(view);
    view.setVisible(attachVisible);
    return view;
  }

  private startCapture(nodeId: string): void {
    const session = this.sessions.get(nodeId);
    if (!session || session.captureTimer) return;
    const intervalMs = Math.round(1000 / session.fps);
    session.captureTimer = setInterval(() => {
      void this.captureOnce(nodeId);
    }, intervalMs);
    void this.captureOnce(nodeId);
  }

  private stopCapture(nodeId: string): void {
    const session = this.sessions.get(nodeId);
    if (!session?.captureTimer) return;
    clearInterval(session.captureTimer);
    session.captureTimer = null;
  }

  private async captureOnce(nodeId: string): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (!session || session.capturing) return;
    session.capturing = true;
    try {
      if (session.mode === 'mirror') {
        if (!session.sourceId) return;
        const sources = await desktopCapturer.getSources({
          types: ['window', 'screen'],
          thumbnailSize: { width: 1280, height: 720 }
        });
        const match = sources.find((s) => s.id === session.sourceId);
        if (!match || match.thumbnail.isEmpty()) return;
        this.sendFrame(nodeId, jpegDataUrl(match.thumbnail));
        return;
      }

      if (!session.view) return;
      const image = await session.view.webContents.capturePage();
      if (image.isEmpty()) return;
      this.sendFrame(nodeId, jpegDataUrl(image));
    } catch {
      // Transient capture failures are expected during navigation.
    } finally {
      session.capturing = false;
    }
  }
}
