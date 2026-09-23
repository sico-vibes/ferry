import { describe, expect, it } from 'vitest';
import type { Profile } from '@ferry/shared';
import { createMockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';
import { memoryStorage } from '../src/mock/storage.js';

const now = new Date('2026-09-23T21:47:00.000Z');
const clock = () => createFakeClock(now).clock;

describe('QA persistence', () => {
  it('restores stars, pins, settings, provider keys and profile edits', async () => {
    const storage = memoryStorage();
    const first = createMockFerryClient({ storage, clock: clock() });
    const workspace = (await first.workspaces.list())[0];
    const profile = (await first.profiles.list())[0];
    if (!workspace || !profile) throw new Error('Fixtures missing');

    const openrouter = (await first.providers.list()).find((item) => item.id === 'openrouter');
    if (!openrouter) throw new Error('OpenRouter fixture missing');

    const session = await first.sessions.create({ workspaceId: workspace.id, title: 'Persist me' });
    await first.sessions.setStarred(session.id, true);
    await first.sessions.setPinned(session.id, true);
    await first.sessions.rename(session.id, 'Persist me v2');
    await first.settings.update({ theme: 'light', fontScale: 1.2 });
    await first.providers.setKey(openrouter.id, 'sk-test-key');
    await first.profiles.save({ ...profile, name: 'Edited Profile' });

    const restored = createMockFerryClient({ storage, clock: clock() });
    const restoredSession = (await restored.sessions.get(session.id)).session;
    expect(restoredSession.starred).toBe(true);
    expect(restoredSession.pinned).toBe(true);
    expect(restoredSession.title).toBe('Persist me v2');

    const settings = await restored.settings.get();
    expect(settings.theme).toBe('light');
    expect(settings.fontScale).toBe(1.2);

    const provider = (await restored.providers.list()).find((item) => item.id === 'openrouter');
    expect(provider?.keyStatus).toBe('unchecked');
    const providerState = restored.__state().providers.find((item) => item.id === 'openrouter');
    expect(providerState?.dailyStepBudget).toBe(382);

    const restoredProfile = (await restored.profiles.list()).find((item) => item.id === profile.id);
    expect(restoredProfile?.name).toBe('Edited Profile');
  });

  it('falls back to fixtures when the persisted version is unknown', async () => {
    const storage = { load: () => ({ version: 99, data: {} }), save: () => undefined };
    const client = createMockFerryClient({ storage, clock: clock() });
    expect(await client.sessions.list()).toHaveLength(12);
    expect((await client.settings.get()).theme).toBe('dark');
  });

  it('falls back to fixtures when storage is garbage or schema-invalid', async () => {
    const garbage = { load: () => 'not-json', save: () => undefined };
    expect(await createMockFerryClient({ storage: garbage }).workspaces.list()).toHaveLength(3);

    const nullData = { load: () => ({ version: 1, data: null }), save: () => undefined };
    expect(await createMockFerryClient({ storage: nullData }).providers.list()).toHaveLength(13);

    const invalid = {
      load: () => ({ version: 1, data: { workspaces: [{ bad: true }] } }),
      save: () => undefined,
    };
    expect(await createMockFerryClient({ storage: invalid }).profiles.list()).toHaveLength(4);
  });

  it('falls back to fixtures when the storage adapter itself throws', async () => {
    const throwing = {
      load: (): unknown => {
        throw new Error('corrupt storage');
      },
      save: () => undefined,
    };
    expect(await createMockFerryClient({ storage: throwing }).sessions.list()).toHaveLength(12);
  });

  it('persists a saved custom profile and its removal', async () => {
    const storage = memoryStorage();
    const first = createMockFerryClient({ storage, clock: clock() });
    const base = (await first.profiles.list())[0];
    if (!base) throw new Error('Profile fixture missing');
    const custom: Profile = {
      ...base,
      id: 'profile_qa_custom' as Profile['id'],
      name: 'QA Custom',
      builtin: false,
    };
    await first.profiles.save(custom);

    const restored = createMockFerryClient({ storage, clock: clock() });
    expect((await restored.profiles.list()).some((item) => item.id === custom.id)).toBe(true);
  });
});
