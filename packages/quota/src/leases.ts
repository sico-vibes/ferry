export interface QuotaLease {
  id: string;
  pool: string;
  requests: number;
  tokens: number;
  expiresAt: number;
}

/** In-memory reservations close the check-then-send race across concurrent agent runs. */
export class QuotaLeaseLedger {
  private readonly leases = new Map<string, QuotaLease>();
  private sequence = 0;

  acquire(
    pool: string,
    request: { requests: number; tokens: number },
    capacity: { requests: number | null; tokens: number | null },
    now: number,
    ttlMs = 120_000,
  ): QuotaLease | undefined {
    this.expire(now);
    const held = [...this.leases.values()].filter((lease) => lease.pool === pool);
    const requests = held.reduce((sum, lease) => sum + lease.requests, 0);
    const tokens = held.reduce((sum, lease) => sum + lease.tokens, 0);
    if (
      (capacity.requests !== null && requests + request.requests > capacity.requests) ||
      (capacity.tokens !== null && tokens + request.tokens > capacity.tokens)
    )
      return undefined;
    const lease = {
      id: `${pool}:${String(++this.sequence)}`,
      pool,
      ...request,
      expiresAt: now + ttlMs,
    };
    this.leases.set(lease.id, lease);
    return lease;
  }

  release(id: string): void {
    this.leases.delete(id);
  }

  private expire(now: number): void {
    for (const [id, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(id);
  }
}
