interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Small TTL cache that coalesces concurrent loads and skips empty fallback values. */
export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly pending = new Map<string, Promise<T>>();
  private readonly keyVersions = new Map<string, number>();
  private version = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async getOrLoad(
    key: string,
    ttlMs: number,
    load: () => Promise<T> | T,
    cacheable: (value: T) => boolean = (value) => value !== undefined,
  ): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    if (cached) this.entries.delete(key);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const operation = Promise.resolve().then(load);
    const version = `${String(this.version)}:${String(this.keyVersions.get(key) ?? 0)}`;
    this.pending.set(key, operation);
    try {
      const value = await operation;
      const currentVersion = `${String(this.version)}:${String(this.keyVersions.get(key) ?? 0)}`;
      if (version === currentVersion && ttlMs > 0 && cacheable(value))
        this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
      return value;
    } finally {
      if (this.pending.get(key) === operation) this.pending.delete(key);
    }
  }

  invalidate(key?: string): void {
    if (key === undefined) {
      this.version += 1;
      this.entries.clear();
      this.pending.clear();
      this.keyVersions.clear();
    } else {
      this.keyVersions.set(key, (this.keyVersions.get(key) ?? 0) + 1);
      this.entries.delete(key);
      this.pending.delete(key);
    }
  }
}
