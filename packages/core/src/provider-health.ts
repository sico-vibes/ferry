import { ProviderHealthTracker, probe, type HealthOutcome } from '@ferry/providers';
import { canProbeCooldown } from '@ferry/router';
import type { ProviderHealthSnapshot } from '@ferry/shared';
import type { FerryServices } from './services.js';
import { createBackgroundQueue } from './background-queue.js';

const trackers = new WeakMap<FerryServices, ReturnType<typeof createHealth>>();
function createHealth(services: FerryServices) {
  const listeners = new Set<(health: ProviderHealthSnapshot) => void>();
  const tracker = new ProviderHealthTracker({
    now: () => services.clock.now().getTime(),
    probeAfterMs: Number(services.env.FERRY_PROVIDER_PROBE_AFTER_MS) || 60_000,
    onChange: (health) => {
      for (const listener of listeners) listener(snapshot(health.providerId));
    },
  });
  const queue = createBackgroundQueue();
  let active: Promise<void> | undefined;
  let disposed = false;
  const isDisposed = () => disposed;
  const controllers = new Set<AbortController>();
  const snapshot = (id: string): ProviderHealthSnapshot => {
    const entries = services.providerKeyEntries.list(id);
    const value = tracker.snapshot(
      id,
      entries.map((entry) => entry.id),
    );
    const keys = value.keys.map((key) => {
      const entry = entries.find((item) => item.id === key.keyId);
      const cooled =
        entry?.cooldownUntil && Date.parse(entry.cooldownUntil) > services.clock.now().getTime();
      return {
        ...key,
        keyId: entry?.keyId ?? key.keyId,
        cooldownUntil: key.cooldownUntil ?? (cooled ? entry.cooldownUntil : null),
        reason:
          key.reason ??
          (cooled || entry?.status === 'invalid' || entry?.status === 'disabled'
            ? (entry.lastError ?? entry.status)
            : null),
      };
    });
    return {
      ...value,
      keys,
      state:
        value.state === 'down'
          ? 'down'
          : keys.some((key) => key.reason !== null || key.cooldownUntil !== null)
            ? 'degraded'
            : value.state,
    };
  };
  return {
    tracker,
    snapshot,
    runProbe: queue,
    record(outcome: HealthOutcome) {
      tracker.record(outcome);
    },
    onChange(listener: (health: ProviderHealthSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    recover(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (active) return active;
      active = Promise.allSettled(
        services.catalog.providers.map(({ provider: id }) =>
          queue(async () => {
            if (isDisposed()) return;
            const saved = services.providers.get(id);
            if (saved?.enabled === false) return;
            const envName = `FERRY_PROVIDER_BASE_URL_${id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
            const baseUrl = services.env[envName];
            if (
              services.env.NODE_ENV === 'test' &&
              (!baseUrl || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname))
            )
              return;
            const cooldown = services.cooldowns.get(id);
            const heuristicDue =
              cooldown &&
              canProbeCooldown(
                {
                  until: Date.parse(cooldown.until),
                  provenance: cooldown.provenance ?? 'authoritative',
                },
                services.clock.now().getTime(),
              );
            const breakerDue =
              tracker.snapshot(id).breaker === 'open' &&
              Date.parse(tracker.snapshot(id).nextProbeAt ?? '') <= services.clock.now().getTime();
            if (tracker.snapshot(id).breaker !== 'closed' && !breakerDue) return;
            if (!breakerDue && !heuristicDue) return;
            const entry = services.providerKeyEntries
              .list(id)
              .find(
                (key) =>
                  key.enabled &&
                  key.status !== 'invalid' &&
                  (!key.cooldownUntil ||
                    Date.parse(key.cooldownUntil) <= services.clock.now().getTime()),
              );
            const key = await services.secrets.get(
              entry?.keyringRef ?? services.providerKeys.get(id)?.keyringRef ?? id,
            );
            if (!key || isDisposed()) return;
            if (breakerDue && !tracker.beginProbe(id)) return;
            const controller = new AbortController();
            controllers.add(controller);
            try {
              let status: number | undefined;
              let retryAfter: string | undefined;
              const result = await probe(id, key, {
                ...(baseUrl ? { baseUrl } : {}),
                signal: controller.signal,
                timeoutMs: 4_000,
                fetch: async (input, init) => {
                  const response = await globalThis.fetch(input, init);
                  status = response.status;
                  retryAfter = response.headers.get('retry-after') ?? undefined;
                  return response;
                },
              });
              if (isDisposed() || !services.db.client.open) return;
              tracker.record({
                providerId: id,
                keyId: entry?.id ?? id,
                retryAfter,
                success: result.ok,
                latencyMs: result.latencyMs ?? 0,
                status: result.ok
                  ? 200
                  : status && status >= 400
                    ? status
                    : result.errorKind === 'auth'
                      ? 401
                      : result.errorKind === 'rate_limit' || result.errorKind === 'quota_exhausted'
                        ? 429
                        : result.errorKind === 'model_not_found'
                          ? 404
                          : result.errorKind === 'forbidden' ||
                              result.errorKind === 'unsupported_free_tier'
                            ? 403
                            : result.errorKind === 'request_scoped_client' ||
                                result.errorKind === 'context_overflow'
                              ? 400
                              : undefined,
                message: result.message,
              });
              if (result.ok && cooldown && services.cooldowns.get(id)?.until === cooldown.until) {
                services.cooldowns.delete(id);
                if (saved)
                  services.providers.put({
                    ...saved,
                    health: 'ok',
                    cooldownUntil: null,
                    cooldownProvenance: null,
                  });
              }
            } catch (error) {
              if (!isDisposed())
                tracker.record({
                  providerId: id,
                  success: false,
                  status: 503,
                  message: error instanceof Error ? error.message : String(error),
                });
            } finally {
              controllers.delete(controller);
            }
          }),
        ),
      )
        .then(() => undefined)
        .finally(() => {
          active = undefined;
        });
      return active;
    },
    async dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      await active;
      listeners.clear();
    },
  };
}
export function getProviderHealth(services: FerryServices) {
  let health = trackers.get(services);
  if (!health) {
    health = createHealth(services);
    trackers.set(services, health);
  }
  return health;
}
