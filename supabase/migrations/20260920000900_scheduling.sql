-- Scheduled ingestion: pg_cron fires a dispatcher that calls the authenticated
-- Edge Function through pg_net. The function URL and shared secret are read from
-- Supabase Vault at dispatch time; neither is stored in a table or in git.
--
-- This migration schedules nothing. A schedule becomes active only through
-- activate_schedule(), which demands proof that the deployed function answered
-- an authenticated readback call, names the person activating it, and only for a
-- public unauthenticated source. robots.txt, terms pages and terms reviews are recorded
-- and reported as advisories (owner collection policy, 2026-09-20); only a person's
-- recorded "not permitted" blocks (RED-LINES R6). No migration, seed or tool writes a review.

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
  outcome text not null check (outcome in ('dispatched', 'skipped_lease_held', 'skipped_inactive', 'skipped_access_not_permitted', 'config_error')),
  net_request_id bigint,
  detail text
);

create trigger schedule_dispatch_log_append_only
  before update or delete on evidence_private.schedule_dispatch_log
  for each row execute function evidence_private.reject_mutation();

-- Publisher access: what was checked, and what a person concluded ---------------------------
--
-- Two different things, kept in two tables so one can never pass for the other:
--   publisher_access_checks  machine provenance. A tool retrieved robots.txt or a terms page at a time, got a
--                            status and a body hash. It proves a page was looked at. It is NOT a legal reading.
--   publisher_terms_reviews  a named person's conclusion, after reading the terms page a recorded check
--                            retrieved, on whether automated access is permitted. Only this can unlock a
--                            schedule, and nothing in this repository writes one.

