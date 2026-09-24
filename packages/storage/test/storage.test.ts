import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileIdSchema, SessionIdSchema, WorkspaceIdSchema } from '@ferry/shared';
import { openDatabase, runRetention, RequestRepository, SessionRepository } from '../src/index.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('@ferry/storage', () => {
  it('migrates an empty database, round-trips shared aggregates and tolerates concurrent inserts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ferry-db-'));
    dirs.push(dir);
    const db = await openDatabase(join(dir, 'ferry.sqlite'));
    try {
      expect(db.client.pragma('user_version', { simple: true })).toBe(1);
      const repo = new SessionRepository(db.client);
      const session = {
        id: 's1',
        workspaceId: WorkspaceIdSchema.parse('w1'),
        title: 'test',
        preview: '',
        profileId: ProfileIdSchema.parse('default'),
        modelRef: null,
        starred: false,
        pinned: false,
        status: 'idle' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
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
