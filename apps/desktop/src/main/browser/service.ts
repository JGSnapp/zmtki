import { clipboard } from 'electron';
import type { BrowserInput, BrowserTabState } from '../../shared/ipc.js';
import type { ChromeHost } from './chrome.js';

interface Tab {
  artifactId: string;
  targetId: string;
  sessionId: string;
  state: BrowserTabState;
  width: number;
  height: number;
  scale: number;
  streaming: boolean;
  /** Frames sent to the renderer and not yet drawn; the next is acked only then. */
  unackedFrame: number | null;
}

export interface BrowserEvents {
  frame(artifactId: string, data: Uint8Array, width: number, height: number): void;
  state(state: BrowserTabState): void;
  /** The page navigated on its own: the card's stored URL should follow. */
  navigated(artifactId: string, url: string): void;
}

const HOME = 'https://www.google.com/';

/** What a user typed into the address bar, as a URL: a link, a domain, or a Google search. */
export const toUrl = (input: string): string => {
  const text = input.trim();
  if (!text) return HOME;
  if (/^(https?|file|about|chrome):/i.test(text)) return text;
  if (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(text) && !text.includes(' ')) return 'https://' + text;
  return 'https://www.google.com/search?q=' + encodeURIComponent(text);
};

const MAX_FRAME_EDGE = 2560;

/**
 * Browser cards as Chrome tabs.
 *
 * A tab renders at the card's CSS size — as a real window of that size would —
 * with a device scale factor that follows the board zoom, so text stays sharp
 * when zoomed in. Frames flow only while the card is on screen, and each is
 * acknowledged only after the renderer drew the previous one: a busy page can
 * never flood the board with frames it cannot show.
 */
export class BrowserService {
  private readonly tabs = new Map<string, Tab>();
  private readonly bySession = new Map<string, Tab>();
  private readonly byTarget = new Map<string, Tab>();

  constructor(
    private readonly chrome: ChromeHost,
    private readonly events: BrowserEvents,
  ) {
    chrome.onEvent((method, params, sessionId) => this.onEvent(method, params, sessionId));
  }

  get available(): boolean {
    return this.chrome.available;
  }

  private publish(tab: Tab): void {
    this.events.state({ ...tab.state });
  }

