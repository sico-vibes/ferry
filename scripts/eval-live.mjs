import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServices } from '../packages/core/src/services.ts';
import { CoreHost } from '../packages/core/src/host.ts';
import { createMemoryTransportPair } from '../packages/core/src/index.ts';
import { domainRegistrars } from '../packages/core/src/domains/index.ts';
import { getModelDiscovery } from '../packages/core/src/domains/model-discovery.ts';
import { createRpcFerryClient } from '../packages/client/src/index.ts';
import { KeyringSecretStore, MemorySecretStore } from '../packages/secrets/src/index.ts';
import { AGENT_EVALS } from '../packages/agent/evals/fixtures.ts';
import { createFixtureRepo } from '../packages/testkit/src/fixture-repo.ts';
import {
  accountRun,
  budgetGuard,
  diffUsageHistory,
  estimateProviderRequests,
  fileDigest,
  formatMarkdown,
  parseDotEnv,
  parseEvalArgs,
  redactText,
  runHarness,
  selectEvalProviders,
  verifyScenario,
} from './eval-live-lib.mjs';
import { driveEvalSession } from './eval-live-runner.mjs';

const execFileAsync = promisify(execFile);
const usage = `Usage: pnpm eval:live [--data-dir PATH] [--profile auto-free|best-available]
  [--only id,id] [--repeat N] [--model provider/model] [--max-steps N]
  [--timeout SECONDS] [--include provider,id] [--exclude provider,id]
  [--allow-paid] [--roles on|off] [--yes] [--json] [--verbose]`;
let activeSecrets = [];

