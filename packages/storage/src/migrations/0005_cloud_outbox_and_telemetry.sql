CREATE TABLE IF NOT EXISTS cloud_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL,
  op TEXT NOT NULL CHECK(op IN ('upsert','insert','delete','rpc')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','failed_permanent')),
  generation INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS cloud_outbox_due_idx ON cloud_outbox(status,next_attempt_at,id);

CREATE TABLE IF NOT EXISTS telemetry_turns (
  id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, user_message_id TEXT, device_id TEXT,
  trace_id TEXT, request_group_id TEXT, attempt INTEGER, parent_turn_id TEXT, source TEXT,
  task_id TEXT, step_id TEXT, step_kind TEXT, agent_role TEXT, agent_profile_id TEXT,
  requested_model TEXT, routing_mode TEXT, routed_provider TEXT, routed_model TEXT,
  routed_upstream_model TEXT, response_model TEXT, provider_key_id TEXT, fallback_reason TEXT,
  routing_decision_json TEXT, routed_differs_from_requested INTEGER, response_differs_from_routed INTEGER,
  status TEXT, http_status INTEGER, error_kind TEXT, error_message TEXT, finish_reason TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
  cost_usd REAL, plan_units REAL, latency_ms INTEGER, ttft_ms INTEGER, request_bytes INTEGER,
  rate_limit_headers_json TEXT, started_at TEXT, finished_at TEXT, created_at TEXT, updated_at TEXT,
  data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS telemetry_turns_session_idx ON telemetry_turns(session_id);
CREATE INDEX IF NOT EXISTS telemetry_turns_trace_idx ON telemetry_turns(trace_id);
CREATE INDEX IF NOT EXISTS telemetry_turns_started_idx ON telemetry_turns(started_at);

CREATE TABLE IF NOT EXISTS telemetry_logs (
  id TEXT PRIMARY KEY, ts TEXT, device_id TEXT, level TEXT, source TEXT, event TEXT, message TEXT,
  session_id TEXT, turn_id TEXT, trace_id TEXT, span_id TEXT, parent_span_id TEXT, app_version TEXT,
  data TEXT, data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS telemetry_logs_session_idx ON telemetry_logs(session_id);
CREATE INDEX IF NOT EXISTS telemetry_logs_trace_idx ON telemetry_logs(trace_id);
CREATE INDEX IF NOT EXISTS telemetry_logs_ts_idx ON telemetry_logs(ts);

CREATE TABLE IF NOT EXISTS telemetry_model_switches (
  id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, kind TEXT, from_model TEXT, to_model TEXT,
  from_provider TEXT, to_provider TEXT, reason TEXT, data TEXT, created_at TEXT,
  data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS telemetry_model_switches_session_idx ON telemetry_model_switches(session_id);
CREATE INDEX IF NOT EXISTS telemetry_model_switches_created_idx ON telemetry_model_switches(created_at);
