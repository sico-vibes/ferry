import { SettingsSchema } from '@ferry/shared';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createSettingsDomain(_store: MockStore, deps: MockDeps): FerryClient['settings'] {
  const { state, before, persist, syncStore } = deps;
  return {
    async get() {
      await before();
      return structuredClone(state.settings);
    },
    async update(patch) {
      await before();
      state.settings = SettingsSchema.parse({
        ...state.settings,
        ...patch,
        paidCaps: { ...state.settings.paidCaps, ...patch.paidCaps },
        optimizers: { ...state.settings.optimizers, ...patch.optimizers },
        globalOptimizerOverride: patch.optimizers
          ? true
          : (patch.globalOptimizerOverride ?? state.settings.globalOptimizerOverride),
        developer: { ...state.settings.developer, ...patch.developer },
        routing: { ...state.settings.routing, ...patch.routing },
      });
      persist();
      syncStore();
      return structuredClone(state.settings);
    },
  };
}
