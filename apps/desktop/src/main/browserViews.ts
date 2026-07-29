import { WebContentsView, type BrowserWindow } from 'electron';

export interface ViewBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Real browser windows as board artifacts.
 *
 * An iframe cannot host most real sites (X-Frame-Options, cross-origin
 * scripting), so this uses Electron's WebContentsView, which is a genuine
 * browser. The cost is that it renders above the canvas rather than inside it:
 * the renderer sends the artifact's screen rectangle on every camera change and
 * the view is repositioned to match, then hidden entirely when the node scrolls
 * out of sight or the user zooms far enough out that a screenshot will do.
 */
export class BrowserArtifactHost {
  private views = new Map<string, WebContentsView>();

  constructor(private readonly window: BrowserWindow) {}

  private ensure(nodeId: string): WebContentsView {
    const existing = this.views.get(nodeId);
    if (existing) return existing;

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    this.views.set(nodeId, view);
    return view;
  }

  async navigate(nodeId: string, url: string): Promise<void> {
    const view = this.ensure(nodeId);
    try {
      await view.webContents.loadURL(url);
    } catch {
      // A failed load leaves the error page visible, which is the right report.
    }
  }

  setBounds(nodeId: string, bounds: ViewBounds | null, visible: boolean): void {
    const view = this.views.get(nodeId);
    if (!view) return;

    if (!visible || !bounds || bounds.w < 40 || bounds.h < 40) {
      view.setVisible(false);
      return;
    }

    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.w),
      height: Math.round(bounds.h)
    });
    view.setVisible(true);
  }

  /** PNG data URL used as the stand-in when the view is hidden. */
  async capture(nodeId: string): Promise<string | null> {
    const view = this.views.get(nodeId);
    if (!view) return null;
    const image = await view.webContents.capturePage();
    return image.isEmpty() ? null : image.toDataURL();
  }

  destroy(nodeId: string): void {
    const view = this.views.get(nodeId);
    if (!view) return;
    this.window.contentView.removeChildView(view);
    view.webContents.close();
    this.views.delete(nodeId);
  }

  destroyAll(): void {
    for (const nodeId of [...this.views.keys()]) this.destroy(nodeId);
  }
}
