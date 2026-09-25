import { describe, expect, it } from 'vitest';
import { createMockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';
import { computeCapacity } from '../src/mock/capacity.js';
import { createProviders } from '../src/mock/fixtures/providers.js';

const now = new Date('2026-09-23T21:47:00.000Z');
const makeClient = (seed = 20260923) =>
  createMockFerryClient({ seed, clock: createFakeClock(now).clock, behavior: 'test' });

describe('mock client QA follow-ups', () => {
  it('clamps quota-window usage and provider percentages', () => {
    const client = makeClient();
    const gemini = client.__state().providers.find((provider) => provider.id === 'gemini');
    if (!gemini) throw new Error('Gemini fixture missing');
    const daily = gemini.windows.find((window) => window.kind === 'fixed_daily');
    if (!daily?.limit) throw new Error('Gemini daily window missing');

    client.__store().consumeSteps(gemini.id, 100_000);
    expect(daily.used).toBe(daily.limit);
    const corrupted = createProviders(now);
    const corruptedGemini = corrupted.find((provider) => provider.id === 'gemini');
    if (!corruptedGemini) throw new Error('Gemini capacity fixture missing');
    const corruptedDaily = corruptedGemini.windows.find((window) => window.kind === 'fixed_daily');
    if (!corruptedDaily?.limit) throw new Error('Daily window missing');
    corruptedDaily.used = corruptedDaily.limit + 500;
    expect(
      computeCapacity(corrupted, now).perProvider.find((item) => item.providerId === 'gemini')
        ?.percent,
    ).toBe(0);
  });

  it('names the earliest resetting low main coder and filters unavailable reset windows', async () => {
    const client = makeClient();
    const openrouter = client.__state().providers.find((provider) => provider.id === 'openrouter');
    if (!openrouter) throw new Error('OpenRouter fixture missing');
    const daily = openrouter.windows.find((window) => window.kind === 'fixed_daily');
    if (!daily?.limit) throw new Error('OpenRouter daily window missing');
    daily.used = daily.limit - 5;
    expect((await client.quota.capacity()).banner?.text).toBe(
      'Free capacity low \u2014 OpenRouter resets in 2h 13m',
    );

    const gemini = client.__state().providers.find((provider) => provider.id === 'gemini');
    if (!gemini) throw new Error('Gemini fixture missing');
    gemini.enabled = false;
    openrouter.keyStatus = 'missing';
    const resets = (await client.quota.capacity()).nextResets;
    expect(resets.some((reset) => reset.providerId === gemini.id)).toBe(false);
    expect(resets.some((reset) => reset.providerId === openrouter.id)).toBe(false);
  });

  it('makes cancellation terminal and rejects rework for cancelled runs', async () => {
    const fake = createFakeClock(now);
    const client = createMockFerryClient({ clock: fake.clock, behavior: 'test' });
    const session = (await client.sessions.list())[0];
    if (!session) throw new Error('Session fixture missing');
    const completed = await client.delegation.start({
      sessionId: session.id,
      lane: 'impl',
      brief: 'Finish before cancellation',
    });
    fake.advance(2_800);
    const updates: string[] = [];
    client.on('delegation.updated', (run) => updates.push(run.status));
    await client.delegation.cancel(completed.id);
    expect((await client.delegation.runs(session.id))[0]?.status).toBe('completed');
    expect(updates).toHaveLength(0);

    const cancelled = await client.delegation.start({
      sessionId: session.id,
      lane: 'impl',
      brief: 'Cancel before rework',
    });
    await client.delegation.cancel(cancelled.id);
    await expect(client.delegation.decide(cancelled.id, 'rework')).rejects.toThrow(
      'A cancelled delegation run cannot be reworked',
    );
    expect((await client.delegation.runs(session.id))[1]?.status).toBe('cancelled');
  });

  it('uses the seeded store ID helper', () => {
    expect(makeClient(42).__store().nextId('message')).toBe(
      makeClient(42).__store().nextId('message'),
    );
  });

  it('probes CLI providers without changing their not-applicable key status', async () => {
    const client = makeClient();
    const cli = client.__state().providers.find((provider) => provider.id === 'codex-cli');
    if (!cli) throw new Error('Codex CLI fixture missing');
    const result = await client.providers.probe(cli.id);
    expect(result).toEqual({
      ok: true,
      keyValid: true,
      latencyMs: null,
      message: 'CLI detected \u2014 no API key needed',
      windows: [],
      models: [],
      errorKind: null,
    });
    expect(cli.keyStatus).toBe('not_applicable');
  });
});
