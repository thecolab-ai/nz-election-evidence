-- Ingestion API for the scoped worker role: registry sync, leases, run ledger,
-- checkpoints, idempotent batch ingest, snapshot tombstones and freshness.
-- All functions are SECURITY INVOKER; the worker's table grants bound what they can do.

-- Payload guard ------------------------------------------------------------------
-- Defence in depth behind the adapter allowlists. Rejects contact fields, bodies,
-- filesystem locations and oversized payloads before anything is stored.

-- Text that must never be stored from a source or an operation: contact data, credentials,
-- filesystem locations, control characters. Used for every string a record carries, not only payloads.
create or replace function evidence_private.text_violation(p_text text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_text is null then
    return null;
  end if;
  if p_text ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
    return 'control_characters';
  end if;
  if p_text ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' then
    return 'email_like_value';
  end if;
  if p_text ~ '(^|["\s=:(,])(file://|~/|[A-Za-z]:\\|/(home|Users|root|var|mnt|srv|etc|tmp|opt|data)/)' then
    return 'filesystem_location_value';
  end if;
  if p_text ~* '(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token|bearer|authorization)["'']?\s*[=:]\s*\S'
     or p_text ~ 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.'
     -- (the pattern is assembled from two pieces so this file does not itself look like it holds a token)
     or p_text ~ ('(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github' || '_pat_|sb_secret_|sk-[A-Za-z0-9]{16,}|BEGIN [A-Z ]*PRIVATE KEY)')
     or p_text ~* '[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@' then
    return 'credential_like_value';
  end if;
  if p_text ~ '(^|[^0-9])(\+?64|0)[ -]?[2-9][0-9]?[ -]?[0-9]{3}[ -]?[0-9]{3,4}([^0-9]|$)' and p_text ~* '(ph|phone|mob|tel|call)' then
    return 'phone_like_value';
  end if;
  return null;
end
$$;

-- A publisher link may not carry credentials or secret-bearing query parameters.
create or replace function evidence_private.url_violation(p_url text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_url ~ '^[a-z]+://[^/?#]*@' then
    return 'url_userinfo';
  end if;
  if p_url is null or p_url !~ '^https://[A-Za-z0-9.-]+(/|$|[?#])' then
    return 'url_not_plain_https';
  end if;
  if length(p_url) > 2000 then
    return 'url_too_long';
  end if;
  if p_url ~* '[?&#](key|api_?key|token|access_token|auth|signature|sig|secret|password|pwd|session|sid|jwt)=' then
    return 'url_secret_parameter';
  end if;
  return evidence_private.text_violation(p_url);
end
$$;

create or replace function evidence_private.payload_violation(p_payload jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text := p_payload::text;
  v_key text;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    return 'payload_not_object';
  end if;
  if length(v_text) > 8192 then
    return 'payload_too_large';
  end if;
  -- Field names are part of what gets published: plain snake_case only, at every depth.
  for v_key in select jsonb_path_query(p_payload, '$.** ? (@.type() == "object").keyvalue().key') #>> '{}' loop
    if v_key !~ '^[a-z][a-z0-9_]{0,62}$' then
      return 'hostile_field_name';
    end if;
  end loop;
  if v_text ~* '"(e[-_]?mail|phone|mobile|fax|address|street|postcode|donor[a-z_]*|contributor[a-z_]*|body|html|raw[a-z_]*|full_text|content_html|file_path|archive_path|local_path|storage_url|signed_url|source_record_json|payload_json|source_passage|password|secret|token|api_key|credential[a-z_]*)"\s*:' then
    return 'forbidden_field_name';
  end if;
  return evidence_private.text_violation(v_text);
end
$$;

-- Everything else a record carries: identifiers, kind, links, publisher date text, omitted-field names.
create or replace function evidence_private.record_violation(p_rec jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_id text := p_rec ->> 'external_record_id';
  v_item jsonb;
  v_violation text;
begin
  if v_id is null or length(v_id) not between 1 and 400 or v_id ~ '[\s<>"''\\]' or v_id ~ '^[/~.]' or v_id ~ '://' then
    return 'bad_external_record_id';
  end if;
  v_violation := evidence_private.text_violation(v_id);
  if v_violation is not null then
    return 'external_record_id_' || v_violation;
  end if;
  if coalesce(p_rec ->> 'record_kind', '') !~ '^[a-z][a-z0-9_]{1,60}$' then
    return 'bad_record_kind';
  end if;
  if coalesce(p_rec ->> 'content_hash', '') !~ '^sha256:[0-9a-f]{64}$' then
    return 'bad_content_hash';
  end if;
  if p_rec ->> 'original_content_hash' is not null and p_rec ->> 'original_content_hash' !~ '^[A-Za-z0-9:_-]{8,200}$' then
    return 'bad_original_content_hash';
  end if;
  v_violation := evidence_private.url_violation(p_rec ->> 'source_url');
  if v_violation is not null then
    return 'source_' || v_violation;
  end if;
  if p_rec ->> 'source_date_text' is not null and p_rec ->> 'source_date_text' !~ '^[A-Za-z0-9 ,:+./()-]{1,80}$' then
    return 'bad_source_date_text';
  end if;
  if jsonb_typeof(coalesce(p_rec -> 'omitted_fields', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_rec -> 'omitted_fields', '[]'::jsonb)) > 100 then
    return 'bad_omitted_fields';
  end if;
  for v_item in select * from jsonb_array_elements(coalesce(p_rec -> 'omitted_fields', '[]'::jsonb)) loop
    if jsonb_typeof(v_item) <> 'object' or coalesce(v_item ->> 'field', '') !~ '^[A-Za-z*][A-Za-z0-9_.*-]{0,79}$'
       or length(coalesce(v_item ->> 'reason', '')) not between 3 and 300
       or (select count(*) from jsonb_object_keys(v_item)) <> 2 then
      return 'hostile_omitted_field';
    end if;
    v_violation := evidence_private.text_violation(v_item ->> 'reason');
    if v_violation is not null then
      return 'omitted_reason_' || v_violation;
    end if;
  end loop;
  return evidence_private.payload_violation(p_rec -> 'safe_payload');
end
$$;

-- Operational free text (run errors) is redacted before storage and is never part of a public projection.
create or replace function evidence_private.redact_text(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(p_text, ''),
    '[a-z][a-z0-9+.-]*://[^\s]+', '[url]', 'gi'),
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[contact]', 'g'),
    '(~|[A-Za-z]:\\|/(home|Users|root|var|mnt|srv|etc|tmp|opt|data))[^\s]*', '[location]', 'g'),
    '(password|passwd|secret|api[_-]?key|token|bearer|authorization)\S*\s*[=:]?\s*\S+', '[credential]', 'gi'), 500);
$$;

-- Registry sync ------------------------------------------------------------------

create or replace function evidence_private.sync_registry(p_registry jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item jsonb;
  v_rights integer := 0;
  v_sources integer := 0;
  v_maps integer := 0;
begin
  for v_item in select * from jsonb_array_elements(coalesce(p_registry -> 'rights', '[]'::jsonb)) loop
    insert into evidence_private.source_rights (
      rights_id, publisher, source_url, review_status, default_release, licence_or_terms_url,
      verified_permissions, excluded_assets, attribution, reviewed_on, approved_fields, register_hash)
    values (
      v_item ->> 'rights_id', v_item ->> 'publisher', v_item ->> 'source_url',
      v_item ->> 'review_status', v_item ->> 'default_release',
      nullif(v_item ->> 'licence_or_terms_url', ''), v_item ->> 'verified_permissions',
      v_item ->> 'excluded_assets', v_item ->> 'attribution',
      nullif(v_item ->> 'reviewed_on', '')::date,
      coalesce((select array_agg(f) from jsonb_array_elements_text(v_item -> 'approved_fields') f), '{}'),
      v_item ->> 'register_hash')
    on conflict (rights_id) do update set
      publisher = excluded.publisher, source_url = excluded.source_url,
      review_status = excluded.review_status, default_release = excluded.default_release,
      licence_or_terms_url = excluded.licence_or_terms_url,
      verified_permissions = excluded.verified_permissions, excluded_assets = excluded.excluded_assets,
      attribution = excluded.attribution, reviewed_on = excluded.reviewed_on,
      approved_fields = excluded.approved_fields,
      register_hash = excluded.register_hash, synced_at = now()
    where evidence_private.source_rights.register_hash is distinct from excluded.register_hash;
    v_rights := v_rights + 1;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p_registry -> 'registry_products', '[]'::jsonb)) loop
    insert into evidence_private.registry_products (registry_key, title, domain, notes)
    values (v_item ->> 'registry_key', v_item ->> 'title', v_item ->> 'domain', v_item ->> 'notes')
    on conflict (registry_key) do update set
      title = excluded.title, domain = excluded.domain, notes = excluded.notes;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p_registry -> 'sources', '[]'::jsonb)) loop
    insert into evidence_private.sources (
      source_id, registry_key, title, publisher, official_url, adapter_kind, adapter_name,
      allowed_hosts, rights_id, view_scope, expected_cadence_seconds, snapshot_semantics,
      enabled, blocked_reason, config_hash)
    values (
      v_item ->> 'source_id', nullif(v_item ->> 'registry_key', ''), v_item ->> 'title',
      v_item ->> 'publisher', v_item ->> 'official_url', v_item ->> 'adapter_kind',
      v_item ->> 'adapter_name',
      coalesce((select array_agg(h) from jsonb_array_elements_text(v_item -> 'allowed_hosts') h), '{}'),
      nullif(v_item ->> 'rights_id', ''), v_item ->> 'view_scope',
      nullif(v_item ->> 'expected_cadence_seconds', '')::integer, v_item ->> 'snapshot_semantics',
      coalesce((v_item ->> 'enabled')::boolean, false), nullif(v_item ->> 'blocked_reason', ''),
      v_item ->> 'config_hash')
    on conflict (source_id) do update set
      registry_key = excluded.registry_key, title = excluded.title, publisher = excluded.publisher,
      official_url = excluded.official_url, adapter_kind = excluded.adapter_kind,
      adapter_name = excluded.adapter_name, allowed_hosts = excluded.allowed_hosts,
      rights_id = excluded.rights_id, view_scope = excluded.view_scope,
      expected_cadence_seconds = excluded.expected_cadence_seconds,
      snapshot_semantics = excluded.snapshot_semantics, enabled = excluded.enabled,
      blocked_reason = excluded.blocked_reason, config_hash = excluded.config_hash, synced_at = now();
    v_sources := v_sources + 1;

    insert into evidence_private.source_freshness (source_id)
    values (v_item ->> 'source_id') on conflict (source_id) do nothing;

    delete from evidence_private.catalogue_product_map where source_id = v_item ->> 'source_id';
    insert into evidence_private.catalogue_product_map (source_id, product_id, mapping_note)
    select v_item ->> 'source_id', m ->> 'product_id', m ->> 'mapping_note'
    from jsonb_array_elements(coalesce(v_item -> 'catalogue_products', '[]'::jsonb)) m;
    get diagnostics v_maps = row_count;
  end loop;

  return jsonb_build_object('rights', v_rights, 'sources', v_sources);
