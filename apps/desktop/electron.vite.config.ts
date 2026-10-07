import { resolve } from 'node:path';
import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { copyStorageMigrations } from '../../packages/storage/scripts/copy-migrations.js';
import { stageOAuthRuntime } from './scripts/stage-oauth-runtime.mjs';

const releaseVersion = process.env.FERRY_RELEASE_VERSION ?? '0.9.0';

const bundledWorkspacePackages = [
  '@ferry/core',
  '@ferry/config',
  '@ferry/secrets',
  '@ferry/storage',
  '@ferry/workspace',
  '@ferry/client',
  '@ferry/shared',
  '@ferry/agent',
  '@ferry/catalog',
  '@ferry/delegate',
  '@ferry/extensions',
  '@ferry/optimizer',
  '@ferry/providers',
  '@ferry/quota',
  '@ferry/router',
  '@ferry/cloud',
  '@ferry/oauth',
];

const copyMigrationsPlugin = {
  name: 'ferry-copy-storage-migrations',
  async closeBundle() {
    const output = resolve('out/main/migrations');
    await copyStorageMigrations(resolve('../../packages/storage/src/migrations'), output);
    await cp(resolve('../../packages/catalog/data'), resolve('out/data'), { recursive: true });
    await stageOAuthRuntime(resolve('out/main/node_modules'));
  },
};

export default defineConfig({
  main: {
    define: {
      'process.env.FERRY_COMMIT': JSON.stringify(process.env.FERRY_COMMIT ?? 'unknown'),
      'process.env.FERRY_RELEASE_VERSION': JSON.stringify(releaseVersion),
    },
    plugins: [copyMigrationsPlugin],
    resolve: { alias: { '@ferry/core': resolve('../../packages/core/src/index.ts') } },
    build: {
      externalizeDeps: {
        exclude: bundledWorkspacePackages,
        include: [
          'better-sqlite3',
          'node-pty',
          '@napi-rs/keyring',
          '@napi-rs/keyring-win32-x64-msvc',
          '@vscode/ripgrep',
          '@vscode/tree-sitter-wasm',
          'pino',
          'pino-roll',
          'electron-updater',
          '@earendil-works/pi-ai',
        ],
      },
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'core-entry': resolve('src/main/core-entry.ts'),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    define: {
      'process.env.FERRY_COMMIT': JSON.stringify(process.env.FERRY_COMMIT ?? 'unknown'),
      'process.env.FERRY_RELEASE_VERSION': JSON.stringify(releaseVersion),
    },
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        'monaco-editor/esm/vs/editor/editor.api.js': fileURLToPath(
          new URL('./node_modules/monaco-editor/esm/vs/editor/editor.api.js', import.meta.url),
        ),
      },
    },
    build: {
      manifest: true,
      outDir: resolve('out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          hoistTransitiveImports: false,
          manualChunks(id) {
            if (id.includes('vite/preload-helper')) return 'vendor-preload';
            if (id.includes('/packages/client/src/')) return 'vendor-client';
            if (id.includes('/packages/shared/src/')) return 'vendor-shared';
            if (!id.includes('node_modules')) return;
            if (id.includes('/zod/')) return 'vendor-zod';
            if (id.includes('/recharts/')) return 'vendor-recharts';
            if (id.includes('/d3-')) return 'vendor-d3';
            if (id.includes('/node_modules/react-dom/')) return 'vendor-react-dom';
            if (id.includes('/node_modules/scheduler/')) return 'vendor-scheduler';
            if (id.includes('/node_modules/react/')) return 'vendor-react';
            if (id.includes('/@tanstack/')) return 'vendor-tanstack';
            if (id.includes('/lucide-react/')) return 'vendor-icons';
          },
        },
      },
    },
  },
});
