import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { serveDirectory } from './static-server.mjs';

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ferry-real-domains-e2e-'));
const fixtureRepo = join(temporaryDirectory, 'FixtureRepo');
const dataDirectory = join(temporaryDirectory, 'ferry-home');
const userDataDirectory = join(temporaryDirectory, 'electron-user-data');
const sourcePath = join(fixtureRepo, 'src', 'hello.ts');
const originalSource = 'export const greeting = "hello from FixtureRepo";\n';
const editedSource = 'export const greeting = "edited by Ferry";\n';
const electronBinary = createRequire(import.meta.url)('electron');
const gitIdentity = {
  GIT_AUTHOR_NAME: 'Ferry E2E',
  GIT_AUTHOR_EMAIL: 'ferry-e2e@example.invalid',
  GIT_COMMITTER_NAME: 'Ferry E2E',
  GIT_COMMITTER_EMAIL: 'ferry-e2e@example.invalid',
};
let application;
let rendererServer;

function git(args, cwd, extraEnv = {}) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, ...gitIdentity, ...extraEnv },
  });
}

function createShadowCheckpoint(message) {
  const jailId = createHash('sha256').update(fixtureRepo.toLowerCase()).digest('hex').slice(0, 16);
  const shadowDirectory = join(dataDirectory, 'checkpoints', jailId);
  const shadowEnv = { GIT_DIR: shadowDirectory, GIT_WORK_TREE: fixtureRepo };
  git(['init', '--bare', shadowDirectory], fixtureRepo);
  git(['add', '-A', '--', 'src/hello.ts'], fixtureRepo, shadowEnv);
  const tree = execFileSync('git', ['write-tree'], {
    cwd: fixtureRepo,
    encoding: 'utf8',
    env: { ...process.env, ...gitIdentity, ...shadowEnv },
  }).trim();
  const checkpoint = execFileSync('git', ['commit-tree', tree, '-m', message], {
    cwd: fixtureRepo,
    encoding: 'utf8',
    env: { ...process.env, ...gitIdentity, ...shadowEnv },
  }).trim();
  git(['update-ref', 'refs/heads/main', checkpoint], fixtureRepo, shadowEnv);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], fixtureRepo, shadowEnv);
  return checkpoint;
}

