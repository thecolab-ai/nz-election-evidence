-- Role boundary: anon and ordinary signed-in users get nothing; an inspector reads through
-- the views only; no browser role can write anything, anywhere.
-- TEST FIXTURES ONLY: synthetic users and records, rolled back.
begin;
select plan(43);

insert into auth.users (id, instance_id, aud, role, email)
values ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'inspector@fixture.invalid'),
       ('aaaaaaaa-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ordinary@fixture.invalid'),
       ('aaaaaaaa-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'revoked@fixture.invalid');

insert into evidence_private.app_memberships (user_id, app_role, granted_by, grant_reason)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'inspector', 'test', 'fixture inspector');
insert into evidence_private.app_memberships (user_id, app_role, granted_by, grant_reason, revoked_at, revoked_by)
values ('aaaaaaaa-0000-0000-0000-000000000003', 'inspector', 'test', 'fixture revoked inspector', now(), 'test');

select evidence_private.sync_registry(jsonb_build_object('sources', jsonb_build_array(
  jsonb_build_object('source_id', 'pgtap_access', 'title', 'Fixture access source', 'publisher', 'Fixture Publisher',
    'official_url', 'https://fixture.example/list', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
    'allowed_hosts', jsonb_build_array('fixture.example'), 'view_scope', 'general',
    'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'c1'))));
select evidence_private.acquire_lease('pgtap_access', '11111111-1111-1111-1111-111111111111', 60);
create temp table t as select evidence_private.start_run('pgtap_access', '11111111-1111-1111-1111-111111111111', 'v1', 'incremental', 'test', 'm') as v;
select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t), '11111111-1111-1111-1111-111111111111',
  jsonb_build_array(jsonb_build_object('external_record_id', 'a-1', 'record_kind', 'fixture_item',
    'content_hash', 'sha256:' || repeat('a', 64), 'source_url', 'https://fixture.example/a-1',
    'retrieved_at', now(), 'safe_payload', jsonb_build_object('title', 'Private fixture item'))));

-- anon ---------------------------------------------------------------------------------
set local role anon;
select throws_ok('select count(*) from evidence_private.source_records', '42501', null, 'anon: no private schema access');
select throws_ok('select count(*) from evidence_private.app_memberships', '42501', null, 'anon: cannot read memberships');
select throws_ok('select count(*) from evidence_inspector.records', '42501', null, 'anon: no inspector schema access');
select throws_ok('select count(*) from evidence_inspector.sources', '42501', null, 'anon: no inspector sources');
select throws_ok('select evidence_inspector.is_inspector()', '42501', null, 'anon: cannot call the membership predicate');
select throws_ok('select count(*) from evidence_api.sources', '42501', null, 'anon: published schema is closed until the release gates open');
select throws_ok($$select evidence_private.ingest_batch(gen_random_uuid(), gen_random_uuid(), '[]')$$, '42501', null, 'anon: cannot call ingest functions');
select throws_ok($$select evidence_private.publish_batch(gen_random_uuid())$$, '42501', null, 'anon: cannot call the release function');
reset role;

-- ordinary signed-in user ------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000002","role":"authenticated"}';
set local role authenticated;
select is(evidence_inspector.is_inspector(), false, 'ordinary user: not an inspector');
select is((select count(*)::int from evidence_inspector.records), 0, 'ordinary user: inspector views return no rows');
select is((select count(*)::int from evidence_inspector.sources), 0, 'ordinary user: no sources');
select is((select count(*)::int from evidence_inspector.record_versions), 0, 'ordinary user: no payloads');
select is((select count(*)::int from evidence_inspector.graph_edges), 0, 'ordinary user: no graph');
select throws_ok('select count(*) from evidence_private.source_records', '42501', null, 'ordinary user: no private schema access');
select throws_ok('select count(*) from evidence_private.source_record_versions', '42501', null, 'ordinary user: no private versions');
select throws_ok($$insert into evidence_private.app_memberships (user_id, app_role, granted_by, grant_reason)
  values ('aaaaaaaa-0000-0000-0000-000000000002', 'inspector', 'self', 'self-grant attempt')$$, '42501', null,
  'ordinary user: cannot grant themselves a membership');
select throws_ok('select count(*) from evidence_api.sources', '42501', null, 'ordinary user: published schema closed');
reset role;

-- A role claim inside user-editable metadata changes nothing
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000002","role":"authenticated","user_metadata":{"app_role":"inspector"},"app_metadata":{"app_role":"inspector"}}';
set local role authenticated;
select is(evidence_inspector.is_inspector(), false, 'metadata role claims are ignored');
select is((select count(*)::int from evidence_inspector.records), 0, 'metadata role claims unlock nothing');
reset role;

-- revoked inspector ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000003","role":"authenticated"}';
set local role authenticated;
select is(evidence_inspector.is_inspector(), false, 'revoked membership: not an inspector');
select is((select count(*)::int from evidence_inspector.records), 0, 'revoked membership: no rows');
reset role;

-- inspector -------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';
set local role authenticated;
select is(evidence_inspector.is_inspector(), true, 'inspector: membership recognised');
select is((select count(*)::int from evidence_inspector.records where source_id = 'pgtap_access'), 1, 'inspector: reads records through the view');
select is((select safe_payload ->> 'title' from evidence_inspector.record_versions where source_id = 'pgtap_access'),
  'Private fixture item', 'inspector: reads the allowlisted detail JSON');
select is((select count(*)::int from evidence_inspector.import_runs where source_id = 'pgtap_access'), 1, 'inspector: reads the run ledger');
select throws_ok('select count(*) from evidence_private.source_records', '42501', null, 'inspector: still no direct private schema access');
select throws_ok('select count(*) from evidence_private.app_memberships', '42501', null, 'inspector: cannot read the membership table');
select throws_ok($$insert into evidence_inspector.records (id) values (gen_random_uuid())$$, null, null, 'inspector: insert denied (grant or non-updatable view)');
select throws_ok($$update evidence_inspector.records set record_kind = 'x'$$, null, null, 'inspector: update denied (grant or non-updatable view)');
select throws_ok($$delete from evidence_inspector.records$$, null, null, 'inspector: delete denied (grant or non-updatable view)');
select throws_ok($$update evidence_inspector.sources set enabled = true$$, null, null, 'inspector: cannot enable a source (grant or non-updatable view)');
select throws_ok($$update evidence_inspector.rights_register set review_status = 'approved'$$, '42501', null, 'inspector: cannot clear a rights row');
select throws_ok($$update evidence_inspector.release_gates set state = 'open'$$, '42501', null, 'inspector: cannot open a release gate');
select throws_ok($$delete from evidence_inspector.record_versions$$, null, null, 'inspector: cannot delete versions (grant or non-updatable view)');
select throws_ok($$select evidence_private.ingest_batch(gen_random_uuid(), gen_random_uuid(), '[]')$$, '42501', null, 'inspector: cannot call ingest functions');
select throws_ok($$select evidence_private.activate_schedule('x', gen_random_uuid(), 'v', 'me')$$, '42501', null, 'inspector: cannot activate schedules');
select throws_ok($$select evidence_private.vault_secret('evidence_cron_secret')$$, '42501', null, 'inspector: cannot read vault secrets');
reset role;

-- structure -------------------------------------------------------------------------------------
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('evidence_private', 'evidence_api') and c.relkind = 'r' and not c.relrowsecurity), 0,
  'row level security is enabled on every private and published table');
select is((select count(*)::int from information_schema.role_table_grants
            where grantee in ('anon', 'authenticated', 'PUBLIC') and table_schema in ('evidence_private', 'evidence_api')), 0,
  'browser roles hold no table privilege on the private or published schemas');
select is((select count(*)::int from information_schema.role_table_grants
            where grantee in ('anon', 'authenticated', 'PUBLIC') and table_schema = 'evidence_inspector' and privilege_type <> 'SELECT'), 0,
  'browser roles hold only SELECT on inspector views');

select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'evidence_inspector' and c.relkind = 'v'
              and (pg_get_userbyid(c.relowner) <> 'evidence_inspector_reader'
                   or not coalesce(c.reloptions @> array['security_barrier=true'], false))), 0,
  'every inspector view is a security barrier owned by the read-only reader role');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'evidence_inspector' and p.proname <> 'is_inspector'), 0,
  'the inspector schema exposes no RPC other than the membership predicate');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'evidence_inspector' and c.relkind = 'v'
              and pg_get_viewdef(c.oid) not like '%is_inspector()%'), 0,
  'every inspector view filters on the membership predicate');

select * from finish();
rollback;
