-- Parliament family: guard correction, typed projection, dates kept apart, route de-duplication, replay.
-- TEST FIXTURES ONLY: every source, URL path and record below is synthetic and rolled back.
begin;
select plan(29);

-- Guard correction: hexadecimal identifiers are not phone numbers; phone numbers still are -----------------------------
select is(evidence_private.text_violation('{"title":"Telecommunications example","ref":"0a021234-5678-4abc-8def-021234567890"}'), null,
  'a publisher id beside the word "tele..." is not read as a phone number');
select is(evidence_private.text_violation('{"title":"A graph","digest":"' || repeat('a', 20) || '0212345678' || repeat('b', 34) || '"}'), null,
  'a SHA-256 digest beside "ph" is not read as a phone number');
select is(evidence_private.text_violation('call 021 234 5678'), 'phone_like_value', 'a phone number is still refused');
select is(evidence_private.text_violation('{"title":"phone 0212345678","ref":"0a021234-5678-4abc-8def-021234567890"}'), 'phone_like_value',
  'a phone number is still refused when an identifier sits beside it');
select is(evidence_private.text_violation('write to person@example.org 0a021234-5678-4abc-8def-021234567890'), 'email_like_value',
  'every other test still sees the whole text');

select evidence_private.sync_registry(jsonb_build_object(
  'rights', jsonb_build_array(jsonb_build_object(
    'rights_id', 'RIGHTS-91', 'publisher', 'Fixture Publisher', 'source_url', 'https://fixture.example/',
    'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h1')),
  'sources', jsonb_build_array(
    jsonb_build_object('source_id', 'pgtap_family_export', 'title', 'Fixture export route', 'publisher', 'Fixture Publisher',
      'official_url', 'https://fixture.example/', 'adapter_kind', 'export_import', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array(), 'rights_id', 'RIGHTS-91', 'view_scope', 'current_parliament',
      'snapshot_semantics', 'rolling_window', 'enabled', false, 'config_hash', 'c1'),
    jsonb_build_object('source_id', 'pgtap_family_live', 'title', 'Fixture live route', 'publisher', 'Fixture Publisher',
      'official_url', 'https://fixture.example/', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture', 'access_basis', 'public_page',
      'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-91', 'view_scope', 'current_parliament',
      'expected_cadence_seconds', 3600, 'snapshot_semantics', 'append_only_feed', 'enabled', true, 'config_hash', 'c2'))));

create temp table t (k text primary key, v jsonb);

create function pg_temp.rec(p_id text, p_kind text, p_hash_char text, p_payload jsonb, p_published timestamptz default null)
returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('external_record_id', p_id, 'record_kind', p_kind,
    'content_hash', 'sha256:' || repeat(p_hash_char, 64), 'source_url', 'https://fixture.example/item/' || p_id,
    'source_published_at', p_published, 'retrieved_at', '2026-09-19T01:00:00Z'::timestamptz, 'safe_payload', p_payload, 'projection_version', 1));
$$;

create function pg_temp.run(p_key text, p_source text, p_holder uuid, p_records jsonb) returns void language plpgsql as $$
declare v_run uuid;
begin
  perform evidence_private.acquire_lease(p_source, p_holder, 60);
  v_run := (evidence_private.start_run(p_source, p_holder, 'v1', 'export_import', 'test', 'm-' || p_key) ->> 'run_id')::uuid;
  insert into t values (p_key || ':batch', evidence_private.ingest_batch(v_run, p_holder, p_records));
  insert into t values (p_key || ':projection', evidence_private.project_run(v_run, p_holder));
  insert into t values (p_key || ':finish', evidence_private.finish_run(v_run, p_holder, 'succeeded', false, null, null, null));
end $$;

