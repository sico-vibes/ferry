import { afterEach, describe, expect, it } from 'vitest';
import { ProfileSchema, ProviderIdSchema, type Profile, type ProfileId } from '@ferry/shared';
import { createMockFerryClient, type MockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';

const provider = (id: string) => ProviderIdSchema.parse(id);

type PreviewOverrides = Omit<Partial<Profile>, 'id'> & { id?: ProfileId | string };

const BASE: Profile = {
  id: 'profile_builtin_auto_free' as Profile['id'],
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

function preview(overrides: PreviewOverrides = {}): Profile {
  return ProfileSchema.parse({
    ...BASE,
    id: 'profile_optimized_preview',
    name: 'Optimized for this device',
    builtin: false,
    pinned: true,
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

let client: MockFerryClient | undefined;
afterEach(() => {
  client = undefined;
});

function makeClient(): MockFerryClient {
  client = createMockFerryClient({
    clock: createFakeClock(new Date('2026-09-23T21:47:00.000Z')).clock,
    behavior: 'test',
  });
  return client;
}

describe('mock managed optimized profile apply/undo', () => {
  it('creates, activates and emits settings.updated', async () => {
    const c = makeClient();
    const events: string[] = [];
    const off = c.on('settings.updated', (settings) => events.push(settings.activeProfileId));
    const result = await c.profiles.applyOptimized(preview({ id: 'profile_optimized_mock_a' }));
    off();
    expect(result.profile.provenance?.managedSlot).toBe('device-optimized');
    expect(result.undoId).toMatch(/^optimized_undo_/);
    expect(managedIn(await c.profiles.list())).toHaveLength(1);
    expect((await c.settings.get()).activeProfileId).toBe(result.profile.id);
    expect(events.at(-1)).toBe(result.profile.id);
  });

  it('adopts the newest legacy generated ID and supersedes older versions', async () => {
    const c = makeClient();
    await c.profiles.save(legacy('profile_optimized_old_one', '2026-01-01T00:00:00.000Z'));
    await c.profiles.save(legacy('profile_optimized_old_two', '2026-01-05T00:00:00.000Z'));
    const result = await c.profiles.applyOptimized(preview({ id: 'profile_optimized_brand_new' }));
    expect(result.profile.id).toBe('profile_optimized_old_two');
    const list = await c.profiles.list();
    expect(list.some((profile) => profile.id === 'profile_optimized_brand_new')).toBe(false);
    expect(
      list.find((profile) => profile.id === 'profile_optimized_old_one')?.provenance?.supersededBy,
    ).toBe('profile_optimized_old_two');
  });

  it('never adopts a user copy carrying the evidence', async () => {
    const c = makeClient();
    await c.profiles.save(
      ProfileSchema.parse({
        ...preview(),
        id: 'profile_custom_copy',
        name: 'Optimized for this device',
      }),
    );
    const result = await c.profiles.applyOptimized(preview({ id: 'profile_optimized_fresh' }));
    expect(result.profile.id).toBe('profile_optimized_fresh');
    const copy = (await c.profiles.list()).find((profile) => profile.id === 'profile_custom_copy');
    expect(copy?.provenance?.managedSlot).toBeUndefined();
    expect(copy?.provenance?.supersededBy).toBeUndefined();
  });

  it('updates one managed ID on repeated apply and restores prior contents', async () => {
    const c = makeClient();
    const first = await c.profiles.applyOptimized(
      preview({
        id: 'profile_optimized_repeat_a',
        fallbackChain: [{ provider: provider('groq'), patterns: ['first'] }],
      }),
    );
    const second = await c.profiles.applyOptimized(
      preview({
        id: 'profile_optimized_repeat_b',
        fallbackChain: [{ provider: provider('gemini'), patterns: ['second'] }],
      }),
    );
    expect(second.profile.id).toBe(first.profile.id);
    expect(managedIn(await c.profiles.list())).toHaveLength(1);
    await c.profiles.undoOptimized(second.undoId);
    const restored = managedIn(await c.profiles.list())[0];
    expect(restored?.fallbackChain).toEqual([{ provider: 'groq', patterns: ['first'] }]);
  });

  it('reports conflict for stale/consumed tokens and intervening edits without overwriting', async () => {
    const c = makeClient();
    const created = await c.profiles.applyOptimized(preview({ id: 'profile_optimized_consume' }));
    await c.profiles.undoOptimized(created.undoId);
    await expect(c.profiles.undoOptimized(created.undoId)).rejects.toThrow(/stale|already used/i);

    const applied = await c.profiles.applyOptimized(preview({ id: 'profile_optimized_edit' }));
    const managed = managedIn(await c.profiles.list())[0];
    if (!managed) throw new Error('managed profile missing');
    await c.profiles.save({ ...managed, description: 'edited later' });
    await expect(c.profiles.undoOptimized(applied.undoId)).rejects.toThrow(/changed/i);
    expect(managedIn(await c.profiles.list())[0]?.description).toBe('edited later');
  });

  it('keeps a newly bound profile and restores the active selection on undo', async () => {
    const c = makeClient();
    const beforeActive = (await c.settings.get()).activeProfileId;
    const session = (await c.sessions.list())[0];
    if (!session) throw new Error('Session fixture missing');
    const applied = await c.profiles.applyOptimized(preview({ id: 'profile_optimized_bound' }));
    await c.profiles.activate(applied.profile.id, session.id);
    await c.profiles.undoOptimized(applied.undoId);
    expect((await c.profiles.list()).some((p) => p.id === applied.profile.id)).toBe(true);
    expect((await c.sessions.get(session.id)).session.profileId).toBe(applied.profile.id);
    expect((await c.settings.get()).activeProfileId).toBe(beforeActive);
  });

  it('rejects builtin and custom id collisions', async () => {
    const c = makeClient();
    await expect(c.profiles.applyOptimized(preview({ id: 'profile_best' }))).rejects.toThrow(
      /reserved/i,
    );
    await c.profiles.save(ProfileSchema.parse({ ...preview(), id: 'profile_custom_clash' }));
    await expect(
      c.profiles.applyOptimized(preview({ id: 'profile_custom_clash' })),
    ).rejects.toThrow(/already uses/i);
    expect(managedIn(await c.profiles.list())).toHaveLength(0);
  });

  it('keeps a new profile bound by a Gateway key on undo', async () => {
    const c = makeClient();
    const beforeActive = (await c.settings.get()).activeProfileId;
    const applied = await c.profiles.applyOptimized(preview({ id: 'profile_optimized_gw_bound' }));
    await c.gateway.createKey({ name: 'bound key', profile: applied.profile.id });
    await c.profiles.undoOptimized(applied.undoId);
    expect((await c.profiles.list()).some((p) => p.id === applied.profile.id)).toBe(true);
    expect((await c.gateway.listKeys()).find((key) => key.name === 'bound key')?.profile).toBe(
      applied.profile.id,
    );
    expect((await c.settings.get()).activeProfileId).toBe(beforeActive);
  });

  it('keeps a new profile bound as a workspace default on undo', async () => {
    const c = makeClient();
    const applied = await c.profiles.applyOptimized(preview({ id: 'profile_optimized_ws_bound' }));
    const workspace = (await c.workspaces.list())[0];
    if (!workspace) throw new Error('Workspace fixture missing');
    await c.workspaces.update(workspace.id, {
      settings: { defaultProfileId: applied.profile.id },
    });
    await c.profiles.undoOptimized(applied.undoId);
    expect((await c.profiles.list()).some((p) => p.id === applied.profile.id)).toBe(true);
    expect(
      (await c.workspaces.list()).find((w) => w.id === workspace.id)?.settings.defaultProfileId,
    ).toBe(applied.profile.id);
  });

  it('conflicts without changes when the previously active profile was removed', async () => {
    const c = makeClient();
    const prev = await c.profiles.save(
      ProfileSchema.parse({ ...preview(), id: 'profile_custom_prev', name: 'Previous' }),
    );
    await c.profiles.activate(prev.id);
    await c.settings.update({ theme: 'light' });
    const applied = await c.profiles.applyOptimized(preview({ id: 'profile_optimized_prev_gone' }));
    await c.profiles.remove(prev.id);
    await expect(c.profiles.undoOptimized(applied.undoId)).rejects.toThrow(/no longer exists/i);
    const list = await c.profiles.list();
    expect(managedIn(list)).toHaveLength(1);
    expect(list.some((p) => p.id === prev.id)).toBe(false);
    const settings = await c.settings.get();
    expect(settings.activeProfileId).toBe(applied.profile.id);
    expect(settings.theme).toBe('light');
  });
});
