import { describe, expect, it } from 'vitest';
import type { UsageHistoryPoint } from '@ferry/shared';
import { activityLevel, greeting, summarizeUsage } from './usageSummary';

const point = (
  date: string,
  providerId: string,
  requests: number,
  costUsd = 0,
): UsageHistoryPoint => ({
  date,
  providerId: providerId as UsageHistoryPoint['providerId'],
  requests,
  inputTokens: requests * 100,
  outputTokens: requests * 10,
  costUsd,
});

describe('home usage summary', () => {
  const now = new Date('2026-10-05T12:00:00Z');

  it('builds a 30-day series that includes empty days', () => {
    const stats = summarizeUsage(
      [
        point('2026-10-05', 'groq', 4),
        point('2026-10-05', 'gemini', 6),
        point('2026-09-20', 'groq', 2),
      ],
      now,
    );
    expect(stats.daily).toHaveLength(30);
    expect(stats.daily.at(-1)).toEqual({ date: '2026-10-05', requests: 10 });
    expect(stats.daily.find((day) => day.date === '2026-09-20')?.requests).toBe(2);
    expect(stats.daily.find((day) => day.date === '2026-09-21')?.requests).toBe(0);
  });

  it('totals this month and ranks providers over the window', () => {
    const stats = summarizeUsage(
      [
        point('2026-10-01', 'groq', 10),
        point('2026-10-02', 'opencode-go', 5, 1.25),
        point('2026-09-28', 'gemini', 40),
      ],
      now,
    );
    expect(stats.monthRequests).toBe(15);
    expect(stats.monthTokens).toBe(15 * 110);
    expect(stats.monthSpendUsd).toBe(1.25);
    expect(stats.freeShare).toBeCloseTo(10 / 15);
    expect(stats.topProviders.map((item) => item.providerId)).toEqual([
      'gemini',
      'groq',
      'opencode-go',
    ]);
  });

  it('reports no free share before any requests', () => {
    expect(summarizeUsage([], now).freeShare).toBeNull();
  });

  it('buckets activity relative to the busiest day', () => {
    expect(activityLevel(0, 100)).toBe(0);
    expect(activityLevel(1, 100)).toBe(1);
    expect(activityLevel(100, 100)).toBe(4);
  });

  it('greets by local time of day', () => {
    expect(greeting(new Date(2026, 9, 5, 9))).toBe('Good morning');
    expect(greeting(new Date(2026, 9, 5, 14))).toBe('Good afternoon');
    expect(greeting(new Date(2026, 9, 5, 21))).toBe('Good evening');
  });
});
