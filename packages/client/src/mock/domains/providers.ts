import { MockNotFoundError } from '../errors.js';
import { ProviderRequestOverridesSchema, type ProbeResult } from '@ferry/shared';
import type { ProviderKey } from '@ferry/shared';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createProvidersDomain(_store: MockStore, deps: MockDeps): FerryClient['providers'] {
  const { state, rng, before, persist, emit } = deps;
  const keys = state.providerKeys;
  return {
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
      p.enabled = true;
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
      p.enabled = true;
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
