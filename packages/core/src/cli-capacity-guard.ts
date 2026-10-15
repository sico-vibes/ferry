import type { CliTransportError, CliTransportErrorKind } from '@ferry/delegate';
import { z } from 'zod';
import type { CliConnectionKind } from '@ferry/shared';

export type CliCapacityBlockKind =
  'exhausted_capacity' | 'temporary_rate_limit' | 'authentication' | 'timeout';

export interface CliCapacityIdentity {
  connectionId: CliConnectionKind;
  accountKey: string | null;
  upstreamProvider: string | null;
  bucketId?: string | null;
}

export interface CliCapacityBlock {
  identity: CliCapacityIdentity;
  kind: CliCapacityBlockKind;
  reason: string;
  blockedAt: string;
  resetAt: string | null;
  retryAfterMs: number | null;
}

export interface CliCapacityStore {
  load(): readonly CliCapacityBlock[];
  save(blocks: readonly CliCapacityBlock[]): void;
}

const CliCapacityIdentitySchema = z.object({
  connectionId: z.enum(['codex-cli', 'claude-code-cli', 'opencode-cli']),
  accountKey: z.string().max(256).nullable(),
  upstreamProvider: z.string().max(256).nullable(),
  bucketId: z.string().max(256).nullable().optional(),
});

const CliCapacityBlockKindSchema = z.enum([
  'exhausted_capacity',
  'temporary_rate_limit',
  'authentication',
  'timeout',
]);

/**
 * Persisted form of one capacity block. Only non-secret identity (an opaque account fingerprint and
 * a provider/bucket name) is stored; no key material, token or credential is ever persisted.
 */
export const CliCapacityBlockSchema = z.object({
  identity: CliCapacityIdentitySchema,
  kind: CliCapacityBlockKindSchema,
  reason: z.string().max(1_000),
  blockedAt: z.iso.datetime(),
  resetAt: z.iso.datetime().nullable(),
  retryAfterMs: z.number().nullable(),
});
export type PersistedCliCapacityBlock = z.infer<typeof CliCapacityBlockSchema>;

/**
 * Parse persisted blocks defensively. A malformed element is dropped rather than trusted, so a
 * corrupted settings value can never resurrect a stale or fabricated block.
 */
export function parseCliCapacityBlocks(raw: unknown): CliCapacityBlock[] {
  if (!Array.isArray(raw)) return [];
  const blocks: CliCapacityBlock[] = [];
  for (const value of raw) {
    const parsed = CliCapacityBlockSchema.safeParse(value);
    if (parsed.success)
      blocks.push({
        identity: {
          connectionId: parsed.data.identity.connectionId,
          accountKey: parsed.data.identity.accountKey,
          upstreamProvider: parsed.data.identity.upstreamProvider,
          bucketId: parsed.data.identity.bucketId ?? null,
        },
        kind: parsed.data.kind,
        reason: parsed.data.reason,
        blockedAt: parsed.data.blockedAt,
        resetAt: parsed.data.resetAt,
        retryAfterMs: parsed.data.retryAfterMs,
      });
  }
  return blocks;
}

export interface CliCapacityGuardOptions {
  now: () => number;
  store?: CliCapacityStore;
}

export interface CliCapacityDecision {
  allowed: boolean;
  block: CliCapacityBlock | null;
}

const DEFAULT_COOLDOWN_MS = 1_000;
const SAFE_MARGIN_MS = 250;
const MAX_BLOCKS = 256;
const SCOPE_SEPARATOR = '\u0000';

const DEFAULT_REASONS: Record<CliCapacityBlockKind, string> = {
  exhausted_capacity: 'CLI account capacity is exhausted',
  temporary_rate_limit: 'CLI provider rate limit is temporarily active',
  authentication: 'CLI account authentication failed',
  timeout: 'CLI provider did not respond before the deadline',
};

type WaitableError = Pick<CliTransportError, 'kind' | 'retryAfterMs'>;

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isSoftKind(kind: CliCapacityBlockKind): boolean {
  return kind === 'temporary_rate_limit' || kind === 'timeout';
}

function blockKindOf(kind: CliTransportErrorKind): CliCapacityBlockKind | null {
  switch (kind) {
    case 'exhausted_capacity':
    case 'temporary_rate_limit':
    case 'authentication':
    case 'timeout':
      return kind;
    default:
      return null;
  }
}

function normalizeResetAt(value: string | null, nowMs: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed) || parsed <= nowMs) return null;
  return new Date(parsed).toISOString();
}

