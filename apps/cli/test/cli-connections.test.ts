import { describe, expect, it, vi } from 'vitest';
import {
  CliConnectionSchema,
  type CliConnection,
  type CliConnectionKind,
  type CliModelCapabilities,
} from '@ferry/shared';
import {
  billingLabel,
  cliEffortChoices,
  cliModelMatchesFilter,
  cliModelPickerOptions,
  cliModelSelectability,
  connectionFacts,
  connectionLimits,
  decodeCliModelValue,
  encodeCliModelValue,
  mergeCliOptionDraft,
  nativeCapMetadata,
  resolveCliOptions,
  safeVerificationModel,
} from '../src/cli-connections.js';
import { connectUpdatePatch, runCli } from '../src/main.js';

function model(overrides: Partial<CliModelCapabilities> = {}): CliModelCapabilities {
  return {
    ref: 'codex-cli/gpt-5.1-codex' as CliModelCapabilities['ref'],
    connectionId: 'codex-cli',
    providerId: 'codex-cli',
    upstreamId: 'gpt-5.1-codex',
    upstreamProvider: 'ChatGPT',
    name: 'GPT-5.1 Codex',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    speeds: ['standard'],
    defaultSpeed: 'standard',
    modalities: ['text'],
    toolCalling: true,
    billing: 'included_subscription',
    hidden: false,
    ...overrides,
  };
}

function connection(
  kind: CliConnectionKind,
  overrides: Partial<CliConnection> = {},
): CliConnection {
  return CliConnectionSchema.parse({
    id: kind,
    kind,
    providerId: kind,
    upstreamLabel: 'Upstream',
    install: { installed: true, executable: kind, version: '1.0.0', installHint: 'Install it.' },
    account: { state: 'signed_in', key: null, label: 'me@example.com', plan: 'Pro' },
    verify: { state: 'unverified', modelRef: null, checkedAt: null, message: null },
    surfaces: { native: false, gateway: false },
    models: [model()],
    usage: {
      connectionId: kind,
      accountKey: null,
      state: 'unavailable',
      source: 'cli',
      observedAt: null,
      staleAt: null,
      windows: [],
      note: 'Observed during generation.',
    },
    lastChecked: null,
    discoveryMessage: null,
    ...overrides,
  });
}

function captureStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

