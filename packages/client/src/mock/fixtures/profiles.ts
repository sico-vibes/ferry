import { DIRECT_PROFILE_ID } from '@ferry/shared';
import { sampleProfile } from '@ferry/shared/testing';
import type { Profile } from '@ferry/shared';

export function createProfiles(): Profile[] {
  const profiles: Profile[] = ['Best Available', 'Auto-Free', 'Fast', 'Long Context'].map(
    (name, i) => ({
      ...sampleProfile,
      id: ['profile_best', 'profile_free', 'profile_fast', 'profile_long'][i] as Profile['id'],
      name,
      icon: ['lightbulb', 'sparkles', 'zap', 'book-open'][i] ?? 'lightbulb',
      pinned: true,
      paidAllowed: i !== 1,
      optimizers: {
        ...sampleProfile.optimizers,
        cavemanInput: i === 1 ? 'lite' : 'off',
        terse: i === 1 ? 'lite' : 'off',
      },
      caps: { dailyUsd: i === 0 ? 2 : null, monthlyUsd: i === 0 ? 20 : null },
      roles: {
        enabled: i === 0 || i === 1,
        plannerModelRef: null,
        editorModelRef: null,
        editorFailureThreshold: 2,
      },
      tierByStep: {
        plan: ['T1', 'T2', 'T3'] as ('T1' | 'T2' | 'T3')[],
        edit: ['T1', 'T2', 'T3'] as ('T1' | 'T2' | 'T3')[],
        search: ['T1', 'T2', 'T3'] as ('T1' | 'T2' | 'T3')[],
        summarize: ['T1', 'T2', 'T3'] as ('T1' | 'T2' | 'T3')[],
        review: ['T1', 'T2', 'T3'] as ('T1' | 'T2' | 'T3')[],
        long_context: ['T1', 'T2'] as ('T1' | 'T2' | 'T3')[],
      },
    }),
  );

  profiles.push({
    ...sampleProfile,
    id: DIRECT_PROFILE_ID,
    name: 'No profile',
    icon: 'sparkles',
    description:
      'Talk to the model you pick. No routing rules, tiers or caps beyond your global settings.',
    affinityMode: 'soft',
    builtin: true,
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
    paidAllowed: true,
    optimizers: { ...sampleProfile.optimizers, cavemanInput: 'off', terse: 'off' },
    caps: { sessionUsd: null, dailyUsd: null, monthlyUsd: null },
    roles: {
      enabled: false,
      plannerModelRef: null,
      editorModelRef: null,
      editorFailureThreshold: 2,
    },
  });
  return profiles;
}
