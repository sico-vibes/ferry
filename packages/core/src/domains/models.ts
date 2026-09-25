import { ModelInfoSchema, ProviderIdSchema } from '@ferry/shared';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

export function register(host: CoreHost, services: FerryServices): void {
  host.registerDomain('models', {
    list(rawProviderId?: unknown) {
      return Promise.resolve().then(() => {
        const providerId = ProviderIdSchema.optional().parse(rawProviderId);
        const enabled = new Set(
          services.catalog.providers
            .map((provider) => provider.provider)
            .filter((id) => services.providers.get(id)?.enabled ?? false),
        );
        return services.catalog.models
          .filter((model) => enabled.has(model.providerId))
          .filter((model) => providerId === undefined || model.providerId === providerId)
          .map((model) => ModelInfoSchema.parse(model));
      });
    },
  });
}
