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
const phase = process.env.FERRY_E2E_ONLY?.trim() || 'core-flows';
const phases = ['core-flows', 'crash-resume', 'paid-guardrails'];

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

async function callRendererRpc(page, method, params) {
  return await page.evaluate(
    async ({ method: rpcMethod, params: rpcParams }) => {
      const [domain, action] = rpcMethod.split('.');
      if (!domain || !action) throw new Error(`Invalid RPC method name: ${rpcMethod}`);
      try {
        return await window.ferryRpcClient[domain][action](...rpcParams);
      } catch (error) {
        const rpcError = error && typeof error === 'object' ? error : {};
        const details = 'details' in rpcError ? rpcError.details : undefined;
        const diagnostics = {
          method: rpcMethod,
          name: 'name' in rpcError ? rpcError.name : undefined,
          code: 'code' in rpcError ? rpcError.code : undefined,
          kind: 'kind' in rpcError ? rpcError.kind : undefined,
          message: 'message' in rpcError ? rpcError.message : String(error),
          zodIssues:
            details && typeof details === 'object' && 'issues' in details
              ? details.issues
              : undefined,
        };
        throw new Error(`E2E RPC failed: ${JSON.stringify(diagnostics)}`);
      }
    },
    { method, params },
  );
}

async function approvePendingRequestsUntilIdle(
  page,
  sessionId,
  { allowedKinds, timeout = 30_000 } = {},
) {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          async ({ id, permittedKinds }) => {
            const detail = await window.ferryRpcClient.sessions.get(id);
            const pending = detail.messages
              .flatMap((message) => message.parts)
              .filter((part) => part.type === 'approval_request' && part.state === 'pending');
            const approvals = permittedKinds
              ? pending.filter((part) => permittedKinds.includes(part.kind))
              : pending;
            const unsupported = pending.filter((part) => !approvals.includes(part));
            if (unsupported.length) {
              throw new Error(
                `Unexpected pending approval(s): ${unsupported.map((part) => part.kind).join(', ')}`,
              );
            }
            for (const approval of approvals) {
              await window.ferryRpcClient.approvals.respond(id, approval.id, 'allow_once');
            }
            return detail.session.status;
          },
          { id: sessionId, permittedKinds: allowedKinds },
        ),
      { timeout },
    )
    .toBe('idle');
}

async function approvePendingRequestsUntilRunning(
  page,
  sessionId,
  { allowedKinds, timeout = 30_000 } = {},
) {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          async ({ id, permittedKinds }) => {
            const detail = await window.ferryRpcClient.sessions.get(id);
            const pending = detail.messages
              .flatMap((message) => message.parts)
              .filter((part) => part.type === 'approval_request' && part.state === 'pending');
            const approvals = pending.filter((part) => permittedKinds.includes(part.kind));
            const unsupported = pending.filter((part) => !approvals.includes(part));
            if (unsupported.length) {
              throw new Error(
                `Unexpected pending approval(s): ${unsupported.map((part) => part.kind).join(', ')}`,
              );
            }
            for (const approval of approvals) {
              await window.ferryRpcClient.approvals.respond(id, approval.id, 'allow_once');
            }
            return detail.session.status;
          },
          { id: sessionId, permittedKinds: allowedKinds },
        ),
      { timeout },
    )
    .toBe('running');
}