export async function runEvalLive(args = process.argv.slice(2), lifecycle = {}) {
  const options = parseEvalArgs(args);
  if (options.help) {
    console.log(usage);
    return 0;
  }
  const unknown = options.only.filter((id) => !AGENT_EVALS.some((scenario) => scenario.id === id));
  if (unknown.length) throw new Error(`Unknown scenario id(s): ${unknown.join(', ')}`);
  const scenarios = AGENT_EVALS.filter(
    (scenario) => !options.only.length || options.only.includes(scenario.id),
  );
  if (!scenarios.length) throw new Error('No scenarios selected');

  const envFile = parseDotEnv(
    await readFile(join(process.cwd(), '.env.local'), 'utf8').catch(() => ''),
  );
  const secrets = Object.entries(envFile).filter(
    ([name, value]) => /_API_KEY$/.test(name) && value,
  );
  const secretValues = secrets.map(([, value]) => value);
  activeSecrets = secretValues;
  const dataDir = options.dataDir
    ? resolve(options.dataDir)
    : await makeTempDir('ferry-live-data-');
  const tempData = !options.dataDir;
  const memorySecrets = new MemorySecretStore(`eval-live-${process.pid}`);
  const keyringSecrets = new KeyringSecretStore(process.env.FERRY_KEYRING_SERVICE ?? 'Ferry');
  const secretsStore = {
    set: (providerId, value) => memorySecrets.set(providerId, value),
    async get(providerId) {
      return (await memorySecrets.get(providerId)) ?? keyringSecrets.get(providerId);
    },
    delete: async (providerId) => {
      await memorySecrets.delete(providerId);
      await keyringSecrets.delete(providerId);
    },
    async has(providerId) {
      return (await memorySecrets.has(providerId)) || keyringSecrets.has(providerId);
    },
  };
  const serviceEnv = { ...process.env, FERRY_DEV_MODE: 'true' };
  for (const [name, value] of secrets) {
    const providerId = name
      .slice(0, -'_API_KEY'.length)
      .toLowerCase()
      .replaceAll('_', '-')
      .replace(/^opencode-zen$/, 'opencode');
    await memorySecrets.set(providerId, value);
  }
  const services = await createServices({ dataDir, env: serviceEnv, secrets: secretsStore });
  let host;
  let rpc;
  const activeSessions = new Set();
  let signalCode;
  const abortController = new AbortController();
  const onSignal = (signal) => {
    signalCode ??= signal === 'SIGINT' ? 130 : 143;
    abortController.abort();
    lifecycle.onSignal?.(signalCode);
    void cancelSessions();
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  const cancelSessions = async () => {
    if (rpc) await Promise.allSettled([...activeSessions].map((id) => rpc.sessions.cancel(id)));
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  let exitCode = 1;
  try {
    for (const [name] of secrets) {
      const providerId = name
        .slice(0, -'_API_KEY'.length)
        .toLowerCase()
        .replaceAll('_', '-')
        .replace(/^opencode-zen$/, 'opencode');
      if (!services.catalog.providers.some(({ provider }) => provider === providerId)) continue;
      services.providerKeys.put({
        id: providerId,
        providerId,
        keyringRef: providerId,
        createdAt: new Date().toISOString(),
      });
    }
    const [coreTransport, clientTransport] = createMemoryTransportPair();
    host = new CoreHost({ dataDir: services.paths.home, services, transport: coreTransport });
    for (const register of domainRegistrars) register(host, services);
    const invokeCore = (method, ...params) =>
      host.dispatch({ jsonrpc: '2.0', id: `${Date.now()}-${Math.random()}`, method, params });
    for (const limits of services.catalog.providers) {
      const saved = services.providers.get(limits.provider);
      const hasEnvKey = secrets.some(
        ([name]) =>
          name
            .slice(0, -'_API_KEY'.length)
            .toLowerCase()
            .replaceAll('_', '-')
            .replace(/^opencode-zen$/, 'opencode') === limits.provider,
      );
      if ((hasEnvKey || services.providerKeys.get(limits.provider)) && (!saved || !saved.enabled))
        await invokeCore('providers.setEnabled', limits.provider, true);
    }
    await host.start();
    rpc = createRpcFerryClient(clientTransport, { timeoutMs: 15_000 });
    await rpc.hello;
    // The picker reads cached models immediately; an eval preflight must await discovery.
    const discovery = getModelDiscovery(host, services);
    await Promise.allSettled(
      services.catalog.providers
        .filter(({ provider }) => services.providers.get(provider)?.enabled)
        .map(({ provider }) => discovery.refreshIfStale(provider)),
    );

    const providerPolicies = await Promise.all(
      services.catalog.providers.map(async (limits) => {
        const saved = services.providers.get(limits.provider);
        const hasReference = Boolean(services.providerKeys.get(limits.provider));
        const keyPresent = hasReference && (await services.secrets.has(limits.provider));
        return {
          id: limits.provider,
          tag: limits.tag,
          keyRequired: limits.key_required !== false,
          keyPresent,
          keyStatus: keyPresent ? (saved?.keyStatus ?? 'unchecked') : 'missing',
          enabled: saved?.enabled ?? keyPresent,
          billingEnabled: saved?.billingEnabled ?? false,
          freeTierUnsupported: saved?.freeTierUnsupported ?? false,
          excludedModelRefs: saved?.excludedModelRefs ?? [],
        };
      }),
    );
    const validProviderIds = new Set(providerPolicies.map(({ id }) => id));
    const invalidSelections = [...options.include, ...options.exclude].filter(
      (id) => !validProviderIds.has(id),
    );
    if (invalidSelections.length)
      throw new Error(`Unknown provider id(s): ${[...new Set(invalidSelections)].join(', ')}`);
    const cachedModels = services.catalog.providers.flatMap(({ provider }) =>
      services.models.list(provider),
    );
    const selection = selectEvalProviders({
      providers: providerPolicies,
      models: cachedModels,
      profile: options.profile,
      include: options.include,
      exclude: options.exclude,
      model: options.model,
    });
    const selectedProviders = selection.providers;
    const modelCandidates = selection.models;
    const providerList = selectedProviders.map(({ id }) => id);
    const listText = `Eligible providers: ${providerList.join(', ') || 'none'}`;
    if (options.json) process.stderr.write(`${redactText(listText, secretValues)}\n`);
    else console.log(listText);
    if (modelCandidates.length === 0)
      throw new Error(
        'No enabled provider models match the selected profile and include/exclude options.',
      );
    const guard = budgetGuard(selectedProviders, { allowPaid: options.allowPaid });
    if (!guard.allowed)
      throw new Error(
        `Paid or credits provider(s) may be used (${guard.paid.join(', ')}). Re-run with --allow-paid to acknowledge.`,
      );
    const estimate = estimateProviderRequests(
      selectedProviders,
      scenarios.length * options.repeat,
      options.maxSteps,
    );
    const estimateText =
      estimate
        .map(
          ({ provider, estimatedRequests }) => `${provider}: up to ${estimatedRequests} requests`,
        )
        .join(', ') || 'no configured cached provider models';
    const estimateLine = `Estimated request usage: ${estimateText}`;
    if (options.json) process.stderr.write(`${redactText(estimateLine, secretValues)}\n`);
    else console.log(estimateLine);
    if (!options.yes) {
      const answer = await askToProceed(abortController.signal);
      if (!answer) return 2;
    }
    if (signalCode) return signalCode;

    if (options.verbose)
      process.stderr.write(
        redactText(
          `Starting ${scenarios.length * options.repeat} task(s); max steps ${options.maxSteps}.\n`,
          secretValues,
        ),
      );

    const report = await runHarness({
      scenarios,
      repeat: options.repeat,
      shouldStop: () => Boolean(signalCode),
      runScenario: (scenario) =>
        runScenario({
          scenario,
          services,
          client: rpc,
          options,
          secrets: secretValues,
          activeSessions,
          signalCode: () => signalCode,
          onSession: lifecycle.onSession,
          signal: abortController.signal,
        }),
    });
    const timestamp = new Date().toISOString();
    const outDir = join(process.cwd(), 'evals', 'results');
    await mkdir(outDir, { recursive: true });
    const jsonPath = join(outDir, `${timestamp.replaceAll(':', '-')}.json`);
    const markdownPath = jsonPath.replace(/\.json$/, '.md');
    const output = {
      timestamp,
      profile: options.profile,
      roles: options.roles ?? 'profile-default',
      model: options.model ?? null,
      dataDir: options.dataDir ? '[provided]' : '[temporary]',
      maxSteps: options.maxSteps,
      timeoutMs: options.timeoutMs,
      estimatedRequests: estimate,
      ...report,
    };
    const safeJson = redactText(JSON.stringify(output, null, 2), secretValues);
    const markdown = redactText(formatMarkdown(report), secretValues);
    await writeFile(jsonPath, `${safeJson}\n`, 'utf8');
    await writeFile(markdownPath, markdown, 'utf8');
    if (options.json) console.log(redactText(JSON.stringify(output), secretValues));
    else console.log(markdown);
    console.log(`Results: ${jsonPath}`);
    exitCode = signalCode ?? (report.passed === report.total ? 0 : 1);
    return exitCode;
  } finally {
    lifecycle.onShutdown?.(signalCode ?? exitCode);
    await cancelSessions();
    rpc?.close();
    try {
      await host?.stop();
    } finally {
      await services.dispose();
      memorySecrets.clear();
      if (tempData)
        await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      lifecycle.onCleanup?.();
    }
  }
}

async function runScenario({
  scenario,
  services,
  client,
  options,
  secrets,
  activeSessions,
  signalCode,
  onSession,
  signal,
}) {
  const fixture = await createFixtureRepo(scenario.template);
  const before = await snapshot(fixture.path);
  const profileName = options.profile === 'auto-free' ? 'Auto-Free' : 'Best Available';
  let savedProfile;
  let changedProfile = false;
  try {
    if (options.roles !== undefined) {
      savedProfile = (await client.profiles.list()).find((profile) => profile.name === profileName);
      if (!savedProfile) throw new Error(`Profile not found: ${profileName}`);
      const enabled = options.roles === 'on';
      if (savedProfile.roles.enabled !== enabled) {
        await client.profiles.save({ ...savedProfile, roles: { ...savedProfile.roles, enabled } });
        changedProfile = true;
      }
    }
    await mkdir(join(fixture.path, '.ferry'), { recursive: true });
    await writeFile(
      join(fixture.path, '.ferry', 'config.json'),
      JSON.stringify({ permissionMode: 'full_auto' }),
      'utf8',
    );
    if (options.model) {
      const model = services.models
        .list(options.model.slice(0, options.model.indexOf('/')))
        .find(({ ref }) => ref === options.model);
      if (!model)
        throw new Error(`Pinned model is not present in the copied model cache: ${options.model}`);
    }
    const usageBefore = await client.quota.history(1).catch(() => []);
    const driven = await driveEvalSession({
      client,
      prompt: scenario.prompt,
      cwd: fixture.path,
      profileName,
      modelRef: options.model,
      maxSteps: options.maxSteps,
      timeoutMs: options.timeoutMs,
      signal,
      verbose: options.verbose,
      logDirectory: services.paths.logs,
      secrets,
      onProgress: ({ kind, text, session }) => {
        if (kind === 'session') {
          activeSessions.add(session.id);
          onSession?.(session);
          if (signalCode()) void client.sessions.cancel(session.id).catch(() => undefined);
        }
        if (!options.verbose) return;
        const message =
          kind === 'session'
            ? `[${scenario.id}] session ${session.id}`
            : `[${scenario.id}] ${text}`;
        process.stderr.write(`${redactText(message, secrets)}\n`);
      },
      onSessionFinished: (finished) => activeSessions.delete(finished.id),
    });
    const { exitCode, detail } = driven;
    const session = detail.session;
    const messages = detail.messages ?? [];
    const assistantText = messages
      .filter(({ role }) => role === 'assistant')
      .flatMap(({ parts }) => parts.filter(({ type }) => type === 'text').map(({ text }) => text))
      .join('\n');
    const after = await snapshot(fixture.path);
    const passed = await verifyScenario(scenario.id, fixture.path, before, after, assistantText);
    const measurements = requestRows(services).filter(
      ({ session_id }) => session_id === session.id,
    );
    const quotaUsage = services.quota.queryUsage({ sessionId: session.id });
    const usageAfter = await client.quota.history(1).catch(() => []);
    const usageDelta = diffUsageHistory(usageBefore, usageAfter);
    const sessionTokensIn = quotaUsage.reduce((sum, usage) => sum + (usage.inputTokens ?? 0), 0);
    const sessionTokensOut = quotaUsage.reduce((sum, usage) => sum + (usage.outputTokens ?? 0), 0);
    const measured = accountRun({
      result: { sessionId: session.id, steps: detail.taskRecord?.steps?.length ?? 0 },
      measurements,
    });
    const taskRows = measurements;
    const handoffs = messages
      .flatMap(({ parts }) => parts.filter(({ type }) => type === 'handoff_marker'))
      .map(({ from, to, reason }) => `${from} -> ${to} (${reason})`);
    const providerErrors = taskRows.reduce((acc, row) => {
      if (row.error_kind) acc[row.error_kind] = (acc[row.error_kind] ?? 0) + 1;
      return acc;
    }, {});
    return {
      passed: passed && session.status !== 'error' && exitCode === 0,
      steps: new Set(taskRows.map(({ step_id }, index) => step_id ?? `row-${index}`)).size,
      models: [
        ...new Set([
          ...measured.models,
          ...messages.map(({ modelRef }) => modelRef).filter(Boolean),
        ]),
      ],
      tokensIn:
        sessionTokensIn ||
        taskRows.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0) ||
        usageDelta.inputTokens,
      tokensOut:
        sessionTokensOut ||
        taskRows.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0) ||
        usageDelta.outputTokens,
      providerErrors,
      toolCallRepairs: messages.filter(
        ({ role, parts }) =>
          role === 'user' &&
          parts.some(
            ({ type, text }) =>
              type === 'text' && /tool call was written as text|repair the text call/i.test(text),
          ),
      ).length,
      editsRefused: messages
        .flatMap(({ parts }) => parts)
        .filter(
          ({ type, status, tool }) =>
            type === 'tool_call' && status === 'denied' && /edit|write|create/i.test(tool),
        ).length,
      editsRetried: countEditRetries(messages),
      detail: passed
        ? ''
        : redactText(
            assistantText.slice(-400) || `session ended ${detail.session.status}`,
            secrets,
          ),
      handoffs,
    };
  } finally {
    try {
      if (changedProfile && savedProfile) await client.profiles.save(savedProfile);
    } finally {
      await fixture.cleanup();
    }
  }
}

