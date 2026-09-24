import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: { externalizeDeps: true, rollupOptions: { input: resolve('src/main/index.ts') } },
  },
  preload: {
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
            if (id.includes('/monaco-editor/esm/vs/')) {
              const contributor = /\/editor\/contrib\/([^/]+)\//.exec(id)?.[1];
              if (contributor) return `monaco-contrib-${contributor}`;
              const editorPart = /\/editor\/(browser|common)\/([^/]+)\//.exec(id);
              if (editorPart?.[1] && editorPart[2]) {
                return `monaco-editor-${editorPart[1]}-${editorPart[2]}`;
              }
              if (id.includes('/editor/standalone/')) return 'monaco-standalone';
              if (id.includes('/editor/')) return 'monaco-editor-core';
              if (id.includes('/base/browser/')) return 'monaco-base-browser';
              if (id.includes('/base/common/')) return 'monaco-base-common';
              if (id.includes('/base/')) return 'monaco-base-core';
              if (id.includes('/platform/browser/')) return 'monaco-platform-browser';
              if (id.includes('/platform/common/')) return 'monaco-platform-common';
              if (id.includes('/platform/')) return 'monaco-platform-core';
              return;
            }
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
