-- Anonymous read-only transparency layer: gate closed/open, withheld columns, rights refusal,
-- unapproved summaries, catalogue completeness (no silent omissions), and write denial.
-- TEST FIXTURES ONLY: synthetic, rolled back.
begin;
select plan(39);

select evidence_private.sync_registry(jsonb_build_object(
  'rights', jsonb_build_array(
    jsonb_build_object('rights_id', 'RIGHTS-93', 'publisher', 'Fixture Publisher', 'source_url', 'https://fixture.example/',
      'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h1'),
    jsonb_build_object('rights_id', 'RIGHTS-94', 'publisher', 'Fixture Refuser', 'source_url', 'https://refuser.example/',
      'review_status', 'refused', 'default_release', 'withheld', 'reviewed_on', '2026-09-20', 'register_hash', 'h2')),
  'sources', jsonb_build_array(
    jsonb_build_object('source_id', 'pgtap_public', 'title', 'Fixture public source', 'publisher', 'Fixture Publisher',
      'official_url', 'https://fixture.example/list', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-93', 'view_scope', 'general',
      'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'c1'),
    jsonb_build_object('source_id', 'pgtap_refused', 'title', 'Fixture refused source', 'publisher', 'Fixture Refuser',
      'official_url', 'https://refuser.example/list', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array('refuser.example'), 'rights_id', 'RIGHTS-94', 'view_scope', 'general',
      'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'c2'))));

create temp table t (k text primary key, v jsonb);
select evidence_private.acquire_lease('pgtap_public', '77777777-7777-7777-7777-777777777777', 60);
insert into t select 'a', evidence_private.start_run('pgtap_public', '77777777-7777-7777-7777-777777777777', 'v1', 'incremental', 'test', 'm');
select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'a'), '77777777-7777-7777-7777-777777777777',
  jsonb_build_array(jsonb_build_object('external_record_id', 'pub-1', 'record_kind', 'fixture_item',
    'content_hash', 'sha256:' || repeat('7', 64), 'source_url', 'https://fixture.example/pub-1',
    'retrieved_at', now(), 'safe_payload', jsonb_build_object('title', 'TEST FIXTURE public item'))));
select evidence_private.acquire_lease('pgtap_refused', '77777777-7777-7777-7777-777777777777', 60);
insert into t select 'b', evidence_private.start_run('pgtap_refused', '77777777-7777-7777-7777-777777777777', 'v1', 'incremental', 'test', 'm');
select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'b'), '77777777-7777-7777-7777-777777777777',
  jsonb_build_array(jsonb_build_object('external_record_id', 'ref-1', 'record_kind', 'fixture_item',
    'content_hash', 'sha256:' || repeat('8', 64), 'source_url', 'https://refuser.example/ref-1',
    'retrieved_at', now(), 'safe_payload', jsonb_build_object('title', 'TEST FIXTURE refused item'))));

insert into evidence_private.model_runs (id, metadata_status) values ('99999999-0000-0000-0000-000000000001', 'historical_unknown');
insert into evidence_private.summary_versions (model_run_id, summary_text, output_hash)
values ('99999999-0000-0000-0000-000000000001', 'TEST FIXTURE unreviewed summary', 'sha256:' || repeat('5', 64));
insert into evidence_private.person_source_identities (id, source_id, external_id, identity_scheme, name_at_source)
values ('99999999-0000-0000-0000-000000000002', 'pgtap_public', 'fixture-person', 'fixture', 'Fixture Person');
insert into evidence_private.identity_decisions (subject_kind, person_identity_id, decision, method, decided_by)
values ('person', '99999999-0000-0000-0000-000000000002', 'rejected', 'manual_source_review', 'Fixture Reviewer Name');

-- Gate closed (the default): anonymous readers reach the views but receive no rows -----------------
update evidence_private.release_gates set state = 'closed', evidence_reference = null, decided_by = null, decided_at = null;
set local role anon;
select is((select count(*)::int from evidence_public.records), 0, 'gate closed: no curated rows for anon');
select is((select count(*)::int from evidence_open.source_record_versions), 0, 'gate closed: no table rows for anon');
select is((select count(*)::int from evidence_public.sources), 0, 'gate closed: no sources for anon');
select is((select bool_or(public_rows_released) from evidence_public.surface_status), false, 'gate closed: status says rows are not released');
select ok((select count(*) > 40 from evidence_public.dataset_catalogue), 'the dataset catalogue is readable even while the gate is closed');
select ok((select count(*) > 300 from evidence_public.dataset_columns), 'the column catalogue is readable even while the gate is closed');
reset role;

-- One gate is not enough
update evidence_private.release_gates set state = 'open', evidence_reference = 'fixture', decided_by = 'Fixture Owner Name', decided_at = now()
 where gate_key = 'r10_public_surface_review';
set local role anon;
select is((select count(*)::int from evidence_public.records), 0, 'R10 alone does not release rows; R8 is also required');
reset role;
update evidence_private.release_gates set state = 'open', evidence_reference = 'fixture', decided_by = 'Fixture Owner Name', decided_at = now()
 where gate_key = 'r8_accountable_legal_entity';

-- Gates open: anonymous browsing -----------------------------------------------------------------------
set local role anon;
select is((select count(*)::int from evidence_public.records where source_id = 'pgtap_public'), 1, 'anon reads curated records');
select is((select safe_payload ->> 'title' from evidence_public.record_versions where source_id = 'pgtap_public'),
  'TEST FIXTURE public item', 'anon reads the allowlisted detail JSON and provenance');
select is((select count(*)::int from evidence_open.source_records where source_id = 'pgtap_public'), 1, 'anon reads the table projection');
select is((select count(*)::int from evidence_open.import_runs where source_id = 'pgtap_public'), 1, 'anon reads the run ledger');
select is((select count(*)::int from evidence_public.sources where source_id = 'pgtap_public'), 1, 'anon reads freshness and coverage');
select is((select rights_review_status from evidence_public.sources where source_id = 'pgtap_public'), 'pending', 'rights stay pending and are shown as pending');
select ok((select count(*) >= 2 from evidence_public.rights_register), 'anon reads the rights register, refused rows included');
select is((select election_date from evidence_public.elections where slug = 'general-2026'), date '2026-11-07', 'anon reads elections');

-- refused rights hide the source everywhere a source_id exists
select is((select count(*)::int from evidence_public.records where source_id = 'pgtap_refused'), 0, 'refused rights: curated rows hidden');
select is((select count(*)::int from evidence_open.source_records where source_id = 'pgtap_refused'), 0, 'refused rights: table rows hidden');
select is((select count(*)::int from evidence_open.import_runs where source_id = 'pgtap_refused'), 0, 'refused rights: run ledger hidden');

-- unreviewed model output never reaches anon
select is((select count(*)::int from evidence_public.summaries), 0, 'unapproved summaries are not public');
select is((select count(*)::int from evidence_open.summary_versions), 0, 'unapproved summary rows are not public');

-- withheld columns do not exist in the public projections
select throws_ok('select decided_by from evidence_public.identity_decisions', '42703', null, 'reviewer names are not a public column (curated)');
select throws_ok('select decided_by from evidence_open.identity_decisions', '42703', null, 'reviewer names are not a public column (table)');
select throws_ok('select decided_by from evidence_open.release_gates', '42703', null, 'gate decider names are not a public column');
select is((select count(*)::int from evidence_open.identity_decisions where person_identity_id = '99999999-0000-0000-0000-000000000002'), 1,
  'the decision itself stays public');
select throws_ok('select count(*) from evidence_open.app_memberships', '42P01', null, 'memberships have no public projection at all');

-- private, privileged and system surfaces stay closed
select throws_ok('select count(*) from evidence_private.source_records', '42501', null, 'anon: private schema denied');
select throws_ok('select count(*) from evidence_private.public_withheld', '42501', null, 'anon: even the withheld register table is read through its view only');
select throws_ok('select count(*) from evidence_views.records', '42501', null, 'anon: base views denied');
select throws_ok('select count(*) from evidence_inspector.records', '42501', null, 'anon: inspector schema denied');
select throws_ok('select count(*) from vault.decrypted_secrets', '42501', null, 'anon: vault denied');
select throws_ok('select count(*) from auth.users', '42501', null, 'anon: auth.users denied');

-- no public role can write
select throws_ok($$insert into evidence_open.sources (source_id) values ('x')$$, '42501', null, 'anon: insert denied');
select throws_ok($$update evidence_open.source_rights set review_status = 'approved'$$, '42501', null, 'anon: cannot clear a rights row');
select throws_ok($$update evidence_open.release_gates set state = 'open'$$, '42501', null, 'anon: cannot open a gate');
select throws_ok($$delete from evidence_open.source_record_versions$$, '42501', null, 'anon: delete denied');
select throws_ok($$select evidence_private.rebuild_exposed_views()$$, '42501', null, 'anon: cannot rebuild projections');
reset role;

-- No silent omissions: every domain column is either projected or has a recorded reason --------------------
select is((
  select count(*)::int
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where n.nspname = 'evidence_private' and c.relkind = 'r'
    and not exists (select 1 from evidence_private.public_withheld w where w.object_schema = 'evidence_private'
                    and w.object_name = c.relname and w.column_name in (a.attname, '*'))
    and not exists (select 1 from pg_class oc join pg_namespace o on o.oid = oc.relnamespace
                    join pg_attribute oa on oa.attrelid = oc.oid and oa.attname = a.attname and oa.attnum > 0
                    where o.nspname = 'evidence_open' and oc.relname = c.relname)), 0,
  'drift check: every non-withheld column of every domain table is in its public projection (run rebuild_exposed_views after schema changes)');
select is((
  select count(*)::int from evidence_private.public_withheld w
  where w.column_name <> '*' and exists (
    select 1 from pg_class oc join pg_namespace o on o.oid = oc.relnamespace
    join pg_attribute oa on oa.attrelid = oc.oid and oa.attname = w.column_name and oa.attnum > 0
    where oc.relname = w.object_name
      and o.nspname = case w.object_schema when 'evidence_private' then 'evidence_open' else 'evidence_public' end)), 0,
  'no withheld column appears in any public projection');

select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'evidence_private' and c.relkind = 'r' and obj_description(c.oid, 'pg_class') is null), 0,
  'every domain table carries a published description');

select * from finish();
rollback;
