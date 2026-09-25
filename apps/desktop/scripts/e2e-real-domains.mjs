import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { FakeOpenAIServer } from '../../../packages/testkit/src/fake-servers.ts';
import { FixtureRepo } from '../../../packages/testkit/src/fixture-repo.ts';
import { serveDirectory } from './static-server.mjs';

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ferry-real-domains-e2e-'));
const agentFixture = await FixtureRepo.create('typescript');
const fixtureRepo = agentFixture.path;
const fixtureRepoName = fixtureRepo.split(/[\\/]/).pop();
const dataDirectory = join(temporaryDirectory, 'ferry-home');
const userDataDirectory = join(temporaryDirectory, 'electron-user-data');
const sourcePath = join(fixtureRepo, 'index.js');
const originalSource = 'export const answer = 42;\n';
const editedSource = 'export const answer = 0;\n';
const electronBinary = createRequire(import.meta.url)('electron');
const gitIdentity = {
  GIT_AUTHOR_NAME: 'Ferry E2E',
  GIT_AUTHOR_EMAIL: 'ferry-e2e@example.invalid',
  GIT_COMMITTER_NAME: 'Ferry E2E',
  GIT_COMMITTER_EMAIL: 'ferry-e2e@example.invalid',
};
let application;
let rendererServer;
let fakeProvider;