  async open(artifactId: string, url: string, width: number, height: number, scale: number): Promise<BrowserTabState> {
    const existing = this.tabs.get(artifactId);
    if (existing) {
      // A renderer that reloaded lost the frame it had not acknowledged; the
      // stream restarts when it asks for one again.
      existing.streaming = false;
      existing.unackedFrame = null;
      await this.chrome.send('Page.stopScreencast', {}, existing.sessionId).catch(() => undefined);
      await this.resize(artifactId, width, height, scale);
      return { ...existing.state };
    }
    await this.chrome.ensure();
    const target = (await this.chrome.send('Target.createTarget', { url: 'about:blank', newWindow: true })) as { targetId: string };
    const attached = (await this.chrome.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })) as {
      sessionId: string;
    };
    const tab: Tab = {
      artifactId,
      targetId: target.targetId,
      sessionId: attached.sessionId,
      state: { artifactId, url: '', title: '', loading: true, canGoBack: false, canGoForward: false, error: undefined },
      width,
      height,
      scale,
      streaming: false,
      unackedFrame: null,
    };
    this.tabs.set(artifactId, tab);
    this.bySession.set(tab.sessionId, tab);
    this.byTarget.set(tab.targetId, tab);

    const s = tab.sessionId;
    await Promise.all([
      this.chrome.send('Page.enable', {}, s),
      this.chrome.send('Network.setUserAgentOverride', { userAgent: this.chrome.userAgent }, s),
      this.chrome.send('Page.setLifecycleEventsEnabled', { enabled: true }, s),
      /*
       * Every tab renders, not just the one Chrome considers to be in front.
       *
       * A board shows several pages at once, but a browser has one foreground
       * tab and the rest are background tabs — and a background tab produces no
       * compositor frames, so `Page.startScreencast` is accepted and then stays
       * silent for ever. That is why a board of six browser cards used to show
       * one page and five empty rectangles: the screencast was running on all
       * six, and only the foreground one had anything to send.
       *
       * The launch flags against backgrounding are not enough on their own;
       * this is the switch that makes a page behave as the focused one.
       */
      this.chrome.send('Emulation.setFocusEmulationEnabled', { enabled: true }, s),
    ]);
    await this.applyMetrics(tab);
    await this.chrome.send('Page.navigate', { url: toUrl(url) }, s);
    return { ...tab.state };
  }

  private async applyMetrics(tab: Tab): Promise<void> {
    const width = Math.max(200, Math.round(tab.width));
    const height = Math.max(120, Math.round(tab.height));
    const scale = Math.min(MAX_FRAME_EDGE / width, Math.max(0.5, tab.scale));
    await this.chrome.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: scale, mobile: false },
      tab.sessionId,
    );
    if (tab.streaming) await this.restartScreencast(tab);
  }

  private async restartScreencast(tab: Tab): Promise<void> {
    const width = Math.round(Math.max(200, tab.width) * Math.max(0.5, tab.scale));
    const height = Math.round(Math.max(120, tab.height) * Math.max(0.5, tab.scale));
    await this.chrome.send('Page.stopScreencast', {}, tab.sessionId).catch(() => undefined);
    tab.unackedFrame = null;
    await this.chrome.send(
      'Page.startScreencast',
      { format: 'jpeg', quality: 82, maxWidth: Math.min(MAX_FRAME_EDGE, width), maxHeight: Math.min(MAX_FRAME_EDGE, height), everyNthFrame: 1 },
      tab.sessionId,
    );
  }

  async resize(artifactId: string, width: number, height: number, scale: number): Promise<void> {
    const tab = this.tabs.get(artifactId);
    if (!tab) return;
    if (Math.abs(tab.width - width) < 1 && Math.abs(tab.height - height) < 1 && Math.abs(tab.scale - scale) < 0.01) return;
    tab.width = width;
    tab.height = height;
    tab.scale = scale;
    await this.applyMetrics(tab);
  }

  async setStreaming(artifactId: string, on: boolean): Promise<void> {
    const tab = this.tabs.get(artifactId);
    if (!tab || tab.streaming === on) return;
    tab.streaming = on;
    if (on) await this.restartScreencast(tab);
    else await this.chrome.send('Page.stopScreencast', {}, tab.sessionId).catch(() => undefined);
  }

  /** The renderer finished drawing a frame; let Chrome send the next one. */
  ackFrame(artifactId: string): void {
    const tab = this.tabs.get(artifactId);
    if (!tab || tab.unackedFrame === null) return;
    const sessionId = tab.unackedFrame;
    tab.unackedFrame = null;
    void this.chrome.send('Page.screencastFrameAck', { sessionId }, tab.sessionId).catch(() => undefined);
  }

  async navigate(artifactId: string, input: string): Promise<void> {
    const tab = this.tabs.get(artifactId);
    if (!tab) return;
    await this.chrome.send('Page.navigate', { url: toUrl(input) }, tab.sessionId);
  }

  async history(artifactId: string, direction: -1 | 1): Promise<void> {
    const tab = this.tabs.get(artifactId);
    if (!tab) return;
    const history = (await this.chrome.send('Page.getNavigationHistory', {}, tab.sessionId)) as {
      currentIndex: number;
      entries: Array<{ id: number }>;
    };
    const entry = history.entries[history.currentIndex + direction];
    if (entry) await this.chrome.send('Page.navigateToHistoryEntry', { entryId: entry.id }, tab.sessionId);
  }

  async reload(artifactId: string): Promise<void> {
    const tab = this.tabs.get(artifactId);
    if (tab) await this.chrome.send('Page.reload', {}, tab.sessionId);
  }

  async input(artifactId: string, event: BrowserInput): Promise<void> {
    const tab = this.tabs.get(artifactId);
    if (!tab) return;
    const s = tab.sessionId;
    switch (event.kind) {
      case 'mouse':
        await this.chrome.send(
          'Input.dispatchMouseEvent',
          {
            type: event.type,
            x: event.x,
            y: event.y,
            button: event.button,
            buttons: event.buttons,
            clickCount: event.clickCount,
            modifiers: event.modifiers,
          },
          s,
        );
        break;
      case 'wheel':
        await this.chrome.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseWheel', x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: event.modifiers },
          s,
        );
        break;
      case 'key':
        await this.chrome.send(
          'Input.dispatchKeyEvent',
          {
            type: event.type,
            key: event.key,
            code: event.code,
            text: event.text,
            unmodifiedText: event.text,
            windowsVirtualKeyCode: event.keyCode,
            nativeVirtualKeyCode: event.keyCode,
            modifiers: event.modifiers,
          },
          s,
        );
        break;
      case 'paste': {
        const text = clipboard.readText();
        if (text) await this.chrome.send('Input.insertText', { text }, s);
        break;
      }
      case 'copy': {
        // The headless browser has no system clipboard of its own; the
        // selection is read out of the page and put on the real one.
        const result = (await this.chrome.send(
          'Runtime.evaluate',
          { expression: 'String(window.getSelection ? window.getSelection() : "")', returnByValue: true },
          s,
        )) as { result?: { value?: string } };
        const value = result.result?.value;
        if (value) clipboard.writeText(value);
        break;
      }
    }
  }

  /** The page's own address, for "open in Chrome". */
  urlOf(artifactId: string): string | null {
    return this.tabs.get(artifactId)?.state.url || null;
  }

  async close(artifactId: string): Promise<void> {
    const tab = this.tabs.get(artifactId);
    if (!tab) return;
    this.tabs.delete(artifactId);
    this.bySession.delete(tab.sessionId);
    this.byTarget.delete(tab.targetId);
    await this.chrome.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
  }

  closeAll(): void {
    for (const id of [...this.tabs.keys()]) void this.close(id);
    this.chrome.stop();
  }

  private async refreshHistory(tab: Tab): Promise<void> {
    const history = (await this.chrome
      .send('Page.getNavigationHistory', {}, tab.sessionId)
      .catch(() => null)) as { currentIndex: number; entries: unknown[] } | null;
    if (!history) return;
    tab.state.canGoBack = history.currentIndex > 0;
    tab.state.canGoForward = history.currentIndex < history.entries.length - 1;
    this.publish(tab);
  }

  private onEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (method === 'Target.targetInfoChanged' || method === 'Target.targetCreated') {
      const info = params.targetInfo as { targetId: string; url: string; title: string; openerId?: string; type: string };
      const own = this.byTarget.get(info.targetId);
      if (own) {
        if (info.title !== own.state.title) {
          own.state.title = info.title;
          this.publish(own);
        }
        return;
      }
      // A link that opens a new window stays in the card: navigate the card
      // there and close the popup, rather than leaving an invisible tab.
      const opener = info.openerId ? this.byTarget.get(info.openerId) : undefined;
      if (opener && info.type === 'page' && info.url && info.url !== 'about:blank') {
        void this.chrome.send('Page.navigate', { url: info.url }, opener.sessionId);
        void this.chrome.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined);
      }
      return;
    }

    const tab = sessionId ? this.bySession.get(sessionId) : undefined;
    if (!tab) return;

    switch (method) {
      case 'Page.screencastFrame': {
        const meta = params.metadata as { deviceWidth: number; deviceHeight: number };
        tab.unackedFrame = params.sessionId as number;
        const bytes = Buffer.from(params.data as string, 'base64');
        this.events.frame(tab.artifactId, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), meta.deviceWidth, meta.deviceHeight);
        break;
      }
      case 'Page.frameNavigated': {
        const frame = params.frame as { parentId?: string; url: string; urlFragment?: string };
        if (frame.parentId) break;
        tab.state.url = frame.url + (frame.urlFragment ?? '');
        tab.state.error = undefined;
        this.publish(tab);
        if (tab.state.url !== 'about:blank') this.events.navigated(tab.artifactId, tab.state.url);
        void this.refreshHistory(tab);
        break;
      }
      case 'Page.navigatedWithinDocument': {
        tab.state.url = params.url as string;
        this.publish(tab);
        this.events.navigated(tab.artifactId, tab.state.url);
        void this.refreshHistory(tab);
        break;
      }
      case 'Page.lifecycleEvent': {
        const name = params.name as string;
        if (name === 'init') tab.state.loading = true;
        else if (name === 'load' || name === 'networkIdle') tab.state.loading = false;
        else break;
        this.publish(tab);
        break;
      }
      case 'Page.javascriptDialogOpening':
        // A dialog nobody can see would freeze the page for good.
        void this.chrome.send('Page.handleJavaScriptDialog', { accept: true }, tab.sessionId).catch(() => undefined);
        break;
      default:
        break;
    }
  }
}
