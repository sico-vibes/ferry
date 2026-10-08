import { describe, expect, it } from 'vitest';
import type { ProviderLimits } from '@ferry/shared';
import {
  describeReset,
  describeWindow,
  remainingShare,
  summarizeProviderWindows,
  tightestDailyWindow,
} from './limits';

type Window = ProviderLimits['windows'][number];
const window = (patch: Partial<Window>): Window => ({
  metric: 'requests',
  period: 'day',
  limit: 50,
  used: 12,
  remaining: 38,
  resetAt: null,
  source: 'published',
  observedAt: null,
  ...patch,
});
const provider = (name: string, windows: Window[]): ProviderLimits =>
  ({
    providerId: name.toLowerCase(),
    providerName: name,
    state: 'known',
    windows,
  }) as ProviderLimits;

describe('limit formatting', () => {
  it('says what is left only when both numbers are known', () => {
    expect(describeWindow(window({}))).toBe('38 of 50 requests left today');
    expect(describeWindow(window({ remaining: null }))).toBe('12 of 50 requests used today');
    expect(describeWindow(window({ limit: null, remaining: null, period: 'month' }))).toBe(
      '12 requests used this month',
    );
    expect(remainingShare(window({ limit: null }))).toBeNull();
  });

  it('formats reset times and drops past ones', () => {
    const now = Date.parse('2026-10-07T10:00:00Z');
    expect(describeReset(window({ resetAt: '2026-10-07T13:20:00Z' }), now)).toBe(
      'resets in 3h 20m',
    );
    expect(describeReset(window({ resetAt: '2026-10-07T09:00:00Z' }), now)).toBeNull();
  });

  it('collapses untouched per-model windows into one line per limit', () => {
    const summary = summarizeProviderWindows(
      provider('OpenRouter', [
        window({ limit: 200, used: 3, remaining: 197 }),
        window({ model: 'openrouter/a:free', used: 2, remaining: 48 }),
        ...Array.from({ length: 37 }, (_, index) =>
          window({ model: `openrouter/m${String(index)}:free`, used: 0, remaining: 50 }),
        ),
      ]),
    );
    expect(summary.rows).toHaveLength(2);
    expect(summary.untouched).toEqual([
      { count: 37, text: '50 requests a day each for 37 other models' },
    ]);
  });

  it('picks the daily window closest to running out, ignoring monthly and unknown ones', () => {
    const tightest = tightestDailyWindow([
      provider('Groq', [window({ limit: 1000, remaining: 900 })]),
      provider('OpenRouter', [
        window({ limit: 50, remaining: 5 }),
        window({ period: 'month', limit: 100, remaining: 1 }),
      ]),
      provider('Anthropic', [window({ limit: null, remaining: null })]),
    ]);
    expect(tightest?.providerName).toBe('OpenRouter');
    expect(tightest?.share).toBe(0.1);
    expect(tightestDailyWindow([provider('Paid', [])])).toBeNull();
    // An untouched plan isn't "closest to running out".
    expect(
      tightestDailyWindow([provider('AnyAPI', [window({ used: 0, remaining: 50 })])]),
    ).toBeNull();
  });
});
