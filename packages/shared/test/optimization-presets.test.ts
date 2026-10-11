import { expect, it } from 'vitest';
import { OPTIMIZATION_PRESETS, optimizationPreset } from '../src/index.js';
it('preserves fidelity by disabling lossy transforms and pairs safe filtering with recovery', () => {
  expect(optimizationPreset(OPTIMIZATION_PRESETS.fidelity)).toBe('fidelity');
  expect(OPTIMIZATION_PRESETS.fidelity).toMatchObject({
    terse: 'off',
    cavemanInput: 'off',
    toolOutputFilters: false,
  });
  expect(OPTIMIZATION_PRESETS.savings).toMatchObject({
    recoveryHandles: true,
    toolOutputFilters: true,
    cavemanInput: 'off',
    terse: 'off',
  });
  expect(optimizationPreset({ ...OPTIMIZATION_PRESETS.savings, rtk: true })).toBe('advanced');
});
