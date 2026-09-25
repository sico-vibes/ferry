import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, QuotaObservationRepository, RequestRepository } from '@ferry/storage';
import type { ModelRef, UsageRecord } from '@ferry/shared';
import { QuotaEngine } from '../src/engine.js';

const provider = {
  provider: 'gemini',
  name: 'Gemini',
  tag: 'legit' as const,
  signup_url: null,
  docs_url: null,
  terms_note: '',
  data_use: '',
  verified_at: '2026-01-01',
  source_url: 'https://example.com',
  windows: [
    {
      scope: 'provider' as const,
      metric: 'requests' as const,
      kind: 'rolling' as const,
      length: 60,
      limit: 4,
    },
  ],
};
const usage = (id: string, time: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  id,
  providerId: 'gemini' as UsageRecord['providerId'],
  modelRef: 'gemini/gemini-flash',
  occurredAt: time,
  status: 'success',
  inputTokens: 10,
  outputTokens: 5,
  stepKind: 'edit',
  ...extra,
});
const getWindow = (engine: QuotaEngine, providerId: string) => {
  const window = engine.getWindows(providerId)[0];
  if (!window) throw new Error(`Missing quota window for ${providerId}`);
  return window;
};

describe('QuotaEngine', () => {
  afterEach(() => vi.useRealTimers());

  it('logs quota.updated callback failures without an unhandled throw', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const engine = new QuotaEngine({
      catalog: { providers: [provider], models: [] },
      emit: () => {
        throw new Error('schema failure');
      },
      onError,
    });
    engine.recordUsage(usage('quota-update-failure', '2026-06-01T09:59:00Z'));
    await vi.advanceTimersByTimeAsync(251);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'schema failure' }));
    engine.dispose();
  });

  it('persists request usage and rebuilds ledger records on restart', async () => {
    const db = await openDatabase(':memory:');
    const now = () => new Date('2026-06-01T10:00:00Z');
    const first = new QuotaEngine({
      requestRepository: new RequestRepository(db.client),
      observationRepository: new QuotaObservationRepository(db.client),
      now,
      catalog: { providers: [provider], models: [] },
    });
    first.recordUsage(usage('r1', '2026-06-01T09:59:00Z', { sessionId: 's1', taskId: 't1' }));
    expect(first.queryUsage({ providerId: 'gemini', sessionId: 's1', taskId: 't1' })).toHaveLength(
      1,
    );
    const restarted = new QuotaEngine({
      requestRepository: new RequestRepository(db.client),
      observationRepository: new QuotaObservationRepository(db.client),
      now,
      catalog: { providers: [provider], models: [] },
    });
    expect(restarted.queryUsage({ day: '2026-06-01' })).toHaveLength(1);
    expect(restarted.getWindows('gemini')[0]?.used).toBe(1);
    first.dispose();
    restarted.dispose();
    db.close();
  });

  it('learns an observed 429 ceiling from usage and holds it at zero remaining', () => {
    const engine = new QuotaEngine({
      now: () => new Date('2026-06-01T10:00:00Z'),
      catalog: { providers: [provider], models: [] },
    });
    engine.recordUsage(usage('1', '2026-06-01T09:59:00Z'));
    engine.recordUsage(usage('2', '2026-06-01T09:59:30Z'));
    const id = getWindow(engine, 'gemini').id;
    engine.observe({
      id: '429',
      providerId: 'gemini' as UsageRecord['providerId'],
      windowId: id,
      metric: 'requests',
      source: 'header',
      observedAt: '2026-06-01T10:00:00Z',
      statusCode: 429,
    });
    const window = getWindow(engine, 'gemini');
    expect(window.confidence).toBe('learned');
    expect(window.limit).toBe(2);
    expect(window.remaining).toBe(0);
    engine.dispose();
  });

  it('prioritizes endpoint snapshots over catalog and reports terminal provider health', () => {
    const engine = new QuotaEngine({
      now: () => new Date('2026-06-01T10:00:00Z'),
      catalog: { providers: [provider], models: [] },
    });
    const window = getWindow(engine, 'gemini');
    engine.observe({
      id: 'catalog',
      providerId: 'gemini' as UsageRecord['providerId'],
      windowId: window.id,
      metric: 'requests',
      limit: 4,
      remaining: 3,
      source: 'endpoint',
      observedAt: '2026-06-01T09:59:00Z',
      resetAt: '2026-06-01T10:01:00Z',
    });
    engine.observe({
      id: 'header',
      providerId: 'gemini' as UsageRecord['providerId'],
      windowId: window.id,
      metric: 'requests',
      limit: 1,
      remaining: 0,
      source: 'header',
      observedAt: '2026-06-01T10:00:00Z',
    });
    expect(engine.getWindows('gemini')[0]?.remaining).toBe(3);
    expect(engine.noteFailure('gemini', 'gemini/gemini-flash', 'key', 'auth_invalid').retry).toBe(
      false,
    );
    expect(engine.health('gemini', 'gemini/gemini-flash', 'key').health).toBe('auth_invalid');
    engine.dispose();
  });

  it('escalates 429 cooldowns and resets them after success', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T10:00:00Z'));
    const engine = new QuotaEngine({
      now: () => new Date(Date.now()),
      catalog: { providers: [provider], models: [] },
    });
    const durations: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = engine.noteFailure('gemini', 'm', 'key', '429');
      durations.push(Date.parse(result.cooldownUntil ?? '') - Date.now());
    }
    expect(durations).toEqual([10_000, 30_000, 60_000, 120_000]);
    engine.noteSuccess('gemini', 'm', 'key');
    expect(engine.health('gemini', 'm', 'key').health).toBe('ok');
    engine.dispose();
  });

  it('executes successful calls through the per-key circuit breaker', async () => {
    const engine = new QuotaEngine();
    await expect(
      engine.executeWithBreaker('p', 'm', 'k', async () => await Promise.resolve(42)),
    ).resolves.toBe(42);
    engine.dispose();
  });

  it('simulates capacity and resets across six providers, including a no-cap provider', () => {
    let instant = new Date('2026-03-08T10:00:00.000Z');
    const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const providers = ids.map((id, index) => ({
      ...provider,
      provider: id,
      windows:
        index === 5
          ? [
              {
                scope: 'provider' as const,
                metric: 'requests' as const,
                kind: 'rolling' as const,
                length: 60,
                limit: 40,
              },
              {
                scope: 'provider' as const,
                metric: 'requests' as const,
                kind: 'fixed_daily' as const,
                tz: 'UTC',
                limit: null,
              },
            ]
          : [
              {
                scope: 'provider' as const,
                metric: 'requests' as const,
                kind: 'fixed_daily' as const,
                tz: 'UTC',
                time: index === 4 ? '12:00' : index === 3 ? '11:00' : '00:00',
                limit: index === 4 || index === 3 ? 4 : 20,
              },
            ],
    }));
    const models = ids.map((id) => ({
      ref: `${id}/model` as ModelRef,
      providerId: id as UsageRecord['providerId'],
      name: id,
      tier: 'T1' as const,
      contextWindow: 8192,
      maxOutput: 4096,
      toolCalling: true,
      reasoning: false,
      free: true,
      priceInPerM: null,
      priceOutPerM: null,
    }));
    const engine = new QuotaEngine({
      now: () => instant,
      catalog: { providers, models },
      lowCapacityThreshold: 30,
    });
    ids.forEach((id, index) => {
      const count = index === 3 ? 3 : index === 4 ? 3 : index === 5 ? 2 : 4;
      for (let i = 0; i < count; i += 1) {
        engine.recordUsage(
          usage(`${id}-${String(i)}`, `2026-03-08T09:${String(i).padStart(2, '0')}:00Z`, {
            providerId: id as UsageRecord['providerId'],
            modelRef: `${id}/model`,
          }),
        );
      }
    });
    const before = engine.capacitySummary();
    expect(before.perProvider).toHaveLength(6);
    expect(before.perProvider.find((item) => item.providerId === 'zeta')?.stepsLeft).toBeNull();
    expect(before.banner?.text).toContain('delta');
    expect(before.nextResets.find((reset) => reset.providerId === 'delta')?.at).toBe(
      '2026-03-08T11:00:00.000Z',
    );
    instant = new Date('2026-03-09T00:01:00.000Z');
    expect(engine.getWindows('alpha')[0]?.used).toBe(0);
    expect(engine.getWindows('alpha')[0]?.resetAt).toBe('2026-03-10T00:00:00.000Z');
    engine.dispose();
  }, 20_000);

  it('prices uncached, cached, output, and off-peak usage in plan-dollar windows', () => {
    const paidProvider = {
      ...provider,
      provider: 'opencode-go',
      windows: [
        {
          scope: 'provider' as const,
          metric: 'usd' as const,
          kind: 'dynamic_5h' as const,
          limit: 12,
        },
      ],
    };
    const paidModel = {
      ref: 'opencode-go/model' as ModelRef,
      providerId: 'opencode-go' as UsageRecord['providerId'],
      name: 'Model',
      tier: 'T1' as const,
      contextWindow: 8192,
      maxOutput: 4096,
      toolCalling: true,
      reasoning: false,
      free: false,
      priceInPerM: 2,
      priceOutPerM: 4,
    };
    const engine = new QuotaEngine({
      now: () => new Date('2026-06-01T10:00:00Z'),
      catalog: { providers: [paidProvider], models: [paidModel] },
      planMultipliers: { 'opencode-go': { input: 1, output: 2, cached: 0.1, offPeak: 0.5 } },
    });
    engine.recordUsage(
      usage('priced', '2026-06-01T09:00:00Z', {
        providerId: 'opencode-go' as UsageRecord['providerId'],
        modelRef: 'opencode-go/model',
        inputTokens: 1_000_000,
        cachedTokens: 500_000,
        outputTokens: 250_000,
        headers: { offPeak: true },
      }),
    );
    expect(engine.getWindows('opencode-go')[0]?.used).toBeCloseTo(1.55);
    engine.dispose();
  });
});