function toolTurn(name, input, content = '') {
  return {
    chunks: [
      {
        id: 'chatcmpl_e2e',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', ...(content ? { content } : {}) },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl_e2e',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${name}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(input) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl_e2e',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ],
  };
}

function textTurn(text) {
  return {
    chunks: [
      {
        id: 'chatcmpl_e2e',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_e2e',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_e2e',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ],
  };
}

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
  git(['add', '-A', '--', '.'], fixtureRepo, shadowEnv);
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
        FERRY_REAL_DOMAINS:
          'settings,workspaces,checkpoints,sessions,approvals,profiles,skills,mcp,optimizer,delegation',
        FERRY_PROVIDER_API_KEY_OPENROUTER: 'fixture-key',
        FERRY_PROVIDER_API_KEY_GROQ: 'fixture-key',
        FERRY_PROVIDER_BASE_URL_OPENROUTER: `${fakeProvider.baseUrl}/v1`,
        FERRY_PROVIDER_BASE_URL_GROQ: `${fakeProvider.baseUrl}/v1`,
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
    assert.deepEqual(details.realDomains, [
      'settings',
      'workspaces',
      'checkpoints',
      'sessions',
      'approvals',
      'profiles',
      'skills',
      'mcp',
      'optimizer',
      'delegation',
    ]);
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
  assert.deepEqual(hello.realDomains, [
    'settings',
    'workspaces',
    'checkpoints',
    'sessions',
    'approvals',
    'profiles',
    'skills',
    'mcp',
    'optimizer',
    'delegation',
  ]);
}

try {
  fakeProvider = FakeOpenAIServer.scriptedTurns([
    toolTurn(
      'update_plan',
      { items: [{ text: 'Edit the failing fixture and run its tests', status: 'doing' }] },
      'I will update the failing fixture and verify the tests.',
    ),
    toolTurn('edit_file', { path: 'index.js', edits: [{ search: '42', replace: '0' }] }),
    toolTurn('run_command', { command: 'node test.js', cwd: '.', timeoutMs: 10000 }),
    textTurn('The fixture now passes its tests.'),
    { status: 429, body: { error: { message: 'scripted rate limit', type: 'rate_limit_error' } } },
    textTurn('Continued successfully after a provider handoff.'),
    {
      chunks: Array.from({ length: 30 }, (_, index) => ({
        id: 'chatcmpl_slow',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            delta: { ...(index === 0 ? { role: 'assistant' } : {}), content: 'working ' },
            finish_reason: null,
          },
        ],
      })),
      delayMs: 500,
    },
  ]);
  await fakeProvider.start();
  await mkdir(join(agentFixture.path, '.ferry'), { recursive: true });
  await writeFile(
    join(agentFixture.path, '.ferry', 'config.json'),
    JSON.stringify({ permissionRules: [{ pattern: 'node test.js', mode: 'allow' }] }),
    'utf8',
  );
  rendererServer = await serveDirectory(join(appDirectory, 'out', 'renderer'));
  await writeFile(sourcePath, originalSource, 'utf8');
  git(['checkout', '-b', 'fixture/restore'], fixtureRepo);
  git(['add', '-A', '--', '.'], fixtureRepo);
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
    await expect(page.getByRole('heading', { name: fixtureRepoName }).last()).toBeVisible();
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
    await expect(page.getByRole('heading', { name: fixtureRepoName }).last()).toBeVisible();
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
    const agentSession = await page.evaluate(async () => {
      const workspace = (await window.ferryRpcClient.workspaces.list())[0];
      if (!workspace) throw new Error('Real FixtureRepo workspace is unavailable');
      return await window.ferryRpcClient.sessions.create({
        workspaceId: workspace.id,
        title: 'Agent walking skeleton',
      });
    });
    const sessionRow = page.getByRole('button', { name: /Agent walking skeleton/ });
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

    const composer = page.getByRole('textbox', { name: 'Message Ferry' });
    await page.evaluate((sessionId) => {
      window.e2eStreamedText = '';
      window.ferryRpcClient.on('session.delta', (event) => {
        if (event.sessionId === sessionId) window.e2eStreamedText += event.textDelta;
      });
    }, agentSession.id);
    await composer.fill(
      'Fix the intentionally failing test by changing index.js, then run node test.js.',
    );
    await composer.press('Enter');
    await expect
      .poll(
        async () =>
          await page.evaluate(
            async (id) => (await window.ferryRpcClient.sessions.get(id)).session.status,
            agentSession.id,
          ),
      )
      .toBe('awaiting_approval');
    await expect
      .poll(() => page.evaluate(() => window.e2eStreamedText))
      .toContain('I will update the failing fixture and verify the tests.');
    const approval = await page.evaluate(async (id) => {
      const detail = await window.ferryRpcClient.sessions.get(id);
      return detail.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'approval_request' && part.state === 'pending')?.id;
    }, agentSession.id);
    expect(approval).toBeTruthy();
    for (let attempt = 0; attempt < 3; attempt++) {
      const pendingId = await page.evaluate(async (id) => {
        const detail = await window.ferryRpcClient.sessions.get(id);
        return detail.messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === 'approval_request' && part.state === 'pending')?.id;
      }, agentSession.id);
      if (!pendingId) break;
      const allowButton = page
        .locator('button')
        .filter({ hasText: /^Allow once$/ })
        .last();
      await expect(allowButton).toBeAttached({ timeout: 15_000 });
      await allowButton.evaluate((button) => button.click());
      await expect
        .poll(
          async () =>
            await page.evaluate(
              async ({ id, pendingId }) => {
                const detail = await window.ferryRpcClient.sessions.get(id);
                return detail.messages
                  .flatMap((message) => message.parts)
                  .some(
                    (part) =>
                      part.type === 'approval_request' &&
                      part.id === pendingId &&
                      part.state === 'pending',
                  );
              },
              { id: agentSession.id, pendingId },
            ),
        )
        .toBe(false);
      await expect
        .poll(
          async () =>
            await page.evaluate(
              async (id) => (await window.ferryRpcClient.sessions.get(id)).session.status,
              agentSession.id,
            ),
          { timeout: 30_000 },
        )
        .not.toBe('awaiting_approval');
      await expect
        .poll(
          async () =>
            await page.evaluate(
              async (id) => (await window.ferryRpcClient.sessions.get(id)).session.status,
              agentSession.id,
            ),
          { timeout: 30_000 },
        )
        .toMatch(/idle|awaiting_approval/);
    }
    await expect
      .poll(
        async () =>
          await page.evaluate(
            async (id) => (await window.ferryRpcClient.sessions.get(id)).session.status,
            agentSession.id,
          ),
        { timeout: 30_000 },
      )
      .toBe('idle');
    assert.match(await readFile(join(agentFixture.path, 'index.js'), 'utf8'), /answer = 0/);
    const finalDetail = await page.evaluate(
      async (id) => await window.ferryRpcClient.sessions.get(id),
      agentSession.id,
    );
    expect(
      finalDetail.messages.some((message) =>
        message.parts.some(
          (part) => part.type === 'text' && part.text.includes('The fixture now passes its tests.'),
        ),
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(page.getByRole('button', { name: /index\.js \+/ })).toBeVisible({
      timeout: 30_000,
    });
    console.log(
      'e2e real domains: streamed plan, edit approval, file diff, passing fixture test, and summary OK',
    );

    await composer.fill('Continue with a forced provider handoff.');
    await composer.press('Enter');
    const handoff = page.getByRole('button', { name: /Switched .*rate_limit/ });
    await expect(handoff).toBeVisible({ timeout: 30_000 });
    await handoff.click();
    await expect(page.getByText(/HTTP 429/)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          await page.evaluate(
            async (id) => (await window.ferryRpcClient.sessions.get(id)).session.status,
            agentSession.id,
          ),
        { timeout: 30_000 },
      )
      .toBe('idle');
    const handoffDetail = await page.evaluate(
      async (id) => await window.ferryRpcClient.sessions.get(id),
      agentSession.id,
    );
    expect(
      handoffDetail.messages.some((message) =>
        message.parts.some(
          (part) =>
            part.type === 'text' &&
            part.text.includes('Continued successfully after a provider handoff.'),
        ),
      ),
    ).toBe(true);
    console.log('e2e real domains: rate-limit recovery emits a handoff marker OK');

    await page
      .getByRole('textbox', { name: 'Message Ferry' })
      .fill('Start a slow response so I can cancel it.');
    await page.getByRole('textbox', { name: 'Message Ferry' }).press('Enter');
    await expect
      .poll(
        async () =>
          await page.evaluate(
            async (id) => (await window.ferryRpcClient.sessions.get(id)).session.status,
            agentSession.id,
          ),
      )
      .toBe('running');
    await page.getByRole('button', { name: /Stop/ }).click();
    await expect
      .poll(
        async () =>
          await page.evaluate(
            async (id) => (await window.ferryRpcClient.sessions.get(id)).session.status,
            agentSession.id,
          ),
      )
      .toBe('idle');
    console.log('e2e real domains: cancellation stops a streaming turn mid-run OK');
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
  await agentFixture.cleanup();
  await fakeProvider?.stop();
}
