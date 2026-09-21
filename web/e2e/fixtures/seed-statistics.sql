-- TEST FIXTURE for the local disposable stack only: one synthetic statistics source, loaded through the REAL typed writer
-- (ingest_stat_meta / ingest_stat_observations) and summarised by the real summary function. Describes no real statistic.
--   * source_id starts with `fixture_`, the publisher is a fixture, every URL is under fixture.example
--   * three observations: a reported number, a confidential cell (no number), and a published zero
do $$
declare
  v_holder uuid := '55555555-5555-4555-8555-555555555555';
  v_run uuid;
begin
  perform evidence_private.sync_registry(jsonb_build_object(
    'rights', jsonb_build_array(jsonb_build_object('rights_id', 'RIGHTS-97', 'publisher', 'Fixture Statistics Office (TEST FIXTURE)',
      'source_url', 'https://stats.fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'fixture-97')),
    'registry_products', jsonb_build_array(jsonb_build_object('registry_key', 'statistics', 'title', 'Official statistics and statistical catalogues', 'domain', 'Statistics')),
    'sources', jsonb_build_array(jsonb_build_object('source_id', 'fixture_statistics', 'registry_key', 'statistics', 'title', 'TEST FIXTURE statistics source',
      'publisher', 'Fixture Statistics Office (TEST FIXTURE)', 'official_url', 'https://stats.fixture.example/data', 'adapter_kind', 'export_import',
      'adapter_name', 'stats_family_artifact', 'allowed_hosts', jsonb_build_array(), 'rights_id', 'RIGHTS-97', 'view_scope', 'statistics',
      'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'fixture-statistics'))));
  if exists (select 1 from evidence_private.import_runs where source_id = 'fixture_statistics') then
    return;
  end if;
  perform evidence_private.acquire_lease('fixture_statistics', v_holder, 120);
  v_run := (evidence_private.start_run('fixture_statistics', v_holder, 'fixture', 'export_import', 'test', 'fixture-statistics') ->> 'run_id')::uuid;
  perform evidence_private.ingest_stat_meta(v_run, v_holder, jsonb_build_object(
    'routes', jsonb_build_array(jsonb_build_object('observation_family', 'fixture.statistics', 'canonical_route', 'operational', 'overlapping_routes', jsonb_build_array(),
      'upstream_rows_by_route', jsonb_build_object('operational', 3), 'decision_note', 'TEST FIXTURE')),
    'datasets', jsonb_build_array(jsonb_build_object('source_id', 'fixture_statistics', 'dataset_key', 'fixture.statistics', 'title', 'WITHHELD Fixture dataset (TEST FIXTURE)',
      'publisher', 'Fixture Statistics Office (TEST FIXTURE)', 'official_url', 'https://stats.fixture.example/data', 'route', 'operational', 'historical', false, 'coverage_note', null)),
    'releases', jsonb_build_array(jsonb_build_object('dataset_key', 'fixture.statistics', 'release_key', 'fixture-r1', 'vintage_label', 'Fixture release', 'released_on', null,
      'released_on_basis', 'publisher_label_only', 'source_url', 'https://stats.fixture.example/data/file.csv', 'source_file_sha256', repeat('a', 64), 'source_bytes', 10,
      'retrieved_at', '2026-01-02T00:00:00Z', 'publisher_last_modified', null, 'boundary_edition', null, 'capture_count', 1)),
    'series', jsonb_build_array(jsonb_build_object('dataset_key', 'fixture.statistics', 'series_key', 'fixture-s1', 'title', 'WITHHELD Fixture series (TEST FIXTURE)', 'unit', 'count',
      'magnitude', null, 'seasonal_adjustment', null, 'frequency', 'annual', 'dimensions', jsonb_build_object('measure', 'fixture'))),
    'geographies', jsonb_build_array(), 'catalogue_entries', jsonb_build_array()));
  perform evidence_private.ingest_stat_observations(v_run, v_holder, jsonb_build_array(
    jsonb_build_object('dataset_key', 'fixture.statistics', 'release_key', 'fixture-r1', 'series_key', 'fixture-s1', 'geography', null, 'period_label', '2001', 'period_start', null, 'period_end', null,
      'value', '4321', 'value_double', null, 'raw_value', '4321', 'value_status', 'reported', 'parse_status', 'parsed', 'source_status', null, 'source_symbol', null,
      'upstream_status', 'observed', 'qualifiers', '{}'::jsonb, 'row_locator', 'file.csv row 2', 'content_hash', 'sha256:' || repeat('a', 64)),
    jsonb_build_object('dataset_key', 'fixture.statistics', 'release_key', 'fixture-r1', 'series_key', 'fixture-s1', 'geography', null, 'period_label', '2006', 'period_start', null, 'period_end', null,
      'value', null, 'value_double', null, 'raw_value', '..C', 'value_status', 'confidential', 'parse_status', 'unparsed_symbol', 'source_status', null, 'source_symbol', '..C',
      'upstream_status', 'confidentialised', 'qualifiers', '{}'::jsonb, 'row_locator', 'file.csv row 3', 'content_hash', 'sha256:' || repeat('b', 64)),
    jsonb_build_object('dataset_key', 'fixture.statistics', 'release_key', 'fixture-r1', 'series_key', 'fixture-s1', 'geography', null, 'period_label', '2013', 'period_start', null, 'period_end', null,
      'value', '0', 'value_double', null, 'raw_value', '0', 'value_status', 'reported', 'parse_status', 'parsed', 'source_status', null, 'source_symbol', null,
      'upstream_status', 'observed', 'qualifiers', '{}'::jsonb, 'row_locator', 'file.csv row 4', 'content_hash', 'sha256:' || repeat('c', 64))));
  perform evidence_private.record_stat_source_summary(v_run, v_holder);
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', false, null, null, null);
end
$$;
