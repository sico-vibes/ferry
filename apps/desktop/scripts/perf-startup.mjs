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
const runtimeMetrics = {};
let dbQueryMs = null;
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
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const describePage = async () =>
      page.evaluate(() => ({
        url: location.href,
        hash: location.hash,
        title: document.title,
        readyState: document.readyState,
        hasFerryHost: Boolean(window.ferryHost),
        hasEngineHello: Boolean(window.ferryEngineHello),
        hasHybridClient: Boolean(window.ferryHybrid),
        body: document.body?.innerText?.slice(0, 1_200) ?? '',
        textareas: [...document.querySelectorAll('textarea')].map((element) => ({
          ariaLabel: element.getAttribute('aria-label'),
          placeholder: element.getAttribute('placeholder'),
          visible: Boolean(element.getClientRects().length),
        })),
        buttons: [...document.querySelectorAll('button')]
          .filter((element) => element.getClientRects().length)
          .slice(0, 30)
          .map((element) => element.innerText || element.getAttribute('aria-label') || ''),
      }));
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
    } catch (error) {
      const diagnostic = { page: await describePage(), pageErrors };
      console.error(
        JSON.stringify({ benchmark: 'packaged-startup-readiness-timeout', label, ...diagnostic }),
      );
      throw new Error(
        `${label} renderer did not reach DOMContentLoaded: ${JSON.stringify(diagnostic)}`,
        {
          cause: error,
        },
      );
    }
    try {
      await page.waitForFunction(
        () => Boolean(window.ferryHost && window.ferryEngineHello && window.ferryHybrid),
        null,
        { timeout: 30_000 },
      );
    } catch (error) {
      const diagnostic = { page: await describePage(), pageErrors };
      console.error(
        JSON.stringify({ benchmark: 'packaged-startup-engine-timeout', label, ...diagnostic }),
      );
      throw new Error(
        `${label} packaged app did not connect to its local engine: ${JSON.stringify(diagnostic)}`,
        { cause: error },
      );
    }
    // The packaged window can open on a non-Home screen. Startup TTI measures
    // the interactive Home composer, so navigate there explicitly.
    await page.evaluate(() => {
      if (location.hash !== '#/') location.hash = '#/';
    });
    const composer = page.locator('textarea[aria-label="Message Ferry"]');
    const getStarted = page.getByRole('button', { name: /Get started/i });
    const skipSetup = page.getByRole('button', { name: 'Skip setup' });
    try {
      await page.waitForFunction(
        () => {
          const visible = (element) =>
            element instanceof HTMLElement && element.getClientRects().length > 0;
          return (
            visible(document.querySelector('textarea[aria-label="Message Ferry"]')) ||
            [...document.querySelectorAll('button')].some(
              (button) =>
                visible(button) && /^(get started|skip setup)$/i.test(button.innerText.trim()),
            )
          );
        },
        null,
        { timeout: 30_000 },
      );
    } catch (error) {
      const diagnostic = { page: await describePage(), pageErrors };
      console.error(
        JSON.stringify({ benchmark: 'packaged-startup-readiness-timeout', label, ...diagnostic }),
      );
      throw new Error(
        `${label} renderer did not expose onboarding or the composer: ${JSON.stringify(diagnostic)}`,
        {
          cause: error,
        },
      );
    }
    try {
      if (completeFirstRun && !(await composer.isVisible())) {
        if (await getStarted.isVisible().catch(() => false)) {
          await getStarted.click();
          await page.getByRole('button', { name: 'Continue', exact: true }).click();
          await page.getByRole('button', { name: 'Continue', exact: true }).click();
          await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
        } else if (await skipSetup.isVisible().catch(() => false)) {
          await skipSetup.click();
        }
        await composer.waitFor({ state: 'visible', timeout: 30_000 });
      }
      if (!(await composer.isVisible()))
        throw new Error(`${label} launch did not reach an interactive composer.`);
    } catch (error) {
      const diagnostic = { page: await describePage(), pageErrors };
      console.error(
        JSON.stringify({ benchmark: 'packaged-startup-interaction-failure', label, ...diagnostic }),
      );
      throw new Error(`${label} launch did not become interactive: ${JSON.stringify(diagnostic)}`, {
        cause: error,
      });
    }
    const interactiveMs = Number((performance.now() - startedAt).toFixed(1));
    if (label === 'Warm') {
      const sampleIdle = async (stage) => {
        const samples = [];
        for (let index = 0; index < 60; index += 1) {
          samples.push(await page.evaluate(() => window.ferryHost?.getProcessMetrics() ?? []));
          await delay(1_000);
        }
        const processes = ['main', 'renderer', 'core'].map((role) => {
          const values = samples.flat().filter((sample) => sample.role === role);
          return {
            role,
            sampleCount: values.length,
            averageCpuPercent: values.length
              ? Number(
                  (
                    values.reduce((sum, sample) => sum + sample.cpuPercent, 0) / values.length
                  ).toFixed(2),
                )
              : null,
            rssBytes: values.at(-1)?.rssBytes ?? null,
            averageRssBytes: values.length
              ? Math.round(values.reduce((sum, sample) => sum + sample.rssBytes, 0) / values.length)
              : null,
          };
        });
        runtimeMetrics[stage] = { durationSeconds: 60, processes };
      };
      await sampleIdle('afterStartup');
      const workspacePath = await mkdtemp(join(tmpdir(), 'ferry-perf-session-'));
      try {
        const session = await page.evaluate(async (path) => {
          const client = window.ferryHybrid;
          if (!client) throw new Error('Ferry client unavailable for session memory sample.');
          const workspace = await client.workspaces.open(path);
          const created = await client.sessions.create({ workspaceId: workspace.id });
          const queryStartedAt = performance.now();
          await client.sessions.list();
          return {
            id: created.id,
            queryMs: Number((performance.now() - queryStartedAt).toFixed(2)),
          };
        }, workspacePath);
        dbQueryMs = session.queryMs;
        await page.evaluate((id) => {
          location.hash = `#/s/${id}`;
        }, session.id);
        await page.locator('.transcript-viewport').waitFor({ state: 'visible', timeout: 30_000 });
        await sampleIdle('afterSession');
      } finally {
        await rm(workspacePath, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    }
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
    idle: runtimeMetrics,
    dbQuerySample: { query: 'sessions.list', elapsedMs: dbQueryMs },
  };
  console.log(JSON.stringify(result));
  if (measured.interactiveMs >= result.targetMs) process.exitCode = 1;
} finally {
  await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
