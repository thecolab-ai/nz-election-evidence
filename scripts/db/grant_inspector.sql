-- Grants (or revokes) an inspector membership. Signing in never creates one.
-- The account must already exist in Supabase Auth (sign-ups are disabled; an administrator invites users).
--
--   psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 -v user_email=person@example.org \
--        -v granted_by="Full Name" -v reason="why this person needs inspector access" -f scripts/db/grant_inspector.sql
--
-- Revoke:  add  -v revoke=1  (the row is kept with revoked_at set; history is not deleted)

\if :{?revoke}
update evidence_private.app_memberships m
   set revoked_at = now(), revoked_by = :'granted_by'
  from auth.users u
 where u.id = m.user_id and lower(u.email) = lower(:'user_email') and m.app_role = 'inspector' and m.revoked_at is null
returning m.user_id, m.app_role, m.revoked_at;
\else
insert into evidence_private.app_memberships (user_id, app_role, granted_by, grant_reason)
select u.id, 'inspector', :'granted_by', :'reason' from auth.users u where lower(u.email) = lower(:'user_email')
on conflict do nothing
returning user_id, app_role, granted_at;
\endif

select count(*) as current_inspectors from evidence_private.app_memberships where app_role = 'inspector' and revoked_at is null;
