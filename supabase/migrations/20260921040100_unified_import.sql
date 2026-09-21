-- Unified import: what the three families share AFTER their own migrations.
--
--   1. typed_destination_counts: one reconciliation readout for every family. Rows of each typed domain table that the
--      store can PROVE came from one source, through the same lineage register that governs the public projections.
--   2. An explicit owner scope for statistical facts. The existing owner scope (source_fields) refuses any field whose
--      name holds "value", "total" or "amount", which is right for votes, poll figures and money, and means it cannot
--      represent an official statistic. Rather than loosen that rule, statistical facts get their own scope, with its
--      own closed field list, available to statistics sources only. It is an owner decision like the others: not a
--      review, not a publisher licence; every rights row stays pending and the tier stays link_only.
--   3. What a statistics source holds, recorded at the end of a load and shown by the sources view.
--   4. The public projections are rebuilt once, after every family.

-- 1. Typed destination tally ------------------------------------------------------------------------------------------------

create or replace function evidence_private.typed_destination_counts(p_source_id text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_scope text;
  v_object record;
  v_rows bigint;
  v_out jsonb := '{}'::jsonb;
  v_unreadable text[] := '{}';
begin
  select s.view_scope into v_scope from evidence_private.sources s where s.source_id = p_source_id;
  if not found then
    raise exception 'unknown source %', p_source_id using errcode = 'P0001';
  end if;
  for v_object in
    select l.object_name, l.lineage_sql
    from evidence_private.public_lineage l
    where l.object_schema = 'evidence_private' and l.lineage_kind = 'source'
      -- Typed domain tables only: the ledger and the operational tables have their own readout (source_reconciliation).
      and l.object_name not in (
        'sources', 'source_records', 'source_record_versions', 'source_observations', 'source_freshness', 'source_leases',
        'fetch_log', 'import_runs', 'ingest_errors', 'ingest_schedules', 'run_checkpoints', 'schedule_dispatch_log',
        'publisher_access_checks', 'publisher_terms_reviews', 'catalogue_product_map', 'record_lifecycle_events', 'release_items')
      -- The statistics writer fills the statistics tables and nothing else, and nothing else fills them: a source is
      -- looked for only where its writer can have put rows. Keeps this readout cheap beside a million observations.
      and ((v_scope = 'statistics') = (l.object_name like 'stat\_%' or l.object_name = 'geography_versions'))
    order by l.object_name
  loop
    -- Runs with the caller's own privileges (no function in these schemas runs as the table owner). A table the caller
    -- may not read is named in the answer, never silently left out.
    if not has_table_privilege(format('evidence_private.%I', v_object.object_name), 'SELECT') then
      v_unreadable := v_unreadable || v_object.object_name;
      continue;
    end if;
    execute format('select count(*) from evidence_private.%I b where (%s) = $1', v_object.object_name, v_object.lineage_sql)
      into v_rows using p_source_id;
    if v_rows > 0 then
      v_out := v_out || jsonb_build_object(v_object.object_name, v_rows);
    end if;
  end loop;
  if cardinality(v_unreadable) > 0 then
    v_out := v_out || jsonb_build_object('__not_readable_by_caller__', to_jsonb(v_unreadable));
  end if;
  return v_out;
end
$$;

revoke execute on function evidence_private.typed_destination_counts(text) from public;
grant execute on function evidence_private.typed_destination_counts(text) to evidence_ingest;

-- The tally runs as the worker, so the worker reads the lineage register (which holds no source data) and the lineage
-- views (record, version, document -> source: facts about rows the worker itself wrote). Nothing else is widened.
grant select on evidence_private.public_lineage to evidence_ingest;
create policy public_lineage_ingest_select on evidence_private.public_lineage for select to evidence_ingest using (true);
grant select on evidence_private.lineage_record, evidence_private.lineage_version, evidence_private.lineage_run, evidence_private.lineage_document,
  evidence_private.lineage_result_set, evidence_private.lineage_party_list, evidence_private.lineage_stat_series to evidence_ingest;
comment on function evidence_private.typed_destination_counts(text) is
  'Counts only: rows of each typed domain table whose recorded lineage resolves to this source. Used by every family''s reconcile.';

-- 2. Owner scope for statistical facts ---------------------------------------------------------------------------------------

alter table evidence_private.owner_authorization_scopes drop constraint owner_authorization_scopes_scope_kind_check;
alter table evidence_private.owner_authorization_scopes add constraint owner_authorization_scopes_scope_kind_check
  check (scope_kind in ('pages_deploy', 'public_rows', 'source_fields', 'statistical_facts'));

alter table evidence_private.owner_authorization_scopes drop constraint owner_scope_shape;
alter table evidence_private.owner_authorization_scopes add constraint owner_scope_shape check (
  (scope_kind = 'pages_deploy' and surface_id = 'explorer-pages' and source_id is null and rights_id is null and field_token is null)
  or (scope_kind = 'public_rows' and surface_id = 'evidence-store' and source_id is null and rights_id is null and field_token is null)
  or (scope_kind in ('source_fields', 'statistical_facts') and surface_id is null and source_id is not null and rights_id is not null
      and field_token is not null and basis is not null and length(btrim(basis)) >= 40));

-- The forbidden-name rule is unchanged and still binds every source_fields row: figures, bodies, contact data and
-- publisher identifiers can never be released through it. Kept equal to FORBIDDEN_FIELD in tools/owner_authorization.ts.
alter table evidence_private.owner_authorization_scopes drop constraint owner_field_scope_forbidden;
alter table evidence_private.owner_authorization_scopes add constraint owner_field_scope_forbidden
  check (scope_kind is distinct from 'source_fields' or field_token !~ '(email|e_mail|phone|mobile|fax|address|postal|contact|twitter|facebook|instagram|linkedin|handle|body|content|html|text|passage|description|summary|excerpt|transcript|portrait|image|photo|donor|birth|gender|ethnic|vote|share|rank|seats|score|confidence|value|pct|percent|total|amount|sample|payload|external_id|external_record_id|publisher_item_id)');

-- A statistical fact is exactly one of these four columns of an observation: the number as stored, the number where it
-- cannot be held exactly, the cell as the publisher printed it, and the status that says whether there is a number at
-- all. A closed list, not a pattern. Kept equal to STATISTICAL_FACT_FIELDS in tools/owner_authorization.ts (tested).
alter table evidence_private.owner_authorization_scopes add constraint owner_statistical_fact_tokens
  check (scope_kind is distinct from 'statistical_facts' or field_token in ('value', 'value_double', 'raw_value', 'value_status'));

drop index evidence_private.owner_scope_surface;
drop index evidence_private.owner_scope_field;
create unique index owner_scope_surface on evidence_private.owner_authorization_scopes (authorization_id, scope_kind)
  where scope_kind in ('pages_deploy', 'public_rows');
create unique index owner_scope_field on evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, field_token)
  where scope_kind in ('source_fields', 'statistical_facts');