-- Export route, generation 1 ---------------------------------------------------------------------------------------------
select pg_temp.run('g1', 'pgtap_family_export', 'aaaaaaaa-1111-1111-1111-111111111111', jsonb_build_array(
  pg_temp.rec('0a021234-0000-4000-8000-000000000001', 'written_question', 'a', jsonb_build_object(
    'title', '1 (2026). Example Member to the Minister for Telecommunications', 'question_number', 1, 'question_year', 2026, 'parliament_number', 54,
    'question_released_on', '2026-02-03', 'source_last_modified_at', '2026-02-04T00:00:00.000Z', 'asker_name_at_source', 'Example Member',
    'minister_name', 'Hon Example', 'reply_present', false, 'attachment_present', false,
    'question_text_sha256', repeat('a', 20) || '0212345678' || repeat('b', 34),
    'public_page_url', 'https://fixture.example/item/0a021234-0000-4000-8000-000000000001', 'metadata_only', true), '2026-02-03T00:00:00Z'),
  pg_temp.rec('0a021234-0000-4000-8000-000000000002', 'committee_report', 'b', jsonb_build_object(
    'title', 'Example report', 'select_committee', 'Example Committee', 'publication_date', '2026-03-04T00:00:00.000Z', 'parliament_number', 54,
    'public_page_url', 'https://fixture.example/item/0a021234-0000-4000-8000-000000000002', 'metadata_only', true)),
  pg_temp.rec('0a021234-0000-4000-8000-000000000003', 'committee_report_file', 'c', jsonb_build_object(
    'attachment_ref', '0a021234-0000-4000-8000-000000000003', 'parent_report_ref', '0a021234-0000-4000-8000-000000000002',
    'official_download_url', 'https://fixture.example/download/3', 'file_sha256', repeat('c', 64), 'file_bytes', 1234, 'metadata_only', true)),
  pg_temp.rec('0a021234-0000-4000-8000-000000000004', 'bill_register_entry', 'd', jsonb_build_object(
    'title', 'Example Bill', 'bill_number', '1-1', 'parliament_number', 53, 'status_label', 'Enacted', 'introduced_at', '2021-05-01T00:00:00.000Z',
    'stage_count', 2, 'stages', jsonb_build_array(
      jsonb_build_object('stage_name', 'Introduction', 'stage_date', '2021-05-01T00:00:00.000Z'),
      jsonb_build_object('stage_name', 'First Reading')),
    'public_page_url', 'https://fixture.example/item/0a021234-0000-4000-8000-000000000004', 'metadata_only', true)),
  pg_temp.rec('set-1', 'bill_publication_set', 'e', jsonb_build_object('bill_ref', 'b-1', 'title', 'Example Bill', 'publication_index_status', 'unavailable', 'metadata_only', true)),
  pg_temp.rec('set-2', 'bill_publication_set', 'f', jsonb_build_object('bill_ref', 'b-2', 'title', 'Example Bill Two', 'publication_revision_count', 0, 'metadata_only', true)),
  pg_temp.rec('term-1', 'member_service_term', '1', jsonb_build_object('person_ref', 'member:1', 'person_name_at_source', 'Member, Example',
    'party_label', 'Example Party', 'representation', 'list', 'valid_from', '2023-10-14', 'date_basis', 'stated_in_official_open_data_file', 'metadata_only', true)),
  pg_temp.rec('term-2', 'member_service_term', '2', jsonb_build_object('person_ref', 'member:2', 'person_name_at_source', 'Other, Example',
    'representation', 'electorate', 'electorate_label', 'Example Electorate', 'date_basis', 'not_stated_by_source', 'metadata_only', true)),
  pg_temp.rec('role-1', 'minister_role', '3', jsonb_build_object('person_ref', 'member:1', 'person_name_at_source', 'Member, Example',
    'role_name', 'Minister', 'portfolio_name', 'Examples', 'date_basis', 'not_stated_by_source', 'metadata_only', true))));

select is((select (v ->> 'rejected')::int from t where k = 'g1:batch'), 0, 'no record is refused, including one with a digit run inside a digest');
select is((select v -> 'parliament_family' ->> 'written_questions' from t where k = 'g1:projection'), '1', 'project_run reports the family projector');

select results_eq($$select w.released_on, w.lodged_on, w.answered_on, w.answer_status, w.reply_present
  from evidence_private.written_questions w join evidence_private.documents d on d.id = w.document_id
  join evidence_private.source_records r on r.id = d.source_record_id where r.source_id = 'pgtap_family_export'$$,
  $$values ('2026-02-03'::date, null::date, null::date, 'unanswered', false)$$,
  'the release date is stored as such; lodgement and answer dates the source does not state stay null');
