import type Database from 'better-sqlite3';

/** A durable per-session/model/provenance usage aggregate row with nullable token dimensions. */
export interface SessionModelUsageRow {
  sessionId: string;
  modelRef: string;
  providerId: string | null;
  connectionId: string | null;
  accountKey: string | null;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  lastUsedAt: string;
  unreportedRequests: number;
  /** True when at least one request in the row left a primary token dimension (input/output) unreported. */
  incomplete: boolean;
}

/** Summed token usage for a session; a token field is null only when never reported. */
export interface SessionModelUsageTotals {
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  unreportedRequests: number;
}

/** Retained-coverage metadata for a session's usage, owned by the repository. */
export interface SessionModelUsageCoverage {
  /**
   * Earliest retained usage-ledger event timestamp for the session. This is the *retained* coverage
   * start, not a proof of the conversation's true first request; it is null when there is no retained
   * ledger evidence (for example a legacy aggregate row whose detail already expired).
   */
  since: string | null;
  /**
   * True when retained evidence cannot prove the conversation's full lifetime. Set when any ledger
   * event is historical/unknown-origin (including backfilled rows) or when a legacy aggregate row
   * with no ledger evidence was preserved.
   */
  unknown: boolean;
}

export interface SessionModelUsageSummary {
  sessionId: string;
  rows: SessionModelUsageRow[];
  totals: SessionModelUsageTotals;
  /**
   * True when any counted request left a primary token dimension (input or output) unreported,
   * so the totals are a partial view. Optional cache/reasoning absence does not set this by itself.
   */
  incomplete: boolean;
  /** Deprecated alias of {@link SessionModelUsageCoverage.unknown}, retained for compatibility. */
  backfilled: boolean;
  /** Repository-owned retained-coverage start and certainty. */
  coverage: SessionModelUsageCoverage;
}

/** One usage event to fold into the aggregate; null token fields are treated as unreported. */
export interface UsageEventInput {
  eventId: string;
  sessionId: string | null;
  modelRef: string;
  providerId: string | null;
  connectionId: string | null;
  accountKey: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  timestamp: string;
}

interface StoredContribution {
  sessionId: string | null;
  modelRef: string | null;
  providerId: string | null;
  connectionId: string | null;
  accountKey: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  lastUsedAt: string;
}

interface AggregateWrite {
  sessionId: string;
  modelRef: string;
  /** Sentinel-normalized provenance; '' is the explicit unknown bucket. */
  providerId: string;
  connectionId: string;
  accountKey: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  inputReported: number;
  outputReported: number;
  cachedReported: number;
  reasoningReported: number;
  unreportedRequests: number;
  lastUsedAt: string;
}

interface RawUsageRow {
  sessionId: string;
  modelRef: string;
  providerId: string;
  connectionId: string;
  accountKey: string;
  provenanceKnown: number;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  inputReported: number;
  outputReported: number;
  cachedReported: number;
  reasoningReported: number;
  unreportedRequests: number;
  lastUsedAt: string;
}

interface BackfillRequestRow {
  eventId: string;
  ts: string;
  provider: string;
  model: string;
  sessionId: string;
  connectionId: string | null;
  accountKey: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
}

interface BucketKey {
  sessionId: string;
  modelRef: string;
  providerId: string;
  connectionId: string;
  accountKey: string;
}

const USAGE_SELECT = `SELECT session_id AS sessionId, model_ref AS modelRef, provider_id AS providerId,
  connection_id AS connectionId, account_key AS accountKey, provenance_known AS provenanceKnown, requests,
  input_tokens AS inputTokens, output_tokens AS outputTokens, cached_tokens AS cachedTokens,
  reasoning_tokens AS reasoningTokens, input_reported AS inputReported, output_reported AS outputReported,
  cached_reported AS cachedReported, reasoning_reported AS reasoningReported,
  unreported_requests AS unreportedRequests, last_used_at AS lastUsedAt FROM session_model_usage`;

/** '' is the explicit unknown-provenance bucket; NULL keeps the aggregate key exact. */
function sentinel(value: string | null): string {
  return value ?? '';
}

function unsentinel(value: string): string | null {
  return value === '' ? null : value;
}

function bucketKeyOf(bucket: BucketKey): string {
  return [
    bucket.sessionId,
    bucket.modelRef,
    bucket.providerId,
    bucket.connectionId,
    bucket.accountKey,
  ].join('\n');
}

