import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      FERRY_KEYRING_SERVICE: 'Ferry-Script-Tests',
      FERRY_TEST_KEYRING_NAMESPACE: 'ferry-script-tests',
    },
    include: ['scripts/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 30_000,
  },
});
