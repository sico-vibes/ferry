# Ferry cloud mode

Cloud mode keeps SQLite as Ferry's synchronous working store. Repository writes are observed locally and written to `cloud_outbox`; `CloudSyncWorker` uploads those durable operations when Supabase auth has a user session. Local mode does not create a Supabase client and uses a no-op mirror. Changing `storageMode` is persisted locally and takes effect after restarting Ferry. If cloud is selected without configuration, startup uses the local adapter and reports that configuration is missing.

## Configuration and auth

Set `FERRY_SUPABASE_URL` and `FERRY_SUPABASE_PUBLISHABLE_KEY` in the process environment or in the repo `config/.env` (development) or `<FERRY_HOME>/config/.env` / `<FERRY_HOME>/cloud.env` (installed builds). `FERRY_SUPABASE_SCHEMA` defaults to `ferry`; `FERRY_CLOUD_OWNER_EMAIL` is optional. Process environment wins. Only the named `FERRY_SUPABASE_*` and `FERRY_CLOUD_*` keys are read. Use a publishable key only. Supabase refresh sessions are persisted in the OS keychain under a project-scoped Ferry account; passwords are passed directly to Auth and never persisted.

Cloud mode without configuration continues to use local storage and exposes a configuration status. Cloud mode while signed out continues local work and leaves writes in the outbox until sign-in. Provider keys are sent only through Vault RPCs and are never queued; without connectivity, saving a key fails clearly. While signed out, `get` returns `undefined` without a request, and set/delete report that cloud sign-in is required. The keychain provider store is not used as a cloud-mode fallback.

Refresh tokens are held in the OS keychain. Provider key migration uses `migrateLocalKeysToVault`, uploads entries referenced by `provider_key_entries.keyringRef` to Vault, and reports migrated/missing/failed counts without returning or logging values. It leaves the local keychain copy intact so switching back to local mode remains possible. OAuth references (`oauth:<provider>`) also use Vault with provider id `oauth`; this keeps all cloud-mode credentials under the same account scoped Vault/RLS policy and avoids maintaining a second secret backend.

## Outbox and mapping

`cloud_outbox` lives in the same SQLite database and stores idempotent operation ids, JSON payloads, retry counts and due times. Re-enqueuing a pending operation coalesces its payload and increments its generation. A worker may delete/retry/fail only the generation it claimed, so a newer payload written during a request remains pending. Re-enqueuing a failed-permanent operation revives it with zero attempts. Workspace/session/message dependencies are ordered before children; FK failures remain retryable with a high cap. Transient failures use bounded exponential backoff with jitter. Constraint/permission/schema errors become permanent after four attempts. Ferry entity IDs stay as cloud row IDs; Supabase supplies `user_id` from the authenticated user. Workspace, session and message rows map to `ferry.workspaces`, `ferry.sessions` and `ferry.messages`; task records, settings and provider configuration map to their matching tables. Other local aggregates use kind-scoped `ferry.sync_records` operation IDs. Telemetry repositories use explicit local `telemetry_*` columns matching the cloud tables, with JSON in text columns and an extra `data_json` for unmapped fields.

| Local data | Cloud destination |
| --- | --- |
| workspaces, sessions, messages, tasks | `workspaces`, `sessions`, `messages`, `task_records` |
| settings key/value and global profile settings | `settings_kv`, `profiles` |
| quota windows and cooldowns | `quota_windows`, `cooldowns` |
| provider key entry metadata | `provider_keys` UPDATE after the Vault RPC creates the row; only allowed metadata columns are sent |
| provider config, model cache, checkpoints, delegations, optimizer events/blobs, task steps, decisions, touched files, handoffs, quota observations | `sync_records` with the schema's constrained kind; operation IDs include kind and Ferry id |
| requests / turn attempts | Job C's `ferry.turns` hook |

Vault create/rotate/delete operations run directly through their RPCs. Provider key metadata never includes `keyringRef` or key material. Provider deletion is performed by the Vault RPC, so it does not enqueue a second table delete.

The session selection contract is deliberate: `sessions.selected_model` is `pinnedModelRef ?? 'auto'`, while `pinned_model` is `pinnedModelRef`. The last model that answered is stored as `metadata.lastModelRef`. This keeps fallback responses from looking like user selection changes to the database trigger.

On sign-in the worker pulls workspaces, sessions, messages, task records and settings. Hydration inserts missing local rows through a no-mirror adapter. It never replaces local messages. A session can replace a local row only when the full session in cloud metadata has a newer Ferry `updatedAt` and no pending session outbox operation exists. Content-capture-off placeholders are skipped and counted rather than saved as prompt/response content.

`captureContent` is explicit when set. When unset, cloud defaults to capture and local defaults to metadata-only. Cloud mapping redacts known and secret-shaped values before queueing. With capture disabled, message parts retain structural metadata and replace content values with character-count markers. Session selection writes use the fields above regardless of capture setting; message parts and session metadata retain full Ferry objects only while capture is enabled.

## Telemetry, traces, and retention

Structured telemetry is written to the local SQLite `telemetry_turns`, `telemetry_logs`, and `telemetry_model_switches` tables in both modes. Local mode keeps telemetry local; content fields are omitted by default. In configured cloud mode the same sanitized records are also placed in `cloud_outbox`: provider attempts upsert to `ferry.turns` keyed by Ferry turn id, append-only events insert into `ferry.logs` with a client `data.event_id`, and app-authored model switches insert into `ferry.model_switches` with an event id. Session selection and router fallback switches are generated by schema triggers from session and turn writes, so the client avoids duplicating those records. Existing `requests` records remain in place.

One 32-character lowercase hexadecimal trace id identifies each submitted request. Provider attempt rows share a request group id and link fallback attempts through `parent_turn_id`; event rows carry trace and span fields where available. The structured event names include request receipt, requested/completed/failed turns, fallbacks, tool calls/results, model switches, and sync errors. Attempt rows hold requested and routed model values separately; response model and upstream model are recorded when the provider boundary exposes them.

`captureContent` defaults to ON in cloud mode and OFF in local mode. When enabled, prompt, response, reasoning, and tool I/O fields may be captured after deep secret redaction. When disabled, those values become omitted markers with character counts. Credential-shaped strings and credential-valued fields are redacted in all telemetry regardless of mode. Local `telemetry_logs` should use a 30-day retention policy; current local telemetry is durable until cleanup is added. The cloud `ferry.logs` table has its existing 30-day retention job.

### Recommended new tables

These event families currently use `ferry.logs` or kind-scoped `ferry.sync_records`; they are recommendations only and are not part of the applied schema:

- `ferry.tool_events`: `id`, `session_id`, `turn_id`, `trace_id`, `tool_call_id`, `tool_name`, `status`, `input`, `output`, `started_at`, `finished_at`.
- `ferry.approval_events`: `id`, `session_id`, `trace_id`, `approval_id`, `tool_name`, `decision`, `requested_at`, `resolved_at`.
- `ferry.delegation_events`: `id`, `session_id`, `trace_id`, `parent_trace_id`, `delegation_id`, `agent`, `status`, `started_at`, `finished_at`, `data`.
- `ferry.lifecycle_events`: `id`, `device_id`, `trace_id`, `event`, `occurred_at`, `app_version`, `data`.
- `ferry.provider_key_events`: `id`, `provider_key_id`, `provider_id`, `event`, `occurred_at`, `trace_id`, `data` (metadata only; never a secret).
