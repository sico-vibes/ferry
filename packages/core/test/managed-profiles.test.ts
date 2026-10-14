import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockFerryClient, createRpcFerryClient, type RpcFerryClient } from '@ferry/client';
import { ProfileIdSchema, ProfileSchema, ProviderIdSchema, type Profile } from '@ferry/shared';
import { createCoreHost, createMemoryTransportPair, type CoreHost } from '../src/index.js';
import type { FerryServices } from '../src/index.js';

const provider = (id: string) => ProviderIdSchema.parse(id);

const BASE: Profile = {
  id: ProfileIdSchema.parse('profile_builtin_auto_free'),
  name: 'Auto-Free',
  icon: 'sparkles',
  description: 'Free routes only',
  affinityMode: 'soft',
  builtin: true,
  pinned: false,
  allowedProviders: 'all_free',
  tierByStep: {
    plan: ['T1'],
    edit: ['T1'],
    search: ['T1'],
    summarize: ['T1'],
    review: ['T1'],
    long_context: ['T1'],
  },
  paidAllowed: false,
  caps: { dailyUsd: null, monthlyUsd: null },
  paidConfirmation: { preauthorize: false, confirmSubscriptions: false, confirmTrials: false },
  delegationMode: 'suggest',
  optimizers: {
    terse: 'off',
    cavemanInput: 'off',
    toolOutputFilters: true,
    recoveryHandles: true,
    contextHygiene: true,
    rtk: false,
  },
  roles: {
    enabled: false,
    plannerModelRef: null,
    editorModelRef: null,
    editorFailureThreshold: 2,
  },
};

function preview(overrides: Partial<Profile> = {}): Profile {
  return ProfileSchema.parse({
    ...BASE,
    id: 'profile_optimized_preview',
    name: 'Optimized for this device',
    builtin: false,
    pinned: true,
    allowedProviders: 'all_free',
    paidAllowed: false,
    fallbackChain: [{ provider: 'groq', patterns: ['qwen/qwen3.8-27b'] }],
    provenance: {
      kind: 'provider-check',
      generatedAt: '2026-01-10T00:00:00.000Z',
      sampleCount: 1,
      note: 'measured on this device',
    },
    ...overrides,
  });
}

function legacy(id: string, generatedAt: string): Profile {
  return ProfileSchema.parse({
    ...preview(),
    id,
    fallbackChain: [{ provider: 'groq', patterns: ['legacy-model'] }],
    provenance: {
      kind: 'provider-check',
      generatedAt,
      sampleCount: 1,
      note: 'legacy generation',
    },
  });
}

const managedIn = (profiles: readonly Profile[]) =>
  profiles.filter((profile) => profile.provenance?.managedSlot === 'device-optimized');

interface Harness {
  root: string;
  host: CoreHost;
  rpc: RpcFerryClient;
  services: FerryServices;
  close(): Promise<void>;
}

async function startCore(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ferry-managed-profiles-'));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const [coreTransport, clientTransport] = createMemoryTransportPair();
  const host = await createCoreHost({
    dataDir,
    transport: coreTransport,
    localControl: false,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FERRY_TEST_KEYRING_NAMESPACE: `ferry-managed-profiles-${String(process.pid)}`,
      FERRY_KEYRING_SERVICE: `Ferry-Managed-Profiles-${String(process.pid)}`,
    },
  });
  const services = host.options.services;
  if (!services) {
    await host.stop();
    throw new Error('Core services were not created');
  }
  const rpc = createRpcFerryClient(clientTransport, { timeoutMs: 30_000 });
  await rpc.hello;
  return {
    root,
    host,
    rpc,
    services,
    async close() {
      rpc.close();
      await host.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    },
  };
}

let active: Harness | undefined;
afterEach(async () => {
  await active?.close();
  active = undefined;
});

