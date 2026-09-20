-- Statistics import family (P11, P12, P18, P19, P20, P21, P22, P23).
--
-- 1. Provenance columns the typed loader needs: release vintage and file hash, collected-at kept apart from any
--    publisher date, the publisher's own status flag and symbol beside every value, quality qualifiers.
-- 2. stat_catalogue_entries: catalogue and listing metadata, versioned by content. A catalogue entry never
--    asserts a fact; the table cannot hold one that does.
-- 3. Two ingestion functions for the scoped worker. SECURITY INVOKER like the rest of the ingestion API: the
--    worker's own grants bound them. They are set-based, idempotent, and they refuse instead of overwriting.
-- 4. Default-deny projection registers for the new table and columns.
--
-- Additive only: no existing column, constraint or row changes meaning.

-- 1. Provenance -------------------------------------------------------------------------------------------

alter table evidence_private.stat_datasets
  add column official_url text check (official_url is null or evidence_private.url_violation(official_url) is null),
  add column route text check (route in ('dedicated_census', 'dedicated_series', 'operational')),
  add column historical boolean not null default false,
  add column coverage_note text check (coverage_note is null or length(coverage_note) <= 1000);

comment on column evidence_private.stat_datasets.historical is
  'True for an edition the publisher has since superseded (an earlier census, a closed release). Shown as history, never as current.';

alter table evidence_private.stat_releases
  add column vintage_label text,
  add column released_on_basis text not null default 'not_stated'
    check (released_on_basis in ('publisher_stated_date', 'publisher_label_only', 'not_stated')),
  add column source_url text check (source_url is null or evidence_private.url_violation(source_url) is null),
  add column source_file_sha256 text check (source_file_sha256 is null or source_file_sha256 ~ '^[0-9a-f]{64}$'),
  add column source_bytes bigint check (source_bytes is null or source_bytes > 0),
  add column retrieved_at timestamptz,
  add column publisher_last_modified text check (publisher_last_modified is null or length(publisher_last_modified) <= 100),
  add column boundary_edition text,
  add column capture_count integer not null default 1 check (capture_count >= 1),
  add column import_run_id uuid references evidence_private.import_runs (id),
  -- A release date exists only where the publisher states one. The time a file was collected is never a release date.
  add constraint stat_releases_released_on_needs_basis
    check ((released_on is not null) = (released_on_basis = 'publisher_stated_date'));

comment on column evidence_private.stat_releases.retrieved_at is
  'When this project collected the file (earliest capture of this exact file). Never the date the publisher released or updated it.';
comment on column evidence_private.stat_releases.released_on is
  'Release date as stated by the publisher. Null when the publisher gives only a label (see vintage_label) or nothing.';
comment on column evidence_private.stat_releases.capture_count is
  'How many collections held this byte-identical file. Collections are history of collecting, not versions of the statistics.';

alter table evidence_private.stat_series
  add column frequency text;

alter table evidence_private.geography_versions
  add column source_id text references evidence_private.sources (source_id),
  add column code_basis text check (code_basis in ('publisher_code', 'publisher_name_only'));

comment on column evidence_private.geography_versions.source_id is
  'The source whose file printed this code. Schemes are source-scoped: the same place in two publishers'' files is two rows until a dated crosswalk says otherwise.';
comment on column evidence_private.geography_versions.code_basis is
  'publisher_name_only: the file prints a name and no code, so the name is the code. Never joined to another scheme by name.';

alter table evidence_private.stat_observations
  add column source_status text check (source_status is null or length(source_status) <= 60),
  add column source_symbol text check (source_symbol is null or length(source_symbol) <= 60),
  add column upstream_status text check (upstream_status is null or length(upstream_status) <= 60),
  add column qualifiers jsonb not null default '{}'::jsonb check (jsonb_typeof(qualifiers) = 'object');

alter table evidence_private.stat_observations drop constraint stat_observations_value_status_check;
alter table evidence_private.stat_observations add constraint stat_observations_value_status_check
  check (value_status in ('reported', 'provisional', 'suppressed', 'confidential', 'missing', 'not_applicable', 'flag_marker'));

comment on column evidence_private.stat_observations.value_status is
  'reported/provisional carry a number. suppressed, confidential, missing, not_applicable and flag_marker (the publisher printed a marker symbol in a flag column) carry none. None of them is ever zero.';
