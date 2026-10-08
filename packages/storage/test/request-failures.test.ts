import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FailureEntrySchema, ProviderIdSchema, rememberSecret, forgetSecret } from '@ferry/shared';
import {
  openDatabase,
  RequestFailureRepository,
  ProviderRepository,
  type DatabaseConnection,
} from '../src/index.js';
import { sampleProvider } from '@ferry/shared/testing';

vi.setConfig({ testTimeout: 30_000 });
let db: DatabaseConnection | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});
const now = new Date('2026-10-08T10:00:00.000Z');
const providers = [{ id: ProviderIdSchema.parse('groq') }];
async function ledger() {
  db = await openDatabase(':memory:');
  return new RequestFailureRepository(db.client);
}
function failure(id: string, patch: Record<string, unknown> = {}) {
  return FailureEntrySchema.parse({
    id,
    at: now.toISOString(),
    providerId: 'groq',
    modelRef: 'groq/model',
    keyId: null,
    requestId: id,
    sessionId: null,
    source: 'agent',
    kind: 'server',
    statusCode: 502,
    message: 'Upstream service error',
    counted: 1,
    ...patch,
  });
}

describe('request failure ledger', () => {
  it('keeps a provider last error even when another provider fills the recent result limit', async () => {
    const repo = await ledger();
    repo.put(failure('groq-old', { message: 'Older upstream outage' }));
    repo.put(
      failure('openai-new', {
        providerId: 'openai',
        modelRef: 'openai/model',
        at: new Date(now.getTime() + 1_000).toISOString(),
        message: 'Newer outage',
      }),
    );
    const result = repo.summary(
      [...providers, { id: ProviderIdSchema.parse('openai') }],
      now,
      undefined,
      { limit: 1 },
    );
    expect(result.recent[0]?.providerId).toBe('openai');
    expect(result.providers.find((provider) => provider.providerId === 'groq')?.lastError).toBe(
      'Older upstream outage',
    );
  });
  it('retains ledger, pause and success state after closing and reopening SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ferry-failure-reopen-'));
    try {
      const path = join(directory, 'ledger.sqlite');
      db = await openDatabase(path);
      const repo = new RequestFailureRepository(db.client);
      repo.put(failure('before-restart'));
      repo.success('groq', 'groq/other-model', now.toISOString());
      repo.put(failure('after-success'));
      new ProviderRepository(db.client).put({
        ...sampleProvider,
        id: ProviderIdSchema.parse('groq'),
        enabled: true,
        pausedReason: {
          kind: 'failed_requests',
          at: now.toISOString(),
          failedRequests: 5,
          lastError: 'Upstream service error',
          lastKind: 'server',
          models: [failure('ref').modelRef],
        },
      });
      db.close();
      db = await openDatabase(path);
      const persisted = new ProviderRepository(db.client).get('groq');
      expect(persisted).toMatchObject({ enabled: false, pausedReason: { failedRequests: 5 } });
      if (!persisted) throw new Error('Missing saved provider');
      expect(new RequestFailureRepository(db.client).summary([persisted], now)).toMatchObject({
        providers: [
          {
            consecutive: 1,
            failed24h: 2,
            lastSuccessAt: now.toISOString(),
            paused: { failedRequests: 5 },
          },
        ],
      });
    } finally {
      db?.close();
      db = undefined;
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
  it('counts distinct requests and excludes quota, rate limits, reservations, tools, context and cancels', async () => {
    const repo = await ledger();
    for (let retry = 0; retry < 3; retry++)
      repo.put(failure(`retry-${String(retry)}`, { requestId: 'same' }));
    for (const kind of [
      'rate_limit',
      'quota_exhausted',
      'local_reservation',
      'tools_unsupported',
      'context_too_large',
      'cancelled',
    ])
      repo.put(failure(kind, { kind }));
    const result = repo.summary(providers, now);
    expect(result.providers[0]).toMatchObject({
      failed24h: 7,
      failed7d: 7,
      counted24h: 1,
      consecutive: 1,
    });
    expect(result.recent).toHaveLength(9);
    expect(result.recent.filter((entry) => entry.counted === 1)).toHaveLength(3);
  });

  it('persists success per provider and model and resets even when clock timestamps are equal', async () => {
    const repo = await ledger();
    for (let request = 0; request < 4; request++) repo.put(failure(String(request)));
    expect(repo.summary(providers, now).providers[0]?.consecutive).toBe(4);
    expect(repo.summary(providers, now).providers[0]?.models[0]?.failing).toBe(true);
    repo.success('groq', 'groq/model', now.toISOString());
    expect(repo.summary(providers, now).providers[0]).toMatchObject({
      consecutive: 0,
      lastSuccessAt: now.toISOString(),
    });
    expect(repo.summary(providers, now).providers[0]?.models[0]).toMatchObject({
      failing: false,
      lastSuccessAt: now.toISOString(),
    });
    repo.put(failure('after-success'));
    expect(repo.summary(providers, now).providers[0]?.consecutive).toBe(1);
    repo.reset('groq');
    expect(repo.summary(providers, now).providers[0]?.consecutive).toBe(0);
    expect(repo.summary(providers, now).providers[0]?.failed24h).toBe(5);
  });

  it('prunes at 30 days, bounds recent results, and keeps sequence resets correct after pruning', async () => {
    const repo = await ledger();
    repo.put(failure('old', { at: new Date(now.getTime() - 31 * 86_400_000).toISOString() }));
    repo.reset('groq');
    expect(repo.prune(now)).toBe(1);
    repo.put(failure('new'));
    repo.put(failure('outside24', { at: new Date(now.getTime() - 2 * 86_400_000).toISOString() }));
    expect(repo.summary(providers, now, 'groq', { limit: 1, sinceHours: 24 })).toMatchObject({
      providers: [{ failed24h: 1, failed7d: 2, consecutive: 1 }],
      recent: [{ requestId: 'new' }],
    });
    repo.clear('groq');
    expect(repo.summary(providers, now).recent).toEqual([]);
  });

  it('redacts secrets before truncating to 500 characters', async () => {
    const repo = await ledger();
    const secret = 'fixture-only-secret';
    rememberSecret(secret);
    try {
      repo.put(failure('redacted', { message: `${'x'.repeat(480)} ${secret}` }));
      const message = repo.summary(providers, now).recent[0]?.message;
      expect(message).toContain('[REDACTED]');
      expect(message).not.toContain(secret);
      expect(message?.length).toBeLessThanOrEqual(500);
    } finally {
      forgetSecret(secret);
    }
  });
});
