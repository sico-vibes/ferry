import { defineConfig } from 'tsup';
import { cp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyStorageMigrations } from '../../packages/storage/scripts/copy-migrations.js';

const cliDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ['src/ferry.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  define: {
    'process.env.FERRY_RELEASE_VERSION': JSON.stringify(
      process.env.FERRY_RELEASE_VERSION ?? '0.9.0',
    ),
  },
  noExternal: [/@ferry\//],
  splitting: false,
  clean: false,
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __ferryCreateRequire } from 'node:module';",
      'const require = __ferryCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  onSuccess: async () => {
    await cp(
      resolve(cliDirectory, '../../packages/catalog/data'),
      resolve(cliDirectory, 'dist/data'),
      { recursive: true },
    );
    await copyStorageMigrations(
      resolve(cliDirectory, '../../packages/storage/src/migrations'),
      resolve(cliDirectory, 'dist/migrations'),
    );
  },
});
