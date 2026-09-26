import {
  ProbeResultSchema,
  ProviderIdSchema,
  ProviderSchema,
  QuotaObservationSchema,
  newId,
  type Provider,
} from '@ferry/shared';
import { discoverProviderModels, probe } from '@ferry/providers';
import { z } from 'zod';
import { rpcDomainError, type CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { invalidateSessionProviderKeyCache } from '../session-deps.js';
import { getModelDiscovery } from './model-discovery.js';

const ProviderIdInput = ProviderIdSchema;
const KeyInput = z.string().trim().min(1).max(4096);
const EnabledInput = z.boolean();

function baseUrlFor(services: FerryServices, id: string): string | undefined {
  const envName = `FERRY_PROVIDER_BASE_URL_${id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  return services.env[envName];
}

function providerRecord(services: FerryServices, id: string): Provider {
  const limits = services.catalog.providers.find((item) => item.provider === id);
  if (!limits) throw rpcDomainError(-32044, 'not_found', `Provider not found: ${id}`);
  const saved = services.providers.get(id);
  const keyRef = services.providerKeys.get(id);
  const keyStatus: Provider['keyStatus'] = keyRef ? (saved?.keyStatus ?? 'unchecked') : 'missing';
  const availableModels = saved?.availableModels;
  const modelCount = availableModels?.length ?? 0;
  const cooldown = services.cooldowns.get(id);
  const activeCooldown = cooldown && Date.parse(cooldown.until) > services.clock.now().getTime();
  return ProviderSchema.parse({
    id,
    name: limits.name,
    tag: limits.tag,
    kind: limits.tag === 'subscription_cli' ? 'cli' : 'api',
    brand: null,
    keyStatus,
    enabled: saved?.enabled ?? Boolean(keyRef),
    health: activeCooldown
      ? 'cooldown'
      : saved?.health === 'cooldown'
        ? 'ok'
        : (saved?.health ?? (keyStatus === 'invalid' ? 'auth_invalid' : 'unknown')),
    cooldownUntil: activeCooldown ? cooldown.until : null,
    dataUse: limits.data_use,
    termsNote: limits.terms_note,
    signupUrl: limits.signup_url,
    docsUrl: limits.docs_url,
    verifiedAt: limits.verified_at,
    modelCount,
    ...(availableModels ? { availableModels } : {}),
    modelsVerifiedAt: saved?.modelsVerifiedAt ?? null,
    windows: services.quota.getWindows(id),
    stepsLeftToday: services.quota.stepsLeft(id),
  });
}

function saveProvider(services: FerryServices, provider: Provider): Provider {
  services.providers.put(ProviderSchema.parse(provider));
  return provider;
}

export function register(host: CoreHost, services: FerryServices): void {
  const modelDiscovery = getModelDiscovery(host, services);
  let healthRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  host.onStart(async () => {
    const testProviderId = services.env.FERRY_E2E_PROVIDER_ID;
    const testProviderKey = services.env.FERRY_E2E_PROVIDER_KEY;
    if (services.env.FERRY_E2E_USER_DATA_DIR && testProviderId && testProviderKey) {
      const id = ProviderIdInput.parse(testProviderId);
      await services.secrets.set(id, testProviderKey);
      services.providerKeys.put({
        id,
        providerId: id,
        keyringRef: id,
        createdAt: services.clock.now().toISOString(),
      });
      const current = providerRecord(services, id);
      saveProvider(services, {
        ...current,
        enabled: true,
        availableModels: [],
        modelsVerifiedAt: null,
      });
      invalidateSessionProviderKeyCache(services, id);
    }
    services.catalog.providers.forEach(({ provider: id }) => {
      const saved = services.providers.get(id);
      const key = services.providerKeys.get(id);
      const limits = services.catalog.providers.find((item) => item.provider === id);
      if (key || (saved?.enabled && limits?.key_required === false))
        void modelDiscovery.refreshIfStale(id);
    });
    if (!healthRecoveryTimer) {
      healthRecoveryTimer = setInterval(
        () => {
          for (const { provider: id } of services.catalog.providers) {
            const saved = services.providers.get(id);
            if (
              saved &&
              (saved.health !== 'ok' || saved.keyStatus === 'invalid') &&
              services.providerKeys.get(id)
            )
              void modelDiscovery.refreshIfStale(id);
          }
        },
        60 * 60 * 1000,
      );
      healthRecoveryTimer.unref();
    }
  });
  host.onShutdown(() => {
    if (healthRecoveryTimer) clearInterval(healthRecoveryTimer);
    healthRecoveryTimer = undefined;
  });
  host.registerDomain('providers', {
    list() {
      return services.catalog.providers.map((entry) => providerRecord(services, entry.provider));
    },
    async setKey(rawId: unknown, rawKey: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const key = KeyInput.parse(rawKey);
      const current = providerRecord(services, id);
      await services.secrets.set(id, key);
      services.providerKeys.put({
        id,
        providerId: id,
        keyringRef: id,
        createdAt: services.clock.now().toISOString(),
      });
      invalidateSessionProviderKeyCache(services, id);
      const provider = saveProvider(services, {
        ...current,
        keyStatus: 'unchecked',
        enabled: true,
        health: 'unknown',
        cooldownUntil: null,
        availableModels: [],
        modelsVerifiedAt: null,
      });
      services.models.replace(id, []);
      host.emit('provider.updated', provider);
      void modelDiscovery.refresh(id);
      return provider;
    },
    async removeKey(rawId: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const current = providerRecord(services, id);
      await services.secrets.delete(id);
      services.providerKeys.delete(id);
      invalidateSessionProviderKeyCache(services, id);
      services.cooldowns.delete(id);
      const provider = saveProvider(services, {
        ...current,
        keyStatus: 'missing',
        enabled: false,
        health: 'unknown',
        cooldownUntil: null,
      });
      services.models.replace(id, []);
      host.emit('provider.updated', provider);
      return provider;
    },
    async probe(rawId: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const current = providerRecord(services, id);
      const key = await services.secrets.get(id);
      if (!key) {
        const result = ProbeResultSchema.parse({
          ok: false,
          keyValid: false,
          latencyMs: null,
          message: 'Add an API key to test this provider',
          windows: [],
          models: [],
          errorKind: 'auth',
        });
        saveProvider(services, { ...current, keyStatus: 'missing' });
        return result;
      }
      const baseUrl = baseUrlFor(services, id);
      const result = ProbeResultSchema.parse(
        await probe(id, key, { ...(baseUrl ? { baseUrl } : {}) }),
      );
      let discovered: Awaited<ReturnType<typeof discoverProviderModels>> = [];
      let discoverySucceeded = false;
      if (result.ok) {
        try {
          discovered = await discoverProviderModels(id, key, { ...(baseUrl ? { baseUrl } : {}) });
          discoverySucceeded = true;
        } catch {
          // Preserve the previous verified list when live discovery fails.
        }
      }
      const unavailableIds = new Set(result.skippedModels?.map((skipped) => skipped.model) ?? []);
      const knownProbeModels = services.catalog.models.filter(
        (model) =>
          model.providerId === id &&
          result.models.includes(model.ref.slice(id.length + 1)) &&
          !unavailableIds.has(model.ref.slice(id.length + 1)),
      );
      const availableModels = (
        discoverySucceeded && discovered.length ? discovered : knownProbeModels
      ).filter((model) => !unavailableIds.has(model.ref.slice(id.length + 1)));
      const persistedModels = result.ok
        ? availableModels
        : (current.availableModels ?? []).filter(
            (model) => !unavailableIds.has(model.ref.slice(id.length + 1)),
          );
      const now = services.clock.now().toISOString();
      const limits = services.catalog.providers.find((item) => item.provider === id);
      const modelRef = services.catalog.models.find((model) => model.providerId === id)?.ref;
      const testedModel = modelRef?.slice(id.length + 1);
      for (const window of result.windows) {
        const definitions = limits?.windows.filter(
          (candidate) =>
            candidate.metric === window.metric &&
            (candidate.scope === 'provider' || candidate.model === testedModel),
        );
        const targets = definitions?.length
          ? definitions.map(
              (definition) =>
                `${id}:${definition.scope}:${definition.model ?? '*'}:${definition.metric}:${definition.kind}`,
            )
          : [window.id];
        for (const windowId of targets) {
          const observation = {
            id: newId('quota'),
            providerId: id,
            windowId,
            metric: window.metric,
            ...(window.limit === null || window.remaining === null
              ? {}
              : { value: Math.max(0, window.limit - window.remaining) }),
            limit: window.limit,
            remaining: window.remaining,
            resetAt: window.resetAt,
            source: 'header' as const,
            observedAt: now,
            ...(result.errorKind === 'rate_limit' || result.errorKind === 'quota_exhausted'
              ? { statusCode: 429 }
              : {}),
          };
          const parsed = QuotaObservationSchema.safeParse(observation);
          if (parsed.success) services.quota.observe(parsed.data);
        }
      }
      const cooldownModel = modelRef ?? id;
      if (result.errorKind === 'rate_limit' || result.errorKind === 'quota_exhausted') {
        const cooldown = services.quota.noteFailure(
          id,
          cooldownModel,
          id,
          '429',
          result.windows.find((window) => window.resetAt)?.resetAt ?? undefined,
        );
        if (cooldown.cooldownUntil) services.cooldowns.put({ id, until: cooldown.cooldownUntil });
      } else if (result.ok) {
        services.quota.noteSuccess(id, cooldownModel, id);
        services.cooldowns.delete(id);
      }
      const provider = saveProvider(services, {
        ...current,
        keyStatus: result.keyValid ? 'valid' : 'invalid',
        health: result.ok
          ? 'ok'
          : result.errorKind === 'auth'
            ? 'auth_invalid'
            : services.cooldowns.get(id)
              ? 'cooldown'
              : 'down',
        cooldownUntil: services.cooldowns.get(id)?.until ?? null,
        windows: services.quota.getWindows(id),
        stepsLeftToday: services.quota.stepsLeft(id),
        verifiedAt: result.ok
          ? services.clock.now().toISOString().slice(0, 10)
          : current.verifiedAt,
        ...(result.ok || result.skippedModels?.length
          ? {
              availableModels: persistedModels,
              modelsVerifiedAt: result.ok
                ? services.clock.now().toISOString()
                : (current.modelsVerifiedAt ?? null),
              modelCount: persistedModels.length,
            }
          : {}),
      });
      if (result.ok) services.models.replace(id, persistedModels, now);
      host.emit('provider.updated', provider);
      return result;
    },
    setEnabled(rawId: unknown, rawEnabled: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const enabled = EnabledInput.parse(rawEnabled);
      const current = providerRecord(services, id);
      const provider = saveProvider(services, { ...current, enabled });
      host.emit('provider.updated', provider);
      return provider;
    },
  });
}
