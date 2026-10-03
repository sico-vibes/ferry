CREATE TABLE IF NOT EXISTS provider_key_entries (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ok',
  last_error TEXT,
  cooldown_until TEXT,
  keyring_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_id, key_id)
);
CREATE INDEX IF NOT EXISTS provider_key_entries_provider_idx
  ON provider_key_entries(provider_id, position);
CREATE TABLE IF NOT EXISTS provider_key_usage_daily (
  day TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  requests INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  PRIMARY KEY(day, provider_id, key_id)
);
INSERT OR IGNORE INTO provider_key_entries
  (id, provider_id, key_id, label, position, enabled, status, last_error, cooldown_until, keyring_ref, created_at, updated_at)
SELECT id || ':1', provider_id, '1', 'Key 1', 0, 1, 'ok', NULL, NULL, keyring_ref, created_at, created_at
FROM provider_keys;
