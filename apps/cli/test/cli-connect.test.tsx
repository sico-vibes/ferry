import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { createMockFerryClient } from '@ferry/client';
import type { FerryClient } from '@ferry/client';
import {
  CliConnectionSchema,
  type CliConnection,
  type CliConnectionKind,
  type CliConnectionSettingsPatch,
  type CliConnectionVerifyResult,
  type CliModelCapabilities,
  type CliOption,
  type SessionDetail,
} from '@ferry/shared';
import { Chat } from '../src/tui.js';
import { ConnectPanel } from '../src/components/connect-panel.js';
import { CliOptionsPanel } from '../src/components/cli-options-panel.js';
import { Picker } from '../src/components/picker.js';

type App = ReturnType<typeof render>;

function cliModel(
  kind: CliConnectionKind,
  overrides: Partial<CliModelCapabilities> = {},
): CliModelCapabilities {
  return {
    ref: `${kind}/test-model` as CliModelCapabilities['ref'],
    connectionId: kind,
    providerId: kind,
    upstreamId: 'test-model',
    upstreamProvider: kind === 'codex-cli' ? 'ChatGPT' : 'Claude',
    name: kind === 'codex-cli' ? 'CLIXUnique Codex' : 'CLIXUnique Claude',
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
    models: [cliModel(kind)],
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

function verifiedNative(kind: CliConnectionKind, model: CliModelCapabilities): CliConnection {
  return connection(kind, {
    models: [model],
    surfaces: { native: true, gateway: false },
    verify: { state: 'verified', modelRef: model.ref, checkedAt: null, message: null },
  });
}

interface FakeClient {
  client: FerryClient;
  updated: { kind: CliConnectionKind; patch: CliConnectionSettingsPatch }[];
  cliOptionCalls: { sessionId: string; modelRef: string; options: Partial<CliOption> }[];
  selectedRefs: string[];
  verifyCalls: { kind: CliConnectionKind; ref: string | undefined }[];
  emit: (connection: CliConnection) => void;
}

interface FakeOptions {
  failSelectRefs?: ReadonlySet<string>;
  updateError?: Error;
  sessionDetail?: SessionDetail;
  verifyResult?: (
    kind: CliConnectionKind,
    ref: CliModelCapabilities['ref'] | undefined,
  ) => CliConnectionVerifyResult;
}

function fakeClient(seed: CliConnection[], options: FakeOptions = {}): FakeClient {
  const base = createMockFerryClient();
  let connections = seed;
  const updated: FakeClient['updated'] = [];
  const cliOptionCalls: FakeClient['cliOptionCalls'] = [];
  const selectedRefs: string[] = [];
  const verifyCalls: FakeClient['verifyCalls'] = [];
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const on = (event: string, handler: (payload: unknown) => void) => {
    const set = handlers.get(event) ?? new Set();
    set.add(handler);
    handlers.set(event, set);
    return () => set.delete(handler);
  };
  const cliConnections: FerryClient['cliConnections'] = {
    list: () => Promise.resolve(connections),
    refresh: (id) => {
      const next = id ? connections.filter((row) => row.kind === id) : connections;
      for (const connectionRow of next)
        for (const fn of handlers.get('cliConnections.updated') ?? []) fn(connectionRow);
      return Promise.resolve(connections);
    },
    verify: (id, ref) => {
      verifyCalls.push({ kind: id, ref });
      if (options.verifyResult) return Promise.resolve(options.verifyResult(id, ref));
      return Promise.resolve({ ok: true, modelRef: ref ?? null, message: `${id} verified` });
    },
    update: (id, patch) => {
      updated.push({ kind: id, patch });
      const current = connections.find((row) => row.kind === id);
      const next: CliConnection = {
        ...(current ?? connection(id)),
        surfaces: {
          native: patch.surfaces?.native ?? current?.surfaces.native ?? false,
          gateway: patch.surfaces?.gateway ?? current?.surfaces.gateway ?? false,
        },
      };
      connections = connections.map((row) => (row.kind === id ? next : row));
      for (const fn of handlers.get('cliConnections.updated') ?? []) fn(next);
      return Promise.resolve(next);
    },
  };
  const client: FerryClient = {
    ...base,
    cliConnections,
    on: on as FerryClient['on'],
    models: {
      ...base.models,
      select: (_id, ref) => {
        if (options.failSelectRefs?.has(ref))
          return Promise.reject(new Error('provider rejected the selection (HTTP 403)'));
        selectedRefs.push(ref);
        return Promise.resolve();
      },
    },
    sessions: {
      ...base.sessions,
      get: (id) =>
        options.sessionDetail ? Promise.resolve(options.sessionDetail) : base.sessions.get(id),
      updateCliOptions: (id, input) => {
        if (options.updateError) return Promise.reject(options.updateError);
        cliOptionCalls.push({ sessionId: id, modelRef: input.modelRef, options: input.options });
        return base.sessions.updateCliOptions(id, input);
      },
    },
  };
  return {
    client,
    updated,
    cliOptionCalls,
    selectedRefs,
    verifyCalls,
    emit: (c) => {
      for (const fn of handlers.get('cliConnections.updated') ?? []) fn(c);
    },
  };
}

async function frame(app: App, value: string, timeout = 3000) {
  await vi.waitFor(
    () => {
      expect(app.lastFrame()).toContain(value);
    },
    { timeout, interval: 10 },
  );
}

async function key(app: App, value: string) {
  await new Promise((resolve) => setTimeout(resolve, 40));
  app.stdin.write(value);
  await new Promise((resolve) => setTimeout(resolve, 40));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('connect panel installed CLIs', () => {
  it('lists installed CLIs and separates facts with independent enable actions', async () => {
    const fake = fakeClient([
      connection('codex-cli'),
      connection('claude-code-cli'),
      connection('opencode-cli'),
    ]);
    const app = render(<ConnectPanel client={fake.client} onClose={() => undefined} />);
    await frame(app, 'Connect a provider');
    await key(app, 'Codex CLI');
    await frame(app, 'Installed CLIs');
    await key(app, '\r');
    await frame(app, 'Generation proof');
    await frame(app, 'Limits:');
    await key(app, 'Enable Native');
    await key(app, '\r');
    await vi.waitFor(() => {
      expect(fake.updated).toHaveLength(1);
    });
    expect(fake.updated[0]).toEqual({
      kind: 'codex-cli',
      patch: { surfaces: { native: true } },
    });
    app.unmount();
  });

  it('shows sign-in instructions without touching native histories', async () => {
    const fake = fakeClient([connection('claude-code-cli')]);
    const app = render(<ConnectPanel client={fake.client} onClose={() => undefined} />);
    await frame(app, 'Connect a provider');
    await key(app, 'Claude Code CLI');
    await key(app, '\r');
    await frame(app, 'Installed CLI actions');
    await key(app, 'Sign-in instructions');
    await key(app, '\r');
    await frame(app, 'claude auth login');
    app.unmount();
  });

  it('verifies a non-spending model instead of blindly guessing the first discovered one', async () => {
    const metered = cliModel('codex-cli', {
      ref: 'codex-cli/metered' as CliModelCapabilities['ref'],
      name: 'Metered Model',
      billing: 'metered',
    });
    const included = cliModel('codex-cli', {
      ref: 'codex-cli/included' as CliModelCapabilities['ref'],
      name: 'Included Model',
      billing: 'included_subscription',
    });
    const fake = fakeClient([connection('codex-cli', { models: [metered, included] })]);
    const app = render(<ConnectPanel client={fake.client} onClose={() => undefined} />);
    await frame(app, 'Connect a provider');
    await key(app, 'Codex CLI');
    await key(app, '\r');
    await frame(app, 'Installed CLI actions');
    await key(app, 'Verify generation');
    await key(app, '\r');
    await frame(app, 'codex-cli verified');
    expect(fake.verifyCalls).toEqual([{ kind: 'codex-cli', ref: 'codex-cli/included' }]);
    app.unmount();
  });

  it('offers a model choice so any discovered model can be verified', async () => {
    const metered = cliModel('codex-cli', {
      ref: 'codex-cli/metered' as CliModelCapabilities['ref'],
      name: 'Metered Model',
      billing: 'metered',
    });
    const included = cliModel('codex-cli', {
      ref: 'codex-cli/included' as CliModelCapabilities['ref'],
      name: 'Included Model',
      billing: 'included_subscription',
    });
    const fake = fakeClient([connection('codex-cli', { models: [metered, included] })]);
    const app = render(<ConnectPanel client={fake.client} onClose={() => undefined} />);
    await frame(app, 'Connect a provider');
    await key(app, 'Codex CLI');
    await key(app, '\r');
    await frame(app, 'Installed CLI actions');
    await key(app, 'Verify another');
    await key(app, '\r');
    await frame(app, 'Verify a Codex CLI model');
    await key(app, 'Metered Model');
    await key(app, '\r');
    await frame(app, 'codex-cli verified');
    expect(fake.verifyCalls).toEqual([{ kind: 'codex-cli', ref: 'codex-cli/metered' }]);
    app.unmount();
  });
});

describe('cli options panel', () => {
  it('disables unsupported efforts with a reason and hides unsupported fast', async () => {
    const model = cliModel('codex-cli', {
      efforts: ['low', 'high', 'ultra'],
      unsupportedEfforts: { ultra: 'bridge does not support ultra' },
    });
    const changes: Partial<CliOption>[] = [];
    const app = render(
      <CliOptionsPanel
        model={model}
        options={{ effort: null, speed: 'standard' }}
        onChange={(patch) => {
          changes.push(patch);
          return Promise.resolve();
        }}
        onClose={() => undefined}
      />,
    );
    await frame(app, 'Model options');
    await key(app, 'Effort');
    await key(app, '\r');
    await frame(app, 'Default effort');
    await key(app, 'ultra');
    await key(app, '\r');
    await frame(app, 'Unavailable: bridge does not support ultra');
    await key(app, '\x1b');
    await key(app, 'Speed');
    await key(app, '\r');
    await frame(app, 'Standard');
    // Fast is not advertised, so the speed list offers only Standard.
    expect(app.lastFrame()).not.toContain('Fast');
    app.unmount();
  });

  it('persists a raw advertised effort token', async () => {
    const changes: Partial<CliOption>[] = [];
    const app = render(
      <CliOptionsPanel
        model={cliModel('claude-code-cli', {
          efforts: ['low', 'high', 'max'],
          defaultEffort: null,
        })}
        options={{ effort: null, speed: 'standard' }}
        onChange={(patch) => {
          changes.push(patch);
          return Promise.resolve();
        }}
        onClose={() => undefined}
      />,
    );
    await frame(app, 'Model options');
    await key(app, 'Effort');
    await key(app, '\r');
    await key(app, 'max');
    await key(app, '\r');
    await vi.waitFor(() => {
      expect(changes).toContainEqual({ effort: 'max' });
    });
    app.unmount();
  });
});

describe('model picker filter modes', () => {
  it('cycles Free, Included subscriptions, and All connected without mislabeling', async () => {
    const app = render(
      <Picker
        title="model"
        options={[
          { value: 'auto', label: 'Auto', pinned: true },
          { value: 'api-free', label: 'ApiFree', free: true },
          { value: 'cli-included', label: 'CliIncluded', included: true },
        ]}
        filter={{ mode: 'all', onChange: () => undefined }}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    );
    await frame(app, 'All connected');
    await frame(app, 'ApiFree');
    await frame(app, 'CliIncluded');
    app.unmount();
  });
});

describe('chat CLI model selection', () => {
  it('selects a verified native CLI model, opens options, and persists per-conversation options', async () => {
    const codex = verifiedNative('codex-cli', cliModel('codex-cli'));
    const fake = fakeClient([codex]);
    const profile = (await fake.client.profiles.list())[0];
    const app = render(<Chat client={fake.client} workspace={null} profile={profile} />);
    await key(app, '/model\r');
    await frame(app, 'Filter:');
    await key(app, 'CLIXUnique Codex');
    await frame(app, 'CLIXUnique Codex');
    await key(app, '\r');
    await frame(app, 'Model options');
    await frame(app, 'Effort: medium');
    await key(app, 'Effort');
    await key(app, '\r');
    await key(app, 'high');
    await key(app, '\r');
    await vi.waitFor(() => {
      expect(fake.cliOptionCalls.length).toBeGreaterThan(0);
    });
    expect(fake.cliOptionCalls.at(-1)).toMatchObject({
      modelRef: 'codex-cli/test-model',
      options: { effort: 'high' },
    });
    app.unmount();
  });

  it('keeps an unverified discovered CLI model visible with a reason and blocks selection', async () => {
    const fake = fakeClient([
      connection('claude-code-cli', { surfaces: { native: true, gateway: false } }),
    ]);
    const profile = (await fake.client.profiles.list())[0];
    const app = render(<Chat client={fake.client} workspace={null} profile={profile} />);
    await key(app, '/model\r');
    await frame(app, 'Filter:');
    await key(app, 'CLIXUnique Claude');
    await frame(app, 'Verify Claude Code CLI');
    await key(app, '\r');
    await frame(app, 'Verify Claude Code CLI in /connect to enable this model');
    expect(fake.selectedRefs).toEqual([]);
    app.unmount();
  });

  it('does not read the CLI inventory on chat load, only when /model is opened', async () => {
    const fake = fakeClient([verifiedNative('codex-cli', cliModel('codex-cli'))]);
    const list = vi.spyOn(fake.client.cliConnections, 'list');
    const profile = (await fake.client.profiles.list())[0];
    const app = render(<Chat client={fake.client} workspace={null} profile={profile} />);
    // Wait for the chat to be ready instead of a fixed sleep, then assert discovery stayed lazy.
    await frame(app, 'Enter sends');
    expect(list).not.toHaveBeenCalled();
    await key(app, '/model\r');
    await frame(app, 'Filter:');
    expect(list).toHaveBeenCalled();
    app.unmount();
  });

  it('switching to a different CLI model reopens options with that model defaults', async () => {
    const codex = verifiedNative('codex-cli', cliModel('codex-cli'));
    const claude = verifiedNative(
      'claude-code-cli',
      cliModel('claude-code-cli', { defaultEffort: null, efforts: ['low', 'max'] }),
    );
    const fake = fakeClient([codex, claude]);
    const profile = (await fake.client.profiles.list())[0];
    const app = render(<Chat client={fake.client} workspace={null} profile={profile} />);
    await key(app, '/model\r');
    await frame(app, 'Filter:');
    await key(app, 'CLIXUnique Codex');
    await key(app, '\r');
    await frame(app, 'Effort: medium');
    await key(app, '\x1b');
    await frame(app, '›');
    await key(app, '/model\r');
    await frame(app, 'Filter:');
    await key(app, 'CLIXUnique Claude');
    await key(app, '\r');
    await frame(app, 'Effort: Default (CLI)');
    app.unmount();
  });

  it('explains the beta Fast billing limit without persisting an unusable option', async () => {
    const codex = verifiedNative(
      'codex-cli',
      cliModel('codex-cli', { speeds: ['standard', 'fast'] }),
    );
    const fake = fakeClient([codex]);
    const profile = (await fake.client.profiles.list())[0];
    const app = render(<Chat client={fake.client} workspace={null} profile={profile} />);
    await key(app, '/model\r');
    await frame(app, 'Filter:');
    await key(app, 'CLIXUnique Codex');
    await key(app, '\r');
    await frame(app, 'Model options');
    await key(app, '\x1b');
    await frame(app, 'Enter sends');
    await key(app, '/speed fast\r');
    await frame(app, 'Fast mode is unavailable in this beta');
    expect(fake.cliOptionCalls.some((call) => call.options.speed === 'fast')).toBe(false);
    expect(fake.selectedRefs).toContain('codex-cli/test-model');
    app.unmount();
  });

  it('keeps the previous model and does not open options when selection fails', async () => {
    const codex = verifiedNative('codex-cli', cliModel('codex-cli'));
    const fake = fakeClient([codex], {
      failSelectRefs: new Set(['codex-cli/test-model']),
    });
    const profile = (await fake.client.profiles.list())[0];
    const app = render(<Chat client={fake.client} workspace={null} profile={profile} />);
    await key(app, '/model\r');
    await frame(app, 'Filter:');
    await key(app, 'CLIXUnique Codex');
    await frame(app, 'CLIXUnique Codex');
    await key(app, '\r');
    await frame(app, 'Could not select');
    // The failed switch neither claims success, opens options, nor changes the actual model.
    expect(app.lastFrame()).not.toContain('Model options');
    expect(app.lastFrame()).not.toContain('Selected CLIXUnique Codex');
    expect(app.lastFrame()).toContain('/connect');
    expect(fake.selectedRefs).toEqual([]);
    expect(app.lastFrame()).toContain('requested auto');
    app.unmount();
  });

  it('does not change the status until a CLI option update is confirmed', async () => {
    const codex = verifiedNative('codex-cli', cliModel('codex-cli'));
    const fake = fakeClient([codex], { updateError: new Error('updateCliOptions rejected') });
    const profile = (await fake.client.profiles.list())[0];
    const app = render(<Chat client={fake.client} workspace={null} profile={profile} />);
    await key(app, '/model\r');
    await frame(app, 'Filter:');
    await key(app, 'CLIXUnique Codex');
    await key(app, '\r');
    await frame(app, 'Model options');
    await key(app, 'Effort');
    await key(app, '\r');
    await key(app, 'high');
    await key(app, '\r');
    await frame(app, 'updateCliOptions rejected');
    expect(fake.cliOptionCalls).toEqual([]);
    // The status bar still reflects the confirmed value, not the rejected optimistic one.
    expect(app.lastFrame()).not.toContain('Effort: high');
    app.unmount();
  });

  it('reopens an existing conversation with its persisted CLI options and status', async () => {
    const codex = verifiedNative('codex-cli', cliModel('codex-cli', { defaultEffort: 'medium' }));
    const fake = fakeClient([codex]);
    const base = await fake.client.sessions.create({ workspaceId: null, title: 'Existing' });
    const detail: SessionDetail = {
      session: {
        ...base,
        pinnedModelRef: 'codex-cli/test-model' as CliModelCapabilities['ref'],
        modelRef: 'codex-cli/test-model' as CliModelCapabilities['ref'],
        cliOptions: {
          ['codex-cli/test-model' as CliModelCapabilities['ref']]: {
            effort: 'high',
            speed: 'standard',
          },
        },
      },
      messages: [],
      taskRecord: {
        sessionId: base.id,
        goal: '',
        plan: [],
        decisions: [],
        touchedFiles: [],
        nextStep: null,
      },
    };
    const loaded = fakeClient([codex], { sessionDetail: detail });
    const profile = (await loaded.client.profiles.list())[0];
    const app = render(
      <Chat client={loaded.client} workspace={null} profile={profile} initialSession={base} />,
    );
    await frame(app, 'Included subscription');
    expect(app.lastFrame()).toContain('high');
    app.unmount();
  });

  it('hides effort when the CLI model advertises none', async () => {
    const model = cliModel('codex-cli', { efforts: [], defaultEffort: null });
    const app = render(
      <CliOptionsPanel
        model={model}
        options={{ effort: null, speed: 'standard' }}
        onChange={() => Promise.resolve()}
        onClose={() => undefined}
      />,
    );
    await frame(app, 'Model options');
    expect(app.lastFrame()).toContain('Speed:');
    expect(app.lastFrame()).not.toContain('Effort:');
    app.unmount();
  });

  it('disables the default effort choice when the reported default is unsupported', async () => {
    const model = cliModel('codex-cli', {
      efforts: ['low', 'ultra'],
      defaultEffort: 'ultra',
      unsupportedEfforts: { ultra: 'bridge does not support ultra' },
    });
    const app = render(
      <CliOptionsPanel
        model={model}
        options={{ effort: null, speed: 'standard' }}
        onChange={() => Promise.resolve()}
        onClose={() => undefined}
      />,
    );
    await frame(app, 'Model options');
    await key(app, 'Effort');
    await key(app, '\r');
    await frame(app, 'Default effort');
    await key(app, '\r');
    await frame(app, 'Unavailable: bridge does not support ultra');
    app.unmount();
  });

  it('merges partial CLI option patches for the same model without dropping the earlier effort', async () => {
    const codex = verifiedNative(
      'codex-cli',
      cliModel('codex-cli', { speeds: ['standard', 'fast'] }),
    );
    const fake = fakeClient([codex]);
    const session = await fake.client.sessions.create({ workspaceId: null, title: 'Merge' });
    await fake.client.sessions.updateCliOptions(session.id, {
      modelRef: 'codex-cli/test-model' as CliModelCapabilities['ref'],
      options: { effort: 'high' },
    });
    await fake.client.sessions.updateCliOptions(session.id, {
      modelRef: 'codex-cli/test-model' as CliModelCapabilities['ref'],
      options: { speed: 'fast' },
    });
    const after = await fake.client.sessions.get(session.id);
    expect(
      after.session.cliOptions?.['codex-cli/test-model' as CliModelCapabilities['ref']],
    ).toEqual({
      effort: 'high',
      speed: 'fast',
    });
    // A different model's options are stored independently and never clobber the first model.
    await fake.client.sessions.updateCliOptions(session.id, {
      modelRef: 'claude-code-cli/other' as CliModelCapabilities['ref'],
      options: { effort: 'max' },
    });
    const both = await fake.client.sessions.get(session.id);
    expect(
      both.session.cliOptions?.['codex-cli/test-model' as CliModelCapabilities['ref']],
    ).toEqual({
      effort: 'high',
      speed: 'fast',
    });
    expect(
      both.session.cliOptions?.['claude-code-cli/other' as CliModelCapabilities['ref']],
    ).toEqual({
      effort: 'max',
      speed: 'standard',
    });
  });
});
