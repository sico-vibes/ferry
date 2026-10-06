-- Ferry cloud mode: core schema, tables, indexes, triggers.
-- Target: any Supabase project. Ferry lives in its own `ferry` schema and can share a project.
-- Only ADDS objects in the dedicated `ferry` schema. Nothing in public/private/storage/auth is altered.
--
-- ID strategy: every entity row is keyed by (user_id, id). `id` is Ferry's own local id
-- (e.g. ses_xxx, msg_xxx, 'openrouter:1'), so the desktop/CLI can upsert 1:1 without an id map.
-- Child rows reference parents with composite FKs that include user_id, so a user can never
-- attach rows to another user's parent.

create schema if not exists ferry;
comment on schema ferry is 'Ferry coding agent cloud mode (sessions, turns, routing, keys, usage, logs). Independent of other schemas in the project.';
revoke all on schema ferry from public;

-- ---------------------------------------------------------------- helpers
create or replace function ferry.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function ferry.reject_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'ferry.% is append-only (% not allowed)', tg_table_name, tg_op using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------- admins (owner/admin role)
create table ferry.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'admin' check (role in ('owner', 'admin')),
  note       text,
  created_at timestamptz not null default now()
);
create unique index admins_single_owner_idx on ferry.admins (role) where role = 'owner';
comment on table ferry.admins is 'Ferry owner/admin marker. Exactly one owner. Independent of other apps'' roles.';

