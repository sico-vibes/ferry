import type { FerryClient } from '../../ferry-client.js';
import { SessionSchema } from '@ferry/shared';
import type { Message, SessionId } from '@ferry/shared';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createSessionsDomain(_store: MockStore, deps: MockDeps): FerryClient['sessions'] {
  const {
    state,
    clock,
    store,
    emitter,
    controllers,
    before,
    persist,
    syncStore,
    emit,
    session,
    workspace,
    updateSession,
    sessionDetail,
    scenarioRunner,
    stringId,
  } = deps;
  const list = async (q: { workspaceId?: string; query?: string } = {}) => {
    await before();
    return state.sessions
      .filter(
        (s) =>
          (!q.workspaceId || s.workspaceId === q.workspaceId) &&
          (!q.query ||
            `${s.title} ${s.preview}`.toLocaleLowerCase().includes(q.query.toLocaleLowerCase())),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => structuredClone(s));
  };
  return {
    list,
    search: list,
    async get(id) {
      await before();
      return structuredClone(sessionDetail(id));
    },
    async create(i) {
      await before();
      workspace(i.workspaceId);
      const s = SessionSchema.parse({
        id: stringId<SessionId>('session'),
        workspaceId: i.workspaceId,
        title: i.title ?? 'New Chat',
        preview: '',
        profileId: i.profileId ?? state.settings.activeProfileId,
        modelRef: null,
        starred: false,
        pinned: false,
        status: 'idle',
        createdAt: clock.now().toISOString(),
        updatedAt: clock.now().toISOString(),
      });
      state.sessions.push(s);
      state.messages.set(s.id, []);
      state.taskRecords.set(s.id, {
        sessionId: s.id,
        goal: s.title,
        plan: [],
        decisions: [],
        touchedFiles: [],
        nextStep: null,
      });
      updateSession(s);
      syncStore();
      return structuredClone(s);
    },
    async send(id, i) {
      await before();
      const s = session(id);
      if (s.title === 'New Chat') {
        const title = i.text
          .trim()
          .split(/\s+/)
          .slice(0, 6)
          .join(' ')
          .replace(/[.!?…]+$/, '');
        const first = title.at(0);
        if (first) s.title = first.toLocaleUpperCase() + title.slice(1);
      }
      const m: Message = {
        id: stringId('message'),
        sessionId: id,
        role: 'user',
        createdAt: clock.now().toISOString(),
        modelRef: s.modelRef,
        parts: [{ type: 'text', id: stringId('part'), text: i.text }],
      };
      state.messages.get(id)?.push(m);
      s.preview = i.text;
      s.updatedAt = clock.now().toISOString();
      s.status = 'running';
      updateSession(s);
      emit('session.message', { sessionId: id, message: m });
      persist();
      const ctrl = new AbortController();
      controllers.set(id, ctrl);
      void scenarioRunner
        .run({
          sessionId: id,
          userText: i.text,
          emit: (e, p) => {
            emitter.emit(e, p);
          },
          store,
          clock,
          signal: ctrl.signal,
        })
        .then(() => {
          if (!ctrl.signal.aborted && s.status === 'running') {
            s.status = 'idle';
            s.updatedAt = clock.now().toISOString();
            updateSession(s);
          }
        })
        .catch((err: unknown) => {
          if (!ctrl.signal.aborted) {
            s.status = 'error';
            const em: Message = {
              id: stringId('message'),
              sessionId: id,
              role: 'assistant',
              createdAt: clock.now().toISOString(),
              modelRef: s.modelRef,
              parts: [
                {
                  type: 'error',
                  id: stringId('part'),
                  message: err instanceof Error ? err.message : String(err),
                  kind: 'internal',
                },
              ],
            };
            state.messages.get(id)?.push(em);
            emit('session.message', { sessionId: id, message: em });
            updateSession(s);
          }
        })
        .finally(() => {
          controllers.delete(id);
          persist();
        });
    },
    async cancel(id) {
      await before();
      controllers.get(id)?.abort();
      controllers.delete(id);
      const s = session(id);
      s.status = 'idle';
      updateSession(s);
    },
    async rename(id, title) {
      await before();
      const s = session(id);
      s.title = title;
      return updateSession(s);
    },
    async setStarred(id, v) {
      await before();
      const s = session(id);
      s.starred = v;
      return updateSession(s);
    },
    async setPinned(id, v) {
      await before();
      const s = session(id);
      s.pinned = v;
      return updateSession(s);
    },
    async remove(id) {
      await before();
      state.sessions = state.sessions.filter((s) => s.id !== id);
      state.messages.delete(id);
      state.taskRecords.delete(id);
      persist();
      syncStore();
    },
  };
}
