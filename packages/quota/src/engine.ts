import {
  circuitBreaker,
  CountBreaker,
  Policy,
  CircuitState,
  type CircuitBreakerPolicy,
} from 'cockatiel';
import type {
  CapacitySummary,
  ProviderHealth,
  QuotaObservation,
  QuotaWindow,
  UsageRecord,
} from '@ferry/shared';
import { ProviderErrorKindSchema } from '@ferry/shared';
import { newId } from '@ferry/shared';
import { ProviderLimitsSchema, type Catalog, type ProviderLimits } from '@ferry/catalog';
import { QuotaObservationRepository, RequestRepository } from '@ferry/storage';
import { nextReset, remaining, usageIn, windowStart, type WindowSpec } from './windows.js';

type EventListener = (event: { type: 'quota.updated'; summary: CapacitySummary }) => void;
type Source = QuotaObservation['source'];
const confidence: Record<Source, QuotaWindow['confidence']> = {
  endpoint: 'exact',
  header: 'exact',
  learned: 'learned',
  catalog: 'estimated',
};
const rank: Record<Source, number> = { catalog: 0, learned: 1, header: 2, endpoint: 3 };

interface ExtendedWindow {
  kind: WindowSpec['kind'];
  tz?: string;
  time?: string;
  dow?: number;
  day?: number;
  length?: number;
  id: string;
  scope: 'provider' | 'model';
  model?: string;
  metric: QuotaWindow['metric'];
  limit: number | null;
}
export interface QuotaEngineOptions {
  catalog?: Pick<Catalog, 'providers' | 'models'>;
  requestRepository?: RequestRepository;
  observationRepository?: QuotaObservationRepository;
  now?: () => Date;
  emit?: EventListener;
  lowCapacityThreshold?: number;
  planMultipliers?: Record<
    string,
    { input?: number; output?: number; cached?: number; offPeak?: number }
  >;
}
export interface UsageQuery {
  providerId?: string;
  modelRef?: string;
  day?: string;
  sessionId?: string;
  taskId?: string;
}
interface LearnedLimit {
  limit: number;
  observedAt: number;
  expiresAt: number;
}
interface Cooldown {
  until: number;
  failures: number;
  terminal?: 'auth_invalid' | 'account_disabled';
}

function sourceFor(observation: QuotaObservation): Source {
  return observation.source;
}
function asWindowSpec(window: ExtendedWindow): WindowSpec {
  switch (window.kind) {
    case 'rolling':
      return { kind: 'rolling', length: window.length ?? 60 };
    case 'fixed_daily':
      return {
        kind: 'fixed_daily',
        tz: window.tz ?? 'UTC',
        time: (window as ExtendedWindow & { time?: string }).time ?? '00:00',
      };
    case 'weekly_fixed':
      return {
        kind: 'weekly_fixed',
        tz: window.tz ?? 'UTC',
        dow: (window as ExtendedWindow & { dow?: number }).dow ?? 1,
        time: (window as ExtendedWindow & { time?: string }).time ?? '00:00',
      };
    case 'weekly_from_first_use':
      return { kind: 'weekly_from_first_use', tz: window.tz ?? 'UTC' };
    case 'monthly_from_anchor':
      return {
        kind: 'monthly_from_anchor',
        tz: window.tz ?? 'UTC',
        day: (window as ExtendedWindow & { day?: number }).day ?? 1,
      };
    case 'dynamic_5h':
      return { kind: 'dynamic_5h' };
  }
}

export class QuotaEngine {
  private readonly now: () => Date;
  private readonly requestRepo?: RequestRepository;
  private readonly observations: QuotaObservationRepository | undefined;
  private readonly records = new Map<string, UsageRecord>();
  private readonly snapshots = new Map<string, QuotaObservation>();
  private readonly learned = new Map<string, LearnedLimit>();
  private readonly cooldowns = new Map<string, Cooldown>();
  private readonly breakers = new Map<string, CircuitBreakerPolicy>();
  private readonly averages = new Map<string, { tokens: number; cost: number; samples: number }>();
  private readonly listeners = new Set<EventListener>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly providers: ProviderLimits[];
  private readonly models: Catalog['models'];
  private readonly lowThreshold: number;
  private readonly multipliers: NonNullable<QuotaEngineOptions['planMultipliers']>;

