import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
