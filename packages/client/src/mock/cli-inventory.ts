import {
  ProviderIdSchema,
  isCliModelVerified,
  type CliConnection,
  type CliConnectionKind,
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
  return [
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

/** Build the scripted mock connection for one installed-CLI kind from the current store state. */
export function buildMockCliConnection(state: MockState, kind: CliConnectionKind): CliConnection {
  const saved = state.settings.cliConnections[kind];
  const surfaces = { native: saved?.native ?? false, gateway: saved?.gateway ?? false };
  const verifiedRef = state.cliVerifiedModels.get(kind) as ModelRef | undefined;
  const verify: CliConnection['verify'] = verifiedRef
    ? {
        state: 'verified',
        modelRef: verifiedRef,
        checkedAt: '2026-10-05T10:00:00.000Z',
        message: 'Verified with a scripted mock generation.',
        receiptKey: 'mock-receipt',
        modelReceipts: {
          [verifiedRef]: { checkedAt: '2026-10-05T10:00:00.000Z', receiptKey: 'mock-receipt' },
        },
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
    free: false,
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