  constructor(private readonly options: QuotaEngineOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.providers = options.catalog?.providers ?? [];
    this.models = options.catalog?.models ?? [];
    this.lowThreshold = options.lowCapacityThreshold ?? 20;
    this.multipliers = options.planMultipliers ?? {};
    if (options.requestRepository) {
      this.requestRepo = options.requestRepository;
      this.observations = options.observationRepository;
      for (const row of this.requestRepo.list()) {
        const record = this.fromRow(row as unknown as Record<string, unknown>);
        this.records.set(record.id, record);
        if (record.stepKind) this.updateAverage(record);
      }
      for (const observation of this.observations?.list() ?? []) {
        this.snapshots.set(
          this.key(observation.providerId, observation.windowId, observation.modelRef ?? undefined),
          observation,
        );
        if (
          observation.source === 'learned' &&
          observation.limit !== undefined &&
          observation.limit !== null
        ) {
          const observedAt = Date.parse(observation.observedAt);
          this.learned.set(
            this.key(
              observation.providerId,
              observation.windowId,
              observation.modelRef ?? undefined,
            ),
            {
              limit: observation.limit,
              observedAt,
              expiresAt: observedAt + 30 * 86400000,
            },
          );
        }
      }
    }
    for (const provider of this.providers) {
      const parsed = ProviderLimitsSchema.safeParse(provider);
      if (parsed.success)
        for (const window of parsed.data.windows)
          this.normalizeCatalogWindow(parsed.data.provider, window);
    }
    this.scheduleResets();
  }

