-- Erasure path: administrator-only, blanks the projection, keeps lineage, logs the event.
-- TEST FIXTURES ONLY: synthetic, rolled back.
begin;
select plan(7);

select evidence_private.sync_registry(jsonb_build_object('sources', jsonb_build_array(
  jsonb_build_object('source_id', 'fixture_redact', 'title', 'Fixture', 'publisher', 'Fixture Publisher',
    'official_url', 'https://fixture.example/', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
    'allowed_hosts', jsonb_build_array('fixture.example'), 'view_scope', 'general',
    'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'c'))));
select evidence_private.acquire_lease('fixture_redact', '66666666-6666-6666-6666-666666666666', 60);
create temp table t as select evidence_private.start_run('fixture_redact', '66666666-6666-6666-6666-666666666666', 'v1', 'incremental', 'test', 'm') as v;
select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t), '66666666-6666-6666-6666-666666666666',
  jsonb_build_array(jsonb_build_object('external_record_id', 'r-1', 'record_kind', 'fixture_item',
    'content_hash', 'sha256:' || repeat('9', 64), 'source_url', 'https://fixture.example/r-1',
    'retrieved_at', now(), 'safe_payload', jsonb_build_object('title', 'TEST FIXTURE to be redacted'))));

select throws_ok($$update evidence_private.source_record_versions set safe_payload = '{"redacted": true}'::jsonb$$,
  'P0001', null, 'the redacted shape alone does not unlock an update');
select throws_ok($$select set_config('evidence.redaction_in_progress', 'on', true);
  update evidence_private.source_record_versions set safe_payload = '{"title": "rewritten"}'::jsonb$$,
  null, null, 'the redaction flag cannot be used to rewrite content');
select throws_ok($$select evidence_private.redact_version((select v.id from evidence_private.source_record_versions v
  join evidence_private.source_records r on r.id = v.record_id where r.source_id = 'fixture_redact'), 'short', 'x')$$,
  'P0001', null, 'redaction needs a real reason');
select lives_ok($$select evidence_private.redact_version((select v.id from evidence_private.source_record_versions v
  join evidence_private.source_records r on r.id = v.record_id where r.source_id = 'fixture_redact'),
  'fixture privacy request reference 0001', 'fixture administrator')$$, 'administrator can redact');
select is((select v.safe_payload from evidence_private.source_record_versions v join evidence_private.source_records r on r.id = v.record_id
            where r.source_id = 'fixture_redact'), '{"redacted": true}'::jsonb, 'projection is blanked');
select is((select count(*)::int from evidence_private.record_lifecycle_events e join evidence_private.source_records r on r.id = e.record_id
            where r.source_id = 'fixture_redact' and e.event = 'redacted'), 1, 'redaction is logged');
select is((select has_function_privilege('evidence_ingest', 'evidence_private.redact_version(uuid, text, text)', 'execute')
               or has_function_privilege('authenticated', 'evidence_private.redact_version(uuid, text, text)', 'execute')
               or has_function_privilege('anon', 'evidence_private.redact_version(uuid, text, text)', 'execute')), false,
  'no scoped or browser role can redact');

select * from finish();
rollback;