end
$$;

-- Leases ---------------------------------------------------------------------------

create or replace function evidence_private.acquire_lease(p_source_id text, p_holder uuid, p_ttl_seconds integer)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_existing evidence_private.source_leases%rowtype;
begin
  if p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 3600 then
    raise exception 'lease ttl must be between 30 and 3600 seconds' using errcode = 'P0001';
  end if;

  select * into v_existing from evidence_private.source_leases where source_id = p_source_id for update;

  if not found then
    begin
      insert into evidence_private.source_leases (source_id, holder, expires_at)
      values (p_source_id, p_holder, now() + make_interval(secs => p_ttl_seconds));
      return true;
    exception when unique_violation then
      return false;
    end;
  end if;

  if v_existing.holder <> p_holder and v_existing.expires_at > now() then
    return false;
  end if;

  if v_existing.holder <> p_holder then
    -- Takeover of an expired lease: the previous run is recorded as abandoned, not erased.
    update evidence_private.import_runs
       set status = 'abandoned', finished_at = now(), error_class = 'lease_expired',
           error_detail = 'lease expired and was taken over by another worker'
     where source_id = p_source_id and status = 'running';
  end if;

  update evidence_private.source_leases
     set holder = p_holder,
         run_id = case when holder = p_holder then run_id else null end,
         acquired_at = case when holder = p_holder then acquired_at else now() end,
         heartbeat_at = now(),
         expires_at = now() + make_interval(secs => p_ttl_seconds)
   where source_id = p_source_id;
  return true;