select is((select v.source_published_at from evidence_private.source_record_versions v join evidence_private.source_records r on r.id = v.record_id
  where r.external_record_id = '0a021234-0000-4000-8000-000000000002'), null,
  'a record given no publisher date has none: the retrieval time is not borrowed');
select is((select cf.report_document_id is not null from evidence_private.committee_report_files cf
  join evidence_private.source_records r on r.id = cf.source_record_id where r.source_id = 'pgtap_family_export'), true, 'a report file attaches to its report through the publisher''s report id');
select is((select count(*)::int from evidence_private.documents d join evidence_private.source_records r on r.id = d.source_record_id
  where r.source_id = 'pgtap_family_export' and d.document_type = 'committee_report'), 1, 'a report file is not a second report document');
select results_eq($$select s.stage_order, s.stage_name, s.stage_at from evidence_private.bill_stages s join evidence_private.documents d on d.id = s.bill_document_id
  join evidence_private.source_records r on r.id = d.source_record_id where r.source_id = 'pgtap_family_export' order by s.stage_order$$,
  $$values (1, 'Introduction', '2021-05-01T00:00:00Z'::timestamptz), (2, 'First Reading', null::timestamptz)$$,
  'stages keep the publisher order; a stage without a date has none');
select results_eq($$select ps.bill_ref, ps.index_status, ps.publication_revision_count from evidence_private.bill_publication_sets ps
  join evidence_private.source_records r on r.id = ps.source_record_id where r.source_id = 'pgtap_family_export' order by ps.bill_ref$$,
  $$values ('b-1', 'unavailable', null::integer), ('b-2', 'read', 0)$$, 'an unread index is unknown, a read empty index is zero');
select results_eq($$select t.basis, t.date_precision, t.valid_from from evidence_private.parliamentary_service_terms t
  join evidence_private.person_source_identities i on i.id = t.person_identity_id where i.source_id = 'pgtap_family_export' order by i.external_id$$,
  $$values ('official_event', 'day', '2023-10-14'::date), ('observed_in_directory', 'unknown', null::date)$$,
  'a term is dated only when the source states the date');
select results_eq($$select rt.date_precision, rt.valid_from, rt.role_title from evidence_private.role_terms rt
  join evidence_private.person_source_identities i on i.id = rt.person_identity_id where i.source_id = 'pgtap_family_export'$$,
  $$values ('unknown', null::date, 'Minister: Examples')$$, 'a role the source does not date is stored undated');
select is((select count(*)::int from evidence_private.person_source_identities where source_id = 'pgtap_family_export' and person_id is not null), 0,
  'no source identity is linked to a person by the projection');

-- Generation 2: the question gains a reply ------------------------------------------------------------------------------------
select pg_temp.run('g2', 'pgtap_family_export', 'aaaaaaaa-2222-2222-2222-222222222222', jsonb_build_array(
  pg_temp.rec('0a021234-0000-4000-8000-000000000001', 'written_question', '9', jsonb_build_object(
    'title', '1 (2026). Example Member to the Minister for Telecommunications', 'question_number', 1, 'question_year', 2026,
    'question_released_on', '2026-02-03', 'reply_present', true, 'public_page_url', 'https://fixture.example/item/0a021234-0000-4000-8000-000000000001',
    'metadata_only', true), '2026-02-03T00:00:00Z')));
select is((select count(*)::int from evidence_private.source_record_versions v join evidence_private.source_records r on r.id = v.record_id
  where r.external_record_id = '0a021234-0000-4000-8000-000000000001' and r.source_id = 'pgtap_family_export'), 2, 'history is kept: two versions of the question');
select is((select answer_status from evidence_private.written_questions w join evidence_private.documents d on d.id = w.document_id
  join evidence_private.source_records r on r.id = d.source_record_id where r.source_id = 'pgtap_family_export'), 'answered', 'the typed row follows the latest version');