function buildWrite(
  sessionId: string,
  modelRef: string,
  providerId: string,
  connectionId: string,
  accountKey: string,
  inputTokens: number | null,
  outputTokens: number | null,
  cachedTokens: number | null,
  reasoningTokens: number | null,
  lastUsedAt: string,
): AggregateWrite {
  const inputReported = inputTokens === null ? 0 : 1;
  const outputReported = outputTokens === null ? 0 : 1;
  const cachedReported = cachedTokens === null ? 0 : 1;
  const reasoningReported = reasoningTokens === null ? 0 : 1;
  return {
    sessionId,
    modelRef,
    providerId,
    connectionId,
    accountKey,
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    inputReported,
    outputReported,
    cachedReported,
    reasoningReported,
    unreportedRequests:
      inputReported || outputReported || cachedReported || reasoningReported ? 0 : 1,
    lastUsedAt,
  };
}

function addAggregate(db: Database.Database, write: AggregateWrite): void {
  db.prepare(
    `INSERT INTO session_model_usage (session_id,model_ref,provider_id,connection_id,account_key,provenance_known,requests,input_tokens,output_tokens,cached_tokens,reasoning_tokens,input_reported,output_reported,cached_reported,reasoning_reported,unreported_requests,last_used_at)
     VALUES (@sessionId,@modelRef,@providerId,@connectionId,@accountKey,1,1,@inputTokens,@outputTokens,@cachedTokens,@reasoningTokens,@inputReported,@outputReported,@cachedReported,@reasoningReported,@unreportedRequests,@lastUsedAt)
     ON CONFLICT(session_id,model_ref,provider_id,connection_id,account_key) DO UPDATE SET
       requests=requests+1,
       input_tokens=CASE WHEN excluded.input_tokens IS NULL THEN input_tokens
         WHEN input_tokens IS NULL THEN excluded.input_tokens ELSE input_tokens+excluded.input_tokens END,
       output_tokens=CASE WHEN excluded.output_tokens IS NULL THEN output_tokens
         WHEN output_tokens IS NULL THEN excluded.output_tokens ELSE output_tokens+excluded.output_tokens END,
       cached_tokens=CASE WHEN excluded.cached_tokens IS NULL THEN cached_tokens
         WHEN cached_tokens IS NULL THEN excluded.cached_tokens ELSE cached_tokens+excluded.cached_tokens END,
       reasoning_tokens=CASE WHEN excluded.reasoning_tokens IS NULL THEN reasoning_tokens
         WHEN reasoning_tokens IS NULL THEN excluded.reasoning_tokens ELSE reasoning_tokens+excluded.reasoning_tokens END,
       input_reported=input_reported+excluded.input_reported,
       output_reported=output_reported+excluded.output_reported,
       cached_reported=cached_reported+excluded.cached_reported,
       reasoning_reported=reasoning_reported+excluded.reasoning_reported,
       unreported_requests=unreported_requests+excluded.unreported_requests,
       provenance_known=min(provenance_known,excluded.provenance_known),
       last_used_at=max(last_used_at,excluded.last_used_at)`,
  ).run(write);
}

const AGGREGATE_WHERE =
  'session_id=@sessionId AND model_ref=@modelRef AND provider_id=@providerId AND connection_id=@connectionId AND account_key=@accountKey';

function removeAggregate(db: Database.Database, write: AggregateWrite): void {
  db.prepare(
    `UPDATE session_model_usage SET
       requests=requests-1,
       input_tokens=CASE WHEN @inputTokens IS NULL THEN input_tokens
         WHEN input_tokens IS NULL THEN NULL ELSE input_tokens-@inputTokens END,
       output_tokens=CASE WHEN @outputTokens IS NULL THEN output_tokens
         WHEN output_tokens IS NULL THEN NULL ELSE output_tokens-@outputTokens END,
       cached_tokens=CASE WHEN @cachedTokens IS NULL THEN cached_tokens
         WHEN cached_tokens IS NULL THEN NULL ELSE cached_tokens-@cachedTokens END,
       reasoning_tokens=CASE WHEN @reasoningTokens IS NULL THEN reasoning_tokens
         WHEN reasoning_tokens IS NULL THEN NULL ELSE reasoning_tokens-@reasoningTokens END,
       input_reported=input_reported-@inputReported,
       output_reported=output_reported-@outputReported,
       cached_reported=cached_reported-@cachedReported,
       reasoning_reported=reasoning_reported-@reasoningReported,
       unreported_requests=unreported_requests-@unreportedRequests
     WHERE ${AGGREGATE_WHERE}`,
  ).run(write);
  db.prepare(`DELETE FROM session_model_usage WHERE ${AGGREGATE_WHERE} AND requests<=0`).run(write);
}