  private key(providerId: string, windowId: string, modelRef?: string): string {
    return `${providerId}:${modelRef ?? '*'}:${windowId}`;
  }
  private allRecords(): UsageRecord[] {
    return [...this.records.values()];
  }
  private fromRow(row: Record<string, unknown>): UsageRecord {
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    const nullableText = (value: unknown): string | null =>
      typeof value === 'string' ? value : null;
    const errorKind = ProviderErrorKindSchema.safeParse(row.error_kind);
    return {
      id: text(row.id),
      providerId: text(row.provider) as UsageRecord['providerId'],
      modelRef: text(row.model),
      occurredAt: text(row.ts),
      sessionId: nullableText(row.session_id),
      taskId: nullableText(row.task_id),
      stepId: nullableText(row.step_id),
      stepKind: nullableText(row.step_kind),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cachedTokens: Number(row.cached_tokens ?? 0),
      reasoningTokens: Number(row.reasoning_tokens ?? 0),
      costUsd: Number(row.cost_usd ?? 0),
      planUnits: Number(row.plan_units ?? 0),
      status: text(row.status),
      errorKind: errorKind.success ? errorKind.data : null,
      latencyMs: row.latency_ms == null ? undefined : Number(row.latency_ms),
    };
  }
  private normalizeCatalogWindow(
    providerId: string,
    source: ProviderLimits['windows'][number],
  ): ExtendedWindow {
    const value = source as ProviderLimits['windows'][number] & {
      dow?: number;
      day?: number;
      time?: string;
    };
    return {
      ...value,
      id: `${providerId}:${value.scope}:${value.model ?? '*'}:${value.metric}:${value.kind}`,
      kind: value.kind,
      tz: value.tz ?? 'UTC',
      length: value.length ?? (value.kind === 'dynamic_5h' ? 300 : 60),
      scope: value.scope,
      model: value.model,
      metric: value.metric,
      limit: value.limit,
      ...(value.dow === undefined ? {} : { dow: value.dow }),
      ...(value.day === undefined ? {} : { day: value.day }),
      ...(value.time === undefined ? {} : { time: value.time }),
    } as ExtendedWindow;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  recordUsage(input: UsageRecord): void {
    const record = {
      ...input,
      ...(input.inputTokens === undefined ? {} : { inputTokens: Math.max(0, input.inputTokens) }),
      ...(input.outputTokens === undefined
        ? {}
        : { outputTokens: Math.max(0, input.outputTokens) }),
      ...(input.cachedTokens === undefined
        ? {}
        : { cachedTokens: Math.max(0, input.cachedTokens) }),
      ...(input.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: Math.max(0, input.reasoningTokens) }),
      ...(input.costUsd === undefined ? {} : { costUsd: Math.max(0, input.costUsd) }),
      ...(input.planUnits === undefined ? {} : { planUnits: Math.max(0, input.planUnits) }),
    };
    this.records.set(record.id, record);
    this.requestRepo?.put({
      id: record.id,
      ts: record.occurredAt,
      provider: record.providerId,
      model: record.modelRef,
      session_id: record.sessionId ?? null,
      task_id: record.taskId ?? null,
      step_id: record.stepId ?? null,
      step_kind: record.stepKind ?? null,
      input_tokens: record.inputTokens ?? null,
      output_tokens: record.outputTokens ?? null,
      cached_tokens: record.cachedTokens ?? null,
      reasoning_tokens: record.reasoningTokens ?? null,
      cost_usd: record.costUsd ?? null,
      plan_units: record.planUnits ?? null,
      status: record.status,
      error_kind: record.errorKind ?? null,
      latency_ms: record.latencyMs ?? null,
      headers: record.headers ?? null,
    });
    if (record.stepKind) this.updateAverage(record);
    this.scheduleResets();
    this.scheduleEmit();
  }
  queryUsage(query: UsageQuery = {}): UsageRecord[] {
    return this.allRecords().filter(
      (record) =>
        (!query.providerId || record.providerId === query.providerId) &&
        (!query.modelRef || record.modelRef === query.modelRef) &&
        (!query.sessionId || record.sessionId === query.sessionId) &&
        (!query.taskId || record.taskId === query.taskId) &&
        (!query.day || record.occurredAt.slice(0, 10) === query.day),
    );
  }
  observe(observation: QuotaObservation): void {
    const key = this.key(
      observation.providerId,
      observation.windowId,
      observation.modelRef ?? undefined,
    );
    const window = this.windowDefinitions(observation.providerId).find(
      (candidate) => candidate.id === observation.windowId,
    );
    if (!observation.resetAt && window) {
      const matching = this.queryUsage({ providerId: observation.providerId });
      observation = {
        ...observation,
        resetAt: nextReset(this.now(), asWindowSpec(window), matching).toISOString(),
      };
    }
    if (observation.statusCode === 429) {
      const current = this.currentWindow(observation.providerId, window);
      const currentUsage = current.used;
      const estimated = current.remaining;
      if ((estimated ?? 1) > 0) {
        const limit = currentUsage;
        this.learned.set(key, {
          limit,
          observedAt: this.now().getTime(),
          expiresAt: this.now().getTime() + 30 * 86400000,
        });
        observation = {
          ...observation,
          id: newId('surprise'),
          source: 'learned',
          value: currentUsage,
          limit,
          observedAt: this.now().toISOString(),
          surprise: true,
          resetAt:
            observation.resetAt ??
            (window
              ? nextReset(this.now(), asWindowSpec(window), this.allRecords()).toISOString()
              : undefined),
        };
      }
    }
    this.observations?.put(observation);
    const previous = this.snapshots.get(key);
    if (
      !previous ||
      rank[sourceFor(observation)] > rank[sourceFor(previous)] ||
      (rank[sourceFor(observation)] === rank[sourceFor(previous)] &&
        Date.parse(observation.observedAt) > Date.parse(previous.observedAt))
    ) {
      this.snapshots.set(key, observation);
    }
    this.scheduleResets();
    this.scheduleEmit();
  }
  private windowDefinitions(providerId: string): ExtendedWindow[] {
    const provider = this.providers.find((item) => item.provider === providerId);
    return provider?.windows.map((window) => this.normalizeCatalogWindow(providerId, window)) ?? [];
  }
  private currentWindow(providerId: string, target?: ExtendedWindow): QuotaWindow {
    const window = target ?? this.windowDefinitions(providerId)[0];
    if (!window)
      return {
        id: 'unknown',
        scope: 'provider',
        modelRef: null,
        metric: 'requests',
        kind: 'rolling',
        periodLabel: 'Unknown',
        used: 0,
        limit: null,
        remaining: null,
        resetAt: null,
        confidence: 'unknown',
      };
    const spec = asWindowSpec(window);
    const now = this.now();
    const matching = this.queryUsage({ providerId }).filter(
      (record) => window.scope !== 'model' || record.modelRef.includes(window.model ?? ''),
    );
    const start = windowStart(now, spec, matching);
    const end = nextReset(now, spec, matching);
    const amounts = usageIn({ start, end: now }, matching);
    const inWindow = matching.filter((record) => {
      const timestamp = Date.parse(record.occurredAt);
      return timestamp >= start.getTime() && timestamp < now.getTime();
    });
    const pricedUsd = inWindow.reduce((sum, record) => sum + this.costFor(record), 0);
    const pricedCredits = inWindow.reduce(
      (sum, record) => sum + (record.planUnits ?? this.costFor(record)),
      0,
    );
    const used =
      window.metric === 'requests'
        ? amounts.requests
        : window.metric === 'tokens'
          ? amounts.tokens
          : window.metric === 'usd'
            ? pricedUsd
            : pricedCredits;
    const modelRef = window.model
      ? (this.models.find((model) => model.ref.includes(window.model ?? ''))?.ref ?? null)
      : null;
    const observation = this.snapshots.get(this.key(providerId, window.id, modelRef ?? undefined));
    const validSnapshot =
      observation && (!observation.resetAt || Date.parse(observation.resetAt) > now.getTime())
        ? observation
        : undefined;
    const learned = this.learned.get(this.key(providerId, window.id, modelRef ?? undefined));
    const learnedLimit =
      learned && learned.expiresAt > now.getTime()
        ? Math.min(
            window.limit ?? learned.limit,
            learned.limit +
              ((window.limit ?? learned.limit) - learned.limit) *
                ((now.getTime() - learned.observedAt) / (30 * 86400000)),
          )
        : undefined;
    const limit = validSnapshot?.limit ?? learnedLimit ?? window.limit;
    const authoritative =
      validSnapshot?.remaining ??
      (validSnapshot?.limit != null && validSnapshot.value != null
        ? Math.max(0, validSnapshot.limit - validSnapshot.value)
        : undefined);
    return {
      id: window.id,
      scope: window.scope,
      modelRef,
      metric: window.metric,
      kind:
        window.kind === 'weekly_fixed' || window.kind === 'weekly_from_first_use'
          ? 'weekly'
          : window.kind === 'monthly_from_anchor'
            ? 'monthly'
            : window.kind === 'dynamic_5h'
              ? 'dynamic'
              : window.kind,
      periodLabel: window.kind,
      used,
      limit,
      remaining: remaining(limit, used, authoritative),
      resetAt: end.toISOString(),
      confidence: validSnapshot
        ? confidence[validSnapshot.source]
        : learned
          ? 'learned'
          : 'estimated',
    };
  }
  getWindows(providerId: string): QuotaWindow[] {
    return this.windowDefinitions(providerId).map((window) =>
      this.currentWindow(providerId, window),
    );
  }