function normalizeRetryAfterMs(kind: CliCapacityBlockKind, value: number | null): number | null {
  // A provider-reported retry wait is preserved verbatim — never shortened to a local ceiling. An
  // unknown/invalid hint falls back to the small default; the caller still chooses whether to inline
  // wait (via `shortWaitMs`) or fall back, but the block itself never early-unblocks.
  if (kind === 'temporary_rate_limit') return positiveFinite(value) ? value : DEFAULT_COOLDOWN_MS;
  if (kind === 'timeout') return DEFAULT_COOLDOWN_MS;
  return null;
}

function softWaitFor(
  kind: CliTransportErrorKind,
  retryAfterMs: number | null,
  policyMaxWaitMs: number,
): number | null {
  if (!(policyMaxWaitMs > 0)) return null;
  if (kind !== 'temporary_rate_limit') return null;
  const requested = positiveFinite(retryAfterMs) ? retryAfterMs : DEFAULT_COOLDOWN_MS;
  return requested <= policyMaxWaitMs ? requested : null;
}

/**
 * Inline wait for a rate-limited retry, or null when the caller must fall back immediately. The
 * provider's requested wait is never shortened: if it exceeds the policy cap or leaves less than
 * the safe margin of the remaining deadline, this returns null so the caller does not retry early.
 */
export function shortWaitMs(
  error: WaitableError,
  remainingDeadlineMs: number,
  policyMaxWaitMs: number,
): number | null {
  if (!Number.isFinite(remainingDeadlineMs) || remainingDeadlineMs <= 0) return null;
  const wait = softWaitFor(error.kind, error.retryAfterMs, policyMaxWaitMs);
  if (wait === null) return null;
  if (wait + SAFE_MARGIN_MS >= remainingDeadlineMs) return null;
  return wait;
}

function clearTimeMs(block: CliCapacityBlock): number | null {
  if (block.kind === 'authentication') return null;
  if (block.kind === 'exhausted_capacity') {
    return block.resetAt === null ? null : Date.parse(block.resetAt);
  }
  const blocked = Date.parse(block.blockedAt);
  return blocked + (block.retryAfterMs ?? DEFAULT_COOLDOWN_MS);
}

function restrictiveness(block: CliCapacityBlock): number {
  const clear = clearTimeMs(block);
  return clear ?? Number.POSITIVE_INFINITY;
}

function isExpired(block: CliCapacityBlock, nowMs: number): boolean {
  const clear = clearTimeMs(block);
  return clear !== null && nowMs >= clear;
}

function activeOf(blocks: readonly CliCapacityBlock[], nowMs: number): CliCapacityBlock[] {
  return blocks.filter((block) => !isExpired(block, nowMs));
}

function matchesScope(block: CliCapacityIdentity, identity: CliCapacityIdentity): boolean {
  if (block.connectionId !== identity.connectionId) return false;
  if (block.accountKey !== identity.accountKey) return false;
  if (block.upstreamProvider !== identity.upstreamProvider) return false;
  const blockBucket = block.bucketId ?? null;
  const targetBucket = identity.bucketId ?? null;
  if (blockBucket !== null && targetBucket !== null && targetBucket !== blockBucket) return false;
  return true;
}

function scopeKey(identity: CliCapacityIdentity): string {
  return [
    identity.connectionId,
    identity.accountKey ?? '',
    identity.upstreamProvider ?? '',
    identity.bucketId ?? '',
  ].join(SCOPE_SEPARATOR);
}

function findActive(
  blocks: readonly CliCapacityBlock[],
  identity: CliCapacityIdentity,
  nowMs: number,
): CliCapacityBlock | null {
  let best: CliCapacityBlock | null = null;
  for (const block of blocks) {
    if (isExpired(block, nowMs)) continue;
    if (!matchesScope(block.identity, identity)) continue;
    if (best === null || restrictiveness(block) > restrictiveness(best)) best = block;
  }
  return best;
}

function cloneIdentity(identity: CliCapacityIdentity): CliCapacityIdentity {
  return {
    connectionId: identity.connectionId,
    accountKey: identity.accountKey,
    upstreamProvider: identity.upstreamProvider,
    bucketId: identity.bucketId ?? null,
  };
}

function cloneBlock(block: CliCapacityBlock): CliCapacityBlock {
  return {
    identity: cloneIdentity(block.identity),
    kind: block.kind,
    reason: block.reason,
    blockedAt: block.blockedAt,
    resetAt: block.resetAt,
    retryAfterMs: block.retryAfterMs,
  };
}

