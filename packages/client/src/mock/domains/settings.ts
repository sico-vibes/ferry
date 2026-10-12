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
      if (patch.opencodeZenTransport) {
        for (const model of state.models)
          if (model.providerId === 'opencode')
            model.transport =
              patch.opencodeZenTransport === 'cli' && model.free ? 'opencode_cli' : 'api';
        for (const provider of state.providers)
          if (provider.id === 'opencode')
            provider.availableModels = state.models.filter(
              (model) => model.providerId === provider.id,
            );
      }
      if (patch.opencodeZenCliUseFerryKey !== undefined) {
        for (const model of state.models)
          if (model.providerId === 'opencode') model.cliAccessVerified = false;
      }
      persist();
      syncStore();
      return structuredClone(state.settings);
    },
  };
}