comment on column evidence_private.stat_observations.source_status is 'The publisher''s status flag, verbatim (FINAL, REVISED, P, C ...).';
comment on column evidence_private.stat_observations.source_symbol is 'The symbol the publisher printed in place of a number, verbatim.';
comment on column evidence_private.stat_observations.qualifiers is
  'Quality measures the publisher prints beside the value (standard error, confidence bounds, flags), verbatim text.';

create index stat_observations_release on evidence_private.stat_observations (release_id);

-- 2. Catalogue entries ------------------------------------------------------------------------------------

create table evidence_private.stat_catalogue_entries (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references evidence_private.sources (source_id),
  entry_key text not null check (length(entry_key) between 1 and 400),
  entry_kind text not null check (entry_kind in ('catalogue_link', 'file_metadata', 'dataset_metadata', 'product_metadata')),
  title text not null check (length(title) between 1 and 1000),
  url text not null check (evidence_private.url_violation(url) is null),
  found_on_url text not null check (evidence_private.url_violation(found_on_url) is null),
  format text check (format is null or format ~ '^[a-z0-9]{1,40}$'),
  file_sha256 text check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),
  publisher_modified_text text check (publisher_modified_text is null or length(publisher_modified_text) <= 100),
  attributes jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object' and length(attributes::text) <= 20000),
  -- A listing says a file exists. It says nothing about what the file holds.
  facts_asserted boolean not null default false check (facts_asserted = false),
  observed_first_at timestamptz not null,
  observed_last_at timestamptz not null check (observed_last_at >= observed_first_at),
  observation_count integer not null check (observation_count >= 1),
  is_current boolean not null default true,
  content_hash text not null check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  import_run_id uuid not null references evidence_private.import_runs (id),
  unique (source_id, entry_key, content_hash)
);

create unique index stat_catalogue_entries_one_current on evidence_private.stat_catalogue_entries (source_id, entry_key) where is_current;

comment on table evidence_private.stat_catalogue_entries is
  'Catalogue and listing metadata of statistical publishers: links, file listings, dataset and product records. Versioned by content. Catalogue only: an entry is never an observation and asserts no fact.';
comment on column evidence_private.stat_catalogue_entries.file_sha256 is
  'Hash of the listed file, only where the collection fetched that file. The hash of a listing page is never stored here.';
comment on column evidence_private.stat_catalogue_entries.publisher_modified_text is
  'The publisher''s own modified or page date, verbatim. Null when the publisher states none; never filled from collection times.';
comment on column evidence_private.stat_catalogue_entries.observed_last_at is 'Last collection that saw this exact content. A collection time, not a publisher date.';

alter table evidence_private.stat_catalogue_entries enable row level security;
revoke all on evidence_private.stat_catalogue_entries from public, anon, authenticated;

-- 3. Worker grants and ingestion functions ----------------------------------------------------------------

do $$
declare
  v_name text;
begin
  foreach v_name in array array['stat_datasets', 'stat_releases', 'stat_series', 'geography_versions', 'stat_route_reconciliation', 'stat_catalogue_entries']
  loop
    execute format('grant select, insert, update on evidence_private.%I to evidence_ingest', v_name);
    execute format('create policy %I on evidence_private.%I for all to evidence_ingest using (true) with check (true)', v_name || '_ingest_all', v_name);
  end loop;
end
$$;

-- Observations are append-only for the worker: a published number is never edited in place.
grant select, insert on evidence_private.stat_observations to evidence_ingest;
create policy stat_observations_ingest_select on evidence_private.stat_observations for select to evidence_ingest using (true);
create policy stat_observations_ingest_insert on evidence_private.stat_observations for insert to evidence_ingest with check (true);

grant select on evidence_private.stat_catalogue_entries to evidence_inspector_reader;
create policy stat_catalogue_entries_reader_select on evidence_private.stat_catalogue_entries for select to evidence_inspector_reader using (true);

