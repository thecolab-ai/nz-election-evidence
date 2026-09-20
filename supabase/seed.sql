-- LOCAL DEVELOPMENT AND CI ONLY. Applied by `supabase db reset` / `supabase db start` to the disposable
-- local stack, never to a hosted project. Creates the scoped worker login with a fixed, well-known
-- local password so tests exercise exactly the production privilege set (member of evidence_ingest,
-- nothing else). Hosted projects use scripts/db/create_ingest_login.sql with a generated password.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'evidence_ingest_local') then
    create role evidence_ingest_local login password 'local-only-not-a-secret'
      nosuperuser nocreatedb nocreaterole noreplication nobypassrls in role evidence_ingest;
  end if;
end
$$;
