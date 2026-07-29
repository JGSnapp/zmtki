import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    // The preload bundle is CommonJS, but the workspace packages are ESM-only.
    // Leaving @zmtki/protocol external makes Electron require() an ESM package
    // at load time, which fails and leaves the renderer with no bridge at all.
    // Bundling it in costs a couple of kilobytes of IPC channel constants.
    plugins: [externalizeDepsPlugin({ exclude: ['@zmtki/protocol', '@zmtki/board-schema'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      // Explicit because the renderer root is a subfolder; without this the
      // output lands outside the app directory and main cannot find index.html.
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
});
