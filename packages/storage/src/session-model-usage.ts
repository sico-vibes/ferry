import type Database from 'better-sqlite3';

/** A durable per-session/model usage aggregate row with nullable token dimensions. */
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

export interface SessionModelUsageSummary {
  sessionId: string;
  rows: SessionModelUsageRow[];
  totals: SessionModelUsageTotals;
  /**
   * True when any counted request left a primary token dimension (input or output) unreported,
   * so the totals are a partial view. Optional cache/reasoning absence does not set this by itself.
   */
  incomplete: boolean;
  /** True when any row was materialized from retained-history backfill (older history is gone). */
  backfilled: boolean;
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
  providerId: string | null;
  connectionId: string | null;
  accountKey: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  inputReported: number;
  outputReported: number;
  cachedReported: number;
  reasoningReported: number;
  unreportedRequests: number;
  backfilled: number;
  lastUsedAt: string;
}

interface RawUsageRow {
  sessionId: string;
  modelRef: string;
  providerId: string | null;
  connectionId: string | null;
  accountKey: string | null;
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
  backfilled: number;
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

const USAGE_SELECT = `SELECT session_id AS sessionId, model_ref AS modelRef, provider_id AS providerId,
  connection_id AS connectionId, account_key AS accountKey, requests,
  input_tokens AS inputTokens, output_tokens AS outputTokens, cached_tokens AS cachedTokens,
  reasoning_tokens AS reasoningTokens, input_reported AS inputReported, output_reported AS outputReported,
  cached_reported AS cachedReported, reasoning_reported AS reasoningReported,
  unreported_requests AS unreportedRequests, backfilled, last_used_at AS lastUsedAt FROM session_model_usage`;

function buildWrite(
  sessionId: string,
  modelRef: string,
  providerId: string | null,
  connectionId: string | null,
  accountKey: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
  cachedTokens: number | null,
  reasoningTokens: number | null,
  backfilled: boolean,
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
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedTokens: cachedTokens ?? 0,
    reasoningTokens: reasoningTokens ?? 0,
    inputReported,
    outputReported,
    cachedReported,
    reasoningReported,
    unreportedRequests:
      inputReported || outputReported || cachedReported || reasoningReported ? 0 : 1,
    backfilled: backfilled ? 1 : 0,
    lastUsedAt,
  };
}

function addAggregate(db: Database.Database, write: AggregateWrite): void {
  db.prepare(
    `INSERT INTO session_model_usage (session_id,model_ref,provider_id,connection_id,account_key,requests,input_tokens,output_tokens,cached_tokens,reasoning_tokens,input_reported,output_reported,cached_reported,reasoning_reported,unreported_requests,backfilled,last_used_at)
     VALUES (@sessionId,@modelRef,@providerId,@connectionId,@accountKey,1,@inputTokens,@outputTokens,@cachedTokens,@reasoningTokens,@inputReported,@outputReported,@cachedReported,@reasoningReported,@unreportedRequests,@backfilled,@lastUsedAt)
     ON CONFLICT(session_id,model_ref) DO UPDATE SET
       requests=requests+1,
       input_tokens=input_tokens+excluded.input_tokens,
       output_tokens=output_tokens+excluded.output_tokens,
       cached_tokens=cached_tokens+excluded.cached_tokens,
       reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens,
       input_reported=input_reported+excluded.input_reported,
       output_reported=output_reported+excluded.output_reported,
       cached_reported=cached_reported+excluded.cached_reported,
       reasoning_reported=reasoning_reported+excluded.reasoning_reported,
       unreported_requests=unreported_requests+excluded.unreported_requests,
       backfilled=max(backfilled,excluded.backfilled),
       last_used_at=max(last_used_at,excluded.last_used_at),
       provider_id=coalesce(excluded.provider_id,provider_id),
       connection_id=coalesce(excluded.connection_id,connection_id),
       account_key=coalesce(excluded.account_key,account_key)`,
  ).run(write);
}

function removeAggregate(db: Database.Database, write: AggregateWrite): void {
  db.prepare(
    `UPDATE session_model_usage SET
       requests=requests-1,
       input_tokens=input_tokens-@inputTokens,
       output_tokens=output_tokens-@outputTokens,
       cached_tokens=cached_tokens-@cachedTokens,
       reasoning_tokens=reasoning_tokens-@reasoningTokens,
       input_reported=input_reported-@inputReported,
       output_reported=output_reported-@outputReported,
       cached_reported=cached_reported-@cachedReported,
       reasoning_reported=reasoning_reported-@reasoningReported,
       unreported_requests=unreported_requests-@unreportedRequests
     WHERE session_id=@sessionId AND model_ref=@modelRef`,
  ).run(write);
  db.prepare(
    'DELETE FROM session_model_usage WHERE session_id=@sessionId AND model_ref=@modelRef AND requests<=0',
  ).run({ sessionId: write.sessionId, modelRef: write.modelRef });
}