function effectiveIdentity(
  identity: CliCapacityIdentity,
  error: CliTransportError,
): CliCapacityIdentity {
  return {
    connectionId: identity.connectionId,
    accountKey: identity.accountKey ?? error.accountKey,
    upstreamProvider: identity.upstreamProvider,
    bucketId: identity.bucketId ?? error.bucketId,
  };
}

function reasonFor(error: CliTransportError, kind: CliCapacityBlockKind): string {
  const message = error.message.trim();
  return message.length > 0 ? message : DEFAULT_REASONS[kind];
}

/** Synchronous capacity circuit guard for native CLI and Gateway transports. */
export class CliCapacityGuard {
  private readonly now: () => number;
  private readonly store: CliCapacityStore | undefined;
  private blocks: CliCapacityBlock[];

  constructor(options: CliCapacityGuardOptions) {
    this.now = options.now;
    this.store = options.store;
    const loaded = this.store ? this.store.load() : [];
    this.blocks = activeOf(
      loaded.map((block) => cloneBlock(block)),
      this.now(),
    );
  }

  check(identity: CliCapacityIdentity): CliCapacityDecision {
    const nowMs = this.now();
    this.prune(nowMs);
    const block = findActive(this.blocks, identity, nowMs);
    return { allowed: block === null, block: block === null ? null : cloneBlock(block) };
  }

  record(identity: CliCapacityIdentity, error: CliTransportError): void {
    const kind = blockKindOf(error.kind);
    if (kind === null) return;
    const nowMs = this.now();
    const block: CliCapacityBlock = {
      identity: effectiveIdentity(identity, error),
      kind,
      reason: reasonFor(error, kind),
      blockedAt: new Date(nowMs).toISOString(),
      resetAt: kind === 'exhausted_capacity' ? normalizeResetAt(error.resetAt, nowMs) : null,
      retryAfterMs: normalizeRetryAfterMs(kind, error.retryAfterMs),
    };
    this.upsert(block, nowMs);
    this.persist();
  }

  verifiedRefresh(identity: CliCapacityIdentity): void {
    const nowMs = this.now();
    const remaining = this.blocks.filter((block) => !matchesScope(block.identity, identity));
    this.commit(remaining, nowMs);
  }

  accountChanged(
    connectionId: CliConnectionKind,
    previousKey: string | null,
    currentKey: string | null,
  ): void {
    if (previousKey === currentKey) return;
    const nowMs = this.now();
    const remaining = this.blocks.filter(
      (block) =>
        !(
          block.identity.connectionId === connectionId && block.identity.accountKey === previousKey
        ),
    );
    this.commit(remaining, nowMs);
  }

  snapshot(): readonly CliCapacityBlock[] {
    const nowMs = this.now();
    this.prune(nowMs);
    return this.blocks.map((block) => cloneBlock(block));
  }

  private prune(nowMs: number): void {
    const next = activeOf(this.blocks, nowMs);
    if (next.length === this.blocks.length) return;
    this.blocks = next;
    this.persist();
  }

  private upsert(block: CliCapacityBlock, nowMs: number): void {
    this.blocks = activeOf(this.blocks, nowMs);
    const key = scopeKey(block.identity);
    const existing = this.blocks.find((candidate) => scopeKey(candidate.identity) === key);
    if (existing !== undefined && restrictiveness(existing) >= restrictiveness(block)) return;
    this.blocks = this.blocks.filter((candidate) => scopeKey(candidate.identity) !== key);
    this.blocks.push(block);
    this.enforceLimit();
  }

  private commit(remaining: readonly CliCapacityBlock[], nowMs: number): void {
    const next = activeOf(remaining, nowMs);
    const changed =
      next.length !== this.blocks.length ||
      next.some((block, index) => block !== this.blocks[index]);
    this.blocks = next;
    if (changed) this.persist();
  }

  private enforceLimit(): void {
    if (this.blocks.length <= MAX_BLOCKS) return;
    const removable = this.blocks
      .filter((block) => isSoftKind(block.kind))
      .sort((a, b) => restrictiveness(a) - restrictiveness(b));
    const overflow = this.blocks.length - MAX_BLOCKS;
    const drop = new Set(removable.slice(0, overflow));
    if (drop.size === 0) return;
    this.blocks = this.blocks.filter((block) => !drop.has(block));
  }

  private persist(): void {
    this.store?.save(this.blocks);
  }
}
