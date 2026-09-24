import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      'monaco-editor/esm/vs/editor/editor.api.js': fileURLToPath(
        new URL('./node_modules/monaco-editor/esm/vs/editor/editor.api.js', import.meta.url),
      ),
    },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    outDir: resolve('out/web'),
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
});
