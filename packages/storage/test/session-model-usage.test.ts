import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileIdSchema, SessionIdSchema, WorkspaceIdSchema } from '@ferry/shared';
import type { Session } from '@ferry/shared';
import {
  backfillSessionModelUsage,
  openDatabase,
  RequestRepository,
  runRetention,
  SessionModelUsageRepository,
  SessionRepository,
  STORAGE_SCHEMA_VERSION,
} from '../src/index.js';

const dirs: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ferry-usage-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })),
  );
});

function sessionFor(id: string): Session {
  const now = new Date().toISOString();
  return {
    archived: false,
    id: SessionIdSchema.parse(id),
    workspaceId: WorkspaceIdSchema.parse('w1'),
    title: 'usage',
    preview: '',
    profileId: ProfileIdSchema.parse('default'),
    modelRef: null,
    pinnedModelRef: null,
    starred: false,
    pinned: false,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    agentEvents: [],
  };
}

async function seedV10Database(
  file: string,
  seed: (client: Database.Database) => void,
): Promise<void> {
  const db = await openDatabase(file);
  db.client.exec('DROP TABLE session_model_usage');
  db.client.exec('DROP TABLE usage_event_keys');
  db.client.exec(`CREATE TABLE session_model_usage (
    session_id TEXT NOT NULL, model_ref TEXT NOT NULL, provider_id TEXT, connection_id TEXT,
    account_key TEXT, requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0, input_reported INTEGER NOT NULL DEFAULT 0,
    output_reported INTEGER NOT NULL DEFAULT 0, cached_reported INTEGER NOT NULL DEFAULT 0,
    reasoning_reported INTEGER NOT NULL DEFAULT 0, unreported_requests INTEGER NOT NULL DEFAULT 0,
    backfilled INTEGER NOT NULL DEFAULT 0, last_used_at TEXT NOT NULL,
    PRIMARY KEY (session_id, model_ref))`);
  db.client.exec(`CREATE TABLE usage_event_keys (
    event_id TEXT PRIMARY KEY, session_id TEXT, model_ref TEXT, provider_id TEXT,
    connection_id TEXT, account_key TEXT, input_tokens INTEGER, output_tokens INTEGER,
    cached_tokens INTEGER, reasoning_tokens INTEGER, last_used_at TEXT NOT NULL)`);
  seed(db.client);
  db.client.pragma('user_version = 10');
  db.close();
}

function insertSessionRow(client: Database.Database, id: string): void {
  client
    .prepare('INSERT INTO sessions (id,data_json,updated_at) VALUES (?,?,?)')
    .run(id, JSON.stringify(sessionFor(id)), '2026-01-01T00:00:00.000Z');
}

interface LegacyAggregateSeed {
  sessionId: string;
  modelRef: string;
  providerId?: string | null;
  connectionId?: string | null;
  accountKey?: string | null;
  requests: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  inputReported?: number;
  outputReported?: number;
  cachedReported?: number;
  reasoningReported?: number;
  unreportedRequests?: number;
  lastUsedAt?: string;
}

function insertLegacyAggregate(client: Database.Database, seed: LegacyAggregateSeed): void {
  client
    .prepare(
      `INSERT INTO session_model_usage (session_id,model_ref,provider_id,connection_id,account_key,requests,input_tokens,output_tokens,cached_tokens,reasoning_tokens,input_reported,output_reported,cached_reported,reasoning_reported,unreported_requests,backfilled,last_used_at)
       VALUES (@sessionId,@modelRef,@providerId,@connectionId,@accountKey,@requests,@inputTokens,@outputTokens,@cachedTokens,@reasoningTokens,@inputReported,@outputReported,@cachedReported,@reasoningReported,@unreportedRequests,0,@lastUsedAt)`,
    )
    .run({
      sessionId: seed.sessionId,
      modelRef: seed.modelRef,
      providerId: seed.providerId ?? null,
      connectionId: seed.connectionId ?? null,
      accountKey: seed.accountKey ?? null,
      requests: seed.requests,
      inputTokens: seed.inputTokens ?? 0,
      outputTokens: seed.outputTokens ?? 0,
      cachedTokens: seed.cachedTokens ?? 0,
      reasoningTokens: seed.reasoningTokens ?? 0,
      inputReported: seed.inputReported ?? 0,
      outputReported: seed.outputReported ?? 0,
      cachedReported: seed.cachedReported ?? 0,
      reasoningReported: seed.reasoningReported ?? 0,
      unreportedRequests: seed.unreportedRequests ?? 0,
      lastUsedAt: seed.lastUsedAt ?? '2026-01-01T00:00:00.000Z',
    });
}

interface LegacyLedgerSeed {
  eventId: string;
  sessionId: string;
  modelRef: string;
  providerId?: string | null;
  connectionId?: string | null;
  accountKey?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  lastUsedAt?: string;
}

function insertLegacyLedger(client: Database.Database, seed: LegacyLedgerSeed): void {
  client
    .prepare(
      `INSERT INTO usage_event_keys (event_id,session_id,model_ref,provider_id,connection_id,account_key,input_tokens,output_tokens,cached_tokens,reasoning_tokens,last_used_at)
       VALUES (@eventId,@sessionId,@modelRef,@providerId,@connectionId,@accountKey,@inputTokens,@outputTokens,@cachedTokens,@reasoningTokens,@lastUsedAt)`,
    )
    .run({
      eventId: seed.eventId,
      sessionId: seed.sessionId,
      modelRef: seed.modelRef,
      providerId: seed.providerId ?? null,
      connectionId: seed.connectionId ?? null,
      accountKey: seed.accountKey ?? null,
      inputTokens: seed.inputTokens ?? null,
      outputTokens: seed.outputTokens ?? null,
      cachedTokens: seed.cachedTokens ?? null,
      reasoningTokens: seed.reasoningTokens ?? null,
      lastUsedAt: seed.lastUsedAt ?? '2026-01-01T00:00:00.000Z',
    });
}