/** Recomputes a bucket's lastUsedAt as the real max of its remaining ledger timestamps. */
function refreshLastUsedAt(db: Database.Database, bucket: BucketKey): void {
  const row = db
    .prepare(
      `SELECT max(last_used_at) AS lastUsedAt FROM usage_event_keys
       WHERE session_id=? AND model_ref=?
         AND coalesce(provider_id,'')=? AND coalesce(connection_id,'')=? AND coalesce(account_key,'')=?`,
    )
    .get(
      bucket.sessionId,
      bucket.modelRef,
      bucket.providerId,
      bucket.connectionId,
      bucket.accountKey,
    ) as { lastUsedAt: string | null };
  if (row.lastUsedAt === null) return;
  db.prepare(
    `UPDATE session_model_usage SET last_used_at=?
     WHERE session_id=? AND model_ref=? AND provider_id=? AND connection_id=? AND account_key=?`,
  ).run(
    row.lastUsedAt,
    bucket.sessionId,
    bucket.modelRef,
    bucket.providerId,
    bucket.connectionId,
    bucket.accountKey,
  );
}

/**
 * Folds one usage event into the exact per-model/provider/connection/account aggregate. A prior
 * contribution for the same event id is reversed first, so repeated or corrected records replace
 * rather than accumulate. Events without a session id produce no per-conversation aggregate and
 * leave no ledger row behind.
 */
export function recordUsageEvent(
  db: Database.Database,
  input: UsageEventInput,
  options: { backfilled?: boolean } = {},
): void {
  const prior = db
    .prepare(
      `SELECT session_id AS sessionId, model_ref AS modelRef, provider_id AS providerId,
       connection_id AS connectionId, account_key AS accountKey, input_tokens AS inputTokens,
       output_tokens AS outputTokens, cached_tokens AS cachedTokens,
       reasoning_tokens AS reasoningTokens, last_used_at AS lastUsedAt
       FROM usage_event_keys WHERE event_id=?`,
    )
    .get(input.eventId) as StoredContribution | undefined;
  const affected = new Map<string, BucketKey>();
  const markAffected = (bucket: BucketKey): void => {
    affected.set(bucketKeyOf(bucket), bucket);
  };
  if (prior) {
    if (prior.sessionId !== null && prior.modelRef !== null) {
      const bucket: BucketKey = {
        sessionId: prior.sessionId,
        modelRef: prior.modelRef,
        providerId: sentinel(prior.providerId),
        connectionId: sentinel(prior.connectionId),
        accountKey: sentinel(prior.accountKey),
      };
      removeAggregate(
        db,
        buildWrite(
          bucket.sessionId,
          bucket.modelRef,
          bucket.providerId,
          bucket.connectionId,
          bucket.accountKey,
          prior.inputTokens,
          prior.outputTokens,
          prior.cachedTokens,
          prior.reasoningTokens,
          prior.lastUsedAt,
        ),
      );
      markAffected(bucket);
    }
    db.prepare('DELETE FROM usage_event_keys WHERE event_id=?').run(input.eventId);
  }
  if (input.sessionId === null) {
    for (const bucket of affected.values()) refreshLastUsedAt(db, bucket);
    return;
  }
  const write = buildWrite(
    input.sessionId,
    input.modelRef,
    sentinel(input.providerId),
    sentinel(input.connectionId),
    sentinel(input.accountKey),
    input.inputTokens,
    input.outputTokens,
    input.cachedTokens,
    input.reasoningTokens,
    input.timestamp,
  );
  addAggregate(db, write);
  markAffected({
    sessionId: write.sessionId,
    modelRef: write.modelRef,
    providerId: write.providerId,
    connectionId: write.connectionId,
    accountKey: write.accountKey,
  });
  db.prepare(
    `INSERT INTO usage_event_keys (event_id,session_id,model_ref,provider_id,connection_id,account_key,input_tokens,output_tokens,cached_tokens,reasoning_tokens,last_used_at,backfilled)
     VALUES (@eventId,@sessionId,@modelRef,@providerId,@connectionId,@accountKey,@inputTokens,@outputTokens,@cachedTokens,@reasoningTokens,@lastUsedAt,@backfilled)
     ON CONFLICT(event_id) DO UPDATE SET session_id=excluded.session_id,model_ref=excluded.model_ref,
       provider_id=excluded.provider_id,connection_id=excluded.connection_id,account_key=excluded.account_key,
       input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens,
       reasoning_tokens=excluded.reasoning_tokens,last_used_at=excluded.last_used_at,backfilled=excluded.backfilled`,
  ).run({
    eventId: input.eventId,
    sessionId: input.sessionId,
    modelRef: input.modelRef,
    providerId: input.providerId,
    connectionId: input.connectionId,
    accountKey: input.accountKey,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cachedTokens: input.cachedTokens,
    reasoningTokens: input.reasoningTokens,
    lastUsedAt: input.timestamp,
    backfilled: options.backfilled === true ? 1 : 0,
  });
  // A plain append already keeps the correct max; only reversed/replaced buckets need recomputing.
  for (const bucket of affected.values()) refreshLastUsedAt(db, bucket);
}

