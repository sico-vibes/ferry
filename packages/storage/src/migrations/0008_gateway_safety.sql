CREATE TABLE IF NOT EXISTS gateway_requests (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_requests_at_idx ON gateway_requests(at);
CREATE TABLE IF NOT EXISTS spend_reservations (
  id TEXT PRIMARY KEY, key_id TEXT, profile_id TEXT NOT NULL, session_id TEXT NOT NULL,
  at TEXT NOT NULL, amount_usd REAL NOT NULL CHECK(amount_usd >= 0)
);
CREATE TABLE IF NOT EXISTS spend_charges (
  id TEXT PRIMARY KEY, key_id TEXT, profile_id TEXT NOT NULL, session_id TEXT NOT NULL,
  at TEXT NOT NULL, amount_usd REAL NOT NULL CHECK(amount_usd >= 0), estimated INTEGER NOT NULL, recorded INTEGER NOT NULL DEFAULT 0
);
