import { describe, expect, it } from 'vitest';
import {
  CliTransportError,
  type CliTransportErrorDetails,
  type CliTransportErrorKind,
} from '@ferry/delegate';
import {
  CliCapacityGuard,
  shortWaitMs,
  type CliCapacityBlock,
  type CliCapacityIdentity,
  type CliCapacityStore,
} from '../src/cli-capacity-guard.js';

const START = Date.parse('2026-02-01T00:00:00.000Z');

function makeClock(start = START): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

class MemoryStore implements CliCapacityStore {
  blocks: readonly CliCapacityBlock[];
  failSaves = false;
  loadCount = 0;

  constructor(seed: readonly CliCapacityBlock[] = []) {
    this.blocks = seed;
  }

  load(): readonly CliCapacityBlock[] {
    this.loadCount += 1;
    return this.blocks;
  }

  save(blocks: readonly CliCapacityBlock[]): void {
    if (this.failSaves) throw new Error('capacity store unavailable');
    this.blocks = [...blocks];
  }
}

function identity(overrides: Partial<CliCapacityIdentity> = {}): CliCapacityIdentity {
  return {
    connectionId: 'codex-cli',
    accountKey: 'acct-1',
    upstreamProvider: 'openai',
    ...overrides,
  };
}

function failure(
  kind: CliTransportErrorKind,
  message: string,
  details: CliTransportErrorDetails = {},
): CliTransportError {
  return new CliTransportError(kind, message, details);
}

describe('CliCapacityGuard exhaustion scope', () => {
  it('blocks the affected connection/account/upstream across models and isolates other scopes', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    guard.record(identity(), failure('exhausted_capacity', 'usage limit reached'));

    expect(guard.check(identity()).allowed).toBe(false);
    expect(guard.check(identity({ connectionId: 'opencode-cli' })).allowed).toBe(true);
    expect(guard.check(identity({ accountKey: 'acct-2' })).allowed).toBe(true);
    expect(guard.check(identity({ upstreamProvider: 'anthropic' })).allowed).toBe(true);
    expect(guard.check(identity({ connectionId: 'claude-code-cli' })).allowed).toBe(true);
  });

  it('keeps named quota buckets isolated while an account-wide block still covers every bucket', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    guard.record(
      identity({ bucketId: 'bucket-a' }),
      failure('exhausted_capacity', 'bucket a empty'),
    );
    expect(guard.check(identity({ bucketId: 'bucket-a' })).allowed).toBe(false);
    expect(guard.check(identity({ bucketId: 'bucket-b' })).allowed).toBe(true);
    expect(guard.check(identity({ bucketId: null })).allowed).toBe(false);

    guard.record(identity(), failure('exhausted_capacity', 'account empty'));
    expect(guard.check(identity({ bucketId: 'bucket-b' })).allowed).toBe(false);
  });

  it('keeps anonymous null accounts in their own stable bucket and never cross-blocks other upstreams', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    const anonymous = identity({
      connectionId: 'opencode-cli',
      accountKey: null,
      upstreamProvider: null,
    });
    guard.record(anonymous, failure('exhausted_capacity', 'anonymous exhausted'));

    expect(guard.check(anonymous).allowed).toBe(false);
    expect(
      guard.check(
        identity({ connectionId: 'opencode-cli', accountKey: null, upstreamProvider: 'zen' }),
      ).allowed,
    ).toBe(true);
    expect(
      guard.check(
        identity({
          connectionId: 'opencode-cli',
          accountKey: null,
          upstreamProvider: 'opencode-go',
        }),
      ).allowed,
    ).toBe(true);
    expect(
      guard.check(
        identity({
          connectionId: 'opencode-cli',
          accountKey: 'zen-account',
          upstreamProvider: null,
        }),
      ).allowed,
    ).toBe(true);
  });

  it('records opaque identity metadata only, never raw account secrets', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });
    const secret = 'sk-abcdefghijklmnop123456';

    guard.record(
      identity({ accountKey: 'opaque-fingerprint' }),
      failure('authentication', `login failed for token ${secret}`),
    );

    const serialized = JSON.stringify(guard.snapshot());
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[redacted]');
    expect(guard.snapshot()[0]?.identity.accountKey).toBe('opaque-fingerprint');
  });
});

