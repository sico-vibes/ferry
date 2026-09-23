import { MockNotFoundError } from '../errors.js';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createCheckpointsDomain(
  _store: MockStore,
  deps: MockDeps,
): FerryClient['checkpoints'] {
  const { state, before, emit } = deps;
  return {
    async list(id) {
      await before();
      return state.checkpoints.filter((c) => c.sessionId === id).map((c) => structuredClone(c));
    },
    async restore(id) {
      await before();
      const cp = state.checkpoints.find((c) => c.id === id);
      if (!cp) throw new MockNotFoundError('Checkpoint', id);
      emit('toast', { kind: 'success', title: `Restored checkpoint ${cp.label}`, body: null });
    },
  };
}