comment on table evidence_private.owner_authorization_scopes is
  'What one owner decision covers: the Pages deployment, release of anonymous rows, named descriptive fields of ONE source, or the statistical-fact columns of ONE statistics source, always beside that source''s still-pending rights row. No wildcards.';

create or replace function evidence_private.owner_scope_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_rights text;
  v_status text;
  v_release text;
  v_view_scope text;
  v_registry_key text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'owner authorization scopes are append-only; revoke the authorization and record a new one' using errcode = 'P0001';
  end if;
  if new.scope_kind in ('source_fields', 'statistical_facts') then
    select s.rights_id, r.review_status, r.default_release, s.view_scope, s.registry_key
      into v_rights, v_status, v_release, v_view_scope, v_registry_key
    from evidence_private.sources s left join evidence_private.source_rights r on r.rights_id = s.rights_id
    where s.source_id = new.source_id;
    if v_rights is distinct from new.rights_id then
      raise exception 'owner field decision for % names rights row %, but the source is governed by %', new.source_id, new.rights_id, coalesce(v_rights, 'no rights row')
        using errcode = 'P0001';
    end if;
    if v_status in ('refused', 'restricted') or v_release = 'withheld' then
      raise exception 'rights row % is %/%: an owner decision cannot publish against a recorded publisher restriction', new.rights_id, v_status, v_release
        using errcode = 'P0001';
    end if;
    -- A number is released as a statistical fact only for a source registered as official statistics. Votes, poll
    -- figures, seats and money belong to other sources and stay outside every owner scope.
    if new.scope_kind = 'statistical_facts' and (v_view_scope is distinct from 'statistics' or v_registry_key is distinct from 'statistics') then
      raise exception 'source % is not a statistics source: statistical facts can be released for official statistics only', new.source_id
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;

