import { discoverProviderModels } from '@ferry/providers';
import { ProviderIdSchema } from '@ferry/shared';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

const modelsMaxAgeMs = 24 * 60 * 60 * 1000;

function baseUrlFor(services: FerryServices, id: string): string | undefined {
  const envName = `FERRY_PROVIDER_BASE_URL_${id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  return services.env[envName];
}

function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export interface ModelDiscovery {
  refresh(id: string): Promise<void>;
  refreshIfStale(id: string): Promise<void>;
  dispose(): Promise<void>;
}

const discoveries = new WeakMap<FerryServices, ModelDiscovery>();

export function getModelDiscovery(host: CoreHost, services: FerryServices): ModelDiscovery {
  const existing = discoveries.get(services);
  if (existing) return existing;

  const inFlight = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();

  const refresh = (id: string): Promise<void> => {
    const active = inFlight.get(id);
    if (active) return active;

    const controller = new AbortController();
    controllers.set(id, controller);
    const task = (async () => {
      const limits = services.catalog.providers.find((item) => item.provider === id);
      const current = services.providers.get(id);
      if (!limits || !current) return;

      const baseUrl = baseUrlFor(services, id);
      if (services.env.NODE_ENV === 'test' && !isLoopbackUrl(baseUrl)) return;

      const key = (await services.secrets.get(id)) ?? '';
      const keylessEnabled = limits.key_required === false && current.enabled;
      const endpointDeclared = limits.models_endpoint === '/models';
      if (!key && !keylessEnabled) return;
      if (!key && !endpointDeclared && !keylessEnabled) return;

      try {
        const providerId = ProviderIdSchema.parse(id);
        const models = await discoverProviderModels(providerId, key, {
          ...(baseUrl ? { baseUrl } : {}),
          signal: controller.signal,
        });
        const fetchedAt = services.clock.now().toISOString();
        services.models.replace(id, models, fetchedAt);
        const saved = services.providers.get(id);
        if (!saved) return;
        const updated = {
          ...saved,
          keyStatus: key ? ('valid' as const) : saved.keyStatus,
          health: 'ok' as const,
          cooldownUntil: null,
          availableModels: models,
          modelCount: models.length,
          modelsVerifiedAt: fetchedAt,
        };
        services.providers.put(updated);
        host.emit('provider.updated', updated);
      } catch (error) {
        services.logger.warn({ err: error, providerId: id }, 'Provider model discovery failed');
      }
    })().finally(() => {
      inFlight.delete(id);
      controllers.delete(id);
    });

    inFlight.set(id, task);
    return task;
  };

  const refreshIfStale = async (id: string): Promise<void> => {
    const saved = services.providers.get(id);
    const fetchedAt = saved?.modelsVerifiedAt ? Date.parse(saved.modelsVerifiedAt) : Number.NaN;
    const needsHealthRecovery = Boolean(
      saved && (['auth_invalid', 'down'].includes(saved.health) || saved.keyStatus === 'invalid'),
    );
    const stale =
      needsHealthRecovery ||
      services.models.list(id).length === 0 ||
      !Number.isFinite(fetchedAt) ||
      services.clock.now().getTime() - fetchedAt >= modelsMaxAgeMs;
    if (stale) await refresh(id);
  };

  const discovery: ModelDiscovery = {
    refresh,
    refreshIfStale,
    async dispose() {
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled(inFlight.values());
      controllers.clear();
      inFlight.clear();
    },
  };
  discoveries.set(services, discovery);
  return discovery;
}
