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
      caps: { dailyUsd: i === 0 ? 2 : null, monthlyUsd: i === 0 ? 20 : null },
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

  return profiles;
}