-- ---------------------------------------------------------------- profiles / settings
create table ferry.profiles (
  user_id                 uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  display_name            text,
  storage_mode            text not null default 'cloud' check (storage_mode in ('local', 'cloud', 'hybrid')),
  active_agent_profile_id text,
  default_model           text,                       -- ModelRef "provider/model" or 'auto'
  settings                jsonb not null default '{}'::jsonb,  -- Ferry Settings (packages/shared SettingsSchema)
  settings_version        integer not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
comment on table ferry.profiles is 'One row per Ferry user: storage mode + full Settings object.';

create table ferry.settings_kv (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key        text not null check (char_length(key) between 1 and 200),
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
comment on table ferry.settings_kv is 'Mirror of local settings_kv (misc keyed settings).';

create table ferry.agent_profiles (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id         text not null,                -- Ferry ProfileId
  name       text not null,
  builtin    boolean not null default false,
  data       jsonb not null default '{}'::jsonb,  -- ProfileSchema (tierByStep, allowedProviders, ...)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
comment on table ferry.agent_profiles is 'Ferry routing/agent profiles (ProfileSchema).';

create table ferry.devices (
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id           text not null default gen_random_uuid()::text,
  name         text,
  client_kind  text not null default 'desktop' check (client_kind in ('desktop', 'cli', 'gateway', 'server', 'other')),
  platform     text,                       -- win32 | darwin | linux | web
  app_version  text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, id)
);
comment on table ferry.devices is 'Each Ferry install (desktop/CLI) that syncs; referenced by turns/logs for tracing.';

-- ---------------------------------------------------------------- workspaces
create table ferry.workspaces (
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id             text not null default gen_random_uuid()::text,   -- Ferry WorkspaceId
  name           text not null,
  path           text,
  git_branch     text,
  language       text,
  settings       jsonb not null default '{}'::jsonb,              -- WorkspaceSettings
  last_opened_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz,
  primary key (user_id, id)
);

-- ---------------------------------------------------------------- sessions
create table ferry.sessions (
  user_id              uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                   text not null default gen_random_uuid()::text,  -- Ferry SessionId
  workspace_id         text,
  title                text not null default '',
  preview              text not null default '',
  agent_profile_id     text,
  selected_model       text,      -- Session.modelRef: what the UI shows/selected (or 'auto')
  pinned_model         text,      -- Session.pinnedModelRef
  starred              boolean not null default false,
  pinned               boolean not null default false,
  status               text not null default 'idle'
                       check (status in ('idle', 'running', 'awaiting_approval', 'error', 'interrupted')),
  in_flight            boolean not null default false,
  -- denormalised from the latest successful turn (maintained by trigger) so the UI can show the model that actually answered
  last_turn_id         text,
  last_turn_at         timestamptz,
  last_requested_model text,
  last_routed_provider text,
  last_routed_model    text,
  last_response_model  text,
  agent_events         jsonb not null default '[]'::jsonb,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  primary key (user_id, id),
  foreign key (user_id, workspace_id) references ferry.workspaces (user_id, id) on delete set null (workspace_id)
);
create index sessions_user_workspace_idx on ferry.sessions (user_id, workspace_id);
create index sessions_user_updated_idx   on ferry.sessions (user_id, updated_at desc);

-- ---------------------------------------------------------------- messages
create table ferry.messages (
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id             text not null default gen_random_uuid()::text,   -- Ferry MessageId
  session_id     text not null,
  seq            bigint generated by default as identity,
  role           text not null check (role in ('user', 'assistant', 'system', 'tool')),
  agent_role     text check (agent_role in ('planner', 'editor')),
  model_ref      text,                -- model credited on the message (should equal the turn's routed_model)
  turn_id        text,                -- final turn that produced this assistant message
  parts          jsonb not null default '[]'::jsonb,   -- MessagePart[]
  model_attempts jsonb,                                -- Message.modelAttempts
  content_text   text,                                  -- optional flattened text for search
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, session_id) references ferry.sessions (user_id, id) on delete cascade
);
create index messages_session_idx on ferry.messages (user_id, session_id, created_at, seq);

create table ferry.task_records (
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_id    text not null,
  goal          text not null default '',
  plan          jsonb not null default '[]'::jsonb,
  decisions     jsonb not null default '[]'::jsonb,
  touched_files jsonb not null default '[]'::jsonb,
  next_step     text,
  updated_at    timestamptz not null default now(),
  primary key (user_id, session_id),
  foreign key (user_id, session_id) references ferry.sessions (user_id, id) on delete cascade
);
comment on table ferry.task_records is 'TaskRecord per session (goal, plan, decisions, touched files).';

-- ---------------------------------------------------------------- provider keys (secret lives in Vault)
create table ferry.provider_keys (
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id              text not null,             -- Ferry provider key entry id, e.g. 'openrouter:1'
  provider_id     text not null,
  key_id          text not null,             -- per-provider key slot ('1', '2', ...)
  label           text not null,
  position        integer not null default 0,
  enabled         boolean not null default true,
  status          text not null default 'ok' check (status in ('ok', 'rate_limited', 'invalid', 'disabled')),
  last_four       text check (char_length(last_four) <= 4),
  vault_secret_id uuid not null unique,      -- vault.secrets.id; the key itself is never stored here
  last_error      text,
  cooldown_until  timestamptz,
  last_used_at    timestamptz,
  last_rotated_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, provider_id, key_id)
);
create index provider_keys_provider_idx on ferry.provider_keys (user_id, provider_id, position);
comment on table ferry.provider_keys is 'Provider API key metadata. Secret is in Supabase Vault; use ferry.set_provider_key / ferry.get_provider_key_secret.';

-- ---------------------------------------------------------------- turns (one row per provider request/attempt)
create table ferry.turns (
  user_id               uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                    text not null default gen_random_uuid()::text,  -- Ferry request id
  session_id            text,             -- null for gateway/probe traffic not tied to a session
  message_id            text,             -- assistant message produced (if any)
  user_message_id       text,             -- user message that triggered it
  device_id             text,
  trace_id              text not null default replace(gen_random_uuid()::text, '-', ''),  -- OTel-compatible 32 hex
  request_group_id      text,             -- groups all attempts of one logical turn (fallback chain)
  attempt               integer not null default 1 check (attempt >= 1),
  parent_turn_id        text,             -- attempt this one fell back from
  source                text not null default 'agent'
                        check (source in ('agent', 'gateway', 'delegate', 'optimizer', 'probe', 'cli', 'other')),
  task_id               text,
  step_id               text,
  step_kind             text,
  agent_role            text,
  agent_profile_id      text,
  -- model accounting (the session-model-mismatch bug lives here)
  requested_model       text,             -- what the session/UI asked for (ModelRef or 'auto')
  routing_mode          text,             -- e.g. pinned | auto | sticky | manual
  routed_provider       text,             -- ProviderId the router picked
  routed_model          text,             -- ModelRef the router picked
  routed_upstream_model text,             -- upstream model id actually sent to the provider (after logical mappings)
  response_model        text,             -- model name the provider reported back in the response
  provider_key_id       text,             -- ferry.provider_keys.id used
  fallback_reason       text,             -- quota | rate_limit | error | context | capability | manual | ...
  routing_decision      jsonb,            -- candidates, scores, exclusions, sticky info
  routed_differs_from_requested boolean generated always as (
    requested_model is not null and requested_model <> 'auto' and routed_model is not null and requested_model <> routed_model
  ) stored,
  response_differs_from_routed boolean generated always as (
    response_model is not null and routed_upstream_model is not null and lower(response_model) <> lower(routed_upstream_model)
  ) stored,
  -- outcome
  status                text not null default 'pending'
                        check (status in ('pending', 'streaming', 'success', 'error', 'cancelled', 'fallback', 'timeout')),
  http_status           integer,
  error_kind            text,             -- ProviderErrorKind
  error_message         text,             -- redacted
  finish_reason         text,
  input_tokens          integer,
  output_tokens         integer,
  cached_tokens         integer,
  reasoning_tokens      integer,
  cost_usd              numeric(14, 6),
  plan_units            numeric,
  latency_ms            integer,
  ttft_ms               integer,
  request_bytes         integer,
  rate_limit_headers    jsonb,
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, session_id)      references ferry.sessions (user_id, id)      on delete cascade,
  foreign key (user_id, message_id)      references ferry.messages (user_id, id)      on delete set null (message_id),
  foreign key (user_id, user_message_id) references ferry.messages (user_id, id)      on delete set null (user_message_id),
  foreign key (user_id, parent_turn_id)  references ferry.turns (user_id, id)         on delete set null (parent_turn_id),
  foreign key (user_id, provider_key_id) references ferry.provider_keys (user_id, id) on delete set null (provider_key_id),
  foreign key (user_id, device_id)       references ferry.devices (user_id, id)       on delete set null (device_id)
);
comment on table ferry.turns is 'One row per provider request attempt with requested vs routed vs provider-reported model, fallback reason, tokens, cost, latency, error.';
create index turns_user_started_idx     on ferry.turns (user_id, started_at desc);
create index turns_session_idx          on ferry.turns (user_id, session_id, started_at);
create index turns_message_idx          on ferry.turns (user_id, message_id);
create index turns_user_message_idx     on ferry.turns (user_id, user_message_id);
create index turns_parent_idx           on ferry.turns (user_id, parent_turn_id);
create index turns_provider_key_idx     on ferry.turns (user_id, provider_key_id);
create index turns_device_idx           on ferry.turns (user_id, device_id);
create index turns_trace_idx            on ferry.turns (trace_id);
create index turns_group_idx            on ferry.turns (user_id, request_group_id) where request_group_id is not null;
create index turns_errors_idx           on ferry.turns (user_id, started_at desc) where status in ('error', 'timeout', 'fallback');
create index turns_model_mismatch_idx   on ferry.turns (user_id, started_at desc)
  where response_differs_from_routed or routed_differs_from_requested;

