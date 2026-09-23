import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createOptimizerDomain(_store: MockStore, deps: MockDeps): FerryClient['optimizer'] {
  const { fixtures, before } = deps;
  return {
    async stats() {
      await before();
      return structuredClone(fixtures.optimizerStats);
    },
  };
}
