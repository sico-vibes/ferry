import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileIdSchema, SessionIdSchema, WorkspaceIdSchema } from '@ferry/shared';
import type { Session } from '@ferry/shared';
import {
  openDatabase,
  ProviderKeyEntryRepository,
  ProviderKeyRepository,
  RequestRepository,
  SessionRepository,
  SettingsRepository,
} from '../src/index.js';

const dirs: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ferry-blob-delete-'));
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
    title: 'blobs',
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

/** Mirrors the persisted Core recovery-blob shape for a session-attributed tool output. */
function recoveryBlob(id: string, sessionId: string): string {
  return JSON.stringify({
    id,
    sessionId,
    workspaceId: 'w1',
    sourcePath: 'src/generated.ts',
    command: 'pnpm test',
    content: `full tool output for ${id}`,
  });
}

function rawBlob(client: Database.Database, id: string, dataJson: string): void {
  client
    .prepare('INSERT INTO optimizer_blobs (id,data_json,updated_at) VALUES (?,?,?)')
    .run(id, dataJson, '2026-01-01T00:00:00.000Z');
}

function blobIds(client: Database.Database): string[] {
  return (
    client.prepare('SELECT id FROM optimizer_blobs ORDER BY id').all() as { id: string }[]
  ).map(({ id }) => id);
}

