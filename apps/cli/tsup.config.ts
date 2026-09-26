import { defineConfig } from 'tsup';
import { cp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ['src/ferry.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
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
    await cp(
      resolve(cliDirectory, '../../packages/storage/src/migrations'),
      resolve(cliDirectory, 'dist/migrations'),
      { recursive: true },
    );
  },
});