describe('CliCapacityGuard hard block lifetime', () => {
  it('clears a hard exhaustion exactly at the reported reset', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });
    const resetAt = new Date(clock.now() + 60_000).toISOString();

    guard.record(identity(), failure('exhausted_capacity', 'exhausted', { resetAt }));

    expect(guard.check(identity()).allowed).toBe(false);
    clock.advance(59_999);
    expect(guard.check(identity()).allowed).toBe(false);
    clock.advance(1);
    expect(guard.check(identity()).allowed).toBe(true);
    expect(guard.snapshot()).toHaveLength(0);
  });

  it('keeps an unknown reset blocked and never guesses a timer', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    guard.record(identity(), failure('exhausted_capacity', 'exhausted'));
    clock.advance(365 * 24 * 60 * 60 * 1000);

    const decision = guard.check(identity());
    expect(decision.allowed).toBe(false);
    expect(decision.block?.resetAt).toBeNull();
    expect(decision.block?.kind).toBe('exhausted_capacity');
  });

  it('does not unblock a hard exhaustion when usage metadata ages out', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    guard.record(identity(), failure('exhausted_capacity', 'exhausted'));
    clock.advance(5 * 60 * 1000);

    expect(guard.check(identity()).allowed).toBe(false);
    expect(guard.snapshot()).toHaveLength(1);
  });

  it('keeps authentication failures blocked without a timer until a verified refresh', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    guard.record(identity(), failure('authentication', 'login required'));
    clock.advance(30 * 24 * 60 * 60 * 1000);
    expect(guard.check(identity()).allowed).toBe(false);

    guard.verifiedRefresh(identity());
    expect(guard.check(identity()).allowed).toBe(true);
  });

  it('never downgrades an active hard block to a shorter soft cooldown', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    guard.record(identity(), failure('exhausted_capacity', 'exhausted'));
    guard.record(identity(), failure('timeout', 'timeout'));
    clock.advance(5_000);

    expect(guard.check(identity()).allowed).toBe(false);
  });
});

describe('CliCapacityGuard persistence', () => {
  it('restores a persisted hard block so a restart cannot bypass it', () => {
    const clock = makeClock();
    const store = new MemoryStore();
    const guard = new CliCapacityGuard({ now: clock.now, store });
    guard.record(identity(), failure('exhausted_capacity', 'exhausted'));
    expect(store.blocks).toHaveLength(1);

    const restarted = new CliCapacityGuard({
      now: clock.now,
      store: new MemoryStore(store.blocks),
    });
    expect(restarted.check(identity()).allowed).toBe(false);
    expect(restarted.check(identity({ accountKey: 'other' })).allowed).toBe(true);
  });

  it('reads the injected store exactly once and never polls it', () => {
    const clock = makeClock();
    const store = new MemoryStore();
    const guard = new CliCapacityGuard({ now: clock.now, store });

    for (let index = 0; index < 5; index += 1) guard.check(identity());
    guard.snapshot();

    expect(store.loadCount).toBe(1);
  });

  it('surfaces persistence failures instead of claiming a block was saved', () => {
    const clock = makeClock();
    const store = new MemoryStore();
    store.failSaves = true;
    const guard = new CliCapacityGuard({ now: clock.now, store });

    expect(() => {
      guard.record(identity(), failure('exhausted_capacity', 'exhausted'));
    }).toThrow('capacity store unavailable');
    expect(store.blocks).toHaveLength(0);
    expect(guard.check(identity()).allowed).toBe(false);
  });

  it('prunes and persists an expired soft block discovered during check', () => {
    const clock = makeClock();
    const store = new MemoryStore();
    const guard = new CliCapacityGuard({ now: clock.now, store });
    guard.record(identity(), failure('timeout', 'timeout'));
    expect(store.blocks).toHaveLength(1);

    clock.advance(1_000);
    expect(guard.check(identity()).allowed).toBe(true);
    expect(store.blocks).toHaveLength(0);

    const restarted = new CliCapacityGuard({
      now: clock.now,
      store: new MemoryStore(store.blocks),
    });
    expect(restarted.check(identity()).allowed).toBe(true);
  });

  it('prunes an expired block on snapshot and persists the removal', () => {
    const clock = makeClock();
    const store = new MemoryStore();
    const guard = new CliCapacityGuard({ now: clock.now, store });
    guard.record(identity(), failure('timeout', 'timeout'));

    clock.advance(1_000);
    expect(guard.snapshot()).toHaveLength(0);
    expect(store.blocks).toHaveLength(0);
  });

  it('surfaces store errors when pruning an expired block', () => {
    const clock = makeClock();
    const store = new MemoryStore();
    const guard = new CliCapacityGuard({ now: clock.now, store });
    guard.record(identity(), failure('timeout', 'timeout'));

    clock.advance(1_000);
    store.failSaves = true;
    expect(() => {
      guard.check(identity());
    }).toThrow('capacity store unavailable');
  });
});

