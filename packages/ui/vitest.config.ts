import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'src/**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
    environment: 'node',
    isolate: false,
    pool: 'threads',
    maxWorkers: 4,
    testTimeout: 30_000,
  },
});
