import {
  OPTIMIZATION_PRESETS,
  type Profile,
  type Provider,
  type ProviderId,
  type StepKind,
  type Tier,
} from '@ferry/shared';

export type AllowedProvidersMode = 'all_free' | 'all' | 'pick';

export function allowedProvidersMode(allowed: Profile['allowedProviders']): AllowedProvidersMode {
  return Array.isArray(allowed) ? 'pick' : allowed;
}

export function providerAllowed(
  allowed: Profile['allowedProviders'],
  provider: Pick<Provider, 'id' | 'tag'>,
): boolean {
  if (allowed === 'all') return true;
  if (allowed === 'all_free') return provider.tag !== 'paid';
  return allowed.includes(provider.id);
}

/** Toggle one provider, expanding the "all" shorthands into an explicit list first. */
export function toggleProvider(
  allowed: Profile['allowedProviders'],
  providers: readonly Pick<Provider, 'id' | 'tag'>[],
  providerId: ProviderId,
  checked: boolean,
): ProviderId[] {
  const current = providers
    .filter((provider) => providerAllowed(allowed, provider))
    .map((provider) => provider.id);
  return checked
    ? [...new Set([...current, providerId])]
    : current.filter((id) => id !== providerId);
}

const tierOrder: Tier[] = ['T1', 'T2', 'T3'];

export function toggleTier(
  tierByStep: Profile['tierByStep'],
  step: StepKind,
  tier: Tier,
): Profile['tierByStep'] {
  const current = tierByStep[step];
  const next = current.includes(tier)
    ? current.filter((value) => value !== tier)
    : tierOrder.filter((value) => value === tier || current.includes(value));
  return { ...tierByStep, [step]: next };
}

/** A new custom profile based on another one, never pinned to built-in status. */
export function newProfileFrom(source: Profile, name: string, now: number): Profile {
  return {
    ...structuredClone(source),
    id: `profile_custom_${String(now)}` as Profile['id'],
    name,
    builtin: false,
    pinned: true,
  };
}

/** The guided creation path always starts free, even when the active profile is paid. */
export function newGuidedProfile(profiles: readonly Profile[], now: number): Profile | null {
  const base =
    profiles.find((profile) => profile.builtin && profile.name === 'Auto-Free') ?? profiles[0];
  if (!base) return null;
  const profile = newProfileFrom(base, 'New profile', now);
  profile.allowedProviders = 'all_free';
  profile.paidAllowed = false;
  profile.paidConfirmation = {
    preauthorize: false,
    confirmSubscriptions: false,
    confirmTrials: false,
  };
  profile.roles = { ...profile.roles, enabled: false };
  profile.optimizers = { ...OPTIMIZATION_PRESETS.fidelity };
  delete profile.allowedModelRefs;
  return profile;
}

export function isProfileDirty(draft: Profile | null, saved: Profile | undefined): boolean {
  if (!draft || !saved) return false;
  return JSON.stringify(draft) !== JSON.stringify(saved);
}
