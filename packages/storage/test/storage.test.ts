import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileIdSchema, SessionIdSchema, WorkspaceIdSchema } from '@ferry/shared';
import {
  openDatabase,
  runRetention,
  RequestRepository,
  ProviderKeyEntryRepository,
  ProviderKeyUsageDailyRepository,
  SessionRepository,
  STORAGE_SCHEMA_VERSION,
  OutboxRepository,
  TurnLogRepository,
  EventLogRepository,
  ModelSwitchRepository,
  CloudTelemetrySink,
  LocalTelemetrySink,
} from '../src/index.js';

const dirs: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('@ferry/storage', () => {
  it('stores metadata-only local telemetry and idempotent cloud outbox events', async () => {
    const db = await openDatabase(':memory:');
    try {
      const turns = new TurnLogRepository(db.client);
      const logs = new EventLogRepository(db.client);
      const switches = new ModelSwitchRepository(db.client);
      const outbox = new OutboxRepository(db.client);
      const local = new LocalTelemetrySink(turns, logs, switches);
      local.log({
        id: 'evt_local',
        event: 'request.received',
        source: 'ui',
        data: {
          prompt: 'local private prompt',
          response: 'assistant output',
          reasoning: 'private reasoning',
          input: { tool: 'private input' },
          output: 'private tool output',
          inputTokens: 10,
          outputTokens: 4,
          cachedTokens: 2,
          reasoningTokens: 1,
          maxTokens: 100,
          tokens: 14,
          input_tokens: 10,
          authorization: 'Bearer private-key',
          nested: { apiKey: 'sk-supersecretcredential' },
        },
      });
      expect(logs.get('evt_local')?.data).toMatchObject({
        prompt: { omitted: 'capture-off', chars: 20 },
        response: { omitted: 'capture-off', chars: 16 },
        reasoning: { omitted: 'capture-off', chars: 17 },
        input: { omitted: 'capture-off' },
        output: { omitted: 'capture-off', chars: 19 },
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 2,
        reasoningTokens: 1,
        maxTokens: 100,
        tokens: 14,
        input_tokens: 10,
        authorization: '[REDACTED]',
        nested: { apiKey: '[REDACTED]' },
      });
      local.turnStarted({
        id: 'turn_secret',
        error_message: 'provider echoed sk-supersecretcredential',
        input_tokens: 9,
      });
      expect(turns.get('turn_secret')).toMatchObject({
        error_message: 'provider echoed [REDACTED]',
        input_tokens: 9,
      });
      local.modelSwitch({
        session_id: 'ses_test',
        kind: 'selection_change',
        from_model: 'openai/a',
        to_model: 'openai/b',
        data: { who: 'user', mid_run: true },
      });
      local.modelSwitch({
        session_id: 'ses_test',
        kind: 'router_fallback',
        from_model: 'openai/a',
        to_model: 'openai/b',
        reason: 'rate_limit',
      });
      expect(switches.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'selection_change',
            data: { who: 'user', mid_run: true },
          }),
          expect.objectContaining({ kind: 'router_fallback', reason: 'rate_limit' }),
        ]),
      );
      const sink = new CloudTelemetrySink(turns, logs, switches, outbox, false);
      sink.log({
        id: 'evt_test',
        event: 'request.received',
        source: 'ui',
        data: { prompt: 'private prompt', inputTokens: 18 },
      });
      sink.log({
        id: 'evt_test',
        event: 'request.received',
        source: 'ui',
        data: { prompt: 'private prompt', inputTokens: 18 },
      });
      expect(logs.get('evt_test')).toMatchObject({
        data: { prompt: { omitted: 'capture-off', chars: 14 }, inputTokens: 18 },
      });
      expect(outbox.counts().pending).toBe(1);
      const queued = outbox.claimDue(10).find((entry) => entry.opId === 'logs:evt_test');
      expect(queued?.payloadJson).not.toContain('private prompt');
      const captureSink = new CloudTelemetrySink(turns, logs, switches, outbox, true);
      captureSink.log({
        id: 'evt_capture',
        event: 'turn.completed',
        source: 'agent',
        data: {
          prompt: 'private prompt sk-abcdefghijk',
          response: 'assistant text',
          reasoning: 'reasoning text',
          outputTokens: 8,
        },
      });
      expect(logs.get('evt_capture')?.data).toMatchObject({
        prompt: 'private prompt [REDACTED]',
        response: 'assistant text',
        reasoning: 'reasoning text',
        outputTokens: 8,
      });
    } finally {
      db.close();
    }
  });
  it('persists idempotent cloud outbox operations across repository instances', async () => {
    const db = await openDatabase(':memory:');
    try {
      const first = new OutboxRepository(db.client);
      first.enqueue({
        opId: 'sessions:ses_test:1',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'ses_test' },
      });
      first.enqueue({
        opId: 'sessions:ses_test:1',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'ses_test', title: 'newer' },
      });
      const restarted = new OutboxRepository(db.client);
      const claimed = restarted.claimDue(10);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.payloadJson).toContain('newer');
      expect(restarted.counts()).toEqual({ pending: 1, failedPermanent: 0 });
      const firstClaim = claimed[0];
      if (!firstClaim) throw new Error('Expected one claimed outbox row');
      restarted.markDone(firstClaim.id, firstClaim.generation);
      expect(restarted.counts()).toEqual({ pending: 0, failedPermanent: 0 });
    } finally {
      db.close();
    }
  });
  it('keeps a coalesced payload when an older generation completes in flight', async () => {
    const db = await openDatabase(':memory:');
    try {
      const outbox = new OutboxRepository(db.client);
      outbox.enqueue({
        opId: 'sessions:ses_race',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'ses_race', title: 'old' },
      });
      const claimed = outbox.claimDue(1)[0];
      if (!claimed) throw new Error('Expected a claimed row');
      outbox.enqueue({
        opId: 'sessions:ses_race',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'ses_race', title: 'new' },
      });
      outbox.markDone(claimed.id, claimed.generation);
      const retry = outbox.claimDue(1)[0];
      expect(retry?.payloadJson).toContain('new');
      expect(retry?.generation).toBeGreaterThan(claimed.generation);
    } finally {
      db.close();
    }
  });
  it('replaces pending operations when an entity is deleted or recreated', async () => {
    const db = await openDatabase(':memory:');
    try {
      const outbox = new OutboxRepository(db.client);
      outbox.enqueue({
        opId: 'sessions:ses_order',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'ses_order' },
      });
      outbox.enqueue({
        opId: 'sessions:ses_order:delete',
        target: 'sessions',
        op: 'delete',
        payload: { id: 'ses_order' },
      });
      expect(outbox.claimDue(10).map(({ op }) => op)).toEqual(['delete']);
      outbox.enqueue({
        opId: 'sessions:ses_order',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'ses_order' },
      });
      expect(outbox.claimDue(10).map(({ op }) => op)).toEqual(['upsert']);
    } finally {
      db.close();
    }
  });
  it('preserves an in-flight opposite operation while queuing its successor', async () => {
    const db = await openDatabase(':memory:');
    try {
      const outbox = new OutboxRepository(db.client);
      outbox.enqueue({
        opId: 'sessions:ses_inflight',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'ses_inflight' },
      });
      const claimed = outbox.claimDue(1)[0];
      if (!claimed) throw new Error('Expected claimed upsert');
      outbox.enqueue({
        opId: 'sessions:ses_inflight:delete',
        target: 'sessions',
        op: 'delete',
        payload: { id: 'ses_inflight' },
      });
      const successor = outbox.claimDue(10)[0];
      expect(successor?.op).toBe('delete');
      outbox.markDone(claimed.id, claimed.generation);
      if (!successor) throw new Error('Expected pending delete successor');
      outbox.markDone(successor.id, successor.generation);
      expect(outbox.counts().pending).toBe(0);
    } finally {
      db.close();
    }
  });
  it('revives permanent rows when the same op id is queued with a newer payload', async () => {
    const db = await openDatabase(':memory:');
    try {
      const outbox = new OutboxRepository(db.client);
      outbox.enqueue({
        opId: 'sessions:ses_repair',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'ses_repair' },
      });
      const row = outbox.claimDue(1)[0];
      if (!row) throw new Error('Expected a claimed row');
      outbox.markPermanent(row.id, row.generation, 'constraint');
      expect(outbox.counts().failedPermanent).toBe(1);
      outbox.enqueue({
        opId: 'sessions:ses_repair',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'ses_repair', title: 'repaired' },
      });
      expect(outbox.claimDue(1)[0]?.payloadJson).toContain('repaired');
      expect(outbox.counts()).toEqual({ pending: 1, failedPermanent: 0 });
    } finally {
      db.close();
    }
  });
  it('upserts turn status changes but keeps append-only event ids idempotent', async () => {
    const db = await openDatabase(':memory:');
    try {
      const turns = new TurnLogRepository(db.client);
      turns.put({
        id: 'turn_1',
        status: 'pending',
        session_id: 'session_1',
        trace_id: 'a'.repeat(32),
      });
      turns.put({
        id: 'turn_1',
        status: 'success',
        session_id: 'session_1',
        trace_id: 'a'.repeat(32),
      });
      expect(turns.get('turn_1')?.status).toBe('success');
      const events = new EventLogRepository(db.client);
      events.put({ id: 'event_1', event: 'turn.done', ts: '2026-01-01T00:00:00.000Z' });
      events.put({ id: 'event_1', event: 'turn.overwritten', ts: '2026-01-02T00:00:00.000Z' });
      expect(events.get('event_1')?.event).toBe('turn.done');
      const columns = db.client.prepare('PRAGMA table_info(telemetry_turns)').all() as {
        name: string;
      }[];
      expect(columns.map((column) => column.name)).toContain('trace_id');
      expect(columns.map((column) => column.name)).toContain('data_json');
    } finally {
      db.close();
    }
  });
  it('migrates a legacy provider credential into key 1 without changing its keyring reference', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ferry-key-migration-'));
    dirs.push(dir);
    const path = join(dir, 'ferry.sqlite');
    const db = await openDatabase(path);
    try {
      db.client.prepare('DELETE FROM provider_key_entries').run();
      db.client
        .prepare(
          'INSERT INTO provider_keys (id,provider_id,keyring_ref,created_at) VALUES (?,?,?,?)',
        )
        .run('openai', 'openai', 'openai', '2026-10-03T00:00:00.000Z');
      db.client.pragma('user_version = 3');
      db.close();
      const migrated = await openDatabase(path);
      try {
        expect(new ProviderKeyEntryRepository(migrated.client).list('openai')).toEqual([
          expect.objectContaining({
            providerId: 'openai',
            keyId: '1',
            label: 'Key 1',
            position: 0,
            keyringRef: 'openai',
            enabled: true,
            status: 'ok',
          }),
        ]);
      } finally {
        migrated.close();
      }
    } finally {
      // The in-memory connection was closed above before migration replay.
    }
  });
  it('stores provider key ordering and health independently', async () => {
    const db = await openDatabase(':memory:');
    try {
      const repository = new ProviderKeyEntryRepository(db.client);
      const now = new Date().toISOString();
      for (const [keyId, position, status] of [
        ['1', 0, 'rate_limited'],
        ['2', 1, 'ok'],
      ] as const) {
        repository.put({
          id: `groq:${keyId}`,
          providerId: 'groq',
          keyId,
          label: `Account ${keyId}`,
          position,
          enabled: true,
          status,
          lastError: status === 'ok' ? null : 'HTTP 429',
          cooldownUntil: status === 'ok' ? null : '2026-10-03T01:00:00.000Z',
          keyringRef: `groq:${keyId}`,
          createdAt: now,
          updatedAt: now,
        });
      }
      expect(repository.list('groq').map(({ keyId, status }) => [keyId, status])).toEqual([
        ['1', 'rate_limited'],
        ['2', 'ok'],
      ]);
    } finally {
      db.close();
    }
  });
  it('aggregates successful usage per key for the current UTC day', async () => {
    const db = await openDatabase(':memory:');
    try {
      const repository = new ProviderKeyUsageDailyRepository(db.client);
      const at = new Date('2026-10-03T12:00:00.000Z');
      repository.record('openai', '1', at, 12, 4);
      repository.record('openai', '1', at, 3, 2);
      repository.record('openai', '2', at, 100, 20);
      expect(repository.today('openai', '1', at)).toEqual({ requests: 2, tokens: 21 });
      expect(repository.today('openai', '2', at)).toEqual({ requests: 1, tokens: 120 });
      expect(repository.today('openai', '1', new Date('2026-10-04T00:00:00.000Z'))).toEqual({
        requests: 0,
        tokens: 0,
      });
    } finally {
      db.close();
    }
  });
  it('migrates an empty database, round-trips shared aggregates and tolerates concurrent inserts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ferry-db-'));
    dirs.push(dir);
    const db = await openDatabase(join(dir, 'ferry.sqlite'));
    try {
      expect(db.client.pragma('user_version', { simple: true })).toBe(STORAGE_SCHEMA_VERSION);
      const repo = new SessionRepository(db.client);
      const session = {
        id: 's1',
        workspaceId: WorkspaceIdSchema.parse('w1'),
        title: 'test',
        preview: '',
        profileId: ProfileIdSchema.parse('default'),
        modelRef: null,
        pinnedModelRef: null,
        starred: false,
        pinned: false,
        status: 'idle' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agentEvents: [],
      };
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          Promise.resolve().then(() => {
            repo.put({ ...session, id: SessionIdSchema.parse(`s${String(index)}`) });
          }),
        ),
      );
      expect(repo.list()).toHaveLength(8);
      expect(repo.get('s1')?.title).toBe('test');
    } finally {
      db.close();
    }
  });
  it('migrates delegation progress into structured events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ferry-event-migration-'));
    dirs.push(dir);
    const path = join(dir, 'ferry.sqlite');
    const first = await openDatabase(path);
    first.client
      .prepare('INSERT INTO delegations (id, data_json, updated_at) VALUES (?, ?, ?)')
      .run(
        'run_legacy',
        JSON.stringify({
          id: 'run_legacy',
          progress: [{ at: '2026-09-29T12:00:00.000Z', text: 'old progress' }],
        }),
        '2026-09-29T12:00:00.000Z',
      );
    first.client.pragma('user_version = 2');
    first.close();
    const migrated = await openDatabase(path);
    try {
      const row = migrated.client
        .prepare('SELECT data_json FROM delegations WHERE id = ?')
        .get('run_legacy') as { data_json: string } | undefined;
      const data = JSON.parse(row?.data_json ?? '{}') as {
        events: { type: string; content: string }[];
      };
      expect(data.events).toEqual([
        expect.objectContaining({ type: 'text', content: 'old progress' }),
      ]);
    } finally {
      migrated.close();
    }
  });
  it('aggregates old requests into daily usage and redacts secret headers', async () => {
    const db = await openDatabase(':memory:');
    try {
      const requests = new RequestRepository(db.client);
      requests.put({
        id: 'old1',
        ts: '2020-01-02T10:00:00.000Z',
        provider: 'p',
        model: 'm',
        input_tokens: 10,
        output_tokens: 4,
        cost_usd: 0.5,
        status: 'ok',
        headers: { Authorization: 'Bearer secret', 'x-api-key': 'sk-supersecretvalue' },
      });
      expect(
        db.client.prepare('SELECT headers_json FROM requests WHERE id=?').get('old1'),
      ).toMatchObject({ headers_json: '{"Authorization":"[REDACTED]","x-api-key":"[REDACTED]"}' });
      expect(runRetention(db.client, new Date('2020-02-01T00:00:00.000Z'))).toBe(1);
      expect(
        db.client.prepare('SELECT requests,input_tokens,output_tokens FROM usage_daily').get(),
      ).toMatchObject({ requests: 1, input_tokens: 10, output_tokens: 4 });
    } finally {
      db.close();
    }
  });
});
