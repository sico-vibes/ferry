import { mockFailures } from '../failures.js';
import { isOpenCodeAppModel } from '@ferry/shared';
import { MockNotFoundError } from '../errors.js';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';
import { mockCliModelRows } from '../cli-inventory.js';

export function createModelsDomain(_store: MockStore, deps: MockDeps): FerryClient['models'] {
  const { state, before, persist, session, updateSession } = deps;
  // Installed-CLI rows are discovered from the live connection state so Verify/opt-ins react.
  const allModels = () => [...state.models, ...mockCliModelRows(state)];
  return {
    async list(providerId) {
      await before();
      const failing = new Set(
        mockFailures(state, deps.clock.now()).providers.flatMap((provider) =>
          provider.models.filter((model) => model.failing).map((model) => model.modelRef),
        ),
      );
      return allModels()
        .filter((model) => providerId === undefined || model.providerId === providerId)
        .map((model) =>
          structuredClone({
            ...model,
            failing: failing.has(model.ref),
            verified: model.verified ?? false,
            verifiedAt: model.verifiedAt ?? null,
          }),
        );
    },
    async page(query = {}) {
      await before();
      const {
        offset = 0,
        limit = 50,
        query: search = '',
        filters = {},
        sort = { key: 'name' as const, ascending: true },
      } = query;
      const failing = new Set(
        mockFailures(state, deps.clock.now()).providers.flatMap((provider) =>
          provider.models.filter((model) => model.failing).map((model) => model.modelRef),
        ),
      );
      const needle = search.trim().toLocaleLowerCase();
      const filtered = allModels()
        .filter((model) => !filters.providerId || model.providerId === filters.providerId)
        .filter((model) => !filters.tier || model.tier === filters.tier)
        .filter((model) => filters.free === undefined || model.free === filters.free)
        .filter(
          (model) =>
            !needle ||
            `${model.name} ${model.ref} ${model.providerId}`.toLocaleLowerCase().includes(needle),
        )
        .toSorted((left, right) => {
          const a = left[sort.key];
          const b = right[sort.key];
          const order =
            typeof a === 'string' && typeof b === 'string'
              ? a.localeCompare(b)
              : Number(a ?? -1) - Number(b ?? -1);
          return (sort.ascending === false ? -1 : 1) * (order || left.ref.localeCompare(right.ref));
        });
      return {
        items: filtered.slice(offset, offset + limit).map((model) =>
          structuredClone({
            ...model,
            failing: failing.has(model.ref),
            verified: model.verified ?? false,
            verifiedAt: model.verifiedAt ?? null,
          }),
        ),
        total: filtered.length,
      };
    },
    async candidates(sessionId) {
      await before();
      const cliChoices = mockCliModelRows(state).filter(
        (model) => model.verified === true && model.toolCalling,
      );
      const choices = state.models
        .filter((model) => !isOpenCodeAppModel(model))
        .filter((m) => {
          const p = state.providers.find((x) => x.id === m.providerId);
          return p?.enabled && p.keyStatus === 'valid';
        })
        .concat(cliChoices)
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
      const model = allModels().find((model) => model.ref === ref);
      if (model && isOpenCodeAppModel(model))
        throw new Error('Available in the OpenCode app. Use ferry run opencode --native.');
      if (ref !== 'auto' && !allModels().some((m) => m.ref === ref))
        throw new MockNotFoundError('Model', ref);
      if (ref === 'auto') state.selections.delete(sessionId);
      else state.selections.set(sessionId, ref);
      s.pinnedModelRef = ref === 'auto' ? null : ref;
      updateSession(s);
      persist();
    },
  };
}
