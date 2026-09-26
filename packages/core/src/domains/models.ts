import { ModelInfoSchema, ProviderIdSchema } from '@ferry/shared';
import { oauthModelCatalog } from '@ferry/oauth';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { getModelDiscovery } from './model-discovery.js';

export function register(host: CoreHost, services: FerryServices): void {
  const modelDiscovery = getModelDiscovery(host, services);
  host.registerDomain('models', {
    async list(rawProviderId?: unknown) {
      const providerId = ProviderIdSchema.optional().parse(rawProviderId);
      const enabled = services.catalog.providers
        .filter((provider) => providerId === undefined || provider.provider === providerId)
        .map((provider) => provider.provider)
        .filter((id) => services.providers.get(id)?.enabled ?? false);

      await Promise.all(enabled.map((id) => modelDiscovery.refreshIfStale(id)));
      const cachedModels = enabled.flatMap((id) => services.models.list(id));
      const oauthModels = oauthModelCatalog
        .filter((model) => services.providers.get(model.providerId)?.enabled)
        .map((model) => ModelInfoSchema.parse(model));

      return [...cachedModels, ...oauthModels]
        .filter((model) => providerId === undefined || model.providerId === providerId)
        .map((model) => ModelInfoSchema.parse(model));
    },
  });
}
