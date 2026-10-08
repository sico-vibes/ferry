import {
  ProviderHealthSnapshotSchema,
  redactKnownSecretText,
  type ProviderHealthSnapshot,
} from '@ferry/shared';

interface State {
  breaker: ProviderHealthSnapshot['breaker'];
  openedAt: number | null;
  nextProbeAt: number | null;
  lastError: string | null;
  keys: Map<string, { until: number; reason: string }>;
  models: Map<string, { until: number; reason: string }>;
  samples: { at: number; latency: number; ok: boolean }[];
}
export interface HealthOutcome {
  providerId: string;
  keyId?: string | undefined;
  modelRef?: string | undefined;
  status?: number | null | undefined;
  message?: string | undefined;
  retryAfter?: string | undefined;
  latencyMs?: number | undefined;
  success: boolean;
}

/** Pure, clock-injected resilience state. Only background probes acquire half-open leases. */
export class ProviderHealthTracker {
  private readonly states = new Map<string, State>();
  constructor(
    private readonly options: {
      now?: () => number;
      probeAfterMs?: number;
      modelLockoutMs?: number;
      onChange?: (health: ProviderHealthSnapshot) => void;
    } = {},
  ) {}
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private state(id: string): State {
    let state = this.states.get(id);
    if (!state) {
      state = {
        breaker: 'closed',
        openedAt: null,
        nextProbeAt: null,
        lastError: null,
        keys: new Map(),
        models: new Map(),
        samples: [],
      };
      this.states.set(id, state);
    }
    return state;
  }
  available(providerId: string, modelRef?: string, keyId?: string): boolean {
    const state = this.state(providerId);
    const now = this.now();
    return (
      state.breaker === 'closed' &&
      (!modelRef || (state.models.get(modelRef)?.until ?? 0) <= now) &&
      (!keyId || (state.keys.get(keyId)?.until ?? 0) <= now)
    );
  }
  beginProbe(providerId: string): boolean {
    const state = this.state(providerId);
    if (state.breaker !== 'open' || (state.nextProbeAt ?? Infinity) > this.now()) return false;
    state.breaker = 'half_open';
    this.options.onChange?.(this.snapshot(providerId));
    return true;
  }
  record(outcome: HealthOutcome): void {
    const state = this.state(outcome.providerId);
    const now = this.now();
    state.samples = state.samples.filter((sample) => now - sample.at < 3_600_000);
    state.samples.push({
      at: now,
      latency: Math.max(0, outcome.latencyMs ?? 0),
      ok: outcome.success,
    });
    const reason = redactKnownSecretText(
      outcome.message ?? `HTTP ${String(outcome.status ?? 'network timeout')}`,
    );
    if (outcome.success) {
      state.breaker = 'closed';
      state.openedAt = null;
      state.nextProbeAt = null;
      state.lastError = null;
    } else {
      state.lastError = reason;
      if (
        outcome.status === 408 ||
        (outcome.status ?? 0) >= 500 ||
        (!outcome.status &&
          /timeout|timed out|network|fetch failed|socket|ECONN|ENOTFOUND|could not reach provider|connection/i.test(
            reason,
          ))
      ) {
        state.breaker = 'open';
        state.openedAt = now;
        state.nextProbeAt = now + (this.options.probeAfterMs ?? 60_000);
      } else if (state.breaker === 'half_open') {
        // The server answered; auth, quota and model failures do not hold its breaker open.
        state.breaker = 'closed';
        state.openedAt = null;
        state.nextProbeAt = null;
      }
      if (outcome.status === 429 && outcome.keyId) {
        const seconds = Number(outcome.retryAfter);
        const date = Date.parse(outcome.retryAfter ?? '');
        const until =
          outcome.retryAfter !== undefined && Number.isFinite(seconds)
            ? now + Math.max(0, seconds) * 1000
            : Number.isFinite(date)
              ? Math.max(now, date)
              : now + 60_000;
        state.keys.set(outcome.keyId, { until, reason });
      }
      if (
        outcome.modelRef &&
        (outcome.status === 404 ||
          /model_not_found/i.test(reason) ||
          (outcome.status === 400 && /model.{0,60}not supported/i.test(reason)))
      )
        state.models.set(outcome.modelRef, {
          until: now + (this.options.modelLockoutMs ?? 6 * 3_600_000),
          reason,
        });
    }
    this.options.onChange?.(this.snapshot(outcome.providerId));
  }
  discovered(providerId: string): void {
    this.state(providerId).models.clear();
    this.options.onChange?.(this.snapshot(providerId));
  }
  snapshot(providerId: string, keyIds: readonly string[] = []): ProviderHealthSnapshot {
    const state = this.state(providerId);
    const now = this.now();
    const samples = state.samples.filter((sample) => now - sample.at < 3_600_000);
    const latencies = samples
      .filter((sample) => sample.ok)
      .map((sample) => sample.latency)
      .sort((a, b) => a - b);
    const percentile = (p: number) =>
      latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] ?? null;
    const keys = [...new Set([...keyIds, ...state.keys.keys()])].map((keyId) => {
      const cooldown = state.keys.get(keyId);
      return {
        keyId,
        cooldownUntil:
          cooldown && cooldown.until > now ? new Date(cooldown.until).toISOString() : null,
        reason: cooldown && cooldown.until > now ? cooldown.reason : null,
      };
    });
    const lockedModels = [...state.models]
      .filter(([, lock]) => lock.until > now)
      .map(([ref, lock]) => ({
        ref,
        until: new Date(lock.until).toISOString(),
        reason: lock.reason,
      }));
    return ProviderHealthSnapshotSchema.parse({
      providerId,
      state:
        state.breaker !== 'closed'
          ? 'down'
          : keys.some((key) => key.cooldownUntil) || lockedModels.length || state.lastError
            ? 'degraded'
            : 'healthy',
      breaker: state.breaker,
      openedAt: state.openedAt === null ? null : new Date(state.openedAt).toISOString(),
      nextProbeAt: state.nextProbeAt === null ? null : new Date(state.nextProbeAt).toISOString(),
      lastError: state.lastError,
      keys,
      lockedModels,
      latencyP50Ms: percentile(0.5),
      latencyP95Ms: percentile(0.95),
      successRate1h: samples.length
        ? samples.filter((sample) => sample.ok).length / samples.length
        : null,
    });
  }
}
