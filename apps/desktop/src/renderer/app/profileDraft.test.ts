import { describe, expect, it } from 'vitest';
import type { Profile, ProviderId } from '@ferry/shared';
import {
  allowedProvidersMode,
  isProfileDirty,
  newProfileFrom,
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
  const base = { id: 'profile_builtin_auto_free', name: 'Auto-Free', builtin: true } as Profile;

  it('creates an unsaved custom copy', () => {
    const copy = newProfileFrom(base, 'Mine', 42);
    expect(copy).toMatchObject({ id: 'profile_custom_42', name: 'Mine', builtin: false });
  });

  it('is dirty only when a saved profile differs', () => {
    expect(isProfileDirty(base, base)).toBe(false);
    expect(isProfileDirty({ ...base, name: 'Other' }, base)).toBe(true);
    expect(isProfileDirty(base, undefined)).toBe(false);
  });
});
