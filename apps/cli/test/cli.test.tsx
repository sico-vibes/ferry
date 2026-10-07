import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createMockFerryClient, createPlaybackRunner } from '@ferry/client';
import {
  formatRoutingDetails,
  gatewayCommand,
  modelMapCommand,
  providerKeysCommand,
  providerOverridesCommand,
  providerRoutingCommand,
  profiles,
  routingSettings,
  runCli,
  runPrompt,
} from '../src/main.js';
import { ApprovalPrompt, Chat } from '../src/tui.js';
import { formatCapacity, statusLine } from '../src/format.js';

function client() {
  return createMockFerryClient({
    behavior: 'live',
    latencyMs: 0,
    scenarioRunner: createPlaybackRunner({ speed: 0 }),
  });
}

describe('@ferry/cli', () => {
  afterEach(() => vi.restoreAllMocks());

  it('formats attempt audits with provider, status, and latency for verbose output', () => {
    const details = {
      attempts: [
        {
          model: 'groq/openai/gpt-oss-120b',
          provider: 'groq',
          kind: 'server' as const,
          status: 503,
          latencyMs: 124,
          message: 'Temporary outage',
        },
      ],
    } as Parameters<typeof formatRoutingDetails>[0];
    expect(formatRoutingDetails(details)).toContain(
      'groq · groq/openai/gpt-oss-120b: server (HTTP 503) · 124 ms',
    );
  });

  it('round-trips Gateway key limits through the in-process Ferry client', async () => {
    const api = client();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(
      await gatewayCommand(['keys', 'create', 'CLI fixture'], true, api, undefined, {
        rpm: '30',
        concurrency: '2',
        'tokens-per-min': '4000',
        'tokens-per-day': '50000',
        'allowed-models': 'openrouter/model-a, openrouter/model-b',
      }),
    ).toBe(0);
    const created = JSON.parse(output.mock.calls.at(-1)?.[0]?.toString() ?? '{}') as {
      key: { id: string };
      secret: string;
    };
    expect(created.secret).toBeTruthy();
    output.mockClear();
    await gatewayCommand(['keys', 'show', created.key.id], true, api);
    expect(JSON.parse(output.mock.calls[0]?.[0]?.toString() ?? '{}')).toMatchObject({
      id: created.key.id,
      rateLimit: 30,
      concurrencyLimit: 2,
      tokenLimitPerMinute: 4000,
      tokenLimitPerDay: 50000,
      allowedModels: ['openrouter/model-a', 'openrouter/model-b'],
    });
    await gatewayCommand(['keys', 'update', created.key.id], true, api, undefined, {
      rpm: '60',
      clear: 'tokens-per-day',
      'allowed-models': 'openrouter/model-c',
    });
    output.mockClear();
    await gatewayCommand(['keys', 'show', created.key.id], true, api);
    expect(JSON.parse(output.mock.calls[0]?.[0]?.toString() ?? '{}')).toMatchObject({
      rateLimit: 60,
      tokenLimitPerDay: null,
      allowedModels: ['openrouter/model-c'],
    });
  });

  it('adds provider keys only from stdin, moves, disables, and removes them without exposing secrets', async () => {
    const api = client();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stdinIterator = vi.spyOn(process.stdin, Symbol.asyncIterator);
    const add = async (secret: string, label: string, json = true) => {
      let read = false;
      stdinIterator.mockReturnValue({
        next: () =>
          Promise.resolve(
            read
              ? { done: true, value: undefined }
              : ((read = true), { done: false, value: Buffer.from(secret) }),
          ),
        return: () => Promise.resolve({ done: true, value: undefined }),
        [Symbol.asyncDispose]: () => Promise.resolve(),
        [Symbol.asyncIterator]() {
          return this;
        },
      });
      await providerKeysCommand(api, ['openrouter', 'add'], { stdin: true, label }, json);
      const rendered = output.mock.calls.at(-1)?.[0]?.toString() ?? '{}';
      if (json) return JSON.parse(rendered) as { id: string };
      const keys = await api.providers.listKeys('openrouter' as import('@ferry/shared').ProviderId);
      const added = keys.find((key) => key.label === label);
      if (!added) throw new Error('Provider key was not added');
      return { id: added.id };
    };
    const first = await add('provider-secret-1234', 'first');
    const second = await add('provider-secret-5678', 'second', false);
    expect(output.mock.calls.map(([chunk]) => String(chunk)).join('')).not.toContain(
      'provider-secret',
    );
    await providerKeysCommand(api, ['openrouter', 'move', second.id, '1'], {}, true);
    await providerKeysCommand(api, ['openrouter', 'disable', second.id], {}, true);
    expect(
      await api.providers.listKeys('openrouter' as import('@ferry/shared').ProviderId),
    ).toMatchObject([{ id: second.id, enabled: false, status: 'disabled' }, { id: first.id }]);
    await providerKeysCommand(api, ['openrouter', 'remove', second.id], { yes: true }, true);
    output.mockClear();
    await providerKeysCommand(api, ['openrouter', 'list'], {}, false);
    expect(output.mock.calls.map(([chunk]) => String(chunk)).join('')).not.toContain(
      'provider-secret',
    );
    stdinIterator.mockRestore();
  });

  it('sets and shows provider routing preferences and a logical model mapping', async () => {
    const api = client();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await providerRoutingCommand(api, ['openrouter'], { priority: '12', weight: '2.5' }, true);
    expect(JSON.parse(output.mock.calls.at(-1)?.[0]?.toString() ?? '{}')).toMatchObject({
      priority: 12,
      weight: 2.5,
    });
    output.mockClear();
    await providerRoutingCommand(api, ['openrouter'], {}, true);
    expect(JSON.parse(output.mock.calls[0]?.[0]?.toString() ?? '{}')).toMatchObject({
      priority: 12,
      weight: 2.5,
    });
    await modelMapCommand(api, ['set', 'logical-test', 'openrouter', 'openai/gpt-test'], true);
    output.mockClear();
    await modelMapCommand(api, ['list'], true);
    const mapped = JSON.parse(output.mock.calls[0]?.[0]?.toString() ?? '{}') as {
      mappings: { logicalName: string; providerId: string; upstreamId: string }[];
    };
    expect(mapped.mappings).toContainEqual({
      logicalName: 'logical-test',
      providerId: 'openrouter',
      upstreamId: 'openai/gpt-test',
    });
  });

  it('gets effective provider overrides through the client and sets profile affinity', async () => {
    const api = client();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const provider = (await api.providers.list()).find((item) => item.id === 'openrouter');
    if (!provider) throw new Error('OpenRouter fixture missing');
    const settings = await api.settings.get();
    await api.settings.update({
      routing: {
        ...settings.routing,
        providerOverrides: {
          ...settings.routing.providerOverrides,
          [provider.id]: {
            stripParams: [],
            forceParams: { temperature: 0.4 },
            headers: { 'X-CLI-Test': 'mock' },
            statusRemaps: [],
          },
        },
      },
    });
    await providerOverridesCommand(api, ['openrouter'], true);
    const overrides = JSON.parse(output.mock.calls.at(-1)?.[0]?.toString() ?? '{}') as {
      overrides: { forceParams: Record<string, unknown>; headers: Record<string, string> };
    };
    expect(overrides.overrides).toMatchObject({
      forceParams: { temperature: 0.4 },
      headers: { 'X-CLI-Test': 'mock' },
    });

    const profile = (await api.profiles.list())[0];
    if (!profile) throw new Error('Profile fixture missing');
    output.mockClear();
    expect(await profiles(api, ['affinity', profile.name, 'strict'], true)).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)?.[0]?.toString() ?? '{}')).toEqual({
      profile: profile.name,
      affinityMode: 'strict',
    });
    output.mockClear();
    await profiles(api, ['affinity', profile.name], true);
    expect(JSON.parse(output.mock.calls.at(-1)?.[0]?.toString() ?? '{}')).toMatchObject({
      affinityMode: 'strict',
    });
  });

  it('returns usage exit code 2 and refuses a positional provider secret without echoing it', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runCli([
      'providers',
      'keys',
      'openrouter',
      'add',
      'unsafe-secret-value',
      '--json',
      '--engine',
      'mock',
    ]);
    expect(code).toBe(2);
    const emitted = output.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(emitted).not.toContain('unsafe-secret-value');
    expect(JSON.parse(emitted)).toMatchObject({ error: { code: 2 } });
  });

  it('documents cloud commands and never prints a non-interactive login password', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runCli(['cloud', '--help'])).toBe(0);
    expect(output.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('migrate-keys');
    output.mockClear();
    const before = process.env.FERRY_CLOUD_PASSWORD;
    process.env.FERRY_CLOUD_PASSWORD = 'cloud-secret-never-echo';
    try {
      expect(
        await runCli([
          'cloud',
          'login',
          '--email',
          'admin@example.com',
          '--json',
          '--engine',
          'mock',
        ]),
      ).toBe(1);
      expect(output.mock.calls.map(([chunk]) => String(chunk)).join('')).not.toContain(
        'cloud-secret-never-echo',
      );
    } finally {
      if (before === undefined) delete process.env.FERRY_CLOUD_PASSWORD;
      else process.env.FERRY_CLOUD_PASSWORD = before;
    }
  });

  it('shows per-command help and returns usage code 2 for invalid Gateway limits', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runCli(['providers', 'keys', '--help'])).toBe(0);
    expect(output.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('--stdin');
    output.mockClear();
    expect(await runCli(['gateway', 'keys', '--help'])).toBe(0);
    expect(output.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
      '--allowed-models <ref,ref>',
    );
    output.mockClear();
    expect(
      await runCli([
        'gateway',
        'keys',
        'create',
        'invalid-budget',
        '--rpm',
        '0',
        '--json',
        '--engine',
        'mock',
      ]),
    ).toBe(2);
    expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''))).toMatchObject({
      error: { code: 2 },
    });
  });

  it('formats quota as a capacity bar with a percentage', async () => {
    const text = formatCapacity(await client().quota.capacity());
    expect(text).toContain('64%');
  });

  it('lists routing settings and persists a per-technique toggle', async () => {
    const api = client();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await routingSettings(api, ['routing', 'list'], false)).toBe(0);
    expect(write.mock.calls.map((call) => String(call[0])).join('')).toContain(
      'sticky-sessions: true',
    );
    expect(await routingSettings(api, ['routing', 'set', 'sticky-sessions', 'off'], false)).toBe(0);
    expect((await api.settings.get()).routing.stickySessions).toBe(false);
  });

  it('renders the profile prompt and status line', async () => {
    const api = client();
    const workspace = await api.workspaces.open(process.cwd());
    const profile = (await api.profiles.list())[0];
    if (!profile) throw new Error('fixture profile missing');
    const app = render(<Chat client={api} workspace={workspace} profile={profile} />);
    expect(app.lastFrame()).toContain(profile.name);
    expect(statusLine(profile.name, 'auto', await api.quota.limits())).toContain('auto');
    expect(statusLine(profile.name, 'gemini/gemini-flash', await api.quota.limits())).toContain(
      'daily requests left',
    );
    app.unmount();
  });

  it('renders the approval prompt', () => {
    const app = render(<ApprovalPrompt summary="Run tests" detail="Command: pnpm test" />);
    expect(app.lastFrame()).toContain('Approval: Run tests');
    expect(app.lastFrame()).toContain('Command: pnpm test');
    app.unmount();
  });

  it('streams a mock scenario to completion with exit code zero', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runPrompt(client(), 'Explain the request routing', true);
    expect(code).toBe(0);
    const rows = write.mock.calls.map((call) => String(call[0]).trim()).filter(Boolean);
    const events = rows.map((row) => JSON.parse(row) as { type?: string });
    expect(events.some((event) => event.type === 'session.delta')).toBe(true);
    expect(events.some((event) => event.type === 'session.status')).toBe(true);
  });

  it('returns approval exit code 3 for an approval-required scenario', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runPrompt(client(), 'Fix the flaky tests', true);
    expect(code).toBe(3);
  });

  it('honors full_auto approvals and the max-step limit', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const automaticallyApproved = await runPrompt(
      client(),
      'Fix the flaky tests',
      true,
      undefined,
      process.cwd(),
      { permission: 'full_auto' },
    );
    expect(automaticallyApproved).toBe(0);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const limited = await runPrompt(
      client(),
      'Fix the flaky tests',
      true,
      undefined,
      process.cwd(),
      { maxSteps: 1, permission: 'full_auto', mock: true },
    );
    expect(limited).toBe(4);
    expect(stderr).toHaveBeenCalled();
  });
});