describe('@ferry/storage session/model usage aggregates', () => {
  it('persists per-session/model usage across reopen without re-backfilling', async () => {
    const file = join(await tempDir(), 'usage.sqlite');
    const first = await openDatabase(file);
    new RequestRepository(first.client).put({
      id: 'e1',
      ts: '2026-01-01T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: 's1',
      connection_id: 'openai-conn',
      account_key: 'acct-1',
      input_tokens: 10,
      output_tokens: 4,
      status: 'ok',
    });
    first.close();
    const second = await openDatabase(file);
    try {
      const usage = new SessionModelUsageRepository(second.client).getBySession('s1');
      expect(usage.rows).toEqual([
        {
          sessionId: 's1',
          modelRef: 'gpt-5',
          providerId: 'openai',
          connectionId: 'openai-conn',
          accountKey: 'acct-1',
          requests: 1,
          inputTokens: 10,
          outputTokens: 4,
          cachedTokens: null,
          reasoningTokens: null,
          lastUsedAt: '2026-01-01T00:00:00.000Z',
          unreportedRequests: 0,
          incomplete: false,
        },
      ]);
      expect(usage.totals).toEqual({
        requests: 1,
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: null,
        reasoningTokens: null,
        unreportedRequests: 0,
      });
      expect(usage.incomplete).toBe(false);
    } finally {
      second.close();
    }
  });

  it('keeps two events on two models as separate rows and totals', async () => {
    const db = await openDatabase(':memory:');
    try {
      const requests = new RequestRepository(db.client);
      requests.put({
        id: 'e1',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 10,
        output_tokens: 1,
        status: 'ok',
      });
      requests.put({
        id: 'e2',
        ts: '2026-01-01T00:00:05.000Z',
        provider: 'openai',
        model: 'gpt-5-mini',
        session_id: 's1',
        input_tokens: 20,
        output_tokens: 2,
        status: 'ok',
      });
      const usage = new SessionModelUsageRepository(db.client).getBySession('s1');
      expect(usage.rows.map((row) => row.modelRef)).toEqual(['gpt-5', 'gpt-5-mini']);
      expect(usage.totals).toEqual({
        requests: 2,
        inputTokens: 30,
        outputTokens: 3,
        cachedTokens: null,
        reasoningTokens: null,
        unreportedRequests: 0,
      });
    } finally {
      db.close();
    }
  });

  it('replaces a cumulative update for the same event id instead of summing snapshots', async () => {
    const db = await openDatabase(':memory:');
    try {
      const requests = new RequestRepository(db.client);
      requests.put({
        id: 'e1',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 10,
        output_tokens: 2,
        status: 'ok',
      });
      requests.put({
        id: 'e1',
        ts: '2026-01-01T00:00:01.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 15,
        output_tokens: 5,
        status: 'ok',
      });
      const usage = new SessionModelUsageRepository(db.client).getBySession('s1');
      expect(usage.rows).toHaveLength(1);
      expect(usage.totals).toEqual({
        requests: 1,
        inputTokens: 15,
        outputTokens: 5,
        cachedTokens: null,
        reasoningTokens: null,
        unreportedRequests: 0,
      });
    } finally {
      db.close();
    }
  });

  it('keeps reported zero as zero while missing fields stay null and count as unreported', async () => {
    const db = await openDatabase(':memory:');
    try {
      const requests = new RequestRepository(db.client);
      requests.put({
        id: 'zero',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 0,
        output_tokens: 0,
        status: 'ok',
      });
      requests.put({
        id: 'missing',
        ts: '2026-01-01T00:00:01.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        status: 'error',
      });
      const usage = new SessionModelUsageRepository(db.client).getBySession('s1');
      expect(usage.rows).toHaveLength(1);
      expect(usage.rows[0]).toMatchObject({
        requests: 2,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: null,
        reasoningTokens: null,
        unreportedRequests: 1,
      });
      expect(usage.incomplete).toBe(true);
    } finally {
      db.close();
    }
  });

  it('reports nullable dimensions for partial usage and marks primary coverage incomplete', async () => {
    const db = await openDatabase(':memory:');
    try {
      new RequestRepository(db.client).put({
        id: 'partial',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 12,
        cached_tokens: 3,
        status: 'ok',
      });
      const usage = new SessionModelUsageRepository(db.client).getBySession('s1');
      expect(usage.rows[0]).toMatchObject({
        inputTokens: 12,
        outputTokens: null,
        cachedTokens: 3,
        reasoningTokens: null,
        unreportedRequests: 0,
        incomplete: true,
      });
      expect(usage.totals).toEqual({
        requests: 1,
        inputTokens: 12,
        outputTokens: null,
        cachedTokens: 3,
        reasoningTokens: null,
        unreportedRequests: 0,
      });
      expect(usage.incomplete).toBe(true);
    } finally {
      db.close();
    }
  });

  it('treats reported zero input and output as complete coverage', async () => {
    const db = await openDatabase(':memory:');
    try {
      new RequestRepository(db.client).put({
        id: 'zeros',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 0,
        output_tokens: 0,
        status: 'ok',
      });
      const usage = new SessionModelUsageRepository(db.client).getBySession('s1');
      expect(usage.rows[0]).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: null,
        reasoningTokens: null,
        unreportedRequests: 0,
        incomplete: false,
      });
      expect(usage.incomplete).toBe(false);
    } finally {
      db.close();
    }
  });

  it('marks missing output while input is present as incomplete coverage', async () => {
    const db = await openDatabase(':memory:');
    try {
      new RequestRepository(db.client).put({
        id: 'input-only',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 7,
        status: 'ok',
      });
      const usage = new SessionModelUsageRepository(db.client).getBySession('s1');
      expect(usage.rows[0]).toMatchObject({
        inputTokens: 7,
        outputTokens: null,
        unreportedRequests: 0,
        incomplete: true,
      });
      expect(usage.incomplete).toBe(true);
    } finally {
      db.close();
    }
  });

  it('does not mark cache or reasoning absence as incomplete coverage', async () => {
    const db = await openDatabase(':memory:');
    try {
      new RequestRepository(db.client).put({
        id: 'no-cache',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 5,
        output_tokens: 5,
        status: 'ok',
      });
      const usage = new SessionModelUsageRepository(db.client).getBySession('s1');
      expect(usage.rows[0]).toMatchObject({
        cachedTokens: null,
        reasoningTokens: null,
        incomplete: false,
      });
      expect(usage.incomplete).toBe(false);
    } finally {
      db.close();
    }
  });

  it('ignores requests without a session id for per-conversation aggregates', async () => {
    const db = await openDatabase(':memory:');
    try {
      new RequestRepository(db.client).put({
        id: 'orphan',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        input_tokens: 5,
        status: 'ok',
      });
      const usage = new SessionModelUsageRepository(db.client);
      expect(usage.list()).toEqual([]);
      expect(usage.getBySession('s1')).toEqual({
        sessionId: 's1',
        rows: [],
        totals: {
          requests: 0,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          reasoningTokens: null,
          unreportedRequests: 0,
        },
        incomplete: false,
        backfilled: false,
        coverage: { since: null, unknown: false },
      });
      expect(db.client.prepare('SELECT count(*) AS n FROM usage_event_keys').get()).toMatchObject({
        n: 0,
      });
    } finally {
      db.close();
    }
  });

  it('moves a reassigned event between session and model buckets idempotently', async () => {
    const db = await openDatabase(':memory:');
    try {
      const requests = new RequestRepository(db.client);
      requests.put({
        id: 'e1',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 5,
        status: 'ok',
      });
      requests.put({
        id: 'e1',
        ts: '2026-01-01T00:00:02.000Z',
        provider: 'openai',
        model: 'gpt-5-mini',
        session_id: 's2',
        input_tokens: 7,
        status: 'ok',
      });
      const usage = new SessionModelUsageRepository(db.client);
      expect(usage.getBySession('s1').rows).toEqual([]);
      expect(usage.getBySession('s1').totals.requests).toBe(0);
      expect(usage.getBySession('s2').totals).toEqual({
        requests: 1,
        inputTokens: 7,
        outputTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
        unreportedRequests: 0,
      });
    } finally {
      db.close();
    }
  });

  it('backfills retained history exactly once', async () => {
    const file = join(await tempDir(), 'backfill.sqlite');
    const db = await openDatabase(file);
    try {
      db.client
        .prepare('INSERT INTO sessions (id,data_json,updated_at) VALUES (?,?,?)')
        .run('s1', JSON.stringify(sessionFor('s1')), '2026-01-01T00:00:00.000Z');
      const insert = db.client.prepare(
        'INSERT INTO requests (id,ts,provider,model,session_id,input_tokens,output_tokens,status) VALUES (?,?,?,?,?,?,?,?)',
      );
      insert.run('b1', '2026-01-01T00:00:00.000Z', 'openai', 'gpt-5', 's1', 10, 2, 'ok');
      insert.run('b2', '2026-01-01T00:00:01.000Z', 'openai', 'gpt-5', 's1', 5, 1, 'ok');
      expect(backfillSessionModelUsage(db.client)).toBe(2);
      expect(backfillSessionModelUsage(db.client)).toBe(0);
      const usage = new SessionModelUsageRepository(db.client).getBySession('s1');
      expect(usage.rows).toHaveLength(1);
      expect(usage.totals).toEqual({
        requests: 2,
        inputTokens: 15,
        outputTokens: 3,
        cachedTokens: null,
        reasoningTokens: null,
        unreportedRequests: 0,
      });
      expect(usage.backfilled).toBe(true);
      expect(usage.incomplete).toBe(false);
    } finally {
      db.close();
    }
  });

  it('keeps aggregates and ledger across detail retention and never recounts duplicates', async () => {
    const db = await openDatabase(':memory:');
    try {
      const requests = new RequestRepository(db.client);
      requests.put({
        id: 'old',
        ts: '2020-01-02T10:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 10,
        output_tokens: 4,
        cost_usd: 0.5,
        status: 'ok',
      });
      const usage = new SessionModelUsageRepository(db.client);
      expect(usage.getBySession('s1').totals.inputTokens).toBe(10);
      expect(runRetention(db.client, new Date('2020-02-01T00:00:00.000Z'))).toBe(1);
      expect(requests.list()).toHaveLength(0);
      expect(usage.getBySession('s1').totals).toEqual({
        requests: 1,
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: null,
        reasoningTokens: null,
        unreportedRequests: 0,
      });
      expect(db.client.prepare('SELECT count(*) AS n FROM usage_event_keys').get()).toMatchObject({
        n: 1,
      });
      requests.put({
        id: 'old',
        ts: '2020-01-02T10:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 10,
        output_tokens: 4,
        status: 'ok',
      });
      expect(usage.getBySession('s1').totals.requests).toBe(1);
      expect(usage.getBySession('s1').totals.inputTokens).toBe(10);
      requests.put({
        id: 'old',
        ts: '2020-01-02T10:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 14,
        output_tokens: 4,
        status: 'ok',
      });
      expect(usage.getBySession('s1').totals.requests).toBe(1);
      expect(usage.getBySession('s1').totals.inputTokens).toBe(14);
    } finally {
      db.close();
    }
  });

  it('clears the aggregate and ledger and detaches requests when a session is deleted', async () => {
    const db = await openDatabase(':memory:');
    try {
      new RequestRepository(db.client).put({
        id: 'e1',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 10,
        status: 'ok',
      });
      const sessions = new SessionRepository(db.client);
      sessions.put(sessionFor('s1'));
      expect(sessions.delete('s1')).toBe(true);
      expect(new SessionModelUsageRepository(db.client).list()).toEqual([]);
      expect(db.client.prepare('SELECT count(*) AS n FROM usage_event_keys').get()).toMatchObject({
        n: 0,
      });
      expect(
        db.client.prepare('SELECT session_id FROM requests WHERE id=?').get('e1'),
      ).toMatchObject({ session_id: null });
    } finally {
      db.close();
    }
  });

  it('does not resurrect deleted conversation usage after close and reopen', async () => {
    const file = join(await tempDir(), 'delete-reopen.sqlite');
    const first = await openDatabase(file);
    new RequestRepository(first.client).put({
      id: 'r1',
      ts: '2026-01-01T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: 's1',
      input_tokens: 10,
      output_tokens: 2,
      cost_usd: 0.25,
      status: 'ok',
    });
    const sessions = new SessionRepository(first.client);
    sessions.put(sessionFor('s1'));
    expect(sessions.delete('s1')).toBe(true);
    first.close();

    const second = await openDatabase(file);
    try {
      expect(new SessionModelUsageRepository(second.client).getBySession('s1')).toEqual({
        sessionId: 's1',
        rows: [],
        totals: {
          requests: 0,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          reasoningTokens: null,
          unreportedRequests: 0,
        },
        incomplete: false,
        backfilled: false,
        coverage: { since: null, unknown: false },
      });
      expect(
        second.client.prepare('SELECT count(*) AS n FROM session_model_usage').get(),
      ).toMatchObject({ n: 0 });
      expect(
        second.client.prepare('SELECT count(*) AS n FROM usage_event_keys').get(),
      ).toMatchObject({ n: 0 });
      // The retained request row is preserved for daily analytics, only detached.
      expect(second.client.prepare('SELECT count(*) AS n FROM requests').get()).toMatchObject({
        n: 1,
      });
      expect(
        second.client.prepare('SELECT session_id FROM requests WHERE id=?').get('r1'),
      ).toMatchObject({ session_id: null });
    } finally {
      second.close();
    }
  });

  it('clears usage and detaches requests even when the session row is absent', async () => {
    const db = await openDatabase(':memory:');
    try {
      new RequestRepository(db.client).put({
        id: 'e1',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 'ghost',
        input_tokens: 10,
        status: 'ok',
      });
      const sessions = new SessionRepository(db.client);
      expect(sessions.delete('ghost')).toBe(false);
      expect(new SessionModelUsageRepository(db.client).list()).toEqual([]);
      expect(db.client.prepare('SELECT count(*) AS n FROM usage_event_keys').get()).toMatchObject({
        n: 0,
      });
      expect(
        db.client.prepare('SELECT session_id FROM requests WHERE id=?').get('e1'),
      ).toMatchObject({ session_id: null });
    } finally {
      db.close();
    }
  });

  it('does not backfill requests whose session no longer exists', async () => {
    const file = join(await tempDir(), 'orphan.sqlite');
    const db = await openDatabase(file);
    try {
      const insertRequest = db.client.prepare(
        'INSERT INTO requests (id,ts,provider,model,session_id,input_tokens,output_tokens,status) VALUES (?,?,?,?,?,?,?,?)',
      );
      insertRequest.run(
        'ghost-request',
        '2026-01-01T00:00:00.000Z',
        'openai',
        'gpt-5',
        'deleted-session',
        10,
        2,
        'ok',
      );
      expect(backfillSessionModelUsage(db.client)).toBe(0);
      expect(
        new SessionModelUsageRepository(db.client).getBySession('deleted-session').rows,
      ).toEqual([]);
      expect(db.client.prepare('SELECT count(*) AS n FROM usage_event_keys').get()).toMatchObject({
        n: 0,
      });

      db.client
        .prepare('INSERT INTO sessions (id,data_json,updated_at) VALUES (?,?,?)')
        .run(
          'live-session',
          JSON.stringify(sessionFor('live-session')),
          '2026-01-01T00:00:00.000Z',
        );
      insertRequest.run(
        'live-request',
        '2026-01-01T00:00:01.000Z',
        'openai',
        'gpt-5',
        'live-session',
        3,
        1,
        'ok',
      );
      expect(backfillSessionModelUsage(db.client)).toBe(1);
      expect(
        new SessionModelUsageRepository(db.client).getBySession('live-session').totals.requests,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it('recomputes lastUsedAt from remaining ledger timestamps when the newest event moves', async () => {
    const db = await openDatabase(':memory:');
    try {
      const requests = new RequestRepository(db.client);
      const usage = new SessionModelUsageRepository(db.client);
      requests.put({
        id: 'e1',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'p',
        model: 'a',
        session_id: 's1',
        input_tokens: 5,
        status: 'ok',
      });
      requests.put({
        id: 'e2',
        ts: '2026-01-02T00:00:00.000Z',
        provider: 'p',
        model: 'a',
        session_id: 's1',
        input_tokens: 6,
        status: 'ok',
      });
      expect(usage.getBySession('s1').rows).toEqual([
        expect.objectContaining({
          modelRef: 'a',
          requests: 2,
          lastUsedAt: '2026-01-02T00:00:00.000Z',
        }),
      ]);
      requests.put({
        id: 'e2',
        ts: '2026-01-02T00:00:00.000Z',
        provider: 'p',
        model: 'b',
        session_id: 's1',
        input_tokens: 6,
        status: 'ok',
      });
      const moved = usage.getBySession('s1').rows;
      expect(moved.find((row) => row.modelRef === 'a')).toMatchObject({
        requests: 1,
        lastUsedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(moved.find((row) => row.modelRef === 'b')).toMatchObject({
        requests: 1,
        lastUsedAt: '2026-01-02T00:00:00.000Z',
      });
    } finally {
      db.close();
    }
  });

  it('recomputes lastUsedAt after retention deletes request detail', async () => {
    const db = await openDatabase(':memory:');
    try {
      const requests = new RequestRepository(db.client);
      const usage = new SessionModelUsageRepository(db.client);
      requests.put({
        id: 'e3',
        ts: '2020-01-01T00:00:00.000Z',
        provider: 'p',
        model: 'c',
        session_id: 's1',
        input_tokens: 1,
        output_tokens: 1,
        status: 'ok',
      });
      requests.put({
        id: 'e4',
        ts: '2020-01-02T00:00:00.000Z',
        provider: 'p',
        model: 'c',
        session_id: 's1',
        input_tokens: 2,
        output_tokens: 2,
        status: 'ok',
      });
      expect(runRetention(db.client, new Date('2021-01-01T00:00:00.000Z'))).toBe(2);
      expect(requests.list()).toHaveLength(0);
      expect(usage.getBySession('s1').rows).toEqual([
        expect.objectContaining({
          modelRef: 'c',
          requests: 2,
          lastUsedAt: '2020-01-02T00:00:00.000Z',
        }),
      ]);
      requests.put({
        id: 'e4',
        ts: '2020-01-02T00:00:00.000Z',
        provider: 'p',
        model: 'd',
        session_id: 's1',
        input_tokens: 2,
        output_tokens: 2,
        status: 'ok',
      });
      const moved = usage.getBySession('s1').rows;
      expect(moved.find((row) => row.modelRef === 'c')).toMatchObject({
        requests: 1,
        lastUsedAt: '2020-01-01T00:00:00.000Z',
      });
      expect(moved.find((row) => row.modelRef === 'd')).toMatchObject({
        requests: 1,
        lastUsedAt: '2020-01-02T00:00:00.000Z',
      });
    } finally {
      db.close();
    }
  });

  it('rolls back request, ledger and aggregate together when the ledger write fails', async () => {
    const db = await openDatabase(':memory:');
    try {
      const requests = new RequestRepository(db.client);
      requests.put({
        id: 'good',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 1,
        output_tokens: 1,
        status: 'ok',
      });
      db.client.exec(
        "CREATE TRIGGER fail_usage BEFORE INSERT ON usage_event_keys WHEN NEW.event_id = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END",
      );
      expect(() => {
        requests.put({
          id: 'boom',
          ts: '2026-01-01T00:00:01.000Z',
          provider: 'openai',
          model: 'gpt-5',
          session_id: 's1',
          input_tokens: 5,
          output_tokens: 5,
          status: 'ok',
        });
      }).toThrow();
      expect(db.client.prepare('SELECT count(*) AS n FROM requests').get()).toMatchObject({
        n: 1,
      });
      expect(db.client.prepare('SELECT id FROM requests WHERE id=?').get('boom')).toBeUndefined();
      expect(new SessionModelUsageRepository(db.client).getBySession('s1').totals).toMatchObject({
        requests: 1,
        inputTokens: 1,
        outputTokens: 1,
      });
      expect(db.client.prepare('SELECT count(*) AS n FROM usage_event_keys').get()).toMatchObject({
        n: 1,
      });
      expect(
        db.client.prepare('SELECT event_id FROM usage_event_keys WHERE event_id=?').get('boom'),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('returns an empty summary for an unknown session', async () => {
    const db = await openDatabase(':memory:');
    try {
      const usage = new SessionModelUsageRepository(db.client);
      expect(usage.getBySession('does-not-exist')).toEqual({
        sessionId: 'does-not-exist',
        rows: [],
        totals: {
          requests: 0,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          reasoningTokens: null,
          unreportedRequests: 0,
        },
        incomplete: false,
        backfilled: false,
        coverage: { since: null, unknown: false },
      });
    } finally {
      db.close();
    }
  });

  it('never stores headers or captured content in the aggregate or ledger', async () => {
    const db = await openDatabase(':memory:');
    try {
      new RequestRepository(db.client).put({
        id: 'e1',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        input_tokens: 10,
        status: 'ok',
        headers: { Authorization: 'Bearer sk-supersecretvalue' },
      });
      const aggregate = JSON.stringify(
        db.client.prepare('SELECT * FROM session_model_usage').all(),
      );
      const ledger = JSON.stringify(db.client.prepare('SELECT * FROM usage_event_keys').all());
      expect(aggregate).not.toContain('secret');
      expect(ledger).not.toContain('secret');
      const usageColumns = (
        db.client.pragma('table_info(session_model_usage)') as { name: string }[]
      ).map((column) => column.name);
      const ledgerColumns = (
        db.client.pragma('table_info(usage_event_keys)') as { name: string }[]
      ).map((column) => column.name);
      expect(usageColumns).not.toContain('headers_json');
      expect(ledgerColumns).not.toContain('headers_json');
      expect(usageColumns).not.toContain('content');
      expect(ledgerColumns).not.toContain('content');
      const indexes = db.client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_model_usage'",
        )
        .all() as { name: string }[];
      expect(indexes.map((index) => index.name)).toContain('session_model_usage_session_idx');
    } finally {
      db.close();
    }
  });

  it('migrates a v9 database losslessly and backfills its retained requests', async () => {
    const file = join(await tempDir(), 'v9.sqlite');
    const v9 = await openDatabase(file);
    v9.client.exec('DROP TABLE IF EXISTS session_model_usage');
    v9.client.exec('DROP TABLE IF EXISTS usage_event_keys');
    v9.client
      .prepare(
        'INSERT INTO requests (id,ts,provider,model,session_id,input_tokens,output_tokens,status) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run('legacy', '2026-01-01T00:00:00.000Z', 'openai', 'gpt-5', 's1', 10, 4, 'ok');
    v9.client
      .prepare('INSERT INTO sessions (id,data_json,updated_at) VALUES (?,?,?)')
      .run('s1', JSON.stringify(sessionFor('s1')), '2026-01-01T00:00:00.000Z');
    v9.client.pragma('user_version = 9');
    v9.close();

    const migrated = await openDatabase(file);
    try {
      expect(migrated.client.pragma('user_version', { simple: true })).toBe(STORAGE_SCHEMA_VERSION);
      expect(migrated.client.prepare('SELECT count(*) AS n FROM requests').get()).toMatchObject({
        n: 1,
      });
      expect(migrated.client.prepare('SELECT count(*) AS n FROM sessions').get()).toMatchObject({
        n: 1,
      });
      const usage = new SessionModelUsageRepository(migrated.client).getBySession('s1');
      expect(usage.totals).toEqual({
        requests: 1,
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: null,
        reasoningTokens: null,
        unreportedRequests: 0,
      });
      expect(
        migrated.client.prepare('SELECT count(*) AS n FROM usage_event_keys').get(),
      ).toMatchObject({ n: 1 });
      expect(usage.backfilled).toBe(true);
    } finally {
      migrated.close();
    }
  });

  it('keeps the same model on two connections/accounts as exact separate rows', async () => {
    const db = await openDatabase(':memory:');
    try {
      const requests = new RequestRepository(db.client);
      requests.put({
        id: 'acct-a',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        connection_id: 'conn-a',
        account_key: 'openai:aaaaaaaaaaaa',
        input_tokens: 10,
        output_tokens: 2,
        status: 'ok',
      });
      requests.put({
        id: 'acct-b',
        ts: '2026-01-01T00:00:05.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        connection_id: 'conn-b',
        account_key: 'openai:bbbbbbbbbbbb',
        input_tokens: 20,
        output_tokens: 4,
        status: 'ok',
      });
      const usage = new SessionModelUsageRepository(db.client).getBySession('s1');
      expect(usage.rows).toHaveLength(2);
      expect(usage.rows).toContainEqual(
        expect.objectContaining({
          modelRef: 'gpt-5',
          connectionId: 'conn-a',
          accountKey: 'openai:aaaaaaaaaaaa',
          requests: 1,
          inputTokens: 10,
          outputTokens: 2,
        }),
      );
      expect(usage.rows).toContainEqual(
        expect.objectContaining({
          modelRef: 'gpt-5',
          connectionId: 'conn-b',
          accountKey: 'openai:bbbbbbbbbbbb',
          requests: 1,
          inputTokens: 20,
          outputTokens: 4,
        }),
      );
      expect(usage.totals).toMatchObject({ requests: 2, inputTokens: 30, outputTokens: 6 });
    } finally {
      db.close();
    }
  });

  it('moves a replaced event to its new provenance without double counting', async () => {
    const db = await openDatabase(':memory:');
    try {
      const requests = new RequestRepository(db.client);
      requests.put({
        id: 'e1',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        connection_id: 'conn-a',
        account_key: 'openai:aaaaaaaaaaaa',
        input_tokens: 10,
        output_tokens: 2,
        status: 'ok',
      });
      requests.put({
        id: 'e1',
        ts: '2026-01-01T00:00:01.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        connection_id: 'conn-b',
        account_key: 'openai:bbbbbbbbbbbb',
        input_tokens: 7,
        output_tokens: 1,
        status: 'ok',
      });
      const usage = new SessionModelUsageRepository(db.client).getBySession('s1');
      expect(usage.rows).toEqual([
        expect.objectContaining({
          connectionId: 'conn-b',
          accountKey: 'openai:bbbbbbbbbbbb',
          requests: 1,
          inputTokens: 7,
          outputTokens: 1,
        }),
      ]);
      expect(usage.totals).toMatchObject({ requests: 1, inputTokens: 7, outputTokens: 1 });
    } finally {
      db.close();
    }
  });

  it('does not double count a retained request that overlaps a preserved legacy aggregate', async () => {
    const db = await openDatabase(':memory:');
    try {
      db.client
        .prepare('INSERT INTO sessions (id,data_json,updated_at) VALUES (?,?,?)')
        .run('s1', JSON.stringify(sessionFor('s1')), '2026-01-01T00:00:00.000Z');
      // A preserved legacy row (no ledger evidence) that may already include this usage.
      db.client
        .prepare(
          `INSERT INTO session_model_usage (session_id,model_ref,provider_id,connection_id,account_key,provenance_known,requests,input_tokens,output_tokens,input_reported,output_reported,unreported_requests,last_used_at)
           VALUES ('s1','gpt-5','','','',0,1,10,2,1,1,0,'2026-01-01T00:00:00.000Z')`,
        )
        .run();
      db.client
        .prepare(
          'INSERT INTO requests (id,ts,provider,model,session_id,input_tokens,output_tokens,status) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run('r1', '2026-01-01T00:00:00.000Z', 'openai', 'gpt-5', 's1', 10, 2, 'ok');
      expect(backfillSessionModelUsage(db.client)).toBe(0);
      const usage = new SessionModelUsageRepository(db.client).getBySession('s1');
      expect(usage.totals).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 2 });
      expect(usage.coverage.unknown).toBe(true);
    } finally {
      db.close();
    }
  });

  it('surfaces a real retained coverage start and certainty for live and backfilled origins', async () => {
    const db = await openDatabase(':memory:');
    try {
      const usage = new SessionModelUsageRepository(db.client);
      new RequestRepository(db.client).put({
        id: 'live',
        ts: '2026-03-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 'live-s',
        input_tokens: 1,
        output_tokens: 1,
        status: 'ok',
      });
      expect(usage.getBySession('live-s').coverage).toEqual({
        since: '2026-03-01T00:00:00.000Z',
        unknown: false,
      });
      db.client
        .prepare('INSERT INTO sessions (id,data_json,updated_at) VALUES (?,?,?)')
        .run('hist-s', JSON.stringify(sessionFor('hist-s')), '2026-01-01T00:00:00.000Z');
      db.client
        .prepare(
          'INSERT INTO requests (id,ts,provider,model,session_id,input_tokens,output_tokens,status) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run('hist', '2025-05-01T00:00:00.000Z', 'openai', 'gpt-5', 'hist-s', 2, 2, 'ok');
      expect(backfillSessionModelUsage(db.client)).toBe(1);
      expect(usage.getBySession('hist-s').coverage).toEqual({
        since: '2025-05-01T00:00:00.000Z',
        unknown: true,
      });
    } finally {
      db.close();
    }
  });

  it('upgrades a v10 database into exact provenance rows without double counting', async () => {
    const file = join(await tempDir(), 'v10.sqlite');
    const v10 = await openDatabase(file);
    v10.client.exec('DROP TABLE session_model_usage');
    v10.client.exec('DROP TABLE usage_event_keys');
    v10.client.exec(`CREATE TABLE session_model_usage (
      session_id TEXT NOT NULL, model_ref TEXT NOT NULL, provider_id TEXT, connection_id TEXT,
      account_key TEXT, requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0, input_reported INTEGER NOT NULL DEFAULT 0,
      output_reported INTEGER NOT NULL DEFAULT 0, cached_reported INTEGER NOT NULL DEFAULT 0,
      reasoning_reported INTEGER NOT NULL DEFAULT 0, unreported_requests INTEGER NOT NULL DEFAULT 0,
      backfilled INTEGER NOT NULL DEFAULT 0, last_used_at TEXT NOT NULL,
      PRIMARY KEY (session_id, model_ref))`);
    v10.client.exec(`CREATE TABLE usage_event_keys (
      event_id TEXT PRIMARY KEY, session_id TEXT, model_ref TEXT, provider_id TEXT,
      connection_id TEXT, account_key TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cached_tokens INTEGER, reasoning_tokens INTEGER, last_used_at TEXT NOT NULL)`);
    v10.client
      .prepare('INSERT INTO sessions (id,data_json,updated_at) VALUES (?,?,?)')
      .run('s1', JSON.stringify(sessionFor('s1')), '2026-01-01T00:00:00.000Z');
    // A coalesced legacy aggregate whose tokens actually came from two accounts.
    v10.client
      .prepare(
        'INSERT INTO session_model_usage (session_id,model_ref,provider_id,connection_id,account_key,requests,input_tokens,output_tokens,input_reported,output_reported,backfilled,last_used_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        's1',
        'gpt-5',
        'openai',
        'conn-1',
        'acct-1',
        2,
        30,
        6,
        2,
        2,
        0,
        '2026-01-02T00:00:00.000Z',
      );
    // A legacy aggregate with no ledger evidence (detail already expired).
    v10.client
      .prepare(
        'INSERT INTO session_model_usage (session_id,model_ref,provider_id,connection_id,account_key,requests,input_tokens,output_tokens,input_reported,output_reported,backfilled,last_used_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        's1',
        'legacy-model',
        'openai',
        null,
        'acct-9',
        1,
        5,
        1,
        1,
        1,
        1,
        '2025-12-01T00:00:00.000Z',
      );
    const insertLedger = v10.client.prepare(
      'INSERT INTO usage_event_keys (event_id,session_id,model_ref,provider_id,connection_id,account_key,input_tokens,output_tokens,last_used_at) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    insertLedger.run(
      'ev1',
      's1',
      'gpt-5',
      'openai',
      'conn-1',
      'acct-1',
      10,
      2,
      '2026-01-01T00:00:00.000Z',
    );
    insertLedger.run(
      'ev2',
      's1',
      'gpt-5',
      'openai',
      'conn-1',
      'acct-2',
      20,
      4,
      '2026-01-02T00:00:00.000Z',
    );
    v10.client.pragma('user_version = 10');
    v10.close();

    const migrated = await openDatabase(file);
    try {
      expect(migrated.client.pragma('user_version', { simple: true })).toBe(STORAGE_SCHEMA_VERSION);
      expect(
        migrated.client.prepare('SELECT count(*) AS n FROM usage_event_keys').get(),
      ).toMatchObject({
        n: 2,
      });
      const ledgerColumns = (
        migrated.client.pragma('table_info(usage_event_keys)') as { name: string }[]
      ).map((column) => column.name);
      expect(ledgerColumns).toContain('backfilled');
      const usage = new SessionModelUsageRepository(migrated.client).getBySession('s1');
      const gpt5 = usage.rows.filter((row) => row.modelRef === 'gpt-5');
      expect(gpt5).toHaveLength(2);
      expect(gpt5.find((row) => row.accountKey === 'acct-1')).toMatchObject({
        requests: 1,
        inputTokens: 10,
        outputTokens: 2,
      });
      expect(gpt5.find((row) => row.accountKey === 'acct-2')).toMatchObject({
        requests: 1,
        inputTokens: 20,
        outputTokens: 4,
      });
      expect(usage.rows.find((row) => row.modelRef === 'legacy-model')).toMatchObject({
        providerId: 'openai',
        accountKey: 'acct-9',
        requests: 1,
        inputTokens: 5,
        outputTokens: 1,
      });
      // The coalesced 30/6 count stays 30/6 (not doubled) and the legacy row's counts are retained.
      expect(usage.totals).toEqual({
        requests: 3,
        inputTokens: 35,
        outputTokens: 7,
        cachedTokens: null,
        reasoningTokens: null,
        unreportedRequests: 0,
      });
      expect(usage.coverage).toEqual({ since: '2026-01-01T00:00:00.000Z', unknown: true });
    } finally {
      migrated.close();
    }
  });

  it('rolls back a failed 0011 migration and leaves the prior state intact', async () => {
    const file = join(await tempDir(), 'rollback.sqlite');
    const seed = await openDatabase(file);
    new RequestRepository(seed.client).put({
      id: 'keep',
      ts: '2026-01-01T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: 's1',
      input_tokens: 10,
      output_tokens: 2,
      status: 'ok',
    });
    // Force migration 0011's table rebuild to fail with a name conflict.
    seed.client.exec('CREATE TABLE session_model_usage_v11 (x)');
    seed.client.pragma('user_version = 10');
    seed.close();

    await expect(openDatabase(file)).rejects.toThrow();

    const inspect = new Database(file, { readonly: true });
    try {
      expect(inspect.pragma('user_version', { simple: true })).toBe(10);
      expect(inspect.prepare('SELECT count(*) AS n FROM session_model_usage').get()).toMatchObject({
        n: 1,
      });
      expect(inspect.prepare('SELECT count(*) AS n FROM usage_event_keys').get()).toMatchObject({
        n: 1,
      });
    } finally {
      inspect.close();
    }
  });

  it('preserves a partially covered legacy aggregate with an honest unknown remainder', async () => {
    const file = join(await tempDir(), 'partial.sqlite');
    await seedV10Database(file, (client) => {
      insertSessionRow(client, 's1');
      insertLegacyAggregate(client, {
        sessionId: 's1',
        modelRef: 'gpt-5',
        providerId: 'openai',
        connectionId: 'conn-legacy',
        accountKey: 'acct-legacy',
        requests: 3,
        inputTokens: 30,
        outputTokens: 6,
        inputReported: 3,
        outputReported: 3,
        lastUsedAt: '2026-01-03T00:00:00.000Z',
      });
      insertLegacyLedger(client, {
        eventId: 'ev1',
        sessionId: 's1',
        modelRef: 'gpt-5',
        providerId: 'openai',
        connectionId: 'conn-ledger',
        accountKey: 'acct-ledger',
        inputTokens: 10,
        outputTokens: 2,
        lastUsedAt: '2026-01-02T00:00:00.000Z',
      });
    });

    const db = await openDatabase(file);
    try {
      const usage = new SessionModelUsageRepository(db.client).getBySession('s1');
      // The exactly-accounted ledger event keeps its real provenance.
      expect(usage.rows).toContainEqual(
        expect.objectContaining({
          providerId: 'openai',
          connectionId: 'conn-ledger',
          accountKey: 'acct-ledger',
          requests: 1,
          inputTokens: 10,
          outputTokens: 2,
        }),
      );
      // The unexplained remainder is preserved as unknown instead of invented into a split.
      expect(usage.rows).toContainEqual(
        expect.objectContaining({
          providerId: 'openai',
          connectionId: 'conn-legacy',
          accountKey: 'acct-legacy',
          requests: 2,
          inputTokens: 20,
          outputTokens: 4,
        }),
      );
      expect(
        db.client
          .prepare(
            "SELECT provenance_known AS p FROM session_model_usage WHERE connection_id='conn-legacy'",
          )
          .get(),
      ).toMatchObject({ p: 0 });
      expect(usage.totals).toEqual({
        requests: 3,
        inputTokens: 30,
        outputTokens: 6,
        cachedTokens: null,
        reasoningTokens: null,
        unreportedRequests: 0,
      });
      expect(usage.coverage.unknown).toBe(true);
    } finally {
      db.close();
    }
  });

  it('keeps a partial remainder and never re-folds its retained requests across reopen', async () => {
    const file = join(await tempDir(), 'partial-reopen.sqlite');
    await seedV10Database(file, (client) => {
      insertSessionRow(client, 's1');
      insertLegacyAggregate(client, {
        sessionId: 's1',
        modelRef: 'gpt-5',
        providerId: 'openai',
        connectionId: 'conn-legacy',
        accountKey: 'acct-legacy',
        requests: 3,
        inputTokens: 30,
        outputTokens: 6,
        inputReported: 3,
        outputReported: 3,
        lastUsedAt: '2026-01-03T00:00:00.000Z',
      });
      insertLegacyLedger(client, {
        eventId: 'ev1',
        sessionId: 's1',
        modelRef: 'gpt-5',
        providerId: 'openai',
        connectionId: 'conn-legacy',
        accountKey: 'acct-ledger',
        inputTokens: 10,
        outputTokens: 2,
        lastUsedAt: '2026-01-02T00:00:00.000Z',
      });
      // Retained detail for the covered event and for two requests already counted in the legacy
      // aggregate; none of it may be folded again.
      const insertRequest = client.prepare(
        'INSERT INTO requests (id,ts,provider,model,session_id,input_tokens,output_tokens,status) VALUES (?,?,?,?,?,?,?,?)',
      );
      insertRequest.run('ev1', '2026-01-02T00:00:00.000Z', 'openai', 'gpt-5', 's1', 10, 2, 'ok');
      insertRequest.run('r2', '2026-01-02T01:00:00.000Z', 'openai', 'gpt-5', 's1', 10, 2, 'ok');
      insertRequest.run('r3', '2026-01-02T02:00:00.000Z', 'openai', 'gpt-5', 's1', 10, 2, 'ok');
    });

    const first = await openDatabase(file);
    const firstTotals = new SessionModelUsageRepository(first.client).getBySession('s1').totals;
    expect(firstTotals).toEqual({
      requests: 3,
      inputTokens: 30,
      outputTokens: 6,
      cachedTokens: null,
      reasoningTokens: null,
      unreportedRequests: 0,
    });
    first.close();

    const second = await openDatabase(file);
    try {
      const usage = new SessionModelUsageRepository(second.client).getBySession('s1');
      expect(usage.totals).toEqual(firstTotals);
      // No double count: the retained requests that the legacy totals already cover stay skipped.
      expect(backfillSessionModelUsage(second.client)).toBe(0);
    } finally {
      second.close();
    }
  });

  it('keeps unreported legacy dimensions null and a reported zero as zero on upgrade', async () => {
    const file = join(await tempDir(), 'zeros.sqlite');
    await seedV10Database(file, (client) => {
      insertSessionRow(client, 's1');
      // Never reported input/output: the stored legacy columns stay 0 but must read back as null.
      insertLegacyAggregate(client, {
        sessionId: 's1',
        modelRef: 'never-reported',
        providerId: 'openai',
        requests: 2,
        inputTokens: 0,
        outputTokens: 0,
        inputReported: 0,
        outputReported: 0,
        unreportedRequests: 2,
      });
      // A genuinely reported zero must survive as 0, not become null.
      insertLegacyAggregate(client, {
        sessionId: 's1',
        modelRef: 'reported-zero',
        providerId: 'openai',
        requests: 1,
        inputTokens: 0,
        outputTokens: 0,
        inputReported: 1,
        outputReported: 1,
      });
    });

    const db = await openDatabase(file);
    try {
      const usage = new SessionModelUsageRepository(db.client).getBySession('s1');
      expect(usage.rows.find((row) => row.modelRef === 'never-reported')).toMatchObject({
        requests: 2,
        inputTokens: null,
        outputTokens: null,
        unreportedRequests: 2,
      });
      expect(usage.rows.find((row) => row.modelRef === 'reported-zero')).toMatchObject({
        requests: 1,
        inputTokens: 0,
        outputTokens: 0,
      });
    } finally {
      db.close();
    }
  });

  it('does not resurrect a deleted conversation from an orphan ledger event on upgrade or reopen', async () => {
    const file = join(await tempDir(), 'orphan-ledger.sqlite');
    await seedV10Database(file, (client) => {
      insertSessionRow(client, 'live');
      insertLegacyLedger(client, {
        eventId: 'ev-live',
        sessionId: 'live',
        modelRef: 'gpt-5',
        providerId: 'openai',
        inputTokens: 4,
        outputTokens: 1,
      });
      // A ledger event whose session row was removed independently (no live conversation remains).
      insertLegacyLedger(client, {
        eventId: 'ev-orphan',
        sessionId: 'gone',
        modelRef: 'gpt-5',
        providerId: 'openai',
        inputTokens: 9,
        outputTokens: 9,
      });
    });

    const first = await openDatabase(file);
    expect(new SessionModelUsageRepository(first.client).getBySession('live').totals.requests).toBe(
      1,
    );
    expect(
      new SessionModelUsageRepository(first.client).list().some((row) => row.sessionId === 'gone'),
    ).toBe(false);
    first.close();

    const second = await openDatabase(file);
    try {
      expect(
        second.client
          .prepare("SELECT count(*) AS n FROM session_model_usage WHERE session_id='gone'")
          .get(),
      ).toMatchObject({ n: 0 });
    } finally {
      second.close();
    }
  });

  it('updates a covered event and adds a new one under partial coverage without touching the remainder', async () => {
    const db = await openDatabase(':memory:');
    try {
      insertSessionRow(db.client, 's1');
      const requests = new RequestRepository(db.client);
      requests.put({
        id: 'ev1',
        ts: '2026-01-02T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        connection_id: 'conn-ledger',
        account_key: 'acct-ledger',
        input_tokens: 10,
        output_tokens: 2,
        status: 'ok',
      });
      // An unknown-provenance remainder for the same model, as a partial migration would leave.
      db.client
        .prepare(
          `INSERT INTO session_model_usage (session_id,model_ref,provider_id,connection_id,account_key,provenance_known,requests,input_tokens,output_tokens,input_reported,output_reported,unreported_requests,last_used_at)
           VALUES ('s1','gpt-5','openai','conn-legacy','acct-legacy',0,2,20,4,2,2,0,'2026-01-01T00:00:00.000Z')`,
        )
        .run();
      const usage = new SessionModelUsageRepository(db.client);

      requests.put({
        id: 'ev1',
        ts: '2026-01-02T00:00:01.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        connection_id: 'conn-ledger',
        account_key: 'acct-ledger',
        input_tokens: 15,
        output_tokens: 3,
        status: 'ok',
      });
      expect(usage.getBySession('s1').totals).toMatchObject({
        requests: 3,
        inputTokens: 35,
        outputTokens: 7,
      });

      requests.put({
        id: 'ev2',
        ts: '2026-01-03T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        connection_id: 'conn-new',
        account_key: 'acct-new',
        input_tokens: 5,
        output_tokens: 1,
        status: 'ok',
      });
      const summary = usage.getBySession('s1');
      expect(summary.totals).toMatchObject({ requests: 4, inputTokens: 40, outputTokens: 8 });
      expect(summary.rows.find((row) => row.connectionId === 'conn-legacy')).toMatchObject({
        requests: 2,
        inputTokens: 20,
        outputTokens: 4,
      });
    } finally {
      db.close();
    }
  });

  it('refuses a v10 upgrade when the ledger cannot reconcile with the legacy aggregate', async () => {
    const file = join(await tempDir(), 'irreconcilable.sqlite');
    await seedV10Database(file, (client) => {
      insertSessionRow(client, 's1');
      insertLegacyAggregate(client, {
        sessionId: 's1',
        modelRef: 'gpt-5',
        providerId: 'openai',
        requests: 1,
        inputTokens: 5,
        outputTokens: 1,
        inputReported: 1,
        outputReported: 1,
      });
      insertLegacyLedger(client, {
        eventId: 'ev1',
        sessionId: 's1',
        modelRef: 'gpt-5',
        providerId: 'openai',
        inputTokens: 4,
        outputTokens: 1,
      });
      insertLegacyLedger(client, {
        eventId: 'ev2',
        sessionId: 's1',
        modelRef: 'gpt-5',
        providerId: 'openai',
        inputTokens: 4,
        outputTokens: 1,
        lastUsedAt: '2026-01-02T00:00:00.000Z',
      });
    });

    await expect(openDatabase(file)).rejects.toMatchObject({ kind: 'migration_integrity' });

    const inspect = new Database(file, { readonly: true });
    try {
      expect(inspect.pragma('user_version', { simple: true })).toBe(10);
      expect(inspect.prepare('SELECT count(*) AS n FROM session_model_usage').get()).toMatchObject({
        n: 1,
      });
      expect(inspect.prepare('SELECT count(*) AS n FROM usage_event_keys').get()).toMatchObject({
        n: 2,
      });
    } finally {
      inspect.close();
    }
  });

  it('never re-folds a retained un-ledgered request that a legacy residual already covers', async () => {
    const file = join(await tempDir(), 'residual-reput.sqlite');
    await seedV10Database(file, (client) => {
      insertSessionRow(client, 's1');
      // Partially covered: two legacy requests, only one retained in the ledger.
      insertLegacyAggregate(client, {
        sessionId: 's1',
        modelRef: 'gpt-5',
        providerId: 'openai',
        connectionId: 'conn-legacy',
        accountKey: 'acct-legacy',
        requests: 2,
        inputTokens: 20,
        outputTokens: 4,
        inputReported: 2,
        outputReported: 2,
        lastUsedAt: '2020-01-03T00:00:00.000Z',
      });
      insertLegacyLedger(client, {
        eventId: 'ev1',
        sessionId: 's1',
        modelRef: 'gpt-5',
        providerId: 'openai',
        connectionId: 'conn-ledger',
        accountKey: 'acct-ledger',
        inputTokens: 10,
        outputTokens: 2,
        lastUsedAt: '2020-01-02T00:00:00.000Z',
      });
      // The un-ledgered historical request the residual represents.
      client
        .prepare(
          'INSERT INTO requests (id,ts,provider,model,session_id,connection_id,account_key,input_tokens,output_tokens,status) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          'r2',
          '2020-01-03T00:00:00.000Z',
          'openai',
          'gpt-5',
          's1',
          'conn-legacy',
          'acct-legacy',
          10,
          2,
          'ok',
        );
    });

    const lifetime = {
      requests: 2,
      inputTokens: 20,
      outputTokens: 4,
      cachedTokens: null,
      reasoningTokens: null,
      unreportedRequests: 0,
    };
    const reput = (client: Database.Database, input: number, output: number): void => {
      new RequestRepository(client).put({
        id: 'r2',
        ts: '2020-01-03T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        connection_id: 'conn-new',
        account_key: 'acct-new',
        input_tokens: input,
        output_tokens: output,
        cost_usd: 0.5,
        status: 'ok',
      });
    };

    const first = await openDatabase(file);
    const usage = new SessionModelUsageRepository(first.client);
    expect(usage.getBySession('s1').totals).toEqual(lifetime);
    expect(usage.getBySession('s1').coverage.unknown).toBe(true);

    // Re-record the same id with changed client metadata and cumulative tokens: the detail row is
    // updated, but the unknown residual totals and coverage are preserved.
    reput(first.client, 15, 3);
    expect(usage.getBySession('s1').totals).toEqual(lifetime);
    expect(
      first.client
        .prepare(
          'SELECT connection_id AS connectionId, account_key AS accountKey, input_tokens AS inputTokens, output_tokens AS outputTokens FROM requests WHERE id=?',
        )
        .get('r2'),
    ).toMatchObject({
      connectionId: 'conn-new',
      accountKey: 'acct-new',
      inputTokens: 15,
      outputTokens: 3,
    });
    // No fabricated per-event group or rewritten account total.
    expect(
      usage
        .getBySession('s1')
        .rows.some((row) => row.connectionId === 'conn-new' || row.accountKey === 'acct-new'),
    ).toBe(false);

    // Repeats stay flat.
    reput(first.client, 15, 3);
    expect(usage.getBySession('s1').totals).toEqual(lifetime);
    first.close();

    // Reopen re-runs backfill: the retained request is still recognised as already accounted for.
    const reopened = await openDatabase(file);
    const reopenedUsage = new SessionModelUsageRepository(reopened.client);
    try {
      expect(reopenedUsage.getBySession('s1').totals).toEqual(lifetime);
      expect(backfillSessionModelUsage(reopened.client)).toBe(0);
      expect(reopenedUsage.getBySession('s1').coverage.unknown).toBe(true);
      // Retention pruning detail never increases or fabricates lifetime usage.
      runRetention(reopened.client, new Date('2021-01-01T00:00:00.000Z'));
      expect(reopenedUsage.getBySession('s1').totals).toEqual(lifetime);
      expect(
        reopenedUsage
          .getBySession('s1')
          .rows.some((row) => row.connectionId === 'conn-new' || row.accountKey === 'acct-new'),
      ).toBe(false);

      // A genuinely new id after the update is counted exactly once under its own provenance.
      new RequestRepository(reopened.client).put({
        id: 'r3',
        ts: '2020-01-04T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        connection_id: 'conn-new',
        account_key: 'acct-new',
        input_tokens: 5,
        output_tokens: 1,
        status: 'ok',
      });
      const withNew = reopenedUsage.getBySession('s1');
      expect(withNew.totals).toMatchObject({ requests: 3, inputTokens: 25, outputTokens: 5 });
      expect(withNew.rows.filter((row) => row.connectionId === 'conn-new')).toHaveLength(1);

      // Updating the covered ledger event corrects its snapshot exactly instead of duplicating it.
      new RequestRepository(reopened.client).put({
        id: 'ev1',
        ts: '2020-01-02T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 's1',
        connection_id: 'conn-ledger',
        account_key: 'acct-ledger',
        input_tokens: 12,
        output_tokens: 2,
        status: 'ok',
      });
      const corrected = reopenedUsage.getBySession('s1');
      expect(corrected.totals).toMatchObject({ requests: 3, inputTokens: 27, outputTokens: 5 });
      expect(corrected.rows.filter((row) => row.connectionId === 'conn-ledger')).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});
