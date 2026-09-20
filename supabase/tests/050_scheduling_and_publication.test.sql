-- Schedules stay inactive without readback proof, secrets and a named activator; publisher-access signals are
-- advisories for a public source, while sign-in/paywall sources and a recorded "not permitted" block; release fails closed.
-- TEST FIXTURES ONLY: synthetic, rolled back.
begin;
select plan(41);

-- Start from a known state whatever a developer's local stack holds (rolled back with the test).
delete from vault.secrets where name in ('evidence_functions_base_url', 'evidence_cron_secret');

select is((select count(*)::int from cron.job where command like '%evidence_private%'), 0, 'migrations schedule no cron job');

select evidence_private.sync_registry(jsonb_build_object(
  'rights', jsonb_build_array(jsonb_build_object('rights_id', 'RIGHTS-91', 'publisher', 'Fixture Publisher',
    'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h1')),
  'sources', jsonb_build_array(jsonb_build_object('source_id', 'pgtap_sched', 'title', 'Fixture scheduled source',
    'publisher', 'Fixture Publisher', 'official_url', 'https://fixture.example/list', 'adapter_kind', 'live_fetch',
    'adapter_name', 'fixture', 'access_basis', 'public_page', 'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-91',
    'view_scope', 'general', 'snapshot_semantics', 'append_only_feed', 'enabled', true, 'config_hash', 'c1'))));
select evidence_private.sync_schedules(jsonb_build_array(jsonb_build_object('schedule_key', 'pgtap-sched-hourly',
  'source_id', 'pgtap_sched', 'cron_expr', '17 * * * *', 'function_slug', 'ingest-run',
  'max_runtime_seconds', 120, 'max_records', 500, 'config_hash', 's1')));

select is((select state from evidence_private.ingest_schedules where schedule_key = 'pgtap-sched-hourly'), 'inactive', 'a synced schedule is inactive');
select throws_ok($$update evidence_private.ingest_schedules set state = 'active' where schedule_key = 'pgtap-sched-hourly'$$,
  '23514', null, 'a schedule cannot be marked active without proof and a cron job id');
select is(evidence_private.dispatch_ingest('pgtap-sched-hourly'), 'skipped_inactive', 'an inactive schedule dispatches nothing');
select throws_ok($$select evidence_private.activate_schedule('pgtap-sched-hourly', gen_random_uuid(), 'fn-v1', 'fixture admin')$$,
  'P0001', null, 'activation without a readback run is refused');

-- a CLI run is not deployment proof
select evidence_private.acquire_lease('pgtap_sched', '55555555-5555-5555-5555-555555555555', 60);
create temp table t as select 'cli'::text as k, evidence_private.start_run('pgtap_sched', '55555555-5555-5555-5555-555555555555', 'v1', 'incremental', 'cli', 'm') as v;
select evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'cli'), '55555555-5555-5555-5555-555555555555', 'succeeded', false, null, null, null);
select throws_ok(format($$select evidence_private.activate_schedule('pgtap-sched-hourly', %L, 'fn-v1', 'fixture admin')$$, (select v ->> 'run_id' from t where k = 'cli')),
  'P0001', null, 'a CLI run does not prove the function is deployed');

-- a function readback run without vault secrets is still refused
select evidence_private.acquire_lease('pgtap_sched', '55555555-5555-5555-5555-555555555555', 60);
insert into t select 'rb', evidence_private.start_run('pgtap_sched', '55555555-5555-5555-5555-555555555555', 'v1', 'incremental', 'function_readback', 'm');
select evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'rb'), '55555555-5555-5555-5555-555555555555', 'succeeded', false, null, null, null);
select throws_ok(format($$select evidence_private.activate_schedule('pgtap-sched-hourly', %L, 'fn-v1', 'fixture admin')$$, (select v ->> 'run_id' from t where k = 'rb')),
  'P0001', null, 'activation without vault secrets is refused');

select ok(evidence_private.functions_base_url_ok('https://abcdefghijklmnopqrst.supabase.co/functions/v1'), 'project functions endpoint accepted');
select ok(not evidence_private.functions_base_url_ok('https://abcdefghijklmnopqrst.supabase.co.attacker.example/functions/v1'), 'look-alike host refused');
select ok(not evidence_private.functions_base_url_ok('http://169.254.169.254/latest/meta-data'), 'metadata address refused');
select ok(not evidence_private.functions_base_url_ok('https://internal.example/functions/v1'), 'arbitrary host refused');

