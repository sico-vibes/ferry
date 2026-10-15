import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelRefSchema,
  ProfileIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  WorkspaceIdSchema,
  type Session,
  type UsageRecord,
} from '@ferry/shared';
import {
  openDatabase,
  QuotaObservationRepository,
  RequestRepository,
  runRetention,
  SessionModelUsageRepository,
  SessionRepository,
} from '@ferry/storage';
import {
  QuotaEngine,
  REQUESTED_MODEL_REF_HEADER,
  sanitizeAccountKey,
  sanitizeConnectionId,
  sanitizeRequestedModelRef,
} from '../src/engine.js';

vi.setConfig({ testTimeout: 30_000 });

const PROVIDER = ProviderIdSchema.parse('opencode-cli');
const ACTUAL_REF = ModelRefSchema.parse('opencode-cli/opencode-go/deepseek-v4.1-flash');
const REQUESTED_REF = ModelRefSchema.parse('gateway/key-requested');
const ACCOUNT_A = 'opencode-cli:aaaaaaaaaaaaaaaaaaaaaaaa';
const ACCOUNT_B = 'opencode-cli:bbbbbbbbbbbbbbbbbbbbbbbb';

const provider = {
  provider: 'opencode-cli',
  name: 'OpenCode CLI',
  tag: 'legit' as const,
  signup_url: null,
  docs_url: null,
  terms_note: '',
  data_use: '',
  verified_at: '2026-01-01',
  source_url: 'https://example.com',
  windows: [
    {
      scope: 'provider' as const,
      metric: 'requests' as const,
      kind: 'fixed_daily' as const,
      tz: 'UTC',
      limit: 50,
    },
  ],
};

const dirs: string[] = [];
async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ferry-quota-attribution-'));
  dirs.push(dir);
  return join(dir, name);
}
afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })),
  );
});

function engineFor(db: Awaited<ReturnType<typeof openDatabase>>): QuotaEngine {
  return new QuotaEngine({
    requestRepository: new RequestRepository(db.client),
    observationRepository: new QuotaObservationRepository(db.client),
    now: () => new Date('2026-06-01T10:00:00Z'),
    catalog: { providers: [provider], models: [] },
  });
}

function usage(id: string, extra: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id,
    providerId: PROVIDER,
    modelRef: ACTUAL_REF,
    occurredAt: '2026-06-01T09:00:00.000Z',
    status: 'success',
    ...extra,
  };
}

