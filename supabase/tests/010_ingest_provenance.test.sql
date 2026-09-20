-- Ingestion ledger: leases, idempotent replay, versioning, payload guard, tombstones, freshness.
-- TEST FIXTURES ONLY: every source, URL path and record below is synthetic and rolled back.
begin;
select plan(36);

-- Runs as the migration role. The scoped worker role is exercised in 030_ingest_role.test.sql.

select evidence_private.sync_registry(jsonb_build_object(
  'rights', jsonb_build_array(jsonb_build_object(
    'rights_id', 'RIGHTS-90', 'publisher', 'Fixture Publisher', 'source_url', 'https://fixture.example/',
    'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h1')),
  'sources', jsonb_build_array(
    jsonb_build_object('source_id', 'pgtap_snapshot', 'title', 'Fixture snapshot source', 'publisher', 'Fixture Publisher',
      'official_url', 'https://fixture.example/list', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-90', 'view_scope', 'general',
      'expected_cadence_seconds', 3600, 'snapshot_semantics', 'complete_snapshot', 'enabled', true, 'config_hash', 'c1'),
    jsonb_build_object('source_id', 'pgtap_feed', 'title', 'Fixture feed source', 'publisher', 'Fixture Publisher',
      'official_url', 'https://fixture.example/feed', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-90', 'view_scope', 'general',
      'expected_cadence_seconds', 3600, 'snapshot_semantics', 'append_only_feed', 'enabled', true, 'config_hash', 'c2'))));

create temp table t (k text primary key, v jsonb);

create function pg_temp.rec(p_id text, p_hash_char text, p_payload jsonb, p_at timestamptz default now())
returns jsonb language sql as $$
  select jsonb_build_object('external_record_id', p_id, 'record_kind', 'fixture_item',
    'content_hash', 'sha256:' || repeat(p_hash_char, 64), 'source_url', 'https://fixture.example/item/' || p_id,
    'retrieved_at', p_at, 'safe_payload', p_payload, 'projection_version', 1);
$$;

-- Leases and overlap prevention
select ok(evidence_private.acquire_lease('pgtap_snapshot', '11111111-1111-1111-1111-111111111111', 60), 'first worker gets the lease');
select ok(not evidence_private.acquire_lease('pgtap_snapshot', '22222222-2222-2222-2222-222222222222', 60), 'second worker is refused while the lease is live');
select throws_ok($$select evidence_private.start_run('pgtap_snapshot', '22222222-2222-2222-2222-222222222222', 'v1', 'incremental', 'test', 'm1')$$,
  'P0001', null, 'a worker without the lease cannot start a run');
select throws_ok($$select evidence_private.acquire_lease('pgtap_snapshot', '11111111-1111-1111-1111-111111111111', 999999)$$,
  'P0001', null, 'lease ttl is bounded');

insert into t select 'run1', evidence_private.start_run('pgtap_snapshot', '11111111-1111-1111-1111-111111111111', 'v1', 'incremental', 'test', 'm1');

-- First ingest: twelve records
insert into t select 'b1', evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'run1'),
  '11111111-1111-1111-1111-111111111111',
  (select jsonb_agg(pg_temp.rec('item-' || g, 'a', jsonb_build_object('title', 'Item ' || g))) from generate_series(1, 12) g));
select is((select (v ->> 'versions_inserted')::int from t where k = 'b1'), 12, 'first ingest inserts twelve versions');

-- Same batch again inside the run: nothing new
insert into t select 'b1again', evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'run1'),
  '11111111-1111-1111-1111-111111111111',
  (select jsonb_agg(pg_temp.rec('item-' || g, 'a', jsonb_build_object('title', 'Item ' || g))) from generate_series(1, 12) g));
select is((select (v ->> 'versions_inserted')::int from t where k = 'b1again'), 0, 'in-run replay inserts no versions');
select is((select (v ->> 'observations_inserted')::int from t where k = 'b1again'), 0, 'in-run replay inserts no observations');

-- Payload guard and host allowlist
insert into t select 'bad', evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'run1'),
  '11111111-1111-1111-1111-111111111111', jsonb_build_array(
    pg_temp.rec('bad-1', 'b', jsonb_build_object('title', 'x', 'email', 'someone')),
    pg_temp.rec('bad-2', 'b', jsonb_build_object('title', 'reach me at person@example.org')),
    pg_temp.rec('bad-3', 'b', jsonb_build_object('title', 'x', 'location', '/home' || '/someone/archive/file.pdf')),
    pg_temp.rec('bad-4', 'b', jsonb_build_object('title', 'x', 'body', 'full text')),
    pg_temp.rec('bad-5', 'b', jsonb_build_object('title', repeat('x', 9000))),
    jsonb_set(pg_temp.rec('bad-6', 'b', jsonb_build_object('title', 'x')), '{source_url}', '"https://elsewhere.example/x"')));
