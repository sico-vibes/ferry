import { describe, expect, it } from 'vitest';
import { createBackgroundQueue } from '../src/background-queue.js';
describe('background probe queue', () => {
  it('runs probes in parallel with a bound, and releases slots on failures', async () => {
    const queue = createBackgroundQueue(2);
    const releases: (() => void)[] = [];
    let running = 0;
    let maximum = 0;
    const work = Array.from({ length: 6 }, (_, index) =>
      queue(async () => {
        running++;
        maximum = Math.max(maximum, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running--;
        if (index === 1) throw new Error('probe failed');
        return index;
      }),
    );
    const settled = Promise.allSettled(work);
    expect(running).toBe(2);
    for (let index = 0; index < 6; index++) {
      while (!releases[index]) await Promise.resolve();
      releases[index]?.();
      await Promise.resolve();
    }
    expect((await settled).filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(maximum).toBe(2);
  });
});