-- Owner collection policy (2026-09-20): for a PUBLIC UNAUTHENTICATED source, robots.txt, a missing terms URL and a
-- missing terms review are recorded advisories, not vetoes. Readback proof, Vault secrets, a named activator and the
-- inactive default are unchanged. A sign-in/paywall source and a person's recorded "not permitted" still block.
select vault.create_secret('https://abcdefghijklmnopqrst.supabase.co/functions/v1', 'evidence_functions_base_url');
select vault.create_secret(repeat('fixture-only-not-a-real-secret-', 2), 'evidence_cron_secret');
create function pg_temp.activate() returns text language sql as $f$
  select format($$select evidence_private.activate_schedule('pgtap-sched-hourly', %L, 'fn-v1', 'fixture admin')$$, (select v ->> 'run_id' from t where k = 'rb'))
$f$;

select is(evidence_private.automated_access_blocker('pgtap_sched'), null, 'policy: no terms URL, no terms review and no robots check do not block a public source');
select ok(evidence_private.automated_access_advisories('pgtap_sched') @> array[
  'the rights register records no terms URL for this publisher', 'no person has reviewed the publisher''s terms for automated access', 'no robots.txt check is on record'],
  'policy: all three are still REPORTED as advisories for a person''s decision');

-- machine checks: provenance only, and a robots.txt disallow among them
insert into evidence_private.publisher_access_checks (source_id, check_kind, checked_url, checked_host, target_path, outcome, http_status, response_bytes, body_sha256, finding, checked_at, tool_version)
values ('pgtap_sched', 'robots_txt', 'https://fixture.example/robots.txt', 'fixture.example', '/list', 'retrieved', 200, 20, 'sha256:' || repeat('a', 64), 'path_disallowed', now(), 'TEST FIXTURE'),
       ('pgtap_sched', 'terms_page', 'https://fixture.example/terms', 'fixture.example', null, 'retrieved', 200, 900, 'sha256:' || repeat('b', 64), 'terms_page_retrieved', now(), 'TEST FIXTURE'),
       ('pgtap_sched', 'terms_page', 'https://fixture.example/other', 'fixture.example', null, 'challenge', 200, 212, null, 'not_retrievable', now(), 'TEST FIXTURE');
select is(evidence_private.automated_access_blocker('pgtap_sched'), null, 'policy: a robots.txt disallow alone does not block');
select ok(evidence_private.automated_access_advisories('pgtap_sched') @> array['robots.txt disallows this path for this client'], 'policy: the disallow is reported');
select throws_ok($$insert into evidence_private.publisher_access_checks (source_id, check_kind, checked_url, checked_host, outcome, finding, checked_at, tool_version)
  values ('pgtap_sched', 'terms_page', 'https://fixture.example/terms', 'fixture.example', 'challenge', 'terms_page_retrieved', now(), 'TEST FIXTURE')$$,
  '23514', null, 'a challenge page can never be recorded as a retrieved terms page');
select throws_ok($$update evidence_private.publisher_access_checks set finding = 'path_allowed'$$, 'P0001', null, 'access checks are append-only');
select throws_ok($$insert into evidence_private.publisher_access_checks (source_id, check_kind, checked_url, checked_host, target_path, outcome, http_status, finding, checked_at, recorded_at, tool_version)
  values ('pgtap_sched', 'robots_txt', 'https://fixture.example/robots.txt', 'fixture.example', '/list', 'not_found', 404, 'no_rules_published', now() + interval '10 years', now() + interval '10 years', 'TEST FIXTURE')$$,
  'P0001', null, 'a check dated in the future is refused');

-- activation: still needs the readback proof and the secrets (tested above); the advisories no longer stop it
select lives_ok(pg_temp.activate(), 'policy: activation succeeds for a public source with readback proof and secrets, despite robots disallow and no terms review');
select is((select count(*)::int from cron.job where jobname = 'pgtap-sched-hourly'), 1, 'one cron job registered');
select ok((select activation_proof -> 'access_advisories_at_activation' @> '["robots.txt disallows this path for this client", "no person has reviewed the publisher''s terms for automated access"]'::jsonb
           from evidence_private.ingest_schedules where schedule_key = 'pgtap-sched-hourly'),
  'the activation proof records what the activating person was told about access');

-- review 14: an active schedule is frozen
select is(evidence_private.sync_schedules(jsonb_build_array(jsonb_build_object('schedule_key', 'pgtap-sched-hourly', 'source_id', 'pgtap_sched',
  'cron_expr', '17 * * * *', 'function_slug', 'ingest-run', 'max_runtime_seconds', 120, 'max_records', 500, 'config_hash', 's1'))), 0,
  'syncing unchanged config leaves an active schedule alone');
