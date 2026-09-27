import { createHash } from 'node:crypto';

export function parseEvalArgs(args) {
  const options = {
    profile: 'auto-free',
    only: [],
    include: [],
    exclude: [],
    repeat: 1,
    model: undefined,
    json: false,
    verbose: false,
    allowPaid: false,
    yes: false,
    dataDir: undefined,
    maxSteps: 25,
    timeoutMs: 10 * 60 * 1000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    const value = () => {
      const next = args[++index];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      return next;
    };
    if (arg === '--profile') options.profile = value();
    else if (arg === '--only') options.only = value().split(',').filter(Boolean);
    else if (arg === '--include') options.include = value().split(',').filter(Boolean);
    else if (arg === '--exclude') options.exclude = value().split(',').filter(Boolean);
    else if (arg === '--repeat') options.repeat = positiveInteger(value(), '--repeat');
    else if (arg === '--model') options.model = value();
    else if (arg === '--data-dir') options.dataDir = value();
    else if (arg === '--max-steps') options.maxSteps = positiveInteger(value(), '--max-steps');
    else if (arg === '--timeout') options.timeoutMs = positiveInteger(value(), '--timeout') * 1000;
    else if (arg === '--json') options.json = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--allow-paid') options.allowPaid = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!['auto-free', 'best-available'].includes(options.profile))
    throw new Error('--profile must be auto-free or best-available');
  if (options.repeat > 100) throw new Error('--repeat must be 100 or less');
  return options;
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`${flag} must be a positive integer`);
  return number;
}

export function parseDotEnv(text) {
  const entries = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    entries[match[1]] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return entries;
}

export function redactText(value, secrets) {
  return [...new Set(secrets.filter(Boolean))]
    .reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), String(value))
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]');
}

export function budgetGuard(providers, { allowPaid = false } = {}) {
  const paid = providers.filter(
    (provider) =>
      provider.tag === 'paid' || provider.tag === 'credits' || provider.billingEnabled === true,
  );
  return { allowed: allowPaid || paid.length === 0, paid: paid.map(({ id }) => id) };
}

/** Selects the cached models the live runner could actually route to. */
export function selectEvalProviders({
  providers,
  models,
  profile = 'auto-free',
  include = [],
  exclude = [],
  model,
}) {
  const explicitlyIncluded = new Set(include);
  const explicitlyExcluded = new Set(exclude);
  const candidates = [];
  for (const provider of providers) {
    const hasCredential = provider.keyPresent || provider.keyRequired === false;
    if (provider.enabled !== true || !hasCredential || provider.keyStatus === 'invalid') continue;
    if (explicitlyExcluded.has(provider.id)) continue;
    if (explicitlyIncluded.size > 0 && !explicitlyIncluded.has(provider.id)) continue;

    const providerModels = models.filter(
      (candidate) =>
        candidate.providerId === provider.id &&
        (!model || candidate.ref === model) &&
        !(provider.excludedModelRefs ?? []).includes(candidate.ref),
    );
    const eligibleModels =
      profile === 'auto-free'
        ? providerModels.filter((candidate) =>
            isAutoFreeEligible(provider, candidate, explicitlyIncluded.has(provider.id)),
          )
        : providerModels;
    if (eligibleModels.length) candidates.push({ provider, models: eligibleModels });
  }
  return {
    providers: candidates.map(({ provider }) => provider),
    models: candidates.flatMap(({ models: providerModels }) => providerModels),
  };
}

function isAutoFreeEligible(provider, model, trialOptedIn) {
  if (
    provider.freeTierUnsupported ||
    provider.billingEnabled ||
    provider.id === 'opencode' ||
    provider.tag === 'paid' ||
    provider.tag === 'credits' ||
    provider.tag.startsWith('subscription_')
  )
    return false;
  if (provider.tag === 'trial' && !trialOptedIn) return false;
  if (provider.id === 'openrouter') return /:free(?:$|:)/i.test(model.ref);
  if (provider.keyRequired === false) return true;
  if (['legit', 'promo'].includes(provider.tag)) return true;
  return model.free;
}

export function estimateProviderRequests(providers, taskCount, maxSteps) {
  return providers.map(({ id }) => ({ provider: id, estimatedRequests: taskCount * maxSteps }));
}

export function accountRun({ result, measurements = [] }) {
  const relevant = measurements.filter(
    (row) => (row.sessionId ?? row.session_id) === result.sessionId,
  );
  return {
    steps: result.steps ?? 0,
    models: [...new Set(relevant.map((row) => row.model).filter(Boolean))],
    tokensIn: relevant.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0),
    tokensOut: relevant.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0),
    providerErrors: relevant.reduce((counts, row) => {
      if (row.error_kind) counts[row.error_kind] = (counts[row.error_kind] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

export async function runHarness({ scenarios, repeat = 1, runScenario }) {
  const results = [];
  for (let repetition = 1; repetition <= repeat; repetition += 1) {
    for (const scenario of scenarios) {
      const startedAt = Date.now();
      try {
        const outcome = await runScenario(scenario);
        results.push({
          id: scenario.id,
          repetition,
          passed: Boolean(outcome.passed),
          steps: outcome.steps ?? 0,
          wallTimeMs: Date.now() - startedAt,
          models: outcome.models ?? [],
          tokensIn: outcome.tokensIn ?? 0,
          tokensOut: outcome.tokensOut ?? 0,
          providerErrors: outcome.providerErrors ?? {},
          handoffs: outcome.handoffs ?? [],
          toolCallRepairs: outcome.toolCallRepairs ?? 0,
          editsRefused: outcome.editsRefused ?? 0,
          editsRetried: outcome.editsRetried ?? 0,
          detail: outcome.detail ?? '',
        });
      } catch (error) {
        results.push({
          id: scenario.id,
          repetition,
          passed: false,
          steps: 0,
          wallTimeMs: Date.now() - startedAt,
          models: [],
          tokensIn: 0,
          tokensOut: 0,
          providerErrors: {},
          handoffs: [],
          toolCallRepairs: 0,
          editsRefused: 0,
          editsRetried: 0,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { results, passed: results.filter(({ passed }) => passed).length, total: results.length };
}

export function fileDigest(entries) {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function formatMarkdown(report) {
  const lines = [
    '# Ferry live evaluation',
    '',
    `Passed **${report.passed}/${report.total}** tasks.`,
    '',
    '| Scenario | Run | Result | Steps | Time | Models / handoffs | Tokens in/out | Provider errors | Repairs | Refused | Retried |',
    '| --- | ---: | --- | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: |',
  ];
  for (const row of report.results) {
    lines.push(
      `| ${row.id} | ${row.repetition} | ${row.passed ? 'PASS' : 'FAIL'} | ${row.steps} | ${(row.wallTimeMs / 1000).toFixed(1)}s | ${row.models.join(', ') || '—'}${row.handoffs.length ? `; ${row.handoffs.join(', ')}` : ''} | ${row.tokensIn}/${row.tokensOut} | ${JSON.stringify(row.providerErrors)} | ${row.toolCallRepairs} | ${row.editsRefused} | ${row.editsRetried} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}
