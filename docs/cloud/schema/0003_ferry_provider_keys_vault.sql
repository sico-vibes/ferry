-- Ferry cloud mode: provider API keys stored in Supabase Vault.
-- ferry.provider_keys keeps only metadata + vault_secret_id. These SECURITY DEFINER functions are the
-- only way to create/rotate/read/delete a key, and they always scope to auth.uid().
-- Every call writes an audit row to ferry.logs (never the secret itself).

create or replace function ferry.set_provider_key(
  p_provider_id text,
  p_secret      text,
  p_label       text default null,
  p_key_id      text default null   -- Ferry entry id (e.g. 'openrouter:1'); null = create new slot
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_existing  ferry.provider_keys%rowtype;
  v_id        text;
  v_slot      text;
  v_secret_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_provider_id is null or btrim(p_provider_id) = '' then
    raise exception 'provider_id is required' using errcode = '22023';
  end if;
  if p_secret is null or btrim(p_secret) = '' then
    raise exception 'secret is required' using errcode = '22023';
  end if;

  if p_key_id is not null then
    select * into v_existing from ferry.provider_keys
     where user_id = v_uid and id = p_key_id
     for update;
  end if;

  if v_existing.id is not null then
    if v_existing.provider_id <> p_provider_id then
      raise exception 'key % belongs to provider %', p_key_id, v_existing.provider_id using errcode = '22023';
    end if;
    perform vault.update_secret(v_existing.vault_secret_id, p_secret);
    update ferry.provider_keys
       set last_four = right(p_secret, 4),
           label = coalesce(p_label, label),
           status = 'ok',
           last_error = null,
           cooldown_until = null,
           last_rotated_at = now()
     where user_id = v_uid and id = v_existing.id;
    v_id := v_existing.id;
  else
    select coalesce(max(case when k.key_id ~ '^[0-9]+$' then k.key_id::int end), 0) + 1
      into v_slot
      from ferry.provider_keys k
     where k.user_id = v_uid and k.provider_id = p_provider_id;
    v_id := coalesce(p_key_id, p_provider_id || ':' || v_slot);
    v_secret_id := vault.create_secret(
      p_secret,
      'ferry/' || v_uid::text || '/' || v_id,
      'Ferry provider key (' || p_provider_id || ')'
    );
    insert into ferry.provider_keys (user_id, id, provider_id, key_id, label, position, last_four, vault_secret_id)
    values (
      v_uid, v_id, p_provider_id, v_slot, coalesce(p_label, 'Key ' || v_slot),
      (select coalesce(max(k.position) + 1, 0) from ferry.provider_keys k where k.user_id = v_uid and k.provider_id = p_provider_id),
      right(p_secret, 4), v_secret_id
    );
  end if;

  insert into ferry.logs (user_id, level, source, event, data)
  values (v_uid, 'info', 'secrets', case when v_existing.id is null then 'provider_key.created' else 'provider_key.rotated' end,
          jsonb_build_object('provider_key_id', v_id, 'provider_id', p_provider_id));
  return v_id;
end;
$$;
comment on function ferry.set_provider_key(text, text, text, text) is 'Create or rotate the caller''s provider key; secret goes to Vault. Returns the key entry id.';

create or replace function ferry.get_provider_key_secret(p_key_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_secret text;
  v_provider text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select ds.decrypted_secret, k.provider_id into v_secret, v_provider
    from ferry.provider_keys k
    join vault.decrypted_secrets ds on ds.id = k.vault_secret_id
   where k.user_id = v_uid and k.id = p_key_id;
  if not found then
    raise exception 'provider key not found' using errcode = 'P0002';
  end if;
  insert into ferry.logs (user_id, level, source, event, data)
  values (v_uid, 'debug', 'secrets', 'provider_key.read', jsonb_build_object('provider_key_id', p_key_id, 'provider_id', v_provider));
  return v_secret;
end;
$$;
comment on function ferry.get_provider_key_secret(text) is 'Return the decrypted secret of one of the caller''s own provider keys.';

create or replace function ferry.list_provider_key_secrets(p_provider_id text default null)
returns table (id text, provider_id text, key_id text, label text, "position" integer, enabled boolean, status text, secret text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  insert into ferry.logs (user_id, level, source, event, data)
  values (v_uid, 'debug', 'secrets', 'provider_key.read_all', jsonb_build_object('provider_id', p_provider_id));
  return query
    select k.id, k.provider_id, k.key_id, k.label, k.position, k.enabled, k.status, ds.decrypted_secret::text
      from ferry.provider_keys k
      join vault.decrypted_secrets ds on ds.id = k.vault_secret_id
     where k.user_id = v_uid and (p_provider_id is null or k.provider_id = p_provider_id)
     order by k.provider_id, k.position;
end;
$$;
comment on function ferry.list_provider_key_secrets(text) is 'Return the caller''s provider keys with decrypted secrets (for loading the router at startup).';

create or replace function ferry.delete_provider_key(p_key_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row ferry.provider_keys%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  delete from ferry.provider_keys where user_id = v_uid and id = p_key_id returning * into v_row;
  if v_row.id is null then
    return false;
  end if;
  delete from vault.secrets where id = v_row.vault_secret_id;
  insert into ferry.logs (user_id, level, source, event, data)
  values (v_uid, 'info', 'secrets', 'provider_key.deleted', jsonb_build_object('provider_key_id', p_key_id, 'provider_id', v_row.provider_id));
  return true;
end;
$$;
comment on function ferry.delete_provider_key(text) is 'Delete one of the caller''s provider keys and its Vault secret.';

revoke all on function ferry.set_provider_key(text, text, text, text) from public, anon;
revoke all on function ferry.get_provider_key_secret(text) from public, anon;
revoke all on function ferry.list_provider_key_secrets(text) from public, anon;
revoke all on function ferry.delete_provider_key(text) from public, anon;
grant execute on function ferry.set_provider_key(text, text, text, text) to authenticated;
grant execute on function ferry.get_provider_key_secret(text) to authenticated;
grant execute on function ferry.list_provider_key_secrets(text) to authenticated;
grant execute on function ferry.delete_provider_key(text) to authenticated;