function sessionFor(id: string): Session {
  const now = new Date().toISOString();
  return {
    archived: false,
    id: SessionIdSchema.parse(id),
    workspaceId: WorkspaceIdSchema.parse('w1'),
    title: 'attribution',
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

describe('QuotaEngine usage attribution', () => {
  it('sanitizes opaque account keys and logical model refs at the boundary', () => {
    expect(sanitizeAccountKey(ACCOUNT_A)).toBe(ACCOUNT_A);
    expect(sanitizeAccountKey('sk-live-supersecretvalue')).toBeNull();
    expect(sanitizeAccountKey('opencode-cli:NOTHEX')).toBeNull();
    expect(sanitizeAccountKey(undefined)).toBeNull();
    expect(sanitizeConnectionId('opencode-cli')).toBe('opencode-cli');
    expect(sanitizeConnectionId('')).toBeNull();
    expect(sanitizeConnectionId(undefined)).toBeNull();
    expect(sanitizeRequestedModelRef(REQUESTED_REF)).toBe(REQUESTED_REF);
    expect(sanitizeRequestedModelRef('auto')).toBeNull();
  });

  it('keeps CLI producer attribution and the requested alias across restart', async () => {
    const db = await openDatabase(await tempFile('attribution.sqlite'));
    const first = engineFor(db);
    first.recordUsage(
      usage('u1', {
        sessionId: 's1',
        connectionId: 'opencode-cli',
        accountKey: ACCOUNT_A,
        requestedModelRef: REQUESTED_REF,
        inputTokens: 10,
        outputTokens: 4,
        stepKind: 'edit',
      }),
    );
    expect(first.queryUsage({ providerId: PROVIDER })[0]).toMatchObject({
      id: 'u1',
      modelRef: ACTUAL_REF,
      connectionId: 'opencode-cli',
      accountKey: ACCOUNT_A,
      requestedModelRef: REQUESTED_REF,
    });
    // The durable request row carries the exact attribution and the namespaced requested alias.
    const row = db.client
      .prepare('SELECT connection_id, account_key, headers_json FROM requests WHERE id=?')
      .get('u1') as {
      connection_id: string | null;
      account_key: string | null;
      headers_json: string;
    };
    expect(row.connection_id).toBe('opencode-cli');
    expect(row.account_key).toBe(ACCOUNT_A);
    expect(JSON.parse(row.headers_json)).toMatchObject({
      [REQUESTED_MODEL_REF_HEADER]: REQUESTED_REF,
    });
    const aggregate = new SessionModelUsageRepository(db.client).getBySession('s1');
    expect(aggregate.rows).toEqual([
      expect.objectContaining({
        modelRef: ACTUAL_REF,
        providerId: 'opencode-cli',
        connectionId: 'opencode-cli',
        accountKey: ACCOUNT_A,
        requests: 1,
        inputTokens: 10,
        outputTokens: 4,
      }),
    ]);

    const restarted = engineFor(db);
    const reloaded = restarted.queryUsage({ providerId: PROVIDER })[0];
    expect(reloaded).toMatchObject({
      id: 'u1',
      modelRef: ACTUAL_REF,
      connectionId: 'opencode-cli',
      accountKey: ACCOUNT_A,
      requestedModelRef: REQUESTED_REF,
      inputTokens: 10,
      outputTokens: 4,
    });
    first.dispose();
    restarted.dispose();
    db.close();
  });

  it('preserves NULL-vs-0 token dimensions and cache/reason exactly across restart', async () => {
    const db = await openDatabase(await tempFile('dimensions.sqlite'));
    const first = engineFor(db);
    // A reported zero stays 0; an omitted dimension stays absent (never fabricated as 0).
    first.recordUsage(
      usage('zero', {
        sessionId: 's-zero',
        inputTokens: 0,
        outputTokens: 0,
      }),
    );
    first.recordUsage(
      usage('missing', {
        sessionId: 's-missing',
        inputTokens: 5,
      }),
    );
    first.dispose();

    const restarted = engineFor(db);
    const zero = restarted.queryUsage({ sessionId: 's-zero' })[0];
    expect(zero).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(zero?.cachedTokens).toBeUndefined();
    expect(zero?.reasoningTokens).toBeUndefined();
    const missing = restarted.queryUsage({ sessionId: 's-missing' })[0];
    expect(missing).toMatchObject({ inputTokens: 5 });
    expect(missing?.outputTokens).toBeUndefined();

    const stored = db.client
      .prepare('SELECT input_tokens, output_tokens, cached_tokens FROM requests WHERE id=?')
      .get('zero') as {
      input_tokens: number | null;
      output_tokens: number | null;
      cached_tokens: number | null;
    };
    expect(stored).toEqual({ input_tokens: 0, output_tokens: 0, cached_tokens: null });

    const usageRepo = new SessionModelUsageRepository(db.client);
    expect(usageRepo.getBySession('s-zero').rows[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: null,
      reasoningTokens: null,
      unreportedRequests: 0,
    });
    expect(usageRepo.getBySession('s-missing').rows[0]).toMatchObject({
      inputTokens: 5,
      outputTokens: null,
      incomplete: true,
    });
    restarted.dispose();
    db.close();
  });

  it('drops malformed account metadata instead of persisting a raw secret', async () => {
    const db = await openDatabase(await tempFile('secret.sqlite'));
    const engine = engineFor(db);
    engine.recordUsage(
      usage('bad-account', {
        sessionId: 's-secret',
        connectionId: 'opencode-cli',
        accountKey: 'sk-live-supersecretvalue',
        inputTokens: 3,
        outputTokens: 1,
      }),
    );
    const row = db.client
      .prepare('SELECT connection_id, account_key, headers_json FROM requests WHERE id=?')
      .get('bad-account') as {
      connection_id: string | null;
      account_key: string | null;
      headers_json: string | null;
    };
    expect(row.connection_id).toBe('opencode-cli');
    expect(row.account_key).toBeNull();
    expect(JSON.stringify(row)).not.toContain('supersecret');
    expect(engine.queryUsage({ sessionId: 's-secret' })[0]?.accountKey).toBeNull();
    const aggregate = new SessionModelUsageRepository(db.client).getBySession('s-secret');
    expect(aggregate.rows[0]?.accountKey).toBeNull();
    expect(JSON.stringify(aggregate)).not.toContain('supersecret');
    engine.dispose();
    db.close();
  });

  it('keeps API usage without CLI provenance as unknown across restart', async () => {
    const db = await openDatabase(await tempFile('unknown.sqlite'));
    const first = engineFor(db);
    first.recordUsage(
      usage('api-only', {
        sessionId: 's-api',
        inputTokens: 8,
        outputTokens: 2,
      }),
    );
    first.dispose();

    const restarted = engineFor(db);
    const reloaded = restarted.queryUsage({ sessionId: 's-api' })[0];
    expect(reloaded?.connectionId).toBeNull();
    expect(reloaded?.accountKey).toBeNull();
    expect(reloaded?.requestedModelRef).toBeUndefined();
    const row = db.client
      .prepare('SELECT connection_id, account_key, headers_json FROM requests WHERE id=?')
      .get('api-only') as {
      connection_id: string | null;
      account_key: string | null;
      headers_json: string | null;
    };
    expect(row).toEqual({ connection_id: null, account_key: null, headers_json: null });
    expect(new SessionModelUsageRepository(db.client).getBySession('s-api').rows[0]).toMatchObject({
      connectionId: null,
      accountKey: null,
      requests: 1,
    });
    restarted.dispose();
    db.close();
  });

  it('moves a re-recorded event to its new provenance without double counting', async () => {
    const db = await openDatabase(await tempFile('dedupe.sqlite'));
    const engine = engineFor(db);
    engine.recordUsage(
      usage('e1', {
        sessionId: 's-dedupe',
        connectionId: 'conn-a',
        accountKey: ACCOUNT_A,
        inputTokens: 10,
        outputTokens: 2,
      }),
    );
    engine.recordUsage(
      usage('e1', {
        sessionId: 's-dedupe',
        connectionId: 'conn-b',
        accountKey: ACCOUNT_B,
        inputTokens: 7,
        outputTokens: 1,
      }),
    );
    const usageRepo = new SessionModelUsageRepository(db.client);
    expect(usageRepo.getBySession('s-dedupe').rows).toEqual([
      expect.objectContaining({
        connectionId: 'conn-b',
        accountKey: ACCOUNT_B,
        requests: 1,
        inputTokens: 7,
        outputTokens: 1,
      }),
    ]);
    engine.dispose();

    // Re-recording the same event after restart stays idempotent.
    const restarted = engineFor(db);
    restarted.recordUsage(
      usage('e1', {
        sessionId: 's-dedupe',
        connectionId: 'conn-b',
        accountKey: ACCOUNT_B,
        inputTokens: 7,
        outputTokens: 1,
      }),
    );
    expect(usageRepo.getBySession('s-dedupe').totals).toMatchObject({
      requests: 1,
      inputTokens: 7,
      outputTokens: 1,
    });
    restarted.dispose();
    db.close();
  });

  it('keeps the conversation aggregate after detail retention', async () => {
    const db = await openDatabase(await tempFile('retention.sqlite'));
    new SessionRepository(db.client).put(sessionFor('s-retain'));
    const engine = engineFor(db);
    engine.recordUsage(
      usage('old', {
        sessionId: 's-retain',
        connectionId: 'opencode-cli',
        accountKey: ACCOUNT_A,
        occurredAt: '2020-01-02T10:00:00.000Z',
        inputTokens: 10,
        outputTokens: 4,
      }),
    );
    const usageRepo = new SessionModelUsageRepository(db.client);
    expect(usageRepo.getBySession('s-retain').totals).toMatchObject({
      requests: 1,
      inputTokens: 10,
      outputTokens: 4,
    });
    // Retention removes the request detail but keeps the durable aggregate and ledger.
    expect(runRetention(db.client, new Date('2020-02-01T00:00:00.000Z'))).toBe(1);
    engine.dispose();
    const afterRetention = engineFor(db);
    expect(afterRetention.queryUsage({ sessionId: 's-retain' })).toHaveLength(0);
    expect(usageRepo.getBySession('s-retain').totals).toMatchObject({
      requests: 1,
      inputTokens: 10,
      outputTokens: 4,
    });
    afterRetention.dispose();
    db.close();
  });

  it('prevents a deleted conversation from resurrecting across reopen', async () => {
    const file = await tempFile('delete.sqlite');
    const db = await openDatabase(file);
    const sessions = new SessionRepository(db.client);
    sessions.put(sessionFor('s-gone'));
    const engine = engineFor(db);
    engine.recordUsage(
      usage('live', {
        sessionId: 's-gone',
        connectionId: 'opencode-cli',
        accountKey: ACCOUNT_A,
        inputTokens: 6,
        outputTokens: 3,
      }),
    );
    expect(new SessionModelUsageRepository(db.client).getBySession('s-gone').totals.requests).toBe(
      1,
    );
    expect(sessions.delete('s-gone')).toBe(true);
    engine.dispose();
    db.close();

    const reopened = await openDatabase(file);
    try {
      expect(new SessionModelUsageRepository(reopened.client).getBySession('s-gone').rows).toEqual(
        [],
      );
      expect(
        reopened.client.prepare('SELECT count(*) AS n FROM usage_event_keys').get(),
      ).toMatchObject({ n: 0 });
      // The retained request is detached, so it can never be backfilled into a resurrected aggregate.
      expect(
        reopened.client.prepare('SELECT session_id FROM requests WHERE id=?').get('live'),
      ).toMatchObject({ session_id: null });
    } finally {
      reopened.close();
    }
  });
});
