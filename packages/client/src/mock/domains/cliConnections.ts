import type {
  CliConnection,
  CliConnectionKind,
  CliConnectionSettings,
  CliUsageSnapshot,
  ModelRef,
} from '@ferry/shared';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

const kinds: readonly CliConnectionKind[] = ['codex-cli', 'claude-code-cli', 'opencode-cli'];

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

export function createCliConnectionsDomain(
  _store: MockStore,
  deps: MockDeps,
): FerryClient['cliConnections'] {
  const { before, emit, state } = deps;
  const surfacesFor = (id: CliConnectionKind) => {
    const saved = state.settings.cliConnections[id];
    return { native: saved?.native ?? false, gateway: saved?.gateway ?? false };
  };
  const build = (id: CliConnectionKind): CliConnection => {
    const surfaces = surfacesFor(id);
    if (id === 'codex-cli')
      return {
        id,
        kind: id,
        providerId: id,
        upstreamLabel: 'ChatGPT',
        install: {
          installed: true,
          executable: 'codex',
          version: '0.162.1',
          installHint: 'Install Codex CLI and sign in with codex login.',
        },
        account: { state: 'not_checked', key: null, label: null, plan: null },
        verify: { state: 'unverified', modelRef: null, checkedAt: null, message: null },
        surfaces,
        models: [
          {
            ref: 'codex-cli/gpt-5.1-codex' as ModelRef,
            connectionId: id,
            providerId: id,
            upstreamId: 'gpt-5.1-codex',
            upstreamProvider: null,
            name: 'GPT-5.1 Codex',
            // Reported effort tokens are preserved verbatim, including `ultra`.
            efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'],
            defaultEffort: 'medium',
            speeds: ['standard', 'fast'],
            defaultSpeed: 'standard',
            modalities: ['text'],
            toolCalling: true,
            billing: 'included_subscription',
            hidden: false,
          },
        ],
        usage: available(id, 'codex app-server account/rateLimits/read', [
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
        ]),
        lastChecked: null,
        discoveryMessage: null,
      };
    if (id === 'claude-code-cli')
      return {
        id,
        kind: id,
        providerId: id,
        upstreamLabel: 'Claude',
        install: {
          installed: true,
          executable: 'claude',
          version: '2.1.296',
          installHint: 'Install Claude Code and run claude auth login.',
        },
        account: { state: 'signed_in', key: null, label: 'demo@example.com', plan: 'Claude Pro' },
        verify: { state: 'unverified', modelRef: null, checkedAt: null, message: null },
        surfaces,
        models: [
          {
            ref: 'claude-code-cli/claude-opus-5-5' as ModelRef,
            connectionId: id,
            providerId: id,
            upstreamId: 'claude-opus-5-5',
            upstreamProvider: null,
            name: 'Opus 5.5',
            efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            defaultEffort: null,
            speeds: ['standard', 'fast'],
            defaultSpeed: 'standard',
            modalities: ['text'],
            toolCalling: true,
            billing: 'included_subscription',
            hidden: false,
          },
        ],
        // Real Claude structured control exposes usage without a generation.
        usage: available(id, 'claude control get_usage', [
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
        ]),
        lastChecked: null,
        discoveryMessage: null,
      };
    // OpenCode Go: a selected Go credential is included subscription capacity, never a free route.
    return {
      id,
      kind: id,
      providerId: id,
      upstreamLabel: 'OpenCode Zen',
      install: {
        installed: true,
        executable: 'opencode',
        version: '1.18.35',
        installHint: 'Install OpenCode, then run opencode auth login for your chosen provider.',
      },
      account: { state: 'unknown', key: null, label: 'OpenCode Go', plan: null },
      verify: { state: 'unverified', modelRef: null, checkedAt: null, message: null },
      surfaces,
      models: [
        {
          ref: 'opencode-cli/opencode-go/deepseek-v4.1-flash' as ModelRef,
          connectionId: id,
          providerId: id,
          upstreamId: 'opencode-go/deepseek-v4.1-flash',
          upstreamProvider: 'opencode-go',
          name: 'DeepSeek V4.1 Flash',
          efforts: ['low', 'high', 'max'],
          defaultEffort: null,
          speeds: ['standard'],
          defaultSpeed: 'standard',
          modalities: ['text'],
          toolCalling: true,
          billing: 'included_subscription',
          hidden: false,
        },
      ],
      usage: unavailable(id, 'OpenCode usage is observed by Ferry during generation.'),
      lastChecked: null,
      discoveryMessage:
        'Free anonymous Zen models may be available without signing in. Choose a model to check.',
    };
  };
  return {
    async list() {
      await before();
      return kinds.map(build);
    },
    async refresh(id) {
      await before();
      const selected = id ? [id] : kinds;
      const connections = selected.map(build);
      for (const connection of connections) emit('cliConnections.updated', connection);
      return kinds.map(build);
    },
    async verify(id, modelRef) {
      await before();
      const connection = build(id);
      return {
        ok: false,
        modelRef: modelRef ?? connection.models[0]?.ref ?? null,
        message: 'Verification requires a generation and is available in a later phase.',
      };
    },
    async update(id, patch) {
      await before();
      const current: Partial<CliConnectionSettings> = state.settings.cliConnections[id] ?? {};
      const defaultOptions = patch.defaultOptions;
      // An explicit `null` clears the stored override; an absent field preserves it.
      const effort =
        defaultOptions && 'effort' in defaultOptions
          ? (defaultOptions.effort ?? null)
          : (current.defaultOptions?.effort ?? null);
      state.settings.cliConnections[id] = {
        native: patch.surfaces?.native ?? current.native ?? false,
        gateway: patch.surfaces?.gateway ?? current.gateway ?? false,
        defaultOptions: {
          effort,
          speed: defaultOptions?.speed ?? current.defaultOptions?.speed ?? 'standard',
        },
        modelDefaults: patch.modelDefaults ?? current.modelDefaults ?? {},
      };
      const connection = build(id);
      emit('cliConnections.updated', connection);
      return connection;
    },
  };
}
