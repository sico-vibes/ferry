import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { FakeOpenAIServer } from '../../../packages/testkit/src/fake-servers.ts';
import { FixtureRepo } from '../../../packages/testkit/src/fixture-repo.ts';

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
let browser;
let fakeProvider;
let activePage;
let failureStep = 'startup';

async function captureFailureArtifacts(error) {
  if (!activePage || activePage.isClosed()) return;
  const artifactDirectory = join(appDirectory, '..', '..', '.dev');
  const step = failureStep.replace(/[^a-z0-9_-]/gi, '-');
  const screenshotPath = join(artifactDirectory, `e2e-failure-${step}.png`);
  const htmlPath = join(artifactDirectory, `e2e-failure-${step}.html`);
  try {
    await mkdir(artifactDirectory, { recursive: true });
    try {
      await activePage.screenshot({ path: screenshotPath, fullPage: true, timeout: 10_000 });
      console.error(`E2E failure screenshot saved: ${screenshotPath}`);
    } catch (artifactError) {
      console.error(
        `Could not save E2E failure screenshot: ${artifactError instanceof Error ? artifactError.message : String(artifactError)}`,
      );
    }
    try {
      const dom = await activePage.content();
      const route = activePage.url();
      const visibleSessionTitle = await activePage
        .evaluate(() => {
          const selectedTab = document.querySelector('[role="tab"][aria-selected="true"]');
          const emptySessionTitle = document.querySelector('.transcript-viewport .session-empty');
          return (selectedTab?.textContent ?? emptySessionTitle?.textContent ?? '').trim();
        })
        .catch(() => 'unavailable');
      const details = [
        `Failure step: ${failureStep}`,
        `Route: ${route}`,
        `Visible session title: ${visibleSessionTitle || 'unavailable'}`,
        `Error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        '',
      ].join('\n');
      await writeFile(htmlPath, `${details}\n${dom}`, 'utf8');
      console.error(`E2E failure route: ${route}`);
      console.error(`E2E failure visible session title: ${visibleSessionTitle || 'unavailable'}`);
      console.error(`E2E failure DOM saved: ${htmlPath}`);
    } catch (artifactError) {
      console.error(
        `Could not save E2E failure DOM: ${artifactError instanceof Error ? artifactError.message : String(artifactError)}`,
      );
    }
  } catch (artifactError) {
    console.error(
      `Could not prepare E2E failure artifacts: ${artifactError instanceof Error ? artifactError.message : String(artifactError)}`,
    );
  }
}

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
  git(['add', '-f', '-A', '--', '.'], fixtureRepo, shadowEnv);
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
  const checkpointFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', checkpoint], {
    cwd: fixtureRepo,
    encoding: 'utf8',
    env: { ...process.env, ...gitIdentity, ...shadowEnv },
  });
  assert.ok(checkpointFiles.split(/\r?\n/).includes('index.js'));
  git(['update-ref', 'refs/heads/main', checkpoint], fixtureRepo, shadowEnv);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], fixtureRepo, shadowEnv);
  return checkpoint;
}

async function startEmbeddedCore() {
  const debuggingServer = createServer();
  await new Promise((resolve, reject) => {
    debuggingServer.once('error', reject);
    debuggingServer.listen(0, '127.0.0.1', resolve);
  });
  const debuggingPort = debuggingServer.address().port;
  await new Promise((resolve, reject) =>
    debuggingServer.close((error) => (error ? reject(error) : resolve())),
  );
  application = spawn(
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
        FERRY_TEST_KEYRING_NAMESPACE: `ferry-real-e2e-${process.pid}`,
        FERRY_E2E_USER_DATA_DIR: userDataDirectory,
        FERRY_E2E_OPEN_FOLDER: fixtureRepo,
        FERRY_HOME: dataDirectory,
        FERRY_REAL_DOMAINS:
          'settings,workspaces,checkpoints,providers,oauth,models,quota,sessions,approvals,profiles,skills,mcp,optimizer,delegation',
        FERRY_PROVIDER_BASE_URL_OPENROUTER: `${fakeProvider.baseUrl}/openrouter/v1`,
        FERRY_PROVIDER_BASE_URL_GROQ: `${fakeProvider.baseUrl}/groq/v1`,
        FERRY_E2E_PROVIDER_ID: 'openrouter',
        FERRY_E2E_PROVIDER_KEY: 'fixture-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let traceBuffer = '';
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
    const text = chunk.toString();
    if (text.includes('E2E approval')) console.log(text.trim());
    output += text;
    traceBuffer += text;
    const lines = traceBuffer.split(/\r?\n/);
    traceBuffer = lines.pop() ?? '';
    for (const line of lines)
      if (/FERRY_(HANDOFF|PRELOAD|RENDERER|RPC|CORE_EXIT|UTILITY_SPAWN|CORE_READY)/.test(line))
        console.log(`[E2E_MAIN] ${line}`);
    const match = output.match(/FERRY_CORE_READY (.+)/);
    if (!match) return;
    const details = JSON.parse(match[1]);
    if (details.realDomains) resolveReady(details);
  };
  application.stdout.on('data', capture);
  application.stderr.on('data', capture);
  application.once('error', rejectReady);
  application.once('exit', (code) =>
    rejectReady(new Error(`Ferry exited with ${code}: ${output}`)),
  );
  try {
    const details = await ready;
    assert.ok(
      [
        'settings',
        'workspaces',
        'checkpoints',
        'providers',
        'models',
        'quota',
        'sessions',
        'approvals',
        'profiles',
        'skills',
        'mcp',
        'optimizer',
        'delegation',
      ].every((domain) => details.realDomains.includes(domain)),
    );
    assert.equal(details.dataDir, dataDirectory);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (application.exitCode !== null)
        throw new Error(`Ferry exited before opening DevTools: ${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${String(debuggingPort)}/json/version`);
        if (response.ok) break;
      } catch {
        // Wait until Electron accepts the DevTools connection.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(debuggingPort)}`);
    const context = browser.contexts()[0];
    assert.ok(context, 'Electron did not expose a browser context');
    const page = context.pages()[0] ?? (await context.newPage());
    activePage = page;
    page.on('console', (message) => {
      const text = message.text();
      if (/FERRY_(PRELOAD|RENDERER|RPC)/.test(text)) console.log(`[E2E_RENDERER] ${text}`);
    });
    const getStarted = page.getByRole('button', { name: /Get started/ });
    await expect(getStarted.or(page.getByRole('button', { name: 'Explore' })).first()).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForFunction(
      () =>
        Boolean(window.ferryRpcClient) &&
        Boolean(window.ferryHybrid) &&
        (window.ferryEngineHello?.realDomains.length ?? 0) > 0,
      undefined,
      { timeout: 15_000 },
    );
    const helloDomains = await page.evaluate(() => window.ferryEngineHello?.realDomains ?? []);
    assert.ok(helloDomains.length > 0, 'File renderer hello must include real domains');
    console.log(`File renderer real client connected with ${String(helloDomains.length)} domains`);
    if (await getStarted.isVisible().catch(() => false)) {
      await getStarted.click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Finish setup' }).click();
    }
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.ferryRpcClient), undefined, {
      timeout: 30_000,
    });
    await page.evaluate(async () => {
      await window.ferryRpcClient.providers.setKey('openrouter', 'fixture-key');
    });
    await expect
      .poll(() => page.evaluate(async () => (await window.ferryRpcClient.models.list()).length))
      .toBeGreaterThan(0);
    return { page, exit, browser };
  } finally {
    clearTimeout(timer);
  }
}