async function createSessionViaUi(page, title, profileName, modelRef) {
  const previousSessions = await callRendererRpc(page, 'sessions.list', []);
  const previousSessionIds = previousSessions.map((session) => session.id);
  await page.getByRole('button', { name: 'Add tab' }).click();
  let routeSnapshot;
  await expect
    .poll(
      async () => {
        routeSnapshot = await page.evaluate(async (knownSessionIds) => {
          const routeSessionId = window.location.hash.split('/').filter(Boolean).at(-1);
          const sessions = await window.ferryRpcClient.sessions.list();
          const newSessionIds = sessions
            .filter((session) => !knownSessionIds.includes(session.id))
            .map((session) => session.id);
          return {
            routeSessionId,
            newSessionIds,
            isNewSessionOnRoute:
              Boolean(routeSessionId) &&
              !knownSessionIds.includes(routeSessionId) &&
              newSessionIds.includes(routeSessionId),
          };
        }, previousSessionIds);
        return routeSnapshot;
      },
      { timeout: 15_000 },
    )
    .toMatchObject({ isNewSessionOnRoute: true });
  const sessionId = routeSnapshot.routeSessionId;
  if (!sessionId) throw new Error(`Add tab did not create a session for ${title}`);
  const detail = await callRendererRpc(page, 'sessions.get', [sessionId]);
  const sessionIdFromDetail = detail.session.id;
  if (sessionIdFromDetail !== sessionId) {
    throw new Error(
      `Add tab route session mismatch for ${title}: route=${sessionId}, detail=${sessionIdFromDetail}`,
    );
  }
  const profiles = await callRendererRpc(page, 'profiles.list', []);
  const profile = profiles.find((item) => item.name === profileName);
  if (!profile) throw new Error(`Profile not found: ${profileName}`);
  await callRendererRpc(page, 'profiles.activate', [profile.id, sessionIdFromDetail]);
  await callRendererRpc(page, 'sessions.rename', [sessionIdFromDetail, title]);
  await callRendererRpc(page, 'models.select', [sessionIdFromDetail, modelRef]);
  await page.evaluate((id) => {
    window.location.hash = `/s/${id}`;
  }, sessionIdFromDetail);
  await page.waitForURL((url) => url.hash === `#/s/${sessionIdFromDetail}`, {
    timeout: 15_000,
  });
  return { ...detail.session, id: sessionIdFromDetail };
}

