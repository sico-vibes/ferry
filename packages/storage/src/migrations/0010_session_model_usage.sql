-- Per-session/model token usage aggregates and an event ledger for idempotent dedupe.
-- Metadata only: no prompt, response, header or other captured content is stored here.
CREATE TABLE IF NOT EXISTS session_model_usage (
  session_id TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  provider_id TEXT,
  connection_id TEXT,
  account_key TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  input_reported INTEGER NOT NULL DEFAULT 0,
  output_reported INTEGER NOT NULL DEFAULT 0,
  cached_reported INTEGER NOT NULL DEFAULT 0,
  reasoning_reported INTEGER NOT NULL DEFAULT 0,
  unreported_requests INTEGER NOT NULL DEFAULT 0,
  backfilled INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (session_id, model_ref)
);
CREATE INDEX IF NOT EXISTS session_model_usage_session_idx ON session_model_usage(session_id);

CREATE TABLE IF NOT EXISTS usage_event_keys (
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
  last_used_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_event_keys_session_model_time_idx
  ON usage_event_keys(session_id, model_ref, last_used_at);

-- connection_id/account_key request attribution columns are added conditionally by openDatabase
-- so a downgraded local schema version can be replayed safely.