-- Release tier: computed from the rights row EXACTLY as before. owner_fields now also lists the statistical-fact
-- columns of a current statistical_facts decision; it never changes the tier and is empty when the tier is none.
create or replace view evidence_private.source_release as
select s.source_id,
       case
         when r.rights_id is null then 'none'
         when r.review_status in ('refused', 'restricted') then 'none'
         when r.default_release = 'withheld' then 'none'
         when r.review_status = 'approved' and r.default_release = 'approved-fields' then 'fields'
         else 'link_only'
       end as tier,
       case when r.review_status = 'approved' and r.default_release = 'approved-fields' then r.approved_fields else '{}'::text[] end as approved_fields,
       case
         when r.rights_id is null or r.review_status in ('refused', 'restricted') or r.default_release = 'withheld' then '{}'::text[]
         else coalesce((select array_agg(distinct f.field_token order by f.field_token)
                        from evidence_private.owner_authorization_scopes f
                        join evidence_private.owner_authorizations o on o.authorization_id = f.authorization_id
                        where f.scope_kind in ('source_fields', 'statistical_facts') and f.source_id = s.source_id and f.rights_id = r.rights_id
                          -- Checked again every time it is read, not only when the decision was recorded: a source that
                          -- is no longer registered as official statistics loses its statistical-fact columns at once.
                          and (f.scope_kind <> 'statistical_facts' or (s.view_scope = 'statistics' and s.registry_key = 'statistics'))
                          and o.revoked_at is null and (now() at time zone 'utc')::date between o.decided_on and o.expires_on), '{}'::text[])
       end as owner_fields
from evidence_private.sources s
left join evidence_private.source_rights r on r.rights_id = s.rights_id;

comment on view evidence_private.source_release is
  'none | link_only | fields per source, from its rights row only. owner_fields lists the field names a current owner decision shows for that source (descriptive fields, and for a statistics source its statistical-fact columns); it never changes the tier and is empty when the tier is none.';

