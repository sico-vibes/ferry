import { discoverProviderModels } from '@ferry/providers';
import { ProviderIdSchema, redactKnownSecretText } from '@ferry/shared';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { createBackgroundQueue } from '../background-queue.js';
import { getProviderHealth } from '../provider-health.js';

const modelsMaxAgeMs = 6 * 60 * 60 * 1000;
const discoveryTimeoutMs = 4_000;
const retryDelaysMs = [60_000, 120_000, 300_000, 900_000, 3_600_000] as const;

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

function discoveryErrorClass(
  error: unknown,
): 'auth' | 'network' | 'server' | 'not_found' | 'unknown' {
  const message = error instanceof Error ? error.message : String(error);
  const status = /HTTP\s+(\d{3})/i.exec(message)?.[1];
  if (status === '401' || status === '403') return 'auth';
  if (status === '404') return 'not_found';
  if (status && Number(status) >= 500) return 'server';
  if (error instanceof TypeError || /fetch|network|socket|timeout|ECONN/i.test(message))
    return 'network';
  return 'unknown';
}

export interface ModelDiscovery {
  keyChanged(id: string): Promise<void>;
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
  const queue = createBackgroundQueue();

  const refresh = (id: string): Promise<void> => {
    const active = inFlight.get(id);
    if (active) return active;

    const controller = new AbortController();
    const aborted = () => controller.signal.aborted;
    controllers.set(id, controller);
    const timeoutReason = new Error('Provider model discovery timed out');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const task = queue(async () => {
      if (aborted()) return;
      timeout = setTimeout(() => {
        controller.abort(timeoutReason);
      }, discoveryTimeoutMs);
      timeout.unref();
      const limits = services.catalog.providers.find((item) => item.provider === id);
      const current = services.providers.get(id);
      if (!limits || !current?.enabled) return;

      const baseUrl = baseUrlFor(services, id);
      if (services.env.NODE_ENV === 'test' && !isLoopbackUrl(baseUrl)) return;

      const keyEntries = services.providerKeyEntries.list(id);
      const usableEntry = keyEntries.find(
        (entry) =>
          entry.enabled &&
          entry.status !== 'invalid' &&
          (entry.status !== 'disabled' ||
            Boolean(
              entry.cooldownUntil &&
              Date.parse(entry.cooldownUntil) <= services.clock.now().getTime(),
            )) &&
          (entry.status !== 'rate_limited' ||
            !entry.cooldownUntil ||
            Date.parse(entry.cooldownUntil) <= services.clock.now().getTime()),
      );
      // A persisted legacy key must not bypass disabled/invalid sibling entries.
      if (keyEntries.length > 0 && !usableEntry) return;
      const key =
        (await services.secrets.get(
          usableEntry?.keyringRef ?? services.providerKeys.get(id)?.keyringRef ?? id,
        )) ?? '';
      const keylessEnabled = limits.key_required === false && current.enabled;
      if (!key && !keylessEnabled) return;

      try {
        const providerId = ProviderIdSchema.parse(id);
        const discovered = await discoverProviderModels(providerId, key, {
          ...(baseUrl ? { baseUrl } : {}),
          signal: controller.signal,
        });
        const fetchedAt = services.clock.now().toISOString();
        if (aborted()) return;
        const models = discovered.map((model) => ({
          ...model,
          verified: true,
          verifiedAt: fetchedAt,
        }));
        services.models.replace(id, models, fetchedAt);
        getProviderHealth(services).tracker.discovered(id);
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
          discoveryFailedAt: null,
          discoveryFailures: 0,
          discoveryErrorClass: null,
          discoveryUnsupported: false,
          excludedModelRefs: [],
        };
        services.providers.put(updated);
        if (
          saved.keyStatus !== updated.keyStatus ||
          saved.health !== updated.health ||
          saved.discoveryUnsupported ||
          saved.discoveryFailures ||
          saved.discoveryErrorClass ||
          saved.modelCount !== updated.modelCount ||
          JSON.stringify(saved.availableModels) !== JSON.stringify(updated.availableModels)
        )
          host.emit('provider.updated', updated);
      } catch (error) {
        if (aborted() && controller.signal.reason !== timeoutReason) return;
        const saved = services.providers.get(id);
        if (!saved) return;
        const errorClass = discoveryErrorClass(error);
        const failedAt = services.clock.now().toISOString();
        const failures = (saved.discoveryFailures ?? 0) + 1;
        const unsupported =
          errorClass === 'not_found' ||
          (error instanceof Error && error.message === 'Provider has no model list endpoint');
        const authFailure = errorClass === 'auth';
        if (authFailure && usableEntry) {
          services.providerKeyEntries.put({
            ...usableEntry,
            status: 'invalid',
            lastError: redactKnownSecretText(
              error instanceof Error ? error.message : String(error),
            ),
            cooldownUntil: null,
            updatedAt: failedAt,
          });
        }
        const anotherUsableKey = keyEntries.some(
          (entry) =>
            entry.keyId !== usableEntry?.keyId &&
            entry.enabled &&
            entry.status !== 'invalid' &&
            (entry.status !== 'disabled' ||
              Boolean(
                entry.cooldownUntil &&
                Date.parse(entry.cooldownUntil) <= services.clock.now().getTime(),
              )) &&
            (entry.status !== 'rate_limited' ||
              !entry.cooldownUntil ||
              Date.parse(entry.cooldownUntil) <= services.clock.now().getTime()),
        );
        const providerAuthFailure = authFailure && !anotherUsableKey;
        const updated = {
          ...saved,
          discoveryFailedAt: failedAt,
          discoveryFailures: failures,
          discoveryErrorClass: authFailure && anotherUsableKey ? 'unknown' : errorClass,
          ...(unsupported ? { discoveryUnsupported: true, modelsVerifiedAt: failedAt } : {}),
          ...(providerAuthFailure
            ? { keyStatus: 'invalid' as const, health: 'auth_invalid' as const }
            : {}),
        };
        services.providers.put(updated);
        if (unsupported && !saved.modelsVerifiedAt) {
          services.models.replace(
            id,
            services.catalog.models
              .filter((model) => model.providerId === id)
              .map((model) => ({ ...model, verified: false, verifiedAt: null })),
          );
        }
        const delayMs =
          retryDelaysMs[Math.min(failures - 1, retryDelaysMs.length - 1)] ?? 3_600_000;
        if (failures <= retryDelaysMs.length)
          services.logger.warn(
            {
              providerId: id,
              errorClass,
              failures,
              retryInMs: unsupported || providerAuthFailure ? null : delayMs,
            },
            'Provider model discovery failed',
          );
        if (
          saved.keyStatus !== updated.keyStatus ||
          saved.health !== updated.health ||
          saved.discoveryUnsupported !== updated.discoveryUnsupported
        )
          host.emit('provider.updated', updated);
      }
    }).finally(() => {
      clearTimeout(timeout);
      inFlight.delete(id);
      controllers.delete(id);
    });