describe('managed optimized profile apply/undo', () => {
  it('creates a new managed profile, activates it and emits settings.updated', async () => {
    const h = (active = await startCore());
    const before = (await h.rpc.settings.get()).activeProfileId;
    const events: { activeProfileId: string }[] = [];
    const off = h.rpc.on('settings.updated', (settings) =>
      events.push({ activeProfileId: settings.activeProfileId }),
    );
    const incoming = preview({ id: ProfileIdSchema.parse('profile_optimized_first') });
    const result = await h.rpc.profiles.applyOptimized(incoming);
    off();
    expect(result.profile.id).toBe(incoming.id);
    expect(result.profile.provenance).toMatchObject({ managedSlot: 'device-optimized' });
    expect(result.profile.provenance?.supersededBy).toBeUndefined();
    expect(result.undoId).toMatch(/^optimized_undo_/);
    const stored = managedIn(await h.rpc.profiles.list());
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(incoming.id);
    expect((await h.rpc.settings.get()).activeProfileId).toBe(incoming.id);
    expect(events.at(-1)?.activeProfileId).toBe(incoming.id);
    expect(before).not.toBe(incoming.id);
  }, 30_000);

  it('adopts the newest legacy generated ID and supersedes the older versions', async () => {
    const h = (active = await startCore());
    await h.rpc.profiles.save(legacy('profile_optimized_old_one', '2026-01-01T00:00:00.000Z'));
    await h.rpc.profiles.save(legacy('profile_optimized_old_two', '2026-01-05T00:00:00.000Z'));
    const result = await h.rpc.profiles.applyOptimized(
      preview({ id: ProfileIdSchema.parse('profile_optimized_brand_new') }),
    );
    expect(result.profile.id).toBe('profile_optimized_old_two');
    const list = await h.rpc.profiles.list();
    expect(list.some((profile) => profile.id === 'profile_optimized_brand_new')).toBe(false);
    const older = list.find((profile) => profile.id === 'profile_optimized_old_one');
    expect(older?.provenance?.supersededBy).toBe('profile_optimized_old_two');
    expect(older?.provenance?.managedSlot).toBeUndefined();
    const newest = managedIn(list)[0];
    expect(newest?.id).toBe('profile_optimized_old_two');
  }, 30_000);

  it('updates one managed ID on repeated Apply and restores prior contents on Undo', async () => {
    const h = (active = await startCore());
    const first = await h.rpc.profiles.applyOptimized(
      preview({
        id: ProfileIdSchema.parse('profile_optimized_repeat_a'),
        fallbackChain: [{ provider: provider('groq'), patterns: ['first-model'] }],
      }),
    );
    const second = await h.rpc.profiles.applyOptimized(
      preview({
        id: ProfileIdSchema.parse('profile_optimized_repeat_b'),
        fallbackChain: [{ provider: provider('gemini'), patterns: ['second-model'] }],
      }),
    );
    expect(second.profile.id).toBe(first.profile.id);
    expect(managedIn(await h.rpc.profiles.list())).toHaveLength(1);
    expect(second.profile.fallbackChain).toEqual([
      { provider: 'gemini', patterns: ['second-model'] },
    ]);
    await h.rpc.profiles.undoOptimized(second.undoId);
    const restored = managedIn(await h.rpc.profiles.list())[0];
    expect(restored?.id).toBe(first.profile.id);
    expect(restored?.fallbackChain).toEqual([{ provider: 'groq', patterns: ['first-model'] }]);
  }, 30_000);

  it('leaves a user-owned copy that carries the evidence untouched', async () => {
    const h = (active = await startCore());
    const copy = await h.rpc.profiles.save(
      ProfileSchema.parse({
        ...preview(),
        id: 'profile_custom_copy',
        name: 'Optimized for this device',
      }),
    );
    const result = await h.rpc.profiles.applyOptimized(
      preview({ id: ProfileIdSchema.parse('profile_optimized_fresh') }),
    );
    expect(result.profile.id).toBe('profile_optimized_fresh');
    const stored = (await h.rpc.profiles.list()).find((profile) => profile.id === copy.id);
    expect(stored?.provenance?.managedSlot).toBeUndefined();
    expect(stored?.provenance?.supersededBy).toBeUndefined();
    expect(stored?.name).toBe('Optimized for this device');
  }, 30_000);

  it('rejects built-in and custom ID collisions when creating', async () => {
    const h = (active = await startCore());
    await expect(
      h.rpc.profiles.applyOptimized(
        preview({ id: ProfileIdSchema.parse('profile_builtin_auto_free') }),
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
    await h.rpc.profiles.save(
      ProfileSchema.parse({ ...preview(), id: 'profile_custom_clash', builtin: false }),
    );
    await expect(
      h.rpc.profiles.applyOptimized(preview({ id: ProfileIdSchema.parse('profile_custom_clash') })),
    ).rejects.toMatchObject({ kind: 'conflict' });
    expect(managedIn(await h.rpc.profiles.list())).toHaveLength(0);
  }, 30_000);

  it('keeps older generated profiles, Gateway keys and session refs intact after apply', async () => {
    const h = (active = await startCore());
    await h.rpc.profiles.save(legacy('profile_optimized_old_one', '2026-01-01T00:00:00.000Z'));
    await h.rpc.profiles.save(legacy('profile_optimized_old_two', '2026-01-05T00:00:00.000Z'));
    const session = await h.rpc.sessions.create({
      profileId: ProfileIdSchema.parse('profile_optimized_old_one'),
    });
    await h.rpc.gateway.createKey({ name: 'bound key', profile: 'profile_optimized_old_one' });
    await h.rpc.profiles.applyOptimized(
      preview({ id: ProfileIdSchema.parse('profile_optimized_adopt_me') }),
    );
    const list = await h.rpc.profiles.list();
    expect(list.some((profile) => profile.id === 'profile_optimized_old_one')).toBe(true);
    expect(list.some((profile) => profile.id === 'profile_optimized_old_two')).toBe(true);
    expect((await h.rpc.sessions.get(session.id)).session.profileId).toBe(
      'profile_optimized_old_one',
    );
    const keys = await h.rpc.gateway.listKeys();
    expect(keys.find((key) => key.name === 'bound key')?.profile).toBe('profile_optimized_old_one');
  }, 30_000);

  it('undo restores exact contents, lineage and active selection while preserving unrelated settings', async () => {
    const h = (active = await startCore());
    await h.rpc.settings.update({ theme: 'light' });
    await h.rpc.profiles.save(
      ProfileSchema.parse({ ...preview(), id: 'profile_custom_keep', name: 'Keep me' }),
    );
    await h.rpc.profiles.save(legacy('profile_optimized_old_one', '2026-01-01T00:00:00.000Z'));
    await h.rpc.profiles.save(legacy('profile_optimized_old_two', '2026-01-05T00:00:00.000Z'));
    const beforeActive = (await h.rpc.settings.get()).activeProfileId;
    const applied = await h.rpc.profiles.applyOptimized(
      preview({ id: ProfileIdSchema.parse('profile_optimized_undo_me') }),
    );
    expect(applied.profile.id).toBe('profile_optimized_old_two');
    await h.rpc.profiles.undoOptimized(applied.undoId);
    const list = await h.rpc.profiles.list();
    expect(managedIn(list)).toHaveLength(0);
    const restored = list.find((profile) => profile.id === 'profile_optimized_old_two');
    expect(restored?.provenance?.managedSlot).toBeUndefined();
    expect(restored?.provenance?.supersededBy).toBeUndefined();
    expect(restored?.fallbackChain).toEqual([{ provider: 'groq', patterns: ['legacy-model'] }]);
    const older = list.find((profile) => profile.id === 'profile_optimized_old_one');
    expect(older?.provenance?.supersededBy).toBeUndefined();
    const settings = await h.rpc.settings.get();
    expect(settings.activeProfileId).toBe(beforeActive);
    expect(settings.theme).toBe('light');
    expect(list.find((profile) => profile.id === 'profile_custom_keep')?.name).toBe('Keep me');
  }, 30_000);

  it('returns conflict for consumed, stale and intervening-edit tokens without overwriting', async () => {
    const h = (active = await startCore());
    const created = await h.rpc.profiles.applyOptimized(
      preview({ id: ProfileIdSchema.parse('profile_optimized_consume') }),
    );
    await h.rpc.profiles.undoOptimized(created.undoId);
    await expect(h.rpc.profiles.undoOptimized(created.undoId)).rejects.toMatchObject({
      kind: 'conflict',
    });

    const first = await h.rpc.profiles.applyOptimized(
      preview({ id: ProfileIdSchema.parse('profile_optimized_stale_a') }),
    );
    const second = await h.rpc.profiles.applyOptimized(
      preview({
        id: ProfileIdSchema.parse('profile_optimized_stale_b'),
        fallbackChain: [{ provider: provider('gemini'), patterns: ['stale-second'] }],
      }),
    );
    await expect(h.rpc.profiles.undoOptimized(first.undoId)).rejects.toMatchObject({
      kind: 'conflict',
    });

    const managed = managedIn(await h.rpc.profiles.list())[0];
    if (!managed) throw new Error('managed profile missing');
    await h.rpc.profiles.save({ ...managed, description: 'user edited after apply' });
    await expect(h.rpc.profiles.undoOptimized(second.undoId)).rejects.toMatchObject({
      kind: 'conflict',
    });
    const after = managedIn(await h.rpc.profiles.list())[0];
    expect(after?.description).toBe('user edited after apply');
    expect(h.services.settings.get('optimized-profile-undo')).toBeDefined();
  }, 30_000);

  it('keeps a new profile that a session bound after apply, and restores the active selection', async () => {
    const h = (active = await startCore());
    const beforeActive = (await h.rpc.settings.get()).activeProfileId;
    const applied = await h.rpc.profiles.applyOptimized(
      preview({ id: ProfileIdSchema.parse('profile_optimized_bound') }),
    );
    const session = await h.rpc.sessions.create({ profileId: applied.profile.id });
    await h.rpc.profiles.undoOptimized(applied.undoId);
    expect((await h.rpc.profiles.list()).some((profile) => profile.id === applied.profile.id)).toBe(
      true,
    );
    expect((await h.rpc.sessions.get(session.id)).session.profileId).toBe(applied.profile.id);
    expect((await h.rpc.settings.get()).activeProfileId).toBe(beforeActive);
  }, 30_000);

  it('serializes concurrent Apply without duplicating the managed slot', async () => {
    const h = (active = await startCore());
    const [a, b] = await Promise.all([
      h.rpc.profiles.applyOptimized(
        preview({
          id: ProfileIdSchema.parse('profile_optimized_race_a'),
          fallbackChain: [{ provider: provider('groq'), patterns: ['race-a'] }],
        }),
      ),
      h.rpc.profiles.applyOptimized(
        preview({
          id: ProfileIdSchema.parse('profile_optimized_race_b'),
          fallbackChain: [{ provider: provider('gemini'), patterns: ['race-b'] }],
        }),
      ),
    ]);
    const list = await h.rpc.profiles.list();
    const managed = managedIn(list);
    expect(managed).toHaveLength(1);
    expect(new Set([a.profile.id, b.profile.id]).size).toBe(1);
    const ids = list.map((profile) => profile.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 30_000);

  it('rolls back fully when a write fails mid-transaction', async () => {
    const h = (active = await startCore());
    const beforeActive = (await h.rpc.settings.get()).activeProfileId;
    h.services.db.client.exec(
      "CREATE TRIGGER managed_profile_rollback BEFORE INSERT ON settings_kv WHEN NEW.key='global' BEGIN SELECT RAISE(ABORT, 'rollback fixture'); END;",
    );
    await expect(
      h.rpc.profiles.applyOptimized(
        preview({ id: ProfileIdSchema.parse('profile_optimized_rollback') }),
      ),
    ).rejects.toBeTruthy();
    expect(managedIn(await h.rpc.profiles.list())).toHaveLength(0);
    expect((await h.rpc.settings.get()).activeProfileId).toBe(beforeActive);
    expect(h.services.settings.get('optimized-profile-undo')).toBeUndefined();
  }, 30_000);

  it('matches the mock client for adoption and undo', async () => {
    const h = (active = await startCore());
    const mock = createMockFerryClient({ behavior: 'test' });
    const seed = legacy('profile_optimized_parity_old', '2026-01-03T00:00:00.000Z');
    await h.rpc.profiles.save(seed);
    await mock.profiles.save(seed);
    const incoming = preview({
      id: ProfileIdSchema.parse('profile_optimized_parity_new'),
      fallbackChain: [{ provider: provider('groq'), patterns: ['parity-model'] }],
    });
    const coreResult = await h.rpc.profiles.applyOptimized(incoming);
    const mockResult = await mock.profiles.applyOptimized(incoming);
    expect(coreResult.profile.id).toBe(seed.id);
    expect(mockResult.profile.id).toBe(seed.id);
    expect(coreResult.profile.provenance?.managedSlot).toBe('device-optimized');
    expect(mockResult.profile.provenance?.managedSlot).toBe('device-optimized');
    expect(coreResult.profile.fallbackChain).toEqual(mockResult.profile.fallbackChain);
    await h.rpc.profiles.undoOptimized(coreResult.undoId);
    await mock.profiles.undoOptimized(mockResult.undoId);
    expect(managedIn(await h.rpc.profiles.list())).toHaveLength(0);
    expect(managedIn(await mock.profiles.list())).toHaveLength(0);
  }, 30_000);

  it('keeps a new profile bound by a Gateway key on undo', async () => {
    const h = (active = await startCore());
    const beforeActive = (await h.rpc.settings.get()).activeProfileId;
    const applied = await h.rpc.profiles.applyOptimized(
      preview({ id: ProfileIdSchema.parse('profile_optimized_gw_bound') }),
    );
    await h.rpc.gateway.createKey({ name: 'bound key', profile: applied.profile.id });
    await h.rpc.profiles.undoOptimized(applied.undoId);
    expect(managedIn(await h.rpc.profiles.list())).toHaveLength(1);
    expect((await h.rpc.gateway.listKeys()).find((key) => key.name === 'bound key')?.profile).toBe(
      applied.profile.id,
    );
    expect((await h.rpc.settings.get()).activeProfileId).toBe(beforeActive);
  }, 30_000);

  it('keeps a new profile bound as a workspace default on undo', async () => {
    const h = (active = await startCore());
    const applied = await h.rpc.profiles.applyOptimized(
      preview({ id: ProfileIdSchema.parse('profile_optimized_ws_bound') }),
    );
    const workspacePath = join(h.root, 'ws');
    await mkdir(workspacePath, { recursive: true });
    const workspace = await h.rpc.workspaces.open(workspacePath);
    await h.rpc.workspaces.update(workspace.id, {
      settings: { defaultProfileId: applied.profile.id },
    });
    await h.rpc.profiles.undoOptimized(applied.undoId);
    expect(managedIn(await h.rpc.profiles.list())).toHaveLength(1);
    const stored = (await h.rpc.workspaces.list()).find((item) => item.id === workspace.id);
    expect(stored?.settings.defaultProfileId).toBe(applied.profile.id);
  }, 30_000);

  it('conflicts without changes when the previously active profile was removed', async () => {
    const h = (active = await startCore());
    const prev = await h.rpc.profiles.save(
      ProfileSchema.parse({ ...preview(), id: 'profile_custom_prev', name: 'Previous' }),
    );
    await h.rpc.profiles.activate(prev.id);
    await h.rpc.settings.update({ theme: 'light' });
    const applied = await h.rpc.profiles.applyOptimized(
      preview({ id: ProfileIdSchema.parse('profile_optimized_prev_gone') }),
    );
    await h.rpc.profiles.remove(prev.id);
    await expect(h.rpc.profiles.undoOptimized(applied.undoId)).rejects.toMatchObject({
      kind: 'conflict',
    });
    const list = await h.rpc.profiles.list();
    expect(managedIn(list)).toHaveLength(1);
    expect(list.some((profile) => profile.id === prev.id)).toBe(false);
    const settings = await h.rpc.settings.get();
    expect(settings.activeProfileId).toBe(applied.profile.id);
    expect(settings.theme).toBe('light');
  }, 30_000);

  it('matches the mock client when bindings retain a new profile on undo', async () => {
    const h = (active = await startCore());
    const mock = createMockFerryClient({ behavior: 'test' });
    const incoming = preview({ id: ProfileIdSchema.parse('profile_optimized_parity_bound') });
    const coreApplied = await h.rpc.profiles.applyOptimized(incoming);
    const mockApplied = await mock.profiles.applyOptimized(incoming);
    await h.rpc.gateway.createKey({ name: 'parity key', profile: coreApplied.profile.id });
    await mock.gateway.createKey({ name: 'parity key', profile: mockApplied.profile.id });
    const workspacePath = join(h.root, 'parity-ws');
    await mkdir(workspacePath, { recursive: true });
    const coreWorkspace = await h.rpc.workspaces.open(workspacePath);
    await h.rpc.workspaces.update(coreWorkspace.id, {
      settings: { defaultProfileId: coreApplied.profile.id },
    });
    const mockWorkspace = (await mock.workspaces.list())[0];
    if (!mockWorkspace) throw new Error('Mock workspace fixture missing');
    await mock.workspaces.update(mockWorkspace.id, {
      settings: { defaultProfileId: mockApplied.profile.id },
    });
    await h.rpc.profiles.undoOptimized(coreApplied.undoId);
    await mock.profiles.undoOptimized(mockApplied.undoId);
    expect(
      managedIn(await h.rpc.profiles.list()).some((p) => p.id === coreApplied.profile.id),
    ).toBe(true);
    expect(managedIn(await mock.profiles.list()).some((p) => p.id === mockApplied.profile.id)).toBe(
      true,
    );
    expect((await h.rpc.gateway.listKeys()).find((key) => key.name === 'parity key')?.profile).toBe(
      coreApplied.profile.id,
    );
    expect((await mock.gateway.listKeys()).find((key) => key.name === 'parity key')?.profile).toBe(
      mockApplied.profile.id,
    );
  }, 30_000);

  it('matches the mock client when the previous active profile was removed', async () => {
    const h = (active = await startCore());
    const mock = createMockFerryClient({ behavior: 'test' });
    const prev = ProfileSchema.parse({ ...preview(), id: 'profile_custom_parity_prev' });
    await h.rpc.profiles.save(prev);
    await mock.profiles.save(prev);
    await h.rpc.profiles.activate(prev.id);
    await mock.profiles.activate(prev.id);
    const coreApplied = await h.rpc.profiles.applyOptimized(
      preview({ id: ProfileIdSchema.parse('profile_optimized_parity_gone_core') }),
    );
    const mockApplied = await mock.profiles.applyOptimized(
      preview({ id: ProfileIdSchema.parse('profile_optimized_parity_gone_mock') }),
    );
    await h.rpc.profiles.remove(prev.id);
    await mock.profiles.remove(prev.id);
    await expect(h.rpc.profiles.undoOptimized(coreApplied.undoId)).rejects.toMatchObject({
      kind: 'conflict',
    });
    await expect(mock.profiles.undoOptimized(mockApplied.undoId)).rejects.toMatchObject({
      kind: 'conflict',
    });
    expect(managedIn(await h.rpc.profiles.list())).toHaveLength(1);
    expect(managedIn(await mock.profiles.list())).toHaveLength(1);
  }, 30_000);
});
