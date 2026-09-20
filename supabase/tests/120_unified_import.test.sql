-- Unified import: one ledger guard, one project_run with EVERY family projector, families that leave each other's tables
-- alone, a cross-route check that resolves in either load order, the typed destination tally, and the explicit owner
-- scope for statistical facts (which releases a number for a statistics source only, and approves no rights row).
-- TEST FIXTURES ONLY: invented publishers, names, numbers and hosts, rolled back.
begin;
select plan(39);

-- One guard, one rule about identifiers ---------------------------------------------------------------------------------------
select is(evidence_private.text_violation('Stephens ' || repeat('0212345678ab', 5) || 'cdef'), null, 'a SHA-256 digest in plain hexadecimal beside "ph" passes');
select is(evidence_private.text_violation('Stephens ' || translate(repeat('0212345678ab', 5) || 'cdef', '0123456789', 'ghijklmnop')), null, 'the same digest letter-encoded (election family) passes: both spellings are accepted');
select is(evidence_private.text_violation('file-0212345678abcdef Stephens'), null, 'a 16-character release key beside "ph" passes');
select is(evidence_private.text_violation('Stephens ' || repeat('0212345678ab', 5) || 'cdef 021 234 5678'), 'phone_like_value', 'a number beside a digest is still refused');
select is(evidence_private.text_violation('Stephens x' || repeat('0212345678ab', 5) || 'cdef'), 'phone_like_value', 'a digest glued to a letter is not a whole token and gets no exemption');
select is(evidence_private.text_violation('Stephens 0212345678'), 'phone_like_value', 'a bare phone-length digit run is never an identifier token');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'evidence_private' and p.proname = 'text_violation'), 1, 'exactly one copy of the guard exists');

-- One project_run, every family projector --------------------------------------------------------------------------------------
select is((select array_agg(projector_key order by projector_key) from evidence_private.run_projectors), array['election_family', 'parliament_family'],
  'both ledger families registered their projector; statistics has its own typed writer and registers none');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'evidence_private' and p.proname = 'project_run'), 1, 'exactly one project_run exists');
select ok(not has_table_privilege('evidence_ingest', 'evidence_private.run_projectors', 'INSERT'), 'the worker cannot register a projector');

