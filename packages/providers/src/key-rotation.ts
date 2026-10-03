export type ProviderKeyHealth = 'ok' | 'rate_limited' | 'invalid' | 'disabled';

export interface RotatingProviderKey {
  id: string;
  order: number;
  enabled: boolean;
  status: ProviderKeyHealth;
  cooldownUntil: string | null;
  weight?: number;
}

export type KeySelectionStrategy = 'round_robin' | 'weighted';

/** Keeps independent round-robin cursors per provider and skips unavailable accounts. */
export class ProviderKeyRotation {
  readonly #cursor = new Map<string, number>();
  constructor(private readonly random: () => number = Math.random) {}

  select<T extends RotatingProviderKey>(
    providerId: string,
    keys: readonly T[],
    now = new Date(),
    strategy: KeySelectionStrategy = 'round_robin',
  ): T | undefined {
    const available = keys
      .filter(
        (key) =>
          key.enabled &&
          key.status !== 'invalid' &&
          (key.status !== 'disabled' ||
            Boolean(key.cooldownUntil && Date.parse(key.cooldownUntil) <= now.getTime())) &&
          (key.status !== 'rate_limited' ||
            !key.cooldownUntil ||
            Date.parse(key.cooldownUntil) <= now.getTime()),
      )
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    if (!available.length) return undefined;
    if (strategy === 'weighted') {
      const weights = available.map((key) => Math.max(0, key.weight ?? 1));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      if (total > 0) {
        let point = Math.min(Math.max(this.random(), 0), 0.999999999) * total;
        for (let index = 0; index < available.length; index += 1) {
          point -= weights[index] ?? 0;
          if (point < 0) return available[index];
        }
      }
      return available[0];
    }
    const cursor = this.#cursor.get(providerId) ?? 0;
    const selected = available[cursor % available.length];
    this.#cursor.set(providerId, cursor + 1);
    return selected;
  }
}

export interface AutoDisableRule {
  statusCodes: readonly number[];
  keywords: readonly string[];
  failureCount: number;
  windowMs: number;
  disableForMs: number;
}

export interface KeyFailure {
  statusCode?: number;
  message: string;
  at: number;
}

/** Returns a temporary disable deadline when an auth, status, keyword, or repeat rule matches. */
export function autoDisableUntil(
  failures: readonly KeyFailure[],
  current: KeyFailure,
  rule: AutoDisableRule,
): number | undefined {
  const message = current.message.toLocaleLowerCase();
  const authFailure = current.statusCode === 401 || current.statusCode === 403;
  const explicitMatch =
    (current.statusCode !== undefined && rule.statusCodes.includes(current.statusCode)) ||
    rule.keywords.some((keyword) => message.includes(keyword.toLocaleLowerCase()));
  const recent = [...failures, current].filter(
    (failure) => current.at - failure.at <= rule.windowMs,
  );
  if (!authFailure && !explicitMatch && recent.length < Math.max(1, rule.failureCount))
    return undefined;
  return current.at + Math.max(0, rule.disableForMs);
}

export function keyProbeReenabled(
  disabledUntil: number | undefined,
  probeSucceeded: boolean,
): boolean {
  return probeSucceeded && disabledUntil !== undefined;
}
