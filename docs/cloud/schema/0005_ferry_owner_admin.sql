-- Ferry cloud mode: mark admin@synthet.me as the single Ferry owner.
-- The auth user already existed (it is also the TikTok dashboard admin), so it is reused as-is:
-- no auth.users / auth.identities rows are inserted or changed and the password is NOT touched.
insert into ferry.admins (user_id, role, note)
select u.id, 'owner', 'Ferry owner (seeded by migration)'
  from auth.users u
 where lower(u.email) = 'admin@synthet.me'
on conflict (user_id) do update set role = 'owner';

insert into ferry.profiles (user_id, display_name)
select u.id, 'Owner'
  from auth.users u
 where lower(u.email) = 'admin@synthet.me'
on conflict (user_id) do nothing;