describe('CliCapacityGuard identity changes', () => {
  it('clears only the previous account scope on a real credential change', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    guard.record(identity({ accountKey: 'old' }), failure('exhausted_capacity', 'exhausted'));
    guard.record(
      identity({ accountKey: 'new' }),
      failure('temporary_rate_limit', 'slow down', { retryAfterMs: 5_000 }),
    );

    guard.accountChanged('codex-cli', 'old', 'new');
    expect(guard.check(identity({ accountKey: 'old' })).allowed).toBe(true);
    expect(guard.check(identity({ accountKey: 'new' })).allowed).toBe(false);

    guard.accountChanged('codex-cli', 'new', 'new');
    expect(guard.check(identity({ accountKey: 'new' })).allowed).toBe(false);
  });

  it('clears hard blocks on explicit verified refresh and leaves other scopes blocked', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    guard.record(identity(), failure('authentication', 'login required'));
    guard.record(identity({ accountKey: 'acct-2' }), failure('authentication', 'login required'));

    guard.verifiedRefresh(identity());
    expect(guard.check(identity()).allowed).toBe(true);
    expect(guard.check(identity({ accountKey: 'acct-2' })).allowed).toBe(false);
  });

  it('leaves distinct accounts and buckets unaffected by one another', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    guard.record(
      identity({ accountKey: 'a', bucketId: 'b1' }),
      failure('exhausted_capacity', 'exhausted'),
    );

    expect(guard.check(identity({ accountKey: 'a', bucketId: 'b1' })).allowed).toBe(false);
    expect(guard.check(identity({ accountKey: 'a', bucketId: 'b2' })).allowed).toBe(true);
    expect(guard.check(identity({ accountKey: 'b', bucketId: 'b1' })).allowed).toBe(true);
  });
});

describe('CliCapacityGuard soft blocks', () => {
  it('expires timeout and temporary-limit blocks after their finite cooldown', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    guard.record(identity({ accountKey: 'timeout' }), failure('timeout', 'timeout'));
    guard.record(
      identity({ accountKey: 'limited' }),
      failure('temporary_rate_limit', 'slow', { retryAfterMs: 4_000 }),
    );

    clock.advance(999);
    expect(guard.check(identity({ accountKey: 'timeout' })).allowed).toBe(false);
    expect(guard.check(identity({ accountKey: 'limited' })).allowed).toBe(false);

    clock.advance(1);
    expect(guard.check(identity({ accountKey: 'timeout' })).allowed).toBe(true);
    expect(guard.check(identity({ accountKey: 'limited' })).allowed).toBe(false);

    clock.advance(3_000);
    expect(guard.check(identity({ accountKey: 'limited' })).allowed).toBe(true);
  });

  it('preserves a provider-reported long cooldown instead of retrying early', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });
    const tenMinutes = 10 * 60 * 1000;

    guard.record(
      identity(),
      failure('temporary_rate_limit', 'slow down', { retryAfterMs: tenMinutes }),
    );
    expect(guard.snapshot()[0]?.retryAfterMs).toBe(tenMinutes);

    clock.advance(60_000);
    expect(guard.check(identity()).allowed).toBe(false);
    clock.advance(tenMinutes - 120_000);
    expect(guard.check(identity()).allowed).toBe(false);
    clock.advance(60_000);
    expect(guard.check(identity()).allowed).toBe(true);
  });

  it('never early-unblocks a provider wait longer than 24h', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });
    const fortyEightHours = 48 * 60 * 60 * 1000;

    guard.record(
      identity(),
      failure('temporary_rate_limit', 'slow down', { retryAfterMs: fortyEightHours }),
    );
    // The actual provider wait is preserved, not clamped to a 24h ceiling.
    expect(guard.snapshot()[0]?.retryAfterMs).toBe(fortyEightHours);

    clock.advance(24 * 60 * 60 * 1000);
    expect(guard.check(identity()).allowed).toBe(false);
    clock.advance(fortyEightHours - 24 * 60 * 60 * 1000 - 1);
    expect(guard.check(identity()).allowed).toBe(false);
    clock.advance(1);
    expect(guard.check(identity()).allowed).toBe(true);
  });

  it('never records cancellation, model or capability failures as capacity blocks', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    for (const kind of [
      'cancelled',
      'unavailable_model',
      'unsupported_capability',
      'provider_error',
    ] as const) {
      guard.record(identity(), failure(kind, `${kind} happened`));
    }

    expect(guard.check(identity()).allowed).toBe(true);
    expect(guard.snapshot()).toHaveLength(0);
  });
});

