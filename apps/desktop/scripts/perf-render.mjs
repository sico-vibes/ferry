import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const packageRoot = resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:4175';
const workspace = await mkdtemp(join(tmpdir(), 'ferry-perf-render-'));
const server = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    '--config',
    'vite.web.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    '4175',
    '--strictPort',
  ],
  { cwd: packageRoot, stdio: 'ignore', windowsHide: true },
);
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null)
      throw new Error(`Vite dev server exited with code ${String(server.exitCode)}`);
    try {
      if ((await fetch(origin)).ok) {
        ready = true;
        break;
      }
    } catch {
      await delay(100);
    }
  }
  if (!ready) throw new Error('Timed out waiting for the renderer dev server.');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${origin}/?perf-render`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.ferryPerfClient && window.ferryPerfNavigate));
  const sessionId = await page.evaluate(async (path) => {
    const client = window.ferryPerfClient;
    if (!client) throw new Error('Performance harness client is missing.');
    const workspace = await client.workspaces.open(path);
    return (await client.sessions.create({ workspaceId: workspace.id })).id;
  }, workspace);
  const navigate = async (path, screen) => {
    await page.evaluate((route) => window.ferryPerfNavigate?.(route), path);
    await page.waitForFunction((name) => (window.ferryPerfRenderCounts?.[name] ?? 0) > 0, screen);
    await page.waitForTimeout(250);
  };
  await navigate('/', 'Home');
  await navigate(`/s/${sessionId}`, 'Session');
  await navigate('/explore', 'Explore');
  await navigate('/settings', 'Settings');
  const renders = await page.evaluate(() => window.ferryPerfRenderCounts ?? {});
  const result = { benchmark: 'screen-renders', harness: 'dev-only React Profiler', renders };
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  server.kill();
  await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
