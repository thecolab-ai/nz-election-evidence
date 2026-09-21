-- Statistics import: the worker loads typed rows through the two functions and nothing else; replays write
-- nothing; a stored number is never overwritten, a withheld value is never a number, a route is never switched,
-- a catalogue entry can never assert a fact, a collection time is never a release date.
-- TEST FIXTURES ONLY: synthetic rows that describe no real statistic, rolled back.
begin;
select plan(21);

grant evidence_ingest to current_user;
create temp table outcome (name text primary key, state text);
grant all on outcome to evidence_ingest;

set local role evidence_ingest;
do $$
declare
  v_holder uuid := '44444444-4444-4444-4444-444444444444';
  v_run uuid;
  v_result jsonb;
  v_case record;
  v_obs jsonb;
  v_meta jsonb;
begin
  perform evidence_private.sync_registry(jsonb_build_object('rights', jsonb_build_array(jsonb_build_object('rights_id', 'RIGHTS-92', 'publisher', 'Fixture Statistics Office',
      'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h1')),
    'sources', jsonb_build_array(
      jsonb_build_object('source_id', 'pgtap_stats', 'title', 'Fixture statistics', 'publisher', 'Fixture Statistics Office', 'official_url', 'https://fixture.example/stats',
        'adapter_kind', 'export_import', 'adapter_name', 'stats_family_artifact', 'allowed_hosts', jsonb_build_array(), 'rights_id', 'RIGHTS-92',
        'view_scope', 'statistics', 'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'c'),
      jsonb_build_object('source_id', 'pgtap_stats_other', 'title', 'Fixture statistics two', 'publisher', 'Fixture Statistics Office', 'official_url', 'https://fixture.example/stats2',
        'adapter_kind', 'export_import', 'adapter_name', 'stats_family_artifact', 'allowed_hosts', jsonb_build_array(), 'rights_id', 'RIGHTS-92',
        'view_scope', 'statistics', 'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'c'))));

  v_meta := jsonb_build_object(
    'routes', jsonb_build_array(jsonb_build_object('observation_family', 'fixture.dataset', 'canonical_route', 'dedicated_census', 'overlapping_routes', jsonb_build_array('operational'),
      'upstream_rows_by_route', jsonb_build_object('dedicated_census', 3, 'operational', 1), 'decision_note', 'fixture')),
    'datasets', jsonb_build_array(jsonb_build_object('source_id', 'pgtap_stats', 'dataset_key', 'fixture.dataset', 'title', 'Fixture dataset', 'publisher', 'Fixture Statistics Office',
      'official_url', 'https://fixture.example/stats', 'route', 'dedicated_census', 'historical', true, 'coverage_note', null)),
    'releases', jsonb_build_array(jsonb_build_object('dataset_key', 'fixture.dataset', 'release_key', 'r1', 'vintage_label', 'Fixture release', 'released_on', null,
      'released_on_basis', 'publisher_label_only', 'source_url', 'https://fixture.example/stats/file.csv', 'source_file_sha256', repeat('a', 64), 'source_bytes', 10,
      'retrieved_at', '2026-01-02T00:00:00Z', 'publisher_last_modified', null, 'boundary_edition', null, 'capture_count', 2)),
    'series', jsonb_build_array(jsonb_build_object('dataset_key', 'fixture.dataset', 'series_key', 's1', 'title', 'Fixture series', 'unit', 'count', 'magnitude', null,
      'seasonal_adjustment', null, 'frequency', 'census', 'dimensions', jsonb_build_object('measure', 'fixture'))),
    'geographies', jsonb_build_array(jsonb_build_object('source_id', 'pgtap_stats', 'scheme', 'pgtap_stats:area', 'edition', 'fixture edition', 'code', 'A1', 'name', 'Fixture area', 'code_basis', 'publisher_code')),
    'catalogue_entries', jsonb_build_array(
      jsonb_build_object('source_id', 'pgtap_stats', 'entry_key', 'e1', 'entry_kind', 'file_metadata', 'title', 'Fixture file (old title)', 'url', 'https://fixture.example/stats/file.csv', 'found_on_url', 'https://fixture.example/stats',
        'format', 'csv', 'file_sha256', null, 'publisher_modified_text', null, 'attributes', jsonb_build_object('topic', 'fixture'), 'observed_first_at', '2026-01-01T00:00:00Z',
        'observed_last_at', '2026-01-01T00:00:00Z', 'observation_count', 1, 'content_hash', 'sha256:' || repeat('1', 64)),
      jsonb_build_object('source_id', 'pgtap_stats', 'entry_key', 'e1', 'entry_kind', 'file_metadata', 'title', 'Fixture file', 'url', 'https://fixture.example/stats/file.csv', 'found_on_url', 'https://fixture.example/stats',
        'format', 'csv', 'file_sha256', null, 'publisher_modified_text', null, 'attributes', jsonb_build_object('topic', 'fixture'), 'observed_first_at', '2026-01-02T00:00:00Z',
        'observed_last_at', '2026-01-03T00:00:00Z', 'observation_count', 2, 'content_hash', 'sha256:' || repeat('2', 64))));
  v_obs := jsonb_build_array(
    jsonb_build_object('dataset_key', 'fixture.dataset', 'release_key', 'r1', 'series_key', 's1', 'geography', jsonb_build_object('scheme', 'pgtap_stats:area', 'edition', 'fixture edition', 'code', 'A1'),
      'period_label', '2001', 'period_start', null, 'period_end', null, 'value', '12.500000000001', 'value_double', null, 'raw_value', '12.500000000001', 'value_status', 'reported',
      'parse_status', 'parsed', 'source_status', 'FINAL', 'source_symbol', null, 'upstream_status', 'observed', 'qualifiers', jsonb_build_object('SE', '0.1'), 'row_locator', 'file.csv row 2',
      'content_hash', 'sha256:' || repeat('a', 64)),
    jsonb_build_object('dataset_key', 'fixture.dataset', 'release_key', 'r1', 'series_key', 's1', 'geography', jsonb_build_object('scheme', 'pgtap_stats:area', 'edition', 'fixture edition', 'code', 'A1'),
      'period_label', '2006', 'period_start', null, 'period_end', null, 'value', null, 'value_double', null, 'raw_value', '..C', 'value_status', 'confidential',
      'parse_status', 'unparsed_symbol', 'source_status', null, 'source_symbol', '..C', 'upstream_status', 'confidentialised', 'qualifiers', '{}'::jsonb, 'row_locator', 'file.csv row 3',
      'content_hash', 'sha256:' || repeat('b', 64)),
    jsonb_build_object('dataset_key', 'fixture.dataset', 'release_key', 'r1', 'series_key', 's1', 'geography', null,
      'period_label', '2013', 'period_start', null, 'period_end', null, 'value', '0', 'value_double', null, 'raw_value', '0', 'value_status', 'reported',
      'parse_status', 'parsed', 'source_status', null, 'source_symbol', null, 'upstream_status', 'observed', 'qualifiers', '{}'::jsonb, 'row_locator', 'file.csv row 4',
      'content_hash', 'sha256:' || repeat('c', 64)));

  perform evidence_private.acquire_lease('pgtap_stats', v_holder, 120);
  v_run := (evidence_private.start_run('pgtap_stats', v_holder, 'v1', 'export_import', 'test', 'm1') ->> 'run_id')::uuid;
  v_result := evidence_private.ingest_stat_meta(v_run, v_holder, v_meta);
  insert into outcome values ('meta_entries_written', (v_result ->> 'catalogue_entries_inserted') || '/' || (v_result ->> 'catalogue_entries_seen'));
  v_result := evidence_private.ingest_stat_observations(v_run, v_holder, v_obs);
  insert into outcome values ('first_inserted', v_result ->> 'inserted');

  -- Replay of the identical rows: nothing is written, everything is unchanged.
  v_result := evidence_private.ingest_stat_observations(v_run, v_holder, v_obs);
  insert into outcome values ('replay_inserted', v_result ->> 'inserted'), ('replay_unchanged', v_result ->> 'unchanged');
  v_result := evidence_private.ingest_stat_meta(v_run, v_holder, v_meta);
  insert into outcome values ('replay_entries_written', (v_result ->> 'catalogue_entries_inserted') || '/' || (v_result ->> 'catalogue_entries_unchanged') || '/' || (v_result ->> 'catalogue_entries_span_widened'));

  -- Same identity, different content: kept as stored, counted as a conflict, never overwritten.
  v_result := evidence_private.ingest_stat_observations(v_run, v_holder, jsonb_build_array(
    (v_obs -> 0) || jsonb_build_object('value', '99', 'content_hash', 'sha256:' || repeat('d', 64))));
  insert into outcome values ('conflict_count', v_result ->> 'conflicts'), ('conflict_inserted', v_result ->> 'inserted');

  for v_case in select * from (values
    ('withheld_with_number', format($q$select evidence_private.ingest_stat_observations(%L, %L, %L)$q$, v_run, v_holder,
        jsonb_build_array((v_obs -> 1) || jsonb_build_object('period_label', '2018', 'value', '0', 'content_hash', 'sha256:' || repeat('e', 64))))),
    ('reported_without_number', format($q$select evidence_private.ingest_stat_observations(%L, %L, %L)$q$, v_run, v_holder,
        jsonb_build_array((v_obs -> 0) || jsonb_build_object('period_label', '2018', 'value', null, 'content_hash', 'sha256:' || repeat('e', 64))))),
    ('unregistered_series', format($q$select evidence_private.ingest_stat_observations(%L, %L, %L)$q$, v_run, v_holder,
        jsonb_build_array((v_obs -> 0) || jsonb_build_object('series_key', 'never-registered', 'content_hash', 'sha256:' || repeat('e', 64))))),
    ('duplicate_identity_in_batch', format($q$select evidence_private.ingest_stat_observations(%L, %L, %L)$q$, v_run, v_holder,
        jsonb_build_array((v_obs -> 0) || jsonb_build_object('period_label', '2019'), (v_obs -> 0) || jsonb_build_object('period_label', '2019', 'content_hash', 'sha256:' || repeat('e', 64))))),
    ('route_switch', format($q$select evidence_private.ingest_stat_meta(%L, %L, %L)$q$, v_run, v_holder,
        jsonb_build_object('routes', jsonb_build_array((v_meta -> 'routes' -> 0) || jsonb_build_object('canonical_route', 'operational', 'overlapping_routes', jsonb_build_array()))))),
    ('release_other_file', format($q$select evidence_private.ingest_stat_meta(%L, %L, %L)$q$, v_run, v_holder,
        jsonb_build_object('releases', jsonb_build_array((v_meta -> 'releases' -> 0) || jsonb_build_object('source_file_sha256', repeat('9', 64)))))),
    ('series_other_unit', format($q$select evidence_private.ingest_stat_meta(%L, %L, %L)$q$, v_run, v_holder,
        jsonb_build_object('series', jsonb_build_array((v_meta -> 'series' -> 0) || jsonb_build_object('unit', 'percent'))))),
    ('collected_time_as_release_date', format($q$select evidence_private.ingest_stat_meta(%L, %L, %L)$q$, v_run, v_holder,
        jsonb_build_object('releases', jsonb_build_array((v_meta -> 'releases' -> 0) || jsonb_build_object('release_key', 'r2', 'released_on', '2026-01-02'))))),
    ('row_of_another_source', format($q$select evidence_private.ingest_stat_meta(%L, %L, %L)$q$, v_run, v_holder,
        jsonb_build_object('datasets', jsonb_build_array((v_meta -> 'datasets' -> 0) || jsonb_build_object('source_id', 'pgtap_stats_other'))))),
    ('contact_text', format($q$select evidence_private.ingest_stat_meta(%L, %L, %L)$q$, v_run, v_holder,
        jsonb_build_object('series', jsonb_build_array((v_meta -> 'series' -> 0) || jsonb_build_object('series_key', 's2', 'title', 'write to fixture.person@fixture.example'))))),
    ('catalogue_asserting_facts', $q$update evidence_private.stat_catalogue_entries set facts_asserted = true$q$),
    ('update_observation', $q$update evidence_private.stat_observations set value = 1$q$),
    ('delete_observation', $q$delete from evidence_private.stat_observations$q$)
  ) as t(name, statement) loop
    begin
      execute v_case.statement;
      insert into outcome values (v_case.name, 'allowed');
    exception when others then
      insert into outcome values (v_case.name, 'refused');
    end;
  end loop;

  insert into outcome values ('counts', evidence_private.stat_source_counts('pgtap_stats')::text);
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', false, 'fixture', null, null);
end
$$;
reset role;

select is((select state from outcome where name = 'meta_entries_written'), '2/2', 'two content versions of one catalogue entry are both kept: two seen, two inserted');
select is((select state from outcome where name = 'first_inserted'), '3', 'three observations stored on first load');
select is((select state from outcome where name = 'replay_inserted') || '/' || (select state from outcome where name = 'replay_unchanged'), '0/3', 'a replay inserts nothing and reports every row unchanged');
select is((select state from outcome where name = 'replay_entries_written'), '0/2/0', 'a replay inserts no catalogue entry version: both are unchanged and no span widened');
select is((select state from outcome where name = 'conflict_count') || '/' || (select state from outcome where name = 'conflict_inserted'), '1/0', 'same identity with other content is a counted conflict, not an overwrite');
select is((select value::text from evidence_private.stat_observations where row_locator = 'file.csv row 2'), '12.500000000001', 'the stored number is the exact published decimal');
select is((select count(*)::integer from evidence_private.ingest_errors where error_class = 'stat_identity_conflict'), 1, 'the conflict is on the error ledger');
select is((select state from outcome where name = 'withheld_with_number'), 'refused', 'a confidential value can never be stored as zero');
select is((select state from outcome where name = 'reported_without_number'), 'refused', 'a reported value must carry its number');
select is((select state from outcome where name = 'unregistered_series'), 'refused', 'an observation of an unregistered series refuses the whole batch');
select is((select state from outcome where name = 'duplicate_identity_in_batch'), 'refused', 'two rows of one identity are refused, never summed');
select is((select state from outcome where name = 'route_switch'), 'refused', 'an import cannot switch the canonical route of a family');
select is((select state from outcome where name = 'release_other_file'), 'refused', 'a release key cannot be repointed at another file');
select is((select state from outcome where name = 'series_other_unit'), 'refused', 'a series unit is never overwritten');
select is((select state from outcome where name = 'collected_time_as_release_date'), 'refused', 'a release date needs a publisher-stated basis');
select is((select state from outcome where name = 'row_of_another_source'), 'refused', 'a run cannot write rows of another source');
select is((select state from outcome where name = 'contact_text'), 'refused', 'contact-like text is refused');
select is((select state from outcome where name = 'catalogue_asserting_facts'), 'refused', 'a catalogue entry can never assert facts');
select is((select state from outcome where name = 'update_observation') || '/' || (select state from outcome where name = 'delete_observation'), 'refused/refused', 'the worker cannot edit or delete a stored observation');
select is((select title from evidence_private.stat_catalogue_entries where entry_key = 'e1' and is_current), 'Fixture file', 'the version observed last is the current one');
select is((select (state::jsonb ->> 'observations') || '/' || (state::jsonb ->> 'withheld_rows_carrying_a_number') || '/' || (state::jsonb -> 'observations_by_status' ->> 'confidential')
             from outcome where name = 'counts'), '3/0/1', 'destination counts: three rows, one confidential, no withheld row carries a number');

select * from finish();
rollback;
