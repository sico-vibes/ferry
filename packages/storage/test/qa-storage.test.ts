import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRefSchema, ProviderIdSchema } from '@ferry/shared';
import {
  JsonRepository,
  ModelCacheRepository,
  openDatabase,
  redactHeaders,
  RequestRepository,
  runRetention,
  SettingsRepository,
  UsageDailyRepository,
} from '../src/index.js';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ferry-qa-storage-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('QA storage: migrations and corruption', () => {
  it('migrates a fresh file database once and reopens idempotently', async () => {
    const dir = await tempDir();
    const file = join(dir, 'nested', 'ferry.sqlite');
    const first = await openDatabase(file);
    expect(first.client.pragma('user_version', { simple: true })).toBe(1);
    first.close();
    const second = await openDatabase(file);
    expect(second.client.pragma('user_version', { simple: true })).toBe(1);
    second.close();
  });

  it('releases the SQLite handle when opening a corrupt file fails', async () => {
    // BUG: openDatabase() constructs the better-sqlite3 Database before running
    // pragmas/migration and never closes it on failure, so the file stays locked
    // on Windows (the cleanup unlink fails with EBUSY).
    const file = join(
      tmpdir(),
      `ferry-qa-corrupt-${String(process.pid)}-${String(Date.now())}.sqlite`,
    );
    await writeFile(file, Buffer.from('this is definitely not sqlite'));
    try {
      await expect(openDatabase(file)).rejects.toThrow();
      await rm(file, { force: true });
    } finally {
      await rm(file, { force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
    }
  });

  it('tolerates two connections writing the same file database', async () => {
    const dir = await tempDir();
    const file = join(dir, 'shared.sqlite');
    const a = await openDatabase(file);
    const b = await openDatabase(file);
    try {
      const repoA = new SettingsRepository(a.client);
      const repoB = new SettingsRepository(b.client);
      for (let i = 0; i < 25; i += 1) {
        repoA.put(`a-${String(i)}`, { i });
        repoB.put(`b-${String(i)}`, { i });
      }
      expect(a.client.prepare('SELECT count(*) AS n FROM settings_kv').get()).toMatchObject({
        n: 50,
      });
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('QA storage: repositories', () => {
  it('round-trips JSON aggregates and reports deletes', async () => {
    const dir = await tempDir();
    const db = await openDatabase(join(dir, 'repo.sqlite'));
    try {
      const repo = new JsonRepository<{ id: string; payload: unknown }>(
        db.client,
        'optimizer_blobs',
      );
      repo.put({ id: 'x', payload: { nested: [1, 2, 3], text: 'value' } });
      expect(repo.get('x')).toEqual({ id: 'x', payload: { nested: [1, 2, 3], text: 'value' } });
      expect(repo.delete('x')).toBe(true);
      expect(repo.delete('x')).toBe(false);
      expect(repo.list()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('caches models per provider and overwrites on conflict', async () => {
    const dir = await tempDir();
    const db = await openDatabase(join(dir, 'models.sqlite'));
    try {
      const cache = new ModelCacheRepository(db.client);
      const model = {
        ref: ModelRefSchema.parse('groq/llama'),
        providerId: ProviderIdSchema.parse('groq'),
        name: 'Llama',
        tier: 'T2' as const,
        contextWindow: 1000,
        maxOutput: 100,
        toolCalling: true,
        reasoning: false,
        free: true,
        priceInPerM: null,
        priceOutPerM: null,
      };
      cache.put('groq', model);
      cache.put('groq', { ...model, name: 'Llama 2' });
      const stored = cache.list('groq');
      expect(stored).toHaveLength(1);
      expect(stored[0]?.name).toBe('Llama 2');
    } finally {
      db.close();
    }
  });

  it('aggregates retention without double counting on a second run', async () => {
    const dir = await tempDir();
    const db = await openDatabase(join(dir, 'retention.sqlite'));
    try {
      const requests = new RequestRepository(db.client);
      for (let i = 0; i < 5; i += 1) {
        requests.put({
          id: `r${String(i)}`,
          ts: '2020-01-02T10:00:00.000Z',
          provider: 'p',
          model: 'm',
          input_tokens: 10,
          output_tokens: 4,
          cost_usd: 0.5,
          status: 'ok',
        });
      }
      const cutoff = new Date('2020-02-01T00:00:00.000Z');
      expect(runRetention(db.client, cutoff)).toBe(5);
      expect(runRetention(db.client, cutoff)).toBe(0);
      const daily = new UsageDailyRepository(db.client).list();
      expect(daily).toHaveLength(1);
      expect(daily[0]).toMatchObject({ requests: 5, input_tokens: 50, output_tokens: 20 });
    } finally {
      db.close();
    }
  });
});

describe('QA storage: secret redaction', () => {
  it('redacts sensitive header keys and bearer-style values', () => {
    const redacted = redactHeaders({
      Authorization: 'Bearer abcdefghijklmnop',
      'X-Api-Key': 'sk-abcdefghijklmnop',
      'X-Goog-Api-Key': 'AIzaSyabcdefghijklmnop',
      nested: { list: [{ token: 'gsk_abcdefghijklmnop' }] },
    });
    expect(redacted).not.toContain('abcdefghijklmnop');
    expect(redacted).not.toContain('sk-abcdefghijklmnop');
    expect(redacted).not.toContain('AIzaSyabcdefghijklmnop');
    expect(redacted).toContain('[REDACTED]');
  });

  it('returns null for absent headers', () => {
    expect(redactHeaders(undefined)).toBeNull();
    expect(redactHeaders(null)).toBeNull();
  });

  it('redacts GitHub-style tokens stored in request headers', () => {
    // BUG: the value scrubber only recognizes sk-/gsk_/AIza/nvapi- prefixes, so a
    // GitHub PAT (ghp_…) persists verbatim into the requests table.
    const redacted = redactHeaders({ 'x-custom-auth': 'ghp_0123456789abcdefghijklmnopqrstuvwx' });
    expect(redacted).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwx');
  });
});
