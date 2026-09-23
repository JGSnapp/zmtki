import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The layout engine is a search; the playground's own suite allows the same.
    testTimeout: 20_000,
  },
});
