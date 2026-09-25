import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveDirectory } from './static-server.mjs';

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const userDataDirectory = await mkdtemp(join(tmpdir(), 'ferry-electron-e2e-'));
const electronRequire = createRequire(import.meta.url);
const coreRequire = createRequire(join(appDirectory, '../../packages/core/package.json'));
const electronBinary = electronRequire('electron');
const { chromium, expect } = await import('@playwright/test');
const { FakeOpenAIServer } = await import(
  pathToFileURL(coreRequire.resolve('@ferry/testkit/fake-servers')).href
);
const rendererServer = await serveDirectory(join(appDirectory, 'out', 'renderer'));
const rendererResponse = await fetch(rendererServer.url);
assert.equal(rendererResponse.status, 200, 'Built desktop renderer is not being served');
const fake = await new FakeOpenAIServer({
  responseHeaders: {
    'x-ratelimit-limit-requests': '20',
    'x-ratelimit-remaining-requests': '13',
    'x-ratelimit-reset-requests': '3600',
  },
}).start();
const keyringNamespace = `Ferry-E2E-${process.pid}-${Date.now()}`;
const fakeKey = 'ferry-e2e-fake-key-do-not-use';
const debuggingServer = createServer();
await new Promise((resolve, reject) => {
  debuggingServer.once('error', reject);
  debuggingServer.listen(0, '127.0.0.1', resolve);
});
const debuggingPort = debuggingServer.address().port;
await new Promise((resolve, reject) =>
  debuggingServer.close((error) => (error ? reject(error) : resolve())),
);