select is((select (v ->> 'rejected')::int from t where k = 'bad'), 6, 'contact fields, email values, file locations, bodies, oversize payloads and off-allowlist hosts are rejected');
select is((select count(*)::int from evidence_private.source_records where external_record_id like 'bad-%'), 0, 'rejected records are not stored');
select is((select count(*)::int from evidence_private.ingest_errors where error_class = 'record_rejected' and source_id = 'pgtap_snapshot'), 6, 'each rejection is recorded');

-- Conflicting duplicate inside one run
insert into t select 'dup', evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'run1'),
  '11111111-1111-1111-1111-111111111111', jsonb_build_array(pg_temp.rec('item-1', 'c', jsonb_build_object('title', 'Different'))));
select is((select (v ->> 'rejected')::int from t where k = 'dup'), 1, 'a second, different content for the same record in one run is rejected');

select lives_ok($$select evidence_private.save_checkpoint((select (v ->> 'run_id')::uuid from t where k = 'run1'),
  '11111111-1111-1111-1111-111111111111', '{"page": 2}'::jsonb, 12, 60)$$, 'checkpoint saved');

insert into t select 'fin1', evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'run1'),
  '11111111-1111-1111-1111-111111111111', 'succeeded', true, 'wm1', null, null);
select is((select v ->> 'status' from t where k = 'fin1'), 'succeeded', 'run one succeeds');
select is((select count(*)::int from evidence_private.source_leases where source_id = 'pgtap_snapshot'), 0, 'finishing releases the lease');
select throws_ok($$select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'run1'),
  '11111111-1111-1111-1111-111111111111', '[]'::jsonb)$$, 'P0001', null, 'a finished run accepts no more writes');

-- Replay in a new run: identical content, later retrieval time
select evidence_private.acquire_lease('pgtap_snapshot', '11111111-1111-1111-1111-111111111111', 60);
insert into t select 'run2', evidence_private.start_run('pgtap_snapshot', '11111111-1111-1111-1111-111111111111', 'v1', 'incremental', 'test', 'm1');
insert into t select 'b2', evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'run2'),
  '11111111-1111-1111-1111-111111111111',
  (select jsonb_agg(pg_temp.rec('item-' || g, 'a', jsonb_build_object('title', 'Item ' || g), now() + interval '1 hour')) from generate_series(1, 12) g));
select is((select (v ->> 'versions_inserted')::int from t where k = 'b2'), 0, 'idempotent replay: a timestamp-only refresh creates no version');
select is((select (v ->> 'unchanged')::int from t where k = 'b2'), 12, 'replay reports twelve unchanged');
select is((select (v ->> 'observations_inserted')::int from t where k = 'b2'), 12, 'replay records twelve new sightings');
select is((select count(*)::int from evidence_private.source_record_versions v join evidence_private.source_records r on r.id = v.record_id
            where r.source_id = 'pgtap_snapshot'), 12, 'still exactly twelve versions');
select evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'run2'),
  '11111111-1111-1111-1111-111111111111', 'succeeded', true, 'wm1', null, null);

-- Changed content and one absent record
select evidence_private.acquire_lease('pgtap_snapshot', '11111111-1111-1111-1111-111111111111', 60);
insert into t select 'run3', evidence_private.start_run('pgtap_snapshot', '11111111-1111-1111-1111-111111111111', 'v1', 'incremental', 'test', 'm1');
select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'run3'), '11111111-1111-1111-1111-111111111111',
  (select jsonb_agg(pg_temp.rec('item-' || g, case when g = 1 then 'd' else 'a' end,
      jsonb_build_object('title', case when g = 1 then 'Item 1 (amended)' else 'Item ' || g end), now() + interval '2 hours'))
   from generate_series(1, 11) g));
insert into t select 'fin3', evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'run3'),
  '11111111-1111-1111-1111-111111111111', 'succeeded', true, 'wm2', null, null);
select is((select count(*)::int from evidence_private.source_record_versions v join evidence_private.source_records r on r.id = v.record_id
            where r.external_record_id = 'item-1'), 2, 'changed content appends a second version');
select is((select v.predecessor_id is not null from evidence_private.source_records r
            join evidence_private.source_record_versions v on v.id = r.current_version_id where r.external_record_id = 'item-1'),
  true, 'the new current version points at its predecessor');
select is((select (v ->> 'tombstoned')::int from t where k = 'fin3'), 1, 'one record absent from a complete snapshot is tombstoned');
select is((select tombstone_reason from evidence_private.source_records where external_record_id = 'item-12'),
  'absent_from_complete_snapshot', 'tombstone reason recorded');
select is((select count(*)::int from evidence_private.source_record_versions v join evidence_private.source_records r on r.id = v.record_id
            where r.external_record_id = 'item-12'), 1, 'tombstoning keeps the history');