select throws_like($$select evidence_private.sync_schedules(jsonb_build_array(jsonb_build_object('schedule_key', 'pgtap-sched-hourly', 'source_id', 'pgtap_sched',
  'cron_expr', '* * * * *', 'function_slug', 'ingest-run', 'max_runtime_seconds', 120, 'max_records', 500, 'config_hash', 's2')))$$,
  '%is active; deactivate it before changing%', 'changed config for an active schedule is refused, not applied');

-- A person's reading of the terms. It must rest on a real retrieval of that exact page, and only "not permitted" blocks.
select evidence_private.sync_registry(jsonb_build_object('rights', jsonb_build_array(jsonb_build_object('rights_id', 'RIGHTS-91', 'publisher', 'Fixture Publisher',
  'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'link-only',
  'licence_or_terms_url', 'https://fixture.example/terms', 'register_hash', 'h2'))));
select throws_like($$insert into evidence_private.publisher_terms_reviews (source_id, rights_id, terms_url, terms_check_id, robots_check_id, automated_access, reviewed_by)
  select 'pgtap_sched', 'RIGHTS-91', 'https://fixture.example/terms',
         (select id from evidence_private.publisher_access_checks where source_id = 'pgtap_sched' and finding = 'not_retrievable'),
         (select id from evidence_private.publisher_access_checks where source_id = 'pgtap_sched' and check_kind = 'robots_txt'), 'permitted', 'TEST FIXTURE reviewer'$$,
  '%recorded retrieval of that exact terms page%', 'a review cannot rest on a page that was never retrieved');
create function pg_temp.review(p_access text, p_conditions text default null) returns void language sql as $f$
  insert into evidence_private.publisher_terms_reviews (source_id, rights_id, terms_url, terms_check_id, robots_check_id, automated_access, conditions, reviewed_by)
  select 'pgtap_sched', 'RIGHTS-91', 'https://fixture.example/terms',
         (select id from evidence_private.publisher_access_checks where source_id = 'pgtap_sched' and finding = 'terms_page_retrieved'),
         (select max(id) from evidence_private.publisher_access_checks where source_id = 'pgtap_sched' and check_kind = 'robots_txt'), p_access, p_conditions, 'TEST FIXTURE reviewer'
$f$;
select pg_temp.review('unclear');
select is(evidence_private.automated_access_blocker('pgtap_sched'), null, 'an "unclear" reading is an advisory, not a block');
select ok(evidence_private.automated_access_advisories('pgtap_sched') @> array['the latest terms review found the terms unclear on automated access'], 'and it is reported');
select throws_ok($$select pg_temp.review('permitted_with_conditions')$$, '23514', null, 'conditional permission must state its conditions');
select throws_ok($$update evidence_private.publisher_terms_reviews set automated_access = 'permitted'$$, 'P0001', null, 'terms reviews are append-only: a reading is superseded, never edited');

-- R6 retained: a known, specific restriction recorded by a person stops an ACTIVE schedule and any new run
select pg_temp.review('not_permitted');
select is(evidence_private.dispatch_ingest('pgtap-sched-hourly'), 'skipped_access_not_permitted', 'R6: a recorded "not permitted" stops an ACTIVE schedule at dispatch');
select is((select detail from evidence_private.schedule_dispatch_log where schedule_key = 'pgtap-sched-hourly' order by id desc limit 1),
  'the latest recorded terms review says automated access is not permitted (R6)', 'and the log says why');
select evidence_private.acquire_lease('pgtap_sched', '55555555-5555-5555-5555-555555555555', 60);
select throws_like($$select evidence_private.start_run('pgtap_sched', '55555555-5555-5555-5555-555555555555', 'v1', 'incremental', 'cli', 'm')$$,
  '%automated access is not permitted (R6)%', 'R6: and no run of any kind can start for that source');
select evidence_private.release_lease('pgtap_sched', '55555555-5555-5555-5555-555555555555');

select evidence_private.deactivate_schedule('pgtap-sched-hourly');
select is((select count(*)::int from cron.job where jobname = 'pgtap-sched-hourly'), 0, 'deactivation removes the cron job');
select throws_like(pg_temp.activate(), '%not permitted (R6)%', 'R6: and it cannot be re-activated while that review stands');