  private updateAverage(record: UsageRecord): void {
    const key = `${record.providerId}:${record.modelRef}:${record.stepKind ?? 'unknown'}`;
    const old = this.averages.get(key) ?? { tokens: 0, cost: 0, samples: 0 };
    const tokens = (record.inputTokens ?? 0) + (record.outputTokens ?? 0);
    const cost = this.costFor(record);
    this.averages.set(key, {
      tokens: old.samples ? old.tokens * 0.8 + tokens * 0.2 : tokens,
      cost: old.samples ? old.cost * 0.8 + cost * 0.2 : cost,
      samples: old.samples + 1,
    });
  }
  private costFor(record: UsageRecord): number {
    if (record.costUsd !== undefined) return record.costUsd;
    const model = this.models.find((entry) => entry.ref === record.modelRef);
    const multipliers = this.multipliers[record.providerId];
    const cached = record.cachedTokens ?? 0;
    const uncachedInput = Math.max(0, (record.inputTokens ?? 0) - cached);
    let cost =
      (uncachedInput * (model?.priceInPerM ?? 0) * (multipliers?.input ?? 1) +
        (record.outputTokens ?? 0) * (model?.priceOutPerM ?? 0) * (multipliers?.output ?? 1) +
        cached * (model?.priceInPerM ?? 0) * (multipliers?.cached ?? 1)) /
      1_000_000;
    if (record.headers?.offPeak === true) cost *= multipliers?.offPeak ?? 1;
    return cost;
  }
  private stepsFor(providerId: string, modelRef?: string): number | null {
    const windows = this.getWindows(providerId);
    const model = modelRef ?? this.models.find((entry) => entry.providerId === providerId)?.ref;
    const bounded = windows.some((window) => {
      if (window.limit === null) return false;
      const definition = this.windowDefinitions(providerId).find((item) => item.id === window.id);
      return definition?.kind !== 'rolling' || (definition.length ?? 0) >= 3600;
    });
    if (!model || !bounded) return null;
    const average = [...this.averages.entries()]
      .filter(([key]) => key.startsWith(`${providerId}:${model}:`))
      .map(([, value]) => value);
    const avgTokens = average.length
      ? Math.max(1, average.reduce((sum, value) => sum + value.tokens, 0) / average.length)
      : 1000;
    const avgCost = average.length
      ? average.reduce((sum, value) => sum + value.cost, 0) / average.length
      : 0;
    const candidates: number[] = [];
    for (const window of windows) {
      if (window.remaining === null) continue;
      if (window.metric === 'requests') candidates.push(window.remaining);
      if (window.metric === 'tokens') candidates.push(Math.floor(window.remaining / avgTokens));
      if ((window.metric === 'usd' || window.metric === 'credits') && avgCost > 0)
        candidates.push(Math.floor(window.remaining / avgCost));
      const definition = this.windowDefinitions(providerId).find((item) => item.id === window.id);
      if (
        window.metric === 'requests' &&
        window.kind === 'rolling' &&
        window.limit !== null &&
        definition?.kind === 'rolling' &&
        typeof definition.length === 'number' &&
        definition.length >= 3600
      ) {
        const seconds = Math.max(
          1,
          (Date.parse(window.resetAt ?? '') - this.now().getTime()) / 1000,
        );
        if (seconds < 60) candidates.push(Math.floor((seconds * window.limit) / 60));
      }
    }
    return candidates.length ? Math.max(0, Math.min(...candidates)) : null;
  }
  stepsLeft(providerId: string, modelRef?: string): number | null {
    return this.stepsFor(providerId, modelRef);
  }
  capacitySummary(): CapacitySummary {
    const providers = [...new Set(this.providers.map((provider) => provider.provider))];
    const perProvider = providers.map((providerId) => {
      const windows = this.getWindows(providerId);
      const resets = windows
        .map((window) => window.resetAt)
        .filter((value): value is string => Boolean(value))
        .sort();
      const stepsLeft = this.stepsLeft(providerId);
      const restrictive = windows
        .filter((window) => window.limit !== null)
        .map((window) => (window.remaining ?? 0) / Math.max(1, window.limit ?? 1));
      return {
        providerId: providerId as CapacitySummary['perProvider'][number]['providerId'],
        stepsLeft,
        percent: restrictive.length ? Math.round(Math.min(...restrictive) * 100) : null,
        nextResetAt: resets[0] ?? null,
      };
    });
    const eligible = perProvider
      .map((provider) => provider.stepsLeft)
      .filter((value): value is number => value !== null);
    const stepsLeftToday = eligible.length ? Math.min(...eligible) : 0;
    const percentages = perProvider
      .map((provider) => provider.percent)
      .filter((value): value is number => value !== null);
    const percentRemaining = percentages.length
      ? Math.round(percentages.reduce((sum, value) => sum + value, 0) / percentages.length)
      : 100;
    const low = perProvider
      .filter((provider) => (provider.percent ?? 100) <= this.lowThreshold)
      .sort((a, b) => Date.parse(a.nextResetAt ?? '') - Date.parse(b.nextResetAt ?? ''))[0];
    const nextResets = providers.flatMap((providerId) =>
      this.getWindows(providerId)
        .filter((window) => window.resetAt)
        .map((window) => ({
          providerId: providerId as CapacitySummary['perProvider'][number]['providerId'],
          windowId: window.id,
          label: window.periodLabel,
          at: window.resetAt ?? '',
        })),
    );
    return {
      stepsLeftToday,
      percentRemaining,
      lowCapacity: Boolean(low),
      perProvider,
      nextResets,
      banner: low
        ? {
            text: `Low capacity — ${low.providerId} resets soon`,
            actionLabel: 'Add provider',
            action: 'add_provider',
          }
        : null,
      updatedAt: this.now().toISOString(),
    };
  }

