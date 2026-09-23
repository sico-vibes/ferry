import { describe, expect, it } from 'vitest';
import type { DelegationRun } from '@ferry/shared';
import { createMockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';

const now = new Date('2026-09-23T21:47:00.000Z');

const setup = async () => {
  const fake = createFakeClock(now);
  const client = createMockFerryClient({ clock: fake.clock, behavior: 'test' });
  const session = (await client.sessions.list())[0];
  if (!session) throw new Error('Session fixture missing');
  return { fake, client, sessionId: session.id };
};

describe('QA delegation lifecycle', () => {
  it('runs queued -> running -> 3 progress lines -> completed on the fake clock', async () => {
    const { fake, client, sessionId } = await setup();
    const run = await client.delegation.start({ sessionId, lane: 'impl', brief: 'Implement it' });
    expect(run.status).toBe('queued');

    const statuses: DelegationRun['status'][] = [];
    client.on('delegation.updated', (updated) => statuses.push(updated.status));

    fake.advance(400);
    let current = (await client.delegation.runs(sessionId))[0];
    expect(current?.status).toBe('running');
    expect(current?.progress).toHaveLength(1);

    fake.advance(800);
    current = (await client.delegation.runs(sessionId))[0];
    expect(current?.progress).toHaveLength(2);

    fake.advance(800);
    current = (await client.delegation.runs(sessionId))[0];
    expect(current?.progress).toHaveLength(3);
    expect(current?.status).toBe('running');

    fake.advance(800);
    current = (await client.delegation.runs(sessionId))[0];
    expect(current?.status).toBe('completed');
    expect(current?.progress).toHaveLength(4);
    expect(current?.finishedAt).not.toBeNull();
    expect(current?.gateResults).toHaveLength(2);
    expect(statuses.at(-1)).toBe('completed');
  });

  it('cancels mid-run without further updates', async () => {
    const { fake, client, sessionId } = await setup();
    const run = await client.delegation.start({ sessionId, lane: 'impl', brief: 'Cancel me' });

    const updates: number[] = [];
    client.on('delegation.updated', () => updates.push(1));

    fake.advance(400);
    const progressBefore = (await client.delegation.runs(sessionId))[0]?.progress.length ?? 0;
    await client.delegation.cancel(run.id);
    expect((await client.delegation.runs(sessionId))[0]?.status).toBe('cancelled');

    const count = updates.length;
    fake.advance(100_000);
    const after = (await client.delegation.runs(sessionId))[0];
    expect(updates.length).toBe(count);
    expect(after?.status).toBe('cancelled');
    expect(after?.progress.length).toBe(progressBefore);
  });

  it('decide rework restarts a shorter cycle', async () => {
    const { fake, client, sessionId } = await setup();
    const run = await client.delegation.start({ sessionId, lane: 'impl', brief: 'Rework me' });

    fake.advance(2800);
    expect((await client.delegation.runs(sessionId))[0]?.status).toBe('completed');

    const reworked = await client.delegation.decide(run.id, 'rework');
    expect(reworked.status).toBe('running');
    expect(reworked.finishedAt).toBeNull();
    expect(reworked.decision).toBe('rework');
    const progressBefore = reworked.progress.length;

    fake.advance(800);
    const after = (await client.delegation.runs(sessionId))[0];
    expect(after?.status).toBe('completed');
    expect(after?.progress.length).toBe(progressBefore);
  });
});