-- The mirror of governance/owner-authorizations.json, unchanged except that it also records statistical_facts scopes.
create or replace function evidence_private.sync_owner_authorizations(p_doc jsonb, p_file_hash text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_a jsonb;
  v_s jsonb;
  v_f text;
  v_id text;
  v_hash text;
  v_new integer := 0;
  v_revoked integer := 0;
  v_unchanged integer := 0;
begin
  if p_doc ->> 'schema_version' is distinct from '1' or jsonb_typeof(p_doc -> 'authorizations') is distinct from 'array' then
    raise exception 'not an owner authorization file (schema_version 1)' using errcode = 'P0001';
  end if;
  -- The file is the whole truth. A decision that is in force here but missing from the file is never left running
  -- silently, and never silently revoked by what may be the wrong file: the operator must mark it revoked.
  select o.authorization_id into v_id from evidence_private.owner_authorizations o
   where o.revoked_at is null
     and not exists (select 1 from jsonb_array_elements(p_doc -> 'authorizations') e where e ->> 'authorization_id' = o.authorization_id)
   limit 1;
  if v_id is not null then
    raise exception 'authorization % is in force in the database but absent from the file; mark it revoked in the file instead of deleting it', v_id
      using errcode = 'P0001';
  end if;
  for v_a in select * from jsonb_array_elements(p_doc -> 'authorizations') loop
    v_id := v_a ->> 'authorization_id';
    if v_a ->> 'status' is null or v_a ->> 'status' not in ('active', 'revoked') then
      raise exception 'authorization % has no valid status', coalesce(v_id, '(no id)') using errcode = 'P0001';
    end if;
    v_hash := 'md5:' || md5((v_a - 'status' - 'revoked_on' - 'revoked_reason')::text);
    if exists (select 1 from evidence_private.owner_authorizations o where o.authorization_id = v_id) then
      if exists (select 1 from evidence_private.owner_authorizations o where o.authorization_id = v_id and o.entry_hash <> v_hash) then
        raise exception 'authorization % differs from what was recorded; a decision is never edited. Revoke it and record a new id', v_id
          using errcode = 'P0001';
      end if;
      if v_a ->> 'status' = 'revoked' and exists (select 1 from evidence_private.owner_authorizations o where o.authorization_id = v_id and o.revoked_at is null) then
        update evidence_private.owner_authorizations set revoked_at = now(), revoked_reason = v_a ->> 'revoked_reason' where authorization_id = v_id;
        v_revoked := v_revoked + 1;
      else
        v_unchanged := v_unchanged + 1;
      end if;
      continue;
    end if;
    if v_a ->> 'status' = 'revoked' then
      v_unchanged := v_unchanged + 1;  -- a decision revoked before it was ever mirrored is simply never recorded
      continue;
    end if;
    if jsonb_typeof(v_a -> 'scopes') is distinct from 'array' or jsonb_array_length(v_a -> 'scopes') = 0 then
      raise exception 'authorization % names no scope', v_id using errcode = 'P0001';
    end if;
    insert into evidence_private.owner_authorizations (
      authorization_id, decided_on, expires_on, decided_by, decided_by_role, request_source, statement, not_claimed, file_hash, entry_hash)
    values (v_id, (v_a ->> 'decided_on')::date, (v_a ->> 'expires_on')::date, v_a ->> 'decided_by', v_a ->> 'decided_by_role',
            v_a ->> 'request_source', v_a ->> 'statement',
            array(select jsonb_array_elements_text(v_a -> 'not_claimed')), p_file_hash, v_hash);
    for v_s in select * from jsonb_array_elements(v_a -> 'scopes') loop
      if v_s ->> 'scope' in ('source_fields', 'statistical_facts') then
        if jsonb_typeof(v_s -> 'fields') is distinct from 'array' or jsonb_array_length(v_s -> 'fields') = 0 then
          raise exception 'field decision for % names no fields', v_s ->> 'source_id' using errcode = 'P0001';
        end if;
        for v_f in select jsonb_array_elements_text(v_s -> 'fields') loop
          insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, rights_id, field_token, basis)
          values (v_id, v_s ->> 'scope', v_s ->> 'source_id', v_s ->> 'rights_id', v_f, v_s ->> 'basis');
        end loop;
      else
        insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, surface_id)
        values (v_id, v_s ->> 'scope', v_s ->> 'surface_id');
      end if;
    end loop;
    v_new := v_new + 1;
  end loop;
  return jsonb_build_object('recorded', v_new, 'revoked', v_revoked, 'unchanged', v_unchanged);
end
$$;
revoke execute on function evidence_private.sync_owner_authorizations(jsonb, text) from public;

-- 3. What a statistics source holds, for the sources view --------------------------------------------------------------------
-- The sources view counts ledger records. A statistics source writes typed observations instead, so it would read
-- "0 records" beside a million observations. Counting observations per request is too slow for a page that lists every
-- source, so the statistics loader records the counts when a load finishes, under the lease of that run.