function countEditRetries(messages) {
  const failedPaths = new Set();
  let retries = 0;
  for (const part of messages.flatMap(({ parts }) => parts)) {
    if (part.type !== 'tool_call' || !/edit|write|create/i.test(part.tool)) continue;
    const target = String(part.args.path ?? part.args.file_path ?? '');
    if (target && failedPaths.has(target)) retries += 1;
    if (target && part.status === 'failed') failedPaths.add(target);
    else if (target && part.status === 'succeeded') failedPaths.delete(target);
  }
  return retries;
}

function requestRows(services) {
  return services.db.client.prepare('SELECT * FROM requests ORDER BY ts').all();
}

async function snapshot(root, relative = '') {
  const entries = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name).replaceAll('\\', '/');
    if (
      name === '.git' ||
      name.startsWith('.git/') ||
      name === '.ferry' ||
      name.startsWith('.ferry/')
    )
      continue;
    if (entry.isDirectory()) entries.push(...(await snapshot(root, name)));
    else entries.push([name, (await readFile(join(root, name))).toString('utf8')]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

async function makeTempDir(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), prefix));
}

async function askToProceed(signal) {
  const { createInterface } = await import('node:readline/promises');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(?:es)?$/i.test(
      (await prompt.question('Proceed with this estimate? [y/N] ', { signal })).trim(),
    );
  } finally {
    prompt.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let fallback;
  const armFallback = (code) => {
    clearTimeout(fallback);
    fallback = setTimeout(() => process.exit(code), 5000);
    fallback.unref();
  };
  runEvalLive(process.argv.slice(2), {
    onSignal: armFallback,
    onShutdown: armFallback,
    onCleanup: () => clearTimeout(fallback),
  })
    .then((code) => {
      clearTimeout(fallback);
      process.exit(code);
    })
    .catch((error) => {
      clearTimeout(fallback);
      const message = error instanceof Error ? error.message : String(error);
      const lockMessage = /already running for data directory/i.test(message)
        ? `Another Ferry eval/core is already using this --data-dir. ${message}`
        : message;
      console.error(redactText(lockMessage, activeSecrets));
      process.exit(1);
    });
}
