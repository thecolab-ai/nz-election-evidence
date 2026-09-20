-- Anonymous projections: default deny, complete source lineage, field-aware rights, release gate, no writes.
-- Regression tests for the release review (rights leak through tables without a source_id column; general
-- payload release under pending rights). TEST FIXTURES ONLY: synthetic, rolled back.
begin;
select plan(47);

create function pg_temp.seed(p_source text, p_prefix text) returns void language plpgsql as $$
declare
  v_holder uuid := '77777777-7777-7777-7777-777777777777';
  v_run uuid;
begin
  perform evidence_private.acquire_lease(p_source, v_holder, 60);
  v_run := (evidence_private.start_run(p_source, v_holder, 'v1', 'incremental', 'test', 'm') ->> 'run_id')::uuid;
  perform evidence_private.ingest_batch(v_run, v_holder, jsonb_build_array(
    jsonb_build_object('external_record_id', p_prefix || '-member', 'record_kind', 'mp_directory_entry',
      'content_hash', 'sha256:' || repeat('1', 64), 'source_url', 'https://fixture.example/' || p_prefix || '/member',
      'retrieved_at', now(), 'source_date_text', '20 Sep 2026',
      'omitted_fields', jsonb_build_array(jsonb_build_object('field', 'portrait', 'reason', 'not needed')),
      'safe_payload', jsonb_build_object('name_display', 'SECRET ' || p_prefix || ' Member', 'party_label', 'SECRET ' || p_prefix || ' Party',
        'representation', 'electorate', 'electorate_label', 'SECRET ' || p_prefix || ' Electorate')),
    jsonb_build_object('external_record_id', p_prefix || '-bill', 'record_kind', 'bill',
      'content_hash', 'sha256:' || repeat('2', 64), 'source_url', 'https://fixture.example/' || p_prefix || '/bill',
      'retrieved_at', now(), 'safe_payload', jsonb_build_object('title', 'SECRET ' || p_prefix || ' Bill', 'bill_number', 'S-1',
        'public_page_url', 'https://fixture.example/' || p_prefix || '/bill')),
    jsonb_build_object('external_record_id', p_prefix || '-cand', 'record_kind', 'baseline_2023_candidacy',
      'content_hash', 'sha256:' || repeat('3', 64), 'source_url', 'https://fixture.example/' || p_prefix || '/cand',
      'retrieved_at', now(), 'safe_payload', jsonb_build_object('candidate_name', 'SECRET ' || p_prefix || ' Candidate',
        'candidacy_type', 'electorate', 'party_name', 'SECRET ' || p_prefix || ' Party', 'electorate_name', 'SECRET ' || p_prefix || ' Seat',
        'candidate_votes', 4321, 'nomination_status', 'officially_nominated')),
    jsonb_build_object('external_record_id', p_prefix || '-list', 'record_kind', 'baseline_2023_candidacy',
      'content_hash', 'sha256:' || repeat('4', 64), 'source_url', 'https://fixture.example/' || p_prefix || '/list',
      'retrieved_at', now(), 'safe_payload', jsonb_build_object('candidate_name', 'SECRET ' || p_prefix || ' Candidate',
        'candidacy_type', 'list', 'party_name', 'SECRET ' || p_prefix || ' Party', 'list_rank', 2, 'nomination_status', 'officially_nominated')),
    jsonb_build_object('external_record_id', p_prefix || '-bad', 'record_kind', 'bill', 'content_hash', 'sha256:' || repeat('5', 64),
      'source_url', 'https://fixture.example/x', 'retrieved_at', now(), 'safe_payload', jsonb_build_object('email', 'x'))));
  perform evidence_private.log_fetch(v_run, p_source, jsonb_build_array(jsonb_build_object('method', 'GET',
    'url', 'https://fixture.example/' || p_prefix, 'host', 'fixture.example', 'attempt', 1, 'outcome', 'ok', 'http_status', 200,
    'bytes', 10, 'retrieved_at', now(), 'duration_ms', 5)));
  perform evidence_private.save_checkpoint(v_run, v_holder, jsonb_build_object('page', 2), 4, 60);
  perform evidence_private.project_run(v_run, v_holder);
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', false, 'wm', null, null);
end
$$;

