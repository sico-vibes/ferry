export class GatewayQueueError extends Error {
  readonly statusCode = 429;
  readonly code = 'queue_full';
}

interface Waiter {
  keyId: string;
  limit: number;
  grant: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
}

/** FIFO within each key, round-robin between keys, with bounded memory and dispatch. */
export class GatewayQueue {
  private active = new Map<string, number>();
  private waiting = new Map<string, Waiter[]>();
  private total = 0;
  private closed = false;
  constructor(
    private readonly concurrency = 16,
    private readonly capacity = 64,
  ) {}
  get state() {
    return {
      active: this.total,
      queued: [...this.waiting.values()].reduce((n, entries) => n + entries.length, 0),
    };
  }
  acquire(keyId: string, limit: number, signal: AbortSignal): Promise<() => void> {
    if (
      this.closed ||
      this.state.queued >= this.capacity ||
      (this.waiting.get(keyId)?.length ?? 0) >=
        Math.max(1, Math.min(8, Math.ceil(this.capacity / 2)))
    )
      return Promise.reject(
        new GatewayQueueError('Gateway queue is full or shutting down. Retry shortly.'),
      );
    if (signal.aborted)
      return Promise.reject(
        signal.reason instanceof Error ? signal.reason : new Error('Request cancelled.'),
      );
    return new Promise((grant, reject) => {
      const waiter: Waiter = {
        keyId,
        limit,
        signal,
        grant,
        reject,
        abort: () => {
          const entries = this.waiting.get(keyId);
          if (entries) {
            const index = entries.indexOf(waiter);
            if (index >= 0) entries.splice(index, 1);
            if (!entries.length) this.waiting.delete(keyId);
          }
          reject(signal.reason instanceof Error ? signal.reason : new Error('Request cancelled.'));
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      const entries = this.waiting.get(keyId) ?? [];
      entries.push(waiter);
      this.waiting.set(keyId, entries);
      this.pump();
    });
  }
  close() {
    this.closed = true;
    for (const entries of this.waiting.values())
      for (const waiter of entries) {
        waiter.signal.removeEventListener('abort', waiter.abort);
        waiter.reject(new GatewayQueueError('Gateway stopped before dispatch.'));
      }
    this.waiting.clear();
  }
  private pump() {
    while (this.total < this.concurrency) {
      const found = [...this.waiting].find(
        ([key, entries]) => entries[0] && (this.active.get(key) ?? 0) < entries[0].limit,
      );
      if (!found) return;
      const [key, entries] = found;
      const waiter = entries.shift();
      this.waiting.delete(key);
      if (entries.length) this.waiting.set(key, entries);
      if (!waiter) continue;
      waiter.signal.removeEventListener('abort', waiter.abort);
      this.total++;
      this.active.set(key, (this.active.get(key) ?? 0) + 1);
      let released = false;
      waiter.grant(() => {
        if (released) return;
        released = true;
        this.total--;
        const count = (this.active.get(key) ?? 1) - 1;
        if (count) this.active.set(key, count);
        else this.active.delete(key);
        this.pump();
      });
    }
  }
}
