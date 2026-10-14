import { execa } from 'execa';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type CliAuthState,
  type CliConnection,
  type CliConnectionKind,
  type CliBilling,
  type CliEffort,
  type CliModelCapabilities,
  type CliUsageSnapshot,
  type CliUsageWindow,
  type ModelRef,
} from '@ferry/shared';
import { commandInvocation, detectCli } from '../index.js';
import { CodexAppServer } from './codex-app-server.js';
import { ClaudeControlClient } from './claude-control.js';
import { deriveCliAccountKey } from './account-key.js';
import {
  parseClaudeAuthStatus,
  parseOpencodeAuthStore,
  parseOpencodeModelsVerbose,
  type ClaudeAuthStatus,
} from './parse.js';

export interface CliDiscoveryOptions {
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  signal?: AbortSignal;
  /** Explicit executable seam for offline fixtures. */
  executable?: string;
  executableArgs?: string[];
  /** Version string to report when an explicit executable seam is used. */
  version?: string;
  timeoutMs?: number;
}

interface DiscoveryRuntime {
  environment: NodeJS.ProcessEnv;
  now: () => Date;
  signal?: AbortSignal;
  timeoutMs: number;
}

/** Authoritative account evidence observed by a probe, kept separate from the usage snapshot. */
export interface CliAccountProbe {
  state: CliAuthState;
  key: string | null;
  label: string | null;
  plan: string | null;
}

/**
 * Result of a usage-only refresh. `account` is the authoritative identity when the probe could read
 * it, or `null` when the probe was unavailable/errored and therefore cannot vouch for a logout.
 */
export interface CliUsageRefresh {
  usage: CliUsageSnapshot;
  account: CliAccountProbe | null;
}

const installHints: Record<CliConnectionKind, string> = {
  'codex-cli': 'Install the Codex CLI, then run codex login to sign in.',
  'claude-code-cli': 'Install Claude Code, then run claude auth login to sign in.',
  'opencode-cli': 'Install OpenCode, then run opencode auth login for your chosen provider.',
};

const upstreamLabels: Record<CliConnectionKind, string> = {
  'codex-cli': 'ChatGPT',
  'claude-code-cli': 'Claude',
  'opencode-cli': 'OpenCode Zen',
};

function runtime(options: CliDiscoveryOptions): DiscoveryRuntime {
  return {
    environment: options.environment ?? process.env,
    now: options.now ?? (() => new Date()),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.timeoutMs ?? 20_000,
  };
}

function emptyUsage(connectionId: CliConnectionKind, note: string): CliUsageSnapshot {
  return {
    connectionId,
    accountKey: null,
    state: 'unavailable',
    source: 'cli',
    observedAt: null,
    staleAt: null,
    windows: [],
    note,
  };
}

function baseConnection(
  kind: CliConnectionKind,
  install: CliConnection['install'],
  discoveryMessage: string | null,
): CliConnection {
  return {
    id: kind,
    kind,
    providerId: kind,
    upstreamLabel: upstreamLabels[kind],
    install,
    account: { state: 'not_checked', key: null, label: null, plan: null },
    verify: { state: 'unverified', modelRef: null, checkedAt: null, message: null },
    surfaces: { native: false, gateway: false },
    models: [],
    usage: emptyUsage(kind, 'Usage is unavailable until a model is visible and used.'),
    lastChecked: null,
    discoveryMessage,
  };
}

function notInstalled(kind: CliConnectionKind, version: string | null): CliConnection {
  return baseConnection(
    kind,
    { installed: false, executable: null, version, installHint: installHints[kind] },
    `The ${kind} CLI is not installed. ${installHints[kind]}`,
  );
}

const cliEffortToken = /^[a-z][a-z0-9_-]{0,31}$/;

/** Preserve a CLI-reported effort token verbatim; only reject malformed tokens. */
function validEffort(value: unknown): CliEffort | null {
  return typeof value === 'string' && cliEffortToken.test(value) ? value : null;
}

function uniqueEfforts(values: unknown[]): CliEffort[] {
  const seen = new Set<CliEffort>();
  for (const value of values) {
    const effort = validEffort(value);
    if (effort) seen.add(effort);
  }
  return [...seen];
}

