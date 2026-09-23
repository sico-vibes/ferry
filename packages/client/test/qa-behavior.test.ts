import { describe, expect, it } from 'vitest';
import { createMockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';
import { MockInjectedError } from '../src/mock/behavior.js';

const now = new Date('2026-09-23T21:47:00.000Z');
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const enable = async (
  client: ReturnType<typeof createMockFerryClient>,
  patch: Partial<{ mockLatency: boolean; injectErrors: boolean }>,
) => {
  const settings = await client.settings.get();
  await client.settings.update({ developer: { ...settings.developer, ...patch } });
};

describe('QA mock behavior injection', () => {
  it('rejects roughly 10% of live calls with MockInjectedError', async () => {
    const client = createMockFerryClient({
      seed: 12345,
      behavior: 'live',
      clock: createFakeClock(now).clock,
    });
    await enable(client, { injectErrors: true });

    let errors = 0;
    for (let i = 0; i < 1000; i++) {
      try {
        await client.providers.list();
      } catch (error) {
        if (error instanceof MockInjectedError) errors++;
        else throw error;
      }
    }
    expect(errors).toBeGreaterThanOrEqual(50);
    expect(errors).toBeLessThanOrEqual(150);
  });

  it('keeps simulated latency within 50-400ms', async () => {
    const fake = createFakeClock(now);
    const client = createMockFerryClient({ seed: 777, behavior: 'live', clock: fake.clock });
    await enable(client, { mockLatency: true });

    for (let i = 0; i < 20; i++) {
      const start = fake.clock.now().getTime();
      const status = { settled: false };
      void client.providers.list().then(() => {
        status.settled = true;
      });
      let elapsed = 0;
      while (!status.settled && elapsed < 1000) {
        fake.advance(1);
        elapsed++;
        await flush();
      }
      expect(status.settled).toBe(true);
      const measured = fake.clock.now().getTime() - start;
      expect(measured).toBeGreaterThanOrEqual(50);
      expect(measured).toBeLessThanOrEqual(400);
    }
  });
});
