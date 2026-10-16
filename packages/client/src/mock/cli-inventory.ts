import {
  ProviderIdSchema,
  isCliModelVerified,
  type CliConnection,
  type CliConnectionKind,
  type CliConnectionVerifyResult,
  type CliCredentialSource,
  type CliModelCapabilities,
  type CliUsageSnapshot,
  type ModelInfo,
  type ModelRef,
  type Provider,
} from '@ferry/shared';
import type { MockState } from './types.js';

export const MOCK_CLI_KINDS: readonly CliConnectionKind[] = [
  'codex-cli',
  'claude-code-cli',
  'opencode-cli',
];

const OPENCODE_CLI_KIND: CliConnectionKind = 'opencode-cli';
/** Persisted legacy Zen model refs use the API-shaped `opencode/<id>` prefix. */
const ZEN_LEGACY_PREFIX = 'opencode/';

const TRANSPORT: Record<CliConnectionKind, NonNullable<ModelInfo['transport']>> = {
  'codex-cli': 'codex_cli',
  'claude-code-cli': 'claude_code_cli',
  'opencode-cli': 'opencode_cli',
};

const NAMES: Record<CliConnectionKind, string> = {
  'codex-cli': 'Codex CLI',
  'claude-code-cli': 'Claude Code',
  'opencode-cli': 'OpenCode CLI',
};

// Unknown native context uses the explicit transport policy bound (not a fabricated native window);
// `capacityKnown` stays false so the UI shows "Not reported".
const UNKNOWN_CONTEXT_WINDOW = 64_000;
const UNKNOWN_MAX_OUTPUT = 2_048;

const BRIDGE_UNSUPPORTED_EFFORTS: Record<string, string> = {
  ultra:
    'The "ultra" control is not supported by this beta CLI bridge (native isolation is not verified).',
};