-- Blocked run: endpoint unavailable is not "no records"
select evidence_private.acquire_lease('pgtap_snapshot', '11111111-1111-1111-1111-111111111111', 60);
insert into t select 'run4', evidence_private.start_run('pgtap_snapshot', '11111111-1111-1111-1111-111111111111', 'v1', 'incremental', 'test', 'm1');
insert into t select 'fin4', evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'run4'),
  '11111111-1111-1111-1111-111111111111', 'blocked', true, null, 'publisher_challenge', 'HTTP 403 interstitial');
select is((select (v ->> 'tombstoned')::int from t where k = 'fin4'), 0, 'a blocked run tombstones nothing');
select is((select count(*)::int from evidence_private.source_records where source_id = 'pgtap_snapshot' and tombstoned_at is null), 11,
  'all live records stay live after a blocked run');
select is((select complete_snapshot from evidence_private.import_runs where id = (select (v ->> 'run_id')::uuid from t where k = 'run4')),
  false, 'a blocked run is never recorded as a complete snapshot');
select is((select last_attempt_status || '/' || consecutive_failures from evidence_private.source_freshness where source_id = 'pgtap_snapshot'),
  'blocked/1', 'freshness records the failed attempt');
select ok((select last_success_at is not null from evidence_private.source_freshness where source_id = 'pgtap_snapshot'),
  'the earlier success time is kept');

-- Safety valve: an almost-empty "complete" snapshot is suspect
select evidence_private.acquire_lease('pgtap_snapshot', '11111111-1111-1111-1111-111111111111', 60);
insert into t select 'run5', evidence_private.start_run('pgtap_snapshot', '11111111-1111-1111-1111-111111111111', 'v1', 'incremental', 'test', 'm1');
select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'run5'), '11111111-1111-1111-1111-111111111111',
  jsonb_build_array(pg_temp.rec('item-2', 'a', jsonb_build_object('title', 'Item 2'), now() + interval '3 hours')));
insert into t select 'fin5', evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'run5'),
  '11111111-1111-1111-1111-111111111111', 'succeeded', true, null, null, null);
select is((select v ->> 'status' from t where k = 'fin5'), 'partial', 'mass disappearance downgrades the run instead of tombstoning');
select is((select count(*)::int from evidence_private.source_records where source_id = 'pgtap_snapshot' and tombstoned_at is null), 11,
  'safety valve wrote no tombstones');

-- Reappearance
select evidence_private.acquire_lease('pgtap_snapshot', '11111111-1111-1111-1111-111111111111', 60);
insert into t select 'run6', evidence_private.start_run('pgtap_snapshot', '11111111-1111-1111-1111-111111111111', 'v1', 'incremental', 'test', 'm1');
select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'run6'), '11111111-1111-1111-1111-111111111111',
  jsonb_build_array(pg_temp.rec('item-12', 'a', jsonb_build_object('title', 'Item 12'), now() + interval '4 hours')));
select is((select tombstoned_at from evidence_private.source_records where external_record_id = 'item-12'), null, 'a record seen again is live again');
select is((select string_agg(e.event, ',' order by e.id) from evidence_private.record_lifecycle_events e
            join evidence_private.source_records r on r.id = e.record_id where r.external_record_id = 'item-12'),
  'tombstoned,reappeared', 'lifecycle history keeps both events');

-- Feeds never tombstone
select evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'run6'), '11111111-1111-1111-1111-111111111111', 'partial', false, null, null, null);
select evidence_private.acquire_lease('pgtap_feed', '11111111-1111-1111-1111-111111111111', 60);
insert into t select 'feed1', evidence_private.start_run('pgtap_feed', '11111111-1111-1111-1111-111111111111', 'v1', 'incremental', 'test', 'm1');
select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'feed1'), '11111111-1111-1111-1111-111111111111',
  (select jsonb_agg(pg_temp.rec('feed-' || g, 'e', jsonb_build_object('title', 'Feed ' || g))) from generate_series(1, 3) g));
select evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'feed1'), '11111111-1111-1111-1111-111111111111', 'succeeded', true, null, null, null);
select evidence_private.acquire_lease('pgtap_feed', '11111111-1111-1111-1111-111111111111', 60);
insert into t select 'feed2', evidence_private.start_run('pgtap_feed', '11111111-1111-1111-1111-111111111111', 'v1', 'incremental', 'test', 'm1');
insert into t select 'feedfin', evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'feed2'), '11111111-1111-1111-1111-111111111111', 'succeeded', true, null, null, null);
select is((select (v ->> 'tombstoned')::int from t where k = 'feedfin'), 0, 'items that scroll off a feed are never tombstoned');

-- History is immutable for every role, including the owner
select throws_ok($$update evidence_private.source_record_versions set safe_payload = '{}'::jsonb$$, 'P0001', null, 'versions cannot be updated');
select throws_ok($$delete from evidence_private.source_observations$$, 'P0001', null, 'observations cannot be deleted');

select * from finish();
rollback;
