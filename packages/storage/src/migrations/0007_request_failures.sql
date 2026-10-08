CREATE TABLE IF NOT EXISTS request_failures (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, provider_id TEXT NOT NULL, model_ref TEXT NOT NULL,
  key_id TEXT, request_id TEXT NOT NULL, session_id TEXT, source TEXT NOT NULL,
  kind TEXT NOT NULL, status_code INTEGER, message TEXT NOT NULL, counted INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS request_failures_provider_at ON request_failures(provider_id, at);
CREATE INDEX IF NOT EXISTS request_failures_at ON request_failures(at);
CREATE TABLE IF NOT EXISTS request_failure_state (
  provider_id TEXT NOT NULL, model_ref TEXT NOT NULL, last_success_at TEXT,
  reset_after_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(provider_id, model_ref)
);