    inFlight.set(id, task);
    return task;
  };

  const refreshIfStale = async (id: string): Promise<void> => {
    const saved = services.providers.get(id);
    if (!saved || saved.discoveryUnsupported) return;
    if (saved.discoveryErrorClass === 'auth') return;
    const failedAt = saved.discoveryFailedAt ? Date.parse(saved.discoveryFailedAt) : Number.NaN;
    const failures = saved.discoveryFailures ?? 0;
    const retryDelay = retryDelaysMs[Math.min(Math.max(0, failures - 1), retryDelaysMs.length - 1)];
    if (
      failures > 0 &&
      Number.isFinite(failedAt) &&
      retryDelay !== undefined &&
      services.clock.now().getTime() - failedAt < retryDelay
    )
      return;
    const fetchedAt = saved.modelsVerifiedAt ? Date.parse(saved.modelsVerifiedAt) : Number.NaN;
    const needsHealthRecovery =
      saved.health === 'down' || saved.health === 'auth_invalid' || saved.keyStatus === 'invalid';
    const stale =
      needsHealthRecovery ||
      !Number.isFinite(fetchedAt) ||
      services.clock.now().getTime() - fetchedAt >= modelsMaxAgeMs;
    if (!stale) return;
    await refresh(id);
  };

  const discovery: ModelDiscovery = {
    async keyChanged(id) {
      controllers.get(id)?.abort();
      await inFlight.get(id);
      await refresh(id);
    },
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
