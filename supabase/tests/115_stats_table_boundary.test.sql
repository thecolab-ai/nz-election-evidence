-- Statistics table boundary: the worker holds table privileges (its ingestion functions are SECURITY INVOKER), so every
-- rule must hold against PLAIN DML issued by that same role. First the honest path, as the least-privileged role and
-- through the functions; then hostile direct DML, inserts and updates alike, each of which must be refused by the
-- tables themselves with the stated error class.
-- TEST FIXTURES ONLY: synthetic rows that describe no real statistic, rolled back.
begin;
select plan(54);

grant evidence_ingest to current_user;
create temp table ctx (k text primary key, v text);
-- Every hostile statement, the SQLSTATE the TABLES must answer with ('ok' = must be allowed), and what it proves.
-- 42501 = the privilege is not held; 23514 = a CHECK constraint; 23505 = a unique identity; P0001 = a guard trigger.
create temp table cases (n integer primary key, statement text not null, expect text not null, note text not null, got text);
grant all on ctx, cases to evidence_ingest;

-- The role under test holds nothing beyond evidence_ingest: no ownership, no bypass, and none of the rights it must not have.
select is((select rolsuper or rolbypassrls or rolcreaterole from pg_roles where rolname = 'evidence_ingest'), false, 'the worker role is not elevated');
select is((select count(*)::integer from information_schema.role_table_grants
            where grantee = 'evidence_ingest' and table_schema = 'evidence_private'
              and (table_name like 'stat\_%' or table_name = 'geography_versions')
              and privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')), 0,
          'the worker holds no DELETE, TRUNCATE, REFERENCES or TRIGGER on any statistics table');
select is((select count(*)::integer from information_schema.role_table_grants
            where grantee = 'evidence_ingest' and table_schema = 'evidence_private' and privilege_type = 'UPDATE'
              and (table_name like 'stat\_%' or table_name = 'geography_versions')), 0,
          'the worker holds no table-wide UPDATE on any statistics table');
select is((select string_agg(table_name || '.' || column_name, ' ' order by table_name, column_name) from information_schema.column_privileges
            where grantee = 'evidence_ingest' and table_schema = 'evidence_private' and privilege_type = 'UPDATE'
              and table_name in ('stat_series', 'geography_versions', 'stat_observations')), null,
          'series, geographies and observations have no updatable column at all');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'evidence_private' and p.proname like any (array['guard_stat%', 'stat_source_open', 'ingest_stat%']) and (p.prosecdef or p.proconfig is null)), 0,
          'no statistics function runs as its owner, and every one pins its search_path');

