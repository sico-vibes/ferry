ALTER TABLE sessions ADD COLUMN workspace_id TEXT;
UPDATE sessions SET workspace_id = json_extract(data_json, '$.workspaceId');
CREATE INDEX IF NOT EXISTS sessions_workspace_updated_idx ON sessions(workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updated_at);

ALTER TABLE messages ADD COLUMN session_id TEXT;
ALTER TABLE messages ADD COLUMN created_at TEXT;
UPDATE messages
SET session_id = json_extract(data_json, '$.sessionId'),
    created_at = json_extract(data_json, '$.createdAt');
CREATE INDEX IF NOT EXISTS messages_session_created_idx ON messages(session_id, created_at, id);
CREATE INDEX IF NOT EXISTS requests_session_ts_idx ON requests(session_id, ts);
CREATE INDEX IF NOT EXISTS quota_observations_updated_idx ON quota_observations(updated_at);
CREATE INDEX IF NOT EXISTS optimizer_events_updated_idx ON optimizer_events(updated_at);
CREATE INDEX IF NOT EXISTS optimizer_blobs_updated_idx ON optimizer_blobs(updated_at);
