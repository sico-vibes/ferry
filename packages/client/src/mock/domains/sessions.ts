import type { FerryClient } from '../../ferry-client.js';
import {
  CliOptionPatchSchema,
  CliOptionSchema,
  EffortSchema,
  ModelRefSchema,
  ReadOutputInputSchema,
  readOutputPage,
  SessionModelUsageSchema,
  SessionSchema,
} from '@ferry/shared';
import type {
  Message,
  MessagePart,
  ModelRef,
  Session,
  SessionId,
  SessionModelUsage,
} from '@ferry/shared';
import { emitPendingApprovals } from './approvals.js';
import type { MockDeps } from './deps.js';
import type { MockState, MockStore } from '../types.js';
import { honestProducer } from '../usage-producer.js';

/** Chronological order (createdAt, then id) so "latest" is well-defined for id-ordered storage. */
function orderedMessages(messages: readonly Message[]): Message[] {
  return [...messages].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function isReplyPart(part: MessagePart): boolean {
  if (part.type === 'text' || part.type === 'reasoning') return part.text.trim().length > 0;
  if (part.type === 'tool_call') return part.output !== null;
  return false;
}

function partProducingModel(part: MessagePart): ModelRef | null {
  return part.type === 'text' || part.type === 'reasoning' || part.type === 'tool_call'
    ? (part.producedBy ?? null)
    : null;
}

function honestMessageModel(message: Message): ModelRef | null {
  return honestProducer(message.modelRef);
}

/**
 * Whether the conversation produced at least one genuine assistant reply. Used only to detect
 * history no retained usage evidence can prove.
 */
function hasAssistantGeneration(messages: readonly Message[]): boolean {
  return messages.some(
    (message) => message.role === 'assistant' && message.parts.some(isReplyPart),
  );
}

function isActivelyRunning(session: Session): boolean {
  return (
    session.inFlight === true ||
    session.status === 'running' ||
    session.status === 'awaiting_approval'
  );
}

/**
 * The session summary with `lastReplyModelRef` derived from its own retained messages. The latest
 * eligible reply's actual producer wins; a logical Gateway key is reported as unknown. While the run
 * is actively streaming its trailing reply the prior value is preserved.
 */
function withLastReply(session: Session, messages: readonly Message[]): Session {
  const ordered = orderedMessages(messages);
  let reply: { index: number; model: ModelRef | null } | null = null;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index];
    if (message?.role !== 'assistant') continue;
    const parts = message.parts.filter(isReplyPart);
    if (parts.length === 0) continue;
    const latest = parts.at(-1);
    reply = {
      index,
      model: (latest ? partProducingModel(latest) : null) ?? honestMessageModel(message),
    };
    break;
  }
  if (!reply) return session;
  if (reply.index === ordered.length - 1 && isActivelyRunning(session)) return session;
  return SessionSchema.parse({ ...session, lastReplyModelRef: reply.model });
}

const LEGIBLE_MOCK_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/;

interface CanonicalMockRef {
  modelRef: ModelRef;
  unknownProvenance: boolean;
}

function canonicalMockRef(row: {
  modelRef: string;
  providerId: string | null;
  connectionId: string | null;
}): CanonicalMockRef {
  const direct = ModelRefSchema.safeParse(row.modelRef);
  if (direct.success) return { modelRef: direct.data, unknownProvenance: false };
  const namespace = row.providerId ?? row.connectionId;
  if (namespace) {
    const namespaced = ModelRefSchema.safeParse(`${namespace}/${row.modelRef}`);
    if (namespaced.success) return { modelRef: namespaced.data, unknownProvenance: false };
  }
  const safe = row.modelRef.replace(/[^A-Za-z0-9._:@+/-]/g, '-').replace(/^-+|-+$/g, '');
  const token =
    safe.length > 0 && safe.length <= 128 && LEGIBLE_MOCK_KEY.test(safe)
      ? safe
      : safe.slice(0, 64) || 'empty';
  return { modelRef: ModelRefSchema.parse(`unknown/${token}`), unknownProvenance: true };
}

function sumNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return left + right;
}

/**
 * Aggregates the mock's retained usage ledger for one session. Rows merge only on an exact
 * `(canonical model, provider, connection, account)` bucket; missing token dimensions stay `null`
 * while a reported zero stays `0`, and coverage is labelled missing when evidence is incomplete.
 */
