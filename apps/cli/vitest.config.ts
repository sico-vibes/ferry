import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      FERRY_KEYRING_SERVICE: 'Ferry-CLI-Tests',
      FERRY_TEST_KEYRING_NAMESPACE: 'ferry-cli-tests',
    },
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    passWithNoTests: true,
    fileParallelism: false,
    testTimeout: 60_000,
    globalSetup: ['./test/global-setup.ts'],
  },
});
