-- Ferry cloud mode: Row Level Security + grants.
-- authenticated: only rows where user_id = auth.uid(). anon: no grants, no policies (gets nothing).
-- service_role: full access (bypasses RLS) for server-side jobs; never ship it in the app.

do $$
declare t text;
begin
  foreach t in array array[
    'admins', 'profiles', 'settings_kv', 'agent_profiles', 'devices', 'workspaces', 'sessions', 'messages',
    'task_records', 'provider_keys', 'turns', 'model_switches', 'usage_daily', 'provider_key_usage_daily',
    'quota_windows', 'cooldowns', 'gateway_keys', 'sync_records', 'logs'
  ] loop
    execute format('alter table ferry.%I enable row level security', t);
  end loop;
end $$;

-- Full CRUD on own rows
do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'settings_kv', 'agent_profiles', 'devices', 'workspaces', 'sessions', 'messages',
    'task_records', 'quota_windows', 'cooldowns', 'gateway_keys', 'sync_records'
  ] loop
    execute format('create policy "own rows: select" on ferry.%I for select to authenticated using ((select auth.uid()) = user_id)', t);
    execute format('create policy "own rows: insert" on ferry.%I for insert to authenticated with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "own rows: update" on ferry.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "own rows: delete" on ferry.%I for delete to authenticated using ((select auth.uid()) = user_id)', t);
    execute format('grant select, insert, update, delete on ferry.%I to authenticated', t);
  end loop;
end $$;

-- turns: insert + update (to finalise an attempt), no delete (history; removed via session cascade)
create policy "own rows: select" on ferry.turns for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows: insert" on ferry.turns for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own rows: update" on ferry.turns for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant select, insert, update on ferry.turns to authenticated;

-- model_switches and logs: append-only for clients
create policy "own rows: select" on ferry.model_switches for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows: insert" on ferry.model_switches for insert to authenticated with check ((select auth.uid()) = user_id);
grant select, insert on ferry.model_switches to authenticated;

create policy "own rows: select" on ferry.logs for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows: insert" on ferry.logs for insert to authenticated with check ((select auth.uid()) = user_id);
grant select, insert on ferry.logs to authenticated;

-- read-only for clients (maintained by triggers / functions)
create policy "own rows: select" on ferry.admins                   for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows: select" on ferry.usage_daily              for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows: select" on ferry.provider_key_usage_daily for select to authenticated using ((select auth.uid()) = user_id);
grant select on ferry.admins, ferry.usage_daily, ferry.provider_key_usage_daily to authenticated;

-- provider_keys: read own metadata, update only non-secret metadata columns; create/rotate/delete via functions
create policy "own rows: select" on ferry.provider_keys for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows: update" on ferry.provider_keys for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant select on ferry.provider_keys to authenticated;
grant update (label, position, enabled, status, last_error, cooldown_until, last_used_at) on ferry.provider_keys to authenticated;

-- view (security_invoker => underlying RLS applies)
grant select on ferry.turn_model_audit to authenticated;

-- schema + sequence usage
grant usage on schema ferry to authenticated, service_role;
grant usage, select on all sequences in schema ferry to authenticated, service_role;

-- service_role: full access, but logs stay append-only (no update)
grant all on all tables in schema ferry to service_role;
revoke update on ferry.logs from service_role;

-- anon / public: nothing
revoke all on all tables in schema ferry from anon, public;
revoke all on all sequences in schema ferry from anon, public;
revoke all on all functions in schema ferry from anon, public;

-- internal trigger/helper functions are not callable by API roles
revoke execute on function ferry.touch_updated_at(), ferry.reject_mutation(),
  ferry.on_session_model_change(), ferry.on_turn_written() from authenticated;

-- future objects created by postgres in ferry: no automatic grants to anon/public
alter default privileges for role postgres in schema ferry revoke all on tables from anon, public;
alter default privileges for role postgres in schema ferry revoke all on sequences from anon, public;
alter default privileges for role postgres in schema ferry revoke execute on functions from anon, public;
