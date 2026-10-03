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
} from '../src/index.js';

const dirs: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('@ferry/storage', () => {
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
