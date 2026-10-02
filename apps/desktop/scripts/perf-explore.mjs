import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

if (process.env.FERRY_SKIP_WEB_BUILD !== '1') await import('./build-web.mjs');

const port = 4176;
const origin = `http://127.0.0.1:${String(port)}`;
const server = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--config',
    'vite.web.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { cwd: process.cwd(), stdio: 'ignore', windowsHide: true },
);
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null)
      throw new Error(`Preview exited with ${String(server.exitCode)}.`);
    try {
      if ((await fetch(origin)).ok) {
        ready = true;
        break;
      }
    } catch {
      await delay(100);
    }
  }
  if (!ready) throw new Error('Timed out waiting for the renderer preview.');
  browser = await chromium.launch({ headless: true });
  const measure = async (query) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        window.ferryExploreDomReady = performance.now();
      });
    });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/models/catalog?demo=explore-perf${query}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.locator('.v2-app-shell').waitFor();
      await page.getByRole('heading', { name: 'Models', exact: true }).waitFor();
      const expectedRows = query ? 1_200 : 50;
      await page
        .locator('tbody tr')
        .nth(expectedRows - 1)
        .waitFor({ timeout: 120_000 });
      return await page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0];
        const ready = window.ferryExploreDomReady ?? navigation?.domContentLoadedEventEnd ?? 0;
        return {
          domContentLoadedToRowsMs: Number((performance.now() - ready).toFixed(1)),
          navigationStartToRowsMs: Number(performance.now().toFixed(1)),
          rows: document.querySelectorAll('tbody tr').length,
          modelsReported: window.ferryPerfModelCount ?? null,
          transferSizeBytes: navigation?.transferSize ?? null,
        };
      });
    } finally {
      await context.close();
    }
  };
  const before = await measure('&perfList=all');
  const after = await measure('');
  console.log(JSON.stringify({ benchmark: 'explore-models-1200', before, after }));
} finally {
  await browser?.close();
  server.kill();
}