interface RetainedRequestIdentity {
  sessionId: string | null;
  model: string;
}

/**
 * Whether an event id that is *already retained in `requests`* belongs to a legacy residual that the
 * ledger cannot describe: it has no ledger entry, and an unknown-provenance (`provenance_known = 0`)
 * aggregate already accounts for its stored `(session, model)`.
 *
 * Such a request was counted by the pre-0011 aggregate but its individual dimensions were never
 * captured, so re-recording it (a snapshot correction or a metadata/token update) must not be folded
 * again as new usage. This is deliberately conservative historical accounting: the exact per-request
 * split of the residual is unrecoverable, so we preserve the unknown totals and coverage rather than
 * invent a correction. A genuinely new request id returns `false` and is counted normally.
 */
export function isRetainedByUnknownUsage(db: Database.Database, eventId: string): boolean {
  const prior = db
    .prepare('SELECT session_id AS sessionId, model AS model FROM requests WHERE id = ?')
    .get(eventId) as RetainedRequestIdentity | undefined;
  if (prior === undefined) return false;
  if (prior.sessionId === null) return false;
  if (db.prepare('SELECT 1 FROM usage_event_keys WHERE event_id = ?').get(eventId) !== undefined)
    return false;
  return (
    db
      .prepare(
        'SELECT 1 FROM session_model_usage WHERE provenance_known = 0 AND session_id = ? AND model_ref = ?',
      )
      .get(prior.sessionId, prior.model) !== undefined
  );
}

/**
 * Folds retained request rows into the aggregate exactly once. Rows whose event id already has a
 * ledger entry are skipped, so calling this on every open is idempotent. A request whose
 * `(session, model)` already has a legacy aggregate row with no ledger evidence is also skipped:
 * that usage may already be counted, and fabricating a split would inflate the totals. Only the
 * local retained `requests` table is scanned; no CLI history is imported. Backfilled ledger rows are
 * marked with an unknown/ historical origin so coverage is labelled unknown rather than falsely
 * complete.
 *
 * Honest limitation: the pre-0011 aggregate never stored per-request dimensions, so this preserves
 * its net totals and reported counts as an unknown residual rather than reconstructing the
 * individual historical requests. A residual-covered request that is later re-recorded keeps its
 * updated detail row but does not change the aggregate (see {@link isRetainedByUnknownUsage}).
 */
