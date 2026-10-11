import type { OptimizerToggles } from './domain/profile.js';

export type OptimizationPreset = 'fidelity' | 'savings' | 'advanced';
export const OPTIMIZATION_PRESETS = {
  fidelity: {
    toolOutputFilters: false,
    recoveryHandles: false,
    contextHygiene: false,
    rtk: false,
    terse: 'off',
    cavemanInput: 'off',
  },
  savings: {
    toolOutputFilters: true,
    recoveryHandles: true,
    contextHygiene: true,
    rtk: false,
    terse: 'off',
    cavemanInput: 'off',
  },
} satisfies Record<'fidelity' | 'savings', OptimizerToggles>;

export function optimizationPreset(toggles: OptimizerToggles): OptimizationPreset {
  for (const preset of ['fidelity', 'savings'] as const) {
    const expected = OPTIMIZATION_PRESETS[preset];
    if (
      (Object.keys(expected) as (keyof OptimizerToggles)[]).every(
        (key) => toggles[key] === expected[key],
      )
    )
      return preset;
  }
  return 'advanced';
}
