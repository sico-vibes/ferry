import type { RoutingSettings } from '@ferry/shared';

export interface StickyRoute {
  modelRef: string;
  providerId?: string | undefined;
  providerKeyId?: string | undefined;
  expiresAt: number;
}

export function preferStickyAffinity<T extends { ref: string; providerId: string }>(
  candidates: readonly T[],
  route: StickyRoute | undefined,
  mode: 'soft' | 'strict',
  providerKeyId: (providerId: string) => string | undefined,
): T[] {
  if (!route) return [...candidates];
  const provider = route.providerId ?? route.modelRef.slice(0, route.modelRef.indexOf('/'));
  const matches = (candidate: T) => {
    if (candidate.providerId !== provider) return false;
    if (!route.providerKeyId) return true;
    const candidateKeyId = providerKeyId(candidate.providerId);
    return candidateKeyId === undefined || candidateKeyId === route.providerKeyId;
  };
  const eligible = mode === 'strict' ? candidates.filter(matches) : [...candidates];
  return eligible.sort(
    (a, b) =>
      Number(!matches(a)) - Number(!matches(b)) ||
      Number(b.ref === route.modelRef) - Number(a.ref === route.modelRef),
  );
}

export class StickySessionLedger {
  private readonly routes: Map<string, StickyRoute>;

  constructor(initial: Readonly<Record<string, StickyRoute>> = {}) {
    this.routes = new Map(Object.entries(initial));
  }

  get(sessionId: string, now: number): string | undefined {
    return this.getRoute(sessionId, now)?.modelRef;
  }

  getRoute(sessionId: string, now: number): StickyRoute | undefined {
    const route = this.routes.get(sessionId);
    if (!route || route.expiresAt <= now) {
      this.routes.delete(sessionId);
      return undefined;
    }
    return { ...route };
  }

  set(
    sessionId: string,
    modelRef: string,
    now: number,
    ttlMs: number,
    affinity?: { providerId: string; providerKeyId?: string },
  ): void {
    this.routes.set(sessionId, {
      modelRef,
      ...(affinity ? { providerId: affinity.providerId } : {}),
      ...(affinity?.providerKeyId ? { providerKeyId: affinity.providerKeyId } : {}),
      expiresAt: now + ttlMs,
    });
  }

  clear(sessionId: string): void {
    this.routes.delete(sessionId);
  }

  snapshot(): Record<string, StickyRoute> {
    return Object.fromEntries(this.routes);
  }
}

export interface ReliabilityObservation {
  modelRef: string;
  outcome: 'success' | 'failure';
  at: number;
}

export interface BetaPosterior {
  alpha: number;
  beta: number;
}

export function decayedBetaPosterior(
  observations: readonly ReliabilityObservation[],
  modelRef: string,
  now: number,
): BetaPosterior {
  const week = 7 * 24 * 60 * 60 * 1000;
  let successes = 0;
  let failures = 0;
  for (const observation of observations) {
    const age = now - observation.at;
    if (observation.modelRef !== modelRef || age < 0 || age > week) continue;
    const weight = 0.5 ** (age / (2 * 24 * 60 * 60 * 1000));
    if (observation.outcome === 'success') successes += weight;
    else failures += weight;
  }
  return { alpha: successes + 1, beta: failures + 1 };
}

export function sampleBeta(posterior: BetaPosterior, random: () => number = Math.random): number {
  const gamma = (shape: number): number => {
    if (shape < 1) return gamma(shape + 1) * random() ** (1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const u1 = Math.max(Number.EPSILON, random());
      const u2 = random();
      const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const v0 = 1 + c * normal;
      if (v0 <= 0) continue;
      const v = v0 ** 3;
      const u = random();
      if (
        u < 1 - 0.0331 * normal ** 4 ||
        Math.log(u) < 0.5 * normal ** 2 + d * (1 - v + Math.log(v))
      )
        return d * v;
    }
    return shape;
  };
  const a = gamma(posterior.alpha);
  const b = gamma(posterior.beta);
  return a / (a + b);
}

export type CooldownProvenance = 'heuristic' | 'authoritative' | 'credit' | 'tier';

export interface ProvenancedCooldown {
  until: number;
  provenance: CooldownProvenance;
}

export function canProbeCooldown(cooldown: ProvenancedCooldown, now: number): boolean {
  return cooldown.provenance === 'heuristic' && cooldown.until - now <= 60_000;
}

export function headroomFactor(
  remaining: number | null,
  limit: number | null,
  start = 0.2,
  floor = 0.1,
): number {
  if (remaining === null || limit === null || limit <= 0) return 1;
  return floor + (1 - floor) * Math.min(1, Math.max(0, remaining / limit) / start);
}

export interface ToolRejection {
  modelRef: string;
  requestId: string;
  at: number;
}

export function isToolDeferred(
  rejections: readonly ToolRejection[],
  modelRef: string,
  now: number,
): boolean {
  const fresh = rejections.filter(
    (item) => item.modelRef === modelRef && now >= item.at && now - item.at < 60 * 60_000,
  );
  return new Set(fresh.map((item) => item.requestId)).size >= 3;
}

export interface RetirementFailure {
  modelRef: string;
  requestId: string;
  at: number;
}

export function shouldRetireModel(
  status: number | null,
  message: string,
  failures: readonly RetirementFailure[],
  modelRef: string,
  requestId: string,
  now: number,
): boolean {
  if (status === 410 || /end of life|retired|no longer available/i.test(message)) return true;
  if (status !== 404 && !/model (?:not found|does not exist)/i.test(message)) return false;
  const recent = failures.filter(
    (item) =>
      item.modelRef === modelRef &&
      item.requestId !== requestId &&
      now >= item.at &&
      now - item.at < 60 * 60_000,
  );
  return new Set(recent.map((item) => item.requestId)).size >= 1;
}

export function routingTechniqueEnabled(
  settings: RoutingSettings,
  key: keyof RoutingSettings,
): boolean {
  return settings[key] === true;
}
