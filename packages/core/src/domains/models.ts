import { ModelInfoSchema, ProviderIdSchema } from '@ferry/shared';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { discoverProviderModels } from '@ferry/providers';
import { oauthModelCatalog } from '@ferry/oauth';

function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export function register(host: CoreHost, services: FerryServices): void {
  host.registerDomain('models', {
    async list(rawProviderId?: unknown) {
      return Promise.resolve().then(() => {
        const providerId = ProviderIdSchema.optional().parse(rawProviderId);
        const enabled = new Set(
          services.catalog.providers
            .filter((provider) => providerId === undefined || provider.provider === providerId)
            .map((provider) => provider.provider)
            .filter((id) => services.providers.get(id)?.enabled ?? false),
        );
        const liveModels = Promise.all(
          [...enabled].map(async (id) => {
            const saved = services.providers.get(id);
            const stale =
              !saved?.modelsVerifiedAt ||
              services.clock.now().getTime() - Date.parse(saved.modelsVerifiedAt) >= 86_400_000;
            const limits = services.catalog.providers.find((provider) => provider.provider === id);
            const envName = `FERRY_PROVIDER_BASE_URL_${id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
            const baseUrl = services.env[envName];
            const mayDiscoverInTest = isLoopbackUrl(baseUrl);
            const hasSnapshot = services.catalog.models.some((model) => model.providerId === id);
            const liveDiscoveryDeclared = limits?.models_endpoint === '/models';
            const keylessDiscoverable = limits?.key_required === false;
            if (
              saved &&
              stale &&
              (services.env.NODE_ENV !== 'test' || mayDiscoverInTest) &&
              (hasSnapshot || liveDiscoveryDeclared || keylessDiscoverable)
            ) {
              const key = (await services.secrets.get(id)) ?? '';
              if (key || keylessDiscoverable) {
                try {
                  const discovered = await discoverProviderModels(id, key, {
                    ...(baseUrl ? { baseUrl } : {}),
                  });
                  services.providers.put({
                    ...saved,
                    availableModels: discovered,
                    modelsVerifiedAt: services.clock.now().toISOString(),
                    modelCount: discovered.length,
                  });
                } catch {
                  // Retain the most recent verified list if refresh cannot reach the provider.
                }
              }
            }
            return services.providers.get(id)?.availableModels ?? [];
          }),
        );
        const oauthEnabled = oauthModelCatalog
          .filter((model) => services.providers.get(model.providerId)?.enabled)
          .map((model) => ModelInfoSchema.parse(model));
        return liveModels.then((records) =>
          [...records.flat(), ...oauthEnabled]
            .filter((model) => providerId === undefined || model.providerId === providerId)
            .map((model) => ModelInfoSchema.parse(model)),
        );
      });
    },
  });
}