alter table ferry.messages
  add foreign key (user_id, turn_id) references ferry.turns (user_id, id) on delete set null (turn_id);
create index messages_turn_idx on ferry.messages (user_id, turn_id);

-- ---------------------------------------------------------------- model switch history
create table ferry.model_switches (
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  session_id    text not null,
  turn_id       text,
  kind          text not null check (kind in ('initial', 'selection_change', 'pin', 'unpin', 'router_fallback',
                                              'handoff', 'retry', 'provider_substitution', 'system')),
  from_model    text,
  to_model      text,
  from_provider text,
  to_provider   text,
  reason        text,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, session_id) references ferry.sessions (user_id, id) on delete cascade,
  foreign key (user_id, turn_id)    references ferry.turns (user_id, id)    on delete set null (turn_id)
);
comment on table ferry.model_switches is 'Every change of a session''s selected/pinned model (auto via trigger) plus router fallbacks/handoffs.';
create index model_switches_session_idx on ferry.model_switches (user_id, session_id, created_at);
create index model_switches_turn_idx    on ferry.model_switches (user_id, turn_id);

-- ---------------------------------------------------------------- usage / quota
create table ferry.usage_daily (
  user_id          uuid not null references auth.users(id) on delete cascade,
  day              date not null,
  provider         text not null,
  model            text not null,
  requests         integer not null default 0,
  successes        integer not null default 0,
  errors           integer not null default 0,
  input_tokens     bigint not null default 0,
  output_tokens    bigint not null default 0,
  cached_tokens    bigint not null default 0,
  reasoning_tokens bigint not null default 0,
  cost_usd         numeric(14, 6) not null default 0,
  latency_ms_total bigint not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (user_id, day, provider, model)
);
comment on table ferry.usage_daily is 'Daily rollup per provider/model, maintained by trigger from ferry.turns (read-only for clients).';