  private cooldownKey(providerId: string, modelRef: string, keyId: string): string {
    return `${providerId}:${modelRef}:${keyId}`;
  }
  noteFailure(
    providerId: string,
    modelRef: string,
    keyId: string,
    error: '429' | '5xx' | 'network' | 'auth_invalid' | 'account_disabled',
    resetAt?: string,
  ): { health: ProviderHealth; cooldownUntil: string | null; retry: boolean } {
    const key = this.cooldownKey(providerId, modelRef, keyId);
    const current = this.cooldowns.get(key) ?? { until: 0, failures: 0 };
    if (error === 'auth_invalid' || error === 'account_disabled') {
      this.cooldowns.set(key, { ...current, terminal: error });
      return { health: error, cooldownUntil: null, retry: false };
    }
    if (error === '429') {
      const delay = ([10, 30, 60, 120][Math.min(current.failures, 3)] ?? 120) * 1000;
      const until = resetAt
        ? Math.max(this.now().getTime() + delay, Date.parse(resetAt))
        : this.now().getTime() + delay;
      this.cooldowns.set(key, { until, failures: current.failures + 1 });
      return { health: 'cooldown', cooldownUntil: new Date(until).toISOString(), retry: true };
    }
    return { health: 'down', cooldownUntil: null, retry: true };
  }
  noteSuccess(providerId: string, modelRef: string, keyId: string): void {
    this.cooldowns.delete(this.cooldownKey(providerId, modelRef, keyId));
  }
  health(
    providerId: string,
    modelRef: string,
    keyId: string,
  ): { health: ProviderHealth; cooldownUntil: string | null; retry: boolean } {
    const state = this.cooldowns.get(this.cooldownKey(providerId, modelRef, keyId));
    if (state?.terminal) return { health: state.terminal, cooldownUntil: null, retry: false };
    if (state && state.until > this.now().getTime())
      return {
        health: 'cooldown',
        cooldownUntil: new Date(state.until).toISOString(),
        retry: true,
      };
    const breaker = this.breakers.get(this.cooldownKey(providerId, modelRef, keyId));
    if (breaker?.state === CircuitState.Open)
      return { health: 'down', cooldownUntil: null, retry: true };
    if (breaker?.state === CircuitState.HalfOpen)
      return { health: 'cooldown', cooldownUntil: null, retry: true };
    return { health: 'ok', cooldownUntil: null, retry: true };
  }
  private breaker(providerId: string, modelRef: string, keyId: string): CircuitBreakerPolicy {
    const key = this.cooldownKey(providerId, modelRef, keyId);
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = circuitBreaker(new Policy({ errorFilter: () => true, resultFilter: () => false }), {
        breaker: new CountBreaker({ threshold: 0.5, size: 4, minimumNumberOfCalls: 2 }),
        halfOpenAfter: 30_000,
      });
      this.breakers.set(key, breaker);
    }
    return breaker;
  }
  executeWithBreaker<T>(
    providerId: string,
    modelRef: string,
    keyId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.breaker(providerId, modelRef, keyId).execute(action);
  }

  private scheduleEmit(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => {
      const event = { type: 'quota.updated' as const, summary: this.capacitySummary() };
      this.options.emit?.(event);
      for (const listener of this.listeners) listener(event);
    }, 250);
  }
  private scheduleResets(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    const soonest = this.providers
      .flatMap((provider) =>
        this.getWindows(provider.provider).map((window) => Date.parse(window.resetAt ?? '')),
      )
      .filter((at) => at > this.now().getTime())
      .sort((a, b) => a - b)[0];
    if (soonest) {
      const timer = setTimeout(
        () => {
          this.scheduleEmit();
          this.scheduleResets();
        },
        Math.min(soonest - this.now().getTime(), 2_147_000_000),
      );
      this.timers.add(timer);
    }
  }
  startOpenRouterPolling(
    poll: () => Promise<void>,
    active: () => boolean = () => true,
  ): () => void {
    let stopped = false;
    const schedule = () => {
      if (stopped || !active()) return;
      const timer = setTimeout(() => {
        void poll().finally(schedule);
      }, 5 * 60_000);
      this.timers.add(timer);
    };
    schedule();
    return () => {
      stopped = true;
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear();
    };
  }
  dispose(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
