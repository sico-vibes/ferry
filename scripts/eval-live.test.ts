import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRpcFerryClient } from '../packages/client/src/index.js';
import { CoreHost, createMemoryTransportPair } from '../packages/core/src/index.js';
import { domainRegistrars } from '../packages/core/src/domains/index.js';
import { createServices } from '../packages/core/src/services.js';
import { MemorySecretStore } from '../packages/secrets/src/index.js';
import { FakeOpenAIServer } from '../packages/testkit/src/fake-servers.js';
import { ProviderIdSchema } from '../packages/shared/src/index.js';
import { driveEvalSession } from './eval-live-runner.mjs';
import {
  accountRun,
  budgetGuard,
  diffUsageHistory,
  parseDotEnv,
  parseEvalArgs,
  redactText,
  runHarness,
  selectEvalProviders,
  verifyScenario,
} from './eval-live-lib.mjs';

const servers: FakeOpenAIServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe('live eval harness helpers', () => {
  it('rejects success claims when scenario artifacts or tests do not pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-eval-verify-'));
    try {
      await writeFile(join(root, 'test.js'), "throw new Error('still failing');\n", 'utf8');
      expect(
        await verifyScenario('fix-failing-test', root, [], [], 'Everything passed successfully.'),
      ).toBe(false);
      await writeFile(join(root, 'index.js'), 'export const value = 1;\n', 'utf8');
      await writeFile(join(root, 'test.js'), "console.log('all tests pass');\n", 'utf8');
      expect(
        await verifyScenario(
          'add-function-test',
          root,
          [],
          [],
          'I added the function and tests pass.',
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 30_000);

  it('parses CLI options and dotenv values without emitting credentials', () => {
    expect(
      parseEvalArgs([
        '--',
        '--profile',
        'best-available',
        '--only',
        'one,two',
        '--repeat',
        '2',
        '--verbose',
        '--yes',
      ]),
    ).toMatchObject({
      profile: 'best-available',
      only: ['one', 'two'],
      include: [],
      exclude: [],
      repeat: 2,
      verbose: true,
      yes: true,
    });
    expect(parseEvalArgs(['--include', 'groq,trial-a', '--exclude', 'credits-a'])).toMatchObject({
      include: ['groq', 'trial-a'],
      exclude: ['credits-a'],
    });
    expect(parseEvalArgs(['--roles', 'off'])).toMatchObject({ roles: 'off' });
    expect(() => parseEvalArgs(['--roles', 'sometimes'])).toThrow('--roles must be on or off');
    const env = parseDotEnv("GROQ_API_KEY='secret-key'\nexport GEMINI_API_KEY=another-secret");
    expect(env).toEqual({ GROQ_API_KEY: 'secret-key', GEMINI_API_KEY: 'another-secret' });
    expect(redactText(JSON.stringify(env), Object.values(env))).not.toContain('secret-key');
    expect(redactText('Authorization: Bearer abcdefghijklmnop', [])).toContain('[REDACTED]');
  });

  it('blocks paid and credits providers unless explicitly allowed', () => {
    const providers = [
      { id: 'groq', tag: 'legit' },
      { id: 'openrouter', tag: 'credits' },
    ];
    expect(budgetGuard(providers)).toEqual({ allowed: false, paid: ['openrouter'] });
    expect(budgetGuard(providers, { allowPaid: true }).allowed).toBe(true);
  });

  it('filters Auto-Free providers by enabled state, credentials, provider policy, and opt-in', () => {
    const providers = [
      { id: 'free', tag: 'legit', enabled: true, keyPresent: true, keyRequired: true },
      { id: 'disabled', tag: 'legit', enabled: false, keyPresent: true, keyRequired: true },
      { id: 'missing-key', tag: 'legit', enabled: true, keyPresent: false, keyRequired: true },
      { id: 'keyless', tag: 'caution', enabled: true, keyPresent: false, keyRequired: false },
      { id: 'paid', tag: 'paid', enabled: true, keyPresent: true, keyRequired: true },
      { id: 'credits', tag: 'credits', enabled: true, keyPresent: true, keyRequired: true },
      {
        id: 'subscription',
        tag: 'subscription_cli',
        enabled: true,
        keyPresent: true,
        keyRequired: true,
      },
      { id: 'trial', tag: 'trial', enabled: true, keyPresent: true, keyRequired: true },
      {
        id: 'unsupported',
        tag: 'legit',
        enabled: true,
        keyPresent: true,
        keyRequired: true,
        freeTierUnsupported: true,
      },
      {
        id: 'billing',
        tag: 'legit',
        enabled: true,
        keyPresent: true,
        keyRequired: true,
        billingEnabled: true,
      },
    ];
    const models = providers.map(({ id }) => ({
      ref: `${id}/model`,
      providerId: id,
      free: id !== 'free',
    }));
    const selected = selectEvalProviders({ providers, models, profile: 'auto-free' });
    expect(selected.providers.map(({ id }) => id)).toEqual(['free', 'keyless']);

    const optedIn = selectEvalProviders({
      providers,
      models,
      profile: 'auto-free',
      include: ['trial', 'free', 'paid'],
      exclude: ['free'],
    });
    expect(optedIn.providers.map(({ id }) => id)).toEqual(['trial']);
  });

  it('keeps paid providers in best-available selection so the budget guard reflects actual candidates', () => {
    const providers = [
      { id: 'free', tag: 'legit', enabled: true, keyPresent: true, keyRequired: true },
      { id: 'credits', tag: 'credits', enabled: true, keyPresent: true, keyRequired: true },
      { id: 'disabled', tag: 'paid', enabled: false, keyPresent: true, keyRequired: true },
    ];
    const models = providers.map(({ id }) => ({ ref: `${id}/model`, providerId: id, free: true }));
    const selected = selectEvalProviders({ providers, models, profile: 'best-available' });
    expect(selected.providers.map(({ id }) => id)).toEqual(['free', 'credits']);
    expect(budgetGuard(selected.providers)).toEqual({ allowed: false, paid: ['credits'] });
  });

  it('runs scenarios through a local fake provider and accounts pass, fail, usage, and errors', async () => {
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
      id: 'chatcmpl_live_eval',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fake-free-model',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    const server = await FakeOpenAIServer.scriptedTurns([
      { chunks: [chunk({ role: 'assistant' }), chunk({ content: 'ok' }), chunk({}, 'stop')] },
      { chunks: [chunk({ role: 'assistant' }), chunk({ content: 'not ok' }), chunk({}, 'stop')] },
    ]).start();
    servers.push(server);
    const report = await runHarness({
      scenarios: [{ id: 'pass' }, { id: 'fail' }],
      runScenario: async (scenario) => {
        const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer fake-key' },
          body: JSON.stringify({
            model: 'fake-free-model',
            messages: [{ role: 'user', content: scenario.id }],
          }),
        });
        expect(response.ok).toBe(true);
        return {
          passed: scenario.id === 'pass',
          steps: 2,
          models: ['fake/fake-free-model'],
          tokensIn: 17,
          tokensOut: 9,
          providerErrors: scenario.id === 'fail' ? { rate_limit: 1 } : {},
        };
      },
    });
    expect(server.requests).toHaveLength(2);
    expect(report).toMatchObject({ passed: 1, total: 2 });
    expect(report.results.map(({ passed }) => passed)).toEqual([true, false]);
    expect(report.results[1]).toMatchObject({
      steps: 2,
      tokensIn: 17,
      tokensOut: 9,
      providerErrors: { rate_limit: 1 },
    });
  }, 30_000);

  it('drives a real core session through the CLI run path and observes a passing model step', async () => {
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
      id: 'chatcmpl_cli_eval',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'openai/gpt-oss-120b',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    const server = FakeOpenAIServer.scriptedTurns([
      {
        chunks: [chunk({ role: 'assistant' }), chunk({ content: 'pong' }), chunk({}, 'stop')],
      },
    ]);
    server.options.models = [{ id: 'openai/gpt-oss-120b', supported_parameters: ['tools'] }];
    await server.start();
    servers.push(server);
    const root = await mkdtemp(join(tmpdir(), 'ferry-live-runner-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const secrets = new MemorySecretStore(`eval-live-runner-${String(process.pid)}`);
    const services = await createServices({
      dataDir: join(root, 'data'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        FERRY_DEV_MODE: 'true',
        FERRY_PROVIDER_BASE_URL_GROQ: `${server.baseUrl}/v1`,
      },
      secrets,
    });
    const [coreTransport, clientTransport] = createMemoryTransportPair();
    const host = new CoreHost({ dataDir: services.paths.home, services, transport: coreTransport });
    for (const register of domainRegistrars) register(host, services);
    await host.start();
    const client = createRpcFerryClient(clientTransport, { timeoutMs: 15_000 });
    try {
      await client.hello;
      await client.providers.setKey(ProviderIdSchema.parse('groq'), 'fake-eval-key');
      for (const provider of await client.providers.list())
        await client.providers.setEnabled(provider.id, provider.id === 'groq');
      const autoFreeProfile = (await client.profiles.list()).find(
        (profile) => profile.name === 'Auto-Free',
      );
      expect(autoFreeProfile).toBeDefined();
      if (!autoFreeProfile) throw new Error('Auto-Free profile missing in fake core');
      const rolesOn = await client.profiles.save({
        ...autoFreeProfile,
        roles: { ...autoFreeProfile.roles, enabled: true },
      });
      expect(rolesOn.roles.enabled).toBe(true);
      await client.profiles.save(autoFreeProfile);
      const result = await driveEvalSession({
        client,
        prompt: 'Reply with exactly one word: pong',
        cwd: workspace,
        profileName: 'Auto-Free',
        maxSteps: 3,
        timeoutMs: 12_000,
        inactivityTimeoutMs: 10_000,
        logDirectory: services.paths.logs,
      });
      const reply = result.detail.messages
        .filter(({ role }) => role === 'assistant')
        .flatMap(({ parts }) => parts.filter(({ type }) => type === 'text').map(({ text }) => text))
        .join('\n');
      expect(result.exitCode).toBe(0);
      expect(result.detail.session.status, JSON.stringify(result.detail)).toBe('idle');
      expect(reply).toMatch(/pong/i);
      const requestRows = services.db.client
        .prepare('SELECT * FROM requests WHERE session_id = ?')
        .all(result.detail.session.id) as { step_id?: string | null }[];
      const steps = new Set(
        requestRows.map(({ step_id }, index) => step_id ?? `row-${String(index)}`),
      );
      expect(steps.size).toBeGreaterThan(0);
      expect(result.exitCode === 0 && /pong/i.test(reply)).toBe(true);
      expect(server.requests.some(({ url }) => url.endsWith('/chat/completions'))).toBe(true);
    } finally {
      client.close();
      await host.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 30_000);

  it('exits within five seconds after writing the report in a child process', async () => {
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
      id: 'chatcmpl_eval_exit',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'openai/gpt-oss-120b',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    const server = new FakeOpenAIServer({
      models: [{ id: 'openai/gpt-oss-120b', supported_parameters: ['tools'] }],
      responses: [
        {
          chunks: [
            chunk({ role: 'assistant' }),
            chunk({ content: 'The intentional assertion in test.js fails.' }),
            chunk({}, 'stop'),
          ],
        },
      ],
    });
    await server.start();
    servers.push(server);
    const root = await mkdtemp(join(tmpdir(), 'ferry-eval-exit-'));
    await writeFile(join(root, '.env.local'), 'GROQ_API_KEY=fake-eval-key\n', 'utf8');
    const output = await runEvalChild(root, server.baseUrl, [
      '--profile',
      'best-available',
      '--include',
      'groq',
      '--only',
      'read-explain',
      '--yes',
      '--timeout',
      '30',
    ]);
    expect(output.text).toContain('Results:');
    expect(output.reportExitMs).toBeLessThan(5000);
    expect(output.code).toBe(0);
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }, 30_000);

  it('cancels active work and exits cleanly on SIGINT', async () => {
    const chunk = (delta: Record<string, unknown>) => ({
      id: 'chatcmpl_eval_sigint',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'openai/gpt-oss-120b',
      choices: [{ index: 0, delta, finish_reason: null }],
    });
    const server = new FakeOpenAIServer({
      models: [{ id: 'openai/gpt-oss-120b', supported_parameters: ['tools'] }],
      responses: [
        { chunks: [chunk({ role: 'assistant' }), chunk({ content: 'working' })], delayMs: 4000 },
      ],
    });
    await server.start();
    servers.push(server);
    const root = await mkdtemp(join(tmpdir(), 'ferry-eval-sigint-'));
    await writeFile(join(root, '.env.local'), 'GROQ_API_KEY=fake-eval-key\n', 'utf8');
    const child = await startSignalEvalChild(root, server.baseUrl);
    try {
      await waitForChildText(child, 'SESSION-STARTED', 30_000);
      const result = await collectChild(child, 12_000);
      expect(result.elapsedMs).toBeLessThan(12_000);
      expect(result.code).toBe(130);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 30_000);

  it('surfaces the core same-data-dir lock as an eval-specific message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferry-eval-lock-'));
    const dataDir = join(root, 'data');
    await mkdir(dataDir, { recursive: true });
    const host = new CoreHost({ dataDir });
    await host.start();
    try {
      const output = await runEvalChild(root, 'http://127.0.0.1:1', [
        '--data-dir',
        dataDir,
        '--only',
        'read-explain',
        '--yes',
      ]);
      expect(output.code).toBe(1);
      expect(output.text).toContain('Another Ferry eval/core is already using this --data-dir');
    } finally {
      await host.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 30_000);

  it('accounts engine request rows by session id', () => {
    expect(
      accountRun({
        result: { sessionId: 's1', steps: 3 },
        measurements: [
          { sessionId: 's1', model: 'groq/model', input_tokens: 10, output_tokens: 5 },
          {
            sessionId: 's1',
            model: 'gemini/model',
            input_tokens: 7,
            output_tokens: 4,
            error_kind: 'rate_limit',
          },
          { sessionId: 's2', model: 'other/model', input_tokens: 100, output_tokens: 100 },
        ],
      }),
    ).toEqual({
      steps: 3,
      models: ['groq/model', 'gemini/model'],
      tokensIn: 17,
      tokensOut: 9,
      providerErrors: { rate_limit: 1 },
    });
  });

  it('uses quota usage history deltas for per-task token accounting', () => {
    expect(
      diffUsageHistory(
        [
          {
            date: '2026-09-27',
            providerId: 'groq',
            requests: 2,
            inputTokens: 100,
            outputTokens: 30,
            costUsd: 0,
          },
        ],
        [
          {
            date: '2026-09-27',
            providerId: 'groq',
            requests: 3,
            inputTokens: 145,
            outputTokens: 48,
            costUsd: 0,
          },
          {
            date: '2026-09-27',
            providerId: 'gemini',
            requests: 1,
            inputTokens: 12,
            outputTokens: 7,
            costUsd: 0,
          },
        ],
      ),
    ).toEqual({ inputTokens: 57, outputTokens: 25 });
  });
});

function startEvalChild(cwd: string, baseUrl: string, args: string[]) {
  const script = fileURLToPath(new URL('./eval-live.mjs', import.meta.url));
  const loader = import.meta.resolve('tsx');
  return spawn(process.execPath, ['--import', loader, script, ...args], {
    cwd,
    env: {
      ...process.env,
      GROQ_API_KEY: 'fake-eval-key',
      FERRY_PROVIDER_BASE_URL_GROQ: `${baseUrl}/v1`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function runEvalChild(cwd: string, baseUrl: string, args: string[]) {
  const child = startEvalChild(cwd, baseUrl, args);
  return collectChild(child, 45_000);
}

async function startSignalEvalChild(cwd: string, baseUrl: string) {
  const moduleUrl = new URL('./eval-live.mjs', import.meta.url).href;
  const wrapper = join(cwd, 'signal-eval.mjs');
  await writeFile(
    wrapper,
    `import { runEvalLive } from ${JSON.stringify(moduleUrl)};\n` +
      `let fallback; const arm = (code) => { clearTimeout(fallback); fallback = setTimeout(() => process.exit(code), 5000); };\n` +
      `const result = runEvalLive(['--profile', 'best-available', '--include', 'groq', '--only', 'read-explain', '--yes', '--timeout', '30'], { onSession() { console.log('SESSION-STARTED'); setTimeout(() => process.emit('SIGINT'), 500); }, onSignal: arm, onShutdown: arm, onCleanup() { clearTimeout(fallback); } });\n` +
      `result.then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(1); });\n`,
    'utf8',
  );
  const loader = import.meta.resolve('tsx');
  return spawn(process.execPath, ['--import', loader, wrapper], {
    cwd,
    env: {
      ...process.env,
      FERRY_PROVIDER_BASE_URL_GROQ: `${baseUrl}/v1`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function collectChild(child: ReturnType<typeof spawn>, timeoutMs: number) {
  const started = Date.now();
  let text = '';
  let reportAt: number | undefined;
  const receive = (part: string) => {
    text += part;
    if (reportAt === undefined && text.includes('Results:')) reportAt = Date.now();
  };
  child.stdout.setEncoding('utf8').on('data', receive);
  child.stderr.setEncoding('utf8').on('data', receive);
  return new Promise<{
    code: number | null;
    text: string;
    elapsedMs: number;
    reportExitMs: number;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Eval child did not exit in ${timeoutMs}ms. Output: ${text}`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        text,
        elapsedMs: Date.now() - started,
        reportExitMs: reportAt === undefined ? Date.now() - started : Date.now() - reportAt,
      });
    });
  });
}

async function waitForChildText(
  child: ReturnType<typeof spawn>,
  expected: string,
  timeoutMs: number,
) {
  let text = '';
  child.stdout.setEncoding('utf8').on('data', (part: string) => {
    text += part;
  });
  child.stderr.setEncoding('utf8').on('data', (part: string) => {
    text += part;
  });
  const deadline = Date.now() + timeoutMs;
  while (!text.includes(expected)) {
    if (child.exitCode !== null) throw new Error(`Eval child exited before ${expected}: ${text}`);
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${expected}: ${text}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
