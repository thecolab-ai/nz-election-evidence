-- Scheduled ingestion: pg_cron fires a dispatcher that calls the authenticated
-- Edge Function through pg_net. The function URL and shared secret are read from
-- Supabase Vault at dispatch time; neither is stored in a table or in git.
--
-- This migration schedules nothing. A schedule becomes active only through
-- activate_schedule(), which demands proof that the deployed function answered
-- an authenticated readback call.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

alter table evidence_private.import_runs drop constraint import_runs_trigger_kind_check;
alter table evidence_private.import_runs add constraint import_runs_trigger_kind_check
  check (trigger_kind in ('cron', 'function_readback', 'cli', 'test'));

create table evidence_private.ingest_schedules (
  schedule_key text primary key check (schedule_key ~ '^[a-z][a-z0-9_-]{2,60}$'),
  source_id text not null references evidence_private.sources (source_id),
  cron_expr text not null check (cron_expr ~ '^(\S+\s+){4}\S+$'),
  function_slug text not null check (function_slug in ('ingest-run')),
  max_runtime_seconds integer not null check (max_runtime_seconds between 10 and 140),
  max_records integer not null check (max_records between 1 and 2000),
  state text not null default 'inactive' check (state in ('inactive', 'active')),
  cron_jobid bigint,
  activation_proof jsonb,
  activated_by text,
  activated_at timestamptz,
  config_hash text not null,
  check (state = 'inactive'
         or (cron_jobid is not null and activation_proof is not null
             and activated_by is not null and activated_at is not null))
);

comment on table evidence_private.ingest_schedules is
  'Desired schedules from version-controlled config. state=active is only ever set by activate_schedule() with readback proof.';
comment on column evidence_private.ingest_schedules.max_runtime_seconds is
  'Edge Function budget for one incremental run. Large backfills run from the CLI instead.';

create table evidence_private.schedule_dispatch_log (
  id bigint generated always as identity primary key,
  schedule_key text not null references evidence_private.ingest_schedules (schedule_key),
  dispatched_at timestamptz not null default now(),
  outcome text not null check (outcome in ('dispatched', 'skipped_lease_held', 'skipped_inactive', 'config_error')),
  net_request_id bigint,
  detail text
);

create trigger schedule_dispatch_log_append_only
  before update or delete on evidence_private.schedule_dispatch_log
  for each row execute function evidence_private.reject_mutation();

