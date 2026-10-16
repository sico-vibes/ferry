import { describe, expect, it } from 'vitest';
import {
  ApprovalsPendingSchema,
  MessageSchema,
  ModelRefSchema,
  SessionModelUsageSchema,
} from '@ferry/shared';
import { createMockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';
import { createPlaybackRunner } from '../src/mock/playback/engine.js';

const now = new Date('2026-09-23T21:47:00.000Z');

const flush = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

const makeClient = () =>
  createMockFerryClient({ clock: createFakeClock(now).clock, behavior: 'test' });

describe('mock session/approval consumers', () => {
  it('lists and reads the actual finalized reply model', async () => {
    const client = makeClient();
    const sessions = await client.sessions.list();
    const flaky = sessions.find((session) => session.id === 'session_3');
    const auth = sessions.find((session) => session.id === 'session_2');
    if (!flaky || !auth) throw new Error('Session fixtures missing');
    expect(flaky.lastReplyModelRef).toBe('cerebras/gpt-oss-120b');
    // The auth reply was recorded without a model, so the summary is honest about the unknown.
    expect(auth.lastReplyModelRef).toBeNull();
    expect((await client.sessions.get('session_3' as never)).session.lastReplyModelRef).toBe(
      'cerebras/gpt-oss-120b',
    );
  });

  it('keeps an unreported dimension null while a reported zero stays zero', async () => {
    const client = makeClient();
    const usage = SessionModelUsageSchema.parse(
      await client.sessions.modelUsage('session_2' as never),
    );
    expect(usage.models).toHaveLength(1);
    expect(usage.models[0]).toMatchObject({
      modelRef: 'openrouter/gpt-4.1-mini',
      inputTokens: 1840,
      outputTokens: 420,
      cachedTokens: 0,
      reasoningTokens: null,
    });
    expect(usage.totals.cachedTokens).toBe(0);
    expect(usage.totals.reasoningTokens).toBeNull();
    expect(usage.incomplete).toBe(false);
    expect(usage.coverage.missing).toBe(false);

    const mixed = await client.sessions.modelUsage('session_3' as never);
    expect(mixed.models).toHaveLength(2);
    // The unreported provider keeps null tokens and is labelled incomplete rather than zeroed.
    expect(mixed.totals.inputTokens).toBe(3100);
    expect(mixed.incomplete).toBe(true);
    expect(mixed.coverage.missing).toBe(true);
  });

  it('records usage and the final model for a scripted reply', async () => {
    const fake = createFakeClock(now);
    const client = createMockFerryClient({ clock: fake.clock, behavior: 'test' });
    const workspace = (await client.workspaces.list())[0];
    if (!workspace) throw new Error('Workspace fixture missing');
    const session = await client.sessions.create({ workspaceId: workspace.id, title: 'Usage run' });
    const stored = client.__state().sessions.find((entry) => entry.id === session.id);
    if (!stored) throw new Error('Created session missing');
    stored.modelRef = ModelRefSchema.parse('gemini/gemini-3.8-flash');

    await client.sessions.send(session.id, { text: 'Explain the architecture' });
    for (const step of [600, 150, 150, 150]) {
      fake.advance(step);
      await flush();
    }

    const usage = await client.sessions.modelUsage(session.id);
    expect(usage.models).toHaveLength(1);
    expect(usage.models[0]?.modelRef).toBe('gemini/gemini-3.8-flash');
    expect(usage.models[0]?.inputTokens).toBeNull();
    expect(usage.incomplete).toBe(true);
    expect(usage.coverage.missing).toBe(true);
    const detail = await client.sessions.get(session.id);
    expect(detail.session.lastReplyModelRef).toBe('gemini/gemini-3.8-flash');
  });

  it('records an honest unknown producer instead of a logical Gateway key', async () => {
    const fake = createFakeClock(now);
    const client = createMockFerryClient({ clock: fake.clock, behavior: 'test' });
    const workspace = (await client.workspaces.list())[0];
    if (!workspace) throw new Error('Workspace fixture missing');
    const session = await client.sessions.create({
      workspaceId: workspace.id,
      title: 'Gateway run',
    });
    const stored = client.__state().sessions.find((entry) => entry.id === session.id);
    if (!stored) throw new Error('Created session missing');
    stored.modelRef = ModelRefSchema.parse('gateway/requested-key');

    await client.sessions.send(session.id, { text: 'Explain the architecture' });
    for (const step of [600, 150, 150, 150]) {
      fake.advance(step);
      await flush();
    }

    const usage = SessionModelUsageSchema.parse(await client.sessions.modelUsage(session.id));
    // The logical key is never listed as the model that served the request.
    expect(usage.models.some((model) => model.modelRef.startsWith('gateway/'))).toBe(false);
    expect(usage.models).toHaveLength(1);
    expect(usage.models[0]?.modelRef.startsWith('unknown/')).toBe(true);
    // The request count survives; the unprovable attribution and tokens do not get invented.
    expect(usage.totals.requests).toBe(1);
    expect(usage.models[0]?.inputTokens).toBeNull();
    expect(usage.incomplete).toBe(true);
    expect(usage.coverage.missing).toBe(true);
    expect((await client.sessions.get(session.id)).session.lastReplyModelRef).toBeNull();
  });

  it('labels a persisted conversation with replies but no usage ledger as missing', async () => {
    const client = makeClient();
    const empty = SessionModelUsageSchema.parse(
      await client.sessions.modelUsage('session_1' as never),
    );
    expect(empty.totals.requests).toBe(0);
    expect(empty.coverage).toEqual({ since: null, missing: false });

    const session = await client.sessions.create({ title: 'Old chat' });
    client
      .__state()
      .messages.get(session.id)
      ?.push(
        MessageSchema.parse({
          id: 'message_old_reply',
          sessionId: session.id,
          role: 'assistant',
          createdAt: now.toISOString(),
          modelRef: 'cerebras/gpt-oss-120b',
          parts: [{ type: 'text', id: 'part_old_reply', text: 'an older reply' }],
        }),
      );
    const usage = SessionModelUsageSchema.parse(await client.sessions.modelUsage(session.id));
    // Existing generation proves history the mock never retained; nothing is invented for it.
    expect(usage.models).toEqual([]);
    expect(usage.totals.requests).toBe(0);
    expect(usage.totals.inputTokens).toBeNull();
    expect(usage.coverage.missing).toBe(true);
  });

  it('keeps a fully reported fresh reply complete though its message precedes the usage row', async () => {
    const client = makeClient();
    const session = await client.sessions.create({ title: 'Fresh chat' });
    const createdAt = now.toISOString();
    client
      .__state()
      .messages.get(session.id)
      ?.push(
        MessageSchema.parse({
          id: 'message_fresh_reply',
          sessionId: session.id,
          role: 'assistant',
          createdAt,
          modelRef: 'cerebras/gpt-oss-120b',
          parts: [{ type: 'text', id: 'part_fresh_reply', text: 'done' }],
        }),
      );
    // A normal reply is appended before its usage is recorded (message start < usage finish).
    client.__store().recordUsage({
      eventId: 'usage_fresh_reply',
      sessionId: session.id,
      modelRef: 'cerebras/gpt-oss-120b',
      providerId: 'cerebras',
      connectionId: null,
      accountKey: null,
      inputTokens: 1108,
      outputTokens: 93,
      cachedTokens: null,
      reasoningTokens: null,
      occurredAt: new Date(Date.parse(createdAt) + 5_000).toISOString(),
    });
    const usage = SessionModelUsageSchema.parse(await client.sessions.modelUsage(session.id));
    expect(usage.totals).toMatchObject({ requests: 1, inputTokens: 1108, outputTokens: 93 });
    expect(usage.incomplete).toBe(false);
    expect(usage.coverage.missing).toBe(false);
  });

  it('publishes pending approvals on append and resolve, excluding idle sessions', async () => {
    const fake = createFakeClock(now);
    const client = createMockFerryClient({
      clock: fake.clock,
      scenarioRunner: createPlaybackRunner({ speed: 0 }),
    });
    const snapshots: { entries: { sessionId: string }[] }[] = [];
    client.on('approvals.pending.updated', (payload) =>
      snapshots.push(ApprovalsPendingSchema.parse(payload)),
    );

    // An idle session holding a pending part must never surface.
    const idle = (await client.sessions.list()).find((session) => session.id === 'session_5');
    if (!idle) throw new Error('Idle fixture session missing');
    const idlePart = {
      type: 'approval_request' as const,
      id: 'part_idle_pending' as never,
      kind: 'command' as const,
      summary: 'Idle approval',
      detail: 'noop',
      risk: 'low' as const,
      state: 'pending' as const,
    };
    client
      .__state()
      .messages.get(idle.id)
      ?.push(
        MessageSchema.parse({
          id: 'message_idle_pending' as never,
          sessionId: idle.id,
          role: 'assistant',
          createdAt: now.toISOString(),
          modelRef: null,
          parts: [idlePart],
        }),
      );

    await client.sessions.send('session_3' as never, { text: 'Fix the flaky payment tests' });
    for (let i = 0; i < 200; i++) {
      fake.advance(100_000);
      await flush(1);
      if (
        client.__state().sessions.find((session) => session.id === 'session_3')?.status ===
        'awaiting_approval'
      )
        break;
    }

    const pending = ApprovalsPendingSchema.parse(await client.approvals.pending());
    expect(pending.entries.map((entry) => entry.sessionId)).toEqual(['session_3']);
    expect(snapshots.some((snapshot) => snapshot.entries.length === 1)).toBe(true);

    const approval = pending.entries[0];
    if (!approval) throw new Error('Pending approval missing');
    await client.approvals.respond('session_3' as never, approval.partId, 'allow_once');
    const after = ApprovalsPendingSchema.parse(await client.approvals.pending());
    expect(after.entries).toEqual([]);
    expect(snapshots.at(-1)?.entries).toEqual([]);
  });

  it('publishes pending approvals when an awaiting session is removed', async () => {
    const fake = createFakeClock(now);
    const client = createMockFerryClient({
      clock: fake.clock,
      scenarioRunner: createPlaybackRunner({ speed: 0 }),
    });
    const snapshots: { entries: unknown[] }[] = [];
    client.on('approvals.pending.updated', (payload) =>
      snapshots.push(ApprovalsPendingSchema.parse(payload)),
    );
    await client.sessions.send('session_3' as never, { text: 'Fix the flaky payment tests' });
    for (let i = 0; i < 200; i++) {
      fake.advance(100_000);
      await flush(1);
      if (
        client.__state().sessions.find((session) => session.id === 'session_3')?.status ===
        'awaiting_approval'
      )
        break;
    }
    expect((await client.approvals.pending()).entries).toHaveLength(1);
    await client.sessions.remove('session_3' as never);
    expect((await client.approvals.pending()).entries).toEqual([]);
    expect(snapshots.at(-1)?.entries).toEqual([]);
  });
});
