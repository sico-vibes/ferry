import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const port = 4173;
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
      throw new Error(`Vite preview exited with code ${String(server.exitCode)}`);
    try {
      const response = await fetch(origin);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      await delay(100);
    }
  }
  if (!ready) throw new Error('Timed out waiting for the built renderer preview.');

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Message Ferry' }).waitFor({ state: 'visible' });
  const result = await page.evaluate(() => {
    const composer = document.querySelector('[aria-label="Message Ferry"]');
    if (!composer || composer.disabled || composer.tabIndex < 0) {
      throw new Error('Composer is visible but not focusable.');
    }
    return { interactiveMs: Number(performance.now().toFixed(1)), focusable: true };
  });
  console.log(JSON.stringify({ url: origin, ...result }));
  if (result.interactiveMs >= 1500) process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
}
