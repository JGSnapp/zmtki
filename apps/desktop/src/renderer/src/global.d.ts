import type { ZmtkiApi } from '../../preload/index.js';

declare global {
  interface Window {
    zmtki: ZmtkiApi;
  }
}

export {};