describe('cli connection helpers', () => {
  it('labels billing without ever calling an included subscription free', () => {
    expect(billingLabel('free')).toBe('Free');
    expect(billingLabel('included_subscription')).toBe('Included subscription');
    expect(billingLabel('metered')).toBe('Metered');
    expect(billingLabel('unknown')).toBe('Billing unknown');
  });

  it('round-trips encoded CLI model values', () => {
    const value = encodeCliModelValue(
      'opencode-cli',
      'opencode-cli/opencode-go/deepseek-v4.1-flash',
    );
    expect(decodeCliModelValue(value)).toEqual({
      kind: 'opencode-cli',
      ref: 'opencode-cli/opencode-go/deepseek-v4.1-flash',
    });
    expect(decodeCliModelValue('opencode-cli/foo')).toBeNull();
  });

  it('requires native opt-in and verification before a CLI model is selectable', () => {
    const off = connection('codex-cli');
    expect(cliModelSelectability(off, model()).selectable).toBe(false);
    expect(cliModelSelectability(off, model()).reason).toMatch(/Enable Native/);

    const nativeUnverified = connection('codex-cli', {
      surfaces: { native: true, gateway: false },
    });
    expect(cliModelSelectability(nativeUnverified, model()).reason).toMatch(/Verify/);

    const verified = connection('codex-cli', {
      surfaces: { native: true, gateway: false },
      verify: {
        state: 'verified',
        modelRef: 'codex-cli/gpt-5.1-codex' as CliConnection['verify']['modelRef'],
        checkedAt: null,
        message: null,
      },
    });
    expect(cliModelSelectability(verified, model()).selectable).toBe(true);

    const gatewayOnly = connection('codex-cli', { surfaces: { native: false, gateway: true } });
    expect(cliModelSelectability(gatewayOnly, model()).selectable).toBe(false);
  });

  it('never treats a model-less verification as proof of every model', () => {
    const verifiedNoModel = connection('codex-cli', {
      surfaces: { native: true, gateway: false },
      verify: { state: 'verified', modelRef: null, checkedAt: null, message: null },
    });
    const result = cliModelSelectability(verifiedNoModel, model());
    expect(result.selectable).toBe(false);
    expect(result.reason).toMatch(/discovery alone/);
  });

  it('keeps previously verified models selectable after checking another model', () => {
    const first = model();
    const second = model({ ref: 'codex-cli/second' as CliModelCapabilities['ref'] });
    const discovered = model({ ref: 'codex-cli/unverified' as CliModelCapabilities['ref'] });
    const proven = connection('codex-cli', {
      surfaces: { native: true, gateway: false },
      models: [first, second, discovered],
      verify: {
        state: 'verified',
        modelRef: second.ref,
        checkedAt: null,
        message: null,
        modelReceipts: {
          [first.ref]: { checkedAt: '2026-10-14T12:00:00.000Z', receiptKey: 'first' },
          [second.ref]: { checkedAt: '2026-10-14T13:00:00.000Z', receiptKey: 'second' },
        },
      },
    });
    expect(cliModelSelectability(proven, first).selectable).toBe(true);
    expect(cliModelSelectability(proven, second).selectable).toBe(true);
    expect(cliModelSelectability(proven, discovered).selectable).toBe(false);
    expect(
      cliModelSelectability({ ...proven, surfaces: { native: false, gateway: true } }, first)
        .selectable,
    ).toBe(false);
  });

  it('blocks explicit signed-out accounts except OpenCode anonymous free generation', () => {
    const signedOut = connection('codex-cli', {
      account: { state: 'signed_out', key: null, label: null, plan: null },
      surfaces: { native: true, gateway: false },
      verify: {
        state: 'verified',
        modelRef: 'codex-cli/gpt-5.1-codex' as CliConnection['verify']['modelRef'],
        checkedAt: null,
        message: null,
      },
    });
    expect(cliModelSelectability(signedOut, model()).selectable).toBe(false);
    expect(cliModelSelectability(signedOut, model()).reason).toMatch(/Sign in/);

    // An OpenCode anonymous free model that proved generation stays selectable without sign-in.
    const anonymousFree = connection('opencode-cli', {
      account: { state: 'signed_out', key: null, label: null, plan: null },
      surfaces: { native: true, gateway: false },
      verify: {
        state: 'verified',
        modelRef: 'codex-cli/gpt-5.1-codex' as CliConnection['verify']['modelRef'],
        checkedAt: null,
        message: null,
      },
      models: [
        model({
          ref: 'opencode-cli/zen/deepseek-free' as CliModelCapabilities['ref'],
          connectionId: 'opencode-cli',
          providerId: 'opencode-cli',
          billing: 'free',
        }),
      ],
    });
    const freeModel = anonymousFree.models[0];
    if (!freeModel) throw new Error('missing model');
    // The proof must name this exact model; a stub receipt for another ref is not proof.
    expect(cliModelSelectability(anonymousFree, freeModel).selectable).toBe(false);
    const proven = connection('opencode-cli', {
      ...anonymousFree,
      verify: {
        state: 'verified',
        modelRef: freeModel.ref,
        checkedAt: null,
        message: null,
      },
    });
    expect(cliModelSelectability(proven, freeModel).selectable).toBe(true);
  });

  it('picks a non-spending verification model, never guessing a metered one', () => {
    const metered = model({
      ref: 'codex-cli/metered' as CliModelCapabilities['ref'],
      billing: 'metered',
    });
    const included = model({
      ref: 'codex-cli/included' as CliModelCapabilities['ref'],
      billing: 'included_subscription',
    });
    const mixed = connection('codex-cli', { models: [metered, included] });
    expect(safeVerificationModel(mixed)?.ref).toBe('codex-cli/included');

    const onlyMetered = connection('codex-cli', { models: [metered] });
    expect(safeVerificationModel(onlyMetered)).toBeUndefined();

    // Re-verifying the already-verified model wins even when it is metered.
    const recheck = connection('codex-cli', {
      models: [metered, included],
      verify: {
        state: 'verified',
        modelRef: 'codex-cli/metered' as CliConnection['verify']['modelRef'],
        checkedAt: null,
        message: null,
      },
    });
    expect(safeVerificationModel(recheck)?.ref).toBe('codex-cli/metered');
  });

  it('resolves conversation > profile > connection > reported effort with fast OFF by default', () => {
    const target = model({ defaultEffort: 'medium', speeds: ['standard', 'fast'] });
    expect(resolveCliOptions(target)).toEqual({ effort: 'medium', speed: 'standard' });
    expect(
      resolveCliOptions(target, {
        connection: { effort: null, speed: 'standard' },
        profile: { effort: 'low' },
        conversation: { effort: 'high' },
      }),
    ).toEqual({ effort: 'high', speed: 'standard' });
    // A default selection stops inheritance and uses the actual reported default.
    expect(
      resolveCliOptions(target, { profile: { effort: 'low' }, conversation: { effort: null } }),
    ).toEqual({ effort: 'medium', speed: 'standard' });
    // Unsupported explicit controls remain visible; Core rejects them before dispatch.
    expect(resolveCliOptions(target, { conversation: { effort: 'ultra', speed: 'fast' } })).toEqual(
      { effort: 'ultra', speed: 'fast' },
    );
    expect(
      resolveCliOptions(target, { conversation: { effort: 'nope', speed: 'standard' } }),
    ).toEqual({ effort: 'nope', speed: 'standard' });
    const noEffort = model({ efforts: [], defaultEffort: null });
    expect(resolveCliOptions(noEffort)).toEqual({ effort: null, speed: 'standard' });
  });

  it('merges pre-session drafts per model, preserving an explicit null reset', () => {
    const draft = mergeCliOptionDraft(null, 'codex-cli/m', { effort: 'high' });
    expect(draft).toEqual({ modelRef: 'codex-cli/m', options: { effort: 'high' } });
    expect(mergeCliOptionDraft(draft, 'codex-cli/m', { speed: 'fast' })).toEqual({
      modelRef: 'codex-cli/m',
      options: { effort: 'high', speed: 'fast' },
    });
    expect(
      mergeCliOptionDraft({ modelRef: 'codex-cli/m', options: { effort: 'high' } }, 'codex-cli/m', {
        effort: null,
        speed: 'fast',
      }),
    ).toEqual({ modelRef: 'codex-cli/m', options: { effort: null, speed: 'fast' } });
    // Switching models replaces rather than merges the draft.
    expect(mergeCliOptionDraft(draft, 'codex-cli/other', { speed: 'fast' })).toEqual({
      modelRef: 'codex-cli/other',
      options: { speed: 'fast' },
    });
  });

  it('filters free and included models distinctly', () => {
    expect(cliModelMatchesFilter('free', 'free')).toBe(true);
    expect(cliModelMatchesFilter('included_subscription', 'free')).toBe(false);
    expect(cliModelMatchesFilter('included_subscription', 'included')).toBe(true);
    expect(cliModelMatchesFilter('free', 'all')).toBe(true);
  });

  it('reads optional native capability hints from the validated public schema', () => {
    const withCaps = model({
      unsupportedEfforts: { ultra: 'bridge does not support ultra' },
      contextWindow: 400_000,
      maxOutput: 32_000,
    });
    const caps = nativeCapMetadata(withCaps);
    expect(caps.contextWindow).toBe(400_000);
    expect(caps.maxOutput).toBe(32_000);
    expect(caps.unsupportedEfforts).toEqual({ ultra: 'bridge does not support ultra' });
    // An older Core client that omits the optional caps degrades to empty hints.
    const legacy = model();
    expect(nativeCapMetadata(legacy)).toEqual({
      unsupportedEfforts: {},
      contextWindow: null,
      maxOutput: null,
    });
  });

  it('keeps unsupported raw efforts visible but unavailable', () => {
    const withCaps = model({
      efforts: ['low', 'ultra'],
      unsupportedEfforts: { ultra: 'bridge does not support ultra' },
    });
    const choices = cliEffortChoices(withCaps);
    expect(choices.find((choice) => choice.token === 'ultra')).toMatchObject({
      unavailable: true,
      reason: 'bridge does not support ultra',
    });
    expect(choices.find((choice) => choice.token === 'low')?.unavailable).toBe(false);
  });

  it('separates install, account, proof, limits and opt-in facts', () => {
    const labels = connectionFacts(connection('codex-cli')).map((fact) => fact.label);
    expect(labels).toEqual([
      'Installed',
      'Version',
      'Current account',
      'Auth',
      'Model discovery',
      'Generation proof',
      'Limits',
      'Opt-ins',
    ]);
  });

  it('reports subscription capacity as unavailable with the source note', () => {
    expect(connectionLimits(connection('codex-cli'))).toBe(
      'Unavailable · Observed during generation.',
    );
    const available = connection('codex-cli', {
      usage: {
        connectionId: 'codex-cli',
        accountKey: null,
        state: 'available',
        source: 'cli',
        observedAt: null,
        staleAt: null,
        windows: [
          {
            id: 'five_hour',
            label: '5h',
            metric: 'percent',
            windowKind: 'five_hour',
            used: 50,
            limit: 100,
            remaining: 50,
            utilization: 0.5,
            resetAt: null,
          },
        ],
        note: null,
      },
    });
    expect(connectionLimits(available)).toBe('5h 50%');
  });

  it('keeps unverified discovered models visible with a reason in the model picker', () => {
    const rows = cliModelPickerOptions([
      connection('claude-code-cli', { surfaces: { native: true, gateway: false } }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.group).toBe('Claude Code CLI');
    expect(rows[0]?.description).toContain('Included subscription');
    expect(rows[0]?.description).toMatch(/Verify/);
    expect(rows[0]?.selectable).toBe(false);
    expect(rows[0]?.included).toBe(true);
    expect(rows[0]?.free).toBeUndefined();
  });
});

describe('ferry connect non-interactive', () => {
  it('documents connect usage in help', async () => {
    const output = captureStdout();
    expect(await runCli(['connect', '--help', '--json'])).toBe(0);
    const emitted = output.mock.calls.map(([chunk]) => String(chunk)).join('');
    const parsed: unknown = JSON.parse(emitted);
    expect(String((parsed as { help?: string }).help)).toContain('ferry connect list');
  });

  it('lists installed CLI connections as JSON through the mock engine', async () => {
    const output = captureStdout();
    expect(await runCli(['connect', 'list', '--json', '--engine', 'mock'])).toBe(0);
    const emitted = output.mock.calls.map(([chunk]) => String(chunk)).join('');
    const parsed = JSON.parse(emitted) as { kind: string }[];
    expect(parsed.map((row) => row.kind)).toEqual(['codex-cli', 'claude-code-cli', 'opencode-cli']);
  });

  it('clears an invalid speed option with a usage error', async () => {
    const output = captureStdout();
    expect(
      await runCli([
        'connect',
        'update',
        'codex-cli',
        '--speed',
        'warp',
        '--json',
        '--engine',
        'mock',
      ]),
    ).toBe(2);
    const emitted = output.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(JSON.parse(emitted)).toMatchObject({ error: { code: 2 } });
    expect(emitted).toMatch(/standard or fast/);
  });

  it('builds a surfaces/options patch and rejects malformed values', () => {
    expect(
      connectUpdatePatch({
        native: 'true',
        gateway: 'false',
        effort: 'ultra',
        speed: 'fast',
      }),
    ).toEqual({
      surfaces: { native: true, gateway: false },
      defaultOptions: { effort: 'ultra', speed: 'fast' },
    });
    expect(connectUpdatePatch({ effort: 'default' })).toEqual({
      defaultOptions: { effort: null },
    });
    expect(() => connectUpdatePatch({ native: 'maybe' })).toThrow(/true\|false/);
    expect(() => connectUpdatePatch({ speed: 'warp' })).toThrow(/standard or fast/);
  });

  it('persists native and gateway opt-ins through update', async () => {
    const output = captureStdout();
    expect(
      await runCli([
        'connect',
        'update',
        'codex-cli',
        '--native',
        'true',
        '--gateway',
        'true',
        '--json',
        '--engine',
        'mock',
      ]),
    ).toBe(0);
    const emitted = output.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(JSON.parse(emitted)).toMatchObject({
      kind: 'codex-cli',
      surfaces: { native: true, gateway: true },
    });
  });
});