create table evidence_private.stat_source_summary (
  source_id text primary key references evidence_private.sources (source_id),
  datasets integer not null check (datasets >= 0),
  releases integer not null check (releases >= 0),
  series integer not null check (series >= 0),
  observations bigint not null check (observations >= 0),
  -- Observations whose status says the publisher printed no number (suppressed, confidential, missing, ...). Never zeros.
  observations_without_a_number bigint not null check (observations_without_a_number >= 0 and observations_without_a_number <= observations),
  catalogue_entries integer not null check (catalogue_entries >= 0),
  import_run_id uuid not null references evidence_private.import_runs (id),
  counted_at timestamptz not null default now()
);
comment on table evidence_private.stat_source_summary is
  'Counts of what one statistics source holds, recorded by the loader at the end of a load. Counts only; surfaced through the sources view.';

create or replace function evidence_private.record_stat_source_summary(p_run_id uuid, p_holder uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_source text;
  v_counts jsonb;
  v_without bigint;
begin
  perform evidence_private.assert_run_held(p_run_id, p_holder);
  select r.source_id into v_source from evidence_private.import_runs r where r.id = p_run_id;
  v_counts := evidence_private.stat_source_counts(v_source);
  select coalesce(sum((e.value)::bigint), 0) into v_without
  from jsonb_each_text(v_counts -> 'observations_by_status') e
  where e.key not in ('reported', 'provisional');
  insert into evidence_private.stat_source_summary as t (source_id, datasets, releases, series, observations, observations_without_a_number, catalogue_entries, import_run_id, counted_at)
  values (v_source, (v_counts ->> 'datasets')::integer, (v_counts ->> 'releases')::integer, (v_counts ->> 'series')::integer, (v_counts ->> 'observations')::bigint,
          v_without, (v_counts ->> 'catalogue_entries_current')::integer, p_run_id, now())
  on conflict (source_id) do update set datasets = excluded.datasets, releases = excluded.releases, series = excluded.series, observations = excluded.observations,
    observations_without_a_number = excluded.observations_without_a_number, catalogue_entries = excluded.catalogue_entries, import_run_id = excluded.import_run_id, counted_at = excluded.counted_at;
  return v_counts;
end
$$;
revoke execute on function evidence_private.record_stat_source_summary(uuid, uuid) from public;
grant execute on function evidence_private.record_stat_source_summary(uuid, uuid) to evidence_ingest;

alter table evidence_private.stat_source_summary enable row level security;
revoke all on evidence_private.stat_source_summary from public, anon, authenticated;
grant select, insert on evidence_private.stat_source_summary to evidence_ingest;
grant update (datasets, releases, series, observations, observations_without_a_number, catalogue_entries, import_run_id, counted_at)
  on evidence_private.stat_source_summary to evidence_ingest;
create policy stat_source_summary_ingest_select on evidence_private.stat_source_summary for select to evidence_ingest using (true);
create policy stat_source_summary_ingest_insert on evidence_private.stat_source_summary for insert to evidence_ingest with check (true);
create policy stat_source_summary_ingest_update on evidence_private.stat_source_summary for update to evidence_ingest using (true) with check (true);

-- The worker holds table privileges (the function above runs with them), so the table itself refuses a summary that is
-- not true: it must be written inside a running, leased run of its own statistics source, and every count must equal
-- what the tables hold at that moment. Binds every role and every path.
create or replace function evidence_private.guard_stat_source_summary()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  if tg_op = 'UPDATE' and new.source_id <> old.source_id then
    raise exception 'a source summary never moves to another source' using errcode = 'P0001';
  end if;
  if not evidence_private.stat_source_open(new.source_id, new.import_run_id) then
    raise exception 'the summary of source % may be written only inside a running run that holds the lease of that statistics source', new.source_id using errcode = 'P0001';
  end if;
  select new.datasets = (select count(*) from evidence_private.stat_datasets d where d.source_id = new.source_id)
     and new.releases = (select count(*) from evidence_private.stat_releases r join evidence_private.stat_datasets d on d.id = r.dataset_id where d.source_id = new.source_id)
     and new.series = (select count(*) from evidence_private.stat_series s join evidence_private.stat_datasets d on d.id = s.dataset_id where d.source_id = new.source_id)
     and new.catalogue_entries = (select count(*) from evidence_private.stat_catalogue_entries e where e.source_id = new.source_id and e.is_current)
     and (new.observations, new.observations_without_a_number) = (
       select count(*), count(*) filter (where o.value_status not in ('reported', 'provisional'))
       from evidence_private.stat_observations o join evidence_private.stat_series s on s.id = o.series_id
       join evidence_private.stat_datasets d on d.id = s.dataset_id where d.source_id = new.source_id)
    into v_ok;
  if not v_ok then
    raise exception 'the summary of source % does not equal what the statistics tables hold; refused', new.source_id using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke execute on function evidence_private.guard_stat_source_summary() from public;
create trigger stat_source_summary_guard before insert or update on evidence_private.stat_source_summary
  for each row execute function evidence_private.guard_stat_source_summary();
grant select on evidence_private.stat_source_summary to evidence_inspector_reader;
create policy stat_source_summary_reader_select on evidence_private.stat_source_summary for select to evidence_inspector_reader using (true);

insert into evidence_private.public_lineage (object_schema, object_name, lineage_kind, lineage_sql, note) values
  ('evidence_private', 'stat_source_summary', 'source', 'b.source_id', 'Every row names exactly one source; rows of a source whose rights do not allow release are not shown.');

-- Appended to the sources view (every column of that view is link metadata: counts and states, never content).
create or replace view evidence_views.sources as
select s.source_id, s.title, s.publisher, s.official_url, s.adapter_kind, s.adapter_name, s.allowed_hosts,
       s.view_scope, s.snapshot_semantics, s.expected_cadence_seconds, s.enabled, s.blocked_reason,
       s.registry_key, s.rights_id, coalesce(sr.review_status, 'no rights row') as rights_review_status,
       coalesce(sr.default_release, 'withheld') as rights_default_release,
       rel.tier as public_release_tier, rel.approved_fields as public_approved_fields,
       f.last_attempt_at, f.last_attempt_status, f.last_success_at, f.last_change_at,
       f.latest_source_published_at, f.consecutive_failures, f.last_error_class,
       case
         when f.last_attempt_at is null then 'never_run'
         when f.last_error_class = 'parser_not_enabled' then 'reachable_not_parsed'
         when f.last_attempt_status in ('blocked', 'failed') then 'unavailable'
         when f.last_success_at is null then 'unavailable'
         when s.expected_cadence_seconds is not null
              and f.last_success_at < now() - make_interval(secs => 2 * s.expected_cadence_seconds) then 'stale'
         when f.last_attempt_status = 'partial' then 'partial'
         else 'fresh'
       end as freshness_status,
       (select count(*) from evidence_private.source_records r where r.source_id = s.source_id and r.tombstoned_at is null) as live_records,
       (select count(*) from evidence_private.source_records r where r.source_id = s.source_id and r.tombstoned_at is not null) as tombstoned_records,
       (select count(*) from evidence_private.source_record_versions v join evidence_private.source_records r on r.id = v.record_id
         where r.source_id = s.source_id) as content_versions,
       (select coalesce(array_agg(m.product_id order by m.product_id), '{}') from evidence_private.catalogue_product_map m
         where m.source_id = s.source_id) as catalogue_product_ids,
       rel.owner_fields as owner_authorized_fields,
       t.observations as statistical_observations, t.observations_without_a_number as statistical_observations_without_a_number,
       t.series as statistical_series, t.catalogue_entries as statistical_catalogue_entries, t.counted_at as statistics_counted_at
from evidence_private.sources s
left join evidence_private.source_rights sr on sr.rights_id = s.rights_id
left join evidence_private.source_freshness f on f.source_id = s.source_id
join evidence_private.source_release rel on rel.source_id = s.source_id
left join evidence_private.stat_source_summary t on t.source_id = s.source_id;

-- 4. Rebuild the public projections once, after every family ------------------------------------------------------------------

select evidence_private.classify_public_columns();
select evidence_private.rebuild_exposed_views();