create function pg_temp.src(p_id text, p_rights text) returns jsonb language sql as $$
  select jsonb_build_object('source_id', p_id, 'title', 'Fixture ' || p_id, 'publisher', 'Fixture Publisher',
    'official_url', 'https://fixture.example/' || p_id, 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
    'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', p_rights, 'view_scope', 'general',
    'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'c');
$$;

update evidence_private.release_gates set state = 'open', evidence_reference = 'fixture', decided_by = 'Fixture Owner Name', decided_at = now()
 where gate_key in ('r10_public_surface_review', 'r8_accountable_legal_entity');

-- Snapshot of what anon sees in EVERY exposed view, before any of the test sources exist --------------------
create temp table seen (phase text, view_name text, n bigint, nonnull_content bigint, primary key (phase, view_name));
grant all on seen to anon;
create function pg_temp.snapshot(p_phase text) returns void language plpgsql as $$
declare
  v record;
  v_cols text;
  v_n bigint;
  v_c bigint;
begin
  for v in
    select case l.object_schema when 'evidence_private' then 'evidence_open' else 'evidence_public' end as sch, l.object_schema, l.object_name
    from evidence_public.dataset_catalogue d
    join (select * from unnest(array['evidence_open', 'evidence_public']) s) x(s) on x.s = d.exposed_schema
    join lateral (select case d.exposed_schema when 'evidence_open' then 'evidence_private' else 'evidence_views' end as object_schema,
                         d.dataset as object_name) l on true
    where d.disposition = 'public' and d.lineage_kind = 'source'
  loop
    select string_agg(format('(%I is not null)::int', c.column_name), ' + ') into v_cols
    from evidence_public.dataset_columns c
    where c.exposed_schema = v.sch and c.dataset = v.object_name and c.disposition = 'rights_gated_content';
    execute format('select count(*), coalesce(sum(%s), 0) from %I.%I', coalesce(v_cols, '0'), v.sch, v.object_name) into v_n, v_c;
    insert into seen values (p_phase, v.sch || '.' || v.object_name, v_n, v_c);
  end loop;
end
$$;

set local role anon;
select pg_temp.snapshot('before');
reset role;

-- 1. P0 regression: refused / restricted / withheld / no-rights sources, through EVERY projection ---------------
select evidence_private.sync_registry(jsonb_build_object(
  'rights', jsonb_build_array(
    jsonb_build_object('rights_id', 'RIGHTS-94', 'publisher', 'Fixture', 'source_url', 'https://fixture.example/', 'review_status', 'refused', 'default_release', 'withheld', 'reviewed_on', '2026-09-20', 'register_hash', 'h'),
    jsonb_build_object('rights_id', 'RIGHTS-95', 'publisher', 'Fixture', 'source_url', 'https://fixture.example/', 'review_status', 'restricted', 'default_release', 'link-only', 'reviewed_on', '2026-09-20', 'register_hash', 'h'),
    jsonb_build_object('rights_id', 'RIGHTS-96', 'publisher', 'Fixture', 'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'withheld', 'register_hash', 'h'),
    jsonb_build_object('rights_id', 'RIGHTS-97', 'publisher', 'Fixture', 'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h'),
    jsonb_build_object('rights_id', 'RIGHTS-98', 'publisher', 'Fixture', 'source_url', 'https://fixture.example/', 'review_status', 'approved', 'default_release', 'approved-fields', 'reviewed_on', '2026-09-20',
      'approved_fields', jsonb_build_array('title', 'bill_number'), 'register_hash', 'h'),
    jsonb_build_object('rights_id', 'RIGHTS-99', 'publisher', 'Fixture', 'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'approved-fields', 'register_hash', 'h')),
  'sources', jsonb_build_array(pg_temp.src('pgtap_refused', 'RIGHTS-94'), pg_temp.src('pgtap_restricted', 'RIGHTS-95'),
    pg_temp.src('pgtap_withheld', 'RIGHTS-96'), pg_temp.src('pgtap_norights', ''))));
select pg_temp.seed('pgtap_refused', 'refused');
select pg_temp.seed('pgtap_restricted', 'restricted');
select pg_temp.seed('pgtap_withheld', 'withheld');
select pg_temp.seed('pgtap_norights', 'norights');

select is((select string_agg(source_id || '=' || tier, ',' order by source_id) from evidence_private.source_release where source_id like 'pgtap_%'),
  'pgtap_norights=none,pgtap_refused=none,pgtap_restricted=none,pgtap_withheld=none', 'refused, restricted, withheld and absent rights all give tier none');
select ok((select count(*) = 16 from evidence_private.source_record_versions v join evidence_private.source_records r on r.id = v.record_id where r.source_id like 'pgtap_%'),
  'sixteen private versions were stored for the four closed sources');

set local role anon;
select pg_temp.snapshot('closed_sources');
reset role;
select is((select count(*)::int from seen a join seen b on b.view_name = a.view_name and b.phase = 'before'
            where a.phase = 'closed_sources' and a.n <> b.n), 0,
  'P0: not one row of a refused, restricted, withheld or rights-less source appears in ANY exposed projection (row counts unchanged in every view)');
select ok((select count(*) >= 60 from seen where phase = 'closed_sources'), 'the check covered every source-lineage projection (60+ views)');

set local role anon;
select is((select count(*)::int from evidence_open.source_record_versions where safe_payload::text like '%SECRET%' or source_url like '%refused%'), 0,
  'P0 reproduction: versions of a refused source are no longer readable (no source_id column on this table)');
select is((select count(*)::int from evidence_open.source_observations o join evidence_open.source_record_versions v on v.id = o.version_id where v.source_url like '%/restricted/%'), 0, 'observations follow the version lineage');
select is((select count(*)::int from evidence_open.run_checkpoints c join evidence_open.import_runs r on r.id = c.run_id where r.source_id like 'pgtap_%'), 0, 'checkpoints follow the run lineage');
select is((select count(*)::int from evidence_open.ingest_errors where source_id like 'pgtap_%'), 0, 'ingest errors of a closed source are hidden');
select is((select count(*)::int from evidence_open.fetch_log where source_id like 'pgtap_%'), 0, 'fetch log of a closed source is hidden');
select is((select count(*)::int from evidence_public.graph_edges where evidence_version_id in (select id from evidence_open.source_record_versions)) - (select count(*)::int from evidence_public.graph_edges), 0, 'every visible edge has a visible evidence version');
select is((select count(*)::int from evidence_public.sources where source_id like 'pgtap_%'), 0, 'a closed source is not listed at all');
reset role;

-- 2. Pending, link-only: rows appear, with link metadata only ---------------------------------------------------------
select evidence_private.sync_registry(jsonb_build_object('sources', jsonb_build_array(
  pg_temp.src('pgtap_pending', 'RIGHTS-97'), pg_temp.src('pgtap_pendingfields', 'RIGHTS-99'))));
select pg_temp.seed('pgtap_pending', 'pending');
select pg_temp.seed('pgtap_pendingfields', 'pendingfields');
select is((select string_agg(tier, ',' order by source_id) from evidence_private.source_release where source_id in ('pgtap_pending', 'pgtap_pendingfields')),
  'link_only,link_only', 'pending is link_only even when the register asks for approved-fields: pending never releases content');

set local role anon;
select pg_temp.snapshot('pending_sources');
reset role;
select ok((select count(*) > 25 from seen a join seen b on b.view_name = a.view_name and b.phase = 'closed_sources'
            where a.phase = 'pending_sources' and a.n > b.n), 'link-only rows are visible across the projections');
select is((select coalesce(sum(a.nonnull_content - b.nonnull_content), 0)::int from seen a join seen b on b.view_name = a.view_name and b.phase = 'closed_sources'
            where a.phase = 'pending_sources'), 0,
  'finding 2: a pending source adds NOT ONE non-null content value to any column of any projection');

set local role anon;
select is((select count(*)::int from evidence_open.source_record_versions v join evidence_open.source_records r on r.id = v.record_id where r.source_id = 'pgtap_pending'), 4, 'pending: versions are listed');
select is((select count(*)::int from evidence_open.source_record_versions v join evidence_open.source_records r on r.id = v.record_id
            where r.source_id = 'pgtap_pending' and (v.safe_payload is not null or v.source_date_text is not null)), 0, 'pending: no payload, no publisher date text');
select is((select count(*)::int from evidence_open.source_records where source_id = 'pgtap_pending' and external_record_id is not null), 0, 'pending: publisher identifiers are content, not link metadata');
select ok((select bool_and(source_url like 'https://fixture.example/%' and content_hash is not null and first_retrieved_at is not null)
           from evidence_open.source_record_versions v join evidence_open.source_records r on r.id = v.record_id where r.source_id = 'pgtap_pending'),
  'pending: the link, hash and retrieval date are shown');
select is((select count(*)::int from evidence_public.records where source_id = 'pgtap_pending' and label is not null), 0, 'pending: no labels in the curated view');
select is((select count(*)::int from evidence_public.service_terms where source_id = 'pgtap_pending' and (member_name is not null or party_label is not null or electorate_name_at_source is not null)), 0, 'pending: no names, parties or electorates');
select is((select count(*)::int from evidence_open.bills b join evidence_open.documents d on d.id = b.document_id where d.official_url like '%/pending/%' and (b.bill_number is not null or d.title is not null)), 0, 'pending: no bill fields');
select is((select count(*)::int from evidence_open.candidate_results where votes is not null
            and candidacy_id in (select id from evidence_open.candidacies where evidence_version_id in
              (select v.id from evidence_open.source_record_versions v join evidence_open.source_records r on r.id = v.record_id where r.source_id = 'pgtap_pending'))), 0, 'pending: no votes');
select is((select public_release_tier from evidence_public.sources where source_id = 'pgtap_pending'), 'link_only', 'the tier is published so a null is explainable');
reset role;

-- 3. Approved with approved-fields: exactly the named fields ---------------------------------------------------------------
select evidence_private.sync_registry(jsonb_build_object('sources', jsonb_build_array(pg_temp.src('pgtap_fields', 'RIGHTS-98'))));
select pg_temp.seed('pgtap_fields', 'fields');
set local role anon;
select is((select v.safe_payload from evidence_open.source_record_versions v join evidence_open.source_records r on r.id = v.record_id
            where r.source_id = 'pgtap_fields' and v.record_kind = 'bill'),
  '{"title": "SECRET fields Bill", "bill_number": "S-1"}'::jsonb, 'approved fields: the payload holds the approved keys and nothing else');
select is((select v.safe_payload from evidence_open.source_record_versions v join evidence_open.source_records r on r.id = v.record_id
            where r.source_id = 'pgtap_fields' and v.record_kind = 'mp_directory_entry'), '{}'::jsonb, 'approved fields: a payload with no approved key is empty');
select is((select d.title || '|' || b.bill_number from evidence_open.bills b join evidence_open.documents d on d.id = b.document_id where d.official_url like '%/fields/%'),
  'SECRET fields Bill|S-1', 'approved fields: typed columns with an approved name are shown');
select is((select count(*)::int from evidence_public.service_terms where source_id = 'pgtap_fields' and member_name is not null), 0, 'approved fields: unnamed fields stay null');
select is((select count(*)::int from evidence_public.records where source_id = 'pgtap_fields' and label is not null), 0, 'approved fields: a derived column needs its own name approved');
reset role;
select throws_ok($$update evidence_private.source_rights set approved_fields = array['title'] where rights_id = 'RIGHTS-97'$$, '23514', null,
  'approved_fields cannot be set on a pending rights row');
select throws_ok($$update evidence_private.source_rights set approved_fields = array['title'], review_status = 'approved', reviewed_on = current_date where rights_id = 'RIGHTS-97'$$, '23514', null,
  'approved_fields cannot be set while the release mode is link-only');

-- 4. Withheld columns, operational text, multi-source summaries ------------------------------------------------------------------
insert into evidence_private.model_runs (id, metadata_status) values ('99999999-0000-0000-0000-000000000001', 'historical_unknown');
insert into evidence_private.summary_versions (id, model_run_id, summary_text, output_hash)
values ('99999999-0000-0000-0000-000000000003', '99999999-0000-0000-0000-000000000001', 'TEST FIXTURE summary', 'sha256:' || repeat('5', 64));
insert into evidence_private.summary_inputs (summary_id, version_id)
select '99999999-0000-0000-0000-000000000003', v.id from evidence_private.source_record_versions v
join evidence_private.source_records r on r.id = v.record_id where r.source_id in ('pgtap_fields', 'pgtap_pending') and v.record_kind = 'bill';
insert into evidence_private.review_decisions (subject_kind, subject_id, subject_hash, decision, reviewer, rubric_version)
values ('summary_version', '99999999-0000-0000-0000-000000000003', 'sha256:' || repeat('5', 64), 'approved', 'Fixture Reviewer Name', 'r1');
update evidence_private.summary_versions set review_status = 'approved' where id = '99999999-0000-0000-0000-000000000003';
set local role anon;
select is((select count(*)::int from evidence_public.summaries), 0, 'a human-approved summary is still private while any input source is not cleared for fields');
select throws_ok('select error_detail from evidence_open.import_runs', '42703', null, 'run error text is not a public column');
select throws_ok('select message from evidence_open.ingest_errors', '42703', null, 'ingest error text is not a public column');
select throws_ok('select record_ref from evidence_public.ingest_errors', '42703', null, 'rejected-record references are not public');
select throws_ok('select cursor_state from evidence_open.run_checkpoints', '42703', null, 'checkpoint JSON is not public');
select throws_ok('select decided_by from evidence_open.identity_decisions', '42703', null, 'reviewer names are not public');
select throws_ok('select count(*) from evidence_open.app_memberships', '42P01', null, 'memberships have no projection');
select throws_ok('select count(*) from evidence_open.people', '42P01', null, 'objects without provable single-source lineage have no projection');
select is((select count(*)::int from evidence_open.ingest_errors where source_id = 'pgtap_pending' and error_class = 'record_rejected'), 1, 'the error class alone is public');

-- 5. Private, system and write paths -----------------------------------------------------------------------------------------------
select throws_ok('select count(*) from evidence_private.source_records', '42501', null, 'anon: private schema denied');
select throws_ok('select count(*) from evidence_private.source_release', '42501', null, 'anon: release tiers are read through the views only');
select throws_ok('select count(*) from evidence_views.records', '42501', null, 'anon: base views denied');
select throws_ok('select count(*) from vault.decrypted_secrets', '42501', null, 'anon: vault denied');
select throws_ok($$update evidence_open.source_rights set review_status = 'approved'$$, '42501', null, 'anon: cannot clear a rights row');
select throws_ok($$delete from evidence_open.source_record_versions$$, null, null, 'anon: delete denied');
reset role;

-- 6. Gate closed: nothing, whatever the rights say
update evidence_private.release_gates set state = 'closed', evidence_reference = null, decided_by = null, decided_at = null where gate_key = 'r8_accountable_legal_entity';
set local role anon;
select is((select count(*)::int from evidence_open.source_record_versions) + (select count(*)::int from evidence_public.records) + (select count(*)::int from evidence_open.source_rights), 0,
  'with a release gate closed no projection returns a row, approved fields included');
select ok((select count(*) > 60 from evidence_public.dataset_catalogue) and (select count(*) > 300 from evidence_public.dataset_columns), 'the catalogue stays readable');
reset role;

select * from finish();
rollback;
