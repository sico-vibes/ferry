import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 20_000,
  use: { baseURL: 'http://127.0.0.1:5174', headless: true, viewport: { width: 1440, height: 900 } },
  webServer: {
    command: 'node scripts/serve-built.mjs',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    timeout: 15_000,
  },
  reporter: 'line',
});
