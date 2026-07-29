/** Channel names shared by main and preload. */
export const IPC = {
  /** Renderer -> main, request/response. */
  submit: 'zmtki:submit',
  /** Main -> renderer, streamed events. */
  event: 'zmtki:event',
  /** Renderer -> main, fire and forget high-frequency input (terminal keys). */
  push: 'zmtki:push'
} as const;

export const APP_SCHEME = 'zmtki';
