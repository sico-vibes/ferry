import { defineConfig } from 'tsup';
import { cp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyStorageMigrations } from '../../packages/storage/scripts/copy-migrations.js';

const cliDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ['src/ferry.ts', 'src/runtime-paths.ts', 'src/format.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  define: {
    'process.env.DEV': JSON.stringify('false'),
    'process.env.FERRY_RELEASE_VERSION': JSON.stringify(
      process.env.FERRY_RELEASE_VERSION ?? '0.9.0',
    ),
  },
  esbuildPlugins: [
    {
      name: 'ferry-disable-optional-react-devtools',
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: 'react-devtools-core',
          namespace: 'ferry-empty-devtools',
        }));
        build.onLoad({ filter: /.*/, namespace: 'ferry-empty-devtools' }, () => ({
          contents: 'export default { initialize() {}, connectToDevTools() {} };',
          loader: 'js',
        }));
      },
    },
  ],
  noExternal: [
    /^(?!(?:better-sqlite3|node-pty|pino|@napi-rs\/keyring(?:-win32-x64-msvc)?|@vscode\/ripgrep(?:-win32-x64)?)(?:\/|$)).+/,
  ],
  external: [
    'better-sqlite3',
    'node-pty',
    'pino',
    '@napi-rs/keyring',
    '@napi-rs/keyring-win32-x64-msvc',
    '@vscode/ripgrep',
    '@vscode/ripgrep-win32-x64',
  ],
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