-- Shorthand used by the hostile statements (created by the owner, run with the caller's rights).
create function pg_temp.a(p_what text) returns uuid language sql as $$
  select case p_what
    when 'run' then (select v::uuid from ctx where k = 'run_pgtap_bound_a')
    when 'dataset' then (select id from evidence_private.stat_datasets where source_id = 'pgtap_bound_a')
    when 'series' then (select s.id from evidence_private.stat_series s join evidence_private.stat_datasets d on d.id = s.dataset_id where d.source_id = 'pgtap_bound_a')
    when 'release' then (select r.id from evidence_private.stat_releases r join evidence_private.stat_datasets d on d.id = r.dataset_id where d.source_id = 'pgtap_bound_a')
    when 'geography' then (select id from evidence_private.geography_versions where source_id = 'pgtap_bound_a') end $$;
create function pg_temp.b(p_what text) returns uuid language sql as $$
  select case p_what
    when 'run' then (select v::uuid from ctx where k = 'run_pgtap_bound_b')
    when 'dataset' then (select id from evidence_private.stat_datasets where source_id = 'pgtap_bound_b')
    when 'series' then (select s.id from evidence_private.stat_series s join evidence_private.stat_datasets d on d.id = s.dataset_id where d.source_id = 'pgtap_bound_b')
    when 'release' then (select r.id from evidence_private.stat_releases r join evidence_private.stat_datasets d on d.id = r.dataset_id where d.source_id = 'pgtap_bound_b')
    when 'geography' then (select id from evidence_private.geography_versions where source_id = 'pgtap_bound_b') end $$;
create function pg_temp.obs(p_series uuid, p_release uuid, p_geography uuid, p_period text, p_run uuid, p_locator text default 'hostile') returns void language sql as $$
  insert into evidence_private.stat_observations (series_id, release_id, geography_version_id, period_label, value, raw_value, value_status, parse_status, row_locator, content_hash, canonical_route, import_run_id)
  values (p_series, p_release, p_geography, p_period, 1, '1', 'reported', 'parsed', p_locator, 'sha256:' || repeat('f', 64), 'dedicated_series', p_run) $$;

insert into cases (n, statement, expect, note) values
  (1, $s$insert into evidence_private.stat_datasets (source_id, dataset_key, title, publisher) values ('pgtap_bound_b', 'hostile', 'x', 'x')$s$, 'P0001', 'a dataset of a source with no running run is refused'),
  (2, $s$insert into evidence_private.stat_datasets (source_id, dataset_key, title, publisher) values ('pgtap_bound_civic', 'hostile', 'x', 'x')$s$, 'P0001', 'a running run of a source that is not a statistics source opens nothing'),
  (3, $s$insert into evidence_private.stat_series (dataset_id, series_key) values (pg_temp.b('dataset'), 'hostile')$s$, 'P0001', 'a series under a closed source is refused'),
  (4, $s$insert into evidence_private.stat_releases (dataset_id, release_key, import_run_id) values (pg_temp.a('dataset'), 'hostile', null)$s$, 'P0001', 'a release that names no run is refused'),
  (5, $s$insert into evidence_private.stat_releases (dataset_id, release_key, import_run_id) values (pg_temp.a('dataset'), 'hostile', pg_temp.b('run'))$s$, 'P0001', 'a release that names the run of another source is refused'),
  (6, $s$insert into evidence_private.geography_versions (scheme, edition, code, name) values ('hostile', 'e', 'c', 'n')$s$, 'P0001', 'a geography without a source is refused'),
  (7, $s$insert into evidence_private.geography_versions (scheme, edition, code, name, source_id) values ('hostile', 'e', 'c', 'n', 'pgtap_bound_b')$s$, 'P0001', 'a geography of a closed source is refused'),
  (8, $s$insert into evidence_private.stat_route_reconciliation (observation_family, canonical_route, decision_note, decided_by) values ('not.a.dataset', 'operational', 'x', 'x')$s$, 'P0001', 'a route for a family that is no dataset of an open source is refused'),
  (9, $s$insert into evidence_private.stat_route_reconciliation (observation_family, canonical_route, decision_note, decided_by) values ('pgtap_bound_b.dataset.other', 'operational', 'x', 'x')$s$, 'P0001', 'and so is one squatting on a name beside a closed source'),
  (10, $s$insert into evidence_private.stat_catalogue_entries (source_id, entry_key, entry_kind, title, url, found_on_url, observed_first_at, observed_last_at, observation_count, is_current, content_hash, import_run_id) values ('pgtap_bound_b', 'hostile', 'catalogue_link', 't', 'https://fixture.example/x', 'https://fixture.example/', now(), now(), 1, false, 'sha256:' || repeat('9', 64), pg_temp.a('run'))$s$, 'P0001', 'a catalogue entry of one source under the run of another is refused'),
  (11, $s$select pg_temp.obs(pg_temp.a('series'), pg_temp.a('release'), null, 'h1', pg_temp.b('run'))$s$, 'P0001', 'an observation under a finished run is refused'),
  (12, $s$select pg_temp.obs(pg_temp.b('series'), pg_temp.b('release'), null, 'h2', pg_temp.a('run'))$s$, 'P0001', 'an observation of another source''s series under one''s own run is refused'),
  (13, $s$select pg_temp.obs(pg_temp.a('series'), pg_temp.b('release'), null, 'h3', pg_temp.a('run'))$s$, 'P0001', 'an observation whose release belongs to another dataset is refused'),
  (14, $s$select pg_temp.obs(pg_temp.a('series'), pg_temp.a('release'), pg_temp.b('geography'), 'h4', pg_temp.a('run'))$s$, 'P0001', 'an observation on another source''s geography is refused'),
  (15, $s$select pg_temp.obs(pg_temp.a('series'), pg_temp.a('release'), null, 'h5', (select v::uuid from ctx where k = 'run_civic'))$s$, 'P0001', 'an observation under the run of a source that is not a statistics source is refused'),
  (16, $s$select pg_temp.obs(pg_temp.a('series'), pg_temp.a('release'), null, 'h6', pg_temp.a('run'), 'write to fixture.person@fixture.example')$s$, '23514', 'contact-like text is refused by the table even inside an open run'),
  (17, $s$insert into evidence_private.stat_series (dataset_id, series_key, title) values (pg_temp.a('dataset'), 'hostile', 'password = hunter2hunter2')$s$, '23514', 'credential-like text in a series title is refused by the table'),
  (18, $s$insert into evidence_private.stat_datasets (source_id, dataset_key, title, publisher, coverage_note) values ('pgtap_bound_a', 'hostile', 'x', 'x', 'see /srv/private/input.csv')$s$, '23514', 'a filesystem location in a dataset note is refused by the table'),
  (19, $s$select pg_temp.obs(pg_temp.a('series'), pg_temp.a('release'), pg_temp.a('geography'), '2001', pg_temp.a('run'))$s$, '23505', 'a second row of a stored identity is an error, never an overwrite'),
  (20, $s$insert into evidence_private.stat_observations (series_id, release_id, period_label, value, value_status, parse_status, content_hash, canonical_route, import_run_id) values (pg_temp.a('series'), pg_temp.a('release'), 'h7', 0, 'suppressed', 'parsed', 'sha256:' || repeat('f', 64), 'dedicated_series', pg_temp.a('run'))$s$, '23514', 'a withheld value can never be stored as zero'),
  (21, $s$insert into evidence_private.stat_observations (series_id, release_id, period_label, value, value_status, parse_status, content_hash, canonical_route, import_run_id) values (pg_temp.a('series'), pg_temp.a('release'), 'h8', 1, 'reported', 'parsed', 'sha256:' || repeat('f', 64), 'operational', pg_temp.a('run'))$s$, 'P0001', 'an observation through a second route is refused'),
  (22, $s$update evidence_private.stat_observations set value = 99$s$, '42501', 'the worker cannot update an observation'),
  (23, $s$delete from evidence_private.stat_observations$s$, '42501', 'nor delete one'),
  (24, $s$truncate evidence_private.stat_observations$s$, '42501', 'nor truncate the table'),
  (25, $s$update evidence_private.stat_series set unit = 'percent'$s$, '42501', 'a series definition cannot be updated'),
  (26, $s$update evidence_private.geography_versions set name = 'moved'$s$, '42501', 'a geography cannot be updated'),
  (27, $s$update evidence_private.stat_datasets set source_id = 'pgtap_bound_b' where source_id = 'pgtap_bound_a'$s$, '42501', 'a dataset cannot be moved to another source'),
  (28, $s$update evidence_private.stat_datasets set route = 'operational' where source_id = 'pgtap_bound_a'$s$, 'P0001', 'a dataset route is never switched'),
  (29, $s$update evidence_private.stat_datasets set title = 'defaced' where source_id = 'pgtap_bound_b'$s$, 'P0001', 'a dataset of a closed source cannot be edited'),
  (30, $s$update evidence_private.stat_releases set source_file_sha256 = repeat('9', 64)$s$, '42501', 'a release cannot be repointed at another file'),
  (31, $s$update evidence_private.stat_releases set capture_count = 1 where id = pg_temp.a('release')$s$, 'P0001', 'a capture count never goes down'),
  (32, $s$update evidence_private.stat_releases set retrieved_at = '2026-06-01T00:00:00Z' where id = pg_temp.a('release')$s$, 'P0001', 'a collection time never moves later'),
  (33, $s$update evidence_private.stat_releases set capture_count = 3, retrieved_at = '2026-01-01T00:00:00Z' where id = pg_temp.a('release')$s$, 'ok', 'an earlier capture of the same file may be recorded inside an open run'),
  (34, $s$update evidence_private.stat_route_reconciliation set canonical_route = 'operational'$s$, '42501', 'a canonical route cannot be switched'),
  (35, $s$update evidence_private.stat_route_reconciliation set decision_note = 'defaced' where observation_family = 'pgtap_bound_b.dataset'$s$, 'P0001', 'the route note of a closed source cannot be edited'),
  (36, $s$update evidence_private.stat_catalogue_entries set title = 'defaced'$s$, '42501', 'a catalogue entry version cannot be rewritten'),
  (37, $s$update evidence_private.stat_catalogue_entries set observed_last_at = '2025-01-01T00:00:00Z' where source_id = 'pgtap_bound_a'$s$, 'P0001', 'an observation span cannot be inverted (the one-way guard answers before the span CHECK)'),
  (38, $s$update evidence_private.stat_catalogue_entries set observation_count = 1 where source_id = 'pgtap_bound_a' and title = 'Newer'$s$, 'P0001', 'nor narrowed'),
  (39, $s$update evidence_private.stat_catalogue_entries set is_current = false where source_id = 'pgtap_bound_a' and title = 'Newer'$s$, 'P0001', 'the version observed last cannot be hidden'),
  (40, $s$update evidence_private.stat_catalogue_entries set is_current = true where source_id = 'pgtap_bound_a' and title = 'Older'$s$, 'any', 'an older version cannot be made current'),
  (41, $s$update evidence_private.stat_source_summary set observations = 1000000 where source_id = 'pgtap_bound_a'$s$, 'P0001', 'a summary that is not what the tables hold is refused'),
  (42, $s$update evidence_private.stat_source_summary set counted_at = now() where source_id = 'pgtap_bound_b'$s$, 'P0001', 'a summary of a closed source cannot be rewritten'),
  (43, $s$alter table evidence_private.stat_observations disable trigger stat_observations_write_guard_insert$s$, '42501', 'the worker cannot disable a guard'),
  (44, $s$drop trigger stat_observations_update_guard on evidence_private.stat_observations$s$, '42501', 'nor drop one');

set local role evidence_ingest;

-- Honest path, least privilege: two statistics sources and one that is not, loaded through the functions only.
do $$
declare
  v_holder uuid := '66666666-6666-6666-6666-666666666666';
  v_run uuid;
  v_result jsonb;
  v_source text;
begin
  perform evidence_private.sync_registry(jsonb_build_object('rights', jsonb_build_array(jsonb_build_object('rights_id', 'RIGHTS-93', 'publisher', 'Fixture Statistics Office',
      'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h1')),
    'sources', (select jsonb_agg(jsonb_build_object('source_id', x.id, 'title', 'Fixture ' || x.id, 'publisher', 'Fixture Statistics Office', 'official_url', 'https://fixture.example/' || x.id,
        'adapter_kind', 'export_import', 'adapter_name', 'stats_family_artifact', 'allowed_hosts', jsonb_build_array(), 'rights_id', 'RIGHTS-93',
        'view_scope', x.scope, 'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'c'))
      from (values ('pgtap_bound_a', 'statistics'), ('pgtap_bound_b', 'statistics'), ('pgtap_bound_civic', 'general')) as x(id, scope))));

  foreach v_source in array array['pgtap_bound_a', 'pgtap_bound_b'] loop
    perform evidence_private.acquire_lease(v_source, v_holder, 300);
    v_run := (evidence_private.start_run(v_source, v_holder, 'v1', 'export_import', 'test', 'm-' || v_source) ->> 'run_id')::uuid;
    insert into ctx values ('run_' || v_source, v_run::text);
    v_result := evidence_private.ingest_stat_meta(v_run, v_holder, jsonb_build_object(
      'routes', jsonb_build_array(jsonb_build_object('observation_family', v_source || '.dataset', 'canonical_route', 'dedicated_series', 'overlapping_routes', jsonb_build_array(),
        'upstream_rows_by_route', jsonb_build_object('dedicated_series', 2), 'decision_note', 'fixture')),
      'datasets', jsonb_build_array(jsonb_build_object('source_id', v_source, 'dataset_key', v_source || '.dataset', 'title', 'Fixture dataset', 'publisher', 'Fixture Statistics Office',
        'official_url', 'https://fixture.example/stats', 'route', 'dedicated_series', 'historical', false, 'coverage_note', null)),
      'releases', jsonb_build_array(jsonb_build_object('dataset_key', v_source || '.dataset', 'release_key', 'r1', 'vintage_label', 'Fixture release', 'released_on', null,
        'released_on_basis', 'publisher_label_only', 'source_url', 'https://fixture.example/stats/file.csv', 'source_file_sha256', repeat('a', 64), 'source_bytes', 10,
        'retrieved_at', '2026-01-02T00:00:00Z', 'publisher_last_modified', null, 'boundary_edition', null, 'capture_count', 2)),
      'series', jsonb_build_array(jsonb_build_object('dataset_key', v_source || '.dataset', 'series_key', 's1', 'title', 'Fixture series', 'unit', 'count', 'magnitude', null,
        'seasonal_adjustment', null, 'frequency', 'annual', 'dimensions', '{}'::jsonb)),
      'geographies', jsonb_build_array(jsonb_build_object('source_id', v_source, 'scheme', v_source || ':area', 'edition', 'e1', 'code', 'A1', 'name', 'Fixture area', 'code_basis', 'publisher_code')),
      'catalogue_entries', jsonb_build_array(
        jsonb_build_object('source_id', v_source, 'entry_key', 'e1', 'entry_kind', 'file_metadata', 'title', 'Older', 'url', 'https://fixture.example/f.csv', 'found_on_url', 'https://fixture.example/',
          'format', 'csv', 'file_sha256', null, 'publisher_modified_text', null, 'attributes', '{}'::jsonb, 'observed_first_at', '2026-01-01T00:00:00Z', 'observed_last_at', '2026-01-01T00:00:00Z',
          'observation_count', 1, 'content_hash', 'sha256:' || repeat('1', 64)),
        jsonb_build_object('source_id', v_source, 'entry_key', 'e1', 'entry_kind', 'file_metadata', 'title', 'Newer', 'url', 'https://fixture.example/f.csv', 'found_on_url', 'https://fixture.example/',
          'format', 'csv', 'file_sha256', null, 'publisher_modified_text', null, 'attributes', '{}'::jsonb, 'observed_first_at', '2026-01-02T00:00:00Z', 'observed_last_at', '2026-01-03T00:00:00Z',
          'observation_count', 2, 'content_hash', 'sha256:' || repeat('2', 64)))));
    v_result := evidence_private.ingest_stat_observations(v_run, v_holder, jsonb_build_array(
      jsonb_build_object('dataset_key', v_source || '.dataset', 'release_key', 'r1', 'series_key', 's1', 'geography', jsonb_build_object('scheme', v_source || ':area', 'edition', 'e1', 'code', 'A1'),
        'period_label', '2001', 'period_start', null, 'period_end', null, 'value', '5', 'value_double', null, 'raw_value', '5', 'value_status', 'reported', 'parse_status', 'parsed',
        'source_status', null, 'source_symbol', null, 'upstream_status', 'observed', 'qualifiers', '{}'::jsonb, 'row_locator', 'file.csv row 2', 'content_hash', 'sha256:' || repeat('a', 64)),
      jsonb_build_object('dataset_key', v_source || '.dataset', 'release_key', 'r1', 'series_key', 's1', 'geography', null,
        'period_label', '2006', 'period_start', null, 'period_end', null, 'value', null, 'value_double', null, 'raw_value', '..C', 'value_status', 'confidential', 'parse_status', 'unparsed_symbol',
        'source_status', null, 'source_symbol', '..C', 'upstream_status', 'confidentialised', 'qualifiers', '{}'::jsonb, 'row_locator', 'file.csv row 3', 'content_hash', 'sha256:' || repeat('b', 64))));
    insert into ctx values ('inserted_' || v_source, v_result ->> 'inserted');
    perform evidence_private.record_stat_source_summary(v_run, v_holder);
  end loop;

  -- Source B is finished and its lease released: it is closed. Source A stays open for the hostile statements below.
  perform evidence_private.finish_run((select v::uuid from ctx where k = 'run_pgtap_bound_b'), v_holder, 'succeeded', false, 'fixture', null, null);
  -- A source that is not a statistics source, with a running, leased run of its own.
  perform evidence_private.acquire_lease('pgtap_bound_civic', v_holder, 300);
  insert into ctx values ('run_civic', evidence_private.start_run('pgtap_bound_civic', v_holder, 'v1', 'export_import', 'test', 'm-civic') ->> 'run_id');
end
$$;


-- Hostile direct DML, as the worker role, while source A is open and source B is closed. Each statement runs in its own
-- subtransaction; what the database answered is recorded, and nothing a refused statement did survives.
do $$
declare
  v_case record;
  v_state text;
begin
  for v_case in select * from cases order by n loop
    begin
      execute v_case.statement;
      v_state := 'ok';
    exception when others then
      v_state := sqlstate;
    end;
    update cases set got = v_state where n = v_case.n;
  end loop;
end
$$;
reset role;

select is((select v from ctx where k = 'inserted_pgtap_bound_a') || '/' || (select v from ctx where k = 'inserted_pgtap_bound_b'), '2/2',
          'least privilege: the worker role alone loads both sources through the guarded functions');
select is((select observations::integer from evidence_private.stat_source_summary where source_id = 'pgtap_bound_a'), 2, 'and records a true summary');
select is((select status from evidence_private.import_runs where id = (select v::uuid from ctx where k = 'run_pgtap_bound_b')), 'succeeded', 'source B is finished; source A is still running');

select is(c.got, c.expect, c.note) from cases c where c.expect <> 'any' order by c.n;
select isnt(c.got, 'ok', c.note) from cases c where c.expect = 'any' order by c.n;


-- Nothing hostile was stored, and the guards bind the table owner's role as well as the worker.
select is((select count(*)::integer from evidence_private.stat_observations o join evidence_private.stat_series s on s.id = o.series_id
            join evidence_private.stat_datasets d on d.id = s.dataset_id where d.source_id like 'pgtap\_bound\_%'), 4, 'only the four honest observations exist');
select throws_ok($$update evidence_private.stat_observations set value = 99 where row_locator = 'file.csv row 2'$$, 'P0001', null, 'even the owner role cannot edit a stored observation in place');

select * from finish();
rollback;