async function runCommand(
  executable: string,
  args: string[],
  context: DiscoveryRuntime,
): Promise<{ stdout: string; failed: boolean }> {
  const invocation = commandInvocation(executable, args);
  const result = await execa(invocation.file, invocation.args, {
    env: context.environment,
    extendEnv: false,
    reject: false,
    windowsHide: true,
    timeout: context.timeoutMs,
    ...(context.signal ? { cancelSignal: context.signal } : {}),
    ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  return { stdout: result.stdout, failed: result.failed };
}

async function resolveInstall(
  kind: CliConnectionKind,
  options: CliDiscoveryOptions,
): Promise<{ installed: boolean; executable: string | null; version: string | null }> {
  if (options.executable) {
    return { installed: true, executable: options.executable, version: options.version ?? null };
  }
  const detection = await detectCli(kind.replace(/-cli$/, '') as 'codex' | 'claude' | 'opencode', {
    checkAuth: false,
    ...(options.environment ? { environment: options.environment } : {}),
  });
  return {
    installed: detection.available,
    executable: detection.available ? detection.executable : null,
    version: detection.version,
  };
}

/* ------------------------------- Codex ---------------------------------- */

const codexModelSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    hidden: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    inputModalities: z.array(z.string()).optional(),
    defaultReasoningEffort: z.string().optional(),
    supportedReasoningEfforts: z
      .array(z.object({ reasoningEffort: z.string(), description: z.string().optional() }))
      .optional(),
    serviceTiers: z
      .array(
        z.object({
          id: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
        }),
      )
      .optional(),
  })
  .loose();

const codexModelListSchema = z.object({
  data: z.array(codexModelSchema),
  nextCursor: z.string().nullable().optional(),
});

const codexAccountSchema = z
  .object({
    account: z
      .union([
        z.object({
          type: z.literal('chatgpt'),
          email: z.string().nullable().optional(),
          planType: z.string().optional(),
        }),
        z.object({ type: z.literal('apiKey') }),
        z.object({ type: z.literal('amazonBedrock') }).loose(),
        z.null(),
      ])
      .optional(),
    requiresOpenaiAuth: z.boolean().optional(),
    workspaceRouting: z.object({ chatgptAccountId: z.string().optional() }).nullable().optional(),
  })
  .loose();

const codexRateLimitWindowSchema = z.object({
  usedPercent: z.number(),
  resetsAt: z.number().nullable().optional(),
  windowDurationMins: z.number().nullable().optional(),
});

const codexRateLimitBucketSchema = z
  .object({
    limitId: z.string().nullable().optional(),
    limitName: z.string().nullable().optional(),
    primary: codexRateLimitWindowSchema.nullable().optional(),
    secondary: codexRateLimitWindowSchema.nullable().optional(),
    planType: z.string().nullable().optional(),
    spendControlReached: z.boolean().nullable().optional(),
  })
  .loose();

const codexRateLimitsSchema = z
  .object({
    accountId: z.string().nullable().optional(),
    ordinaryUsageAllowed: z.boolean().nullable().optional(),
    rateLimits: codexRateLimitBucketSchema.nullable().optional(),
    rateLimitsByLimitId: z.record(z.string(), codexRateLimitBucketSchema).nullable().optional(),
  })
  .loose();

function codexWindowKind(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return 'rolling';
  if (minutes <= 300) return 'five_hour';
  if (minutes <= 10_080) return 'seven_day';
  return 'monthly';
}

function codexWindow(
  id: string,
  label: string,
  window: z.infer<typeof codexRateLimitWindowSchema>,
): CliUsageWindow {
  const used = window.usedPercent;
  return {
    id,
    label,
    metric: 'percent',
    windowKind: codexWindowKind(window.windowDurationMins),
    used,
    limit: 100,
    remaining: Math.max(0, 100 - used),
    utilization: used / 100,
    resetAt:
      typeof window.resetsAt === 'number' ? new Date(window.resetsAt * 1000).toISOString() : null,
  };
}

