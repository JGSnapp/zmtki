/** Channel names shared by main and preload. */
export const IPC = {
  /** Renderer -> main, request/response. */
  submit: 'zmtki:submit',
  /** Main -> renderer, streamed events. */
  event: 'zmtki:event',
  /** Renderer -> main, fire and forget high-frequency input (terminal keys). */
  push: 'zmtki:push',
  /** Main -> renderer, JPEG/PNG data URLs for appView headless/mirror frames. */
  appViewFrame: 'zmtki:appView.frame'
} as const;

export const APP_SCHEME = 'zmtki';