create table ferry.provider_key_usage_daily (
  user_id         uuid not null references auth.users(id) on delete cascade,
  day             date not null,
  provider_key_id text not null,
  requests        integer not null default 0,
  tokens          bigint not null default 0,
  primary key (user_id, day, provider_key_id),
  foreign key (user_id, provider_key_id) references ferry.provider_keys (user_id, id) on delete cascade
);
create index provider_key_usage_key_idx on ferry.provider_key_usage_daily (user_id, provider_key_id);

create table ferry.quota_windows (
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id           text not null,
  provider_id  text not null,
  scope        text not null check (scope in ('provider', 'model')),
  model_ref    text,
  metric       text not null check (metric in ('requests', 'tokens', 'usd', 'credits')),
  kind         text not null check (kind in ('rolling', 'fixed_daily', 'weekly', 'monthly', 'dynamic')),
  period_label text,
  used         numeric not null default 0,
  limit_value  numeric,
  remaining    numeric,
  reset_at     timestamptz,
  confidence   text not null default 'unknown' check (confidence in ('exact', 'estimated', 'learned', 'unknown')),
  data         jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  primary key (user_id, id)
);
create index quota_windows_provider_idx on ferry.quota_windows (user_id, provider_id);

create table ferry.cooldowns (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id          text not null,
  provider_id text not null,
  model_ref   text,
  until       timestamptz not null,
  reason      text,
  provenance  text check (provenance in ('heuristic', 'authoritative', 'credit', 'tier')),
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (user_id, id)
);
create index cooldowns_provider_idx on ferry.cooldowns (user_id, provider_id, until);

-- ---------------------------------------------------------------- local gateway keys (hash only)
create table ferry.gateway_keys (
  user_id                 uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                      text not null,
  name                    text not null,
  profile                 text not null,
  allowed_models          text[] not null default '{}',
  rate_limit              integer,
  token_limit_per_minute  integer,
  token_limit_per_day     integer,
  concurrency_limit       integer,
  compress_tool_results   boolean not null default false,
  terse_system_prompt     boolean not null default false,
  key_hash                text not null,
  created_at              timestamptz not null default now(),
  last_used_at            timestamptz,
  revoked_at              timestamptz,
  updated_at              timestamptz not null default now(),
  primary key (user_id, id)
);

-- ---------------------------------------------------------------- generic synced aggregates
create table ferry.sync_records (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('provider', 'model_cache', 'checkpoint', 'delegation', 'handoff',
                                           'optimizer_event', 'optimizer_blob', 'touched_file', 'task_step',
                                           'decision', 'mcp_server', 'skill', 'other')),
  id         text not null,
  session_id text,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, kind, id),
  foreign key (user_id, session_id) references ferry.sessions (user_id, id) on delete cascade
);
comment on table ferry.sync_records is 'Remaining local JSON aggregates (providers config w/o secrets, models cache, checkpoints, delegations, handoffs, optimizer events...).';
create index sync_records_session_idx on ferry.sync_records (user_id, session_id);