async function stopEmbeddedCore(core) {
  if (!application) return;
  if (application.exitCode === null && application.signalCode === null) {
    application.kill();
    await Promise.race([core.exit, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  }
  await core.browser.close().catch(() => undefined);
  if (browser === core.browser) browser = undefined;
  application = undefined;
}

function hardKillCore(pid) {
  if (process.platform === 'win32')
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(pid, 'SIGKILL');
}

async function openRenderer(page) {
  await page.evaluate((path) => {
    window.prompt = () => path;
  }, fixtureRepo);
  await page.waitForFunction(() => Boolean(window.ferryRpcClient), undefined, { timeout: 30_000 });
  const hello = await page.evaluate(() => window.ferryRpcClient.hello);
  assert.ok(
    [
      'settings',
      'workspaces',
      'checkpoints',
      'providers',
      'models',
      'quota',
      'sessions',
      'approvals',
      'profiles',
      'skills',
      'mcp',
      'optimizer',
      'delegation',
    ].every((domain) => hello.realDomains.includes(domain)),
  );
}

try {
  fakeProvider = new FakeOpenAIServer({
    models: [
      { id: 'cohere/north-mini-code:free', supported_parameters: ['tools'] },
      { id: 'allam-2-7b', supported_parameters: ['tools'] },
    ],
    responses: [
      toolTurn(
        'update_plan',
        { items: [{ text: 'Edit the failing fixture and run its tests', status: 'doing' }] },
        'I will update the failing fixture and verify the tests.',
      ),
      toolTurn('edit_file', { path: 'index.js', edits: [{ search: '42', replace: '0' }] }),
      toolTurn('run_command', { command: 'node test.js', cwd: '.', timeoutMs: 10000 }),
      textTurn('The fixture now passes its tests.'),
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
      {
        status: 429,
        body: { error: { message: 'scripted rate limit', type: 'rate_limit_error' } },
      },
      textTurn('Continued successfully after a provider handoff.'),
    ],
  });
  await fakeProvider.start();
  await mkdir(join(agentFixture.path, '.ferry'), { recursive: true });
  await writeFile(
    join(agentFixture.path, '.ferry', 'config.json'),
    JSON.stringify({ permissionRules: [{ pattern: 'node test.js', mode: 'allow' }] }),
    'utf8',
  );
  await writeFile(sourcePath, originalSource, 'utf8');
  git(['checkout', '-b', 'fixture/restore'], fixtureRepo);
  git(['add', '-A', '--', '.'], fixtureRepo);
  git(['commit', '-m', 'FixtureRepo baseline'], fixtureRepo);

  try {
    let core = await startEmbeddedCore();
    let page = core.page;
    activePage = page;
    failureStep = 'real-domains-ui';
    await openRenderer(page);
    await expect(page.getByText('Demo data', { exact: true })).toHaveCount(0);

    const selectedFolder = await page.evaluate(() => window.ferryHost?.openFolder());
    assert.equal(selectedFolder?.toLowerCase(), fixtureRepo.toLowerCase());
    const openedWorkspace = await page.evaluate(
      (folder) => window.ferryRpcClient.workspaces.open(folder),
      selectedFolder,
    );
    assert.equal(openedWorkspace.path.toLowerCase(), fixtureRepo.toLowerCase());

    await page.getByRole('button', { name: 'Open folder', exact: true }).first().click();
    await expect
      .poll(() =>
        page.evaluate(
          async (path) =>
            (await window.ferryRpcClient.workspaces.list()).some(
              (workspace) => workspace.path.toLowerCase() === path.toLowerCase(),
            ),
          fixtureRepo,
        ),
      )
      .toBe(true);
    await page.getByRole('button', { name: `Open ${fixtureRepoName} in Library` }).click();
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
    await stopEmbeddedCore(core);

    core = await startEmbeddedCore();
    page = core.page;
    activePage = page;
    await openRenderer(page);
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
    await page.evaluate(async () => {
      await window.ferryRpcClient.providers.setKey('openrouter', 'fixture-key');
      await window.ferryRpcClient.providers.setKey('groq', 'fixture-key');
      await Promise.all([
        window.ferryRpcClient.models.list('openrouter'),
        window.ferryRpcClient.models.list('groq'),
      ]);
    });
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const providers = await window.ferryRpcClient.providers.list();
            const groqModels = await window.ferryRpcClient.models.list('groq');
            return (
              ['openrouter', 'groq'].every((id) => {
                const provider = providers.find((entry) => entry.id === id);
                return Boolean(provider?.modelsVerifiedAt && provider.availableModels?.length);
              }) && groqModels.length > 0
            );
          }),
        { timeout: 30_000 },
      )
      .toBe(true);
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
      try {
        restoredSource = await readFile(sourcePath, 'utf8');
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
          throw error;
      }
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
      window.e2eHandoffParts = [];
      window.e2eAgentEvents = [];
      window.ferryRpcClient.on('session.delta', (event) => {
        if (event.sessionId === sessionId) window.e2eStreamedText += event.textDelta;
      });
      window.ferryRpcClient.on('session.part', (event) => {
        if (event.sessionId !== sessionId) return;
        if (event.part.type === 'handoff_marker') window.e2eHandoffParts.push(event.part);
        if (event.part.type === 'tool_call')
          window.e2eAgentEvents.push({
            kind: 'session.part',
            status: event.part.status,
            tool: event.part.tool,
            paths: event.part.changes.map((change) => change.path),
          });
      });
      window.ferryRpcClient.on('task.updated', (task) => {
        if (task.sessionId === sessionId)
          window.e2eAgentEvents.push({
            kind: 'task.updated',
            touchedPaths: task.touchedFiles.map((file) => file.path),
          });
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
    for (let attempt = 0; attempt < 20; attempt++) {
      const pendingId = await page.evaluate(async (id) => {
        const detail = await window.ferryRpcClient.sessions.get(id);
        return detail.messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === 'approval_request' && part.state === 'pending')?.id;
      }, agentSession.id);
      if (!pendingId) {
        const status = await page.evaluate(
          async (id) => (await window.ferryRpcClient.sessions.get(id)).session.status,
          agentSession.id,
        );
        if (status === 'idle') break;
        await expect
          .poll(
            async () =>
              await page.evaluate(async (id) => {
                const detail = await window.ferryRpcClient.sessions.get(id);
                return (
                  detail.session.status === 'idle' ||
                  detail.messages
                    .flatMap((message) => message.parts)
                    .some((part) => part.type === 'approval_request' && part.state === 'pending')
                );
              }, agentSession.id),
            { timeout: 30_000 },
          )
          .toBe(true);
        continue;
      }
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
    const agentEventTrace = await page.evaluate(() => window.e2eAgentEvents);
    console.log(`e2e real domains: edit event trace ${JSON.stringify(agentEventTrace)}`);
    const touchedFileEventIndex = agentEventTrace.findIndex(
      (event) => event.kind === 'task.updated' && event.touchedPaths.includes('index.js'),
    );
    const successfulEditEventIndex = agentEventTrace.findIndex(
      (event) =>
        event.kind === 'session.part' &&
        event.status === 'succeeded' &&
        event.paths.includes('index.js'),
    );
    expect(touchedFileEventIndex).toBeGreaterThanOrEqual(0);
    expect(successfulEditEventIndex).toBeGreaterThan(touchedFileEventIndex);
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
    const sessionUsage = await page.evaluate(async () => ({
      capacity: await window.ferryRpcClient.quota.capacity(),
      history: await window.ferryRpcClient.quota.history(14),
    }));
    expect(sessionUsage.history.some((point) => point.requests > 0)).toBe(true);
    await page.getByRole('button', { name: 'Explore', exact: true }).click();
    await page.getByRole('button', { name: 'Usage', exact: true }).click();
    const usageDashboard = page.getByRole('region', { name: 'Usage dashboard' });
    await expect(usageDashboard).toBeVisible();
    await expect(
      usageDashboard.getByRole('img', {
        name: `${String(sessionUsage.capacity.percentRemaining)}% capacity remaining`,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Chats navigation' }).click();
    await page.getByRole('tab', { name: /Agent walking skeleton/ }).click();
    await expect(composer).toBeVisible({ timeout: 15_000 });

    await composer.fill('Start a slow response so I can cancel it.');
    await composer.press('Enter');
    await expect
      .poll(
        async () =>
          await page.evaluate(
            async (id) => (await window.ferryRpcClient.sessions.get(id)).session.status,
            agentSession.id,
          ),
      )
      .toBe('running');
    await expect(page.getByText(/working/).last()).toBeVisible({ timeout: 15_000 });
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

    const autoTrigger = page.getByRole('button', { name: /Auto ·/ });
    if (await autoTrigger.isVisible().catch(() => false)) {
      await autoTrigger.click();
      const manualModel = page.getByRole('option', { name: /North Mini Code/ });
      await expect(manualModel).toBeVisible();
      await manualModel.click();
    }
    await expect(page.getByRole('button', { name: /Manual · North Mini Code/ })).toBeVisible();
    await page.getByRole('button', { name: /Manual · North Mini Code/ }).click();
    const autoModel = page.getByRole('option', { name: /Auto \(recommended\)/ });
    await expect(autoModel).toBeVisible();
    await autoModel.click();
    await expect(page.getByRole('dialog', { name: 'Choose model' })).toBeHidden();
    await expect(page.getByRole('button', { name: /Auto ·/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Auto/ })).toBeVisible();
    await composer.fill('Continue with a forced provider handoff.');
    await composer.press('Enter');
    const handoff = page.getByRole('button', { name: /Switched .*rate_limit/ });
    try {
      await expect(handoff).toBeVisible({ timeout: 30_000 });
    } catch (error) {
      const evidence = await page.evaluate(async (sessionId) => {
        const detail = await window.ferryRpcClient.sessions.get(sessionId);
        const providers = await window.ferryRpcClient.providers.list();
        const groqModels = await window.ferryRpcClient.models.list('groq');
        return {
          status: detail.session.status,
          parts: detail.messages
            .at(-1)
            ?.parts.map((part) =>
              part.type === 'error'
                ? { type: part.type, kind: part.kind, message: part.message }
                : part.type,
            ),
          models: detail.messages.at(-1)?.modelAttempts?.map((attempt) => attempt.model),
          handoffs: window.e2eHandoffParts,
          providers: providers.map(({ id, enabled, keyStatus, health }) => ({
            id,
            enabled,
            keyStatus,
            health,
          })),
          groqModels: groqModels.map((model) => ({
            ref: model.ref,
            toolCalling: model.toolCalling,
          })),
        };
      }, agentSession.id);
      console.error(
        'e2e handoff diagnostic',
        JSON.stringify({
          evidence,
          requests: fakeProvider.requests.map((request) => ({
            url: request.url,
            model: request.body?.model,
            stream: request.body?.stream,
          })),
        }),
      );
      throw error;
    }
    await handoff.click();
    await expect(page.getByText(/HTTP 429/)).toBeVisible({ timeout: 30_000 });
    const handoffEvidence = await page.evaluate(
      async (sessionId) => ({
        parts: window.e2eHandoffParts,
        stats: await window.ferryRpcClient.quota.handoffs(30),
        session: await window.ferryRpcClient.sessions.get(sessionId),
      }),
      agentSession.id,
    );
    assert.ok(handoffEvidence.parts.some((part) => part.reason === 'rate_limit'));
    assert.ok(
      handoffEvidence.stats.some((handoff) => handoff.reason === 'rate_limit' && handoff.count > 0),
    );
    assert.ok(
      handoffEvidence.session.messages.some((message) =>
        message.parts.some((part) => part.type === 'handoff_marker' && part.briefingTokens >= 0),
      ),
    );
    await expect
      .poll(
        async () =>
          await page.evaluate(async (id) => {
            const detail = await window.ferryRpcClient.sessions.get(id);
            if (detail.session.status !== 'awaiting_approval') return detail.session.status;
            const parts = detail.messages.flatMap((message) =>
              message.parts
                .filter((part) => part.type === 'approval_request' && part.state === 'pending')
                .map((part) => part.id),
            );
            if (!parts.length) return detail.session.status;
            for (const approvalId of parts) {
              await window.ferryRpcClient.approvals.respond(id, approvalId, 'allow_once');
            }
            return 'approvals_responded';
          }, agentSession.id),
        { timeout: 60_000 },
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

    const crashResponses = fakeProvider.options.responses;
    fakeProvider.cursor = crashResponses.length;
    crashResponses.push(
      {
        chunks: [
          {
            id: 'chatcmpl_crash',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl_crash',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta: { content: 'slow provider step' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl_crash',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
        ],
        delayMs: 5_000,
      },
      textTurn('The interrupted task resumed and completed.'),
    );
    failureStep = 'crash-resume-create';
    await page.getByRole('button', { name: 'Add tab', exact: true }).click();
    await expect(page).toHaveURL(/#\/s\/[^/?#]+$/);
    const crashSessionRoute = new URL(page.url()).hash;
    const crashSessionMatch = /^#\/s\/([^/?#]+)$/.exec(crashSessionRoute);
    if (!crashSessionMatch?.[1]) {
      throw new Error(`Could not capture crash session id from route: ${crashSessionRoute}`);
    }
    const crashSessionId = crashSessionMatch[1];
    await expect(page.locator('.transcript-viewport')).toHaveAttribute(
      'data-session-status',
      'idle',
    );
    const beforeCrashRequests = fakeProvider.requests.length;
    void page.evaluate(
      (id) => window.ferryRpcClient.sessions.send(id, { text: 'Finish the crash recovery task.' }),
      crashSessionId,
    );
    await expect
      .poll(() => fakeProvider.requests.length, { timeout: 10_000 })
      .toBeGreaterThan(beforeCrashRequests);
    await expect(page.locator('.transcript-viewport')).toHaveAttribute(
      'data-session-status',
      'running',
    );
    const previousCorePid = await page.evaluate(async () => {
      const status = await window.ferryHost.getEngineStatus();
      if (!status.pid) throw new Error('Core process PID unavailable for crash test');
      return status.pid;
    });
    hardKillCore(previousCorePid);
    page = core.page;
    activePage = page;
    await page.waitForFunction(
      async (oldPid) => {
        const status = await window.ferryHost.getEngineStatus();
        return status.status === 'connected' && status.pid !== oldPid;
      },
      previousCorePid,
      { timeout: 30_000 },
    );
    let crashSessionObservation = { kind: 'pending' };
    const crashSessionRead = page
      .evaluate(async (id) => {
        let retriedAfterRestart = false;
        const deadline = Date.now() + 17_000;
        while (Date.now() < deadline) {
          let timeout;
          try {
            const detail = await Promise.race([
              window.ferryRpcClient.sessions.get(id),
              new Promise((_, reject) => {
                timeout = window.setTimeout(
                  () => reject(new Error('sessions.get did not settle within 17 seconds')),
                  Math.max(1, deadline - Date.now()),
                );
              }),
            ]);
            return { kind: 'status', status: detail.session.status };
          } catch (error) {
            if (
              !retriedAfterRestart &&
              typeof error === 'object' &&
              error !== null &&
              'kind' in error &&
              error.kind === 'core_restarted'
            ) {
              retriedAfterRestart = true;
              continue;
            }
            return {
              kind: 'error',
              ...(typeof error === 'object' && error !== null && 'kind' in error
                ? { errorKind: String(error.kind) }
                : {}),
              name: error instanceof Error ? error.name : 'UnknownError',
              message: error instanceof Error ? error.message : String(error),
            };
          } finally {
            if (timeout) window.clearTimeout(timeout);
          }
        }
        return {
          kind: 'error',
          name: 'TimeoutError',
          message: 'sessions.get did not settle within 17 seconds',
        };
      }, crashSessionId)
      .then(
        (observation) => {
          crashSessionObservation = observation;
          return observation;
        },
        (error) => {
          crashSessionObservation = {
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
          return crashSessionObservation;
        },
      );
    try {
      await expect
        .poll(() => crashSessionRead, { timeout: 20_000 })
        .toEqual({
          kind: 'status',
          status: 'interrupted',
        });
    } catch (error) {
      console.error(
        `e2e crash-resume session.get observation: ${JSON.stringify(crashSessionObservation)}`,
      );
      throw error;
    }
    failureStep = 'crash-resume-library';
    const crashWorkspaceName = await page.evaluate(async (id) => {
      const detail = await window.ferryRpcClient.sessions.get(id);
      const workspace = (await window.ferryRpcClient.workspaces.list()).find(
        (item) => item.id === detail.session.workspaceId,
      );
      if (!workspace) throw new Error('Crash resume workspace unavailable in Library');
      return workspace.name;
    }, crashSessionId);
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page
      .getByRole('button', { name: `Expand workspace ${crashWorkspaceName}`, exact: true })
      .click();
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, crashSessionRoute);
    await expect(page).toHaveURL(new RegExp(`/s/${crashSessionId}(?:$|[?#])`));
    failureStep = 'crash-resume-detail';
    await expect(page.locator('.transcript-viewport')).toBeVisible();
    await expect(page.locator('.transcript-viewport')).toHaveAttribute(
      'data-session-status',
      'interrupted',
    );
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    failureStep = 'crash-resume-completion';
    await expect
      .poll(
        async () => {
          const state = await page.evaluate(async (id) => {
            const detail = await window.ferryRpcClient.sessions.get(id);
            const approvals = detail.messages
              .flatMap((message) => message.parts)
              .filter(
                (part) =>
                  part.type === 'approval_request' &&
                  part.state === 'pending' &&
                  (part.kind === 'command' || part.kind === 'edit'),
              )
              .map(({ id: approvalId, kind, summary }) => ({
                id: approvalId,
                kind,
                summary,
              }));
            return { status: detail.session.status, approvals };
          }, crashSessionId);

          for (const approval of state.approvals) {
            console.log(
              `e2e crash-resume: approving pending ${approval.kind} approval: ${approval.summary}`,
            );
            await page.evaluate(
              async ({ id, approvalId }) =>
                window.ferryRpcClient.approvals.respond(id, approvalId, 'allow_once'),
              { id: crashSessionId, approvalId: approval.id },
            );
          }
          return state.status;
        },
        { timeout: 30_000 },
      )
      .toBe('idle');
    const resumedDetail = await page.evaluate(
      async (id) => window.ferryRpcClient.sessions.get(id),
      crashSessionId,
    );
    assert.ok(
      resumedDetail.messages.some((message) =>
        message.parts.some(
          (part) =>
            part.type === 'text' && part.text.includes('interrupted task resumed and completed'),
        ),
      ),
    );
    console.log('e2e real domains: killed mid-provider step, restarted, resumed, and completed OK');
    await stopEmbeddedCore(core);
  } catch (error) {
    await captureFailureArtifacts(error);
    throw error;
  } finally {
    if (application) {
      application.kill();
      await new Promise((resolve) => application.once('exit', resolve));
      application = undefined;
    }
    await browser?.close().catch(() => undefined);
    browser = undefined;
  }
} catch (error) {
  await captureFailureArtifacts(error);
  throw error;
} finally {
  const currentApplication = application;
  if (currentApplication) {
    currentApplication.kill();
    await new Promise((resolve) => currentApplication.once('exit', resolve));
  }
  await rm(temporaryDirectory, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
  await agentFixture.cleanup();
  await fakeProvider?.stop();
}
