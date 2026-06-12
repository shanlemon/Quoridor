import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // CPU-bound bot-vs-bot simulations block the event loop for seconds at a
    // time; the forks pool tolerates that without worker-RPC heartbeat flakes.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text'],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 88,
      },
    },
  },
});