select evidence_private.sync_registry(jsonb_build_object(
  'rights', jsonb_build_array(
    jsonb_build_object('rights_id', 'RIGHTS-92', 'publisher', 'Fixture Statistics Office', 'source_url', 'https://stats.fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h92'),
    jsonb_build_object('rights_id', 'RIGHTS-93', 'publisher', 'Fixture Poll Publisher', 'source_url', 'https://polls.fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h93')),
  'registry_products', jsonb_build_array(jsonb_build_object('registry_key', 'statistics', 'title', 'Official statistics', 'domain', 'Statistics')),
  'sources', jsonb_build_array(
    jsonb_build_object('source_id', 'baseline_2023_candidacies_export', 'title', 'Fixture candidacy product', 'publisher', 'Fixture Publisher',
      'official_url', 'https://fixture.example/results', 'adapter_kind', 'export_import', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array(), 'view_scope', 'baseline_2023', 'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'u0'),
    jsonb_build_object('source_id', 'pgtap_unified_election', 'title', 'Fixture election export', 'publisher', 'Fixture Poll Publisher',
      'official_url', 'https://polls.fixture.example/', 'adapter_kind', 'export_import', 'adapter_name', 'fixture', 'rights_id', 'RIGHTS-93',
      'allowed_hosts', jsonb_build_array(), 'view_scope', 'baseline_2023', 'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'u1'),
    jsonb_build_object('source_id', 'pgtap_unified_parliament', 'title', 'Fixture parliament export', 'publisher', 'Fixture Publisher',
      'official_url', 'https://fixture.example/', 'adapter_kind', 'export_import', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array(), 'view_scope', 'current_parliament', 'snapshot_semantics', 'rolling_window', 'enabled', false, 'config_hash', 'u2'),
    jsonb_build_object('source_id', 'pgtap_unified_stats', 'registry_key', 'statistics', 'title', 'Fixture statistics', 'publisher', 'Fixture Statistics Office',
      'official_url', 'https://stats.fixture.example/', 'adapter_kind', 'export_import', 'adapter_name', 'fixture', 'rights_id', 'RIGHTS-92',
      'allowed_hosts', jsonb_build_array(), 'view_scope', 'statistics', 'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'u3'))));

create temp table t (k text primary key, v jsonb);
create function pg_temp.rec(p_id text, p_kind text, p_hash text, p_payload jsonb) returns jsonb language sql as $$
  select jsonb_build_object('external_record_id', p_id, 'record_kind', p_kind, 'content_hash', 'sha256:' || repeat(p_hash, 64),
    'source_url', 'https://fixture.example/page/' || p_id, 'retrieved_at', '2026-09-19T01:00:00Z'::timestamptz, 'safe_payload', p_payload, 'projection_version', 1);
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
create function pg_temp.family_rows() returns jsonb language sql as $$
  select jsonb_build_object(
    'written_questions', (select count(*) from evidence_private.written_questions), 'committee_reports', (select count(*) from evidence_private.committee_reports),
    'route_keys', (select count(*) from evidence_private.record_route_keys),
    'party_results', (select count(*) from evidence_private.party_results), 'route_checks', (select count(*) from evidence_private.result_route_checks),
    'summaries', (select count(*) from evidence_private.electorate_result_summaries), 'candidacies', (select count(*) from evidence_private.candidacies));
$$;
insert into t values ('rows:start', pg_temp.family_rows());

-- LOAD ORDER, first half: the electorate pages (P09 kind) arrive BEFORE the candidacy product (P04 kind) they are checked against.
select pg_temp.run('election', 'pgtap_unified_election', 'bbbbbbbb-1111-1111-1111-111111111111', jsonb_build_array(
  pg_temp.rec('el-party-1', 'election_electorate_vote', '4', jsonb_build_object('election_year', 2023, 'electorate_number', 7, 'electorate_name', 'Fixture North', 'vote_type', 'party', 'name_at_source', 'Fixture Party', 'votes', 299)),
  pg_temp.rec('el-party-2', 'election_electorate_vote', '5', jsonb_build_object('election_year', 2023, 'electorate_number', 7, 'electorate_name', 'Fixture North', 'vote_type', 'party', 'name_at_source', 'Unreported Party')),
  pg_temp.rec('el-cand-1', 'election_electorate_vote', '6', jsonb_build_object('election_year', 2023, 'electorate_number', 7, 'electorate_name', 'Fixture North', 'vote_type', 'candidate', 'name_at_source', 'FIXTURE, Alex', 'votes', 1200, 'baseline_candidacy_ref', 'abcdefghijklmnopabcdefghijklmnop')),
  pg_temp.rec('el-sum', 'election_electorate_summary', '8', jsonb_build_object('election_year', 2023, 'electorate_number', 7, 'electorate_name', 'Fixture North', 'candidate_total', 1250, 'candidate_informals', 10, 'party_total', 301, 'party_informals', 2))));

select ok((select v ? 'election_family' and v ? 'parliament_family' and v ? 'mp_directory' and v ? 'documents' and v ? 'baseline_candidacies' from t where k = 'election:projection'),
  'project_run ran the three core projections and both family projectors in one call');
select is((select (v ->> 'rejected')::int from t where k = 'election:batch'), 0, 'the ledger rejected nothing');
select is((select count(*)::int from evidence_private.party_results pr join evidence_private.lineage_result_set l on l.result_set_id = pr.result_set_id where l.source_id = 'pgtap_unified_election'), 2, 'the election projector wrote its typed rows');
select is((select count(*)::int from evidence_private.party_results pr join evidence_private.lineage_result_set l on l.result_set_id = pr.result_set_id where l.source_id = 'pgtap_unified_election' and pr.value_status <> 'reported' and pr.votes is not null), 0,
  'a party line the source does not report holds no number (unknown is not zero)');
select is((select outcome from evidence_private.result_route_checks c join evidence_private.lineage_version l on l.version_id = c.evidence_version_id where l.source_id = 'pgtap_unified_election' and c.check_kind = 'candidate_votes_same_fact'), 'other_route_not_loaded',
  'with the candidacy product not loaded yet, the cross-route check says so instead of guessing');
select is((select (pg_temp.family_rows() ->> 'written_questions')::int - (v ->> 'written_questions')::int from t where k = 'rows:start'), 0, 'an election run leaves the parliament tables untouched');
select is((select (pg_temp.family_rows() ->> 'route_keys')::int - (v ->> 'route_keys')::int from t where k = 'rows:start'), 0, 'and writes no parliament route key');
insert into t values ('rows:after_election', pg_temp.family_rows());

select pg_temp.run('parliament', 'pgtap_unified_parliament', 'cccccccc-1111-1111-1111-111111111111', jsonb_build_array(
  pg_temp.rec('0a021234-0000-4000-8000-000000000001', 'written_question', 'a', jsonb_build_object(
    'title', '1 (2026). Example Member to the Minister for Telecommunications', 'question_number', 1, 'question_year', 2026, 'parliament_number', 54,
    'question_released_on', '2026-02-03', 'asker_name_at_source', 'Example Member', 'minister_name', 'Hon Example', 'reply_present', false, 'attachment_present', false,
    'question_text_sha256', repeat('a', 20) || '0212345678' || repeat('b', 34),
    'public_page_url', 'https://fixture.example/item/0a021234-0000-4000-8000-000000000001', 'metadata_only', true)),
  pg_temp.rec('0a021234-0000-4000-8000-000000000002', 'committee_report', 'b', jsonb_build_object(
    'title', 'Example report', 'select_committee', 'Example Committee', 'publication_date', '2026-03-04T00:00:00.000Z', 'parliament_number', 54,
    'public_page_url', 'https://fixture.example/item/0a021234-0000-4000-8000-000000000002', 'metadata_only', true))));

select is((select (v ->> 'rejected')::int from t where k = 'parliament:batch'), 0, 'a publisher id and a digest beside "Telecommunications" are accepted by the shared guard');
select is((select (pg_temp.family_rows() ->> 'written_questions')::int - (v ->> 'written_questions')::int from t where k = 'rows:after_election'), 1, 'the parliament projector wrote its typed row from the same project_run');
select is((select (pg_temp.family_rows() ->> 'committee_reports')::int - (v ->> 'committee_reports')::int from t where k = 'rows:after_election'), 1, 'and its report');
select is((select jsonb_build_object('p', pg_temp.family_rows() -> 'party_results', 'c', pg_temp.family_rows() -> 'route_checks', 's', pg_temp.family_rows() -> 'summaries')), (select jsonb_build_object('p', v -> 'party_results', 'c', v -> 'route_checks', 's', v -> 'summaries') from t where k = 'rows:after_election'),
  'a parliament run leaves every election table exactly as it was');

-- LOAD ORDER, second half: the candidacy product arrives afterwards, and the electorate pages are replayed.
select pg_temp.run('p04', 'baseline_2023_candidacies_export', 'dddddddd-1111-1111-1111-111111111111', jsonb_build_array(
  pg_temp.rec('abcdef0123456789abcdef0123456789', 'baseline_2023_candidacy', 'a', jsonb_build_object('candidate_name', 'FIXTURE, Alex', 'candidacy_type', 'electorate',
    'electorate_name', 'Fixture North', 'electorate_type', 'general', 'party_name', 'Fixture Party', 'candidate_votes', 1200, 'election_year', 2023, 'current_status', 'elected'))));
select pg_temp.run('election-replay', 'pgtap_unified_election', 'bbbbbbbb-2222-2222-2222-222222222222', jsonb_build_array(
  pg_temp.rec('el-cand-1', 'election_electorate_vote', '6', jsonb_build_object('election_year', 2023, 'electorate_number', 7, 'electorate_name', 'Fixture North', 'vote_type', 'candidate', 'name_at_source', 'FIXTURE, Alex', 'votes', 1200, 'baseline_candidacy_ref', 'abcdefghijklmnopabcdefghijklmnop'))));
select is((select (v ->> 'versions_inserted')::int from t where k = 'election-replay:batch'), 0, 'the replay inserts no version');
select is((select outcome from evidence_private.result_route_checks c join evidence_private.lineage_version l on l.version_id = c.evidence_version_id where l.source_id = 'pgtap_unified_election' and c.check_kind = 'candidate_votes_same_fact'), 'agrees',
  'once both routes are loaded the same check resolves to "agrees": the result does not depend on load order');
select is((select count(*)::int from evidence_private.candidate_results cr join evidence_private.lineage_result_set l on l.result_set_id = cr.result_set_id where l.source_id = 'pgtap_unified_election'), 0,
  'the electorate-page route never writes a second counted candidate vote');

-- Typed destination tally ------------------------------------------------------------------------------------------------------
select is(evidence_private.typed_destination_counts('pgtap_unified_parliament') -> 'written_questions', '1'::jsonb, 'typed tally: one written question proven to come from the parliament fixture');
select is(evidence_private.typed_destination_counts('pgtap_unified_election') -> 'party_results', '2'::jsonb, 'typed tally: two party lines proven to come from the election fixture');
select ok(not (evidence_private.typed_destination_counts('pgtap_unified_election') ? 'written_questions'), 'a source is never credited with another source''s rows');
select throws_ok($$select evidence_private.typed_destination_counts('pgtap_no_such_source')$$, 'P0001', null, 'an unknown source is an error, not an empty tally');
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'evidence_private' and p.proname = 'typed_destination_counts'), false, 'the tally runs with the caller''s own privileges');

-- Owner scope for statistical facts -------------------------------------------------------------------------------------------
-- (isolated from any owner decision already in the database: only this fixture's ids are asserted on)
insert into evidence_private.owner_authorizations (authorization_id, decided_on, expires_on, decided_by, decided_by_role, request_source, statement, not_claimed, file_hash, entry_hash)
values ('OWNER-AUTH-2026-01-01-91', (now() at time zone 'utc')::date - 1, (now() at time zone 'utc')::date + 30, 'Fixture Owner', 'repository owner', 'TEST FIXTURE: owner request, relayed',
        'TEST FIXTURE: the owner authorizes statistical facts of one statistics source ahead of the reviews.', array['No R10 review.', 'No R8 acceptance.', 'No publisher licence.'], 'sha256:' || repeat('f', 64), 'md5:' || repeat('f', 32));

select lives_ok($$insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, rights_id, field_token, basis)
  values ('OWNER-AUTH-2026-01-01-91', 'statistical_facts', 'pgtap_unified_stats', 'RIGHTS-92', 'value', 'TEST FIXTURE: official statistics as printed by the publisher.'),
         ('OWNER-AUTH-2026-01-01-91', 'statistical_facts', 'pgtap_unified_stats', 'RIGHTS-92', 'value_status', 'TEST FIXTURE: official statistics as printed by the publisher.')$$,
  'a statistics source can have its statistical-fact columns released by an owner decision');
select throws_ok($$insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, rights_id, field_token, basis)
  values ('OWNER-AUTH-2026-01-01-91', 'source_fields', 'pgtap_unified_stats', 'RIGHTS-92', 'value', 'TEST FIXTURE: a number through the descriptive scope, which must stay impossible.')$$,
  '23514', null, 'the descriptive scope still cannot release a number, even for a statistics source');
select throws_ok($$insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, rights_id, field_token, basis)
  values ('OWNER-AUTH-2026-01-01-91', 'statistical_facts', 'pgtap_unified_stats', 'RIGHTS-92', 'votes', 'TEST FIXTURE: a field outside the closed list of statistical-fact columns.')$$,
  '23514', null, 'a statistical_facts scope names only the four fact columns');
select throws_ok($$insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, rights_id, field_token, basis)
  values ('OWNER-AUTH-2026-01-01-91', 'statistical_facts', 'pgtap_unified_election', 'RIGHTS-93', 'value', 'TEST FIXTURE: a poll or vote figure dressed up as a statistical fact.')$$,
  'P0001', null, 'a source that is not registered as official statistics cannot have a number released as a statistical fact');
select throws_ok($$insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, rights_id, field_token, basis)
  values ('OWNER-AUTH-2026-01-01-91', 'statistical_facts', 'pgtap_unified_stats', 'RIGHTS-93', 'raw_value', 'TEST FIXTURE: the wrong rights row for this statistics source.')$$,
  'P0001', null, 'the decision must sit beside the rights row that really governs the source');

select is((select owner_fields from evidence_private.source_release where source_id = 'pgtap_unified_stats'), array['value', 'value_status'], 'the released columns are exactly the ones named');
select is((select tier from evidence_private.source_release where source_id = 'pgtap_unified_stats'), 'link_only', 'the release tier is still link_only: an owner decision is not a rights approval');
select is((select review_status || '/' || default_release from evidence_private.source_rights where rights_id = 'RIGHTS-92'), 'pending/link-only', 'and the rights row is untouched: still pending, still link-only');
select is((select owner_fields from evidence_private.source_release where source_id = 'pgtap_unified_election'), '{}'::text[], 'nothing leaks to a neighbouring source');

update evidence_private.source_rights set review_status = 'refused', default_release = 'withheld', reviewed_on = current_date where rights_id = 'RIGHTS-92';
select is((select tier || ':' || cardinality(owner_fields) from evidence_private.source_release where source_id = 'pgtap_unified_stats'), 'none:0', 'a publisher''s refusal still beats the owner decision: nothing is shown');

select * from finish();
rollback;