export function backfillSessionModelUsage(db: Database.Database): number {
  const run = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT r.id AS eventId, r.ts, r.provider AS provider, r.model AS model,
         r.session_id AS sessionId, r.connection_id AS connectionId, r.account_key AS accountKey,
         r.input_tokens AS inputTokens, r.output_tokens AS outputTokens,
         r.cached_tokens AS cachedTokens, r.reasoning_tokens AS reasoningTokens
         FROM requests r
         JOIN sessions s ON s.id = r.session_id
         LEFT JOIN usage_event_keys k ON k.event_id = r.id
         WHERE r.session_id IS NOT NULL AND k.event_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM session_model_usage u
             WHERE u.provenance_known = 0 AND u.session_id = r.session_id AND u.model_ref = r.model
           )
         ORDER BY r.ts, r.id`,
      )
      .all() as BackfillRequestRow[];
    for (const row of rows) {
      recordUsageEvent(
        db,
        {
          eventId: row.eventId,
          sessionId: row.sessionId,
          modelRef: row.model,
          providerId: row.provider,
          connectionId: row.connectionId,
          accountKey: row.accountKey,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cachedTokens: row.cachedTokens,
          reasoningTokens: row.reasoningTokens,
          timestamp: row.ts,
        },
        { backfilled: true },
      );
    }
    return rows.length;
  });
  return run();
}

/** Typed failure when a v10→v11 usage rebuild cannot be reconciled without losing retained evidence. */
export class UsageProvenanceMigrationError extends Error {
  readonly kind = 'migration_integrity';
  constructor(message: string) {
    super(message);
    this.name = 'UsageProvenanceMigrationError';
  }
}

/** A coalesced pre-0011 aggregate row (primary key is session + model only). */
interface LegacyUsageAggregateRow {
  sessionId: string;
  modelRef: string;
  providerId: string;
  connectionId: string;
  accountKey: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  inputReported: number;
  outputReported: number;
  cachedReported: number;
  reasoningReported: number;
  unreportedRequests: number;
  lastUsedAt: string;
}

/** Ledger evidence rolled up to the legacy `(session, model)` granularity for reconciliation. */
interface LedgerRollup {
  sessionId: string;
  modelRef: string;
  requests: number;
  inputTokens: number;
  inputReported: number;
  outputTokens: number;
  outputReported: number;
  cachedTokens: number;
  cachedReported: number;
  reasoningTokens: number;
  reasoningReported: number;
  unreportedRequests: number;
}

/**
 * Regenerates exact per-provenance aggregate rows from the retained ledger. A ledger event whose
 * session row is gone (an orphan left by an independent table salvage) must not resurrect a deleted
 * conversation's aggregate, so those events are skipped.
 */
const LEDGER_DERIVED_INSERT = `INSERT INTO session_model_usage_v11 (
  session_id, model_ref, provider_id, connection_id, account_key, provenance_known,
  requests, input_tokens, output_tokens, cached_tokens, reasoning_tokens,
  input_reported, output_reported, cached_reported, reasoning_reported,
  unreported_requests, last_used_at)
SELECT
  k.session_id, k.model_ref,
  COALESCE(k.provider_id, ''), COALESCE(k.connection_id, ''), COALESCE(k.account_key, ''),
  1,
  COUNT(*), SUM(k.input_tokens), SUM(k.output_tokens), SUM(k.cached_tokens),
  SUM(k.reasoning_tokens),
  SUM(CASE WHEN k.input_tokens IS NOT NULL THEN 1 ELSE 0 END),
  SUM(CASE WHEN k.output_tokens IS NOT NULL THEN 1 ELSE 0 END),
  SUM(CASE WHEN k.cached_tokens IS NOT NULL THEN 1 ELSE 0 END),
  SUM(CASE WHEN k.reasoning_tokens IS NOT NULL THEN 1 ELSE 0 END),
  SUM(CASE WHEN k.input_tokens IS NULL AND k.output_tokens IS NULL
            AND k.cached_tokens IS NULL AND k.reasoning_tokens IS NULL THEN 1 ELSE 0 END),
  MAX(k.last_used_at)
FROM usage_event_keys k
WHERE k.session_id IS NOT NULL AND k.model_ref IS NOT NULL
  AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = k.session_id)
GROUP BY k.session_id, k.model_ref,
  COALESCE(k.provider_id, ''), COALESCE(k.connection_id, ''), COALESCE(k.account_key, '')`;

const LEDGER_ROLLUP = `SELECT session_id AS sessionId, model_ref AS modelRef,
  SUM(requests) AS requests,
  COALESCE(SUM(input_tokens), 0) AS inputTokens, SUM(input_reported) AS inputReported,
  COALESCE(SUM(output_tokens), 0) AS outputTokens, SUM(output_reported) AS outputReported,
  COALESCE(SUM(cached_tokens), 0) AS cachedTokens, SUM(cached_reported) AS cachedReported,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
  SUM(reasoning_reported) AS reasoningReported,
  SUM(unreported_requests) AS unreportedRequests
