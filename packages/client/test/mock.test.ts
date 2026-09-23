/* eslint-disable @typescript-eslint/no-unused-expressions, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-empty-function, @typescript-eslint/no-unused-vars, @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';
import {
  CapacitySummarySchema,
  CheckpointSchema,
  DelegationRunSchema,
  LaneSchema,
  McpServerSchema,
  MessageSchema,
  ModelInfoSchema,
  OptimizerStatsSchema,
  ProfileSchema,
  ProviderSchema,
  SessionSchema,
  SettingsSchema,
  SkillSchema,
  TaskRecordSchema,
  WorkspaceSchema,
} from '@ferry/shared';
import { createMockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';
import { memoryStorage } from '../src/mock/storage.js';
import { createRng } from '../src/mock/rng.js';

describe('MockFerryClient', () => {
  it('seeds schema-valid fixtures and expected capacity', async () => {
    const fake = createFakeClock(new Date('2026-09-23T21:47:00.000Z'));
    const c = createMockFerryClient({ clock: fake.clock });
    const s = c.__state();
    s.workspaces.forEach((x) => WorkspaceSchema.parse(x));
    s.sessions.forEach((x) => SessionSchema.parse(x));
    s.providers.forEach((x) => ProviderSchema.parse(x));
    s.models.forEach((x) => ModelInfoSchema.parse(x));
    s.profiles.forEach((x) => ProfileSchema.parse(x));
    s.settings && SettingsSchema.parse(s.settings);
    s.checkpoints.forEach((x) => CheckpointSchema.parse(x));
    for (const rows of s.messages.values()) rows.forEach((x) => MessageSchema.parse(x));
    for (const x of s.taskRecords.values()) TaskRecordSchema.parse(x);
    s.lanes.forEach((x) => LaneSchema.parse(x));
    s.skills.forEach((x) => SkillSchema.parse(x));
    s.mcps.forEach((x) => McpServerSchema.parse(x));
    s.delegationRuns.forEach((x) => DelegationRunSchema.parse(x));
    OptimizerStatsSchema.parse(await c.optimizer.stats());
    const capacity = await c.quota.capacity();
    CapacitySummarySchema.parse(capacity);
    expect(capacity.stepsLeftToday).toBe(420);
    expect(capacity.percentRemaining).toBe(64);
    expect(capacity.banner?.text).toBe('Free capacity low — Gemini resets in 9h 13m');
  });
  it('recomputes capacity for eligibility and exhaustion', async () => {
    const client = createMockFerryClient();
    const providers = client.__state().providers;
    const openrouter = providers.find((provider) => provider.id === 'openrouter');
    expect(openrouter).toBeDefined();
    if (openrouter) openrouter.enabled = false;
    const reduced = await client.quota.capacity();
    expect(reduced.stepsLeftToday).toBe(108);
    expect(reduced.percentRemaining).toBe(39);
    for (const provider of providers) {
      if (provider.dailyStepBudget !== undefined) provider.stepsLeftToday = 0;
    }
    const empty = await client.quota.capacity();
    expect(empty.stepsLeftToday).toBe(0);
    expect(empty.percentRemaining).toBe(0);
    expect(empty.banner).not.toBeNull();
  });
  it('consumes steps, updates the request window, persists and emits capacity', async () => {
    const storage = memoryStorage();
    const client = createMockFerryClient({ storage });
    const provider = client.__state().providers.find((item) => item.id === 'gemini');
    expect(provider?.stepsLeftToday).toBe(38);
    if (!provider) throw new Error('Gemini fixture missing');
    const window = provider.windows.find((item) => item.metric === 'requests');
    expect(window?.used).toBe(212);
    let emitted = 0;
    client.on('quota.updated', () => emitted++);
    const summary = client.__store().consumeSteps(provider.id, 5);
    expect(summary.stepsLeftToday).toBe(415);
    expect(provider.stepsLeftToday).toBe(33);
    expect(window?.used).toBe(217);
    expect(emitted).toBe(1);
    expect((await createMockFerryClient({ storage }).quota.capacity()).stepsLeftToday).toBe(415);
  });
  it('persists user changes and recovers corrupted storage', async () => {
    const storage = memoryStorage();
    const c = createMockFerryClient({ storage });
    const w = (await c.workspaces.list())[0]!;
    const s = await c.sessions.create({ workspaceId: w.id, title: 'Persistent' });
    const restored = createMockFerryClient({ storage });
    expect((await restored.sessions.get(s.id)).session.title).toBe('Persistent');
    const broken = { load: () => ({ version: 1, data: { bad: true } }), save: () => {} };
    expect((await createMockFerryClient({ storage: broken }).sessions.list()).length).toBe(12);
  });
  it('exercises delegation lifecycle on the fake clock', async () => {
    const fake = createFakeClock(new Date('2026-09-23T00:00:00Z'));
    const c = createMockFerryClient({ clock: fake.clock });
    const s = (await c.sessions.list())[0]!;
    const run = await c.delegation.start({ sessionId: s.id, lane: 'impl', brief: 'Implement' });
    fake.advance(400);
    expect((await c.delegation.runs(s.id))[0]?.status).toBe('running');
    fake.advance(2400);
    const done = (await c.delegation.runs(s.id))[0]!;
    expect(DelegationRunSchema.parse(done).status).toBe('completed');
  });
  it('computes Pacific midnight across daylight saving changes', async () => {
    const spring = createMockFerryClient({
      clock: createFakeClock(new Date('2026-03-07T20:00:00Z')).clock,
    });
    const autumn = createMockFerryClient({
      clock: createFakeClock(new Date('2026-10-31T20:00:00Z')).clock,
    });
    const reset = (client: ReturnType<typeof createMockFerryClient>) =>
      client.__state().providers.find((p) => p.id === 'gemini')?.windows[0]?.resetAt;
    expect(reset(spring)).toBe('2026-03-08T08:00:00.000Z');
    expect(reset(autumn)).toBe('2026-11-01T07:00:00.000Z');
  });
  it('ranks free enabled candidates by tier and remaining steps', async () => {
    const client = createMockFerryClient();
    const session = (await client.sessions.list())[0];
    expect(session).toBeDefined();
    if (!session) return;
    const candidates = await client.models.candidates(session.id);
    expect(candidates[0]?.ref).toBe('openrouter/nvidia/nemotron-3-ultra:free');
    expect(candidates.filter((candidate) => candidate.selected)).toHaveLength(1);
  });
  it('applies live latency and deterministic injected errors', async () => {
    const fake = createFakeClock(new Date('2026-09-23T00:00:00Z'));
    const slow = createMockFerryClient({ clock: fake.clock, seed: 4, behavior: 'live' });
    await slow.settings.update({
      developer: { ...slow.__state().settings.developer, mockLatency: true },
    });
    const pending = slow.workspaces.list();
    fake.advance(400);
    expect(await pending).toHaveLength(3);
    let errorSeed = 1;
    while (createRng(errorSeed).next() >= 0.1) errorSeed++;
    const erroring = createMockFerryClient({ seed: errorSeed, behavior: 'live' });
    await erroring.settings.update({
      developer: { ...erroring.__state().settings.developer, injectErrors: true },
    });
    await expect(erroring.workspaces.list()).rejects.toMatchObject({ name: 'MockInjectedError' });
  });
});
