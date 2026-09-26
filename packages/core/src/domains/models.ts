import { ModelInfoSchema, ProviderIdSchema } from '@ferry/shared';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { oauthModelCatalog } from '@ferry/oauth';

export function register(host: CoreHost, services: FerryServices): void {
  host.registerDomain('models', {
    async list(rawProviderId?: unknown) {
      return Promise.resolve().then(() => {
        const providerId = ProviderIdSchema.optional().parse(rawProviderId);
        const enabled = new Set(
          services.catalog.providers
            .map((provider) => provider.provider)
            .filter((id) => services.providers.get(id)?.enabled ?? false),
        );
        const liveModels = [...enabled].map((id) => services.models.list(id));
        const oauthEnabled = oauthModelCatalog
          .filter((model) => services.providers.get(model.providerId)?.enabled)
          .map((model) => ModelInfoSchema.parse(model));
        return [...liveModels.flat(), ...oauthEnabled]
          .filter((model) => providerId === undefined || model.providerId === providerId)
          .map((model) => ModelInfoSchema.parse(model));
      });
    },
  });
}
