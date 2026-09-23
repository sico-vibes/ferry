/* eslint-disable @typescript-eslint/require-await */
import { runFerryClientContract } from '../src/testing/contract.js';
import { createMockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';

runFerryClientContract('MockFerryClient', async () => {
  const fake = createFakeClock(new Date('2026-09-23T21:47:00.000Z'));
  return {
    client: createMockFerryClient({ clock: fake.clock, behavior: 'test' }),
    advance: async (ms) => {
      fake.advance(ms);
    },
  };
});
