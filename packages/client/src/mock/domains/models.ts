import { MockNotFoundError } from '../errors.js';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createModelsDomain(_store: MockStore, deps: MockDeps): FerryClient['models'] {
  const { state, before, persist, session, updateSession } = deps;
  return {
    async list(providerId) {
      await before();
      return state.models
        .filter((m) => !providerId || m.providerId === providerId)
        .map((m) => structuredClone(m));
    },
    async candidates(sessionId) {
      await before();
      const choices = state.models
        .filter((m) => {
          const p = state.providers.find((x) => x.id === m.providerId);
          return p?.enabled && p.keyStatus === 'valid';
        })
        .sort(
          (a, b) =>
            Number(b.free) - Number(a.free) ||
            a.tier.localeCompare(b.tier) ||
            (state.providers.find((x) => x.id === b.providerId)?.stepsLeftToday ?? -1) -
              (state.providers.find((x) => x.id === a.providerId)?.stepsLeftToday ?? -1),
        );
      const chosen = sessionId ? state.selections.get(sessionId) : undefined;
      return choices.map((m, i) => {
        const steps = state.providers.find((p) => p.id === m.providerId)?.stepsLeftToday ?? null;
        return {
          ref: m.ref,
          score: choices.length - i,
          stepsLeft: steps,
          explanation: `${m.tier} coder${steps === null ? '' : ` · ${String(steps)} steps left`} · ${m.contextWindow >= 1000000 ? '1M' : `${String(Math.round(m.contextWindow / 1000))}K`} context · ${m.free ? 'free' : 'paid'}`,
          selected: chosen ? chosen === m.ref : i === 0,
        };
      });
    },
    async select(sessionId, ref) {
      await before();
      const s = session(sessionId);
      if (ref !== 'auto' && !state.models.some((m) => m.ref === ref))
        throw new MockNotFoundError('Model', ref);
      if (ref === 'auto') state.selections.delete(sessionId);
      else state.selections.set(sessionId, ref);
      s.modelRef = ref === 'auto' ? null : ref;
      updateSession(s);
      persist();
    },
  };
}