-- Routes, datasets, releases, series, geographies and catalogue entries of ONE source, inside a held run.
create or replace function evidence_private.ingest_stat_meta(p_run_id uuid, p_holder uuid, p_meta jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_run evidence_private.import_runs%rowtype;
  v_bad text;
  v_routes integer := 0;
  v_datasets integer := 0;
  v_releases integer := 0;
  v_series integer := 0;
  v_geographies integer := 0;
  v_entries integer := 0;
  v_entries_seen integer := 0;
begin
  v_run := evidence_private.assert_run_held(p_run_id, p_holder);
  if jsonb_typeof(p_meta) <> 'object' then
    raise exception 'statistics meta batch must be an object' using errcode = 'P0001';
  end if;

  if exists (select 1 from jsonb_each(p_meta) section where jsonb_typeof(section.value) <> 'array'
                or section.key not in ('routes', 'datasets', 'releases', 'series', 'geographies', 'catalogue_entries')) then
    raise exception 'statistics meta batch holds a section that is not part of the contract' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_each(p_meta) section, jsonb_array_elements(section.value) e where jsonb_typeof(e) <> 'object') then
    raise exception 'statistics meta batch holds a row that is not an object' using errcode = 'P0001';
  end if;

  -- Defence in depth behind the typed contract: every string is checked, and a row of another source is refused.
  select min(t.why) into v_bad from (
    select 'row of another source' as why
      from jsonb_array_elements(coalesce(p_meta -> 'datasets', '[]'::jsonb) || coalesce(p_meta -> 'geographies', '[]'::jsonb)
                                || coalesce(p_meta -> 'catalogue_entries', '[]'::jsonb)) e
     where e ->> 'source_id' is distinct from v_run.source_id
    union all
    select 'text that is never stored: ' || evidence_private.text_violation(s.value)
      from jsonb_each(p_meta) section, jsonb_array_elements(section.value) e, jsonb_each_text(e) s
     where evidence_private.text_violation(s.value) is not null
  ) t;
  if v_bad is not null then
    raise exception 'statistics meta batch refused: %', v_bad using errcode = 'P0001';
  end if;

  -- A route decision is made once. A later batch that names another route for the same family is refused.
  select min(r.observation_family) into v_bad
  from jsonb_to_recordset(coalesce(p_meta -> 'routes', '[]'::jsonb)) as i(observation_family text, canonical_route text)
  join evidence_private.stat_route_reconciliation r on r.observation_family = i.observation_family
  where r.canonical_route <> i.canonical_route;
  if v_bad is not null then
    raise exception 'observation family % already has a different canonical route; routes are never switched by an import', v_bad using errcode = 'P0001';
  end if;
  insert into evidence_private.stat_route_reconciliation (observation_family, canonical_route, overlapping_routes, upstream_rows_by_route, decision_note, decided_by)
  select i.observation_family, i.canonical_route,
         coalesce((select array_agg(x) from jsonb_array_elements_text(i.overlapping_routes) x), '{}'),
         i.upstream_rows_by_route, i.decision_note, 'statistics import contract (route table in the repository)'
  from jsonb_to_recordset(coalesce(p_meta -> 'routes', '[]'::jsonb))
       as i(observation_family text, canonical_route text, overlapping_routes jsonb, upstream_rows_by_route jsonb, decision_note text)
  on conflict (observation_family) do update
    set overlapping_routes = excluded.overlapping_routes, upstream_rows_by_route = excluded.upstream_rows_by_route,
        decision_note = excluded.decision_note;
  get diagnostics v_routes = row_count;

  insert into evidence_private.stat_datasets (source_id, dataset_key, title, publisher, official_url, route, historical, coverage_note)
  select v_run.source_id, i.dataset_key, i.title, i.publisher, i.official_url, i.route, i.historical, i.coverage_note
  from jsonb_to_recordset(coalesce(p_meta -> 'datasets', '[]'::jsonb))
       as i(dataset_key text, title text, publisher text, official_url text, route text, historical boolean, coverage_note text)
  on conflict (source_id, dataset_key) do update
    set title = excluded.title, publisher = excluded.publisher, official_url = excluded.official_url, route = excluded.route,
        historical = excluded.historical, coverage_note = excluded.coverage_note;
  get diagnostics v_datasets = row_count;

  -- A release key names one file. The same key arriving with another file hash is a different vintage and is refused.
  select min(i.release_key) into v_bad
  from jsonb_to_recordset(coalesce(p_meta -> 'releases', '[]'::jsonb)) as i(dataset_key text, release_key text, source_file_sha256 text)
  join evidence_private.stat_datasets d on d.source_id = v_run.source_id and d.dataset_key = i.dataset_key
  join evidence_private.stat_releases r on r.dataset_id = d.id and r.release_key = i.release_key
  where r.source_file_sha256 is distinct from i.source_file_sha256 and r.import_run_id is not null;
  if v_bad is not null then
    raise exception 'release % is already recorded for a different file; a new file is a new release vintage', v_bad using errcode = 'P0001';
  end if;
  insert into evidence_private.stat_releases (dataset_id, release_key, released_on, released_on_basis, vintage_label, source_url,
    source_file_sha256, source_bytes, retrieved_at, publisher_last_modified, boundary_edition, capture_count, import_run_id)
  select d.id, i.release_key, i.released_on, i.released_on_basis, i.vintage_label, i.source_url, i.source_file_sha256, i.source_bytes,
         i.retrieved_at, i.publisher_last_modified, i.boundary_edition, i.capture_count, p_run_id
  from jsonb_to_recordset(coalesce(p_meta -> 'releases', '[]'::jsonb))
       as i(dataset_key text, release_key text, released_on date, released_on_basis text, vintage_label text, source_url text,
            source_file_sha256 text, source_bytes bigint, retrieved_at timestamptz, publisher_last_modified text, boundary_edition text, capture_count integer)
  join evidence_private.stat_datasets d on d.source_id = v_run.source_id and d.dataset_key = i.dataset_key
  on conflict (dataset_id, release_key) do update
    -- The earliest collection of the file is kept; a later look at the same file only raises the capture count.
    set retrieved_at = least(evidence_private.stat_releases.retrieved_at, excluded.retrieved_at),
        capture_count = greatest(evidence_private.stat_releases.capture_count, excluded.capture_count);
  get diagnostics v_releases = row_count;

  -- One series key, one definition. A unit that changes under the same key is refused, never overwritten. Letter case
  -- is not a change of unit ("Dollars" in a publisher file, "dollars" in an earlier normalised load): the stored
  -- definition is kept as it is.
  select min(i.series_key) into v_bad
  from jsonb_to_recordset(coalesce(p_meta -> 'series', '[]'::jsonb)) as i(dataset_key text, series_key text, unit text, magnitude text)
  join evidence_private.stat_datasets d on d.source_id = v_run.source_id and d.dataset_key = i.dataset_key
  join evidence_private.stat_series s on s.dataset_id = d.id and s.series_key = i.series_key
  where lower(s.unit) is distinct from lower(i.unit) or s.magnitude is distinct from i.magnitude;
  if v_bad is not null then
    raise exception 'series % is already defined with a different unit or magnitude; refused, not overwritten', left(v_bad, 80) using errcode = 'P0001';
  end if;
  insert into evidence_private.stat_series (dataset_id, series_key, title, unit, magnitude, seasonal_adjustment, frequency, dimensions)
  select d.id, i.series_key, i.title, i.unit, i.magnitude, i.seasonal_adjustment, i.frequency, coalesce(i.dimensions, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_meta -> 'series', '[]'::jsonb))
       as i(dataset_key text, series_key text, title text, unit text, magnitude text, seasonal_adjustment text, frequency text, dimensions jsonb)
  join evidence_private.stat_datasets d on d.source_id = v_run.source_id and d.dataset_key = i.dataset_key
  on conflict (dataset_id, series_key) do nothing;
  get diagnostics v_series = row_count;

  select min(i.code) into v_bad
  from jsonb_to_recordset(coalesce(p_meta -> 'geographies', '[]'::jsonb)) as i(scheme text, edition text, code text)
  join evidence_private.geography_versions g on g.scheme = i.scheme and g.edition = i.edition and g.code = i.code
  where g.source_id is distinct from v_run.source_id;
  if v_bad is not null then
    raise exception 'geography code % belongs to another source''s scheme; schemes are source-scoped', left(v_bad, 80) using errcode = 'P0001';
  end if;
  insert into evidence_private.geography_versions (scheme, edition, code, name, source_id, code_basis)
  select i.scheme, i.edition, i.code, i.name, v_run.source_id, i.code_basis
  from jsonb_to_recordset(coalesce(p_meta -> 'geographies', '[]'::jsonb)) as i(scheme text, edition text, code text, name text, code_basis text)
  on conflict (scheme, edition, code) do nothing;
  get diagnostics v_geographies = row_count;

  -- Catalogue entries: a new content hash is a new version; an old one only widens its observation span.
  select count(*) into v_entries_seen from jsonb_array_elements(coalesce(p_meta -> 'catalogue_entries', '[]'::jsonb));
  if v_entries_seen > 0 then
    insert into evidence_private.stat_catalogue_entries (source_id, entry_key, entry_kind, title, url, found_on_url, format, file_sha256,
      publisher_modified_text, attributes, observed_first_at, observed_last_at, observation_count, is_current, content_hash, import_run_id)
    select v_run.source_id, i.entry_key, i.entry_kind, i.title, i.url, i.found_on_url, i.format, i.file_sha256, i.publisher_modified_text,
           coalesce(i.attributes, '{}'::jsonb), i.observed_first_at, i.observed_last_at, i.observation_count, false, i.content_hash, p_run_id
    from jsonb_to_recordset(p_meta -> 'catalogue_entries')
         as i(entry_key text, entry_kind text, title text, url text, found_on_url text, format text, file_sha256 text, publisher_modified_text text,
              attributes jsonb, observed_first_at timestamptz, observed_last_at timestamptz, observation_count integer, content_hash text)
    on conflict (source_id, entry_key, content_hash) do update
      set observed_first_at = least(evidence_private.stat_catalogue_entries.observed_first_at, excluded.observed_first_at),
          observed_last_at = greatest(evidence_private.stat_catalogue_entries.observed_last_at, excluded.observed_last_at),
          observation_count = greatest(evidence_private.stat_catalogue_entries.observation_count, excluded.observation_count)
      where evidence_private.stat_catalogue_entries.observed_first_at > excluded.observed_first_at
         or evidence_private.stat_catalogue_entries.observed_last_at < excluded.observed_last_at
         or evidence_private.stat_catalogue_entries.observation_count < excluded.observation_count;
    get diagnostics v_entries = row_count;

    -- Exactly one current version per entry: the one seen last (ties broken by hash, so a replay is stable).
    -- Two statements, demote then promote, because the one-current index is checked row by row.
    update evidence_private.stat_catalogue_entries e set is_current = false
      from (
        select e2.id, row_number() over (partition by e2.entry_key order by e2.observed_last_at desc, e2.observed_first_at desc, e2.content_hash desc) as rn
        from evidence_private.stat_catalogue_entries e2
        where e2.source_id = v_run.source_id
          and e2.entry_key in (select i.entry_key from jsonb_to_recordset(p_meta -> 'catalogue_entries') as i(entry_key text))
      ) r
     where r.id = e.id and r.rn > 1 and e.is_current;
    update evidence_private.stat_catalogue_entries e set is_current = true
      from (
        select e2.id, row_number() over (partition by e2.entry_key order by e2.observed_last_at desc, e2.observed_first_at desc, e2.content_hash desc) as rn
        from evidence_private.stat_catalogue_entries e2
        where e2.source_id = v_run.source_id
          and e2.entry_key in (select i.entry_key from jsonb_to_recordset(p_meta -> 'catalogue_entries') as i(entry_key text))
      ) r
     where r.id = e.id and r.rn = 1 and not e.is_current;
  end if;

  update evidence_private.import_runs
     set records_seen = records_seen + v_entries_seen, versions_inserted = versions_inserted + v_entries,
         unchanged = unchanged + (v_entries_seen - v_entries)
   where id = p_run_id;

  return jsonb_build_object('routes', v_routes, 'datasets', v_datasets, 'releases', v_releases, 'series_inserted', v_series,
                            'geographies_inserted', v_geographies, 'catalogue_entries_seen', v_entries_seen,
                            'catalogue_entries_written', v_entries);
