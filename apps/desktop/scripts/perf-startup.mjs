import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const packageRoot = resolve(import.meta.dirname, '..');
const executable = join(packageRoot, 'release', 'win-unpacked', 'Ferry.exe');
const userDataDirectory = await mkdtemp(join(tmpdir(), 'ferry-perf-startup-'));
const freePort = async () => {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a debug port.');
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
};

async function launchAndMeasure(label, completeFirstRun) {
  const port = await freePort();
  const startedAt = performance.now();
  const application = spawn(
    executable,
    [
      '--disable-gpu',
      '--in-process-gpu',
      '--use-gl=swiftshader',
      '--no-sandbox',
      `--remote-debugging-port=${String(port)}`,
    ],
    {
      cwd: packageRoot,
      env: { ...process.env, FERRY_E2E_USER_DATA_DIR: userDataDirectory },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  let browser;
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (application.exitCode !== null || application.signalCode !== null)
        throw new Error(
          `${label} launch exited with code ${String(application.exitCode)} and signal ${String(application.signalCode)}.`,
        );
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
        if (response.ok) break;
      } catch {
        await delay(100);
      }
    }
    if (Date.now() >= deadline) throw new Error(`${label} launch timed out waiting for DevTools.`);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`, {
      timeout: 10_000,
    });
    const context = browser.contexts()[0];
    if (!context) throw new Error(`${label} launch did not expose a browser context.`);
    let page;
    const pageDeadline = Date.now() + 30_000;
    while (Date.now() < pageDeadline) {
      page = context.pages().find((candidate) => candidate.url().startsWith('file://'));
      if (page) break;
      await delay(100);
    }
    if (!page) throw new Error(`${label} launch did not open the Ferry renderer.`);
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
    const composer = page.getByRole('textbox', { name: 'Message Ferry' });
    const skipSetup = page.getByRole('button', { name: 'Skip setup' });
    await Promise.race([
      composer.waitFor({ state: 'visible', timeout: 30_000 }),
      skipSetup.waitFor({ state: 'visible', timeout: 30_000 }),
    ]);
    if (completeFirstRun && (await skipSetup.isVisible())) {
      await skipSetup.click();
      await composer.waitFor({ state: 'visible', timeout: 15_000 });
    }
    const interactiveMs = Number((performance.now() - startedAt).toFixed(1));
    return { interactiveMs, firstRun: await skipSetup.isVisible().catch(() => false) };
  } finally {
    await browser?.close();
    if (application.exitCode === null) {
      const exitWait = new Promise((resolveExit) => application.once('exit', resolveExit));
      const treeKill = spawn('taskkill.exe', ['/pid', String(application.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      treeKill.once('error', () => application.kill());
      await Promise.race([
        new Promise((resolveExit) => treeKill.once('exit', resolveExit)),
        delay(5_000),
      ]);
      if (application.exitCode === null) application.kill();
      await Promise.race([exitWait, delay(5_000)]);
    }
  }
}

try {
  const warmup = await launchAndMeasure('Warm-up', true);
  const measured = await launchAndMeasure('Warm', false);
  const result = {
    benchmark: 'packaged-startup',
    targetMs: 2_000,
    warmupInteractiveMs: warmup.interactiveMs,
    warmInteractiveMs: measured.interactiveMs,
    firstRunOnboarding: measured.firstRun,
  };
  console.log(JSON.stringify(result));
  if (measured.interactiveMs >= result.targetMs) process.exitCode = 1;
} finally {
  await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