create or replace function evidence_private.sync_schedules(p_schedules jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_item jsonb;
  v_count integer := 0;
begin
  for v_item in select * from jsonb_array_elements(p_schedules) loop
    -- Sync never touches state, proof or the cron job id.
    insert into evidence_private.ingest_schedules (
      schedule_key, source_id, cron_expr, function_slug, max_runtime_seconds, max_records, config_hash)
    values (
      v_item ->> 'schedule_key', v_item ->> 'source_id', v_item ->> 'cron_expr', v_item ->> 'function_slug',
      (v_item ->> 'max_runtime_seconds')::integer, (v_item ->> 'max_records')::integer, v_item ->> 'config_hash')
    on conflict (schedule_key) do update set
      source_id = excluded.source_id, cron_expr = excluded.cron_expr, function_slug = excluded.function_slug,
      max_runtime_seconds = excluded.max_runtime_seconds, max_records = excluded.max_records,
      config_hash = excluded.config_hash;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

create or replace function evidence_private.vault_secret(p_name text)
returns text
language sql
stable
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;

-- Only a Supabase project functions endpoint (or the local stack gateway) is a valid target.
create or replace function evidence_private.functions_base_url_ok(p_url text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_url ~ '^https://[a-z0-9]{16,32}\.supabase\.co/functions/v1$'
      or p_url ~ '^http://(kong|supabase_kong_[a-z0-9_-]+):8000/functions/v1$';
$$;

create or replace function evidence_private.dispatch_ingest(p_schedule_key text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_schedule evidence_private.ingest_schedules%rowtype;
  v_base text;
  v_secret text;
  v_request_id bigint;
begin
  select * into v_schedule from evidence_private.ingest_schedules where schedule_key = p_schedule_key;
  if not found then
    raise exception 'unknown schedule %', p_schedule_key using errcode = 'P0001';
  end if;
  if v_schedule.state <> 'active' then
    insert into evidence_private.schedule_dispatch_log (schedule_key, outcome) values (p_schedule_key, 'skipped_inactive');
    return 'skipped_inactive';
  end if;

  -- Overlap prevention before any network call; the function checks the lease again.
  if exists (select 1 from evidence_private.source_leases l
             where l.source_id = v_schedule.source_id and l.expires_at > now()) then
    insert into evidence_private.schedule_dispatch_log (schedule_key, outcome) values (p_schedule_key, 'skipped_lease_held');
    return 'skipped_lease_held';
  end if;

  v_base := evidence_private.vault_secret('evidence_functions_base_url');
  v_secret := evidence_private.vault_secret('evidence_cron_secret');
  if v_base is null or v_secret is null or length(v_secret) < 32
     or not evidence_private.functions_base_url_ok(v_base) then
    insert into evidence_private.schedule_dispatch_log (schedule_key, outcome, detail)
    values (p_schedule_key, 'config_error', 'vault secrets missing, too short, or base URL not an allowed functions endpoint');
    return 'config_error';
  end if;

  select net.http_post(
    url := v_base || '/' || v_schedule.function_slug,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-evidence-cron-secret', v_secret),
    body := jsonb_build_object(
      'schedule_key', v_schedule.schedule_key, 'source_id', v_schedule.source_id, 'trigger_kind', 'cron',
      'max_runtime_seconds', v_schedule.max_runtime_seconds, 'max_records', v_schedule.max_records),
    timeout_milliseconds := (v_schedule.max_runtime_seconds + 5) * 1000
  ) into v_request_id;

  insert into evidence_private.schedule_dispatch_log (schedule_key, outcome, net_request_id)
  values (p_schedule_key, 'dispatched', v_request_id);
  return 'dispatched';
end
$$;

-- Activation needs machine-checkable proof: a recent successful run that the deployed
-- function created in response to an authenticated readback call.
create or replace function evidence_private.activate_schedule(
  p_schedule_key text, p_readback_run_id uuid, p_function_version text, p_activated_by text)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_schedule evidence_private.ingest_schedules%rowtype;
  v_run evidence_private.import_runs%rowtype;
  v_jobid bigint;
begin
  select * into v_schedule from evidence_private.ingest_schedules where schedule_key = p_schedule_key for update;
  if not found then
    raise exception 'unknown schedule %', p_schedule_key using errcode = 'P0001';
  end if;
  if coalesce(trim(p_activated_by), '') = '' or coalesce(trim(p_function_version), '') = '' then
    raise exception 'activation needs a named person and the deployed function version' using errcode = 'P0001';
  end if;

  select * into v_run from evidence_private.import_runs where id = p_readback_run_id;
  if not found or v_run.source_id <> v_schedule.source_id or v_run.trigger_kind <> 'function_readback'
     or v_run.status <> 'succeeded' or v_run.finished_at < now() - interval '24 hours' then
    raise exception 'no successful function readback run for this source in the last 24 hours' using errcode = 'P0001';
  end if;
  if not exists (select 1 from evidence_private.sources s where s.source_id = v_schedule.source_id and s.enabled) then
    raise exception 'source % is not enabled', v_schedule.source_id using errcode = 'P0001';
  end if;
  if evidence_private.vault_secret('evidence_cron_secret') is null
     or not evidence_private.functions_base_url_ok(coalesce(evidence_private.vault_secret('evidence_functions_base_url'), '')) then
    raise exception 'vault secrets for the dispatcher are missing or invalid' using errcode = 'P0001';
  end if;

  select cron.schedule(v_schedule.schedule_key, v_schedule.cron_expr,
                       format('select evidence_private.dispatch_ingest(%L)', v_schedule.schedule_key))
    into v_jobid;

  update evidence_private.ingest_schedules
     set state = 'active', cron_jobid = v_jobid, activated_by = p_activated_by, activated_at = now(),
         activation_proof = jsonb_build_object(
           'readback_run_id', v_run.id, 'readback_finished_at', v_run.finished_at,
           'function_version', p_function_version, 'adapter_version', v_run.adapter_version)
   where schedule_key = p_schedule_key;
  return v_jobid;
end
$$;

create or replace function evidence_private.deactivate_schedule(p_schedule_key text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from cron.job where jobname = p_schedule_key) then
    perform cron.unschedule(p_schedule_key);
  end if;
  update evidence_private.ingest_schedules
     set state = 'inactive', cron_jobid = null, activation_proof = null, activated_by = null, activated_at = null
   where schedule_key = p_schedule_key;
end
$$;