create table evidence_private.publisher_access_checks (
  id bigint generated always as identity primary key,
  source_id text not null references evidence_private.sources (source_id),
  check_kind text not null check (check_kind in ('robots_txt', 'terms_page')),
  checked_url text not null check (checked_url ~ '^https://'),
  checked_host text not null,
  -- For a robots check: the path the adapter would fetch, and what the rules say about it.
  target_path text,
  outcome text not null check (outcome in (
    'retrieved', 'not_found', 'challenge', 'blocked', 'http_error', 'network_error', 'not_attempted')),
  http_status integer,
  response_bytes bigint,
  body_sha256 text check (body_sha256 is null or body_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  finding text not null check (finding in (
    'path_allowed', 'path_disallowed', 'no_rules_published', 'terms_page_retrieved', 'not_retrievable', 'no_terms_url_recorded')),
  crawl_delay_seconds numeric check (crawl_delay_seconds is null or crawl_delay_seconds >= 0),
  checked_at timestamptz not null,
  tool_version text not null,
  recorded_at timestamptz not null default now(),
  check ((check_kind = 'robots_txt') = (finding in ('path_allowed', 'path_disallowed', 'no_rules_published'))
         or finding = 'not_retrievable'),
  check (finding <> 'terms_page_retrieved' or (outcome = 'retrieved' and body_sha256 is not null))
);

comment on table evidence_private.publisher_access_checks is
  'Append-only provenance of automated robots.txt and terms-page retrievals. Proves a page was retrieved at a time with a given hash; it is not a legal review and never stores the page body.';

create index publisher_access_checks_source on evidence_private.publisher_access_checks (source_id, check_kind, checked_at desc);

-- recorded_at is the server's clock, whatever the writer sends, and a check cannot claim to come from the future.
-- "Latest" is decided by recorded_at, so a skewed or forged checked_at can neither mask a later disallow nor stay fresh forever.
create or replace function evidence_private.stamp_access_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.recorded_at := now();
  if new.checked_at > now() + interval '5 minutes' then
    raise exception 'an access check cannot be dated in the future' using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger publisher_access_checks_stamp
  before insert on evidence_private.publisher_access_checks
  for each row execute function evidence_private.stamp_access_check();

create trigger publisher_access_checks_append_only
  before update or delete on evidence_private.publisher_access_checks
  for each row execute function evidence_private.reject_mutation();

create table evidence_private.publisher_terms_reviews (
  id bigint generated always as identity primary key,
  source_id text not null references evidence_private.sources (source_id),
  rights_id text not null references evidence_private.source_rights (rights_id),
  terms_url text not null check (terms_url ~ '^https://'),
  terms_check_id bigint not null references evidence_private.publisher_access_checks (id),
  robots_check_id bigint not null references evidence_private.publisher_access_checks (id),
  automated_access text not null check (automated_access in ('permitted', 'permitted_with_conditions', 'not_permitted', 'unclear')),
  conditions text,
  reviewed_by text not null check (trim(reviewed_by) <> ''),
  reviewed_at timestamptz not null default now(),
  check (automated_access <> 'permitted_with_conditions' or coalesce(trim(conditions), '') <> '')
);

comment on table evidence_private.publisher_terms_reviews is
  'A named person''s reading of a publisher''s terms for one source. Append-only; the latest row per source counts. Written only by an administrator on a person''s instruction - no tool, seed or migration creates one.';

create trigger publisher_terms_reviews_append_only
  before update or delete on evidence_private.publisher_terms_reviews
  for each row execute function evidence_private.reject_mutation();

-- A review must rest on checks that actually retrieved this source's terms page and robots rules.
create or replace function evidence_private.guard_terms_review()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_source evidence_private.sources%rowtype;
  v_terms evidence_private.publisher_access_checks%rowtype;
  v_robots evidence_private.publisher_access_checks%rowtype;
  v_register_url text;
begin
  new.reviewed_at := now();  -- the server's clock: a review cannot be back- or forward-dated
  select * into v_source from evidence_private.sources where source_id = new.source_id;
  if v_source.rights_id is distinct from new.rights_id then
    raise exception 'the review names a rights row that is not this source''s' using errcode = 'P0001';
  end if;
  select licence_or_terms_url into v_register_url from evidence_private.source_rights where rights_id = new.rights_id;
  if v_register_url is null or v_register_url <> new.terms_url then
    raise exception 'the reviewed terms URL must be the one recorded in the rights register' using errcode = 'P0001';
  end if;
  select * into v_terms from evidence_private.publisher_access_checks where id = new.terms_check_id;
  if v_terms.source_id <> new.source_id or v_terms.check_kind <> 'terms_page'
     or v_terms.finding <> 'terms_page_retrieved' or v_terms.checked_url <> new.terms_url then
    raise exception 'a terms review needs a recorded retrieval of that exact terms page for this source' using errcode = 'P0001';
  end if;
  select * into v_robots from evidence_private.publisher_access_checks where id = new.robots_check_id;
  if v_robots.source_id <> new.source_id or v_robots.check_kind <> 'robots_txt'
     or v_robots.finding = 'not_retrievable' then
    raise exception 'a terms review needs a recorded robots.txt check for this source' using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger publisher_terms_reviews_guard
  before insert on evidence_private.publisher_terms_reviews
  for each row execute function evidence_private.guard_terms_review();

-- Collection policy (owner decision, 2026-09-20). Two different questions, two functions:
--
--   automated_access_blocker()     what STOPS a schedule. Only: the source is unknown or not enabled; it has no rights
--                                  register row; it is not a public unauthenticated endpoint (behind a sign-in or a
--                                  paywall, or its kind is not stated); or a PERSON has recorded that the publisher's
--                                  terms do not permit automated access (RED-LINES R6).
--   automated_access_advisories()  what is REPORTED for a person's decision and never stops anything by itself: a
--                                  robots.txt disallow or an unreadable/missing/stale robots check, no terms URL, no
--                                  terms review or an unclear/stale one, an undocumented public endpoint, and any known
--                                  specific restriction written on the source.
--
-- Neither says anything about publication. Rights rows, release gates and withheld columns are separate and unchanged.
-- Used by activation AND by every dispatch, so an adverse review recorded later stops an active job.
create or replace function evidence_private.automated_access_blocker(p_source_id text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_source evidence_private.sources%rowtype;
  v_review evidence_private.publisher_terms_reviews%rowtype;
begin
  select * into v_source from evidence_private.sources where source_id = p_source_id;
  if not found then return 'unknown source'; end if;
  if not v_source.enabled then return 'source is not enabled'; end if;
  if v_source.rights_id is null then return 'source has no rights register row'; end if;
  if v_source.access_basis is null then return 'the source does not say what kind of endpoint it is'; end if;
  if v_source.access_basis in ('authenticated', 'paywalled') then
    return 'the source is behind a sign-in or a paywall; only public unauthenticated content is collected';
  end if;
  select * into v_review from evidence_private.publisher_terms_reviews
   where source_id = p_source_id order by reviewed_at desc, id desc limit 1;
  if found and v_review.automated_access = 'not_permitted' then
    return 'the latest recorded terms review says automated access is not permitted (R6)';
  end if;
  return null;
end
$$;

create or replace function evidence_private.automated_access_advisories(p_source_id text)
returns text[]
language plpgsql
stable
set search_path = ''
as $$
declare
  v_source evidence_private.sources%rowtype;
  v_terms_url text;
  v_review evidence_private.publisher_terms_reviews%rowtype;
  v_robots evidence_private.publisher_access_checks%rowtype;
  v_out text[] := '{}';
begin
  select * into v_source from evidence_private.sources where source_id = p_source_id;
  if not found then return array['unknown source']; end if;
  if v_source.access_basis = 'public_undocumented_endpoint' then
    v_out := array_append(v_out, 'the endpoint is public but undocumented: the publisher has not published terms for it'::text);
  end if;
  if coalesce(trim(v_source.known_access_restriction), '') <> '' then
    v_out := array_append(v_out, ('known restriction: ' || v_source.known_access_restriction)::text);
  end if;

  select licence_or_terms_url into v_terms_url from evidence_private.source_rights where rights_id = v_source.rights_id;
  if v_terms_url is null then v_out := array_append(v_out, 'the rights register records no terms URL for this publisher'::text); end if;

  select * into v_review from evidence_private.publisher_terms_reviews
   where source_id = p_source_id order by reviewed_at desc, id desc limit 1;
  if not found then
    v_out := array_append(v_out, 'no person has reviewed the publisher''s terms for automated access'::text);
  else
    if v_terms_url is not null and v_review.terms_url <> v_terms_url then v_out := array_append(v_out, 'the terms URL changed since the last terms review'::text); end if;
    if v_review.automated_access = 'unclear' then v_out := array_append(v_out, 'the latest terms review found the terms unclear on automated access'::text); end if;
    if v_review.automated_access = 'permitted_with_conditions' then v_out := array_append(v_out, 'the latest terms review permits automated access with conditions'::text); end if;
    if v_review.automated_access = 'not_permitted' then v_out := array_append(v_out, 'the latest terms review says automated access is not permitted (this one also blocks: R6)'::text); end if;
    if v_review.reviewed_at < now() - interval '365 days' then v_out := array_append(v_out, 'the terms review is more than a year old'::text); end if;
  end if;

  select * into v_robots from evidence_private.publisher_access_checks
   where source_id = p_source_id and check_kind = 'robots_txt' order by recorded_at desc, id desc limit 1;
  if not found then
    v_out := array_append(v_out, 'no robots.txt check is on record'::text);
  else
    if least(v_robots.checked_at, v_robots.recorded_at) < now() - interval '30 days' then v_out := array_append(v_out, 'the latest robots.txt check is more than 30 days old'::text); end if;
    if v_robots.finding = 'path_disallowed' then v_out := array_append(v_out, 'robots.txt disallows this path for this client'::text); end if;
    if v_robots.finding = 'not_retrievable' then v_out := array_append(v_out, 'robots.txt could not be read'::text); end if;
  end if;
  return v_out;
end
$$;

comment on function evidence_private.automated_access_advisories(text) is
  'Signals reported for a person''s decision before and after activation. None of them stops collection by itself.';

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
    -- An active schedule is frozen: its configuration was what the activation proof covered. Unchanged config is
    -- skipped; changed config is refused until someone deactivates it (which needs more than the worker login).
    if exists (select 1 from evidence_private.ingest_schedules s
               where s.schedule_key = v_item ->> 'schedule_key' and s.state = 'active') then
      if exists (select 1 from evidence_private.ingest_schedules s
                 where s.schedule_key = v_item ->> 'schedule_key' and s.config_hash = v_item ->> 'config_hash') then
        continue;
      end if;
      raise exception 'schedule % is active; deactivate it before changing its configuration', v_item ->> 'schedule_key'
        using errcode = 'P0001';
    end if;
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

  -- A schedule stops when its source is disabled, stops being a public unauthenticated endpoint, or a person records
  -- that the terms do not permit automated access. Advisories (robots.txt, missing review) do not stop it.
  if evidence_private.automated_access_blocker(v_schedule.source_id) is not null then
    insert into evidence_private.schedule_dispatch_log (schedule_key, outcome, detail)
    values (p_schedule_key, 'skipped_access_not_permitted', evidence_private.automated_access_blocker(v_schedule.source_id));
    return 'skipped_access_not_permitted';
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
  v_blocker text;
  v_review_id bigint;
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
  -- Hard stops only (not public and unauthenticated, no rights row, a recorded "not permitted"). Everything else
  -- known about access is copied into the activation proof, so the record shows what the activating person was told.
  v_blocker := evidence_private.automated_access_blocker(v_schedule.source_id);
  if v_blocker is not null then
    raise exception 'automated access is not cleared for %: %', v_schedule.source_id, v_blocker using errcode = 'P0001';
  end if;
  select id into v_review_id from evidence_private.publisher_terms_reviews
   where source_id = v_schedule.source_id order by reviewed_at desc, id desc limit 1;
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
           'function_version', p_function_version, 'adapter_version', v_run.adapter_version,
           'terms_review_id', v_review_id,
           'access_advisories_at_activation', to_jsonb(evidence_private.automated_access_advisories(v_schedule.source_id)))
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
