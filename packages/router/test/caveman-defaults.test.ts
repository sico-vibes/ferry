import { expect, it } from 'vitest';
import { ProfileSchema } from '@ferry/shared';
import { BUILTIN_PROFILES } from '../src/index.js';

it('uses Lite Caveman by default only on free-only built-in profiles', () => {
  expect(
    BUILTIN_PROFILES.find((profile) => profile.name === 'Auto-Free')?.optimizers,
  ).toMatchObject({
    cavemanInput: 'lite',
    terse: 'lite',
  });
  for (const profile of BUILTIN_PROFILES) {
    const freeOnly = !profile.paidAllowed && profile.allowedProviders === 'all_free';
    expect(JSON.stringify(ProfileSchema.parse(profile).optimizers)).toBe(
      JSON.stringify(profile.optimizers),
    );
    expect(profile.optimizers.cavemanInput).toBe(freeOnly ? 'lite' : 'off');
    expect(profile.optimizers.terse).toBe(freeOnly ? 'lite' : 'off');
  }
});