const application = spawn(
  electronBinary,
  [
    `--remote-debugging-port=${String(debuggingPort)}`,
    '--no-proxy-server',
    '--no-sandbox',
    '--disable-gpu',
    '--in-process-gpu',
    '--use-gl=swiftshader',
    appDirectory,
  ],
  {
    cwd: appDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FERRY_E2E_USER_DATA_DIR: userDataDirectory,
      FERRY_HOME: join(userDataDirectory, 'ferry-home'),
      FERRY_TEST_KEYRING_NAMESPACE: keyringNamespace,
      FERRY_PROVIDER_BASE_URL_OPENAI: `${fake.baseUrl}/v1`,
      FERRY_REAL_DOMAINS:
        'settings,workspaces,checkpoints,providers,models,quota,sessions,approvals,profiles,skills,mcp,optimizer,delegation',
      ELECTRON_RENDERER_URL: rendererServer.url,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let output = '';
const capture = (chunk) => {
  const value = chunk.toString().replaceAll(fakeKey, '[REDACTED]');
  output += value;
};
application.stdout.on('data', capture);
application.stderr.on('data', capture);
const exit = new Promise((resolve) => application.once('exit', resolve));
const waitForDevtools = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (application.exitCode !== null)
      throw new Error(`Ferry exited with ${String(application.exitCode)}: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${String(debuggingPort)}/json/version`);
      if (response.ok) return;
    } catch {
      // Electron has not opened the debugging endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Electron DevTools: ${output}`);
};

let browser;
try {
  await waitForDevtools();
  const connectionDeadline = Date.now() + 15_000;
  let connectionError;
  while (!browser && Date.now() < connectionDeadline) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(debuggingPort)}`);
    } catch (error) {
      connectionError = error;
      if (application.exitCode !== null)
        throw new Error(`Ferry exited before DevTools connected: ${output}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!browser)
    throw new Error(
      `Could not connect to Electron DevTools: ${String(connectionError)}\n${output}`,
    );
  const context = browser.contexts()[0];
  assert.ok(context, 'Electron did not expose a browser context');
  const page = context.pages()[0] ?? (await context.newPage());
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error')
      pageErrors.push(message.text().replaceAll(fakeKey, '[REDACTED]'));
  });
  page.on('pageerror', (error) => pageErrors.push(error.message.replaceAll(fakeKey, '[REDACTED]')));
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
  const getStarted = page.getByRole('button', { name: /Get started/ });
  await expect(getStarted.or(page.getByRole('button', { name: 'Explore' })).first()).toBeVisible({
    timeout: 20_000,
  });
  if (await getStarted.isVisible().catch(() => false)) {
    await getStarted.click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Finish setup' }).click();
  }
  await page.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Explore providers and models' })).toBeVisible();
  await page
    .getByRole('region', { name: 'Explore providers and models' })
    .getByRole('button', { name: /Add provider/ })
    .click();
  await page.getByRole('button', { name: /OpenAI API/ }).click();
  await expect(page.getByRole('dialog', { name: 'Manage OpenAI API key' })).toBeVisible();

  const saved = await page
    .evaluate(async (key) => {
      const client = window.ferryHybrid;
      if (!client) throw new Error('Real Ferry client is not available');
      if (!client.getRealDomains().includes('providers'))
        throw new Error('Providers domain is not real');
      await client.providers.setKey('openai', key);
      return client.getRealDomains();
    }, fakeKey)
    .catch(async (error) => {
      const state = await page.evaluate(() => ({
        host: Boolean(window.ferryHost),
        rpc: Boolean(window.ferryRpcClient),
        helloDomains: window.ferryEngineHello?.realDomains ?? null,
        hybrid: Boolean(window.ferryHybrid),
      }));
      throw new Error(
        `Renderer core bootstrap failed: ${JSON.stringify(state)}; page errors: ${pageErrors.join(' | ')}; core output: ${output}`,
        { cause: error },
      );
    });
  assert.ok(saved.includes('quota') && saved.includes('models'));
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status')).toContainText('Connected in', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Close dialog' }).click();

  const liveQuota = await page.evaluate(async () => {
    const client = window.ferryHybrid;
    if (!client) throw new Error('Real Ferry client is not available');
    return {
      capacity: await client.quota.capacity(),
      history: await client.quota.history(14),
    };
  });
  assert.ok(
    liveQuota.capacity.percentRemaining < 100,
    `Expected fake rate limit to affect capacity: ${JSON.stringify(liveQuota.capacity)}`,
  );
  assert.ok(
    liveQuota.capacity.perProvider.some(
      (provider) => provider.providerId === 'openai' && provider.percent === 65,
    ),
    `OpenAI rate limit was not reflected in capacity: ${JSON.stringify(liveQuota.capacity)}`,
  );
  assert.ok(
    liveQuota.history.some((point) => point.providerId === 'openai' && point.requests > 0),
    `Fake usage headers were not reflected in history: ${JSON.stringify(liveQuota.history)}`,
  );

  await page
    .getByRole('navigation', { name: 'Explore sections' })
    .getByRole('button', { name: 'Usage' })
    .click();
  await expect(page.getByRole('region', { name: 'Usage dashboard' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Explore sections' }).getByText('Demo data'),
  ).toHaveCount(0);
  const usageDashboard = page.getByRole('region', { name: 'Usage dashboard' });
  await expect(
    usageDashboard.getByRole('img', {
      name: `${String(liveQuota.capacity.percentRemaining)}% capacity remaining`,
    }),
  ).toBeVisible();
  await expect(
    usageDashboard.getByRole('img', { name: '14 day stacked requests usage by provider' }),
  ).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Explore sections' })
    .getByRole('button', { name: 'Providers' })
    .click();
  fake.options.responses = [
    {
      status: 429,
      headers: {
        'retry-after': '30',
        'x-ratelimit-limit-requests': '20',
        'x-ratelimit-remaining-requests': '0',
      },
    },
  ];
  await page.getByRole('button', { name: 'Test OpenAI API' }).click();
  await expect(page.getByText(/Cooldown/)).toBeVisible({ timeout: 15_000 });
  await page.evaluate(async () => {
    await window.ferryHybrid?.providers.removeKey('openai');
  });
  assert.ok(fake.requests.some((request) => request.method === 'POST'));
  assert.ok(!output.includes(fakeKey), 'The fake key appeared in Electron logs');
  console.log('Electron real-domain provider, quota, usage, and cooldown flow OK');
} finally {
  application.kill();
  await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  if (browser)
    await Promise.race([
      browser.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  await fake.stop().catch(() => undefined);
  rendererServer.server.closeAllConnections();
  await Promise.race([
    new Promise((resolve) => rendererServer.server.close(resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  await rm(userDataDirectory, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  }).catch(() => undefined);
}
