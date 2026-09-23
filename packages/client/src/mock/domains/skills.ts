import { MockNotFoundError } from '../errors.js';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createSkillsDomain(_store: MockStore, deps: MockDeps): FerryClient['skills'] {
  const { state, before, persist, syncStore } = deps;
  return {
    async list() {
      await before();
      return structuredClone(state.skills);
    },
    async setEnabled(id, v) {
      await before();
      const x = state.skills.find((x) => x.id === id);
      if (!x) throw new MockNotFoundError('Skill', id);
      x.enabled = v;
      persist();
      syncStore();
      return structuredClone(x);
    },
  };
}
