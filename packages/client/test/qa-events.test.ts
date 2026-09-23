import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint } from '@ferry/shared';
import { createMockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';
import { FerryEventSchemas } from '../src/events.js';
import type { FerryEvents } from '../src/events.js';

const now = new Date('2026-09-23T21:47:00.000Z');
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe('QA event emitter', () => {
  it('isolates throwing handlers and unsubscribes cleanly', async () => {
    const client = createMockFerryClient({ clock: createFakeClock(now).clock });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const session = (await client.sessions.list())[0];
    if (!session) throw new Error('Session fixture missing');

    let second = 0;
    const offFirst = client.on('session.updated', () => {
      throw new Error('boom');
    });
    const offSecond = client.on('session.updated', () => {
      second++;
    });

    await client.sessions.setStarred(session.id, true);
    expect(second).toBe(1);

    offFirst();
    offSecond();
    await client.sessions.setStarred(session.id, false);
    expect(second).toBe(1);
    errorSpy.mockRestore();
  });

  it('emits payloads that validate against FerryEventSchemas', async () => {
    const fake = createFakeClock(now);
    const client = createMockFerryClient({ clock: fake.clock, behavior: 'test' });
    const seen: { event: keyof FerryEvents; payload: unknown }[] = [];
    for (const event of Object.keys(FerryEventSchemas) as (keyof FerryEvents)[]) {
      client.on(event, (payload: unknown) => seen.push({ event, payload }));
    }

    const session = (await client.sessions.list())[0];
    const provider = (await client.providers.list()).find((item) => item.keyStatus === 'missing');
    const gemini = client.__state().providers.find((item) => item.id === 'gemini');
    if (!session || !provider || !gemini) throw new Error('Fixtures missing');

    let checkpoint: Checkpoint | undefined;
    for (const candidate of await client.sessions.list()) {
      const list = await client.checkpoints.list(candidate.id);
      if (list[0]) {
        checkpoint = list[0];
        break;
      }
    }
    if (!checkpoint) throw new Error('Checkpoint fixture missing');

    await client.sessions.setStarred(session.id, true);
    await client.sessions.send(session.id, { text: 'events' });
    fake.advance(600);
    await flush();
    fake.advance(150);
    await flush();
    fake.advance(150);
    await flush();
    fake.advance(150);
    await flush();
    await client.providers.setKey(provider.id, 'demo-key');
    client.__store().consumeSteps(gemini.id, 1);
    await client.delegation.start({ sessionId: session.id, lane: 'impl', brief: 'events' });
    await client.checkpoints.restore(checkpoint.id);

    expect(seen.length).toBeGreaterThan(0);
    for (const { event, payload } of seen) {
      const result = FerryEventSchemas[event].safeParse(payload);
      expect(result.success, `${event} payload should validate`).toBe(true);
    }
    const emitted = new Set(seen.map((entry) => entry.event));
    expect(emitted).toContain('quota.updated');
    expect(emitted).toContain('provider.updated');
    expect(emitted).toContain('delegation.updated');
    expect(emitted).toContain('session.message');
    expect(emitted).toContain('toast');
  });
});
