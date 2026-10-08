import type { FerryClient } from '../../ferry-client.js';
import { EffortSchema, ReadOutputInputSchema, readOutputPage, SessionSchema } from '@ferry/shared';
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
  const list = async (
    q: { workspaceId?: string | null; query?: string; includeArchived?: boolean } = {},
  ) => {
    await before();
    return state.sessions
      .filter(
        (s) =>
          ((q.includeArchived ?? false) || !s.archived) &&
          (q.workspaceId === undefined || (s.workspaceId ?? null) === q.workspaceId) &&
          (!q.query ||
            `${s.title} ${s.preview}`.toLocaleLowerCase().includes(q.query.toLocaleLowerCase())),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => structuredClone(s));
  };
  return {
    list,
    async compact(id) {
      await before();
      const current = session(id);
      if (current.status === 'running' || current.status === 'awaiting_approval')
        throw new Error('Session is already running');
      const summary = (state.messages.get(id) ?? [])
        .flatMap((message) =>
          message.parts
            .filter((part) => part.type === 'text')
            .map((part) => `${message.role}: ${part.text}`),
        )
        .join('\n');
      const task = state.taskRecords.get(id);
      if (task)
        task.decisions.push({
          text: summary || 'No conversation yet.',
          why: 'Mock context compaction',
          at: clock.now().toISOString(),
        });
      persist();
      return structuredClone(current);
    },
    async search(q = {}) {
      const { query: _query, ...filters } = q;
      const sessions = await list(filters);
      const needle = q.query?.toLocaleLowerCase() ?? '';
      return sessions.flatMap((s) => {
        const texts = [
          s.title,
          s.preview,
          ...(state.messages.get(s.id) ?? []).flatMap((message) =>
            message.parts.flatMap((part) =>
              part.type === 'text' || part.type === 'reasoning' ? [part.text] : [],
            ),
          ),
        ];
        const text = texts.find((text) => text.toLocaleLowerCase().includes(needle));
        if (text === undefined) return [];
        const index = text.toLocaleLowerCase().indexOf(needle);
        return [{ ...s, match: text.slice(Math.max(0, index - 40), index + needle.length + 80) }];
      });
    },
    async archive(id, archived) {
      await before();
      const s = session(id);
      s.archived = archived;
      updateSession(s);
      return structuredClone(s);
    },
    async move(id, workspaceId) {
      await before();
      const s = session(id);
      if (
        controllers.has(id) ||
        s.inFlight ||
        s.status === 'running' ||
        s.status === 'awaiting_approval'
      )
        throw Object.assign(new Error('Running chats cannot be moved'), {
          code: -32010,
          kind: 'conflict',
          details: { sessionId: id, status: s.status },
        });
      if (workspaceId) workspace(workspaceId);
      s.workspaceId = workspaceId;
      updateSession(s);
      return structuredClone(s);
    },
    async get(id) {
      await before();
      return structuredClone(sessionDetail(id));
    },
    async readOutput(rawInput) {
      await before();
      const input = ReadOutputInputSchema.parse(rawInput);
      const current = session(input.sessionId);
      const messageOutput = (state.messages.get(current.id) ?? [])
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'tool_call' && part.output?.recoveryHandle === input.handle);
      const eventOutput = state.delegationRuns
        .filter((run) => run.sessionId === current.id)
        .flatMap((run) => run.events)
        .find((event) => event.type === 'tool_result' && event.recoveryHandle === input.handle);
      const content =
        messageOutput?.type === 'tool_call'
          ? messageOutput.output?.text
          : eventOutput?.type === 'tool_result'
            ? eventOutput.output
            : undefined;
      if (content === undefined) throw new Error('Output handle not found');
      return readOutputPage(content, input);
    },
    async create(i) {
      await before();
      if (i.workspaceId) workspace(i.workspaceId);
      const s = SessionSchema.parse({
        id: stringId<SessionId>('session'),
        workspaceId: i.workspaceId ?? null,
        title: i.title ?? 'New Chat',
        preview: '',
        profileId: i.profileId ?? state.settings.activeProfileId,
        modelRef: null,
        pinnedModelRef: null,
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
      s.inFlight = true;
      updateSession(s);
      emit('session.message', { sessionId: id, message: m });
      persist();
      // Like the core: a message sent mid-run joins the running turn instead of starting another.
      if (controllers.has(id)) return;
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
            s.inFlight = false;
            s.updatedAt = clock.now().toISOString();
            updateSession(s);
          }
        })
        .catch((err: unknown) => {
          if (!ctrl.signal.aborted) {
            s.status = 'error';
            s.inFlight = false;
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
    async resume(id, options = {}) {
      await before();
      const current = session(id);
      if (current.status !== 'interrupted')
        throw new Error('Only an interrupted session can be resumed');
      const messages = state.messages.get(id) ?? [];
      const interrupted = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === 'tool_call' && part.status === 'running');
      if (interrupted.length && !options.retryInterruptedTool) {
        const names = interrupted
          .map((part) => (part.type === 'tool_call' ? part.title : ''))
          .join(', ');
        throw new Error(
          'Interrupted while ' + names + ' was running. Confirm before retrying this tool.',
        );
      }
      for (const part of interrupted) {
        if (part.type !== 'tool_call') continue;
        const message = messages.find((entry) =>
          entry.parts.some((candidate) => candidate.id === part.id),
        );
        if (message)
          message.parts = message.parts.map((candidate) =>
            candidate.id === part.id
              ? {
                  ...part,
                  status: 'failed',
                  output: {
                    text: 'Interrupted tool retry confirmed.',
                    filtered: false,
                    originalTokens: null,
                    filteredTokens: null,
                    recoveryHandle: null,
                  },
                }
              : candidate,
          );
      }
      const prompt = [...messages]
        .reverse()
        .find((message) => message.role === 'user')
        ?.parts.filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(' ')
        .trim();
      if (!prompt) throw new Error('This session has no durable user prompt to resume');
      current.status = 'running';
      current.inFlight = true;
      current.updatedAt = clock.now().toISOString();
      updateSession(current);
      persist();
      const controller = new AbortController();
      controllers.set(id, controller);
      void scenarioRunner
        .run({
          sessionId: id,
          userText: prompt,
          emit: (event, payload) => {
            emitter.emit(event, payload);
          },
          store,
          clock,
          signal: controller.signal,
        })
        .then(() => {
          if (!controller.signal.aborted && current.status === 'running') {
            current.status = 'idle';
            current.inFlight = false;
            current.updatedAt = clock.now().toISOString();
            updateSession(current);
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          current.status = 'error';
          current.inFlight = false;
          const failure: Message = {
            id: stringId('message'),
            sessionId: id,
            role: 'assistant',
            createdAt: clock.now().toISOString(),
            modelRef: current.modelRef,
            parts: [
              {
                type: 'error',
                id: stringId('part'),
                message: error instanceof Error ? error.message : String(error),
                kind: 'internal',
              },
            ],
          };
          state.messages.get(id)?.push(failure);
          emit('session.message', { sessionId: id, message: failure });
          updateSession(current);
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
      s.inFlight = false;
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
    async setEffort(id, effort) {
      await before();
      const s = session(id);
      s.effort = EffortSchema.nullable().parse(effort);
      return updateSession(s);
    },
    async remove(id) {
      await before();
      state.sessions = state.sessions.filter((s) => s.id !== id);
      state.messages.delete(id);
      state.taskRecords.delete(id);
      persist();
      syncStore();
      emit('session.removed', { id });
    },
  };
}
