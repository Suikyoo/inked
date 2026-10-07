import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The integration tests start the real server, which uses node:sqlite.
    execArgv: ['--disable-warning=ExperimentalWarning'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
