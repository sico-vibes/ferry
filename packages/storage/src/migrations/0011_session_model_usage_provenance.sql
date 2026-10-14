-- Exact per-model/provider/connection/account usage aggregation with retained-coverage metadata.
-- Additive over 0010: the two token-value columns become nullable (NULL = never reported, 0 = a
-- reported zero), provenance is now part of the aggregate key so same-model usage across an
-- account or connection change is no longer coalesced into an arbitrary first value, and the usage
-- ledger gains a nullable origin marker used to label historical coverage as unknown.
--
-- The new aggregate table is left empty here and populated by the version-11 step in
-- `openDatabase` (`migrateSessionModelUsageProvenance`) rather than by a blind SQL copy. That step
-- proves count/dimension completeness: exactly-covered rows are regenerated from the retained
-- ledger, while a partially-covered legacy aggregate keeps its remainder under an explicit
-- unknown-provenance bucket so no counted request or token is silently dropped. The whole rebuild
-- runs in the migration transaction, so any failed reconciliation rolls back before the old
-- `session_model_usage` table is dropped.

-- 1) Recreate the ledger with an additive origin column (NULL = origin unknown/pre-0011).
CREATE TABLE usage_event_keys_v11 (
  event_id TEXT PRIMARY KEY,
  session_id TEXT,
  model_ref TEXT,
  provider_id TEXT,
  connection_id TEXT,
  account_key TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  reasoning_tokens INTEGER,
  last_used_at TEXT NOT NULL,
  backfilled INTEGER
);
INSERT INTO usage_event_keys_v11 (
  event_id, session_id, model_ref, provider_id, connection_id, account_key,
  input_tokens, output_tokens, cached_tokens, reasoning_tokens, last_used_at, backfilled)
SELECT
  event_id, session_id, model_ref, provider_id, connection_id, account_key,
  input_tokens, output_tokens, cached_tokens, reasoning_tokens, last_used_at, NULL
FROM usage_event_keys;
DROP TABLE usage_event_keys;
ALTER TABLE usage_event_keys_v11 RENAME TO usage_event_keys;
CREATE INDEX IF NOT EXISTS usage_event_keys_session_model_time_idx
  ON usage_event_keys(session_id, model_ref, last_used_at);

-- 2) Exact aggregate target. provider/connection/account are NOT NULL sentinels ('' = unknown) so
--    the primary key distinguishes unknown provenance from a known one instead of merging them.
--    Populated by `migrateSessionModelUsageProvenance`, then renamed over the old table.
CREATE TABLE session_model_usage_v11 (
  session_id TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  connection_id TEXT NOT NULL DEFAULT '',
  account_key TEXT NOT NULL DEFAULT '',
  provenance_known INTEGER NOT NULL DEFAULT 1,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  reasoning_tokens INTEGER,
  input_reported INTEGER NOT NULL DEFAULT 0,
  output_reported INTEGER NOT NULL DEFAULT 0,
  cached_reported INTEGER NOT NULL DEFAULT 0,
  reasoning_reported INTEGER NOT NULL DEFAULT 0,
  unreported_requests INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (session_id, model_ref, provider_id, connection_id, account_key)
);

-- 3) Indexed session selection for approval lookups. The guarded expression is evaluated lazily, so
--    a malformed JSON row indexes as NULL instead of aborting the migration.
CREATE INDEX IF NOT EXISTS messages_session_id_idx
  ON messages(CASE WHEN json_valid(data_json) THEN json_extract(data_json,'$.sessionId') END);