function sessionModelUsageFor(state: MockState, sessionId: SessionId): SessionModelUsage {
  interface Group {
    modelRef: ModelRef;
    providerId: string | null;
    connectionId: string | null;
    accountKey: string | null;
    requests: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    reasoningTokens: number | null;
    inputReported: number;
    outputReported: number;
    cachedReported: number;
    reasoningReported: number;
    lastUsedAt: string | null;
    unreportedRequests: number;
    unknownProvenance: boolean;
  }
  const rows = state.sessionUsage.filter((row) => row.sessionId === sessionId);
  const groups = new Map<string, Group>();
  let anyBackfilled = false;
  let since: string | null = null;
  for (const row of rows) {
    const canonical = canonicalMockRef(row);
    const key = [
      canonical.modelRef,
      row.providerId ?? '',
      row.connectionId ?? '',
      row.accountKey ?? '',
    ].join('\u0000');
    const reported = {
      input: row.inputTokens !== null,
      output: row.outputTokens !== null,
      cached: row.cachedTokens !== null,
      reasoning: row.reasoningTokens !== null,
    };
    const existing = groups.get(key);
    if (existing) {
      existing.requests += 1;
      existing.inputTokens = sumNullable(existing.inputTokens, row.inputTokens);
      existing.outputTokens = sumNullable(existing.outputTokens, row.outputTokens);
      existing.cachedTokens = sumNullable(existing.cachedTokens, row.cachedTokens);
      existing.reasoningTokens = sumNullable(existing.reasoningTokens, row.reasoningTokens);
      existing.inputReported += reported.input ? 1 : 0;
      existing.outputReported += reported.output ? 1 : 0;
      existing.cachedReported += reported.cached ? 1 : 0;
      existing.reasoningReported += reported.reasoning ? 1 : 0;
      existing.unreportedRequests +=
        reported.input || reported.output || reported.cached || reported.reasoning ? 0 : 1;
      existing.lastUsedAt =
        existing.lastUsedAt === null || row.occurredAt > existing.lastUsedAt
          ? row.occurredAt
          : existing.lastUsedAt;
      existing.unknownProvenance ||= canonical.unknownProvenance;
    } else {
      groups.set(key, {
        modelRef: canonical.modelRef,
        providerId: row.providerId,
        connectionId: row.connectionId,
        accountKey: row.accountKey,
        requests: 1,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cachedTokens: row.cachedTokens,
        reasoningTokens: row.reasoningTokens,
        inputReported: reported.input ? 1 : 0,
        outputReported: reported.output ? 1 : 0,
        cachedReported: reported.cached ? 1 : 0,
        reasoningReported: reported.reasoning ? 1 : 0,
        lastUsedAt: row.occurredAt,
        unreportedRequests:
          reported.input || reported.output || reported.cached || reported.reasoning ? 0 : 1,
        unknownProvenance: canonical.unknownProvenance,
      });
    }
    anyBackfilled ||= row.backfilled === true;
    if (since === null || row.occurredAt < since) since = row.occurredAt;
  }
  const models = [...groups.values()]
    .map((group) => ({
      modelRef: group.modelRef,
      providerId: group.providerId,
      connectionId: group.connectionId,
      accountKey: group.accountKey,
      requests: group.requests,
      inputTokens: group.inputReported > 0 ? group.inputTokens : null,
      outputTokens: group.outputReported > 0 ? group.outputTokens : null,
      cachedTokens: group.cachedReported > 0 ? group.cachedTokens : null,
      reasoningTokens: group.reasoningReported > 0 ? group.reasoningTokens : null,
      lastUsedAt: group.lastUsedAt,
      unreportedRequests: group.unreportedRequests,
    }))
    .sort((a, b) => {
      const refOrder = a.modelRef.localeCompare(b.modelRef);
      if (refOrder !== 0) return refOrder;
      return (a.providerId ?? '').localeCompare(b.providerId ?? '');
    });
  const sum = (pick: (model: (typeof models)[number]) => number | null): number | null => {
    let total = 0;
    let reported = false;
    for (const model of models) {
      const value = pick(model);
      if (value === null) continue;
      reported = true;
      total += value;
    }
    return reported ? total : null;
  };
  const incomplete = [...groups.values()].some(
    (group) => group.requests > group.inputReported || group.requests > group.outputReported,
  );
  const unknownProvenance = [...groups.values()].some((group) => group.unknownProvenance);
  // A reply with no retained rows at all proves conversation history the totals cannot cover. Reply
  // start times are never compared against usage-finish times: a normal reply is appended before its
  // usage is recorded, so that ordering is equally true of a fully captured fresh chat and is not a
  // reliable signal. A retained row set is trusted on its own, so expired detail stays complete.
  const uncoveredHistory =
    hasAssistantGeneration(state.messages.get(sessionId) ?? []) && rows.length === 0;
  return SessionModelUsageSchema.parse({
    sessionId,
    totals: {
      requests: models.reduce((total, model) => total + model.requests, 0),
      inputTokens: sum((model) => model.inputTokens),
      outputTokens: sum((model) => model.outputTokens),
      cachedTokens: sum((model) => model.cachedTokens),
      reasoningTokens: sum((model) => model.reasoningTokens),
    },
    models,
    incomplete,
    coverage: {
      since,
      missing: incomplete || anyBackfilled || unknownProvenance || uncoveredHistory,
    },
  });
}

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
      .map((s) => structuredClone(withLastReply(s, state.messages.get(s.id) ?? [])));
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
      const detail = sessionDetail(id);
      return structuredClone({
        ...detail,
        session: withLastReply(detail.session, detail.messages),
      });
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
            s.lastReplyModelRef = withLastReply(s, state.messages.get(id) ?? []).lastReplyModelRef;
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
            current.lastReplyModelRef = withLastReply(
              current,
              state.messages.get(id) ?? [],
            ).lastReplyModelRef;
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
      s.lastReplyModelRef = withLastReply(s, state.messages.get(id) ?? []).lastReplyModelRef;
      updateSession(s);
      emitPendingApprovals(emit, state, clock);
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
    async modelUsage(id) {
      await before();
      session(id);
      return sessionModelUsageFor(state, id);
    },
    async updateCliOptions(id, input) {
      await before();
      const s = session(id);
      const parsed = CliOptionPatchSchema.parse(input.options);
      s.cliOptions = {
        ...(s.cliOptions ?? {}),
        [input.modelRef]: CliOptionSchema.parse({
          ...(s.cliOptions?.[input.modelRef] ?? {}),
          ...parsed,
        }),
      };
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
      emitPendingApprovals(emit, state, clock);
    },
  };
}