/** Recomputes a bucket's lastUsedAt as the real max of its remaining ledger timestamps. */
function refreshLastUsedAt(db: Database.Database, sessionId: string, modelRef: string): void {
  const row = db
    .prepare(
      'SELECT max(last_used_at) AS lastUsedAt FROM usage_event_keys WHERE session_id=? AND model_ref=?',
    )
    .get(sessionId, modelRef) as { lastUsedAt: string | null };
  if (row.lastUsedAt === null) return;
  db.prepare(
    'UPDATE session_model_usage SET last_used_at=? WHERE session_id=? AND model_ref=?',
  ).run(row.lastUsedAt, sessionId, modelRef);
}

/**
 * Folds one usage event into the aggregate. A prior contribution for the same event id is
 * reversed first, so repeated or corrected records replace rather than accumulate. Events without
 * a session id produce no per-conversation aggregate and leave no ledger row behind.
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
  const affected = new Map<string, { sessionId: string; modelRef: string }>();
  const markAffected = (sessionId: string, modelRef: string): void => {
    affected.set(`${sessionId}\n${modelRef}`, { sessionId, modelRef });
  };
  if (prior) {
    if (prior.sessionId !== null && prior.modelRef !== null) {
      removeAggregate(
        db,
        buildWrite(
          prior.sessionId,
          prior.modelRef,
          prior.providerId,
          prior.connectionId,
          prior.accountKey,
          prior.inputTokens,
          prior.outputTokens,
          prior.cachedTokens,
          prior.reasoningTokens,
          false,
          prior.lastUsedAt,
        ),
      );
      markAffected(prior.sessionId, prior.modelRef);
    }
    db.prepare('DELETE FROM usage_event_keys WHERE event_id=?').run(input.eventId);
  }
  if (input.sessionId === null) {
    for (const bucket of affected.values())
      refreshLastUsedAt(db, bucket.sessionId, bucket.modelRef);
    return;
  }
  addAggregate(
    db,
    buildWrite(
      input.sessionId,
      input.modelRef,
      input.providerId,
      input.connectionId,
      input.accountKey,
      input.inputTokens,
      input.outputTokens,
      input.cachedTokens,
      input.reasoningTokens,
      options.backfilled === true,
      input.timestamp,
    ),
  );
  if (prior) markAffected(input.sessionId, input.modelRef);
  db.prepare(
    `INSERT INTO usage_event_keys (event_id,session_id,model_ref,provider_id,connection_id,account_key,input_tokens,output_tokens,cached_tokens,reasoning_tokens,last_used_at)
     VALUES (@eventId,@sessionId,@modelRef,@providerId,@connectionId,@accountKey,@inputTokens,@outputTokens,@cachedTokens,@reasoningTokens,@lastUsedAt)
     ON CONFLICT(event_id) DO UPDATE SET session_id=excluded.session_id,model_ref=excluded.model_ref,
       provider_id=excluded.provider_id,connection_id=excluded.connection_id,account_key=excluded.account_key,
       input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens,
       reasoning_tokens=excluded.reasoning_tokens,last_used_at=excluded.last_used_at`,
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
  });
  // A plain append already keeps the correct max; only reversed/replaced buckets need recomputing.
  for (const bucket of affected.values()) refreshLastUsedAt(db, bucket.sessionId, bucket.modelRef);
}

/**
 * Folds retained request rows into the aggregate exactly once. Rows whose event id already has a
 * ledger entry are skipped, so calling this on every open is idempotent. Only the local retained
 * `requests` table is scanned; no CLI history is imported.
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

function toRow(row: RawUsageRow): SessionModelUsageRow {
  return {
    sessionId: row.sessionId,
    modelRef: row.modelRef,
    providerId: row.providerId,
    connectionId: row.connectionId,
    accountKey: row.accountKey,
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

/** Reads durable per-session/model usage aggregates and backfill coverage metadata. */
export class SessionModelUsageRepository {
  constructor(private readonly db: Database.Database) {}

  /** All aggregate rows, ordered by session then model. */
  list(): SessionModelUsageRow[] {
    return (
      this.db.prepare(`${USAGE_SELECT} ORDER BY session_id, model_ref`).all() as RawUsageRow[]
    ).map(toRow);
  }

  /** Rows, nullable totals and coverage metadata for one session in a single indexed read. */
  getBySession(sessionId: string): SessionModelUsageSummary {
    const raw = this.db
      .prepare(`${USAGE_SELECT} WHERE session_id=? ORDER BY model_ref`)
      .all(sessionId) as RawUsageRow[];
    const rows = raw.map(toRow);
    return {
      sessionId,
      rows,
      totals: totalsOf(rows),
      incomplete: rows.some((row) => row.incomplete),
      backfilled: raw.some((row) => row.backfilled > 0),
    };
  }
}
