import { describe, expect, it } from 'vitest';
import { retryDelayFromHeaders, quotaPeriodMs } from '../src/routing-limits.js';
import { QuotaWindowSchema } from '@ferry/shared';
import { changedRunFiles } from '../src/run-files.js';

describe('routing reset hints', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  it.each([
    '12s',
    String((now + 12000) / 1000),
    String(now + 12000),
    new Date(now + 12000).toISOString(),
  ])('reads a 12s provider reset from %s', (value) => {
    expect(retryDelayFromHeaders({ 'X-RateLimit-Reset-Tokens': value }, now)).toBe(12000);
  });
  it('prefers Retry-After and ignores invalid or expired reset hints', () => {
    expect(
      retryDelayFromHeaders(
        new Headers({ 'retry-after': '12', 'x-ratelimit-reset-tokens': '60s' }),
        now,
      ),
    ).toBe(12000);
    expect(retryDelayFromHeaders({ 'ratelimit-reset': 'nonsense' }, now)).toBeNull();
    expect(
      retryDelayFromHeaders({ 'ratelimit-reset': String((now - 1000) / 1000) }, now),
    ).toBeNull();
  });
  it('ignores reset hints for a dimension with remaining capacity', () => {
    expect(
      retryDelayFromHeaders(
        {
          'x-ratelimit-reset-tokens': '12s',
          'x-ratelimit-remaining-tokens': '0',
          'x-ratelimit-reset-requests': '60s',
          'x-ratelimit-remaining-requests': '10',
        },
        now,
      ),
    ).toBe(12000);
  });
  it('recognizes daily windows even when their optional duration is absent', () => {
    expect(
      quotaPeriodMs(
        QuotaWindowSchema.parse({
          id: 'day',
          scope: 'provider',
          modelRef: null,
          metric: 'tokens',
          kind: 'fixed_daily',
          periodLabel: 'daily',
          used: 100,
          remaining: 0,
          limit: 100,
          confidence: 'exact',
          resetAt: new Date(now + 12000).toISOString(),
        }),
      ),
    ).toBeGreaterThan(120000);
  });
});
describe('command file changes', () => {
  it('detects equal-size edits, additions and deletions and ignores identical content', () => {
    expect(
      changedRunFiles(
        new Map([
          ['edit.txt', { hash: 'old', sizeBytes: 3 }],
          ['delete.txt', { hash: 'gone', sizeBytes: 2 }],
          ['same.txt', { hash: 'same', sizeBytes: 1 }],
        ]),
        new Map([
          ['edit.txt', { hash: 'new', sizeBytes: 3 }],
          ['add.txt', { hash: 'add', sizeBytes: 4 }],
          ['same.txt', { hash: 'same', sizeBytes: 1 }],
        ]),
      ),
    ).toEqual([
      { path: 'add.txt', sizeBytes: 4, status: 'added' },
      { path: 'delete.txt', sizeBytes: 0, status: 'deleted' },
      { path: 'edit.txt', sizeBytes: 3, status: 'modified' },
    ]);
  });
});
