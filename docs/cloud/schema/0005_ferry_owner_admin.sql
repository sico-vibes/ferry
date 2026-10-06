-- Ferry cloud mode: mark one existing Supabase Auth user as the single Ferry owner.
-- Replace OWNER_EMAIL below before running. The auth user is reused as-is: no auth.users or
-- auth.identities rows are created or changed, and the password is not touched.
insert into ferry.admins (user_id, role, note)
select u.id, 'owner', 'Ferry owner (seeded by migration)'
  from auth.users u
 where lower(u.email) = lower('OWNER_EMAIL')
on conflict (user_id) do update set role = 'owner';

insert into ferry.profiles (user_id, display_name)
select u.id, 'Owner'
  from auth.users u
 where lower(u.email) = lower('OWNER_EMAIL')
on conflict (user_id) do nothing;
