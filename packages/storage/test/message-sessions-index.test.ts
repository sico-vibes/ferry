import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageSchema } from '@ferry/shared';
import type { Message } from '@ferry/shared';
import { MessageRepository, openDatabase } from '../src/index.js';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ferry-msg-index-'));
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

/** Exact guarded expression the repository queries and migration 0011 indexes. */
const SESSION_EXPR =
  "CASE WHEN json_valid(data_json) THEN json_extract(data_json,'$.sessionId') END";

function messageFor(sessionId: string, id: string, text = 'hello'): Message {
  return MessageSchema.parse({
    id,
    sessionId,
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    modelRef: null,
    parts: [{ type: 'text', id: `${id}-part`, text }],
  });
}

describe('messages session index and MessageRepository.listForSessions', () => {
  it('selects only the requested sessions and skips corrupt or invalid rows', async () => {
    const db = await openDatabase(':memory:');
    try {
      const messages = new MessageRepository(db.client);
      messages.put(messageFor('s1', 'm1'));
      messages.put(messageFor('s2', 'm2'));
      messages.put(messageFor('s3', 'm3'));
      db.client
        .prepare('INSERT INTO messages (id,data_json,updated_at) VALUES (?,?,?)')
        .run('corrupt', '{not valid json', '2026-01-01T00:00:00.000Z');
      db.client
        .prepare('INSERT INTO messages (id,data_json,updated_at) VALUES (?,?,?)')
        .run('invalid-shape', JSON.stringify({ id: 'x' }), '2026-01-01T00:00:00.000Z');

      const listed = messages.listForSessions(['s1', 's3']);
      expect(listed.map((entry) => entry.id).sort()).toEqual(['m1', 'm3']);
    } finally {
      db.close();
    }
  });

  it('drives session selection through the messages_session_id_idx index', async () => {
    const db = await openDatabase(':memory:');
    try {
      const plan = db.client
        .prepare(`EXPLAIN QUERY PLAN SELECT data_json FROM messages WHERE ${SESSION_EXPR} IN (?,?)`)
        .all('s1', 's2');
      expect(JSON.stringify(plan)).toContain('messages_session_id_idx');
    } finally {
      db.close();
    }
  });

  it('stays bounded across far more sessions than the SQLite variable limit', async () => {
    const db = await openDatabase(':memory:');
    try {
      const messages = new MessageRepository(db.client);
      const insert = db.client.prepare(
        'INSERT INTO messages (id,data_json,updated_at) VALUES (?,?,?)',
      );
      const seed = db.client.transaction(() => {
        for (let index = 0; index < 1200; index += 1) {
          const message = messageFor(`s${String(index)}`, `m${String(index)}`);
          insert.run(message.id, JSON.stringify(message), message.createdAt);
        }
      });
      seed();
      const ids = Array.from({ length: 1200 }, (_, index) => `s${String(index)}`);
      expect(messages.listForSessions(ids)).toHaveLength(1200);
      expect(messages.listForSessions([])).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('recreates the session index over malformed message JSON during migration', async () => {
    const file = join(await tempDir(), 'malformed.sqlite');
    const seeded = await openDatabase(file);
    seeded.client.exec('DROP INDEX IF EXISTS messages_session_id_idx');
    seeded.client
      .prepare('INSERT INTO messages (id,data_json,updated_at) VALUES (?,?,?)')
      .run('corrupt', '{not valid json', '2026-01-01T00:00:00.000Z');
    seeded.client
      .prepare('INSERT INTO messages (id,data_json,updated_at) VALUES (?,?,?)')
      .run('good', JSON.stringify(messageFor('s1', 'good')), '2026-01-01T00:00:00.000Z');
    seeded.client.pragma('user_version = 10');
    seeded.close();

    const migrated = await openDatabase(file);
    try {
      const index = migrated.client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='messages_session_id_idx'",
        )
        .get();
      expect(index).toBeDefined();
      expect(
        new MessageRepository(migrated.client).listForSessions(['s1']).map((m) => m.id),
      ).toEqual(['good']);
    } finally {
      migrated.close();
    }
  });

  it('propagates an infrastructure failure instead of returning an empty list', async () => {
    const db = await openDatabase(':memory:');
    try {
      const messages = new MessageRepository(db.client);
      messages.put(messageFor('s1', 'm1'));
      db.client.exec('DROP TABLE messages');
      expect(() => messages.listForSessions(['s1'])).toThrow();
    } finally {
      db.close();
    }
  });
});