end
$$;

create or replace function evidence_private.release_lease(p_source_id text, p_holder uuid)
returns void
language sql
set search_path = ''
as $$
  delete from evidence_private.source_leases where source_id = p_source_id and holder = p_holder;
$$;

create or replace function evidence_private.assert_run_held(p_run_id uuid, p_holder uuid)
returns evidence_private.import_runs
language plpgsql
set search_path = ''
as $$
declare
  v_run evidence_private.import_runs%rowtype;
begin
  select * into v_run from evidence_private.import_runs where id = p_run_id for update;
  if not found then
    raise exception 'run not found' using errcode = 'P0001';
  end if;
  if v_run.status <> 'running' then
    raise exception 'run is % and accepts no more writes', v_run.status using errcode = 'P0001';
  end if;
  if v_run.holder <> p_holder or not exists (
    select 1 from evidence_private.source_leases l
    where l.source_id = v_run.source_id and l.holder = p_holder and l.expires_at > now())
  then
    raise exception 'worker no longer holds the lease for source %', v_run.source_id using errcode = 'P0001';
  end if;
  return v_run;
end
$$;

-- Run ledger ------------------------------------------------------------------------

create or replace function evidence_private.start_run(
  p_source_id text, p_holder uuid, p_adapter_version text, p_mode text, p_trigger_kind text, p_manifest_hash text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_source evidence_private.sources%rowtype;
  v_run_id uuid;
  v_resume uuid;
  v_cursor jsonb;
begin
  select * into v_source from evidence_private.sources where source_id = p_source_id;
  if not found then
    raise exception 'unknown source %; run the registry sync first', p_source_id using errcode = 'P0001';
  end if;
  if p_trigger_kind = 'cron' and not v_source.enabled then
    raise exception 'source % is not enabled for scheduled runs', p_source_id using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from evidence_private.source_leases l
    where l.source_id = p_source_id and l.holder = p_holder and l.expires_at > now())
  then
    raise exception 'acquire the lease for % before starting a run', p_source_id using errcode = 'P0001';
  end if;

  -- The caller holds the only live lease, so any run still marked running has died (crash, timeout).
  update evidence_private.import_runs
     set status = 'abandoned', finished_at = now(), error_class = 'superseded_by_new_run',
         error_detail = 'worker stopped without finishing; a later run took over'
   where source_id = p_source_id and status = 'running';

  -- Resume from the newest unfinished attempt of the same mode and manifest, if it left a checkpoint.
  select r.id into v_resume
  from evidence_private.import_runs r
  where r.source_id = p_source_id and r.mode = p_mode
    and r.status in ('abandoned', 'failed', 'partial')
    and r.manifest_hash is not distinct from p_manifest_hash
    and exists (select 1 from evidence_private.run_checkpoints c where c.run_id = r.id)
    -- A checkpoint is resumed at most once. If that attempt also fails, the next run starts clean,
    -- so a checkpoint the publisher has since invalidated can never wedge the source.
    and not exists (select 1 from evidence_private.import_runs again where again.resumed_from_run_id = r.id)
    and not exists (
      select 1 from evidence_private.import_runs later
      where later.source_id = p_source_id and later.mode = p_mode
        and later.status = 'succeeded' and later.started_at > r.started_at)
  order by r.started_at desc
  limit 1;

  if v_resume is not null then
    select c.cursor_state into v_cursor
    from evidence_private.run_checkpoints c where c.run_id = v_resume order by c.seq desc limit 1;
  end if;

  insert into evidence_private.import_runs (
    source_id, adapter_version, mode, trigger_kind, holder, manifest_hash, resumed_from_run_id)
  values (p_source_id, p_adapter_version, p_mode, p_trigger_kind, p_holder, p_manifest_hash, v_resume)
  returning id into v_run_id;

  update evidence_private.source_leases set run_id = v_run_id, heartbeat_at = now()
   where source_id = p_source_id and holder = p_holder;

  return jsonb_build_object('run_id', v_run_id, 'resumed_from_run_id', v_resume, 'resume_cursor', v_cursor);
