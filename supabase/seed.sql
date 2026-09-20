-- LOCAL DEVELOPMENT ONLY. Applied by `supabase db reset` against the disposable local stack.
-- Lets the local migration role act as the scoped worker so the CLI can run with --assume-role.
-- Hosted projects use a dedicated login instead: scripts/db/create_ingest_login.sql.
grant evidence_ingest to postgres;
