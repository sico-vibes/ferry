import { describe, expect, it } from 'vitest';
import type { Profile, ProviderId } from '@ferry/shared';
import { createMockFerryClient } from '@ferry/client';
import {
  allowedProvidersMode,
  isProfileDirty,
  newProfileFrom,
  newGuidedProfile,
  providerAllowed,
  toggleProvider,
  toggleTier,
} from './profileDraft';

const id = (value: string) => value as ProviderId;
const groq = { id: id('groq'), tag: 'legit' as const };
const openai = { id: id('openai'), tag: 'paid' as const };
const providers = [groq, openai, { id: id('gemini'), tag: 'legit' as const }];

describe('allowed providers', () => {
  it('maps shorthands and lists to a mode', () => {
    expect(allowedProvidersMode('all')).toBe('all');
    expect(allowedProvidersMode('all_free')).toBe('all_free');
    expect(allowedProvidersMode([id('groq')])).toBe('pick');
  });

  it('treats free-only as every non-paid provider', () => {
    expect(providerAllowed('all_free', groq)).toBe(true);
    expect(providerAllowed('all_free', openai)).toBe(false);
  });

  it('expands a shorthand before toggling one provider', () => {
    expect(toggleProvider('all_free', providers, id('gemini'), false)).toEqual([id('groq')]);
    expect(toggleProvider([id('groq')], providers, id('openai'), true)).toEqual([
      id('groq'),
      id('openai'),
    ]);
  });
});

describe('toggleTier', () => {
  const tiers = {
    plan: ['T1'],
    edit: ['T1', 'T2'],
    search: [],
    summarize: [],
    review: [],
    long_context: [],
  } as unknown as Profile['tierByStep'];

  it('adds a tier in T1..T3 order and removes it again', () => {
    expect(toggleTier(tiers, 'plan', 'T3').plan).toEqual(['T1', 'T3']);
    expect(toggleTier(tiers, 'edit', 'T1').edit).toEqual(['T2']);
  });
});

describe('profile drafts', () => {
  it('starts guided profiles free with safe defaults even when the first preset is paid', async () => {
    const profiles = await createMockFerryClient({ behavior: 'test' }).profiles.list();
    const paid = profiles.find((profile) => profile.paidAllowed),
      free = profiles.find((profile) => profile.name === 'Auto-Free');
    if (!paid || !free) throw new Error('Missing presets');
    const guided = newGuidedProfile(
      [paid, { ...free, id: 'profile_fixture_auto' as Profile['id'] }],
      44,
    );
    expect(guided).toMatchObject({
      builtin: false,
      paidAllowed: false,
      allowedProviders: 'all_free',
      roles: { enabled: false },
      paidConfirmation: { preauthorize: false },
      optimizers: { terse: 'off', cavemanInput: 'off' },
    });
    expect(guided?.tierByStep).toEqual(free.tierByStep);
    expect(newGuidedProfile([], 1)).toBeNull();
  });
  const base = { id: 'profile_builtin_auto_free', name: 'Auto-Free', builtin: true } as Profile;

  it('creates an unsaved custom copy', () => {
    const copy = newProfileFrom(base, 'Mine', 42);
    expect(copy).toMatchObject({ id: 'profile_custom_42', name: 'Mine', builtin: false });
  });

  it('preserves optimization evidence while making a copied profile independent of the managed slot', () => {
    const generated: Profile = {
      ...base,
      provenance: {
        kind: 'provider-check',
        generatedAt: '2026-10-14T00:00:00.000Z',
        sampleCount: 3,
        note: 'Measured response time',
        managedSlot: 'device-optimized',
        supersededBy: 'profile_optimized_next' as Profile['id'],
      },
    };
    const copy = newProfileFrom(generated, 'My own routes', 43);
    expect(copy.provenance).toEqual({
      kind: 'provider-check',
      generatedAt: generated.provenance?.generatedAt,
      sampleCount: 3,
      note: 'Measured response time',
    });
    expect(generated.provenance?.managedSlot).toBe('device-optimized');
    expect(generated.provenance?.supersededBy).toBe('profile_optimized_next');
  });

  it('is dirty only when a saved profile differs', () => {
    expect(isProfileDirty(base, base)).toBe(false);
    expect(isProfileDirty({ ...base, name: 'Other' }, base)).toBe(true);
    expect(isProfileDirty(base, undefined)).toBe(false);
  });
});