try {
  if (!phases.includes(phase)) {
    throw new Error(`Unsupported FERRY_E2E_ONLY phase: ${phase}. Supported: ${phases.join(', ')}`);
  }
  fakeProvider = new FakeOpenAIServer({
    models: [
      { id: 'cohere/north-mini-code:free', supported_parameters: ['tools'] },
      {
        id: 'bytedance-seed/seed-2.0-mini',
        supported_parameters: ['tools'],
        pricing: { prompt: '0.0000005', completion: '0.000001' },
      },
    ],
    responses: [],
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

    if (phase === 'core-flows') {
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
    }

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
    const walkingSkeletonModel = await page.evaluate(async () => {
      const freeModel = (await window.ferryRpcClient.models.list('openrouter')).find(
        (item) => item.ref.endsWith(':free') && item.toolCalling,
      );
      if (!freeModel) throw new Error('OpenRouter free tool model is unavailable');
      return freeModel.ref;
    });

    if (phase === 'core-flows') {
      failureStep = 'checkpoint-restore';
      const checkpointId = createShadowCheckpoint('FixtureRepo baseline');
      assert.match(checkpointId, /^[a-f0-9]{40}$/);
      await writeFile(sourcePath, editedSource, 'utf8');
      const checkpointSession = await createSessionViaUi(
        page,
        'Checkpoint Restore E2E',
        'Auto-Free',
        walkingSkeletonModel,
      );
      await page.evaluate((id) => {
        window.location.hash = `/s/${id}`;
      }, checkpointSession.id);
      await page.waitForURL((url) => url.hash === `#/s/${checkpointSession.id}`, {
        timeout: 15_000,
      });
      await expect(page.locator('.transcript-viewport')).toBeVisible();
      await page.getByRole('button', { name: 'Changes', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Changes', exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
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

      failureStep = 'walking-skeleton';
      await page.getByRole('button', { name: 'Chats navigation' }).click();
      const agentSession = await createSessionViaUi(
        page,
        'Agent walking skeleton',
        'Auto-Free',
        walkingSkeletonModel,
      );
      assert.equal(new URL(page.url()).hash, `#/s/${agentSession.id}`);
      const composer = page.getByRole('textbox', { name: 'Message Ferry' });
      fakeProvider.setResponses([
        toolTurn(
          'update_plan',
          { items: [{ text: 'Edit the failing fixture and run its tests', status: 'doing' }] },
          'I will update the failing fixture and verify the tests.',
        ),
        toolTurn('edit_file', { path: 'index.js', edits: [{ search: '42', replace: '0' }] }),
        toolTurn('run_command', { command: 'node test.js', cwd: '.', timeoutMs: 10000 }),
        textTurn('The fixture now passes its tests.'),
      ]);
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
          { timeout: 30_000 },
        )
        .toBe('awaiting_approval');
      await expect
        .poll(() => page.evaluate(() => window.e2eStreamedText))
        .toContain('I will update the failing fixture and verify the tests.');
      const approval = await page.evaluate(async (id) => {
        const detail = await window.ferryRpcClient.sessions.get(id);
        const paidApproval = detail.messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === 'approval_request' && part.kind === 'paid_model');
        if (paidApproval) throw new Error('Auto-Free requested approval for a free model');
        return detail.messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === 'approval_request' && part.state === 'pending')?.id;
      }, agentSession.id);
      expect(approval).toBeTruthy();
      await approvePendingRequestsUntilIdle(page, agentSession.id);
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
            (part) =>
              part.type === 'text' && part.text.includes('The fixture now passes its tests.'),
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
      failureStep = 'cancellation';
      await page.getByRole('button', { name: 'Chats navigation' }).click();
      const cancellationModel = await page.evaluate(async () => {
        const model = (await window.ferryRpcClient.models.list('openrouter')).find(
          (item) => item.ref.endsWith(':free') && item.toolCalling,
        );
        if (!model) throw new Error('OpenRouter free tool model is unavailable');
        return model.ref;
      });
      const cancellationSession = await createSessionViaUi(
        page,
        'Cancellation E2E',
        'Auto-Free',
        cancellationModel,
      );
      await expect(composer).toBeVisible({ timeout: 15_000 });

      fakeProvider.setResponses([
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
      await composer.fill('Start a slow response so I can cancel it.');
      await composer.press('Enter');
      await expect
        .poll(
          async () =>
            await page.evaluate(
              async (id) => (await window.ferryRpcClient.sessions.get(id)).session.status,
              cancellationSession.id,
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
              cancellationSession.id,
            ),
        )
        .toBe('idle');
      console.log('e2e real domains: cancellation stops a streaming turn mid-run OK');

      failureStep = 'rate-limit';
      const rateLimitModel = await page.evaluate(async () => {
        const model = (await window.ferryRpcClient.models.list('openrouter')).find(
          (item) => item.ref.includes('north-mini-code') && item.toolCalling,
        );
        if (!model) throw new Error('North Mini Code model is unavailable');
        return model.ref;
      });
      const handoffSession = await createSessionViaUi(
        page,
        'Rate Limit Recovery E2E',
        'Auto-Free',
        rateLimitModel,
      );
      const manualTrigger = page.getByRole('button', { name: /Manual · North Mini Code/ });
      await expect(manualTrigger).toBeVisible();
      await manualTrigger.click();
      const autoModel = page.getByRole('option', { name: /Auto \(recommended\)/ });
      await expect(autoModel).toBeVisible();
      await autoModel.click();
      await expect(page.getByRole('dialog', { name: 'Choose model' })).toBeHidden();
      await expect(page.getByRole('button', { name: /Auto ·/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Auto-Free', exact: true })).toBeVisible();
      await page.evaluate((sessionId) => {
        window.e2eHandoffParts = [];
        window.ferryRpcClient.on('session.part', (event) => {
          if (event.sessionId === sessionId && event.part.type === 'handoff_marker')
            window.e2eHandoffParts.push(event.part);
        });
      }, handoffSession.id);
      fakeProvider.setResponses([
        {
          status: 429,
          body: { error: { message: 'scripted rate limit', type: 'rate_limit_error' } },
        },
        textTurn('Continued successfully after a provider handoff.'),
      ]);
      await composer.fill('Continue with a forced provider handoff.');
      await composer.press('Enter');
      const handoff = page.getByRole('button', { name: /Switched .*rate_limit/ }).first();
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
        }, handoffSession.id);
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
      const handoffEvidence = await page.evaluate(
        async (sessionId) => ({
          parts: window.e2eHandoffParts,
          stats: await window.ferryRpcClient.quota.handoffs(30),
          session: await window.ferryRpcClient.sessions.get(sessionId),
        }),
        handoffSession.id,
      );
      assert.ok(handoffEvidence.parts.some((part) => part.reason === 'rate_limit'));
      assert.ok(
        handoffEvidence.stats.some(
          (handoff) => handoff.reason === 'rate_limit' && handoff.count > 0,
        ),
      );
      assert.ok(
        handoffEvidence.session.messages.some((message) =>
          message.parts.some((part) => part.type === 'handoff_marker' && part.briefingTokens >= 0),
        ),
      );
      await approvePendingRequestsUntilIdle(page, handoffSession.id, { timeout: 60_000 });
      const handoffDetail = await page.evaluate(
        async (id) => await window.ferryRpcClient.sessions.get(id),
        handoffSession.id,
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
    }

    if (phase === 'crash-resume') {
      failureStep = 'crash-resume';
      fakeProvider.setResponses([
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
              choices: [
                { index: 0, delta: { content: 'slow provider step' }, finish_reason: null },
              ],
            },
          ],
          holdOpen: true,
        },
        toolTurn('edit_file', {
          path: 'index.js',
          edits: [{ search: 'answer = 0', replace: 'answer = 1' }],
        }),
        textTurn('The interrupted task resumed and completed.'),
      ]);
      failureStep = 'crash-resume-create';
      const crashSession = await createSessionViaUi(
        page,
        'Crash Resume E2E',
        'Auto-Free',
        walkingSkeletonModel,
      );
      const crashSessionRoute = new URL(page.url()).hash;
      const crashSessionMatch = /^#\/s\/([^/?#]+)$/.exec(crashSessionRoute);
      if (!crashSessionMatch?.[1]) {
        throw new Error(`Could not capture crash session id from route: ${crashSessionRoute}`);
      }
      const crashSessionId = crashSessionMatch[1];
      assert.equal(crashSession.id, crashSessionId);
      await expect(page.locator('.transcript-viewport')).toHaveAttribute(
        'data-session-status',
        'idle',
      );
      const beforeCrashRequests = fakeProvider.requests.length;
      void page.evaluate(
        (id) =>
          window.ferryRpcClient.sessions.send(id, { text: 'Finish the crash recovery task.' }),
        crashSessionId,
      );
      await approvePendingRequestsUntilRunning(page, crashSessionId, {
        allowedKinds: ['command', 'edit'],
        timeout: 30_000,
      });
      await expect
        .poll(() => fakeProvider.requests.length, { timeout: 10_000 })
        .toBeGreaterThan(beforeCrashRequests);
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
      await approvePendingRequestsUntilIdle(page, crashSessionId, {
        allowedKinds: ['command', 'edit'],
      });
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
      console.log(
        'e2e real domains: killed mid-provider step, restarted, resumed, and completed OK',
      );
    }

    if (phase === 'paid-guardrails') {
      failureStep = 'paid-guardrails';
      const paidStepRequestStart = fakeProvider.requests.length;
      const billingProvider = await callRendererRpc(page, 'providers.setBillingEnabled', [
        'openrouter',
        true,
      ]);
      expect(billingProvider.billingEnabled).toBe(true);
      const bestAvailable = (await callRendererRpc(page, 'profiles.list', [])).find(
        (profile) => profile.name === 'Best Available',
      );
      if (!bestAvailable) throw new Error('Best Available profile is unavailable');
      await callRendererRpc(page, 'profiles.save', [
        { ...bestAvailable, roles: { ...bestAvailable.roles, enabled: false } },
      ]);
      await callRendererRpc(page, 'settings.update', [
        { paidCaps: { dailyUsd: null, sessionUsd: null, monthlyUsd: null } },
      ]);
      const spendBeforePaid = await page.evaluate(async () => {
        const history = await window.ferryRpcClient.quota.history(31);
        const today = new Date().toISOString().slice(0, 10);
        return history
          .filter((point) => point.date === today)
          .reduce((sum, point) => sum + point.costUsd, 0);
      });
      const paidModelCatalog = await page.evaluate(async () => {
        const models = await window.ferryRpcClient.models.list('openrouter');
        return {
          selected:
            models.find(
              (model) =>
                !model.free &&
                model.toolCalling &&
                model.priceInPerM !== null &&
                model.priceInPerM > 0 &&
                model.priceOutPerM !== null,
            )?.ref ?? null,
          paidModelIds: models
            .filter((model) => !model.free)
            .map((model) => model.ref.replace(/^openrouter\//, '')),
        };
      });
      const paidModel = paidModelCatalog.selected;
      const paidOpenRouterModelIds = new Set(paidModelCatalog.paidModelIds);
      expect(paidModel).toBeTruthy();
      const paidWorkspaceExists = await page.evaluate(
        async (workspaceId) =>
          (await window.ferryRpcClient.workspaces.list()).some(
            (workspace) => workspace.id === workspaceId,
          ),
        openedWorkspace.id,
      );
      expect(paidWorkspaceExists).toBe(true);
      // The Electron file renderer uses hash routing; wait for Add tab to navigate to its new session.
      const livePaidSession = await createSessionViaUi(
        page,
        'Paid guardrails E2E',
        'Best Available',
        paidModel,
      );
      expect(livePaidSession).toBeTruthy();
      const livePaidSessionId = livePaidSession.id;
      const paidSetup = await page.evaluate(async (sessionId) => {
        const providers = await window.ferryRpcClient.providers.list();
        const profiles = await window.ferryRpcClient.profiles.list();
        const detail = await window.ferryRpcClient.sessions.get(sessionId);
        const profile = profiles.find((item) => item.id === detail.session.profileId);
        return {
          billingEnabled: providers.find((item) => item.id === 'openrouter')?.billingEnabled,
          profile: profile
            ? {
                id: profile.id,
                name: profile.name,
                paidAllowed: profile.paidAllowed,
                rolesEnabled: profile.roles.enabled,
              }
            : null,
          session: {
            profileId: detail.session.profileId,
            modelRef: detail.session.modelRef,
            pinnedModelRef: detail.session.pinnedModelRef,
          },
        };
      }, livePaidSessionId);
      expect(paidSetup.billingEnabled).toBe(true);
      expect(paidSetup.profile).toMatchObject({
        id: 'profile_builtin_best_available',
        name: 'Best Available',
        paidAllowed: true,
        rolesEnabled: false,
      });
      expect(paidSetup.session.modelRef).toBe(paidModel);
      expect(paidSetup.session.pinnedModelRef).toBe(paidModel);
      console.log('e2e paid setup readback ' + JSON.stringify(paidSetup));
      const paidComposer = page.getByRole('textbox', { name: 'Message Ferry' });
      fakeProvider.setResponses([textTurn('Paid approval completed.')]);
      const paidSendDispatch = await page.evaluate(
        ({ sessionId, text }) => {
          window.e2ePaidSendResult = { state: 'pending' };
          void window.ferryRpcClient.sessions.send(sessionId, { text }).then(
            () => {
              window.e2ePaidSendResult = { state: 'resolved' };
            },
            (error) => {
              window.e2ePaidSendResult = {
                state: 'rejected',
                message: error instanceof Error ? error.message : String(error),
              };
            },
          );
          return { state: 'dispatched', sessionId, text };
        },
        { sessionId: livePaidSessionId, text: 'Use the paid model after explicit confirmation.' },
      );
      let paidPreAssertionTrace;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        paidPreAssertionTrace = await page.evaluate(async (sessionId) => {
          const detail = await window.ferryRpcClient.sessions.get(sessionId);
          const messages = detail.messages.slice(-5).map((message) => ({
            role: message.role,
            modelRef: message.modelRef,
            parts: message.parts.map((part) => ({
              type: part.type,
              ...('text' in part ? { text: part.text } : {}),
              ...('message' in part ? { message: part.message } : {}),
              ...('kind' in part ? { kind: part.kind } : {}),
              ...('state' in part ? { state: part.state } : {}),
            })),
          }));
          const paidApproval = detail.messages
            .flatMap((message) => message.parts)
            .find(
              (part) =>
                part.type === 'approval_request' &&
                part.kind === 'paid_model' &&
                part.state === 'pending',
            );
          return {
            sendResult: window.e2ePaidSendResult ?? { state: 'missing' },
            session: { status: detail.session.status, modelRef: detail.session.modelRef, messages },
            paidApprovalId: paidApproval?.id ?? null,
          };
        }, livePaidSessionId);
        if (paidPreAssertionTrace.paidApprovalId) break;
        await page.waitForTimeout(100);
      }
      const paidRequestsSinceStart = fakeProvider.requests
        .slice(paidStepRequestStart)
        .map(({ method, url, body }) => ({ method, url, model: body?.model ?? null }));
      console.log(
        'e2e paid pre-assert trace ' +
          JSON.stringify({
            sendDispatch: paidSendDispatch,
            livePaidSessionId,
            sendSessionMatchesLivePaidSession: paidSendDispatch.sessionId === livePaidSessionId,
            ...paidPreAssertionTrace,
            fakeProviderRequestsSinceStepStart: paidRequestsSinceStart,
          }),
      );
      const pendingPaidApproval = paidPreAssertionTrace.paidApprovalId;
      expect(
        pendingPaidApproval,
        `first paid request should produce a paid-model approval (dispatch session ${paidSendDispatch.sessionId}, live session ${livePaidSessionId})`,
      ).toBeTruthy();
      const paidConfirmation = page.getByText(/Use .* from .* for an estimated \$\d+\.\d{4}/);
      await expect(paidConfirmation).toBeVisible({
        timeout: 30_000,
      });
      await expect(paidConfirmation).toContainText('OpenRouter');
      await expect(paidConfirmation).not.toContainText(/free models/i);
      const screenshotDirectory = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'design',
        'screenshots',
        'app',
      );
      await mkdir(screenshotDirectory, { recursive: true });
      await page.screenshot({
        path: join(screenshotDirectory, 'paid-confirmation.png'),
        fullPage: false,
      });
      await page.evaluate(
        async ({ sessionId, partId }) => {
          await window.ferryRpcClient.approvals.respond(sessionId, partId, 'allow_once');
        },
        { sessionId: livePaidSessionId, partId: pendingPaidApproval },
      );
      try {
        await expect
          .poll(async () =>
            page.evaluate(
              async ({ sessionId, partId }) => {
                const detail = await window.ferryRpcClient.sessions.get(sessionId);
                return detail.messages
                  .flatMap((message) => message.parts)
                  .find((part) => part.type === 'approval_request' && part.id === partId)?.state;
              },
              { sessionId: livePaidSessionId, partId: pendingPaidApproval },
            ),
          )
          .toBe('allowed_once');
        await approvePendingRequestsUntilIdle(page, livePaidSessionId, { timeout: 30_000 });
      } catch (error) {
        const pending = await page.evaluate(async (id) => {
          const detail = await window.ferryRpcClient.sessions.get(id);
          return {
            status: detail.session.status,
            approvals: detail.messages
              .flatMap((message) => message.parts)
              .filter((part) => part.type === 'approval_request'),
          };
        }, livePaidSessionId);
        console.error(
          'e2e paid approval diagnostic',
          JSON.stringify({
            dispatchSessionId: paidSendDispatch.sessionId,
            livePaidSessionId,
            pending,
          }),
        );
        throw error;
      }
      const paidUsage = await page.evaluate(async () => {
        const history = await window.ferryRpcClient.quota.history(31);
        const today = new Date().toISOString().slice(0, 10);
        return history
          .filter((point) => point.date === today)
          .reduce((sum, point) => sum + point.costUsd, 0);
      });
      expect(paidUsage).toBeGreaterThan(spendBeforePaid);
      const paidTurnTrace = await page.evaluate(async (sessionId) => {
        const detail = await window.ferryRpcClient.sessions.get(sessionId);
        return {
          status: detail.session.status,
          modelRef: detail.session.modelRef,
          assistantModels: detail.messages
            .filter((message) => message.role === 'assistant')
            .map((message) => message.modelRef)
            .filter(Boolean),
          modelAttempts: detail.messages.flatMap((message) => message.modelAttempts ?? []),
          handoffs: detail.messages
            .flatMap((message) => message.parts)
            .filter((part) => part.type === 'handoff_marker')
            .map((part) => ({ from: part.from, to: part.to, reason: part.reason })),
        };
      }, livePaidSessionId);
      const paidProviderRequests = fakeProvider.requests.filter((request) =>
        request.url.startsWith('/openrouter/'),
      );
      const paidModelRequests = paidProviderRequests.filter(
        (request) => request.body?.model === paidModel.replace(/^openrouter\//, ''),
      );
      expect(paidModelRequests.length).toBeGreaterThan(0);
      expect(paidTurnTrace.assistantModels).toContain(paidModel);
      expect(paidTurnTrace.modelRef).toBe(paidModel);
      console.log(
        'e2e paid model trace ' +
          JSON.stringify({
            ...paidTurnTrace,
            requests: paidProviderRequests.map((request) => request.body?.model),
          }),
      );
      const capState = await page.evaluate(async () => {
        const settings = await window.ferryRpcClient.settings.get();
        const history = await window.ferryRpcClient.quota.history(31);
        const today = new Date().toISOString().slice(0, 10);
        const used = history
          .filter((point) => point.date === today)
          .reduce((sum, point) => sum + point.costUsd, 0);
        return { used, caps: { ...settings.paidCaps, dailyUsd: used } };
      });
      const cappedSettings = await callRendererRpc(page, 'settings.update', [
        { paidCaps: capState.caps },
      ]);
      expect(capState.used).toBeGreaterThan(0);
      expect(cappedSettings.paidCaps.dailyUsd).toBe(capState.used);
      const paidRequestsBeforeCappedAttempt = fakeProvider.requests.filter(
        (request) =>
          request.url.startsWith('/openrouter/') &&
          typeof request.body?.model === 'string' &&
          paidOpenRouterModelIds.has(request.body.model),
      ).length;
      await paidComposer.fill('Attempt a second paid call after the cap is reached.');
      await paidComposer.press('Enter');
      await expect(page.getByText(/Paid cap reached:/)).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole('button', { name: 'Wait for free capacity' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Raise cap' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
      await page.screenshot({
        path: join(screenshotDirectory, 'paid-cap-reached.png'),
        fullPage: false,
      });
      expect(
        fakeProvider.requests.filter(
          (request) =>
            request.url.startsWith('/openrouter/') &&
            typeof request.body?.model === 'string' &&
            paidOpenRouterModelIds.has(request.body.model),
        ),
      ).toHaveLength(paidRequestsBeforeCappedAttempt);
      console.log(
        'e2e real domains: paid confirmation, recorded spend, cap hard stop, and screenshots OK',
      );
    }
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