end
$$;

create or replace function evidence_private.save_checkpoint(
  p_run_id uuid, p_holder uuid, p_cursor_state jsonb, p_records_so_far integer, p_extend_seconds integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_run evidence_private.import_runs%rowtype;
  v_seq integer;
begin
  v_run := evidence_private.assert_run_held(p_run_id, p_holder);
  if length(p_cursor_state::text) > 2048 or evidence_private.text_violation(p_cursor_state::text) is not null then
    raise exception 'checkpoint cursor is too large or carries disallowed text' using errcode = 'P0001';
  end if;
  select coalesce(max(seq), -1) + 1 into v_seq from evidence_private.run_checkpoints where run_id = p_run_id;
  insert into evidence_private.run_checkpoints (run_id, seq, cursor_state, records_so_far)
  values (p_run_id, v_seq, p_cursor_state, p_records_so_far);
  update evidence_private.source_leases
     set heartbeat_at = now(),
         expires_at = greatest(expires_at, now() + make_interval(secs => least(greatest(p_extend_seconds, 30), 3600)))
   where source_id = v_run.source_id and holder = p_holder;
  return v_seq;
end
$$;

create or replace function evidence_private.log_fetch(p_run_id uuid, p_source_id text, p_entries jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  if exists (select 1 from jsonb_array_elements(p_entries) e where evidence_private.url_violation(e ->> 'url') is not null
                or coalesce(e ->> 'host', '') !~ '^[a-z0-9.-]{0,253}$') then
    raise exception 'fetch log entry carries a URL or host that may not be stored' using errcode = 'P0001';
  end if;
  insert into evidence_private.fetch_log (
    run_id, source_id, request_method, request_url, request_host, attempt, outcome,
    http_status, response_bytes, body_sha256, retrieved_at, duration_ms)
  select p_run_id, p_source_id, e ->> 'method', e ->> 'url', e ->> 'host', (e ->> 'attempt')::integer,
         e ->> 'outcome', nullif(e ->> 'http_status', '')::integer, nullif(e ->> 'bytes', '')::bigint,
         nullif(e ->> 'body_sha256', ''), (e ->> 'retrieved_at')::timestamptz,
         nullif(e ->> 'duration_ms', '')::integer
  from jsonb_array_elements(p_entries) e;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- Idempotent batch ingest ---------------------------------------------------------------

create or replace function evidence_private.ingest_batch(p_run_id uuid, p_holder uuid, p_records jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_run evidence_private.import_runs%rowtype;
  v_rec jsonb;
  v_record evidence_private.source_records%rowtype;
  v_version_id uuid;
  v_new_version boolean;
  v_violation text;
  v_retrieved timestamptz;
  v_seen integer := 0;
  v_inserted integer := 0;
  v_observed integer := 0;
  v_unchanged integer := 0;
  v_rejected integer := 0;
  v_rows integer;
begin
  v_run := evidence_private.assert_run_held(p_run_id, p_holder);
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 500 then
    raise exception 'a batch is a JSON array of at most 500 records' using errcode = 'P0001';
  end if;

  for v_rec in select * from jsonb_array_elements(p_records) loop
    v_seen := v_seen + 1;
    -- Every string the record carries is checked, not only the payload.
    v_violation := evidence_private.record_violation(v_rec);
    if v_violation is null and not exists (
      select 1 from evidence_private.sources s
      where s.source_id = v_run.source_id
        and (s.adapter_kind = 'export_import'
             or split_part(split_part(v_rec ->> 'source_url', '://', 2), '/', 1) = any (s.allowed_hosts)))
    then
      v_violation := 'source_url_host_not_allowlisted';
    end if;

    if v_violation is not null then
      v_rejected := v_rejected + 1;
      insert into evidence_private.ingest_errors (run_id, source_id, error_class, message, record_ref)
      values (p_run_id, v_run.source_id, 'record_rejected', v_violation,
              'sha256:' || left(encode(sha256(convert_to(coalesce(v_rec ->> 'external_record_id', ''), 'UTF8')), 'hex'), 16));
      continue;
    end if;

    v_retrieved := (v_rec ->> 'retrieved_at')::timestamptz;

    insert into evidence_private.source_records (
      source_id, external_record_id, record_kind, first_seen_at, last_seen_at)
    values (v_run.source_id, v_rec ->> 'external_record_id', v_rec ->> 'record_kind', v_retrieved, v_retrieved)
    on conflict (source_id, external_record_id) do update
      set last_seen_at = greatest(evidence_private.source_records.last_seen_at, excluded.last_seen_at)
    returning * into v_record;

    -- The same record with two different contents inside one run is an adapter fault.
    if exists (
      select 1
      from evidence_private.source_observations o
      join evidence_private.source_record_versions v on v.id = o.version_id
      where o.run_id = p_run_id and v.record_id = v_record.id
        and v.content_hash <> v_rec ->> 'content_hash')
    then
      v_rejected := v_rejected + 1;
      insert into evidence_private.ingest_errors (run_id, source_id, error_class, message, record_ref)
      values (p_run_id, v_run.source_id, 'record_rejected', 'conflicting_duplicate_in_run',
              left(v_rec ->> 'external_record_id', 200));
      continue;
    end if;

    select id into v_version_id
    from evidence_private.source_record_versions
    where record_id = v_record.id and content_hash = v_rec ->> 'content_hash';
    v_new_version := v_version_id is null;

    if v_new_version then
      insert into evidence_private.source_record_versions (
        record_id, content_hash, original_content_hash, record_kind, source_url,
        source_published_at, source_date_text, first_retrieved_at, import_run_id,
        predecessor_id, projection_version, safe_payload, omitted_fields)
      values (
        v_record.id, v_rec ->> 'content_hash', nullif(v_rec ->> 'original_content_hash', ''),
        v_rec ->> 'record_kind', v_rec ->> 'source_url',
        nullif(v_rec ->> 'source_published_at', '')::timestamptz, nullif(v_rec ->> 'source_date_text', ''),
        v_retrieved, p_run_id, v_record.current_version_id,
        coalesce((v_rec ->> 'projection_version')::integer, 1),
        v_rec -> 'safe_payload', coalesce(v_rec -> 'omitted_fields', '[]'::jsonb))
      returning id into v_version_id;
      v_inserted := v_inserted + 1;
    else
      v_unchanged := v_unchanged + 1;
    end if;

    insert into evidence_private.source_observations (version_id, run_id, observed_at)
    values (v_version_id, p_run_id, v_retrieved)
    on conflict (version_id, run_id) do nothing;
    get diagnostics v_rows = row_count;
    v_observed := v_observed + v_rows;

    if v_record.current_version_id is distinct from v_version_id then
      update evidence_private.source_records set current_version_id = v_version_id where id = v_record.id;
    end if;

    if v_record.tombstoned_at is not null then
      update evidence_private.source_records set tombstoned_at = null, tombstone_reason = null where id = v_record.id;
      insert into evidence_private.record_lifecycle_events (record_id, run_id, event, reason)
      values (v_record.id, p_run_id, 'reappeared', 'observed again at the official source');
    end if;
  end loop;

  update evidence_private.import_runs
     set records_seen = records_seen + v_seen,
         versions_inserted = versions_inserted + v_inserted,
         observations_inserted = observations_inserted + v_observed,
         unchanged = unchanged + v_unchanged,
         rejected = rejected + v_rejected
   where id = p_run_id;

  return jsonb_build_object('seen', v_seen, 'versions_inserted', v_inserted,
    'observations_inserted', v_observed, 'unchanged', v_unchanged, 'rejected', v_rejected);
end
$$;

-- Finish: tombstones, freshness, lease release ---------------------------------------------

create or replace function evidence_private.finish_run(
  p_run_id uuid, p_holder uuid, p_status text, p_complete_snapshot boolean,
  p_source_watermark text, p_error_class text, p_error_detail text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_run evidence_private.import_runs%rowtype;
  v_source evidence_private.sources%rowtype;
  v_status text := p_status;
  v_error_class text := p_error_class;
  v_live integer;
  v_absent integer;
  v_tombstoned integer := 0;
  v_changed boolean;
begin
  v_run := evidence_private.assert_run_held(p_run_id, p_holder);
  if p_status not in ('succeeded', 'partial', 'failed', 'blocked') then
    raise exception 'finish status must be succeeded, partial, failed or blocked' using errcode = 'P0001';
  end if;
  select * into v_source from evidence_private.sources where source_id = v_run.source_id;

  -- Absence means something only after a complete, successful snapshot of a snapshot-type source.
  -- A blocked, failed or partial run says nothing about whether records still exist.
  if p_status = 'succeeded' and coalesce(p_complete_snapshot, false)
     and v_source.snapshot_semantics = 'complete_snapshot' then
    select count(*) into v_live from evidence_private.source_records r
     where r.source_id = v_run.source_id and r.tombstoned_at is null;
    select count(*) into v_absent from evidence_private.source_records r
     where r.source_id = v_run.source_id and r.tombstoned_at is null
       and not exists (
         select 1 from evidence_private.source_observations o
         join evidence_private.source_record_versions v on v.id = o.version_id
         where o.run_id = p_run_id and v.record_id = r.id);

    if v_live >= 10 and v_absent * 2 > v_live then
      -- Safety valve: a snapshot that drops most records is treated as suspect, not as mass deletion.
      v_status := 'partial';
      v_error_class := 'tombstone_safety_valve';
      insert into evidence_private.ingest_errors (run_id, source_id, error_class, message)
      values (p_run_id, v_run.source_id, 'tombstone_safety_valve',
              format('%s of %s live records absent; no tombstones written, needs human check', v_absent, v_live));
    elsif v_absent > 0 then
      with gone as (
        update evidence_private.source_records r
           set tombstoned_at = now(), tombstone_reason = 'absent_from_complete_snapshot'
         where r.source_id = v_run.source_id and r.tombstoned_at is null
           and not exists (
             select 1 from evidence_private.source_observations o
             join evidence_private.source_record_versions v on v.id = o.version_id
             where o.run_id = p_run_id and v.record_id = r.id)
        returning r.id, r.external_record_id)
      , events as (
        insert into evidence_private.record_lifecycle_events (record_id, run_id, event, reason)
        select id, p_run_id, 'tombstoned', 'absent_from_complete_snapshot' from gone
        returning record_id)
      select count(*) into v_tombstoned from events;

      -- A member missing from a complete directory snapshot gets an observation-absence mark, not an end date.
      update evidence_private.parliamentary_service_terms t
         set observed_absent_at = v_run.started_at
        from evidence_private.person_source_identities i
        join evidence_private.source_records r
          on r.source_id = i.source_id and r.external_record_id = i.external_id
       where t.person_identity_id = i.id and t.observed_absent_at is null
         and r.source_id = v_run.source_id and r.tombstoned_at is not null;
    end if;
  end if;

  v_changed := v_run.versions_inserted > 0 or v_tombstoned > 0;

  update evidence_private.import_runs
     set status = v_status, finished_at = now(),
         complete_snapshot = (v_status = 'succeeded' and coalesce(p_complete_snapshot, false)),
         source_watermark = p_source_watermark, tombstoned = v_tombstoned,
         error_class = v_error_class, error_detail = nullif(evidence_private.redact_text(p_error_detail), '')
   where id = p_run_id;

  insert into evidence_private.source_freshness as f (
    source_id, last_attempt_at, last_attempt_status, last_attempt_run_id, last_success_at,
    last_success_run_id, last_change_at, latest_source_published_at, consecutive_failures, last_error_class)
  values (
    v_run.source_id, now(), v_status, p_run_id,
    case when v_status = 'succeeded' then now() end,
    case when v_status = 'succeeded' then p_run_id end,
    case when v_changed then now() end,
    (select max(v.source_published_at) from evidence_private.source_record_versions v
      join evidence_private.source_records r on r.id = v.record_id where r.source_id = v_run.source_id),
    case when v_status = 'succeeded' then 0 else 1 end, v_error_class)
  on conflict (source_id) do update set
    last_attempt_at = excluded.last_attempt_at,
    last_attempt_status = excluded.last_attempt_status,
    last_attempt_run_id = excluded.last_attempt_run_id,
    last_success_at = coalesce(excluded.last_success_at, f.last_success_at),
    last_success_run_id = coalesce(excluded.last_success_run_id, f.last_success_run_id),
    last_change_at = coalesce(excluded.last_change_at, f.last_change_at),
    latest_source_published_at = coalesce(excluded.latest_source_published_at, f.latest_source_published_at),
    consecutive_failures = case when excluded.last_attempt_status = 'succeeded' then 0 else f.consecutive_failures + 1 end,
    last_error_class = excluded.last_error_class;

  perform evidence_private.release_lease(v_run.source_id, p_holder);

  return jsonb_build_object('status', v_status, 'tombstoned', v_tombstoned, 'error_class', v_error_class);
end
$$;
