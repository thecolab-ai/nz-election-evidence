-- Foundation: schemas, scoped roles and the server-controlled membership table.
--
-- Boundary summary (see docs/database/architecture.md):
--   evidence_private    never exposed through the REST API; all evidence lives here
--   evidence_inspector  exposed; read-only views that return rows only to users with
--                       a current inspector membership
--   evidence_api        physically separate reviewed release batches; stays unexposed
--   evidence_views      unexposed base views (single definition of every curated view)
--   evidence_public     exposed; anonymous read-only curated views, withheld columns removed,
--                       rows returned only once the R8/R10 release gates are recorded
--   evidence_open       exposed; one anonymous read-only projection per domain table, same gate
--
-- Browser roles (anon, authenticated) receive no privilege on evidence_private.

create schema if not exists evidence_private;
create schema if not exists evidence_inspector;
create schema if not exists evidence_api;
create schema if not exists evidence_views;
create schema if not exists evidence_public;
create schema if not exists evidence_open;

comment on schema evidence_private is 'Private evidence, provenance, civic model and review records. Not exposed.';
comment on schema evidence_inspector is 'Read-only inspector views. Rows are returned only to users holding a current inspector membership.';
comment on schema evidence_api is 'Reviewed release batches. Closed until release gates are recorded.';
comment on schema evidence_views is 'Unexposed base views. No browser role holds any privilege here.';
comment on schema evidence_public is 'Anonymous read-only curated views. Withheld columns are listed in dataset_columns. Release-gated.';
comment on schema evidence_open is 'Anonymous read-only projection of every domain table, minus documented withheld columns. Release-gated.';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'evidence_ingest') then
    create role evidence_ingest nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'evidence_inspector_reader') then
    create role evidence_inspector_reader nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'evidence_public_reader') then
    create role evidence_public_reader nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'evidence_publisher') then
    create role evidence_publisher nologin;
  end if;
end
$$;

comment on role evidence_ingest is 'Scoped ingestion worker. No login by itself; a login member is created out-of-band (docs/database/runbook.md).';
comment on role evidence_inspector_reader is 'Owns the inspector views. SELECT only on allowlisted private tables.';
comment on role evidence_public_reader is 'Owns the public views. Column-level SELECT on non-withheld columns only.';
comment on role evidence_publisher is 'May execute the gated release function only.';

-- The migration role must be able to hand view ownership to the reader role.
grant evidence_inspector_reader, evidence_public_reader to current_user;

-- Remove every implicit privilege before granting anything.
revoke all on schema evidence_private, evidence_inspector, evidence_api, evidence_views, evidence_public, evidence_open from public;
revoke all on schema evidence_private, evidence_inspector, evidence_api, evidence_views, evidence_public, evidence_open from anon, authenticated;

alter default privileges in schema evidence_private revoke all on tables from public, anon, authenticated;
alter default privileges in schema evidence_private revoke all on sequences from public, anon, authenticated;
alter default privileges in schema evidence_private revoke execute on functions from public, anon, authenticated;
alter default privileges in schema evidence_inspector revoke all on tables from public, anon, authenticated;
alter default privileges in schema evidence_inspector revoke execute on functions from public, anon, authenticated;
alter default privileges in schema evidence_api revoke all on tables from public, anon, authenticated;
alter default privileges in schema evidence_api revoke execute on functions from public, anon, authenticated;

grant usage on schema evidence_private to evidence_ingest, evidence_inspector_reader, evidence_publisher;
grant usage on schema evidence_inspector to authenticated, evidence_inspector_reader;
grant usage on schema evidence_views to evidence_inspector_reader, evidence_public_reader;
grant usage on schema evidence_public, evidence_open to anon, authenticated, evidence_public_reader;
grant usage on schema evidence_private to evidence_public_reader;

alter default privileges in schema evidence_views revoke all on tables from public, anon, authenticated;
alter default privileges in schema evidence_public revoke all on tables from public, anon, authenticated;
alter default privileges in schema evidence_open revoke all on tables from public, anon, authenticated;
alter default privileges in schema evidence_public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema evidence_open revoke execute on functions from public, anon, authenticated;

-- Shared guards -------------------------------------------------------------

create or replace function evidence_private.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'append-only: % on %.% is not permitted; supersede with a new row',
    tg_op, tg_table_schema, tg_table_name
    using errcode = 'P0001';
end
$$;

comment on function evidence_private.reject_mutation() is
  'Trigger body for append-only history tables. Applies to every role, including the table owner.';

-- Memberships ---------------------------------------------------------------
-- App roles live here, never in user-editable auth metadata.

create table evidence_private.app_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  app_role text not null check (app_role in ('inspector', 'reviewer', 'publisher', 'admin')),
  granted_by text not null,
  grant_reason text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by text,
  check ((revoked_at is null) = (revoked_by is null))
);

create unique index app_memberships_one_current
  on evidence_private.app_memberships (user_id, app_role)
  where revoked_at is null;

comment on table evidence_private.app_memberships is
  'Server-controlled role memberships. Granted only by an administrator through the documented runbook; signing in does not create one.';

alter table evidence_private.app_memberships enable row level security;

create policy app_memberships_reader_select on evidence_private.app_memberships
  for select to evidence_inspector_reader using (true);

grant select on evidence_private.app_memberships to evidence_inspector_reader;

-- There is deliberately no membership function. The inspector views test membership with an inline
-- subquery that runs with the privileges of their read-only owner, so no SECURITY DEFINER is needed.
