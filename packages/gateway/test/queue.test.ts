import { expect, it, vi } from 'vitest';
import { GatewayQueue } from '../src/queue.js';
it('bounds waiting, rotates across keys and obeys per-key concurrency', async () => {
  const queue = new GatewayQueue(1, 3),
    signal = new AbortController().signal;
  const first = await queue.acquire('a', 1, signal);
  const order: string[] = [];
  const a2 = queue.acquire('a', 1, signal).then((release) => {
    order.push('a2');
    return release;
  });
  const b = queue.acquire('b', 1, signal).then((release) => {
    order.push('b');
    return release;
  });
  const a3 = queue.acquire('a', 1, signal).then((release) => {
    order.push('a3');
    return release;
  });
  await expect(queue.acquire('c', 1, signal)).rejects.toThrow('full');
  first();
  const second = await a2;
  second();
  const other = await b;
  other();
  const last = await a3;
  last();
  expect(order).toEqual(['a2', 'b', 'a3']);
  expect(queue.state).toEqual({ active: 0, queued: 0 });
});
it('cancellation removes queued work without dispatch and shutdown settles waiters', async () => {
  const queue = new GatewayQueue(1, 2),
    controller = new AbortController();
  const release = await queue.acquire('a', 1, new AbortController().signal);
  const cancelled = queue.acquire('a', 1, controller.signal);
  const assertion = expect(cancelled).rejects.toThrow('deadline');
  controller.abort(new Error('deadline'));
  await assertion;
  expect(queue.state.queued).toBe(0);
  const pending = queue.acquire('b', 1, new AbortController().signal);
  const stopped = expect(pending).rejects.toThrow('stopped');
  queue.close();
  await stopped;
  release();
});
it('a saturated key does not prevent another key from using an available slot', async () => {
  const queue = new GatewayQueue(2, 4),
    signal = new AbortController().signal;
  const a = await queue.acquire('a', 1, signal);
  let dispatched = false;
  const waiting = queue.acquire('a', 1, signal).then((release) => {
    dispatched = true;
    return release;
  });
  const b = await queue.acquire('b', 1, signal);
  expect(dispatched).toBe(false);
  b();
  a();
  (await waiting)();
});
it('removes waiting work when its bounded request deadline expires', async () => {
  vi.useFakeTimers();
  try {
    const queue = new GatewayQueue(1, 4),
      signal = new AbortController().signal;
    const release = await queue.acquire('a', 1, signal),
      controller = new AbortController();
    const pending = queue.acquire('b', 1, controller.signal);
    const assertion = expect(pending).rejects.toThrow('timed out');
    setTimeout(() => {
      controller.abort(new Error('timed out'));
    }, 10);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(queue.state.queued).toBe(0);
    release();
  } finally {
    vi.useRealTimers();
  }
});