FROM session_model_usage_v11
GROUP BY session_id, model_ref`;

const LEGACY_AGGREGATE_SELECT = `SELECT session_id AS sessionId, model_ref AS modelRef,
  COALESCE(provider_id, '') AS providerId, COALESCE(connection_id, '') AS connectionId,
  COALESCE(account_key, '') AS accountKey, requests,
  input_tokens AS inputTokens, output_tokens AS outputTokens,
  cached_tokens AS cachedTokens, reasoning_tokens AS reasoningTokens,
  input_reported AS inputReported, output_reported AS outputReported,
  cached_reported AS cachedReported, reasoning_reported AS reasoningReported,
  unreported_requests AS unreportedRequests, last_used_at AS lastUsedAt
FROM session_model_usage`;

/**
 * Adds a legacy aggregate's uncovered remainder into its unknown-provenance bucket. If the ledger
 * already produced a bucket under the same full key, the remainder is summed into it rather than
 * colliding; the bucket is then conservatively marked unknown.
 */
const RESIDUAL_UPSERT = `INSERT INTO session_model_usage_v11 (
  session_id, model_ref, provider_id, connection_id, account_key, provenance_known,
  requests, input_tokens, output_tokens, cached_tokens, reasoning_tokens,
  input_reported, output_reported, cached_reported, reasoning_reported,
  unreported_requests, last_used_at)
VALUES (@sessionId, @modelRef, @providerId, @connectionId, @accountKey, 0,
  @requests, @inputTokens, @outputTokens, @cachedTokens, @reasoningTokens,
  @inputReported, @outputReported, @cachedReported, @reasoningReported,
  @unreportedRequests, @lastUsedAt)
