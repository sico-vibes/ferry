import { MockNotFoundError } from '../errors.js';
import type { ProbeResult } from '@ferry/shared';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createProvidersDomain(_store: MockStore, deps: MockDeps): FerryClient['providers'] {
  const { state, rng, before, persist, emit } = deps;
  return {
    async list() {
      await before();
      return structuredClone(state.providers);
    },
    async setKey(id, key) {
      await before();
      if (!key) throw new Error('Key cannot be empty');
      const p = state.providers.find((p) => p.id === id);
      if (!p) throw new MockNotFoundError('Provider', id);
      p.keyStatus = key.startsWith('bad') ? 'invalid' : 'unchecked';
      p.enabled = true;
      emit('provider.updated', p);
      persist();
      return structuredClone(p);
    },
    async removeKey(id) {
      await before();
      const p = state.providers.find((p) => p.id === id);
      if (!p) throw new MockNotFoundError('Provider', id);
      p.keyStatus = 'missing';
      emit('provider.updated', p);
      persist();
      return structuredClone(p);
    },
    async probe(id): Promise<ProbeResult> {
      await before();
      const p = state.providers.find((p) => p.id === id);
      if (!p) throw new MockNotFoundError('Provider', id);
      if (p.keyStatus === 'missing' || p.keyStatus === 'invalid')
        return {
          ok: false,
          latencyMs: null,
          message: 'Provider key is unavailable',
          windows: p.windows,
        };
      p.keyStatus = 'valid';
      emit('provider.updated', p);
      persist();
      return { ok: true, latencyMs: rng.int(180, 900), message: 'Connected', windows: p.windows };
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
  };
}
