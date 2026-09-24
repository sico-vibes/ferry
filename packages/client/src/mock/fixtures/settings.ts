import { sampleOptimizerStats, sampleSettings } from '@ferry/shared/testing';

export function createSettings() {
  return {
    settings: {
      ...sampleSettings,
      homeStyle: 'auto' as const,
      activeProfileId: 'profile_best' as typeof sampleSettings.activeProfileId,
    },
    optimizerStats: {
      ...sampleOptimizerStats,
      today: { savedTokens: 182400, percent: 38 },
      byOptimizer: [
        ['tool-output-filters', 'Tool-output filters', true, 61],
        ['context-hygiene', 'Context hygiene', true, 22],
        ['terse', 'Terse output', false, 9],
        ['recovery-handles', 'Recovery handles', true, 0],
        ['rtk', 'RTK', false, 0],
      ].map(([id, name, enabled, percent]) => ({
        id: String(id),
        name: String(name),
        enabled: Boolean(enabled),
        savedTokens: Math.round((182400 * Number(percent)) / 100),
        percent: Number(percent),
      })),
    },
  };
}