async function startEmbeddedCore() {
  application = spawn(
    electronBinary,
    ['--disable-gpu', '--in-process-gpu', '--use-gl=swiftshader', appDirectory],
    {
      cwd: appDirectory,
      env: {
        ...process.env,
        FERRY_E2E_USER_DATA_DIR: userDataDirectory,
        FERRY_HOME: dataDirectory,
        FERRY_REAL_DOMAINS: 'settings,workspaces,checkpoints',
        FERRY_E2E_CORE_ONLY: '1',
        FERRY_E2E_WEBSOCKET: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exit = new Promise((resolve) => application.once('exit', resolve));
  const timer = setTimeout(
    () => rejectReady(new Error(`Timed out waiting for embedded Ferry Core: ${output}`)),
    30_000,
  );
  const capture = (chunk) => {
    output += chunk.toString();
    const match = output.match(/FERRY_CORE_READY (.+)/);
    if (!match) return;
    const details = JSON.parse(match[1]);
    if (details.websocketUrl) resolveReady(details);
  };
  application.stdout.on('data', capture);
  application.stderr.on('data', capture);
  application.once('error', rejectReady);
  application.once('exit', (code) =>
    rejectReady(new Error(`Ferry exited with ${code}: ${output}`)),
  );
  try {
    const details = await ready;
    assert.deepEqual(details.realDomains, ['settings', 'workspaces', 'checkpoints']);
    assert.equal(details.dataDir, dataDirectory);
    return { websocketUrl: details.websocketUrl, exit };
  } finally {
    clearTimeout(timer);
  }
}

async function stopEmbeddedCore(exit) {
  if (!application) return;
  if (application.exitCode === null && application.signalCode === null) {
    application.kill();
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  }
  application = undefined;
}

async function openRenderer(page, websocketUrl) {
  const url = new URL(rendererServer.url);
  url.pathname = '/library';
  url.searchParams.set('e2eCore', websocketUrl);
  await page.goto(url.toString());
  await page.waitForFunction(() => Boolean(window.ferryRpcClient), undefined, { timeout: 30_000 });
  const hello = await page.evaluate(() => window.ferryRpcClient.hello);
  assert.deepEqual(hello.realDomains, ['settings', 'workspaces', 'checkpoints']);
}

try {
  rendererServer = await serveDirectory(join(appDirectory, 'out', 'renderer'));
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, originalSource, 'utf8');
  git(['init', '-b', 'fixture/restore'], fixtureRepo);
  git(['add', 'src/hello.ts'], fixtureRepo);
  git(['commit', '-m', 'FixtureRepo baseline'], fixtureRepo);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      bypassCSP: true,
    });
    await context.addInitScript((path) => {
      window.prompt = () => path;
    }, fixtureRepo);
    let page = await context.newPage();
    let core = await startEmbeddedCore();
    await openRenderer(page, core.websocketUrl);

    await page.locator('.canvas').getByRole('button', { name: 'Open folder' }).click();
    await expect(page.getByRole('heading', { name: 'FixtureRepo' }).last()).toBeVisible();
    await expect(page.getByText('fixture/restore', { exact: true })).toBeVisible();
    console.log('e2e real domains: folder dialog, Library entry, and git branch OK');

    await page.evaluate(async () => {
      await window.ferryRpcClient.settings.update({ theme: 'dark' });
    });
    await page.waitForFunction(
      async () =>
        (await window.ferryRpcClient.settings.get()).theme === 'dark' &&
        document.documentElement.dataset.theme === 'dark',
    );
    await page.getByRole('button', { name: 'Toggle theme' }).click();
    await page.waitForFunction(
      async () => (await window.ferryRpcClient.settings.get()).theme === 'light',
    );
    await page.close();
    await stopEmbeddedCore(core.exit);

    core = await startEmbeddedCore();
    page = await context.newPage();
    await openRenderer(page, core.websocketUrl);
    await expect(page.getByRole('heading', { name: 'FixtureRepo' }).last()).toBeVisible();
    await page.waitForFunction(
      async () =>
        (await window.ferryRpcClient.settings.get()).theme === 'light' &&
        document.documentElement.dataset.theme === 'light',
    );
    console.log(
      'e2e real domains: setting survives desktop restart and workspace remains in Library OK',
    );

    const checkpointId = createShadowCheckpoint('FixtureRepo baseline');
    assert.match(checkpointId, /^[a-f0-9]{40}$/);
    await writeFile(sourcePath, editedSource, 'utf8');
    await page.evaluate(async () => {
      const workspace = (await window.ferryE2EMockClient.workspaces.list())[0];
      if (!workspace) throw new Error('Fixture mock workspace is unavailable');
      await window.ferryHybrid.sessions.create({
        workspaceId: workspace.id,
        title: 'Fixture checkpoint session',
      });
    });
    const sessionRow = page.getByRole('button', { name: /Fixture checkpoint session/ });
    await expect(sessionRow.first()).toBeVisible();
    await sessionRow.first().click();
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    const restoreButton = page.getByRole('button', {
      name: 'Restore checkpoint FixtureRepo baseline',
    });
    await expect(restoreButton).toBeVisible();
    await restoreButton.click();

    const restoreDeadline = Date.now() + 15_000;
    let restoredSource = '';
    while (Date.now() < restoreDeadline) {
      restoredSource = await readFile(sourcePath, 'utf8');
      if (restoredSource === originalSource) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(restoredSource, originalSource);
    console.log(
      'e2e real domains: Changes lists checkpoint and Restore restores FixtureRepo file OK',
    );
    await stopEmbeddedCore(core.exit);
  } finally {
    await browser.close();
  }
} finally {
  const currentApplication = application;
  if (currentApplication) {
    currentApplication.kill();
    await new Promise((resolve) => currentApplication.once('exit', resolve));
  }
  if (rendererServer)
    await new Promise((resolve, reject) =>
      rendererServer.server.close((error) => (error ? reject(error) : resolve())),
    );
  await rm(temporaryDirectory, { recursive: true, force: true });
}
