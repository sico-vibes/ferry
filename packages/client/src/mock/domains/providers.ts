import { MockNotFoundError } from '../errors.js';
import type { ProbeResult } from '@ferry/shared';
import type { ProviderKey } from '@ferry/shared';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createProvidersDomain(_store: MockStore, deps: MockDeps): FerryClient['providers'] {
  const { state, rng, before, persist, emit } = deps;
  const keys = new Map<string, ProviderKey[]>();
  return {
    async list() {
      await before();
      return structuredClone(state.providers);
    },
    async listKeys(id) {
      await before();
      return structuredClone(keys.get(id) ?? []);
    },
    async setKey(id, key) {
      await before();
      if (!key) throw new Error('Key cannot be empty');
      const p = state.providers.find((p) => p.id === id);
      if (!p) throw new MockNotFoundError('Provider', id);
      p.keyStatus = key.startsWith('bad') ? 'invalid' : 'unchecked';
      const existing = keys.get(id) ?? [];
      if (!existing.length)
        keys.set(id, [
          {
            id: '1',
            providerId: id,
            label: 'Key 1',
            order: 0,
            enabled: true,
            status: key.startsWith('bad') ? 'invalid' : 'ok',
            lastFour: key.slice(-4),
            usageToday: { requests: 0, tokens: 0 },
            lastError: null,
            cooldownUntil: null,
          },
        ]);
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
      p.keyStatus = key.startsWith('bad') ? 'invalid' : 'unchecked';
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
      keys.delete(id);
      emit('provider.updated', p);
      persist();
      return structuredClone(p);
    },
    async removeKeyEntry(id, keyId) {
      await before();
      keys.set(
        id,
        (keys.get(id) ?? []).filter((entry) => entry.id !== keyId),
      );
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
    async probe(id): Promise<ProbeResult> {
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
      if (p.keyStatus === 'missing' || p.keyStatus === 'invalid')
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
