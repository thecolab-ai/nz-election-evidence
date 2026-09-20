-- Creates (or rotates the password of) the login used by the ingestion worker.
-- The login is only a member of evidence_ingest: no superuser, no bypass of row level security,
-- no role creation, no access to memberships, vault, schedules' state or published tables.
--
-- Run as the project administrator. The password is supplied at run time and never stored in git:
--
--   psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 \
--        -v login_name=evidence_ingest_login -v login_password="$NEW_PASSWORD" \
--        -f scripts/db/create_ingest_login.sql
--
-- Then store the resulting connection string as the Edge Function secret EVIDENCE_INGEST_DB_URL
-- (supabase secrets set ...) and, for CLI backfills, in the operator's own environment.

select case when exists (select 1 from pg_roles where rolname = :'login_name')
  then format('alter role %I with login password %L', :'login_name', :'login_password')
  else format('create role %I with login password %L nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 6 in role evidence_ingest',
              :'login_name', :'login_password')
end
\gexec

select format('grant evidence_ingest to %I', :'login_name')
\gexec
select format('alter role %I set statement_timeout = %L', :'login_name', '150s')
\gexec
select format('alter role %I set idle_in_transaction_session_timeout = %L', :'login_name', '60s')
\gexec

select rolname, rolsuper, rolbypassrls, rolcreaterole, rolconnlimit,
       (select array_agg(g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid) as member_of
from pg_roles r where rolname = :'login_name';
