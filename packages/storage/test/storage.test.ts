import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileIdSchema, SessionIdSchema, WorkspaceIdSchema } from '@ferry/shared';
import {
  openDatabase,
  runRetention,
  RequestRepository,
  SessionRepository,
  STORAGE_SCHEMA_VERSION,
} from '../src/index.js';

const dirs: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('@ferry/storage', () => {
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