describe('CliCapacityGuard normalization', () => {
  it('normalizes malformed or stale resets to an unknown reset', () => {
    const malformed = [
      'not-a-date',
      'in 5 hours',
      '',
      new Date(Date.parse('2025-01-01T00:00:00.000Z')).toISOString(),
    ];

    for (const resetAt of malformed) {
      const clock = makeClock();
      const guard = new CliCapacityGuard({ now: clock.now });
      guard.record(identity(), failure('exhausted_capacity', 'exhausted', { resetAt }));
      expect(guard.snapshot()[0]?.resetAt).toBeNull();
      clock.advance(365 * 24 * 60 * 60 * 1000);
      expect(guard.check(identity()).allowed).toBe(false);
    }
  });

  it('clamps negative, zero or NaN retry hints to a finite default cooldown', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    guard.record(
      identity({ accountKey: 'nan' }),
      failure('temporary_rate_limit', 'slow', { retryAfterMs: Number.NaN }),
    );
    guard.record(
      identity({ accountKey: 'neg' }),
      failure('temporary_rate_limit', 'slow', { retryAfterMs: -10 }),
    );
    guard.record(
      identity({ accountKey: 'zero' }),
      failure('temporary_rate_limit', 'slow', { retryAfterMs: 0 }),
    );

    for (const key of ['nan', 'neg', 'zero']) {
      const block = guard.snapshot().find((candidate) => candidate.identity.accountKey === key);
      expect(block?.retryAfterMs).toBe(1_000);
    }

    clock.advance(999);
    expect(guard.check(identity({ accountKey: 'nan' })).allowed).toBe(false);
    clock.advance(1);
    expect(guard.check(identity({ accountKey: 'nan' })).allowed).toBe(true);
  });

  it('drops only soft blocks under pressure and never an active unknown hard block', () => {
    const clock = makeClock();
    const guard = new CliCapacityGuard({ now: clock.now });

    guard.record(identity({ accountKey: 'hard' }), failure('exhausted_capacity', 'exhausted'));
    for (let index = 0; index < 300; index += 1) {
      guard.record(
        identity({ accountKey: `soft-${String(index)}` }),
        failure('timeout', 'timeout'),
      );
    }

    const before = guard.snapshot();
    expect(before.length).toBeLessThanOrEqual(256);
    expect(before.some((block) => block.identity.accountKey === 'hard')).toBe(true);

    clock.advance(1_000);
    expect(guard.check(identity({ accountKey: 'hard' })).allowed).toBe(false);
  });
});

describe('shortWaitMs', () => {
  it('returns the provider retry hint only when it fully fits the remaining deadline', () => {
    expect(
      shortWaitMs(failure('temporary_rate_limit', 'slow', { retryAfterMs: 800 }), 5_000, 2_000),
    ).toBe(800);
    expect(
      shortWaitMs(failure('temporary_rate_limit', 'slow', { retryAfterMs: 800 }), 5_000, 800),
    ).toBe(800);
  });

  it('returns no wait when the requested wait leaves no safe margin before the deadline', () => {
    const limited = failure('temporary_rate_limit', 'slow', { retryAfterMs: 800 });
    expect(shortWaitMs(limited, 1_050, 2_000)).toBeNull();
    expect(shortWaitMs(limited, 1_000, 2_000)).toBeNull();
    expect(shortWaitMs(limited, 0, 2_000)).toBeNull();
  });

  it('never shortens a requested wait to fit the policy cap', () => {
    expect(
      shortWaitMs(failure('temporary_rate_limit', 'slow', { retryAfterMs: 10_000 }), 60_000, 1_000),
    ).toBeNull();
    expect(
      shortWaitMs(failure('temporary_rate_limit', 'slow', { retryAfterMs: 9_000 }), 100_000, 2_000),
    ).toBeNull();
    expect(shortWaitMs(failure('temporary_rate_limit', 'slow'), 5_000, 0)).toBeNull();
  });

  it('does not treat a timeout as a rate-limit retry wait', () => {
    expect(shortWaitMs(failure('timeout', 'timeout'), 60_000, 30_000)).toBeNull();
    expect(shortWaitMs(failure('authentication', 'auth'), 5_000, 2_000)).toBeNull();
    expect(shortWaitMs(failure('exhausted_capacity', 'exhausted'), 5_000, 2_000)).toBeNull();
  });

  it('normalizes an invalid retry hint to the default cooldown', () => {
    expect(
      shortWaitMs(failure('temporary_rate_limit', 'slow', { retryAfterMs: -5 }), 5_000, 2_000),
    ).toBe(1_000);
    expect(
      shortWaitMs(
        failure('temporary_rate_limit', 'slow', { retryAfterMs: Number.NaN }),
        5_000,
        2_000,
      ),
    ).toBe(1_000);
  });
});