-- ---------------------------------------------------------------- logs / events (append-only)
create table ferry.logs (
  id             bigint generated always as identity primary key,
  ts             timestamptz not null default now(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  device_id      text,
  level          text not null default 'info' check (level in ('trace', 'debug', 'info', 'warn', 'error', 'fatal')),
  source         text not null,   -- router | gateway | provider | agent | ui | cli | quota | secrets | storage | sync | tool
  event          text not null,   -- dotted name, e.g. turn.routed, turn.fallback, model.switch, provider.error
  message        text,
  session_id     text,            -- soft references: logs must be writable before/without the parent row
  turn_id        text,
  trace_id       text,
  span_id        text,
  parent_span_id text,
  app_version    text,
  data           jsonb not null default '{}'::jsonb
);
comment on table ferry.logs is 'Append-only end-to-end event log. Retained 30 days (cron job ferry-log-retention).';
create index logs_user_ts_idx      on ferry.logs (user_id, ts desc);
create index logs_session_ts_idx   on ferry.logs (user_id, session_id, ts) where session_id is not null;
create index logs_turn_idx         on ferry.logs (user_id, turn_id) where turn_id is not null;
create index logs_trace_idx        on ferry.logs (trace_id) where trace_id is not null;
create index logs_problems_idx     on ferry.logs (user_id, ts desc) where level in ('warn', 'error', 'fatal');
create index logs_event_idx        on ferry.logs (user_id, event, ts desc);
create index logs_ts_brin_idx      on ferry.logs using brin (ts);

create trigger logs_append_only before update on ferry.logs
  for each row execute function ferry.reject_mutation();

-- ---------------------------------------------------------------- updated_at triggers
create trigger profiles_touch       before update on ferry.profiles       for each row execute function ferry.touch_updated_at();
create trigger settings_kv_touch    before update on ferry.settings_kv    for each row execute function ferry.touch_updated_at();
create trigger agent_profiles_touch before update on ferry.agent_profiles for each row execute function ferry.touch_updated_at();
create trigger workspaces_touch     before update on ferry.workspaces     for each row execute function ferry.touch_updated_at();
create trigger sessions_touch       before update on ferry.sessions       for each row execute function ferry.touch_updated_at();
create trigger messages_touch       before update on ferry.messages       for each row execute function ferry.touch_updated_at();
create trigger task_records_touch   before update on ferry.task_records   for each row execute function ferry.touch_updated_at();
create trigger provider_keys_touch  before update on ferry.provider_keys  for each row execute function ferry.touch_updated_at();
create trigger turns_touch          before update on ferry.turns          for each row execute function ferry.touch_updated_at();
create trigger quota_windows_touch  before update on ferry.quota_windows  for each row execute function ferry.touch_updated_at();
create trigger cooldowns_touch      before update on ferry.cooldowns      for each row execute function ferry.touch_updated_at();
create trigger gateway_keys_touch   before update on ferry.gateway_keys   for each row execute function ferry.touch_updated_at();
create trigger sync_records_touch   before update on ferry.sync_records   for each row execute function ferry.touch_updated_at();

-- ---------------------------------------------------------------- session model history trigger
create or replace function ferry.on_session_model_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.selected_model is not null then
      insert into ferry.model_switches (user_id, session_id, kind, to_model, reason)
      values (new.user_id, new.id, 'initial', new.selected_model, nullif(current_setting('ferry.switch_reason', true), ''));
    end if;
    return null;
  end if;
  if new.selected_model is distinct from old.selected_model then
    insert into ferry.model_switches (user_id, session_id, kind, from_model, to_model, reason)
    values (new.user_id, new.id, 'selection_change', old.selected_model, new.selected_model,
            nullif(current_setting('ferry.switch_reason', true), ''));
  end if;
  if new.pinned_model is distinct from old.pinned_model then
    insert into ferry.model_switches (user_id, session_id, kind, from_model, to_model, reason)
    values (new.user_id, new.id, case when new.pinned_model is null then 'unpin' else 'pin' end,
            old.pinned_model, new.pinned_model, nullif(current_setting('ferry.switch_reason', true), ''));
  end if;
  return null;
end;
$$;

create trigger sessions_model_history_ins after insert on ferry.sessions
  for each row execute function ferry.on_session_model_change();
create trigger sessions_model_history_upd after update of selected_model, pinned_model on ferry.sessions
  for each row execute function ferry.on_session_model_change();

-- ---------------------------------------------------------------- turn side effects
-- * keeps sessions.last_* in sync with the model that actually answered
-- * records router fallbacks in model_switches
-- * rolls usage up into usage_daily / provider_key_usage_daily once a turn reaches a terminal status
create or replace function ferry.on_turn_written()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  terminal constant text[] := array['success', 'error', 'cancelled', 'fallback', 'timeout'];
  became_terminal boolean := new.status = any(terminal) and (tg_op = 'INSERT' or not (old.status = any(terminal)));
  v_at timestamptz := coalesce(new.finished_at, now());
  v_tokens bigint := coalesce(new.input_tokens, 0) + coalesce(new.output_tokens, 0);
begin
  if new.session_id is not null and new.status = 'success' and (tg_op = 'INSERT' or old.status is distinct from 'success') then
    update ferry.sessions s
       set last_turn_id = new.id,
           last_turn_at = v_at,
           last_requested_model = new.requested_model,
           last_routed_provider = new.routed_provider,
           last_routed_model = new.routed_model,
           last_response_model = new.response_model
     where s.user_id = new.user_id and s.id = new.session_id
       and (s.last_turn_at is null or s.last_turn_at <= v_at);
  end if;

  if new.session_id is not null and new.fallback_reason is not null
     and (tg_op = 'INSERT' or old.fallback_reason is null) then
    insert into ferry.model_switches (user_id, session_id, turn_id, kind, from_model, to_model, to_provider, reason)
    values (new.user_id, new.session_id, new.id, 'router_fallback', new.requested_model, new.routed_model,
            new.routed_provider, new.fallback_reason);
  end if;

  if became_terminal then
    insert into ferry.usage_daily as u (user_id, day, provider, model, requests, successes, errors,
                                        input_tokens, output_tokens, cached_tokens, reasoning_tokens, cost_usd, latency_ms_total)
    values (new.user_id, (new.started_at at time zone 'utc')::date,
            coalesce(new.routed_provider, 'unknown'), coalesce(new.routed_model, new.requested_model, 'unknown'),
            1, (new.status = 'success')::int, (new.status <> 'success')::int,
            coalesce(new.input_tokens, 0), coalesce(new.output_tokens, 0), coalesce(new.cached_tokens, 0),
            coalesce(new.reasoning_tokens, 0), coalesce(new.cost_usd, 0), coalesce(new.latency_ms, 0))
    on conflict (user_id, day, provider, model) do update set
      requests = u.requests + 1,
      successes = u.successes + excluded.successes,
      errors = u.errors + excluded.errors,
      input_tokens = u.input_tokens + excluded.input_tokens,
      output_tokens = u.output_tokens + excluded.output_tokens,
      cached_tokens = u.cached_tokens + excluded.cached_tokens,
      reasoning_tokens = u.reasoning_tokens + excluded.reasoning_tokens,
      cost_usd = u.cost_usd + excluded.cost_usd,
      latency_ms_total = u.latency_ms_total + excluded.latency_ms_total,
      updated_at = now();

    if new.provider_key_id is not null then
      insert into ferry.provider_key_usage_daily as k (user_id, day, provider_key_id, requests, tokens)
      values (new.user_id, (new.started_at at time zone 'utc')::date, new.provider_key_id, 1, v_tokens)
      on conflict (user_id, day, provider_key_id) do update set
        requests = k.requests + 1,
        tokens = k.tokens + excluded.tokens;
      update ferry.provider_keys pk set last_used_at = v_at
       where pk.user_id = new.user_id and pk.id = new.provider_key_id;
    end if;
  end if;
  return null;
end;
$$;

create trigger turns_side_effects after insert or update of status, fallback_reason on ferry.turns
  for each row execute function ferry.on_turn_written();

-- ---------------------------------------------------------------- debugging view for the model-mismatch bug
create view ferry.turn_model_audit with (security_invoker = true) as
select t.user_id,
       t.id as turn_id,
       t.session_id,
       t.trace_id,
       t.started_at,
       s.selected_model as session_selected_model,
       t.requested_model,
       t.routed_provider,
       t.routed_model,
       t.routed_upstream_model,
       t.response_model,
       m.model_ref as message_model_ref,
       t.fallback_reason,
       t.status,
       t.error_kind,
       t.latency_ms,
       t.routed_differs_from_requested,
       t.response_differs_from_routed,
       (m.model_ref is not null and t.routed_model is not null and m.model_ref <> t.routed_model) as message_credits_wrong_model
  from ferry.turns t
  left join ferry.sessions s on s.user_id = t.user_id and s.id = t.session_id
  left join ferry.messages m on m.user_id = t.user_id and m.id = t.message_id;
comment on view ferry.turn_model_audit is 'Per-turn comparison of selected vs requested vs routed vs provider-reported model (security_invoker, RLS applies).';
