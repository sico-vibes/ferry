import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    // Uncapped file concurrency makes the existing cancellation timing checks
    // flaky alongside the provider catalog and child-process fixtures.
    maxWorkers: 2,
  },
});
