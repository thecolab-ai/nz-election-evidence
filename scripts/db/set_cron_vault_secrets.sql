-- Stores the two dispatcher secrets in Supabase Vault (encrypted at rest). Values come from the
-- operator's shell at run time; they are never written to git, to a table, or to a migration.
--
--   psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 \
--        -v functions_base_url="https://<project-ref>.supabase.co/functions/v1" \
--        -v cron_secret="$EVIDENCE_CRON_SECRET" -f scripts/db/set_cron_vault_secrets.sql
--
-- The same cron_secret value must be set as the Edge Function secret EVIDENCE_CRON_SECRET.

select case when not evidence_private.functions_base_url_ok(:'functions_base_url')
  then 'do $$ begin raise exception ''functions_base_url is not an allowed functions endpoint''; end $$'
  when length(:'cron_secret') < 32
  then 'do $$ begin raise exception ''cron_secret must be at least 32 characters''; end $$'
  else 'select 1' end
\gexec

select case when exists (select 1 from vault.secrets where name = 'evidence_functions_base_url')
  then format('select vault.update_secret((select id from vault.secrets where name = %L), %L)', 'evidence_functions_base_url', :'functions_base_url')
  else format('select vault.create_secret(%L, %L, %L)', :'functions_base_url', 'evidence_functions_base_url', 'Edge Functions base URL for the ingest dispatcher') end
\gexec
select case when exists (select 1 from vault.secrets where name = 'evidence_cron_secret')
  then format('select vault.update_secret((select id from vault.secrets where name = %L), %L)', 'evidence_cron_secret', :'cron_secret')
  else format('select vault.create_secret(%L, %L, %L)', :'cron_secret', 'evidence_cron_secret', 'Shared secret between pg_cron dispatcher and the ingest-run function') end
\gexec

-- Readback shows names and timestamps only, never values.
select name, description, created_at, updated_at from vault.secrets where name like 'evidence_%' order by name;
