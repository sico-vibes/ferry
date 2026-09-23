import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
    environment: 'node',
    // Type-aware ESLint runs inside tests are slow, especially under parallel turbo runs.
    testTimeout: 30_000,
  },
});