select is((select answered_on from evidence_private.written_questions w join evidence_private.documents d on d.id = w.document_id
  join evidence_private.source_records r on r.id = d.source_record_id where r.source_id = 'pgtap_family_export'), null, 'and still claims no answer date');

-- Replay of generation 2 changes nothing
select pg_temp.run('g2again', 'pgtap_family_export', 'aaaaaaaa-3333-3333-3333-333333333333', jsonb_build_array(
  pg_temp.rec('0a021234-0000-4000-8000-000000000001', 'written_question', '9', jsonb_build_object(
    'title', '1 (2026). Example Member to the Minister for Telecommunications', 'question_number', 1, 'question_year', 2026,
    'question_released_on', '2026-02-03', 'reply_present', true, 'public_page_url', 'https://fixture.example/item/0a021234-0000-4000-8000-000000000001',
    'metadata_only', true), '2026-02-03T00:00:00Z')));
select is((select (v ->> 'versions_inserted')::int from t where k = 'g2again:batch'), 0, 'a replay inserts no version');
select is((select count(*)::int from evidence_private.written_questions w join evidence_private.documents d on d.id = w.document_id
  join evidence_private.source_records r on r.id = d.source_record_id where r.source_id = 'pgtap_family_export'), 1, 'and no second typed row');

-- The same question by the live route: separate records, counted once -------------------------------------------------------------
select pg_temp.run('live', 'pgtap_family_live', 'bbbbbbbb-1111-1111-1111-111111111111', jsonb_build_array(
  pg_temp.rec('0A021234-0000-4000-8000-000000000001', 'written_question', '9', jsonb_build_object(
    'title', '1 (2026). Example Member to the Minister for Telecommunications', 'question_number', 1, 'question_year', 2026,
    'question_released_on', '2026-02-03', 'reply_present', true, 'public_page_url', 'https://fixture.example/item/0a021234-0000-4000-8000-000000000001',
    'metadata_only', true), '2026-02-03T00:00:00Z')));
select is((select count(*)::int from evidence_private.source_records where external_record_id ilike '0a021234-0000-4000-8000-000000000001'), 2,
  'each route keeps its own record: nothing is overwritten');
select results_eq($$select count(*)::int, count(distinct k.route_key)::int from evidence_private.record_route_keys k
  join evidence_private.source_records r on r.id = k.record_id
  where r.source_id in ('pgtap_family_export', 'pgtap_family_live') and k.item_family = 'written_question'$$,
  $$values (2, 1)$$, 'across routes the question is counted once: two records, one publisher item');
select results_eq($$select records::int, also_seen_by_another_route::int from evidence_views.route_coverage_by_source
  where source_id = 'pgtap_family_live' and item_family = 'written_question'$$, $$values (1, 1)$$, 'the coverage view shows the overlap per route');
select is((select count(*)::int from evidence_private.source_records where source_id = 'pgtap_family_export' and tombstoned_at is not null), 0,
  'an import never tombstones');
select is((evidence_private.source_reconciliation('pgtap_family_export') ->> 'records')::int, 9, 'the reconciliation readout counts the records of one source');
select is((evidence_private.source_reconciliation('pgtap_family_export') ->> 'versions')::int, 10, 'and its versions');

-- The worker role can read the reconciliation counts, and cannot register a projector ------------------------------------------
-- (The worker cannot call pgTAP functions, so outcomes are recorded in a table and asserted afterwards.)
grant evidence_ingest to current_user;
create temp table outcome (name text primary key, state text);
grant all on outcome to evidence_ingest;
set local role evidence_ingest;
do $$
begin
  insert into outcome values ('reconciliation', evidence_private.source_reconciliation('pgtap_family_export') ->> 'records');
  begin
    insert into evidence_private.run_projectors values ('pgtap_x', 'pgtap_x');
    insert into outcome values ('register_projector', 'allowed');
  exception when others then
    insert into outcome values ('register_projector', sqlstate);
  end;
end
$$;
reset role;
select is((select state from outcome where name = 'reconciliation'), '9', 'the worker can read the reconciliation counts');
select is((select state from outcome where name = 'register_projector'), '42501', 'the worker cannot register a projector');

select * from finish();
rollback;
