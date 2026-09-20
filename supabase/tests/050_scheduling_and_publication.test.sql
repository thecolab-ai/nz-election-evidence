-- Schedules stay inactive without readback proof; the release path fails closed.
-- TEST FIXTURES ONLY: synthetic, rolled back.
begin;
select plan(17);

select is((select count(*)::int from cron.job where command like '%evidence_private%'), 0, 'migrations schedule no cron job');

select evidence_private.sync_registry(jsonb_build_object(
  'rights', jsonb_build_array(jsonb_build_object('rights_id', 'RIGHTS-91', 'publisher', 'Fixture Publisher',
    'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h1')),
  'sources', jsonb_build_array(jsonb_build_object('source_id', 'fixture_sched', 'title', 'Fixture scheduled source',
    'publisher', 'Fixture Publisher', 'official_url', 'https://fixture.example/list', 'adapter_kind', 'live_fetch',
    'adapter_name', 'fixture', 'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-91',
    'view_scope', 'general', 'snapshot_semantics', 'append_only_feed', 'enabled', true, 'config_hash', 'c1'))));
select evidence_private.sync_schedules(jsonb_build_array(jsonb_build_object('schedule_key', 'fixture-sched-hourly',
  'source_id', 'fixture_sched', 'cron_expr', '17 * * * *', 'function_slug', 'ingest-run',
  'max_runtime_seconds', 120, 'max_records', 500, 'config_hash', 's1')));

select is((select state from evidence_private.ingest_schedules where schedule_key = 'fixture-sched-hourly'), 'inactive', 'a synced schedule is inactive');
select throws_ok($$update evidence_private.ingest_schedules set state = 'active' where schedule_key = 'fixture-sched-hourly'$$,
  '23514', null, 'a schedule cannot be marked active without proof and a cron job id');
select is(evidence_private.dispatch_ingest('fixture-sched-hourly'), 'skipped_inactive', 'an inactive schedule dispatches nothing');
select throws_ok($$select evidence_private.activate_schedule('fixture-sched-hourly', gen_random_uuid(), 'fn-v1', 'fixture admin')$$,
  'P0001', null, 'activation without a readback run is refused');

-- a CLI run is not deployment proof
select evidence_private.acquire_lease('fixture_sched', '55555555-5555-5555-5555-555555555555', 60);
create temp table t as select 'cli'::text as k, evidence_private.start_run('fixture_sched', '55555555-5555-5555-5555-555555555555', 'v1', 'incremental', 'cli', 'm') as v;
select evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'cli'), '55555555-5555-5555-5555-555555555555', 'succeeded', false, null, null, null);
select throws_ok(format($$select evidence_private.activate_schedule('fixture-sched-hourly', %L, 'fn-v1', 'fixture admin')$$, (select v ->> 'run_id' from t where k = 'cli')),
  'P0001', null, 'a CLI run does not prove the function is deployed');

-- a function readback run without vault secrets is still refused
select evidence_private.acquire_lease('fixture_sched', '55555555-5555-5555-5555-555555555555', 60);
insert into t select 'rb', evidence_private.start_run('fixture_sched', '55555555-5555-5555-5555-555555555555', 'v1', 'incremental', 'function_readback', 'm');
select evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'rb'), '55555555-5555-5555-5555-555555555555', 'succeeded', false, null, null, null);
select throws_ok(format($$select evidence_private.activate_schedule('fixture-sched-hourly', %L, 'fn-v1', 'fixture admin')$$, (select v ->> 'run_id' from t where k = 'rb')),
  'P0001', null, 'activation without vault secrets is refused');

select ok(evidence_private.functions_base_url_ok('https://abcdefghijklmnopqrst.supabase.co/functions/v1'), 'project functions endpoint accepted');
select ok(not evidence_private.functions_base_url_ok('https://abcdefghijklmnopqrst.supabase.co.attacker.example/functions/v1'), 'look-alike host refused');
select ok(not evidence_private.functions_base_url_ok('http://169.254.169.254/latest/meta-data'), 'metadata address refused');
select ok(not evidence_private.functions_base_url_ok('https://internal.example/functions/v1'), 'arbitrary host refused');

-- with secrets and readback proof, activation registers exactly one job; deactivation removes it
select vault.create_secret('https://abcdefghijklmnopqrst.supabase.co/functions/v1', 'evidence_functions_base_url');
select vault.create_secret(repeat('fixture-only-not-a-real-secret-', 2), 'evidence_cron_secret');
select lives_ok(format($$select evidence_private.activate_schedule('fixture-sched-hourly', %L, 'fn-v1', 'fixture admin')$$, (select v ->> 'run_id' from t where k = 'rb')),
  'activation succeeds with readback proof and vault secrets');
select is((select count(*)::int from cron.job where jobname = 'fixture-sched-hourly'), 1, 'one cron job registered');
select evidence_private.deactivate_schedule('fixture-sched-hourly');
select is((select count(*)::int from cron.job where jobname = 'fixture-sched-hourly'), 0, 'deactivation removes the cron job');

-- publication fails closed
insert into evidence_private.release_batches (id, created_by) values ('eeeeeeee-0000-0000-0000-000000000001', 'fixture publisher');
insert into evidence_private.release_items (batch_id, item_kind, source_id) values ('eeeeeeee-0000-0000-0000-000000000001', 'source', 'fixture_sched');
select throws_ok($$select evidence_private.publish_batch('eeeeeeee-0000-0000-0000-000000000001')$$, 'P0001',
  'release gates are closed: R8/R10 review and the election-day check must be recorded first', 'closed gates block publication');
update evidence_private.release_gates set state = 'open', evidence_reference = 'fixture', decided_by = 'fixture', decided_at = now();
select throws_ok($$select evidence_private.publish_batch('eeeeeeee-0000-0000-0000-000000000001')$$, 'P0001',
  'rights review is not approved for: fixture_sched', 'pending rights block publication even with open gates');
select is((select count(*)::int from evidence_api.sources), 0, 'nothing was published');

select * from finish();
rollback;
