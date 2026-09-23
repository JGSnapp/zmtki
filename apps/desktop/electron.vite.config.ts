import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The layout engine runs on a worker thread; it is built next to the
          // main bundle so `new Worker(...)` can find it by file name.
          'arrange.worker': resolve('src/main/layout/arrange.worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // CommonJS: a preload script runs before ESM is available in the
        // isolated world, so an .mjs bundle would fail to load.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    // Brand artwork (logo.png, icon.png) lives in one folder that the main
    // process reads for the window icon and the renderer serves as static files.
    publicDir: resolve('resources'),
    plugins: [react()],
    // Pinned to IPv4: on Windows `localhost` can resolve to ::1 for Vite and
    // to 127.0.0.1 for Electron, and the window then loads nothing.
    server: { host: '127.0.0.1', port: 5173, strictPort: false },
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
  },
});
