import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CapacitySummarySchema,
  ModelRefSchema,
  ProviderIdSchema,
  type ModelInfo,
  type UsageRecord,
} from '@ferry/shared';
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
      kind: 'fixed_daily' as const,
      tz: 'UTC',
      limit: 20,
    },
  ],
};

const model: ModelInfo = {
  ref: ModelRefSchema.parse('gemini/gemini-flash'),
  providerId: ProviderIdSchema.parse('gemini'),
  name: 'Flash',
  tier: 'T1',
  contextWindow: 100_000,
  maxOutput: 8_000,
  toolCalling: true,
  reasoning: false,
  free: true,
  priceInPerM: null,
  priceOutPerM: null,
};

const record = (occurredAt: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  id: occurredAt,
  providerId: 'gemini' as UsageRecord['providerId'],
  modelRef: 'gemini/gemini-flash',
  occurredAt,
  status: 'success',
  inputTokens: 1,
  outputTokens: 1,
  ...extra,
});

const engines: QuotaEngine[] = [];
function makeEngine(options: ConstructorParameters<typeof QuotaEngine>[0] = {}): QuotaEngine {
  const engine = new QuotaEngine({ now: () => new Date('2026-06-01T10:00:00Z'), ...options });
  engines.push(engine);
  return engine;
}
afterEach(() => {
  vi.useRealTimers();
  while (engines.length) engines.pop()?.dispose();
});

describe('QA-w2 quota: 429 cooldown escalation', () => {
  it('escalates the cooldown delay on consecutive 429s without retry-after', () => {
    let current = Date.parse('2026-06-01T10:00:00Z');
    const engine = makeEngine({ now: () => new Date(current) });
    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = engine.noteFailure('openai', 'openai/gpt-5.4', 'key-1', '429');
      delays.push(Date.parse(result.cooldownUntil ?? '') - current);
      current += 1_000;
    }
    expect(delays).toEqual([10_000, 30_000, 60_000, 120_000, 120_000]);
  });

  it('never schedules a 429 cooldown before a provider-supplied reset time', () => {
    const current = Date.parse('2026-06-01T10:00:00Z');
    const engine = makeEngine({ now: () => new Date(current) });
    const resetAt = new Date(current + 3_600_000).toISOString();
    const result = engine.noteFailure('openai', 'openai/gpt-5.4', 'key-1', '429', resetAt);
    expect(Date.parse(result.cooldownUntil ?? '')).toBeGreaterThanOrEqual(Date.parse(resetAt));
    expect(result.retry).toBe(true);
  });

  it('treats auth_invalid and account_disabled as terminal and time-independent', () => {
    let current = Date.parse('2026-06-01T10:00:00Z');
    const engine = makeEngine({ now: () => new Date(current) });
    expect(engine.noteFailure('openai', 'openai/gpt-5.4', 'key-1', 'auth_invalid')).toEqual({
      health: 'auth_invalid',
      cooldownUntil: null,
      retry: false,
    });
    current += 30 * 86_400_000;
    expect(engine.health('openai', 'openai/gpt-5.4', 'key-1')).toMatchObject({
      health: 'auth_invalid',
      retry: false,
    });
    const disabled = engine.noteFailure(
      'gemini',
      'gemini/gemini-flash',
      'key-2',
      'account_disabled',
    );
    expect(disabled.health).toBe('account_disabled');
  });

  it('clears a transient cooldown on the next success and reports ok afterwards', () => {
    let current = Date.parse('2026-06-01T10:00:00Z');
    const engine = makeEngine({ now: () => new Date(current) });
    engine.noteFailure('openai', 'openai/gpt-5.4', 'key-1', '429');
    expect(engine.health('openai', 'openai/gpt-5.4', 'key-1').health).toBe('cooldown');
    engine.noteSuccess('openai', 'openai/gpt-5.4', 'key-1');
    expect(engine.health('openai', 'openai/gpt-5.4', 'key-1').health).toBe('ok');
    current += 1_000_000;
    expect(engine.health('openai', 'openai/gpt-5.4', 'key-1').health).toBe('ok');
  });
});

