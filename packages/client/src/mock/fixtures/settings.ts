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
      demo: true,
      today: { savedTokens: 0, percent: 0, samples: 0 },
      byOptimizer: [],
    },
  };
}
