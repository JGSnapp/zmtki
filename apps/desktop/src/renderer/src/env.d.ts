import type { DesktopApi } from '../../shared/ipc';

declare global {
  interface Window {
    zmtki: DesktopApi;
  }
}

export {};