ON CONFLICT(session_id, model_ref, provider_id, connection_id, account_key) DO UPDATE SET
  requests = requests + excluded.requests,
  input_tokens = CASE WHEN excluded.input_tokens IS NULL THEN input_tokens
    WHEN input_tokens IS NULL THEN excluded.input_tokens ELSE input_tokens + excluded.input_tokens END,
  output_tokens = CASE WHEN excluded.output_tokens IS NULL THEN output_tokens
    WHEN output_tokens IS NULL THEN excluded.output_tokens ELSE output_tokens + excluded.output_tokens END,
  cached_tokens = CASE WHEN excluded.cached_tokens IS NULL THEN cached_tokens
    WHEN cached_tokens IS NULL THEN excluded.cached_tokens ELSE cached_tokens + excluded.cached_tokens END,
  reasoning_tokens = CASE WHEN excluded.reasoning_tokens IS NULL THEN reasoning_tokens
    WHEN reasoning_tokens IS NULL THEN excluded.reasoning_tokens ELSE reasoning_tokens + excluded.reasoning_tokens END,
  input_reported = input_reported + excluded.input_reported,
  output_reported = output_reported + excluded.output_reported,
  cached_reported = cached_reported + excluded.cached_reported,
  reasoning_reported = reasoning_reported + excluded.reasoning_reported,
  unreported_requests = unreported_requests + excluded.unreported_requests,
  provenance_known = min(provenance_known, excluded.provenance_known),
  last_used_at = max(last_used_at, excluded.last_used_at)`;

interface ResidualDimension {
  tokens: number | null;
  reported: number;
}

/**
 * The remainder of one legacy token dimension after subtracting exactly-accounted ledger evidence.
 * A dimension the legacy row never reported stays `null` (not a fabricated zero), a reported value
 * that nets to zero stays `0`, and a value with no matching reported request is kept with an honest
 * lower-bound count of one so the token total is never dropped. A negative remainder means the
 * ledger cannot be part of this legacy aggregate, so reconciliation is refused.
 */
function residualDimension(
  legacyTokens: number,
  legacyReported: number,
  ledgerTokens: number,
  ledgerReported: number,
  label: string,
  context: string,
): ResidualDimension {
  if (legacyReported <= 0) return { tokens: null, reported: 0 };
  const tokens = legacyTokens - ledgerTokens;
  const reported = legacyReported - ledgerReported;
  if (tokens < 0 || reported < 0)
    throw new UsageProvenanceMigrationError(
      `Cannot reconcile ${label} for ${context}: retained ledger exceeds the legacy aggregate`,
    );
  if (tokens === 0 && reported === 0) return { tokens: null, reported: 0 };
  return { tokens, reported: reported > 0 ? reported : 1 };
}

/**
 * Populates the exact v11 aggregate from a pre-0011 database without losing retained usage.
 *
 * Every ledger event is rebuilt at its exact `(provider, connection, account)` provenance, but only
 * for conversations that still exist. For each legacy `(session, model)` aggregate the retained
 * ledger is then treated as a *candidate subset*: its request count and every reported token
 * dimension are subtracted, and any remaining totals are kept in a `provenance_known = 0` bucket
 * (the legacy provenance label retained as a hint, or merged into the same unknown bucket) rather
 * than guessed into a specific provider/account split. Exactly-covered rows therefore become exact
 * provenance rows, a partially-covered row keeps both its exactly-accounted portion and an honest
 * remainder, and an uncovered row survives whole as unknown.
 *
 * Missing evidence is never turned into a destructive guess: if the remainder would be negative (the
 * ledger claims more usage than the legacy aggregate held) a {@link UsageProvenanceMigrationError}
 * is thrown and the enclosing migration transaction rolls back with the v10 data intact.
 *
 * The remainder is not counted twice by later backfill or by `RequestRepository.put`:
 * `backfillSessionModelUsage` and `isRetainedByUnknownUsage` both skip a retained request whose
 * `(session, model)` owns a `provenance_known = 0` row, so detail already represented by the legacy
 * totals is never re-folded. Honest limitation: the residual preserves the pre-0011 aggregate's net
 * totals and reported counts only; the individual historical requests never captured in the ledger
 * cannot be reconstructed, so they are labelled unknown rather than claimed as exact per-request
 * dimensions.
 */
export function migrateSessionModelUsageProvenance(db: Database.Database): void {
  db.prepare(LEDGER_DERIVED_INSERT).run();
  const rollups = new Map<string, LedgerRollup>();
  for (const row of db.prepare(LEDGER_ROLLUP).all() as LedgerRollup[]) {
    rollups.set(`${row.sessionId}\n${row.modelRef}`, row);
  }
  const upsert = db.prepare(RESIDUAL_UPSERT);
  for (const row of db.prepare(LEGACY_AGGREGATE_SELECT).all() as LegacyUsageAggregateRow[]) {
    const context = `${row.sessionId}/${row.modelRef}`;
    const ledger = rollups.get(`${row.sessionId}\n${row.modelRef}`);
    const requests = row.requests - (ledger?.requests ?? 0);
    if (requests < 0)
      throw new UsageProvenanceMigrationError(
        `Cannot reconcile usage for ${context}: retained ledger has more requests than the legacy aggregate`,
      );
    const unreportedRequests = row.unreportedRequests - (ledger?.unreportedRequests ?? 0);
    if (unreportedRequests < 0)
      throw new UsageProvenanceMigrationError(
        `Cannot reconcile unreported requests for ${context}: retained ledger exceeds the legacy aggregate`,
      );
    const input = residualDimension(
      row.inputTokens,
      row.inputReported,
      ledger?.inputTokens ?? 0,
      ledger?.inputReported ?? 0,
      'input tokens',
      context,
    );
    const output = residualDimension(
      row.outputTokens,
      row.outputReported,
      ledger?.outputTokens ?? 0,
      ledger?.outputReported ?? 0,
      'output tokens',
      context,
    );
    const cached = residualDimension(
      row.cachedTokens,
      row.cachedReported,
      ledger?.cachedTokens ?? 0,
      ledger?.cachedReported ?? 0,
      'cached tokens',
      context,
    );
    const reasoning = residualDimension(
      row.reasoningTokens,
      row.reasoningReported,
      ledger?.reasoningTokens ?? 0,
      ledger?.reasoningReported ?? 0,
      'reasoning tokens',
      context,
    );
    const hasRemainder =
      requests > 0 ||
      unreportedRequests > 0 ||
      input.tokens !== null ||
      output.tokens !== null ||
      cached.tokens !== null ||
      reasoning.tokens !== null;
    if (!hasRemainder) continue;
    upsert.run({
      sessionId: row.sessionId,
      modelRef: row.modelRef,
      providerId: row.providerId,
      connectionId: row.connectionId,
      accountKey: row.accountKey,
      requests,
      inputTokens: input.tokens,
      outputTokens: output.tokens,
      cachedTokens: cached.tokens,
      reasoningTokens: reasoning.tokens,
      inputReported: input.reported,
      outputReported: output.reported,
      cachedReported: cached.reported,
      reasoningReported: reasoning.reported,
      unreportedRequests,
      lastUsedAt: row.lastUsedAt,
    });
  }
}

function toRow(row: RawUsageRow): SessionModelUsageRow {
  return {
    sessionId: row.sessionId,
    modelRef: row.modelRef,
    providerId: unsentinel(row.providerId),
    connectionId: unsentinel(row.connectionId),
    accountKey: unsentinel(row.accountKey),
    requests: row.requests,
    inputTokens: row.inputReported > 0 ? row.inputTokens : null,
    outputTokens: row.outputReported > 0 ? row.outputTokens : null,
    cachedTokens: row.cachedReported > 0 ? row.cachedTokens : null,
    reasoningTokens: row.reasoningReported > 0 ? row.reasoningTokens : null,
    lastUsedAt: row.lastUsedAt,
    unreportedRequests: row.unreportedRequests,
    incomplete: row.requests > row.inputReported || row.requests > row.outputReported,
  };
}

function sumDimension(
  rows: readonly SessionModelUsageRow[],
  pick: (row: SessionModelUsageRow) => number | null,
): number | null {
  let total = 0;
  let reported = false;
  for (const row of rows) {
    const value = pick(row);
    if (value === null) continue;
    reported = true;
    total += value;
  }
  return reported ? total : null;
}

function totalsOf(rows: readonly SessionModelUsageRow[]): SessionModelUsageTotals {
  return {
    requests: rows.reduce((total, row) => total + row.requests, 0),
    inputTokens: sumDimension(rows, (row) => row.inputTokens),
    outputTokens: sumDimension(rows, (row) => row.outputTokens),
    cachedTokens: sumDimension(rows, (row) => row.cachedTokens),
    reasoningTokens: sumDimension(rows, (row) => row.reasoningTokens),
    unreportedRequests: rows.reduce((total, row) => total + row.unreportedRequests, 0),
  };
}

/** Reads durable per-session/model/provenance usage aggregates and retained-coverage metadata. */
export class SessionModelUsageRepository {
  constructor(private readonly db: Database.Database) {}

  /** All aggregate rows, ordered by session, model and provenance. */
  list(): SessionModelUsageRow[] {
    return (
      this.db
        .prepare(
          `${USAGE_SELECT} ORDER BY session_id, model_ref, provider_id, connection_id, account_key`,
        )
        .all() as RawUsageRow[]
    ).map(toRow);
  }

  /** Rows, nullable totals and retained-coverage metadata for one session in a single indexed read. */
  getBySession(sessionId: string): SessionModelUsageSummary {
    const raw = this.db
      .prepare(
        `${USAGE_SELECT} WHERE session_id=? ORDER BY model_ref, provider_id, connection_id, account_key`,
      )
      .all(sessionId) as RawUsageRow[];
    const rows = raw.map(toRow);
    const coverage = this.coverage(sessionId);
    return {
      sessionId,
      rows,
      totals: totalsOf(rows),
      incomplete: rows.some((row) => row.incomplete),
      backfilled: coverage.unknown,
      coverage,
    };
  }

  /**
   * Retained coverage: the earliest retained ledger event timestamp and whether the evidence can
   * prove full-lifetime coverage. Never derived from per-model `lastUsedAt`.
   */
  coverage(sessionId: string): SessionModelUsageCoverage {
    const ledger = this.db
      .prepare(
        `SELECT MIN(last_used_at) AS since,
           SUM(CASE WHEN backfilled IS NULL OR backfilled = 1 THEN 1 ELSE 0 END) AS uncertain
         FROM usage_event_keys WHERE session_id = ?`,
      )
      .get(sessionId) as { since: string | null; uncertain: number | null };
    const legacy = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM session_model_usage WHERE session_id = ? AND provenance_known = 0',
      )
      .get(sessionId) as { n: number };
    return { since: ledger.since ?? null, unknown: (ledger.uncertain ?? 0) > 0 || legacy.n > 0 };
  }
}