describe('QA-w2 quota: capacity invariants', () => {
  it('reports a schema-valid 100 percent summary for zero data', () => {
    const engine = makeEngine({ catalog: { providers: [provider], models: [model] } });
    const summary = engine.capacitySummary();
    expect(CapacitySummarySchema.safeParse(summary).success).toBe(true);
    expect(summary.percentRemaining).toBe(100);
    expect(summary.stepsLeftToday).toBe(20);
  });

  it('never lets an over-reporting header push percentRemaining outside [0,100]', () => {
    // BUG: capacitySummary() computes percent = remaining / max(1, limit) without
    // clamping, so an authoritative observation whose remaining exceeds its limit
    // yields percentRemaining > 100. The core quota domain then fails to parse the
    // summary (CapacitySummarySchema max is 100), which turns quota.capacity and the
    // quota.updated event into validation errors.
    const engine = makeEngine({ catalog: { providers: [provider], models: [] } });
    const windowId = engine.getWindows('gemini')[0]?.id;
    if (!windowId) throw new Error('no window definition');
    engine.observe({
      id: 'surprise-header',
      providerId: 'gemini' as UsageRecord['providerId'],
      windowId,
      metric: 'requests',
      source: 'header',
      observedAt: '2026-06-01T10:00:00Z',
      limit: 20,
      remaining: 500,
    });
    const summary = engine.capacitySummary();
    expect(summary.percentRemaining).toBeLessThanOrEqual(100);
    expect(CapacitySummarySchema.safeParse(summary).success).toBe(true);
  });

  it('never reports negative steps or a non-finite percent', () => {
    const engine = makeEngine({ catalog: { providers: [provider], models: [model] } });
    for (let i = 0; i < 25; i += 1)
      engine.recordUsage(record('2026-06-01T09:00:00Z', { id: `usage-${String(i)}` }));
    const summary = engine.capacitySummary();
    expect(CapacitySummarySchema.safeParse(summary).success).toBe(true);
    const steps = engine.stepsLeft('gemini', model.ref);
    expect(steps === null || steps >= 0).toBe(true);
    for (const entry of summary.perProvider) {
      expect(entry.percent === null || Number.isFinite(entry.percent)).toBe(true);
      expect(entry.stepsLeft === null || Number.isFinite(entry.stepsLeft)).toBe(true);
    }
  });
});

describe('QA-w2 quota: quota.updated debounce', () => {
  it('emits exactly one debounced event for a burst and one per later burst', async () => {
    vi.useFakeTimers();
    const events: { type: string }[] = [];
    const engine = makeEngine({ emit: (event) => events.push(event) });
    for (let i = 0; i < 50; i += 1)
      engine.recordUsage(record('2026-06-01T09:30:00Z', { id: `burst-${String(i)}` }));
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(260);
    expect(events).toHaveLength(1);
    for (let i = 0; i < 10; i += 1)
      engine.recordUsage(record('2026-06-01T09:40:00Z', { id: `later-${String(i)}` }));
    await vi.advanceTimersByTimeAsync(260);
    expect(events).toHaveLength(2);
  });

  it('does not emit before the debounce window elapses', async () => {
    vi.useFakeTimers();
    const events: { type: string }[] = [];
    const engine = makeEngine({ emit: (event) => events.push(event) });
    engine.recordUsage(record('2026-06-01T09:30:00Z', { id: 'one' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toHaveLength(1);
  });
});

describe('QA-w2 quota: OpenRouter polling lifecycle', () => {
  it('keeps polling after usage is recorded', async () => {
    // BUG: recordUsage()/observe() call scheduleResets(), which clears every timer in
    // engine.timers -- including the OpenRouter polling timer registered by
    // startOpenRouterPolling(). Under normal traffic the poll timer is constantly
    // cancelled, so OpenRouter quota polling effectively never runs.
    vi.useFakeTimers();
    const engine = makeEngine();
    const poll = vi.fn(() => Promise.resolve());
    engine.startOpenRouterPolling(poll);
    engine.recordUsage(record('2026-06-01T09:30:00Z', { id: 'cancel-poll' }));
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(poll).toHaveBeenCalled();
  });

  it('stops polling when the returned stop handle is invoked', async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const poll = vi.fn(() => Promise.resolve());
    const stop = engine.startOpenRouterPolling(poll);
    stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(poll).not.toHaveBeenCalled();
  });

  it('does not poll while the provider is disabled', async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const poll = vi.fn(() => Promise.resolve());
    engine.startOpenRouterPolling(poll, () => false);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(poll).not.toHaveBeenCalled();
  });

  it('reschedules the next poll after each completed poll', async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const poll = vi.fn(() => Promise.resolve());
    engine.startOpenRouterPolling(poll);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});

describe('QA-w2 quota: window reset boundaries', () => {
  it('resets a fixed-daily window exactly at the boundary instant', () => {
    let current = Date.parse('2026-06-01T23:59:30Z');
    const engine = makeEngine({
      now: () => new Date(current),
      catalog: { providers: [provider], models: [] },
    });
    engine.recordUsage(record('2026-06-01T12:00:00Z', { id: 'before-midnight' }));
    expect(engine.getWindows('gemini')[0]?.used).toBe(1);
    current = Date.parse('2026-06-01T23:59:59.999Z');
    expect(engine.getWindows('gemini')[0]?.used).toBe(1);
    current = Date.parse('2026-06-02T00:00:00.000Z');
    expect(engine.getWindows('gemini')[0]?.used).toBe(0);
  });

  it('fires the scheduled reset timer at the boundary and emits a debounced update', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T23:59:50.000Z'));
    const events: { type: string }[] = [];
    makeEngine({
      now: () => new Date(),
      catalog: { providers: [provider], models: [] },
      emit: (event) => events.push(event),
    });
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(events).toHaveLength(1);
  });
});
