import { mockFailures } from '../failures.js';
import { MockNotFoundError } from '../errors.js';
import {
  ProviderRequestOverridesSchema,
  FailureOptionsSchema,
  ProviderHealthSnapshotSchema,
  ProviderCheckOptionsSchema,
  providerDefinition,
  type ProbeResult,
} from '@ferry/shared';
import type { ProviderKey } from '@ferry/shared';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createProvidersDomain(_store: MockStore, deps: MockDeps): FerryClient['providers'] {
  const { state, rng, before, persist, emit } = deps;
  const keys = state.providerKeys;
  const keyless = (provider: import('@ferry/shared').Provider) => {
    const auth = providerDefinition(provider.id)?.auth;
    return provider.keyRequired === false || auth === 'local' || auth === 'anonymous';
  };
  let check: import('@ferry/shared').ProviderCheckProgress = {
    id: 'previous',
    running: false,
    cancelled: false,
    results: [],
    error: null,
  };
  const resume = async (id: import('@ferry/shared').ProviderId) => {
    await before();
    const provider = state.providers.find((item) => item.id === id);
    if (!provider) throw new MockNotFoundError('Provider', id);
    provider.enabled = true;
    provider.pausedReason = null;
    state.failureResets[id] = state.requestFailures
      .filter((row) => row.providerId === id)
      .map((row) => row.id);
    emit('provider.updated', provider);
    persist();
    return structuredClone(provider);
  };
  return {
    async zenCliStatus() {
      await before();
      return {
        available: true,
        version: 'Preview',
        executable: 'opencode',
        credentialSource: 'opencode',
        freeModels: state.models
          .filter((model) => model.providerId === 'opencode' && model.free)
          .map((model) => ({ ref: model.ref, name: model.name })),
        verifiedModels:
          state.providers
            .find((provider) => provider.id === 'opencode')
            ?.availableModels?.filter((model) => model.cliAccessVerified)
            .map((model) => model.ref) ?? [],
      };
    },
    async verifyZenCli(ref) {
      await before();
      const provider = state.providers.find((provider) => provider.id === 'opencode');
      const model = state.models.find(
        (model) =>
          model.providerId === 'opencode' && model.free && (ref === undefined || model.ref === ref),
      );
      if (!provider || !model) throw new Error('No free Zen model available in this preview');
      model.cliAccessVerified = true;
      model.transport = state.settings.opencodeZenTransport === 'cli' ? 'opencode_cli' : 'api';
      provider.enabled = true;
      provider.availableModels = state.models.filter((model) => model.providerId === provider.id);
      persist();
      emit('provider.updated', provider);
      return {
        ok: true,
        modelRef: model.ref,
        message: 'Preview: free generation verified through OpenCode CLI.',
      };
    },
    startChecks: (rawOptions) => {
      const options = ProviderCheckOptionsSchema.parse(rawOptions ?? {});
      check = {
        id: crypto.randomUUID(),
        running: false,
        cancelled: false,
        results: state.providers
          .filter(
            (provider) =>
              provider.enabled &&
              provider.kind === 'api' &&
              (keyless(provider) ||
                ['valid', 'not_applicable', 'unchecked'].includes(provider.keyStatus)) &&
              (!provider.cooldownUntil ||
                Date.parse(provider.cooldownUntil) <= deps.clock.now().getTime()),
          )
          .flatMap((provider) => {
            const model = state.models.find(
              (model) =>
                model.providerId === provider.id &&
                (options.approvedCostUsd === undefined
                  ? // Mock fixtures already classify their models' free access;
                    // they do not carry the full production free-plan catalog.
                    model.free && !provider.billingEnabled
                  : !model.free || provider.billingEnabled === true),
            );
            return model
              ? [
                  {
                    providerId: provider.id,
                    modelRef: model.ref,
                    ok: true,
                    at: new Date().toISOString(),
                    firstResponseMs: 100,
                    completionMs: 180,
                    sampleCount: 1 as const,
                    paid: options.approvedCostUsd !== undefined,
                    costUsd: 0,
                    message:
                      'Web preview fixture: reachable. One sample does not measure coding quality.',
                    features:
                      'Text generation tested; tools, structured output and multimodal compatibility require request-specific verification.' as const,
                  },
                ]
              : [];
          }),
        error: null,
      };
      check.entries = state.providers
        .filter((provider) => provider.enabled || provider.keyStatus === 'valid')
        .map((provider) => {
          const result = check.results.find((result) => result.providerId === provider.id);
          return {
            providerId: provider.id,
            name: provider.name,
            modelRef: result?.modelRef ?? null,
            state: result ? ('complete' as const) : ('skipped' as const),
            ...(!result
              ? {
                  reason: !provider.enabled
                    ? 'Disabled or paused. Enable this provider before checking.'
                    : provider.kind !== 'api'
                      ? 'This connection uses its account or CLI verification flow.'
                      : provider.cooldownUntil &&
                          Date.parse(provider.cooldownUntil) > deps.clock.now().getTime()
                        ? 'Provider is cooling down. Check again after its limit resets.'
                        : !keyless(provider) && ['missing', 'invalid'].includes(provider.keyStatus)
                          ? 'Connect usable credentials first.'
                          : 'No eligible connected free model available in this preview fixture.',
                }
              : {}),
          };
        });
      emit('providers.check', check);
      return Promise.resolve({ id: check.id });
    },
    checkProgress: (id) =>
      id === undefined || id === check.id
        ? Promise.resolve(structuredClone(check))
        : Promise.reject(new Error('Unknown check.')),
    cancelChecks: (id) => {
      if (id !== check.id) return Promise.reject(new Error('Unknown check.'));
      check = { ...check, cancelled: true, running: false };
      emit('providers.check', check);
      return Promise.resolve(structuredClone(check));
    },
    resume,
    async clearFailures(id) {
      await before();
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) throw new MockNotFoundError('Provider', id);
      state.requestFailures.splice(
        0,
        state.requestFailures.length,
        ...state.requestFailures.filter((row) => row.providerId !== id),
      );
      emit('provider.updated', provider);
      persist();
    },
    async failures(id, options) {
      await before();
      if (id && !state.providers.some((item) => item.id === id))
        throw new MockNotFoundError('Provider', id);
      return structuredClone(
        mockFailures(state, deps.clock.now(), id, FailureOptionsSchema.parse(options ?? {})),
      );
    },
    async health() {
      await before();
      return state.providers.map((provider) =>
        ProviderHealthSnapshotSchema.parse({
          providerId: provider.id,
          state:
            provider.health === 'down' ? 'down' : provider.health === 'ok' ? 'healthy' : 'degraded',
          breaker: provider.health === 'down' ? 'open' : 'closed',
          openedAt: null,
          nextProbeAt: null,
          lastError: null,
          keys: (keys.get(provider.id) ?? []).map((key) => ({
            keyId: key.id,
            cooldownUntil: key.cooldownUntil,
            reason: key.lastError,
          })),
          lockedModels: [],
          latencyP50Ms: null,
          latencyP95Ms: null,
          successRate1h: null,
        }),
      );
    },
    async list() {
      await before();
      return structuredClone(state.providers);
    },
    async listKeys(id) {
      await before();
      return structuredClone(keys.get(id) ?? []);
    },
    async effectiveOverrides(id) {
      await before();
      return ProviderRequestOverridesSchema.parse(
        state.settings.routing.providerOverrides[id] ?? {},
      );
    },
    async setKey(id, key) {
      await before();
      if (!key) throw new Error('Key cannot be empty');
      const p = state.providers.find((p) => p.id === id);
      if (!p) throw new MockNotFoundError('Provider', id);
      const existing = keys.get(id) ?? [];
      const primary = existing.find((entry) => entry.order === 0);
      const updated: ProviderKey = {
        id: primary?.id ?? '1',
        providerId: id,
        label: primary?.label ?? 'Key 1',
        order: 0,
        enabled: true,
        status: key.startsWith('bad') ? 'invalid' : 'ok',
        lastFour: key.slice(-4),
        usageToday: primary?.usageToday ?? { requests: 0, tokens: 0 },
        lastError: key.startsWith('bad') ? 'Provider key is invalid' : null,
        cooldownUntil: null,
      };
      keys.set(
        id,
        primary ? existing.map((entry) => (entry.id === primary.id ? updated : entry)) : [updated],
      );
      p.keyCount = keys.get(id)?.length ?? 0;
      const usableKey = keys
        .get(id)
        ?.some(
          (entry) => entry.enabled && entry.status !== 'invalid' && entry.status !== 'disabled',
        );
      p.keyStatus = usableKey ? 'unchecked' : 'invalid';
      p.enabled = !p.pausedReason;
      emit('provider.updated', p);
      persist();
      return structuredClone(p);
    },
    async addKey(id, label, key) {
      await before();
      if (!key) throw new Error('Key cannot be empty');
      const p = state.providers.find((p) => p.id === id);
      if (!p) throw new MockNotFoundError('Provider', id);
      const items = keys.get(id) ?? [];
      if (['opencode', 'opencode-zen'].includes(id) && items.length)
        throw new Error('Zen uses one account key. Replace it instead of stacking keys.');
      const item: ProviderKey = {
        id: String(Math.max(0, ...items.map((entry) => Number(entry.id) || 0)) + 1),
        providerId: id,
        label,
        order: items.length,
        enabled: true,
        status: key.startsWith('bad') ? 'invalid' : 'ok',
        lastFour: key.slice(-4),
        usageToday: { requests: 0, tokens: 0 },
        lastError: null,
        cooldownUntil: null,
      };
      keys.set(id, [...items, item]);
      p.keyCount = items.length + 1;
      const usableKey = [...items, item].some(
        (entry) => entry.enabled && entry.status !== 'invalid' && entry.status !== 'disabled',
      );
      p.keyStatus = usableKey ? 'unchecked' : 'invalid';
      p.enabled = !p.pausedReason;
      emit('provider.updated', p);
      persist();
      return structuredClone(item);
    },
    async removeKey(id) {
      await before();
      const p = state.providers.find((p) => p.id === id);
      if (!p) throw new MockNotFoundError('Provider', id);
      p.keyStatus = 'missing';
      p.keyCount = 0;
      keys.delete(id);
      emit('provider.updated', p);
      persist();
      return structuredClone(p);
    },
    async removeKeyEntry(id, keyId) {
      await before();
      const remaining = (keys.get(id) ?? []).filter((entry) => entry.id !== keyId);
      keys.set(id, remaining);
      const p = state.providers.find((provider) => provider.id === id);
      if (p) {
        p.keyCount = remaining.length;
        if (!remaining.length) {
          p.keyStatus = 'missing';
          p.enabled = false;
        }
        emit('provider.updated', p);
      }
      persist();
    },
    async setKeyEnabled(id, keyId, enabled) {
      await before();
      keys.set(
        id,
        (keys.get(id) ?? []).map((entry) =>
          entry.id === keyId
            ? {
                ...entry,
                enabled,
                status: enabled ? (entry.status === 'disabled' ? 'ok' : entry.status) : 'disabled',
              }
            : entry,
        ),
      );
      persist();
    },
    async reorderKeys(id, keyIds) {
      await before();
      const items = keys.get(id) ?? [];
      if (items.length !== keyIds.length || new Set(keyIds).size !== keyIds.length)
        throw new Error('Key order must include each provider key exactly once');
      keys.set(
        id,
        keyIds.flatMap((keyId, order) => {
          const item = items.find((entry) => entry.id === keyId);
          return item ? [{ ...item, order }] : [];
        }),
      );
      persist();
    },
    async setAutoDisablePolicy(id, policy) {
      await before();
      const p = state.providers.find((p) => p.id === id);
      if (!p) throw new MockNotFoundError('Provider', id);
      p.autoDisableEnabled = policy.enabled;
      p.autoDisableFailureCount = policy.failureCount;
      p.autoDisableFailureWindowMinutes = policy.failureWindowMinutes;
      p.autoDisableStatusCodes = policy.statusCodes;
      p.autoDisableKeywords = policy.keywords;
      p.autoDisableMinutes = policy.disableMinutes;
      emit('provider.updated', p);
      persist();
      return structuredClone(p);
    },
    async probe(id, keyId): Promise<ProbeResult> {
      await before();
      const p = state.providers.find((p) => p.id === id);
      if (!p) throw new MockNotFoundError('Provider', id);
      if (p.keyStatus === 'not_applicable')
        return {
          ok: true,
          keyValid: true,
          latencyMs: null,
          message: 'CLI detected — no API key needed',
          windows: [],
          models: [],
          errorKind: null,
        };
      const entries = keys.get(id) ?? [];
      const entry = keyId
        ? entries.find((item) => item.id === keyId)
        : (entries.find((item) => item.enabled && item.status !== 'invalid') ?? entries[0]);
      if (
        p.keyStatus === 'missing' ||
        (entry ? entry.status === 'invalid' : p.keyStatus === 'invalid')
      )
        return {
          ok: false,
          keyValid: false,
          latencyMs: null,
          message: 'Provider key is unavailable',
          windows: p.windows,
          models: [],
          errorKind: 'auth',
        };
      p.keyStatus = 'valid';
      if (entry) {
        keys.set(
          id,
          (keys.get(id) ?? []).map((item) =>
            item.id === entry.id
              ? { ...item, status: 'ok', lastError: null, cooldownUntil: null }
              : item,
          ),
        );
      }
      emit('provider.updated', p);
      persist();
      return {
        ok: true,
        keyValid: true,
        latencyMs: rng.int(180, 900),
        message: 'Connected',
        windows: p.windows,
        models: [],
        errorKind: null,
      };
    },
    async setEnabled(id, v) {
      if (v) return resume(id);
      await before();
      const p = state.providers.find((p) => p.id === id);
      if (!p) throw new MockNotFoundError('Provider', id);
      p.enabled = v;
      emit('provider.updated', p);
      persist();
      return structuredClone(p);
    },
    async setBillingEnabled(id, v) {
      await before();
      const p = state.providers.find((p) => p.id === id);
      if (!p) throw new MockNotFoundError('Provider', id);
      p.billingEnabled = v;
      emit('provider.updated', p);
      persist();
      return structuredClone(p);
    },
  };
}
