import {
  ProbeResultSchema,
  ProviderKeySchema,
  ProviderIdSchema,
  ProviderSchema,
  RoutingSettingsSchema,
  QuotaObservationSchema,
  redactKnownSecretText,
  type Provider,
} from '@ferry/shared';
import { discoverProviderModels, probe, resolveProviderRequestOverrides } from '@ferry/providers';
import { z } from 'zod';
import { observationsFromProbe } from '@ferry/quota';
import { rpcDomainError, type CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { invalidateSessionProviderKeyCache } from '../session-deps.js';
import { getModelDiscovery } from './model-discovery.js';
import { getProviderHealth } from '../provider-health.js';
import { isCoreWindowActive, onCoreWindowActiveChange } from '../runtime-activity.js';
import { hasUsableProviderKey } from '../services.js';

const ProviderIdInput = ProviderIdSchema;
const KeyInput = z.string().trim().min(1).max(4096);
const EnabledInput = z.boolean();

function baseUrlFor(services: FerryServices, id: string): string | undefined {
  const envName = `FERRY_PROVIDER_BASE_URL_${id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  return services.env[envName];
}

function cooldownReasonsEnabled(services: FerryServices): boolean {
  const stored = services.settings.get('global');
  const routing =
    typeof stored === 'object' && stored !== null && 'routing' in stored
      ? stored.routing
      : undefined;
  return RoutingSettingsSchema.parse(routing ?? {}).cooldownReasons;
}

function providerRecord(services: FerryServices, id: string): Provider {
  const limits = services.catalog.providers.find((item) => item.provider === id);
  if (!limits) throw rpcDomainError(-32044, 'not_found', `Provider not found: ${id}`);
  const saved = services.providers.get(id);
  const keyRef = services.providerKeys.get(id);
  const keys = services.providerKeyEntries.list(id);
  const keyStatus: Provider['keyStatus'] =
    keyRef || keys.length
      ? keys.length && keys.every((key) => key.status === 'invalid')
        ? 'invalid'
        : (saved?.keyStatus ?? 'unchecked')
      : 'missing';
  const availableModels = saved?.availableModels;
  const modelCount = availableModels?.length ?? 0;
  const cooldown = services.cooldowns.get(id);
  const activeCooldown = cooldown && Date.parse(cooldown.until) > services.clock.now().getTime();
  const keyCooldown = !hasUsableProviderKey(services, id)
    ? keys
        .filter(
          (key) =>
            key.enabled &&
            key.status === 'rate_limited' &&
            key.cooldownUntil &&
            Date.parse(key.cooldownUntil) > services.clock.now().getTime(),
        )
        .map((key) => key.cooldownUntil)
        .sort()[0]
    : undefined;
  return ProviderSchema.parse({
    id,
    name: limits.name,
    tag: limits.tag,
    keyRequired: limits.key_required ?? true,
    ...(limits.free_plan === undefined
      ? {}
      : {
          freePlan: {
            sourceUrl: limits.free_plan.source_url,
            models: limits.free_plan.models,
            ...(limits.free_plan.excluded_models === undefined
              ? {}
              : { excludedModels: limits.free_plan.excluded_models }),
          },
        }),
    billingEnabled: saved?.billingEnabled ?? false,
    kind: limits.tag === 'subscription_cli' ? 'cli' : 'api',
    brand: null,
    keyStatus,
    keyCount: keys.length || (keyRef ? 1 : 0),
    autoDisableEnabled: saved?.autoDisableEnabled ?? true,
    autoDisableFailureCount: saved?.autoDisableFailureCount ?? 3,
    autoDisableFailureWindowMinutes: saved?.autoDisableFailureWindowMinutes ?? 10,
    autoDisableStatusCodes: saved?.autoDisableStatusCodes ?? [],
    autoDisableKeywords: saved?.autoDisableKeywords ?? [],
    autoDisableMinutes: saved?.autoDisableMinutes ?? 60,
    enabled:
      saved?.enabled ?? (hasUsableProviderKey(services, id) || limits.key_required === false),
    health:
      activeCooldown || keyCooldown
        ? 'cooldown'
        : saved?.health === 'cooldown'
          ? 'ok'
          : (saved?.health ?? (keyStatus === 'invalid' ? 'auth_invalid' : 'unknown')),
    cooldownUntil: activeCooldown ? cooldown.until : (keyCooldown ?? null),
    cooldownProvenance:
      activeCooldown && cooldownReasonsEnabled(services) ? (cooldown.provenance ?? null) : null,
    dataUse: limits.data_use,
    termsNote: limits.terms_note,
    signupUrl: limits.signup_url,
    docsUrl: limits.docs_url,
    verifiedAt: limits.verified_at,
    modelCount,
    ...(availableModels ? { availableModels } : {}),
    modelsVerifiedAt: saved?.modelsVerifiedAt ?? null,
    discoveryFailedAt: saved?.discoveryFailedAt ?? null,
    discoveryFailures: saved?.discoveryFailures ?? 0,
    discoveryErrorClass: saved?.discoveryErrorClass ?? null,
    discoveryUnsupported: saved?.discoveryUnsupported ?? false,
    freeTierUnsupported: saved?.freeTierUnsupported ?? false,
    excludedModelRefs: saved?.excludedModelRefs ?? [],
    windows: services.quota.getWindows(id),
    stepsLeftToday: services.quota.stepsLeft(id),
  });
}

function ensureLegacyKeyEntry(services: FerryServices, id: string) {
  const entries = services.providerKeyEntries.list(id);
  if (entries.length) return entries;
  const legacyKey = services.providerKeys.get(id);
  if (!legacyKey) return entries;
  const now = services.clock.now().toISOString();
  const entry = {
    id: `${id}:1`,
    providerId: id,
    keyId: '1',
    label: 'Key 1',
    position: 0,
    enabled: true,
    status: 'ok' as const,
    lastError: null,
    cooldownUntil: null,
    keyringRef: legacyKey.keyringRef,
    createdAt: legacyKey.createdAt,
    updatedAt: now,
  };
  services.providerKeyEntries.put(entry);
  return [entry];
}

function saveProvider(services: FerryServices, provider: Provider): Provider {
  services.providers.put(ProviderSchema.parse(provider));
  return provider;
}

const probeBackoff = new WeakMap<
  FerryServices,
  Map<string, { failures: number; retryAt: number }>
>();
export function register(host: CoreHost, services: FerryServices): void {
  const providerProbeBackoff =
    probeBackoff.get(services) ?? new Map<string, { failures: number; retryAt: number }>();
  probeBackoff.set(services, providerProbeBackoff);
  const modelDiscovery = getModelDiscovery(host, services);
  const health = getProviderHealth(services);
  const unsubscribeHealth = health.onChange((value) => {
    host.emit('providers.health.updated', value);
  });
  const recoveryTimer = setInterval(() => {
    void health.recover();
  }, 1_000);
  recoveryTimer.unref();
  const discoveryTimer = setInterval(() => {
    for (const { provider: id } of services.catalog.providers)
      void modelDiscovery.refreshIfStale(id).catch(() => undefined);
  }, 60_000);
  discoveryTimer.unref();
  let healthRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let offlineRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleOfflineRecovery = () => {
    if (offlineRecoveryTimer) clearTimeout(offlineRecoveryTimer);
    offlineRecoveryTimer = undefined;
    if (!isCoreWindowActive() || providerProbeBackoff.size === 0) return;
    const now = services.clock.now().getTime();
    const nextRetry = Math.min(...[...providerProbeBackoff.values()].map((item) => item.retryAt));
    offlineRecoveryTimer = setTimeout(
      () => {
        offlineRecoveryTimer = undefined;
        for (const [id, backoff] of providerProbeBackoff) {
          if (backoff.retryAt > services.clock.now().getTime()) continue;
          providerProbeBackoff.set(id, {
            ...backoff,
            retryAt: services.clock.now().getTime() + 30_000,
          });
          void host
            .dispatch({
              jsonrpc: '2.0',
              id: 'offline-recovery',
              method: 'providers.probe',
              params: [id],
            })
            .catch(() => undefined);
        }
        scheduleOfflineRecovery();
      },
      Math.max(250, nextRetry - now),
    );
    offlineRecoveryTimer.unref();
  };
  const scheduleHealthRecovery = () => {
    if (healthRecoveryTimer) clearTimeout(healthRecoveryTimer);
    healthRecoveryTimer = undefined;
    if (!isCoreWindowActive()) return;
    healthRecoveryTimer = setTimeout(
      () => {
        healthRecoveryTimer = undefined;
        for (const { provider: id } of services.catalog.providers) {
          const saved = services.providers.get(id);
          if (!saved) continue;
          const entries = services.providerKeyEntries.list(id);
          const unhealthyKeys = entries.filter(
            (entry) =>
              entry.enabled &&
              (entry.status === 'invalid' ||
                (entry.status === 'disabled' &&
                  entry.cooldownUntil !== null &&
                  Date.parse(entry.cooldownUntil) <= services.clock.now().getTime()) ||
                (entry.status === 'rate_limited' &&
                  (!entry.cooldownUntil ||
                    Date.parse(entry.cooldownUntil) <= services.clock.now().getTime()))),
          );
          if (unhealthyKeys.length) {
            for (const entry of unhealthyKeys)
              void host
                .dispatch({
                  jsonrpc: '2.0',
                  id: `key-recovery-${id}-${entry.keyId}`,
                  method: 'providers.probe',
                  params: [id, entry.keyId],
                })
                .catch(() => undefined);
          } else if (
            (saved.health !== 'ok' || saved.keyStatus === 'invalid') &&
            hasUsableProviderKey(services, id)
          ) {
            void modelDiscovery.refreshIfStale(id);
          }
        }
        scheduleHealthRecovery();
      },
      60 * 60 * 1000,
    );
    healthRecoveryTimer.unref();
  };
  const unsubscribeWindowActivity = onCoreWindowActiveChange((active) => {
    if (!active) {
      if (offlineRecoveryTimer) clearTimeout(offlineRecoveryTimer);
      if (healthRecoveryTimer) clearTimeout(healthRecoveryTimer);
      offlineRecoveryTimer = undefined;
      healthRecoveryTimer = undefined;
      return;
    }
    services.catalog.providers.forEach(({ provider: id }) => {
      const saved = services.providers.get(id);
      if (
        hasUsableProviderKey(services, id) ||
        (saved?.enabled &&
          services.catalog.providers.find((item) => item.provider === id)?.key_required === false)
      )
        void modelDiscovery.refreshIfStale(id);
    });
    scheduleOfflineRecovery();
    scheduleHealthRecovery();
  });
  host.onStart(async () => {
    const testProviderIds =
      services.env.FERRY_E2E_PROVIDER_IDS?.split(',')
        .map((id) => id.trim())
        .filter(Boolean) ??
      (services.env.FERRY_E2E_PROVIDER_ID ? [services.env.FERRY_E2E_PROVIDER_ID] : []);
    const testProviderKey = services.env.FERRY_E2E_PROVIDER_KEY;
    if (services.env.FERRY_E2E_USER_DATA_DIR && testProviderIds.length && testProviderKey) {
      for (const rawId of testProviderIds) {
        const id = ProviderIdInput.parse(rawId);
        await services.secrets.set(id, testProviderKey);
        services.providerKeys.put({
          id,
          providerId: id,
          keyringRef: id,
          createdAt: services.clock.now().toISOString(),
        });
        services.providerKeyEntries.put({
          id: `${id}:1`,
          providerId: id,
          keyId: '1',
          label: 'Key 1',
          position: 0,
          enabled: true,
          status: 'ok',
          lastError: null,
          cooldownUntil: null,
          keyringRef: id,
          createdAt: services.clock.now().toISOString(),
          updatedAt: services.clock.now().toISOString(),
        });
        const current = providerRecord(services, id);
        saveProvider(services, {
          ...current,
          enabled: true,
          availableModels: [],
          modelsVerifiedAt: null,
          discoveryFailedAt: null,
          discoveryFailures: 0,
          discoveryErrorClass: null,
          discoveryUnsupported: false,
          freeTierUnsupported: false,
          excludedModelRefs: [],
        });
        invalidateSessionProviderKeyCache(services, id);
        // The bundled CLI integration fixture must be routable before its first request.
        // The base URL is restricted to loopback while NODE_ENV=test in model discovery.
        await modelDiscovery.refresh(id);
      }
    }
    services.catalog.providers.forEach(({ provider: id }) => {
      const saved = services.providers.get(id);
      const key = services.providerKeys.get(id);
      const limits = services.catalog.providers.find((item) => item.provider === id);
      if (isCoreWindowActive() && (key || (saved?.enabled && limits?.key_required === false)))
        void modelDiscovery.refreshIfStale(id);
    });
    scheduleOfflineRecovery();
    scheduleHealthRecovery();
  });
  host.onShutdown(async () => {
    clearInterval(recoveryTimer);
    clearInterval(discoveryTimer);
    unsubscribeHealth();
    await health.dispose();
    if (healthRecoveryTimer) clearTimeout(healthRecoveryTimer);
    if (offlineRecoveryTimer) clearTimeout(offlineRecoveryTimer);
    healthRecoveryTimer = undefined;
    offlineRecoveryTimer = undefined;
    await modelDiscovery.dispose();
    unsubscribeWindowActivity();
  });
  host.registerDomain('providers', {
    health() {
      return services.catalog.providers.map(({ provider: id }) => health.snapshot(id));
    },
    list() {
      return services.catalog.providers.map((entry) => providerRecord(services, entry.provider));
    },
    async listKeys(rawId: unknown) {
      const id = ProviderIdInput.parse(rawId);
      return Promise.all(
        ensureLegacyKeyEntry(services, id).map(async (entry) => {
          const secret = await services.secrets.get(entry.keyringRef);
          return ProviderKeySchema.parse({
            id: entry.keyId,
            providerId: id,
            label: entry.label,
            order: entry.position,
            enabled: entry.enabled,
            status: entry.enabled ? entry.status : 'disabled',
            lastFour: secret?.slice(-4) ?? '',
            usageToday: services.providerKeyUsage.today(id, entry.keyId, services.clock.now()),
            lastError: entry.lastError,
            cooldownUntil: entry.cooldownUntil,
          });
        }),
      );
    },
    effectiveOverrides(rawId: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const stored = services.settings.get('global');
      const routing =
        typeof stored === 'object' && stored !== null && 'routing' in stored
          ? stored.routing
          : undefined;
      const custom = RoutingSettingsSchema.parse(routing ?? {}).providerOverrides[id];
      return resolveProviderRequestOverrides(id, custom);
    },
    async addKey(rawId: unknown, rawLabel: unknown, rawKey: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const label = z.string().trim().min(1).max(80).parse(rawLabel);
      const key = KeyInput.parse(rawKey);
      const entries = ensureLegacyKeyEntry(services, id);
      const keyId = String(Math.max(0, ...entries.map((entry) => Number(entry.keyId) || 0)) + 1);
      const keyringRef = `${id}:${keyId}`;
      const now = services.clock.now().toISOString();
      await services.secrets.set(keyringRef, key);
      services.providerKeyEntries.put({
        id: `${id}:${keyId}`,
        providerId: id,
        keyId,
        label,
        position: entries.length,
        enabled: true,
        status: 'ok',
        lastError: null,
        cooldownUntil: null,
        keyringRef,
        createdAt: now,
        updatedAt: now,
      });
      if (!services.providerKeys.get(id))
        services.providerKeys.put({ id, providerId: id, keyringRef, createdAt: now });
      invalidateSessionProviderKeyCache(services, id);
      const provider = saveProvider(services, {
        ...providerRecord(services, id),
        keyStatus: 'unchecked',
        enabled: true,
      });
      host.emit('provider.updated', provider);
      void modelDiscovery.keyChanged(id).catch(() => undefined);
      return {
        id: keyId,
        providerId: id,
        label,
        order: entries.length,
        enabled: true,
        status: 'ok' as const,
        lastFour: key.slice(-4),
        usageToday: { requests: 0, tokens: 0 },
        lastError: null,
        cooldownUntil: null,
      };
    },
    async setKey(rawId: unknown, rawKey: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const key = KeyInput.parse(rawKey);
      const current = providerRecord(services, id);
      const entries = services.providerKeyEntries.list(id);
      const primary = entries[0];
      const legacyKey = services.providerKeys.get(id);
      const keyId = primary?.keyId ?? '1';
      const now = services.clock.now().toISOString();
      await services.secrets.set(id, key);
      services.providerKeys.put({
        id,
        providerId: id,
        keyringRef: id,
        createdAt: primary?.createdAt ?? now,
      });
      services.providerKeyEntries.put({
        id: primary?.id ?? `${id}:${keyId}`,
        providerId: id,
        keyId,
        label: primary?.label ?? 'Key 1',
        position: 0,
        enabled: true,
        status: 'ok',
        lastError: null,
        cooldownUntil: null,
        keyringRef: id,
        createdAt: primary?.createdAt ?? now,
        updatedAt: now,
      });
      const replacedKeyringRefs = new Set([
        ...(primary ? [primary.keyringRef] : []),
        ...(legacyKey ? [legacyKey.keyringRef] : []),
      ]);
      for (const keyringRef of replacedKeyringRefs)
        if (keyringRef !== id) await services.secrets.delete(keyringRef);
      invalidateSessionProviderKeyCache(services, id);
      const provider = saveProvider(services, {
        ...current,
        keyStatus: 'unchecked',
        enabled: true,
        health: 'unknown',
        cooldownUntil: null,
        availableModels: current.availableModels ?? [],
        modelsVerifiedAt: current.modelsVerifiedAt ?? null,
        discoveryFailedAt: null,
        discoveryFailures: 0,
        discoveryErrorClass: null,
        discoveryUnsupported: false,
        freeTierUnsupported: false,
        excludedModelRefs: [],
      });
      host.emit('provider.updated', provider);
      void modelDiscovery.keyChanged(id).catch(() => undefined);
      return provider;
    },
    async removeKey(rawId: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const current = providerRecord(services, id);
      const keyringRefs = new Set([
        id,
        ...services.providerKeyEntries.list(id).map((entry) => entry.keyringRef),
      ]);
      for (const keyringRef of keyringRefs) await services.secrets.delete(keyringRef);
      services.providerKeys.delete(id);
      for (const entry of services.providerKeyEntries.list(id))
        services.providerKeyEntries.delete(id, entry.keyId);
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
    async removeKeyEntry(rawId: unknown, rawKeyId: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const keyId = z.string().min(1).parse(rawKeyId);
      const entry = services.providerKeyEntries.list(id).find((item) => item.keyId === keyId);
      if (!entry) return;
      await services.secrets.delete(entry.keyringRef);
      services.providerKeyEntries.delete(id, keyId);
      const remaining = services.providerKeyEntries.list(id);
      if (remaining.length) {
        const first = remaining[0];
        if (first)
          services.providerKeys.put({
            id,
            providerId: id,
            keyringRef: first.keyringRef,
            createdAt: first.createdAt,
          });
      } else {
        services.providerKeys.delete(id);
      }
      invalidateSessionProviderKeyCache(services, id);
      const current = providerRecord(services, id);
      const provider = saveProvider(services, {
        ...current,
        keyStatus: remaining.length ? current.keyStatus : 'missing',
        enabled: remaining.length > 0 && current.enabled,
      });
      host.emit('provider.updated', provider);
    },
    setKeyEnabled(rawId: unknown, rawKeyId: unknown, rawEnabled: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const keyId = z.string().min(1).parse(rawKeyId);
      const enabled = EnabledInput.parse(rawEnabled);
      const entry = services.providerKeyEntries.list(id).find((item) => item.keyId === keyId);
      if (!entry)
        throw rpcDomainError(-32044, 'not_found', `Provider key not found: ${id}/${keyId}`);
      services.providerKeyEntries.put({
        ...entry,
        enabled,
        status: enabled ? (entry.status === 'disabled' ? 'ok' : entry.status) : 'disabled',
        updatedAt: services.clock.now().toISOString(),
      });
      invalidateSessionProviderKeyCache(services, id);
    },
    reorderKeys(rawId: unknown, rawKeyIds: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const keyIds = z.array(z.string().min(1)).parse(rawKeyIds);
      const entries = services.providerKeyEntries.list(id);
      if (
        keyIds.length !== entries.length ||
        new Set(keyIds).size !== entries.length ||
        entries.some((entry) => !keyIds.includes(entry.keyId))
      )
        throw rpcDomainError(
          -32602,
          'validation',
          'Key order must include each provider key exactly once',
        );
      const now = services.clock.now().toISOString();
      keyIds.forEach((keyId, position) => {
        const entry = entries.find((item) => item.keyId === keyId);
        if (entry) services.providerKeyEntries.put({ ...entry, position, updatedAt: now });
      });
    },
    setAutoDisablePolicy(rawId: unknown, rawPolicy: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const policy = z
        .object({
          enabled: z.boolean(),
          failureCount: z.number().int().min(2).max(20),
          failureWindowMinutes: z.number().int().min(1).max(1440),
          statusCodes: z.array(z.number().int().min(100).max(599)),
          keywords: z.array(z.string().trim().min(1).max(120)),
          disableMinutes: z.number().int().min(1).max(1440),
        })
        .parse(rawPolicy);
      const current = providerRecord(services, id);
      const provider = saveProvider(services, {
        ...current,
        autoDisableEnabled: policy.enabled,
        autoDisableFailureCount: policy.failureCount,
        autoDisableFailureWindowMinutes: policy.failureWindowMinutes,
        autoDisableStatusCodes: policy.statusCodes,
        autoDisableKeywords: policy.keywords,
        autoDisableMinutes: policy.disableMinutes,
      });
      host.emit('provider.updated', provider);
      return provider;
    },
    probe: (rawId: unknown, rawKeyId?: unknown) =>
      health.runProbe(async () => {
        const id = ProviderIdInput.parse(rawId);
        const current = providerRecord(services, id);
        const keyEntries = ensureLegacyKeyEntry(services, id);
        const requestedKeyId =
          rawKeyId === undefined ? undefined : z.string().min(1).parse(rawKeyId);
        const keyEntry = requestedKeyId
          ? keyEntries.find((entry) => entry.keyId === requestedKeyId)
          : (keyEntries.find((entry) => entry.enabled && entry.status !== 'invalid') ??
            keyEntries[0]);
        const key = keyEntry
          ? await services.secrets.get(keyEntry.keyringRef)
          : await services.secrets.get(services.providerKeys.get(id)?.keyringRef ?? id);
        const backoff = providerProbeBackoff.get(id);
        const nowMs = services.clock.now().getTime();
        if (backoff && backoff.retryAt > nowMs) {
          return ProbeResultSchema.parse({
            ok: false,
            keyValid: true,
            latencyMs: null,
            message: 'Provider probe paused while offline; retrying automatically.',
            windows: [],
            models: [],
            errorKind: 'offline',
          });
        }
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
        const stored = services.settings.get('global');
        const routing =
          typeof stored === 'object' && stored !== null && 'routing' in stored
            ? stored.routing
            : undefined;
        const overrides = RoutingSettingsSchema.parse(routing ?? {}).providerOverrides[id];
        const result = ProbeResultSchema.parse(
          await probe(id, key, {
            ...(baseUrl ? { baseUrl } : {}),
            overrides: resolveProviderRequestOverrides(id, overrides),
          }),
        );
        if (keyEntry) {
          const status = result.ok
            ? 'ok'
            : result.errorKind === 'auth'
              ? 'invalid'
              : result.errorKind === 'rate_limit' || result.errorKind === 'quota_exhausted'
                ? 'rate_limited'
                : keyEntry.status;
          services.providerKeyEntries.put({
            ...keyEntry,
            status,
            lastError: result.ok ? null : redactKnownSecretText(result.message),
            cooldownUntil:
              status === 'rate_limited'
                ? (result.windows.find((window) => window.resetAt)?.resetAt ??
                  new Date(services.clock.now().getTime() + 60_000).toISOString())
                : null,
            updatedAt: services.clock.now().toISOString(),
          });
        }
        if (result.errorKind === 'offline') {
          const failures = (providerProbeBackoff.get(id)?.failures ?? 0) + 1;
          providerProbeBackoff.set(id, {
            failures,
            retryAt: nowMs + Math.min(60_000, 2_000 * 2 ** Math.min(failures - 1, 5)),
          });
        } else if (result.ok) providerProbeBackoff.delete(id);
        scheduleOfflineRecovery();
        let discovered: Awaited<ReturnType<typeof discoverProviderModels>> = [];
        let discoverySucceeded = false;
        if (result.ok) {
          try {
            discovered = await discoverProviderModels(id, key, { ...(baseUrl ? { baseUrl } : {}) });
            discovered = discovered.map((model) => ({
              ...model,
              verified: true,
              verifiedAt: services.clock.now().toISOString(),
            }));
            discoverySucceeded = true;
            health.tracker.discovered(id);
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
          discoverySucceeded
            ? discovered
            : current.discoveryUnsupported
              ? knownProbeModels.map((model) => ({ ...model, verified: false, verifiedAt: null }))
              : services.models.list(id)
        ).filter((model) => !unavailableIds.has(model.ref.slice(id.length + 1)));
        const persistedModels = result.ok
          ? availableModels
          : (current.availableModels ?? []).filter(
              (model) => !unavailableIds.has(model.ref.slice(id.length + 1)),
            );
        const excludedModelRefs = new Set([
          ...(current.excludedModelRefs ?? []),
          ...(result.skippedModels ?? []).flatMap((item) => {
            const model = [...services.catalog.models, ...services.models.list(id)].find(
              (candidate) =>
                candidate.providerId === id && candidate.ref.slice(id.length + 1) === item.model,
            );
            return model ? [model.ref] : [];
          }),
        ]);
        if (discoverySucceeded)
          for (const model of persistedModels) excludedModelRefs.delete(model.ref);
        const now = services.clock.now().toISOString();
        const limits = services.catalog.providers.find((item) => item.provider === id);
        const modelRef = services.catalog.models.find((model) => model.providerId === id)?.ref;
        const observedModel = result.usedModel
          ? result.usedModel.startsWith(id + '/')
            ? result.usedModel
            : id + '/' + result.usedModel
          : modelRef;
        for (const observation of observationsFromProbe({
          providerId: id,
          modelRef: observedModel,
          windows: result.windows,
          definitions: limits?.windows ?? [],
          source: id === 'openrouter' ? 'endpoint' : 'header',
          observedAt: now,
        }))
          services.quota.observe(QuotaObservationSchema.parse(observation));
        const cooldownModel = modelRef ?? id;
        if (result.errorKind === 'rate_limit' || result.errorKind === 'quota_exhausted') {
          const cooldown = services.quota.noteFailure(
            id,
            cooldownModel,
            keyEntry?.keyId ?? id,
            '429',
            result.windows.find((window) => window.resetAt)?.resetAt ?? undefined,
          );
          if (cooldown.cooldownUntil && !keyEntry)
            services.cooldowns.put({
              id,
              until: cooldown.cooldownUntil,
              ...(cooldownReasonsEnabled(services)
                ? {
                    provenance: result.windows.some((window) => window.resetAt)
                      ? 'authoritative'
                      : 'heuristic',
                  }
                : {}),
            });
        } else if (result.ok) {
          services.quota.noteSuccess(id, cooldownModel, keyEntry?.keyId ?? id);
          services.cooldowns.delete(id);
        }
        const usableKey = hasUsableProviderKey(services, id);
        const rateLimited =
          result.errorKind === 'rate_limit' || result.errorKind === 'quota_exhausted';
        const keyCooldown =
          rateLimited && !usableKey
            ? (services.providerKeyEntries
                .list(id)
                .map((entry) => entry.cooldownUntil)
                .filter((until): until is string => until !== null)
                .sort()[0] ?? null)
            : null;
        const provider = saveProvider(services, {
          ...current,
          keyStatus: result.keyValid || hasUsableProviderKey(services, id) ? 'valid' : 'invalid',
          health: result.ok
            ? 'ok'
            : result.errorKind === 'auth'
              ? usableKey
                ? 'ok'
                : 'auth_invalid'
              : rateLimited
                ? usableKey
                  ? 'ok'
                  : 'cooldown'
                : services.cooldowns.get(id)
                  ? 'cooldown'
                  : 'down',
          cooldownUntil: services.cooldowns.get(id)?.until ?? keyCooldown,
          freeTierUnsupported:
            result.errorKind === 'unsupported_free_tier'
              ? true
              : result.ok
                ? false
                : (current.freeTierUnsupported ?? false),
          excludedModelRefs: [...excludedModelRefs],
          windows: services.quota.getWindows(id),
          stepsLeftToday: services.quota.stepsLeft(id),
          verifiedAt: result.ok
            ? services.clock.now().toISOString().slice(0, 10)
            : current.verifiedAt,
          ...(result.ok || result.skippedModels?.length
            ? {
                availableModels: persistedModels,
                modelsVerifiedAt: discoverySucceeded
                  ? services.clock.now().toISOString()
                  : (current.modelsVerifiedAt ?? null),
                modelCount: persistedModels.length,
              }
            : {}),
        });
        if (result.ok) services.models.replace(id, persistedModels, now);
        health.record({
          providerId: id,
          keyId: keyEntry?.id ?? id,
          success: result.ok,
          latencyMs: result.latencyMs ?? 0,
          status: result.ok
            ? 200
            : result.errorKind === 'auth'
              ? 401
              : result.errorKind === 'rate_limit' || result.errorKind === 'quota_exhausted'
                ? 429
                : result.errorKind === 'model_not_found'
                  ? 404
                  : 503,
          message: result.message,
          retryAfter: result.windows.find((window) => window.resetAt)?.resetAt ?? undefined,
        });
        host.emit('provider.updated', provider);
        return result;
      }),
    setEnabled(rawId: unknown, rawEnabled: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const enabled = EnabledInput.parse(rawEnabled);
      const current = providerRecord(services, id);
      const provider = saveProvider(services, { ...current, enabled });
      host.emit('provider.updated', provider);
      return provider;
    },
    setBillingEnabled(rawId: unknown, rawEnabled: unknown) {
      const id = ProviderIdInput.parse(rawId);
      const billingEnabled = EnabledInput.parse(rawEnabled);
      const current = providerRecord(services, id);
      const provider = saveProvider(services, { ...current, billingEnabled });
      host.emit('provider.updated', provider);
      return provider;
    },
  });
}
