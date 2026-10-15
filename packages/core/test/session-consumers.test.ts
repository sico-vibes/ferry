import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalsPendingSchema,
  MessageSchema,
  ModelRefSchema,
  PartIdSchema,
  ProfileIdSchema,
  SessionIdSchema,
  SessionModelUsageSchema,
  SessionSchema,
  newId,
  type Message,
  type ModelRef,
  type Session,
  type SessionId,
} from '@ferry/shared';
import { RequestRepository } from '@ferry/storage';
import type { FerryServices } from '../src/services.js';
import { startHarness, toolTurn, waitFor, textTurn } from './qa-w3-harness.js';

const MODEL_A = ModelRefSchema.parse('openai/gpt-5');
const MODEL_B = ModelRefSchema.parse('anthropic/claude-opus-4');
const PRODUCED = ModelRefSchema.parse('opencode-cli/opencode-go/deepseek-v4.1-flash');
const LOGICAL = ModelRefSchema.parse('gateway/requested-key');

function seedSession(
  sessionId: SessionId,
  overrides: Partial<Session> = {},
  now = '2026-01-01T00:00:00.000Z',
): Session {
  return SessionSchema.parse({
    id: sessionId,
    workspaceId: null,
    title: `Session ${sessionId}`,
    preview: '',
    profileId: ProfileIdSchema.parse('profile_builtin_direct'),
    modelRef: null,
    pinnedModelRef: null,
    starred: false,
    pinned: false,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    agentEvents: [],
    ...overrides,
  });
}

function putSession(services: FerryServices, session: Session): void {
  services.sessions.put(session);
  services.tasks.put({
    sessionId: session.id,
    goal: session.title,
    plan: [],
    decisions: [],
    touchedFiles: [],
    nextStep: null,
  });
}

function assistant(
  sessionId: SessionId,
  parts: Message['parts'],
  modelRef: ModelRef | null,
  createdAt = '2026-01-01T00:00:01.000Z',
): Message {
  return MessageSchema.parse({
    id: newId('message'),
    sessionId,
    role: 'assistant',
    createdAt,
    modelRef,
    parts,
  });
}

function userText(
  sessionId: SessionId,
  text: string,
  createdAt = '2026-01-01T00:00:00.000Z',
): Message {
  return MessageSchema.parse({
    id: newId('message'),
    sessionId,
    role: 'user',
    createdAt,
    modelRef: null,
    parts: [{ type: 'text', id: PartIdSchema.parse(newId('part')), text }],
  });
}

function textPart(text: string, producedBy?: ModelRef): Message['parts'][number] {
  return {
    type: 'text',
    id: PartIdSchema.parse(newId('part')),
    text,
    ...(producedBy ? { producedBy } : {}),
  };
}

function pendingApproval(
  detail = 'rm -rf build',
): Extract<Message['parts'][number], { type: 'approval_request' }> {
  return {
    type: 'approval_request',
    id: PartIdSchema.parse(newId('part')),
    kind: 'command',
    summary: 'Run a command',
    detail,
    risk: 'medium',
    state: 'pending',
  };
}

