import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      'monaco-editor/esm/vs/editor/editor.api.js': fileURLToPath(
        new URL('./src/test/monaco-editor-api.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    isolate: false,
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
