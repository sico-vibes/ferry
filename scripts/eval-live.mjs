import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServices } from '../packages/core/src/services.ts';
import { CoreHost } from '../packages/core/src/host.ts';
import { domainRegistrars } from '../packages/core/src/domains/index.ts';
import { KeyringSecretStore, MemorySecretStore } from '../packages/secrets/src/index.ts';
import { AGENT_EVALS } from '../packages/agent/evals/fixtures.ts';
import { createFixtureRepo } from '../packages/testkit/src/fixture-repo.ts';
import {
  accountRun,
  budgetGuard,
  estimateProviderRequests,
  fileDigest,
  formatMarkdown,
  parseDotEnv,
  parseEvalArgs,
  redactText,
  runHarness,
} from './eval-live-lib.mjs';

const execFileAsync = promisify(execFile);
const usage = `Usage: pnpm eval:live [--data-dir PATH] [--profile auto-free|best-available]
  [--only id,id] [--repeat N] [--model provider/model] [--max-steps N]
  [--timeout SECONDS] [--allow-paid] [--yes] [--json]`;
let activeSecrets = [];

export async function runEvalLive(args = process.argv.slice(2)) {
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
      const saved = services.providers.get(providerId);
      if (saved) services.providers.put({ ...saved, enabled: true });
    }
    host = new CoreHost({ dataDir: services.paths.home, services });
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
      if (
        hasEnvKey ||
        (!saved && (limits.key_required === false || services.providerKeys.get(limits.provider)))
      )
        await invokeCore('providers.setEnabled', limits.provider, true);
    }
    await host.start();
    await invokeCore('models.list');

    const eligibleProviders = [];
    for (const limits of services.catalog.providers) {
      const keyAvailable =
        Boolean(services.providerKeys.get(limits.provider)) || limits.key_required === false;
      if (
        keyAvailable &&
        (limits.key_required === false || (await services.secrets.has(limits.provider)))
      )
        eligibleProviders.push(limits.provider);
    }
    const availableModels = eligibleProviders.flatMap((provider) => services.models.list(provider));
    const modelCandidates = options.model
      ? availableModels.filter(({ ref }) => ref === options.model)
      : availableModels.filter((model) => options.profile !== 'auto-free' || model.free);
    const providerIds = new Set(modelCandidates.map(({ providerId }) => providerId));
    const selectedProviders = services.catalog.providers
      .filter(({ provider }) => providerIds.has(provider))
      .map((limits) => {
        const saved = services.providers.get(limits.provider);
        return {
          id: limits.provider,
          tag: limits.tag,
          billingEnabled:
            (saved?.billingEnabled ?? false) ||
            modelCandidates.some((model) => model.providerId === limits.provider && !model.free),
        };
      });
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
      const answer = await askToProceed();
      if (!answer) return 2;
    }

    const report = await runHarness({
      scenarios,
      repeat: options.repeat,
      runScenario: (scenario) =>
        runScenario({ scenario, services, host, options, secrets: secretValues }),
    });
    const timestamp = new Date().toISOString();
    const outDir = join(process.cwd(), 'evals', 'results');
    await mkdir(outDir, { recursive: true });
    const jsonPath = join(outDir, `${timestamp.replaceAll(':', '-')}.json`);
    const markdownPath = jsonPath.replace(/\.json$/, '.md');
    const output = {
      timestamp,
      profile: options.profile,
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
    return report.passed === report.total ? 0 : 1;
  } finally {
    await host?.stop();
    if (!host) await services.dispose();
    memorySecrets.clear();
    if (tempData)
      await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

async function runScenario({ scenario, services, host, options, secrets }) {
  const fixture = await createFixtureRepo(scenario.template);
  const before = await snapshot(fixture.path);
  const profileId =
    options.profile === 'auto-free'
      ? 'profile_builtin_auto_free'
      : 'profile_builtin_best_available';
  const invoke = (method, ...params) =>
    host.dispatch({ jsonrpc: '2.0', id: `${Date.now()}-${Math.random()}`, method, params });
  try {
    await mkdir(join(fixture.path, '.ferry'), { recursive: true });
    await writeFile(
      join(fixture.path, '.ferry', 'config.json'),
      JSON.stringify({ permissionMode: 'full_auto' }),
      'utf8',
    );
    const workspace = await invoke('workspaces.open', fixture.path);
    const session = await invoke('sessions.create', {
      workspaceId: workspace.id,
      profileId,
      title: scenario.title,
    });
    if (options.model) {
      const model = services.models
        .list(options.model.slice(0, options.model.indexOf('/')))
        .find(({ ref }) => ref === options.model);
      if (!model)
        throw new Error(`Pinned model is not present in the copied model cache: ${options.model}`);
      services.sessions.put({ ...session, pinnedModelRef: model.ref });
    }
    await invoke('sessions.send', session.id, {
      text: scenario.prompt,
      maxSteps: options.maxSteps,
    });
    const end = Date.now() + options.timeoutMs;
    let detail;
    let observedRunning = false;
    while (Date.now() < end) {
      detail = await invoke('sessions.get', session.id);
      if (detail.session.status === 'running') observedRunning = true;
      const hasAssistantReply = detail.messages.some(({ role }) => role === 'assistant');
      if (
        !['running', 'awaiting_approval'].includes(detail.session.status) &&
        (observedRunning || hasAssistantReply)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (
      !detail ||
      detail.session.status === 'running' ||
      detail.session.status === 'awaiting_approval'
    ) {
      await invoke('sessions.cancel', session.id).catch(() => {});
      throw new Error(`Task timed out after ${options.timeoutMs}ms`);
    }
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
      passed: passed && detail.session.status !== 'error',
      steps: new Set(taskRows.map(({ step_id }, index) => step_id ?? `row-${index}`)).size,
      models: [
        ...new Set([
          ...measured.models,
          ...messages.map(({ modelRef }) => modelRef).filter(Boolean),
        ]),
      ],
      tokensIn: taskRows.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0),
      tokensOut: taskRows.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0),
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
    await fixture.cleanup();
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

async function verifyScenario(id, root, before, after, explanation) {
  const read = (relative) => readFile(join(root, relative), 'utf8').catch(() => '');
  if (id === 'fix-failing-test') return runNodeTest(root);
  if (id === 'add-function-test') {
    const [source, test] = await Promise.all([read('index.js'), read('test.js')]);
    return (
      /function\s+double|const\s+double|double\s*=/.test(source) &&
      /double/.test(test) &&
      (await runNodeTest(root))
    );
  }
  if (id === 'rename-symbol') {
    const [source, test] = await Promise.all([read('index.js'), read('test.js')]);
    return (
      /\bresult\b/.test(source) &&
      /\bresult\b/.test(test) &&
      !/\banswer\b/.test(`${source}\n${test}`)
    );
  }
  if (id === 'read-explain')
    return (
      fileDigest(before) === fileDigest(after) &&
      /intentional|assertion|test\.js/i.test(explanation)
    );
  if (id === 'diagnose-build')
    return (
      fileDigest(before) === fileDigest(after) &&
      /intentional|assertion|test\.js/i.test(explanation)
    );
  if (id === 'crlf-edit') {
    const bytes = await readFile(join(root, 'README.md')).catch(() => Buffer.alloc(0));
    const text = bytes.toString('utf8');
    return text.includes('CRLF fixture\r\nupdated\r\n') && !/(?<!\r)\n/.test(text);
  }
  if (id === 'large-targeted-edit') {
    const old = before.find(([name]) => name === 'large.txt')?.[1] ?? '';
    const current = await readFile(join(root, 'large.txt'), 'utf8').catch(() => '');
    const oldLines = String(old).split('\n');
    const newLines = current.split('\n');
    return (
      newLines[49999] === 'updated' &&
      oldLines.length === newLines.length &&
      oldLines.filter((line, index) => line !== newLines[index]).length === 1 &&
      fileDigest(before.filter(([name]) => name !== 'large.txt')) ===
        fileDigest(after.filter(([name]) => name !== 'large.txt'))
    );
  }
  if (id === 'multi-file-refactor') {
    const [newModule, a, b] = await Promise.all([
      read('packages/a/src/answer.js'),
      read('packages/a/src/index.js'),
      read('packages/b/src/index.js'),
    ]);
    return (
      /export\s+const\s+answer\s*=\s*42/.test(newModule) &&
      !/export\s+const\s+answer/.test(a) &&
      /answer\.js/.test(a) &&
      /answer/.test(b) &&
      (await runNodeTest(root))
    );
  }
  return false;
}

async function runNodeTest(root) {
  try {
    await execFileAsync(process.execPath, ['test.js'], { cwd: root, timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
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

async function askToProceed() {
  const { createInterface } = await import('node:readline/promises');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(?:es)?$/i.test((await prompt.question('Proceed with this estimate? [y/N] ')).trim());
  } finally {
    prompt.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runEvalLive()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(redactText(message, activeSecrets));
      process.exitCode = 1;
    });
}