describe('core session/approval consumers over public RPC', () => {
  it(
    'registers the sessions.modelUsage and approvals.pending methods',
    { timeout: 30_000 },
    async () => {
      const h = await startHarness();
      try {
        expect([...h.rpc.implementedMethods]).toEqual(
          expect.arrayContaining(['sessions.modelUsage', 'approvals.pending']),
        );
      } finally {
        await h.close();
      }
    },
  );

  it('redacts a missing session id as not_found for model usage', { timeout: 30_000 }, async () => {
    const h = await startHarness();
    try {
      const session = seedSession(SessionIdSchema.parse('session_present'));
      putSession(h.services, session);
      await expect(
        h.rpc.sessions.modelUsage(SessionIdSchema.parse('session_missing')),
      ).rejects.toMatchObject({ kind: 'not_found', code: -32044 });
      SessionModelUsageSchema.parse(await h.rpc.sessions.modelUsage(session.id));
    } finally {
      await h.close();
    }
  });

  it(
    'reports the actual producer of the latest final reply, never a logical Gateway key',
    { timeout: 30_000 },
    async () => {
      const h = await startHarness();
      try {
        const fallback = seedSession(SessionIdSchema.parse('session_actual'));
        const mixed = seedSession(SessionIdSchema.parse('session_mixed'));
        const logical = seedSession(SessionIdSchema.parse('session_logical'));
        for (const session of [fallback, mixed, logical]) putSession(h.services, session);
        h.services.messages.put(userText(fallback.id, 'hello', '2026-01-01T00:00:00.000Z'));
        h.services.messages.put(assistant(fallback.id, [textPart('answer')], MODEL_A));
        h.services.messages.put(
          assistant(
            mixed.id,
            [textPart('planned', MODEL_A), textPart('final answer', PRODUCED)],
            MODEL_A,
          ),
        );
        h.services.messages.put(assistant(logical.id, [textPart('routed reply')], LOGICAL));

        const listed = new Map((await h.rpc.sessions.list()).map((s) => [s.id, s]));
        expect(listed.get(fallback.id)?.lastReplyModelRef).toBe(MODEL_A);
        expect(listed.get(mixed.id)?.lastReplyModelRef).toBe(PRODUCED);
        expect(listed.get(logical.id)?.lastReplyModelRef).toBeNull();

        // The durable read summary matches the list and is stable across calls.
        const detail = await h.rpc.sessions.get(mixed.id);
        expect(detail.session.lastReplyModelRef).toBe(PRODUCED);
        expect((await h.rpc.sessions.get(mixed.id)).session.lastReplyModelRef).toBe(PRODUCED);
      } finally {
        await h.close();
      }
    },
  );

  it(
    'preserves the prior logo while a run is still streaming its trailing reply',
    { timeout: 30_000 },
    async () => {
      const h = await startHarness();
      try {
        const running = seedSession(SessionIdSchema.parse('session_streaming'), {
          status: 'running',
          inFlight: true,
          lastReplyModelRef: MODEL_A,
        });
        putSession(h.services, running);
        h.services.messages.put(
          assistant(running.id, [textPart('streaming')], MODEL_B, '2026-01-01T00:00:02.000Z'),
        );
        const [listed] = await h.rpc.sessions.list({ query: 'streaming' });
        expect(listed?.lastReplyModelRef).toBe(MODEL_A);
        expect((await h.rpc.sessions.get(running.id)).session.lastReplyModelRef).toBe(MODEL_A);
      } finally {
        await h.close();
      }
    },
  );

  it(
    'backfills lastReplyModelRef once and never re-reads an already resolved session',
    { timeout: 30_000 },
    async () => {
      const h = await startHarness();
      try {
        const session = seedSession(SessionIdSchema.parse('session_backfill'));
        putSession(h.services, session);
        h.services.messages.put(assistant(session.id, [textPart('done')], MODEL_A));
        const spy = vi.spyOn(h.services.messages, 'listForSessions');
        await h.rpc.sessions.list();
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockClear();
        await h.rpc.sessions.list();
        expect(spy).not.toHaveBeenCalled();
        expect(h.services.sessions.get(session.id)?.lastReplyModelRef).toBe(MODEL_A);
        spy.mockRestore();
      } finally {
        await h.close();
      }
    },
  );

  it(
    'returns nullable usage distinctly and stays idempotent through the public API',
    { timeout: 30_000 },
    async () => {
      const h = await startHarness();
      try {
        const missing = seedSession(SessionIdSchema.parse('session_missing_tokens'));
        const zero = seedSession(SessionIdSchema.parse('session_zero_tokens'));
        putSession(h.services, missing);
        putSession(h.services, zero);
        const requests = new RequestRepository(h.services.db.client);
        requests.put({
          id: 'req_missing',
          ts: '2026-01-01T00:00:00.000Z',
          provider: 'openai',
          model: 'gpt-5',
          session_id: missing.id,
          input_tokens: null,
          output_tokens: null,
          status: 'ok',
        });
        requests.put({
          id: 'req_zero',
          ts: '2026-01-01T00:00:00.000Z',
          provider: 'openai',
          model: 'gpt-5',
          session_id: zero.id,
          input_tokens: 0,
          output_tokens: 0,
          status: 'ok',
        });

        const missingUsage = await h.rpc.sessions.modelUsage(missing.id);
        expect(missingUsage.totals.inputTokens).toBeNull();
        expect(missingUsage.incomplete).toBe(true);
        expect(missingUsage.coverage.missing).toBe(true);
        const zeroUsage = await h.rpc.sessions.modelUsage(zero.id);
        expect(zeroUsage.totals.inputTokens).toBe(0);
        expect(zeroUsage.incomplete).toBe(false);
        expect(await h.rpc.sessions.modelUsage(zero.id)).toEqual(zeroUsage);
      } finally {
        await h.close();
      }
    },
  );

  it(
    'retains the usage aggregate after the retained request detail expires',
    { timeout: 30_000 },
    async () => {
      const h = await startHarness();
      try {
        const session = seedSession(SessionIdSchema.parse('session_expiry'));
        putSession(h.services, session);
        new RequestRepository(h.services.db.client).put({
          id: 'req_expiry',
          ts: '2026-01-01T00:00:00.000Z',
          provider: 'openai',
          model: 'gpt-5',
          session_id: session.id,
          input_tokens: 12,
          output_tokens: 3,
          status: 'ok',
        });
        expect((await h.rpc.sessions.modelUsage(session.id)).totals).toMatchObject({
          requests: 1,
          inputTokens: 12,
        });
        // Retention drops the per-request detail; the durable aggregate survives unchanged.
        h.services.db.client.prepare('DELETE FROM requests WHERE id=?').run('req_expiry');
        expect((await h.rpc.sessions.modelUsage(session.id)).totals).toMatchObject({
          requests: 1,
          inputTokens: 12,
          outputTokens: 3,
        });
      } finally {
        await h.close();
      }
    },
  );

  it(
    'summarizes pending approvals from indexed messages without a per-conversation fan-out',
    { timeout: 30_000 },
    async () => {
      const h = await startHarness();
      try {
        const awaiting = seedSession(SessionIdSchema.parse('session_pending'), {
          status: 'awaiting_approval',
          title: 'Needs approval',
        });
        const idle = seedSession(SessionIdSchema.parse('session_idle'));
        putSession(h.services, awaiting);
        putSession(h.services, idle);
        const part = pendingApproval();
        h.services.messages.put(assistant(awaiting.id, [part], MODEL_A));
        h.services.messages.put(assistant(idle.id, [pendingApproval()], MODEL_A));

        const listSpy = vi.spyOn(h.services.messages, 'list');
        const getSpy = vi.spyOn(h.services.sessions, 'get');
        const pending = ApprovalsPendingSchema.parse(await h.rpc.approvals.pending());
        expect(listSpy).not.toHaveBeenCalled();
        expect(getSpy).not.toHaveBeenCalled();
        listSpy.mockRestore();
        getSpy.mockRestore();
        expect(pending.entries).toEqual([
          expect.objectContaining({ sessionId: awaiting.id, partId: part.id, kind: 'command' }),
        ]);
      } finally {
        await h.close();
      }
    },
  );

  it('emits approvals.pending.updated on resolve and removal', { timeout: 30_000 }, async () => {
    const h = await startHarness();
    try {
      const session = seedSession(SessionIdSchema.parse('session_resolve'), {
        status: 'awaiting_approval',
      });
      putSession(h.services, session);
      const part = pendingApproval();
      h.services.messages.put(assistant(session.id, [part], MODEL_A));
      const snapshots: { entries: unknown[] }[] = [];
      const off = h.rpc.on('approvals.pending.updated', (payload) =>
        snapshots.push(ApprovalsPendingSchema.parse(payload)),
      );
      await h.rpc.approvals.respond(session.id, part.id, 'allow_once');
      await waitFor(() => snapshots.length >= 1);
      const resolved = snapshots.at(-1) as { entries: unknown[] };
      expect(resolved.entries).toEqual([]);
      await h.rpc.sessions.remove(session.id);
      await waitFor(() => snapshots.length >= 2);
      off();
    } finally {
      await h.close();
    }
  });

  it(
    'surfaces a storage failure as a redacted error instead of empty approvals',
    { timeout: 30_000 },
    async () => {
      const h = await startHarness();
      try {
        const session = seedSession(SessionIdSchema.parse('session_broken'), {
          status: 'awaiting_approval',
        });
        putSession(h.services, session);
        h.services.db.client.exec('DROP TABLE messages');
        await expect(h.rpc.approvals.pending()).rejects.toMatchObject({
          kind: 'unavailable',
          code: -32004,
        });
      } finally {
        await h.close();
      }
    },
  );

  it(
    'denies pending approvals on shutdown and publishes the reduced snapshot',
    { timeout: 60_000 },
    async () => {
      const h = await startHarness({
        turns: [toolTurn('write_file', { path: 'notes.txt', content: 'hi' }), textTurn('done')],
      });
      try {
        const session = await h.rpc.sessions.create({ workspaceId: h.workspaceId });
        const snapshots: { entries: { sessionId: string }[] }[] = [];
        const off = h.rpc.on('approvals.pending.updated', (payload) =>
          snapshots.push(payload as { entries: { sessionId: string }[] }),
        );
        let approvalId: string | undefined;
        const offRequest = h.rpc.on('approval.request', (event) => {
          if (event.sessionId === session.id) approvalId = event.part.id;
        });
        await h.rpc.sessions.send(session.id, { text: 'write a note' });
        await waitFor(() => approvalId !== undefined);
        offRequest();
        await waitFor(async () => {
          const detail = await h.rpc.sessions.get(session.id);
          return detail.session.status === 'awaiting_approval';
        });
        await h.host.stop();
        await waitFor(() => snapshots.some((snapshot) => snapshot.entries.length === 0));
        off();
      } finally {
        await h.close();
      }
    },
  );

  it(
    'does not resurrect usage or summaries for a removed conversation',
    { timeout: 30_000 },
    async () => {
      const h = await startHarness();
      try {
        const session = seedSession(SessionIdSchema.parse('session_removed'));
        putSession(h.services, session);
        h.services.messages.put(assistant(session.id, [textPart('done')], MODEL_A));
        await h.rpc.sessions.remove(session.id);
        expect((await h.rpc.sessions.list()).map((item) => item.id)).not.toContain(session.id);
        await expect(h.rpc.sessions.modelUsage(session.id)).rejects.toMatchObject({
          kind: 'not_found',
        });
      } finally {
        await h.close();
      }
    },
  );
});