end
$$;

-- Resolves a batch of contract observation rows to this source's series, releases and geographies. Read-only.
create or replace function evidence_private.stat_resolve_observations(p_source_id text, p_rows jsonb)
returns table (
  series_id uuid, release_id uuid, geography_version_id uuid, route text, wants_geography boolean, period_label text, period_start date,
  period_end date, value numeric(38, 12), value_double double precision, raw_value text, value_status text, parse_status text,
  source_status text, source_symbol text, upstream_status text, qualifiers jsonb, row_locator text, content_hash text)
language sql
stable
set search_path = ''
as $$
  select s.id, r.id, g.id, d.route, i.geography is not null and jsonb_typeof(i.geography) = 'object', i.period_label, i.period_start, i.period_end,
         i.value::numeric(38, 12), i.value_double, i.raw_value, i.value_status, i.parse_status, i.source_status, i.source_symbol,
         i.upstream_status, coalesce(i.qualifiers, '{}'::jsonb), i.row_locator, i.content_hash
  from jsonb_to_recordset(p_rows)
       as i(dataset_key text, release_key text, series_key text, geography jsonb, period_label text, period_start date, period_end date,
            value text, value_double double precision, raw_value text, value_status text, parse_status text, source_status text,
            source_symbol text, upstream_status text, qualifiers jsonb, row_locator text, content_hash text)
  left join evidence_private.stat_datasets d on d.source_id = p_source_id and d.dataset_key = i.dataset_key
  left join evidence_private.stat_series s on s.dataset_id = d.id and s.series_key = i.series_key
  left join evidence_private.stat_releases r on r.dataset_id = d.id and r.release_key = i.release_key
  left join evidence_private.geography_versions g
    on jsonb_typeof(i.geography) = 'object' and g.scheme = i.geography ->> 'scheme' and g.edition = i.geography ->> 'edition'
   and g.code = i.geography ->> 'code' and g.source_id = p_source_id;
