import { describe, expect, it } from 'vitest';
import { createMockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';
import { createProviders } from '../src/mock/fixtures/providers.js';

const now = new Date('2026-09-23T21:47:00.000Z');

const geminiReset = (date: Date): string | null => {
  const gemini = createProviders(date).find((provider) => provider.id === 'gemini');
  return gemini?.windows.find((window) => window.kind === 'fixed_daily')?.resetAt ?? null;
};

describe('QA capacity and reset windows', () => {
  it('formats the low-capacity banner with hours and minutes', async () => {
    const client = createMockFerryClient({ clock: createFakeClock(now).clock });
    const capacity = await client.quota.capacity();
    expect(capacity.banner?.text).toMatch(/^Free capacity low — Gemini resets in \d+h \d+m$/);
    expect(capacity.banner?.text).toBe('Free capacity low — Gemini resets in 9h 13m');
  });

  it('recomputes capacity when a provider key is removed', async () => {
    const client = createMockFerryClient({ clock: createFakeClock(now).clock });
    const openrouter = client.__state().providers.find((provider) => provider.id === 'openrouter');
    if (!openrouter) throw new Error('OpenRouter fixture missing');

    await client.providers.removeKey(openrouter.id);

    const capacity = await client.quota.capacity();
    expect(capacity.stepsLeftToday).toBe(108);
    expect(capacity.percentRemaining).toBe(39);
    expect(
      capacity.perProvider.find((item) => item.providerId === 'openrouter')?.stepsLeft,
    ).toBeNull();
  });

  it('never drops below zero and emits one quota.updated per consumeSteps call', () => {
    const client = createMockFerryClient({ clock: createFakeClock(now).clock });
    const store = client.__store();
    let emitted = 0;
    client.on('quota.updated', () => emitted++);

    const gemini = client.__state().providers.find((provider) => provider.id === 'gemini');
    if (!gemini) throw new Error('Gemini fixture missing');

    const first = store.consumeSteps(gemini.id, 5);
    expect(first.stepsLeftToday).toBe(415);
    expect(emitted).toBe(1);
    expect(gemini.stepsLeftToday).toBe(33);

    store.consumeSteps(gemini.id, 33);
    expect(emitted).toBe(2);
    expect(gemini.stepsLeftToday).toBe(0);

    store.consumeSteps(gemini.id, 1);
    expect(emitted).toBe(3);
    expect(gemini.stepsLeftToday).toBe(0);
  });

  it('clamps capacity instead of throwing when a provider is over-consumed', () => {
    const client = createMockFerryClient({ clock: createFakeClock(now).clock });
    const gemini = client.__state().providers.find((provider) => provider.id === 'gemini');
    if (!gemini) throw new Error('Gemini fixture missing');
    expect(() => client.__store().consumeSteps(gemini.id, 10_000)).not.toThrow();
  });

  it('computes the next Pacific midnight exactly at and around DST changes', () => {
    expect(geminiReset(new Date('2026-03-08T08:00:00.000Z'))).toBe('2026-03-09T07:00:00.000Z');
    expect(geminiReset(new Date('2026-03-08T09:00:00.000Z'))).toBe('2026-03-09T07:00:00.000Z');
    expect(geminiReset(new Date('2026-03-09T06:59:00.000Z'))).toBe('2026-03-09T07:00:00.000Z');
    expect(geminiReset(new Date('2026-11-01T06:00:00.000Z'))).toBe('2026-11-01T07:00:00.000Z');
    expect(geminiReset(new Date('2026-11-01T07:00:00.000Z'))).toBe('2026-11-02T08:00:00.000Z');
    expect(geminiReset(new Date('2026-11-01T09:00:00.000Z'))).toBe('2026-11-02T08:00:00.000Z');
  });
});