describe('SessionRepository.delete recovery-blob scope', () => {
  it('removes only the deleted session recovery blobs and preserves every other invariant', async () => {
    const file = join(await tempDir(), 'delete-scope.sqlite');
    const first = await openDatabase(file);
    const sessions = new SessionRepository(first.client);
    const requests = new RequestRepository(first.client);
    const settings = new SettingsRepository(first.client);
    const providerKeys = new ProviderKeyRepository(first.client);
    const keyEntries = new ProviderKeyEntryRepository(first.client);

    sessions.put(sessionFor('sesA'));
    sessions.put(sessionFor('sesB'));

    for (const id of ['blob_a1', 'blob_a2']) rawBlob(first.client, id, recoveryBlob(id, 'sesA'));
    for (const id of ['blob_b1', 'blob_b2']) rawBlob(first.client, id, recoveryBlob(id, 'sesB'));
    rawBlob(first.client, 'blob_corrupt', '{not valid json');
    rawBlob(first.client, 'blob_legacy', JSON.stringify({ id: 'blob_legacy', content: 'legacy' }));
    rawBlob(
      first.client,
      'blob_workspace',
      JSON.stringify({ id: 'blob_workspace', workspaceId: 'w1', content: 'shared' }),
    );
    rawBlob(
      first.client,
      'blob_null_session',
      JSON.stringify({ id: 'blob_null_session', sessionId: null, content: 'unattributed' }),
    );

    requests.put({
      id: 'req_a',
      ts: '2026-01-01T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: 'sesA',
      input_tokens: 10,
      output_tokens: 2,
      status: 'ok',
    });
    requests.put({
      id: 'req_b',
      ts: '2026-01-01T00:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5',
      session_id: 'sesB',
      input_tokens: 4,
      output_tokens: 1,
      status: 'ok',
    });
    settings.put('theme', 'dark');
    providerKeys.put({
      id: 'openai',
      providerId: 'openai',
      keyringRef: 'openai',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    keyEntries.put({
      id: 'openai:1',
      providerId: 'openai',
      keyId: '1',
      label: 'Key 1',
      position: 0,
      enabled: true,
      status: 'ok',
      lastError: null,
      cooldownUntil: null,
      keyringRef: 'openai',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(sessions.delete('sesA')).toBe(true);
    first.close();

    const second = await openDatabase(file);
    try {
      expect(blobIds(second.client)).toEqual([
        'blob_b1',
        'blob_b2',
        'blob_corrupt',
        'blob_legacy',
        'blob_null_session',
        'blob_workspace',
      ]);
      const bBlob = second.client
        .prepare('SELECT data_json FROM optimizer_blobs WHERE id=?')
        .get('blob_b1') as { data_json: string };
      expect(JSON.parse(bBlob.data_json)).toMatchObject({
        id: 'blob_b1',
        sessionId: 'sesB',
        content: 'full tool output for blob_b1',
      });

      expect(
        second.client
          .prepare('SELECT count(*) AS n FROM usage_event_keys WHERE session_id=?')
          .get('sesA'),
      ).toMatchObject({ n: 0 });
      expect(
        second.client
          .prepare('SELECT count(*) AS n FROM usage_event_keys WHERE session_id=?')
          .get('sesB'),
      ).toMatchObject({ n: 1 });
      expect(
        second.client
          .prepare('SELECT count(*) AS n FROM session_model_usage WHERE session_id=?')
          .get('sesA'),
      ).toMatchObject({ n: 0 });
      expect(
        second.client
          .prepare('SELECT count(*) AS n FROM session_model_usage WHERE session_id=?')
          .get('sesB'),
      ).toMatchObject({ n: 1 });

      expect(
        second.client.prepare('SELECT session_id FROM requests WHERE id=?').get('req_a'),
      ).toMatchObject({ session_id: null });
      expect(
        second.client.prepare('SELECT session_id FROM requests WHERE id=?').get('req_b'),
      ).toMatchObject({ session_id: 'sesB' });

      expect(new SettingsRepository(second.client).get('theme')).toBe('dark');
      expect(new ProviderKeyRepository(second.client).get('openai')?.keyringRef).toBe('openai');
      expect(
        new ProviderKeyEntryRepository(second.client).list('openai').map(({ keyId }) => keyId),
      ).toEqual(['1']);
    } finally {
      second.close();
    }
  });

  it('does not crash on corrupt JSON and leaves unrelated rows when the session row is absent', async () => {
    const db = await openDatabase(':memory:');
    try {
      const sessions = new SessionRepository(db.client);
      rawBlob(db.client, 'blob_corrupt', '{not valid json');
      rawBlob(db.client, 'blob_b', recoveryBlob('blob_b', 'sesB'));
      expect(sessions.delete('ghost')).toBe(false);
      expect(blobIds(db.client)).toEqual(['blob_b', 'blob_corrupt']);
    } finally {
      db.close();
    }
  });

  it('rolls back the whole session delete when recovery-blob cleanup fails', async () => {
    const db = await openDatabase(':memory:');
    try {
      new RequestRepository(db.client).put({
        id: 'req_a',
        ts: '2026-01-01T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        session_id: 'sesA',
        input_tokens: 10,
        status: 'ok',
      });
      const sessions = new SessionRepository(db.client);
      sessions.put(sessionFor('sesA'));
      rawBlob(db.client, 'blob_a', recoveryBlob('blob_a', 'sesA'));
      db.client.exec(
        "CREATE TRIGGER fail_blob_delete BEFORE DELETE ON optimizer_blobs WHEN OLD.id = 'blob_a' BEGIN SELECT RAISE(ABORT, 'boom'); END",
      );

      expect(() => sessions.delete('sesA')).toThrow(/boom/);

      expect(db.client.prepare('SELECT count(*) AS n FROM sessions').get()).toMatchObject({ n: 1 });
      expect(db.client.prepare('SELECT count(*) AS n FROM optimizer_blobs').get()).toMatchObject({
        n: 1,
      });
      expect(db.client.prepare('SELECT count(*) AS n FROM usage_event_keys').get()).toMatchObject({
        n: 1,
      });
      expect(
        db.client.prepare('SELECT count(*) AS n FROM session_model_usage').get(),
      ).toMatchObject({ n: 1 });
      expect(
        db.client.prepare('SELECT session_id FROM requests WHERE id=?').get('req_a'),
      ).toMatchObject({ session_id: 'sesA' });
    } finally {
      db.close();
    }
  });
});
