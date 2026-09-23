import { describe, expect, it } from 'vitest';
import type { Profile } from '@ferry/shared';
import { createMockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';

const now = new Date('2026-09-23T21:47:00.000Z');
const makeClient = () => createMockFerryClient({ clock: createFakeClock(now).clock });

describe('QA profiles domain', () => {
  it('refuses to remove builtin profiles', async () => {
    const client = makeClient();
    const builtin = (await client.profiles.list()).find((profile) => profile.builtin);
    if (!builtin) throw new Error('Builtin profile fixture missing');

    await expect(client.profiles.remove(builtin.id)).rejects.toThrow(/builtin/i);
    expect((await client.profiles.list()).some((profile) => profile.id === builtin.id)).toBe(true);
  });

  it('upserts a saved profile without duplicating it', async () => {
    const client = makeClient();
    const base = (await client.profiles.list())[0];
    if (!base) throw new Error('Profile fixture missing');

    const custom: Profile = {
      ...base,
      id: 'profile_qa_upsert' as Profile['id'],
      name: 'QA Custom',
      builtin: false,
    };
    await client.profiles.save(custom);
    expect(
      (await client.profiles.list()).filter((profile) => profile.id === custom.id),
    ).toHaveLength(1);

    const updated = await client.profiles.save({ ...custom, name: 'QA Custom v2' });
    expect(updated.name).toBe('QA Custom v2');
    const stored = (await client.profiles.list()).filter((profile) => profile.id === custom.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('QA Custom v2');
  });

  it('activate with a sessionId changes only that session', async () => {
    const client = makeClient();
    const sessions = await client.sessions.list();
    const first = sessions[0];
    const second = sessions[1];
    if (!first || !second) throw new Error('Session fixtures missing');

    const target = (await client.profiles.list()).find((profile) => profile.id !== first.profileId);
    if (!target) throw new Error('Alternative profile fixture missing');

    await client.profiles.activate(target.id, first.id);

    expect((await client.sessions.get(first.id)).session.profileId).toBe(target.id);
    expect((await client.sessions.get(second.id)).session.profileId).toBe(second.profileId);
    expect((await client.settings.get()).activeProfileId).toBe('profile_best');
  });

  it('activate without a sessionId changes the global active profile', async () => {
    const client = makeClient();
    await client.profiles.activate('profile_fast' as Profile['id']);
    expect((await client.settings.get()).activeProfileId).toBe('profile_fast');
  });
});
