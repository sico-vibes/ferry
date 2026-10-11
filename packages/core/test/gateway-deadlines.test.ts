import { afterEach, expect, it, vi } from 'vitest';
import { withGatewayDeadlines } from '../src/gateway-deadlines.js';

afterEach(() => vi.useRealTimers());
for (const mode of ['first', 'idle', 'overall'] as const) {
  it(`terminates a stalled ${mode} deadline and aborts its adapter`, async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const task = withGatewayDeadlines(
      {
        signal: new AbortController().signal,
        firstResponseMs: mode === 'first' ? 10 : 100,
        idleMs: mode === 'idle' ? 10 : 100,
        overallMs: mode === 'overall' ? 10 : 100,
      },
      (adapterSignal, progress) => {
        signal = adapterSignal;
        if (mode !== 'first') progress();
        return new Promise(() => undefined);
      },
    );
    const failure = expect(task).rejects.toMatchObject({ code: 'request_timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await failure;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
}
it('handles disconnects and never leaves timers behind', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const task = withGatewayDeadlines(
    { signal: controller.signal, firstResponseMs: 20, idleMs: 20, overallMs: 100 },
    () => new Promise(() => undefined),
  );
  const failure = expect(task).rejects.toThrow('Disconnected');
  controller.abort(new Error('Disconnected'));
  await failure;
  expect(vi.getTimerCount()).toBe(0);
});
