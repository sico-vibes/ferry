import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const port = 4174;
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
      if ((await fetch(origin)).ok) {
        ready = true;
        break;
      }
    } catch {
      await delay(100);
    }
  }
  if (!ready) throw new Error('Timed out waiting for the built renderer preview.');

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${origin}/?demo=long`, { waitUntil: 'domcontentloaded' });
  await page.locator('.transcript-viewport').waitFor({ state: 'visible' });
  await page.locator('.transcript-message').first().waitFor({ state: 'visible' });
  const initial = await page.evaluate(() => {
    const viewport = document.querySelector('.transcript-viewport');
    const rows = document.querySelectorAll('.transcript-message').length;
    if (!viewport || rows > 40)
      throw new Error(`Expected a virtualized transcript; got ${rows} rows.`);
    viewport.scrollTop = 0;
    return { renderedRows: rows, scrollHeight: viewport.scrollHeight };
  });

  await page.evaluate(async () => {
    const viewport = document.querySelector('.transcript-viewport');
    if (!viewport) throw new Error('Transcript viewport disappeared.');
    for (let step = 0; step < 70; step += 1) {
      viewport.scrollTop = (step % 35) * (viewport.scrollHeight / 35);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  await page.waitForFunction(() => Boolean(window.ferryPerfFrameTimes?.length), null, {
    timeout: 6_000,
  });
  const frames = await page.evaluate(() => window.ferryPerfFrameTimes ?? []);
  const sorted = frames.slice().sort((a, b) => a - b);
  const averageMs = frames.reduce((sum, value) => sum + value, 0) / Math.max(1, frames.length);
  const p95Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const result = {
    ...initial,
    frameSamples: frames.length,
    averageFrameMs: Number(averageMs.toFixed(2)),
    p95FrameMs: Number(p95Ms.toFixed(2)),
    framesOver33ms: frames.filter((value) => value > 33.3).length,
  };
  console.log(JSON.stringify(result));
  if (result.renderedRows > 40 || result.p95FrameMs > 33.3) process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
}