/** Prefer the multi-bucket `rateLimitsByLimitId` view; fall back to the legacy single bucket. */
function codexUsageWindows(limits: z.infer<typeof codexRateLimitsSchema>): CliUsageWindow[] {
  const buckets: { key: string; bucket: z.infer<typeof codexRateLimitBucketSchema> }[] = [];
  const byId = limits.rateLimitsByLimitId;
  if (byId && Object.keys(byId).length > 0)
    for (const [key, bucket] of Object.entries(byId)) buckets.push({ key, bucket });
  else if (limits.rateLimits)
    buckets.push({ key: limits.rateLimits.limitId ?? 'codex', bucket: limits.rateLimits });
  const windows: CliUsageWindow[] = [];
  for (const { key, bucket } of buckets) {
    const label = bucket.limitName ?? bucket.limitId ?? key;
    if (bucket.primary) windows.push(codexWindow(`${key}:primary`, label, bucket.primary));
    if (bucket.secondary) windows.push(codexWindow(`${key}:secondary`, label, bucket.secondary));
  }
  return windows;
}

function codexSpendControlReached(limits: z.infer<typeof codexRateLimitsSchema>): boolean {
  const byId = limits.rateLimitsByLimitId;
  if (byId)
    for (const bucket of Object.values(byId)) if (bucket.spendControlReached === true) return true;
  return limits.rateLimits?.spendControlReached === true;
}

function codexUsageFromLimits(
  kind: CliConnectionKind,
  limits: z.infer<typeof codexRateLimitsSchema>,
  identity: string | null,
  context: DiscoveryRuntime,
): CliUsageSnapshot {
  const windows = codexUsageWindows(limits);
  if (windows.length === 0) return emptyUsage(kind, 'Codex reported no active rate-limit windows.');
  return {
    connectionId: kind,
    accountKey: deriveCliAccountKey(kind, identity),
    state: 'available',
    source: 'codex app-server account/rateLimits/read',
    observedAt: context.now().toISOString(),
    staleAt: null,
    windows,
    note: codexSpendControlReached(limits) ? 'Spend control has been reached.' : null,
  };
}

function codexBilling(planType: string | null | undefined, accountType: string): CliBilling {
  if (accountType === 'apiKey') return 'metered';
  if (planType && planType !== 'free' && planType !== 'unknown') return 'included_subscription';
  return 'unknown';
}

function codexIdentity(raw: z.infer<typeof codexAccountSchema>): string | null {
  const account = raw.account ?? null;
  return account?.type === 'chatgpt'
    ? (account.email ?? raw.workspaceRouting?.chatgptAccountId ?? null)
    : null;
}

function codexAccountProbe(raw: z.infer<typeof codexAccountSchema>): CliAccountProbe {
  const account = raw.account ?? null;
  return {
    state: account ? 'signed_in' : raw.requiresOpenaiAuth ? 'signed_out' : 'unknown',
    key: deriveCliAccountKey('codex-cli', codexIdentity(raw)),
    label:
      account?.type === 'chatgpt'
        ? (account.email ?? null)
        : account?.type === 'apiKey'
          ? 'API key'
          : null,
    plan: account?.type === 'chatgpt' ? (account.planType ?? null) : null,
  };
}

function codexCapabilities(
  kind: CliConnectionKind,
  model: z.infer<typeof codexModelSchema>,
  billing: CliBilling,
): CliModelCapabilities | null {
  const upstreamId = model.model ?? model.id;
  if (!upstreamId) return null;
  const efforts = uniqueEfforts(
    (model.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort),
  );
  const requestedDefault = validEffort(model.defaultReasoningEffort);
  const defaultEffort =
    requestedDefault && efforts.includes(requestedDefault) ? requestedDefault : null;
  const fast = (model.serviceTiers ?? []).some((tier) =>
    /fast|priority/i.test(`${tier.id} ${tier.name ?? ''}`),
  );
  return {
    ref: `${kind}/${upstreamId}` as ModelRef,
    connectionId: kind,
    providerId: kind,
    upstreamId,
    upstreamProvider: null,
    name: model.displayName ?? upstreamId,
    efforts,
    defaultEffort,
    speeds: fast ? ['standard', 'fast'] : ['standard'],
    defaultSpeed: 'standard',
    modalities: ['text'],
    toolCalling: true,
    billing,
    hidden: false,
  };
}

