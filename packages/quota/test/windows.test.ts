import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { UsageRecord } from '@ferry/shared';
import { nextReset, remaining, usageIn, windowStart } from '../src/windows.js';

const record = (id: string, occurredAt: string): UsageRecord => ({
  id,
  providerId: 'gemini' as UsageRecord['providerId'],
  modelRef: 'gemini/gemini-flash',
  occurredAt,
  status: 'success',
  inputTokens: 3,
  outputTokens: 2,
  costUsd: 0.01,
});

describe('quota window math', () => {
  it('keeps rolling-window starts exactly one length behind now', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 14 * 24 * 60 * 60 }),
        fc.integer({ min: 0, max: 2_000_000_000_000 }),
        (length, now) => {
          const milliseconds = length * 1000;
          const spec = { kind: 'rolling' as const, length };
          expect(windowStart(new Date(now), spec).getTime()).toBe(now - milliseconds);
          expect(nextReset(new Date(now), spec).getTime()).toBe(now);
        },
      ),
    );
  });

  it('resets Gemini daily windows at Los Angeles midnight across spring DST', () => {
    const spec = { kind: 'fixed_daily' as const, tz: 'America/Los_Angeles', time: '00:00' };
    const now = new Date('2026-03-08T12:00:00.000Z');
    expect(windowStart(now, spec).toISOString()).toBe('2026-03-08T08:00:00.000Z');
    expect(nextReset(now, spec).toISOString()).toBe('2026-03-09T07:00:00.000Z');
  });

  it('resets Gemini daily windows at Los Angeles midnight across autumn DST', () => {
    const spec = { kind: 'fixed_daily' as const, tz: 'America/Los_Angeles', time: '00:00' };
    const now = new Date('2026-11-01T12:00:00.000Z');
    expect(windowStart(now, spec).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(nextReset(now, spec).toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });

  it('counts only records inside the half-open window and clamps remaining', () => {
    const usage = usageIn(
      { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-02T00:00:00Z') },
      [
        record('before', '2025-12-31T23:59:59Z'),
        record('included', '2026-01-01T01:00:00Z'),
        record('end', '2026-01-02T00:00:00Z'),
      ],
    );
    expect(usage).toEqual({ requests: 1, tokens: 5, usd: 0.01, credits: 0.01 });
    expect(remaining(5, 8)).toBe(0);
    expect(remaining(5, 0, 3)).toBe(3);
  });

  it('models dynamic credits returning five hours after individual usage', () => {
    const now = new Date('2026-05-01T10:00:00Z');
    const spec = { kind: 'dynamic_5h' as const };
    expect(
      nextReset(now, spec, [
        record('old', '2026-05-01T04:00:00Z'),
        record('new', '2026-05-01T08:00:00Z'),
      ]).toISOString(),
    ).toBe('2026-05-01T13:00:00.000Z');
  });

  it('honors weekly reset weekdays and local times across a DST boundary', () => {
    const spec = {
      kind: 'weekly_fixed' as const,
      dow: 1,
      tz: 'America/Los_Angeles',
      time: '08:30',
    };
    const now = new Date('2026-03-08T12:00:00.000Z');
    expect(windowStart(now, spec).toISOString()).toBe('2026-03-02T16:30:00.000Z');
    expect(nextReset(now, spec).toISOString()).toBe('2026-03-09T15:30:00.000Z');
  });

  it('clamps monthly anchors to short months', () => {
    const spec = { kind: 'monthly_from_anchor' as const, day: 31, tz: 'UTC' };
    const now = new Date('2026-04-15T12:00:00.000Z');
    expect(windowStart(now, spec).toISOString()).toBe('2026-03-31T00:00:00.000Z');
    expect(nextReset(now, spec).toISOString()).toBe('2026-04-30T00:00:00.000Z');
  });
});