$$;

-- Observations of ONE source, inside a held run. Idempotent: an identical row is counted as unchanged. A row whose
-- identity exists with different content is never overwritten: it is counted, logged, and the run must not succeed.
-- One autocommit statement, no session state and no temporary table, so it is safe behind a transaction-mode pooler.
create or replace function evidence_private.ingest_stat_observations(p_run_id uuid, p_holder uuid, p_rows jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_run evidence_private.import_runs%rowtype;
  v_seen integer;
  v_distinct integer;
  v_unresolved integer;
  v_inserted integer := 0;
  v_unchanged integer := 0;
  v_conflicts integer := 0;
begin
  v_run := evidence_private.assert_run_held(p_run_id, p_holder);
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'statistics observation batch must be an array' using errcode = 'P0001';
  end if;
  select count(*) into v_seen from jsonb_array_elements(p_rows);
  if v_seen > 10000 then
    raise exception 'statistics observation batch is larger than 10000 rows' using errcode = 'P0001';
  end if;

  -- Nothing is skipped: one row that does not resolve to this source's series, release and geography refuses the batch.
  select count(*) filter (where t.series_id is null or t.release_id is null or t.route is null or (t.wants_geography and t.geography_version_id is null)),
         count(distinct (t.series_id, t.release_id, t.geography_version_id, t.period_label))
    into v_unresolved, v_distinct
  from evidence_private.stat_resolve_observations(v_run.source_id, p_rows) t;
  if v_unresolved > 0 then
    raise exception '% observation(s) name a series, release or geography this source has not registered; load the meta rows first', v_unresolved using errcode = 'P0001';
  end if;
  if v_distinct <> v_seen then
    raise exception 'observation batch holds % rows but % identities; two rows of one identity are a fault, never a sum', v_seen, v_distinct using errcode = 'P0001';
  end if;
  if exists (select 1 from evidence_private.stat_resolve_observations(v_run.source_id, p_rows) t
              where evidence_private.text_violation(t.raw_value) is not null or evidence_private.text_violation(t.row_locator) is not null
                 or evidence_private.text_violation(t.qualifiers::text) is not null) then
    raise exception 'observation batch carries text that is never stored' using errcode = 'P0001';
  end if;

  select count(*) into v_conflicts
  from evidence_private.stat_resolve_observations(v_run.source_id, p_rows) t
  join evidence_private.stat_observations o
    on o.series_id = t.series_id and o.release_id = t.release_id and o.period_label = t.period_label
   and coalesce(o.geography_version_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(t.geography_version_id, '00000000-0000-0000-0000-000000000000'::uuid)
  where o.content_hash <> t.content_hash;

  with written as (
    insert into evidence_private.stat_observations (series_id, release_id, geography_version_id, period_label, period_start, period_end,
      value, value_double, raw_value, value_status, parse_status, row_locator, content_hash, canonical_route, import_run_id,
      source_status, source_symbol, upstream_status, qualifiers)
    select t.series_id, t.release_id, t.geography_version_id, t.period_label, t.period_start, t.period_end, t.value, t.value_double, t.raw_value,
           t.value_status, t.parse_status, t.row_locator, t.content_hash, t.route, p_run_id, t.source_status, t.source_symbol, t.upstream_status, t.qualifiers
    from evidence_private.stat_resolve_observations(v_run.source_id, p_rows) t
    on conflict (series_id, release_id, coalesce(geography_version_id, '00000000-0000-0000-0000-000000000000'::uuid), period_label) do nothing
    returning 1)
  select count(*) into v_inserted from written;

  v_unchanged := v_seen - v_inserted - v_conflicts;
  if v_conflicts > 0 then
    insert into evidence_private.ingest_errors (run_id, source_id, error_class, message)
    values (p_run_id, v_run.source_id, 'stat_identity_conflict',
            format('%s observation(s) already exist for the same series, release, geography and period with different content; kept as stored, not overwritten', v_conflicts));
  end if;

  update evidence_private.import_runs
     set records_seen = records_seen + v_seen, observations_inserted = observations_inserted + v_inserted,
         unchanged = unchanged + v_unchanged, rejected = rejected + v_conflicts
   where id = p_run_id;

  return jsonb_build_object('seen', v_seen, 'inserted', v_inserted, 'unchanged', v_unchanged, 'conflicts', v_conflicts);
end
$$;

-- What a source holds, for the loader's destination-side reconciliation. Counts only.
create or replace function evidence_private.stat_source_counts(p_source_id text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'datasets', (select count(*) from evidence_private.stat_datasets d where d.source_id = p_source_id),
    'releases', (select count(*) from evidence_private.stat_releases r join evidence_private.stat_datasets d on d.id = r.dataset_id where d.source_id = p_source_id),
    'series', (select count(*) from evidence_private.stat_series s join evidence_private.stat_datasets d on d.id = s.dataset_id where d.source_id = p_source_id),
    'geographies', (select count(*) from evidence_private.geography_versions g where g.source_id = p_source_id),
    'catalogue_entry_versions', (select count(*) from evidence_private.stat_catalogue_entries e where e.source_id = p_source_id),
    'catalogue_entries_current', (select count(*) from evidence_private.stat_catalogue_entries e where e.source_id = p_source_id and e.is_current),
    'observations', (select count(*) from evidence_private.stat_observations o join evidence_private.stat_series s on s.id = o.series_id
                      join evidence_private.stat_datasets d on d.id = s.dataset_id where d.source_id = p_source_id),
    'observations_by_release', coalesce((
      select jsonb_object_agg(x.k, x.n) from (
        select d.dataset_key || ' @ ' || r.release_key as k, count(*) as n
        from evidence_private.stat_observations o join evidence_private.stat_releases r on r.id = o.release_id
        join evidence_private.stat_datasets d on d.id = r.dataset_id where d.source_id = p_source_id group by 1) x), '{}'::jsonb),
    'observations_by_status', coalesce((
      select jsonb_object_agg(x.k, x.n) from (
        select o.value_status as k, count(*) as n
        from evidence_private.stat_observations o join evidence_private.stat_series s on s.id = o.series_id
        join evidence_private.stat_datasets d on d.id = s.dataset_id where d.source_id = p_source_id group by 1) x), '{}'::jsonb),
    -- A number where none was published, or none where one was: both must be zero. Withheld is never zero.
    'withheld_rows_carrying_a_number', (
      select count(*) from evidence_private.stat_observations o join evidence_private.stat_series s on s.id = o.series_id
      join evidence_private.stat_datasets d on d.id = s.dataset_id
      where d.source_id = p_source_id and o.value_status not in ('reported', 'provisional') and (o.value is not null or o.value_double is not null)),
    'content_digest', (
      select md5(coalesce(string_agg(o.content_hash, '' order by o.content_hash), ''))
      from evidence_private.stat_observations o join evidence_private.stat_series s on s.id = o.series_id
      join evidence_private.stat_datasets d on d.id = s.dataset_id where d.source_id = p_source_id));
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array['ingest_stat_meta(uuid, uuid, jsonb)', 'ingest_stat_observations(uuid, uuid, jsonb)',
                              'stat_resolve_observations(text, jsonb)', 'stat_source_counts(text)']
  loop
    execute format('revoke execute on function evidence_private.%s from public', v_fn);
    execute format('grant execute on function evidence_private.%s to evidence_ingest', v_fn);
  end loop;
end
$$;

-- 4. Base views and projection registers ------------------------------------------------------------------
-- Columns are appended, never reordered, so dependent projections stay valid until they are rebuilt below.

create or replace view evidence_views.stat_series as
select s.id, d.source_id, d.dataset_key, d.title as dataset_title, s.series_key, s.title, s.unit, s.magnitude,
       s.seasonal_adjustment, s.dimensions,
       (select count(*) from evidence_private.stat_observations o where o.series_id = s.id) as observations,
       s.frequency, d.route as canonical_route, d.historical, d.official_url, d.coverage_note
from evidence_private.stat_series s
join evidence_private.stat_datasets d on d.id = s.dataset_id;

create or replace view evidence_views.stat_observations as
select o.id, o.series_id, rl.release_key, rl.released_on, g.scheme as geography_scheme, g.edition as geography_edition,
       g.code as geography_code, g.name as geography_name, o.period_label, o.period_start, o.period_end,
       o.value, o.value_double, o.raw_value, o.value_status, o.parse_status, o.row_locator, o.canonical_route,
       o.source_status, o.source_symbol, o.qualifiers, rl.vintage_label, rl.released_on_basis, rl.source_url,
       rl.source_file_sha256 as source_file_hash, rl.retrieved_at, o.content_hash
from evidence_private.stat_observations o
join evidence_private.stat_releases rl on rl.id = o.release_id
left join evidence_private.geography_versions g on g.id = o.geography_version_id;

create view evidence_views.stat_releases as
select rl.id, d.source_id, d.dataset_key, d.title as dataset_title, d.historical, rl.release_key, rl.vintage_label, rl.released_on,
       rl.released_on_basis, rl.source_url, rl.source_file_sha256 as source_file_hash, rl.source_bytes, rl.retrieved_at,
       rl.publisher_last_modified, rl.boundary_edition, rl.capture_count,
       (select count(*) from evidence_private.stat_observations o where o.release_id = rl.id) as observations
from evidence_private.stat_releases rl
join evidence_private.stat_datasets d on d.id = rl.dataset_id;

create view evidence_views.stat_catalogue_entries as
select e.id, e.source_id, e.entry_key, e.entry_kind, e.title, e.url as source_url, e.found_on_url, e.format,
       e.file_sha256 as file_hash, e.publisher_modified_text, e.attributes, e.facts_asserted, e.observed_first_at, e.observed_last_at,
       e.observation_count, e.is_current, e.content_hash
from evidence_private.stat_catalogue_entries e;

grant usage, create on schema evidence_views to evidence_inspector_reader;
alter view evidence_views.stat_releases owner to evidence_inspector_reader;
alter view evidence_views.stat_catalogue_entries owner to evidence_inspector_reader;
revoke all on evidence_views.stat_releases, evidence_views.stat_catalogue_entries from public, anon, authenticated;
revoke create on schema evidence_views from evidence_inspector_reader;

-- Geographies now carry the source whose file printed them, so their lineage can be proved: the blanket withhold
-- ("no foreign key to a source dataset yet") is replaced by recorded lineage. Rows without a source stay unshown.
delete from evidence_private.public_withheld
 where object_schema = 'evidence_private' and object_name = 'geography_versions' and column_name = '*';

insert into evidence_private.public_lineage (object_schema, object_name, lineage_kind, lineage_sql, note) values
  ('evidence_private', 'geography_versions', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'stat_catalogue_entries', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'stat_catalogue_entries', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'stat_releases', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.');

select evidence_private.classify_public_columns();
select evidence_private.rebuild_exposed_views();