async function discoverCodex(
  options: CliDiscoveryOptions,
  context: DiscoveryRuntime,
): Promise<CliConnection> {
  const kind: CliConnectionKind = 'codex-cli';
  const install = await resolveInstall(kind, options);
  if (!install.installed || !install.executable) return notInstalled(kind, install.version);
  const server = new CodexAppServer({
    executable: install.executable,
    ...(options.executableArgs ? { args: options.executableArgs } : {}),
    environment: context.environment,
    timeoutMs: context.timeoutMs,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  try {
    await server.request('initialize', {
      clientInfo: { name: 'Ferry', version: '0.9.0' },
      capabilities: { experimentalApi: true },
    });
    server.notify('initialized');
    const models: CliModelCapabilities[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const listed = codexModelListSchema.parse(
        await server.request('model/list', { limit: 100, cursor, includeHidden: false }),
      );
      for (const model of listed.data) {
        const capability = codexCapabilities(kind, model, 'unknown');
        if (capability) models.push(capability);
      }
      cursor = listed.nextCursor ?? null;
      if (!cursor) break;
    }
    const accountRaw = codexAccountSchema.parse(await server.request('account/read', {}));
    const account = codexAccountProbe(accountRaw);
    const accountType = accountRaw.account?.type ?? 'none';
    const billing = codexBilling(account.plan, accountType);
    const withBilling = models.map((model) => ({ ...model, billing }));
    let usage = emptyUsage(kind, 'Account limits are unavailable for this CLI version.');
    try {
      const limits = codexRateLimitsSchema.parse(
        await server.request('account/rateLimits/read', null),
      );
      usage = codexUsageFromLimits(
        kind,
        limits,
        limits.accountId ?? codexIdentity(accountRaw),
        context,
      );
    } catch {
      usage = emptyUsage(kind, 'Codex rate limits are unavailable on this account.');
    }
    return {
      id: kind,
      kind,
      providerId: kind,
      upstreamLabel: upstreamLabels[kind],
      install: {
        installed: true,
        executable: install.executable,
        version: install.version,
        installHint: installHints[kind],
      },
      account,
      verify: { state: 'unverified', modelRef: null, checkedAt: null, message: null },
      surfaces: { native: false, gateway: false },
      models: withBilling,
      usage,
      lastChecked: context.now().toISOString(),
      discoveryMessage:
        withBilling.length === 0 ? 'Codex reported no available models for this account.' : null,
    };
  } finally {
    await server.close();
  }
}

/* ------------------------------- Claude --------------------------------- */

const claudeModelSchema = z
  .object({
    value: z.string().optional(),
    resolvedModel: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    supportsEffort: z.boolean().optional(),
    supportedEffortLevels: z.array(z.string()).optional(),
    supportsFastMode: z.boolean().optional(),
  })
  .loose();

const claudeInitializeSchema = z
  .object({
    models: z.array(claudeModelSchema).optional(),
    account: z
      .object({
        email: z.string().nullable().optional(),
        organization: z.string().nullable().optional(),
        subscriptionType: z.string().nullable().optional(),
        apiProvider: z.string().nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
    claude_code_version: z.string().optional(),
  })
  .loose();

const claudeUsageSchema = z
  .object({
    subscription_type: z.string().nullable().optional(),
    rate_limits_available: z.boolean().optional(),
    rate_limits: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .loose();

function claudeCapabilities(
  kind: CliConnectionKind,
  model: z.infer<typeof claudeModelSchema>,
): CliModelCapabilities | null {
  const upstreamId = model.resolvedModel ?? model.value;
  if (!upstreamId) return null;
  const efforts = model.supportsEffort ? uniqueEfforts(model.supportedEffortLevels ?? []) : [];
  const fast = model.supportsFastMode === true;
  return {
    ref: `${kind}/${upstreamId}` as ModelRef,
    connectionId: kind,
    providerId: kind,
    upstreamId,
    upstreamProvider: null,
    name: model.displayName ?? upstreamId,
    efforts,
    defaultEffort: null,
    speeds: fast ? ['standard', 'fast'] : ['standard'],
    defaultSpeed: 'standard',
    modalities: ['text'],
    toolCalling: true,
    billing: 'unknown',
    hidden: false,
  };
}

function claudeModels(
  kind: CliConnectionKind,
  raw: z.infer<typeof claudeModelSchema>[],
): CliModelCapabilities[] {
  const byRef = new Map<string, { capability: CliModelCapabilities; value: string | undefined }>();
  for (const model of raw) {
    const capability = claudeCapabilities(kind, model);
    if (!capability) continue;
    const existing = byRef.get(capability.ref);
    // Prefer a concrete selector over the `default` alias when both resolve to the same model.
    if (!existing || (existing.value === 'default' && model.value !== 'default'))
      byRef.set(capability.ref, { capability, value: model.value });
  }
  return [...byRef.values()].map((entry) => entry.capability);
}

function claudeUsageWindows(
  rateLimits: Record<string, unknown> | null | undefined,
): CliUsageWindow[] {
  if (!rateLimits) return [];
  const windows: CliUsageWindow[] = [];
  for (const [key, value] of Object.entries(rateLimits)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as { utilization?: unknown; resets_at?: unknown };
    if (typeof entry.utilization !== 'number') continue;
    const used = entry.utilization;
    windows.push({
      id: key,
      label: key,
      metric: 'percent',
      windowKind: key === 'five_hour' ? 'five_hour' : key === 'seven_day' ? 'seven_day' : 'scoped',
      used,
      limit: 100,
      remaining: Math.max(0, 100 - used),
      utilization: used / 100,
      // Claude reports `resets_at` with a `+00:00` offset; normalize to the shared ISO `Z` form.
      resetAt:
        typeof entry.resets_at === 'string' && !Number.isNaN(Date.parse(entry.resets_at))
          ? new Date(entry.resets_at).toISOString()
          : null,
    });
  }
  return windows;
}

/** Read the bounded local `claude auth status --json`; never touches credentials or generates. */
async function readClaudeAuthStatus(
  executable: string,
  baseArgs: string[],
  context: DiscoveryRuntime,
): Promise<ClaudeAuthStatus | null> {
  const result = await runCommand(
    executable,
    [...baseArgs, 'auth', 'status', '--json'],
    context,
  ).catch(() => null);
  return result ? parseClaudeAuthStatus(result.stdout) : null;
}

/**
 * Derive the Claude account from structured-control initialization plus authoritative auth status.
 *
 * A successful `initialize` is discovery, not authentication: only `loggedIn === true` or genuine
 * account fields make the connection signed in. An authoritative `loggedIn === false` is a real
 * logout regardless of a successful initialize or cached email. Returns `null` only when neither
 * the control probe nor auth status produced any evidence (so an errored probe never clears a known
 * account). Identity hashes user + organization + effective auth source, never organization alone.
 */
function claudeAccountProbe(
  init: z.infer<typeof claudeInitializeSchema> | null,
  status: ClaudeAuthStatus | null,
): CliAccountProbe | null {
  if (!init && !status) return null;
  if (status && !status.loggedIn)
    return { state: 'signed_out', key: null, label: null, plan: null };
  const account = init?.account ?? null;
  const email = account?.email ?? status?.email ?? null;
  const organization = account?.organization ?? status?.orgName ?? status?.orgId ?? null;
  const subscriptionType = account?.subscriptionType ?? status?.subscriptionType ?? null;
  const authMethod = status?.authMethod ?? null;
  const apiProvider = account?.apiProvider ?? status?.apiProvider ?? null;
  const apiKeySource = status?.apiKeySource ?? null;
  const hasAccountEvidence = Boolean(
    account?.email ?? account?.organization ?? account?.subscriptionType ?? account?.apiProvider,
  );
  const state: CliAuthState = status ? 'signed_in' : hasAccountEvidence ? 'signed_in' : 'unknown';
  const source = authMethod ?? apiProvider ?? apiKeySource ?? '';
  const identity = [email, organization, source].filter(Boolean).join('|');
  return {
    state,
    key: identity ? deriveCliAccountKey('claude-code-cli', identity) : null,
    label: email,
    plan: subscriptionType,
  };
}

/**
 * Billing classification: `included_subscription` only for proven native subscription auth
 * (`claude.ai` + `firstParty` + known subscription). API-key/console/cloud-provider sources are
 * `metered` even when stale subscription metadata is present; otherwise `unknown`. This never
 * asserts token prices or authorizes spend.
 */
function claudeBilling(
  init: z.infer<typeof claudeInitializeSchema> | null,
  status: ClaudeAuthStatus | null,
): CliBilling {
  const account = init?.account ?? null;
  const authMethod = (status?.authMethod ?? '').toLowerCase() || null;
  const apiProvider = (account?.apiProvider ?? status?.apiProvider ?? '').toLowerCase() || null;
  const apiKeySource = status?.apiKeySource ?? null;
  const subscriptionType = account?.subscriptionType ?? status?.subscriptionType ?? null;
  const nonNativeSource =
    apiKeySource !== null ||
    (authMethod !== null && /api[-_]?key|console|bedrock|vertex/.test(authMethod)) ||
    (apiProvider !== null && apiProvider !== 'firstparty');
  if (nonNativeSource) return 'metered';
  if (
    authMethod === 'claude.ai' &&
    apiProvider === 'firstparty' &&
    Boolean(subscriptionType?.trim())
  )
    return 'included_subscription';
  return 'unknown';
}

function claudeUsageFromControl(
  controlUsage: z.infer<typeof claudeUsageSchema> | null,
  accountKey: string | null,
  context: DiscoveryRuntime,
): CliUsageSnapshot {
  const windows = claudeUsageWindows(controlUsage?.rate_limits);
  if (controlUsage?.rate_limits_available === true && windows.length > 0)
    return {
      connectionId: 'claude-code-cli',
      accountKey,
      state: 'available',
      source: 'claude control get_usage',
      observedAt: context.now().toISOString(),
      staleAt: null,
      windows,
      note: null,
    };
  return emptyUsage(
    'claude-code-cli',
    'Claude rate limits are unavailable for this CLI version or account.',
  );
}

interface ClaudeControlProbe {
  init: z.infer<typeof claudeInitializeSchema> | null;
  usage: z.infer<typeof claudeUsageSchema> | null;
}

async function probeClaudeControl(
  executable: string,
  baseArgs: string[],
  context: DiscoveryRuntime,
): Promise<ClaudeControlProbe> {
  const client = new ClaudeControlClient({
    executable,
    baseArgs,
    environment: context.environment,
    timeoutMs: context.timeoutMs,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  try {
    let init: z.infer<typeof claudeInitializeSchema> | null = null;
    let usage: z.infer<typeof claudeUsageSchema> | null = null;
    try {
      init = claudeInitializeSchema.parse(await client.request('initialize'));
    } catch {
      init = null;
    }
    try {
      usage = claudeUsageSchema.parse(await client.request('get_usage'));
    } catch {
      usage = null;
    }
    return { init, usage };
  } finally {
    await client.close();
  }
}

async function discoverClaude(
  options: CliDiscoveryOptions,
  context: DiscoveryRuntime,
): Promise<CliConnection> {
  const kind: CliConnectionKind = 'claude-code-cli';
  const install = await resolveInstall(kind, options);
  if (!install.installed || !install.executable) return notInstalled(kind, install.version);
  const baseArgs = options.executableArgs ?? [];
  const [control, status] = await Promise.all([
    probeClaudeControl(install.executable, baseArgs, context).catch(() => ({
      init: null,
      usage: null,
    })),
    readClaudeAuthStatus(install.executable, baseArgs, context),
  ]);
  const { init, usage: controlUsage } = control;
  const account = claudeAccountProbe(init, status);
  const billing = claudeBilling(init, status);
  const models = claudeModels(kind, init?.models ?? []).map((model) => ({ ...model, billing }));
  const usage = claudeUsageFromControl(controlUsage, account?.key ?? null, context);
  return {
    id: kind,
    kind,
    providerId: kind,
    upstreamLabel: upstreamLabels[kind],
    install: {
      installed: true,
      executable: install.executable,
      version: init?.claude_code_version ?? install.version,
      installHint: installHints[kind],
    },
    account: account ?? { state: 'unknown', key: null, label: null, plan: null },
    verify: { state: 'unverified', modelRef: null, checkedAt: null, message: null },
    surfaces: { native: false, gateway: false },
    models,
    usage,
    lastChecked: context.now().toISOString(),
    discoveryMessage: init
      ? models.length === 0
        ? 'Claude reported no selectable models for this account.'
        : null
      : 'Claude structured control (initialize/get_usage) is unavailable on this CLI version; only auth status was read.',
  };
}

/* ------------------------------ OpenCode -------------------------------- */

async function readOpencodeAuth(context: DiscoveryRuntime) {
  const dataHome = context.environment.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(dataHome, 'opencode', 'auth.json'), 'utf8'),
    );
    return parseOpencodeAuthStore(raw);
  } catch {
    return [];
  }
}

function opencodeBilling(providerId: string, cost: unknown): CliBilling {
  // OpenCode Go is a paid subscription plan: a selected Go credential is included capacity, and
  // zero-cost metadata must never be reported as a free route.
  if (providerId === 'opencode-go') return 'included_subscription';
  if (typeof cost !== 'object' || cost === null) return 'unknown';
  const value = cost as { input?: unknown; output?: unknown };
  if (value.input === 0 && value.output === 0) return 'free';
  return 'unknown';
}

function opencodeCapabilities(
  kind: CliConnectionKind,
  providerId: string,
  id: string,
  raw: Record<string, unknown>,
): CliModelCapabilities {
  const variants = raw.variants;
  const efforts =
    typeof variants === 'object' && variants !== null
      ? uniqueEfforts(
          Object.values(variants as Record<string, unknown>).map((variant) =>
            typeof variant === 'object' && variant !== null
              ? (variant as { reasoningEffort?: unknown }).reasoningEffort
              : undefined,
          ),
        )
      : [];
  const capabilities =
    typeof raw.capabilities === 'object' && raw.capabilities !== null
      ? (raw.capabilities as { toolcall?: unknown })
      : undefined;
  const name = typeof raw.name === 'string' && raw.name ? raw.name : id;
  return {
    ref: `${kind}/${providerId}/${id}` as ModelRef,
    connectionId: kind,
    providerId: kind,
    upstreamId: `${providerId}/${id}`,
    upstreamProvider: providerId,
    name,
    efforts,
    defaultEffort: null,
    speeds: ['standard'],
    defaultSpeed: 'standard',
    modalities: ['text'],
    toolCalling: capabilities?.toolcall === true,
    billing: opencodeBilling(providerId, raw.cost),
    hidden: false,
  };
}

async function discoverOpencode(
  options: CliDiscoveryOptions,
  context: DiscoveryRuntime,
): Promise<CliConnection> {
  const kind: CliConnectionKind = 'opencode-cli';
  const install = await resolveInstall(kind, options);
  if (!install.installed || !install.executable) return notInstalled(kind, install.version);
  const records = await readOpencodeAuth(context);
  const selected = records.find((record) => record.providerId === 'opencode') ?? records[0];
  const connected = new Set(records.map((record) => record.providerId));
  const models: CliModelCapabilities[] = [];
  try {
    const baseArgs = options.executableArgs ?? [];
    const listed = await runCommand(
      install.executable,
      [...baseArgs, 'models', '--verbose'],
      context,
    );
    for (const block of parseOpencodeModelsVerbose(listed.stdout)) {
      const capability = opencodeCapabilities(kind, block.providerId, block.id, block.raw);
      // Only offer providers with a selected credential, plus free anonymous Zen models.
      if (!connected.has(block.providerId) && capability.billing !== 'free') continue;
      models.push(capability);
    }
  } catch {
    /* model listing is best-effort; discoveryMessage explains the gap below */
  }
  const accountKey = selected?.key ? deriveCliAccountKey(kind, selected.key) : null;
  const source = records.some((record) => record.providerId === 'opencode')
    ? 'opencode'
    : records.some((record) => record.providerId === 'opencode-go')
      ? 'opencode-go'
      : 'anonymous';
  return {
    id: kind,
    kind,
    providerId: kind,
    upstreamLabel: upstreamLabels[kind],
    install: {
      installed: true,
      executable: install.executable,
      version: install.version,
      installHint: installHints[kind],
    },
    account: {
      state: selected ? 'signed_in' : 'not_checked',
      key: accountKey,
      label: source === 'opencode-go' ? 'OpenCode Go' : source === 'opencode' ? 'OpenCode' : null,
      plan: null,
    },
    verify: { state: 'unverified', modelRef: null, checkedAt: null, message: null },
    surfaces: { native: false, gateway: false },
    models,
    usage: emptyUsage(kind, 'OpenCode usage is observed by Ferry during generation.'),
    lastChecked: context.now().toISOString(),
    discoveryMessage:
      models.length === 0
        ? 'No OpenCode models were discovered. Run opencode auth login and retry.'
        : source === 'anonymous'
          ? 'Free anonymous Zen models may be available without signing in.'
          : null,
  };
}

/** Codex usage-only probe against a cached executable: account/read + rate limits, no model/list. */
async function codexUsageFor(
  executable: string,
  options: CliDiscoveryOptions,
  context: DiscoveryRuntime,
): Promise<CliUsageRefresh> {
  const kind: CliConnectionKind = 'codex-cli';
  const server = new CodexAppServer({
    executable,
    ...(options.executableArgs ? { args: options.executableArgs } : {}),
    environment: context.environment,
    timeoutMs: context.timeoutMs,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  try {
    await server.request('initialize', {
      clientInfo: { name: 'Ferry', version: '0.9.0' },
      capabilities: { experimentalApi: true },
    });
    server.notify('initialized');
    const accountRaw = codexAccountSchema.parse(await server.request('account/read', {}));
    const account = codexAccountProbe(accountRaw);
    const limits = codexRateLimitsSchema.parse(
      await server.request('account/rateLimits/read', null),
    );
    return {
      usage: codexUsageFromLimits(
        kind,
        limits,
        limits.accountId ?? codexIdentity(accountRaw),
        context,
      ),
      account,
    };
  } catch {
    return {
      usage: emptyUsage(kind, 'Codex rate limits are unavailable on this account.'),
      account: null,
    };
  } finally {
    await server.close();
  }
}

/**
 * Claude usage-only probe: isolated initialize/get_usage control plus bounded auth status, never a
 * user turn and without version detection or model catalogue re-listing.
 */
async function claudeUsageFor(
  executable: string,
  options: CliDiscoveryOptions,
  context: DiscoveryRuntime,
): Promise<CliUsageRefresh> {
  const baseArgs = options.executableArgs ?? [];
  const [probe, status] = await Promise.all([
    probeClaudeControl(executable, baseArgs, context).catch(() => ({ init: null, usage: null })),
    readClaudeAuthStatus(executable, baseArgs, context),
  ]);
  const account = claudeAccountProbe(probe.init, status);
  return {
    usage: claudeUsageFromControl(probe.usage, account?.key ?? null, context),
    account,
  };
}

/**
 * Bounded usage-only refresh against an already-detected connection. Reuses the cached executable
 * and version, so no version detection or model catalogue listing runs. Codex reads only
 * `account/read` + `account/rateLimits/read`; Claude runs an isolated structured-control probe
 * (`initialize` + `get_usage`, never a user turn); OpenCode has no usage endpoint and stays
 * `unavailable`. The authoritative account evidence is returned separately so the caller can tell a
 * real logout from an unavailable/errored probe.
 */
export async function discoverCliUsage(
  connection: CliConnection,
  options: CliDiscoveryOptions = {},
): Promise<CliUsageRefresh> {
  const context = runtime(options);
  const kind = connection.kind;
  const executable = connection.install.executable;
  if (!connection.install.installed || !executable)
    return { usage: emptyUsage(kind, `The ${kind} CLI is not installed.`), account: null };
  if (kind === 'codex-cli') return await codexUsageFor(executable, options, context);
  if (kind === 'claude-code-cli') return await claudeUsageFor(executable, options, context);
  return {
    usage: emptyUsage(kind, 'OpenCode usage is observed by Ferry during generation.'),
    account: null,
  };
}

export async function discoverCliConnection(
  kind: CliConnectionKind,
  options: CliDiscoveryOptions = {},
): Promise<CliConnection> {
  const context = runtime(options);
  if (kind === 'codex-cli') return await discoverCodex(options, context);
  if (kind === 'claude-code-cli') return await discoverClaude(options, context);
  return await discoverOpencode(options, context);
}

export async function discoverCliConnections(
  options: CliDiscoveryOptions = {},
): Promise<CliConnection[]> {
  return await Promise.all(
    (['codex-cli', 'claude-code-cli', 'opencode-cli'] as const).map((kind) =>
      discoverCliConnection(kind, options),
    ),
  );
}
