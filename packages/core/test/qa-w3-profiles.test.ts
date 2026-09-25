import { describe, expect, it } from 'vitest';
import type { Profile, ProfileId } from '@ferry/shared';
import { startHarness, textTurn, waitFor } from './qa-w3-harness.js';

function customProfile(overrides: Record<string, unknown> = {}): Profile {
  return {
    id: 'profile_qa_custom' as ProfileId,
    name: 'QA Custom',
    icon: 'sparkles',
    description: 'QA profile',
    builtin: false,
    pinned: false,
    allowedProviders: 'all',
    tierByStep: {
      plan: ['T1', 'T2', 'T3'],
      edit: ['T1', 'T2', 'T3'],
      search: ['T1', 'T2', 'T3'],
      summarize: ['T1', 'T2', 'T3'],
      review: ['T1', 'T2', 'T3'],
      long_context: ['T1', 'T2', 'T3'],
    },
    paidAllowed: false,
    caps: { dailyUsd: null, monthlyUsd: null },
    delegationMode: 'suggest',
    optimizers: {
      terse: 'off',
      toolOutputFilters: true,
      recoveryHandles: true,
      contextHygiene: true,
      rtk: false,
    },
    ...overrides,
  };
}

describe('QA W3 profiles: validation and paid-routing guarantees', () => {
  it('rejects an out-of-range tier in a tier map', async () => {
    const h = await startHarness();
    try {
      const bad = customProfile({
        id: 'profile_qa_bad_tier',
        tierByStep: { plan: ['T9'], edit: ['T2'] },
      });
      await expect(h.rpc.profiles.save(bad)).rejects.toMatchObject({ kind: 'validation' });
      expect((await h.rpc.profiles.list()).some((item) => item.id === bad.id)).toBe(false);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('refuses to overwrite or delete a built-in profile', async () => {
    const h = await startHarness();
    try {
      await expect(
        h.rpc.profiles.save(customProfile({ builtin: true, pinned: false })),
      ).rejects.toMatchObject({ kind: 'validation' });
      await expect(
        h.rpc.profiles.save(customProfile({ id: 'profile_builtin_auto_free' })),
      ).rejects.toMatchObject({ kind: 'validation' });
      await expect(
        h.rpc.profiles.remove('profile_builtin_auto_free' as ProfileId),
      ).rejects.toMatchObject({ kind: 'validation' });
      const builtins = (await h.rpc.profiles.list()).filter((item) => item.builtin);
      expect(builtins.some((item) => item.id === 'profile_builtin_auto_free')).toBe(true);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('rejects activating an unknown profile and creating a session with one', async () => {
    const h = await startHarness();
    try {
      await expect(h.rpc.profiles.activate('profile_ghost' as ProfileId)).rejects.toMatchObject({
        kind: 'not_found',
      });
      await expect(
        h.rpc.sessions.create({
          workspaceId: h.workspaceId,
          profileId: 'profile_ghost' as ProfileId,
        }),
      ).rejects.toMatchObject({ kind: 'not_found' });
    } finally {
      await h.close();
    }
  }, 30_000);

  it('never routes a paid-disallowed custom profile to a paid model', async () => {
    const h = await startHarness({ turns: [textTurn('free path only')] });
    try {
      const paidExists = h.services.catalog.models.some(
        (model) => model.providerId === 'openrouter' && !model.free && model.toolCalling,
      );
      expect(paidExists).toBe(true);
      const profile = customProfile({ paidAllowed: false, allowedProviders: 'all' });
      await h.rpc.profiles.save(profile);
      const session = await h.rpc.sessions.create({
        workspaceId: h.workspaceId,
        profileId: profile.id,
      });
      await h.rpc.sessions.send(session.id, { text: 'pick a free model' });
      await waitFor(async () => (await h.rpc.sessions.get(session.id)).session.status === 'idle');
      const selected = (await h.rpc.sessions.get(session.id)).session.modelRef;
      expect(selected).not.toBeNull();
      const model = h.services.catalog.models.find((item) => item.ref === selected);
      expect(model?.free).toBe(true);
      // The provider was actually asked to run that free model.
      const body = h.server.requests.at(0)?.body as { model?: string } | undefined;
      expect(typeof body?.model).toBe('string');
      const requested = h.services.catalog.models.find(
        (item) => item.ref === `openrouter/${body?.model ?? ''}`,
      );
      expect(requested?.free).toBe(true);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('lists a saved custom profile and activates it for a session', async () => {
    const h = await startHarness();
    try {
      const profile = customProfile({ id: 'profile_qa_activate' });
      await h.rpc.profiles.save(profile);
      const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
      await h.rpc.profiles.activate(profile.id, session.id);
      expect((await h.rpc.sessions.get(session.id)).session.profileId).toBe(profile.id);
      await h.rpc.profiles.remove(profile.id);
      expect((await h.rpc.profiles.list()).some((item) => item.id === profile.id)).toBe(false);
    } finally {
      await h.close();
    }
  }, 30_000);
});
