import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    isolate: false,
    pool: 'threads',
    maxWorkers: 2,
    restoreMocks: true,
    clearMocks: true,
  },
});