-- Collection eligibility: a source behind a sign-in or a paywall is never enabled, scheduled or run
select throws_ok($$select evidence_private.sync_registry(jsonb_build_object('sources', jsonb_build_array(jsonb_build_object('source_id', 'pgtap_members_only', 'title', 'Fixture members-only source',
  'publisher', 'Fixture Publisher', 'official_url', 'https://fixture.example/members-only', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture', 'access_basis', 'authenticated',
  'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-91', 'view_scope', 'general', 'snapshot_semantics', 'append_only_feed', 'enabled', true, 'config_hash', 'c'))))$$,
  '23514', null, 'a source behind a sign-in can never be enabled');
select evidence_private.sync_registry(jsonb_build_object('sources', jsonb_build_array(
  jsonb_build_object('source_id', 'pgtap_members_only', 'title', 'Fixture members-only source', 'publisher', 'Fixture Publisher', 'official_url', 'https://fixture.example/members-only',
    'adapter_kind', 'live_fetch', 'adapter_name', 'fixture', 'access_basis', 'authenticated', 'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-91',
    'view_scope', 'general', 'snapshot_semantics', 'append_only_feed', 'enabled', false, 'blocked_reason', 'TEST FIXTURE: needs a sign-in', 'config_hash', 'c'),
  jsonb_build_object('source_id', 'pgtap_paywalled', 'title', 'Fixture paywalled source', 'publisher', 'Fixture Publisher', 'official_url', 'https://fixture.example/premium',
    'adapter_kind', 'live_fetch', 'adapter_name', 'fixture', 'access_basis', 'paywalled', 'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-91',
    'view_scope', 'general', 'snapshot_semantics', 'append_only_feed', 'enabled', false, 'blocked_reason', 'TEST FIXTURE: paywall', 'config_hash', 'c'),
  jsonb_build_object('source_id', 'pgtap_public_undocumented', 'title', 'Fixture public undocumented endpoint', 'publisher', 'Fixture Publisher', 'official_url', 'https://fixture.example/api/search',
    'adapter_kind', 'live_fetch', 'adapter_name', 'fixture', 'access_basis', 'public_undocumented_endpoint', 'known_access_restriction', 'TEST FIXTURE: publisher asks for attribution',
    'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-91', 'view_scope', 'general', 'snapshot_semantics', 'append_only_feed', 'enabled', true, 'config_hash', 'c'))));
select evidence_private.acquire_lease('pgtap_members_only', '55555555-5555-5555-5555-555555555555', 60);
select throws_like($$select evidence_private.start_run('pgtap_members_only', '55555555-5555-5555-5555-555555555555', 'v1', 'incremental', 'cli', 'm')$$,
  '%behind a sign-in or a paywall%', 'no run can start for a source behind a sign-in');
select is(evidence_private.automated_access_blocker('pgtap_paywalled'), 'source is not enabled', 'a paywalled source is blocked (it can never be enabled)');
update evidence_private.sources set rights_id = 'RIGHTS-91' where source_id = 'pgtap_public_undocumented';
select is(evidence_private.automated_access_blocker('pgtap_public_undocumented'), null, 'policy: a PUBLIC undocumented endpoint may be enabled and is not blocked');
select ok(evidence_private.automated_access_advisories('pgtap_public_undocumented') @> array[
  'the endpoint is public but undocumented: the publisher has not published terms for it', 'known restriction: TEST FIXTURE: publisher asks for attribution'],
  'and both the undocumented status and a known specific restriction are reported for a person''s decision');

-- publication fails closed
insert into evidence_private.release_batches (id, created_by) values ('eeeeeeee-0000-0000-0000-000000000001', 'fixture publisher');
insert into evidence_private.release_items (batch_id, item_kind, source_id) values ('eeeeeeee-0000-0000-0000-000000000001', 'source', 'pgtap_sched');
select throws_ok($$select evidence_private.publish_batch('eeeeeeee-0000-0000-0000-000000000001')$$, 'P0001',
  'release gates are closed: R8/R10 review and the election-day check must be recorded first', 'closed gates block publication');
update evidence_private.release_gates set state = 'open', evidence_reference = 'fixture', decided_by = 'fixture', decided_at = now();
select throws_ok($$select evidence_private.publish_batch('eeeeeeee-0000-0000-0000-000000000001')$$, 'P0001',
  'rights review is not approved for: pgtap_sched', 'pending rights block publication even with open gates');
select is((select count(*)::int from evidence_api.sources), 0, 'nothing was published');

select * from finish();
rollback;
