import { defineConfig } from 'tsup';

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
  banner: { js: '#!/usr/bin/env node' },
});