function unavailable(connectionId: string, note: string): CliUsageSnapshot {
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

function available(
  connectionId: string,
  source: string,
  windows: CliUsageSnapshot['windows'],
): CliUsageSnapshot {
  return {
    connectionId,
    accountKey: null,
    state: 'available',
    source,
    observedAt: '2026-10-05T10:00:00.000Z',
    staleAt: null,
    windows,
    note: null,
  };
}

function modelsFor(kind: CliConnectionKind): CliModelCapabilities[] {
  if (kind === 'codex-cli')
    return [
      {
        ref: 'codex-cli/gpt-5.1-codex' as ModelRef,
        connectionId: kind,
        providerId: kind,
        upstreamId: 'gpt-5.1-codex',
        upstreamProvider: null,
        name: 'GPT-5.1 Codex',
        efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'],
        defaultEffort: 'medium',
        speeds: ['standard', 'fast'],
        defaultSpeed: 'standard',
        modalities: ['text'],
        toolCalling: true,
        contextWindow: 272_000,
        maxOutput: 128_000,
        billing: 'included_subscription',
        hidden: false,
      },
    ];
  if (kind === 'claude-code-cli')
    return [
      {
        ref: 'claude-code-cli/claude-opus-5-5' as ModelRef,
        connectionId: kind,
        providerId: kind,
        upstreamId: 'claude-opus-5-5',
        upstreamProvider: null,
        name: 'Opus 5.5',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: null,
        speeds: ['standard', 'fast'],
        defaultSpeed: 'standard',
        modalities: ['text'],
        toolCalling: true,
        contextWindow: 200_000,
        maxOutput: 64_000,
        billing: 'included_subscription',
        hidden: false,
      },
    ];
  // One OpenCode connection holds an anonymous free Zen model and an included Go model at once, each
  // with its own actual billing and credential bucket.
  return [
    {
      ref: 'opencode-cli/opencode/deepseek-v4.1-flash-free' as ModelRef,
      connectionId: kind,
      providerId: kind,
      upstreamId: 'opencode/deepseek-v4.1-flash-free',
      upstreamProvider: 'opencode',
      name: 'DeepSeek V4.1 Flash (Free)',
      efforts: ['low', 'high'],
      defaultEffort: null,
      speeds: ['standard'],
      defaultSpeed: 'standard',
      modalities: ['text'],
      toolCalling: true,
      contextWindow: 128_000,
      maxOutput: 32_000,
      billing: 'free',
      hidden: false,
    },
    {
      ref: 'opencode-cli/opencode-go/deepseek-v4.1-flash' as ModelRef,
      connectionId: kind,
      providerId: kind,
      upstreamId: 'opencode-go/deepseek-v4.1-flash',
      upstreamProvider: 'opencode-go',
      name: 'DeepSeek V4.1 Flash',
      efforts: ['low', 'high', 'max'],
      defaultEffort: null,
      speeds: ['standard'],
      defaultSpeed: 'standard',
      modalities: ['text'],
      toolCalling: true,
      contextWindow: 128_000,
      maxOutput: 64_000,
      billing: 'included_subscription',
      hidden: false,
    },
  ];
}

/**
 * Scripted verification receipts live in `state.cliVerifiedModels`. They carry, as a leading sentinel
 * entry, the credential-source signature they were recorded under, so changing the source (credential
 * mode/provider or the legacy Ferry-key opt-in) stops the connection from reporting them — without a
 * second proof store and without touching provider API keys or API verification.
 */
const SOURCE_SENTINEL_PREFIX = '\u0000mock-source:';

/** The credential-source signature the current settings select for one connection. */
function mockSourceSignature(state: MockState, kind: CliConnectionKind): string {
  if (kind !== OPENCODE_CLI_KIND) return 'installed';
  const saved = state.settings.cliConnections[OPENCODE_CLI_KIND];
  const mode = saved?.credentialMode ?? 'installed';
  const provider = saved?.credentialProvider ?? '';
  const ferryKey = state.settings.opencodeZenCliUseFerryKey ? 'ferry-key' : 'no-ferry-key';
  return `${mode}|${provider}|${ferryKey}`;
}

function recordedSourceSignature(entries: readonly string[]): string | null {
  const sentinel = entries.find((entry) => entry.startsWith(SOURCE_SENTINEL_PREFIX));
  return sentinel ? sentinel.slice(SOURCE_SENTINEL_PREFIX.length) : null;
}

/**
 * Verified refs for one connection, honouring the recorded source signature. An entry set with no
 * recorded signature (a receipt written before source binding) is treated as current.
 */
function verifiedRefsFor(state: MockState, kind: CliConnectionKind): ModelRef[] {
  const entries = state.cliVerifiedModels.get(kind) ?? [];
  const recorded = recordedSourceSignature(entries);
  if (recorded !== null && recorded !== mockSourceSignature(state, kind)) return [];
  return entries.filter((entry) => !entry.startsWith(SOURCE_SENTINEL_PREFIX)) as ModelRef[];
}

/** Build the scripted mock connection for one installed-CLI kind from the current store state. */
export function buildMockCliConnection(state: MockState, kind: CliConnectionKind): CliConnection {
  const saved = state.settings.cliConnections[kind];
  const surfaces = { native: saved?.native ?? false, gateway: saved?.gateway ?? false };
  // Accumulated per-model receipts: verifying a new model never forgets earlier verified models.
  const verifiedRefs = verifiedRefsFor(state, kind);
  const modelReceipts = Object.fromEntries(
    verifiedRefs.map((ref) => [
      ref,
      { checkedAt: '2026-10-05T10:00:00.000Z', receiptKey: 'mock-receipt' },
    ]),
  );
  const verify: CliConnection['verify'] =
    verifiedRefs.length > 0
      ? {
          state: 'verified',
          modelRef: verifiedRefs[verifiedRefs.length - 1] ?? null,
          checkedAt: '2026-10-05T10:00:00.000Z',
          message: 'Verified with a scripted mock generation.',
          receiptKey: 'mock-receipt',
          modelReceipts,
        }
      : { state: 'unverified', modelRef: null, checkedAt: null, message: null };
  const base: CliConnection = {
    id: kind,
    kind,
    providerId: kind,
    upstreamLabel:
      kind === 'codex-cli' ? 'ChatGPT' : kind === 'claude-code-cli' ? 'Claude' : 'OpenCode Zen',
    install: {
      installed: true,
      executable:
        kind === 'codex-cli' ? 'codex' : kind === 'claude-code-cli' ? 'claude' : 'opencode',
      version:
        kind === 'codex-cli' ? '0.162.1' : kind === 'claude-code-cli' ? '2.1.296' : '1.18.35',
      installHint:
        kind === 'codex-cli'
          ? 'Install Codex CLI and sign in with codex login.'
          : kind === 'claude-code-cli'
            ? 'Install Claude Code and run claude auth login.'
            : 'Install OpenCode, then run opencode auth login for your chosen provider.',
    },
    account:
      kind === 'claude-code-cli'
        ? { state: 'signed_in', key: null, label: 'demo@example.com', plan: 'Claude Pro' }
        : kind === 'opencode-cli'
          ? { state: 'unknown', key: null, label: 'OpenCode Go', plan: null }
          : { state: 'not_checked', key: null, label: null, plan: null },
    verify,
    surfaces,
    models: modelsFor(kind),
    usage:
      kind === 'codex-cli'
        ? available(kind, 'codex app-server account/rateLimits/read', [
            {
              id: 'codex:primary',
              label: 'Codex',
              metric: 'percent',
              windowKind: 'five_hour',
              used: 65,
              limit: 100,
              remaining: 35,
              utilization: 0.65,
              resetAt: null,
            },
            {
              id: 'codex:secondary',
              label: 'Codex',
              metric: 'percent',
              windowKind: 'seven_day',
              used: 11,
              limit: 100,
              remaining: 89,
              utilization: 0.11,
              resetAt: null,
            },
          ])
        : kind === 'claude-code-cli'
          ? available(kind, 'claude control get_usage', [
              {
                id: 'five_hour',
                label: 'five_hour',
                metric: 'percent',
                windowKind: 'five_hour',
                used: 65,
                limit: 100,
                remaining: 35,
                utilization: 0.65,
                resetAt: null,
              },
              {
                id: 'seven_day',
                label: 'seven_day',
                metric: 'percent',
                windowKind: 'seven_day',
                used: 62,
                limit: 100,
                remaining: 38,
                utilization: 0.62,
                resetAt: null,
              },
            ])
          : unavailable(kind, 'OpenCode usage is observed by Ferry during generation.'),
    lastChecked: null,
    discoveryMessage:
      kind === 'opencode-cli'
        ? 'Free anonymous Zen models may be available without signing in. Choose a model to check.'
        : null,
  };
  return base;
}

function unsupportedEfforts(model: CliModelCapabilities): Record<string, string> {
  const result: Record<string, string> = {};
  for (const effort of model.efforts) {
    const reason = model.unsupportedEfforts?.[effort] ?? BRIDGE_UNSUPPORTED_EFFORTS[effort];
    if (reason) result[effort] = reason;
  }
  return result;
}

/** A connection is "surfaced" once opted in or verified; default-off connections stay invisible. */
function surfaced(connection: CliConnection): boolean {
  return (
    connection.surfaces.native ||
    connection.surfaces.gateway ||
    connection.verify.state === 'verified'
  );
}

function toModelInfo(connection: CliConnection, model: CliModelCapabilities): ModelInfo {
  const verified = isCliModelVerified(connection, model.ref);
  const capacityKnown = model.contextWindow != null && model.maxOutput != null;
  return {
    ref: model.ref,
    providerId: ProviderIdSchema.parse(connection.providerId),
    name: model.name,
    tier: 'T1',
    contextWindow: model.contextWindow ?? UNKNOWN_CONTEXT_WINDOW,
    maxOutput: model.maxOutput ?? UNKNOWN_MAX_OUTPUT,
    capacityKnown,
    toolCalling: model.toolCalling,
    reasoning: model.efforts.length > 0,
    free: model.billing === 'free',
    priceInPerM: null,
    priceOutPerM: null,
    transport: TRANSPORT[connection.kind],
    cliConnectionId: connection.kind,
    cliCapabilities: { ...model, unsupportedEfforts: unsupportedEfforts(model) },
    verified,
    verifiedAt: verified ? connection.verify.checkedAt : null,
  };
}

/** Synthetic CLI model rows the mock exposes once a connection is opted in or verified. */
export function mockCliModelRows(state: MockState): ModelInfo[] {
  return MOCK_CLI_KINDS.flatMap((kind) => {
    const connection = buildMockCliConnection(state, kind);
    if (!surfaced(connection)) return [];
    return connection.models
      .filter((model) => !model.hidden)
      .map((model) => toModelInfo(connection, model));
  });
}

/** Synthetic CLI provider rows the mock exposes once a connection is opted in or verified. */
export function mockCliProviderRows(state: MockState): Provider[] {
  return MOCK_CLI_KINDS.flatMap((kind) => {
    const connection = buildMockCliConnection(state, kind);
    if (!surfaced(connection)) return [];
    const verified = connection.verify.state === 'verified';
    const optedIn = connection.surfaces.native || connection.surfaces.gateway;
    return [
      {
        id: ProviderIdSchema.parse(connection.providerId),
        name: NAMES[kind],
        tag: 'subscription_cli' as const,
        keyRequired: false,
        kind: 'cli' as const,
        brand: null,
        keyStatus: 'not_applicable' as const,
        keyCount: 0,
        enabled: optedIn && verified,
        health: verified ? ('ok' as const) : ('unknown' as const),
        cooldownUntil: null,
        dataUse: null,
        termsNote: null,
        signupUrl: null,
        docsUrl: null,
        verifiedAt: null,
        modelCount: connection.models.length,
        availableModels: connection.models.map((model) => toModelInfo(connection, model)),
        windows: [],
        stepsLeftToday: null,
      },
    ];
  });
}

/** The canonical installed-CLI ref for one legacy OpenCode Zen upstream model id. */
export function canonicalZenRef(id: string): ModelRef {
  return `${OPENCODE_CLI_KIND}/opencode/${id}` as ModelRef;
}

/** The bare upstream id of a persisted legacy `opencode/<id>` ref, or null when it is not an alias. */
export function legacyZenAliasId(ref: string): string | null {
  if (!ref.startsWith(ZEN_LEGACY_PREFIX)) return null;
  const id = ref.slice(ZEN_LEGACY_PREFIX.length).trim();
  return id.length > 0 && !id.includes(' ') ? id : null;
}

/**
 * Whether the legacy Zen CLI transport selects one surface. Mirrors the shared rule: a generic
 * OpenCode CLI opt-in for another upstream (e.g. Go) never reroutes a standard Zen API ref.
 */
export function mockZenCliSurfaceSelected(
  state: MockState,
  surface: 'native' | 'gateway' = 'native',
): boolean {
  const settings = state.settings;
  if (settings.opencodeZenTransport !== 'cli') return false;
  const shared = settings.cliConnections[OPENCODE_CLI_KIND];
  if (settings.zenCliMigratedToShared) return shared?.[surface] ?? false;
  if (shared && (Object.hasOwn(shared, 'native') || Object.hasOwn(shared, 'gateway')))
    return shared[surface];
  return true;
}

/** Whether the Zen CLI transport is selected for either surface. */
export function mockZenCliTransportSelected(state: MockState): boolean {
  return mockZenCliSurfaceSelected(state, 'native') || mockZenCliSurfaceSelected(state, 'gateway');
}

/**
 * Resolve one ref to a discovered canonical CLI model of `kind`. A persisted legacy `opencode/<id>`
 * alias resolves to `opencode-cli/opencode/<id>` only for the OpenCode connection and only while the
 * Zen CLI transport is selected, so a standard Zen API ref is never silently rerouted.
 */
export function resolveMockCliModel(
  state: MockState,
  kind: CliConnectionKind,
  ref: string,
): CliModelCapabilities | undefined {
  const discovered = buildMockCliConnection(state, kind).models.filter((model) => !model.hidden);
  const direct = discovered.find((model) => model.ref === ref);
  if (direct) return direct;
  if (kind !== OPENCODE_CLI_KIND || !mockZenCliTransportSelected(state)) return undefined;
  const aliasId = legacyZenAliasId(ref);
  if (aliasId === null) return undefined;
  const canonical = canonicalZenRef(aliasId);
  return discovered.find((model) => model.ref === canonical);
}

/** Resolve a ref across every installed-CLI kind to its discovered canonical model, or undefined. */
export function resolveMockCliModelRef(
  state: MockState,
  ref: string,
): CliModelCapabilities | undefined {
  for (const kind of MOCK_CLI_KINDS) {
    const model = resolveMockCliModel(state, kind, ref);
    if (model) return model;
  }
  return undefined;
}

/**
 * Record one successful scripted verification against the shared per-model receipt store and return
 * the updated connection. Refs recorded under a different credential source are dropped rather than
 * carried over, and provider API keys/API verification are never touched.
 */
export function recordMockCliVerification(
  state: MockState,
  kind: CliConnectionKind,
  modelRef: ModelRef,
): CliConnection {
  const entries = state.cliVerifiedModels.get(kind) ?? [];
  const signature = mockSourceSignature(state, kind);
  const recorded = recordedSourceSignature(entries);
  const sourceBound = recorded === null || recorded === signature;
  const priorRefs = entries.filter(
    (entry) => !entry.startsWith(SOURCE_SENTINEL_PREFIX),
  ) as ModelRef[];
  const refs = sourceBound ? priorRefs : [];
  const next = refs.includes(modelRef) ? refs : [...refs, modelRef];
  state.cliVerifiedModels.set(kind, [`${SOURCE_SENTINEL_PREFIX}${signature}`, ...next]);
  return buildMockCliConnection(state, kind);
}

/**
 * The single shared mock verification used by both the `cliConnections` domain and the Zen facade.
 * An explicit unknown/non-discovered target fails instead of silently verifying another model; a
 * missing target verifies the first non-spending discovered model, matching the shared broker.
 */
export function verifyMockCliConnection(
  state: MockState,
  kind: CliConnectionKind,
  requestedRef?: ModelRef,
): CliConnectionVerifyResult {
  const connection = buildMockCliConnection(state, kind);
  const discovered = connection.models.filter((model) => !model.hidden);
  const resolved =
    requestedRef === undefined ? undefined : resolveMockCliModel(state, kind, requestedRef);
  const target =
    resolved ??
    (requestedRef === undefined
      ? (discovered.find((model) => model.billing !== 'metered' && model.billing !== 'unknown') ??
        discovered[0])
      : undefined);
  if (!target) {
    return {
      ok: false,
      modelRef: requestedRef ?? null,
      message:
        requestedRef === undefined
          ? `No discoverable ${kind} model is available to verify.`
          : `Model ${requestedRef} is not discovered for ${kind}.`,
    };
  }
  recordMockCliVerification(state, kind, target.ref);
  return {
    ok: true,
    modelRef: target.ref,
    message: `Verified ${target.name} with a scripted mock generation.`,
  };
}

/**
 * Validation message for an explicit CLI option patch against a discovered model's capabilities, or
 * null when every explicit value is supported. Mirrors the shared `cliOptionError`: absent fields and
 * an explicit null effort are accepted, advertised-but-unrunnable controls are rejected.
 */
export function mockCliOptionError(
  modelRef: string,
  model: Pick<CliModelCapabilities, 'efforts' | 'speeds' | 'unsupportedEfforts'>,
  patch: { effort?: string | null | undefined; speed?: 'standard' | 'fast' | undefined },
): string | null {
  if (patch.effort != null) {
    const reason = unsupportedEfforts(model as CliModelCapabilities)[patch.effort];
    if (reason) return `${patch.effort} is unavailable for ${modelRef}: ${reason}`;
    if (!model.efforts.includes(patch.effort))
      return `${patch.effort} is not a supported effort for ${modelRef}.`;
  }
  if (patch.speed !== undefined && !model.speeds.includes(patch.speed))
    return `${patch.speed} is not a supported speed for ${modelRef}.`;
  return null;
}

/** The mock's discovered credential source, mirroring the frozen Core facade. */
export function mockZenCliCredentialSource(
  state: MockState,
  connection: CliConnection,
): CliCredentialSource {
  const saved = state.settings.cliConnections[OPENCODE_CLI_KIND];
  const mode =
    saved?.credentialMode === 'anonymous' || saved?.credentialMode === 'ferry'
      ? saved.credentialMode
      : 'installed';
  const offer =
    typeof saved?.credentialProvider === 'string' && saved.credentialProvider.trim()
      ? saved.credentialProvider.trim()
      : null;
  if (mode === 'anonymous') return 'anonymous';
  if (mode === 'ferry') return 'ferry';
  if (offer === 'opencode-go') return 'opencode_go';
  if (connection.account.label === 'OpenCode Go') return 'opencode_go';
  if (connection.account.state === 'signed_in' && connection.account.key !== null)
    return 'opencode';
  return 'anonymous';
}
