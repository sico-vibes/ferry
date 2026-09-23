import { MockNotFoundError } from '../errors.js';
import type { DelegationRun, RunId } from '@ferry/shared';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createDelegationDomain(
  _store: MockStore,
  deps: MockDeps,
): FerryClient['delegation'] {
  const {
    state,
    clock,
    before,
    persist,
    syncStore,
    emit,
    session,
    run,
    scheduleRun,
    finishRun,
    stringId,
  } = deps;
  return {
    async lanes() {
      await before();
      return structuredClone(state.lanes);
    },
    async approveProjectLanes() {
      await before();
      state.lanes = state.lanes.map((l) => (l.source === 'project' ? { ...l, trusted: true } : l));
      persist();
      syncStore();
      return structuredClone(state.lanes);
    },
    async runs(id) {
      await before();
      return state.delegationRuns.filter((r) => r.sessionId === id).map((r) => structuredClone(r));
    },
    async start(i) {
      await before();
      session(i.sessionId);
      const lane = state.lanes.find((l) => l.name === i.lane);
      if (!lane) throw new MockNotFoundError('Lane', i.lane);
      const r: DelegationRun = {
        id: stringId<RunId>('run'),
        sessionId: i.sessionId,
        lane: lane.name,
        implementer: lane.implementer,
        brief: i.brief,
        status: 'queued',
        startedAt: clock.now().toISOString(),
        finishedAt: null,
        progress: [],
        finalMessage: null,
        touchedFiles: [],
        gateResults: [],
        usage: null,
        decision: null,
      };
      state.delegationRuns.push(r);
      scheduleRun(r);
      emit('delegation.updated', r);
      persist();
      return structuredClone(r);
    },
    async cancel(id) {
      await before();
      const r = run(id);
      if (r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled') return;
      r.status = 'cancelled';
      r.finishedAt = clock.now().toISOString();
      emit('delegation.updated', r);
      persist();
    },
    async decide(id, decision) {
      await before();
      const r = run(id);
      if (decision === 'rework' && r.status === 'cancelled') {
        throw new Error('A cancelled delegation run cannot be reworked');
      }
      r.decision = decision;
      if (decision === 'rework') {
        r.status = 'running';
        r.finishedAt = null;
        r.progress.push({ at: clock.now().toISOString(), text: 'Applying requested rework' });
        clock.setTimeout(() => {
          finishRun(r);
        }, 800);
      }
      persist();
      emit('delegation.updated', r);
      return structuredClone(r);
    },
  };
}
