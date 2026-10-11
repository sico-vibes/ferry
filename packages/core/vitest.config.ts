import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      FERRY_KEYRING_SERVICE: 'Ferry-Core-Tests',
      FERRY_TEST_KEYRING_NAMESPACE: 'ferry-core-tests',
    },
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    // Catalog loading and Windows process fixtures can starve readiness deadlines
    // even with two files in flight. Keep integration files serial, with their
    // existing assertions and bounded polling deadlines unchanged.
    maxWorkers: 1,
  },
});
