-- READ-ONLY pre-flight for a hosted project. Run before applying any migration and keep the output
-- with the release notes. An empty public schema does not prove the project is empty.
--
--   psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 -f scripts/db/inspect_existing_objects.sql

\echo == non-system schemas
select nspname from pg_namespace where nspname !~ '^(pg_|information_schema)' order by 1;
\echo == objects in evidence_* schemas (expected: none before first apply)
select n.nspname, c.relkind, count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname like 'evidence_%' group by 1, 2 order by 1, 2;
\echo == applied migrations
select version, name from supabase_migrations.schema_migrations order by version;
\echo == roles named evidence_*
select rolname, rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname like 'evidence_%' order by 1;
\echo == cron jobs
select jobid, jobname, schedule, active from cron.job order by jobid;
\echo == vault secret names (never values)
select name, created_at from vault.secrets order by name;
\echo == policies outside system schemas
select schemaname, tablename, policyname, roles, cmd from pg_policies where schemaname !~ '^(pg_|auth|storage|realtime|vault|cron|net|supabase_)' order by 1, 2, 3;
