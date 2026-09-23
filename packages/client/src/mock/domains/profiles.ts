import { MockNotFoundError } from '../errors.js';
import { ProfileSchema } from '@ferry/shared';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createProfilesDomain(_store: MockStore, deps: MockDeps): FerryClient['profiles'] {
  const { state, before, persist, syncStore, session, updateSession } = deps;
  return {
    async list() {
      await before();
      return structuredClone(state.profiles);
    },
    async save(profile) {
      await before();
      const p = ProfileSchema.parse(profile);
      const index = state.profiles.findIndex((x) => x.id === p.id);
      if (index < 0) state.profiles.push(p);
      else state.profiles[index] = p;
      persist();
      syncStore();
      return structuredClone(p);
    },
    async remove(id) {
      await before();
      const p = state.profiles.find((x) => x.id === id);
      if (!p) throw new MockNotFoundError('Profile', id);
      if (p.builtin) throw new Error('Builtin profiles cannot be removed');
      state.profiles = state.profiles.filter((x) => x.id !== id);
      persist();
      syncStore();
    },
    async activate(id, sessionId) {
      await before();
      if (!state.profiles.some((p) => p.id === id)) throw new MockNotFoundError('Profile', id);
      if (sessionId) {
        session(sessionId).profileId = id;
        updateSession(session(sessionId));
      } else state.settings.activeProfileId = id;
      persist();
      syncStore();
    },
  };
}
