-- Election family projections: one fact is counted once, unknown is not zero, no policy class without a model run,
-- no candidate or person is created, new tables are default-deny.
-- TEST FIXTURES ONLY: invented parties, names, numbers and hosts, rolled back. Not real results, polls or returns.
begin;
select plan(27);

select evidence_private.sync_registry(jsonb_build_object('sources', jsonb_build_array(
  jsonb_build_object('source_id', 'baseline_2023_candidacies_export', 'title', 'Fixture candidacy product', 'publisher', 'Fixture Publisher',
    'official_url', 'https://fixture.example/results', 'adapter_kind', 'export_import', 'adapter_name', 'fixture',
    'allowed_hosts', jsonb_build_array(), 'view_scope', 'baseline_2023', 'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'f0'),
  jsonb_build_object('source_id', 'aa_pgtap_election_family', 'title', 'Fixture election family export', 'publisher', 'Fixture Publisher',
    'official_url', 'https://fixture.example/results', 'adapter_kind', 'export_import', 'adapter_name', 'fixture',
    'allowed_hosts', jsonb_build_array(), 'view_scope', 'baseline_2023', 'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'f1'),
  -- A second publisher of a nationwide total for the same election, and a third source whose electorate lines have no
  -- total of their own: together they decide whether the cross-route comparison picks its partner by a stated rule.
  jsonb_build_object('source_id', 'ab_pgtap_election_other', 'title', 'Fixture second nationwide publisher', 'publisher', 'Fixture Publisher Two',
    'official_url', 'https://fixture.example/other', 'adapter_kind', 'export_import', 'adapter_name', 'fixture',
    'allowed_hosts', jsonb_build_array(), 'view_scope', 'baseline_2023', 'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'f2'),
  jsonb_build_object('source_id', 'az_pgtap_election_pages', 'title', 'Fixture electorate pages without a total', 'publisher', 'Fixture Publisher Three',
    'official_url', 'https://fixture.example/pages', 'adapter_kind', 'export_import', 'adapter_name', 'fixture',
    'allowed_hosts', jsonb_build_array(), 'view_scope', 'baseline_2023', 'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'f3'))));

create temp table t (k text primary key, v jsonb);
create function pg_temp.rec(p_id text, p_kind text, p_hash text, p_payload jsonb) returns jsonb language sql as $$
  select jsonb_build_object('external_record_id', p_id, 'record_kind', p_kind, 'content_hash', 'sha256:' || repeat(p_hash, 64),
    'source_url', 'https://fixture.example/page/' || p_id, 'retrieved_at', now(), 'safe_payload', p_payload);
$$;

create temp table before_counts as select
  (select count(*) from evidence_private.candidacies) as candidacies,
  (select count(*) from evidence_private.candidate_results) as candidate_results,
  (select count(*) from evidence_private.person_source_identities) as identities,
  (select count(*) from evidence_private.people) as people;

-- The other route first: one candidacy with a reported vote, from the candidacy product.
select evidence_private.acquire_lease('baseline_2023_candidacies_export', '55555555-5555-5555-5555-555555555501', 60);
insert into t select 'base', evidence_private.start_run('baseline_2023_candidacies_export', '55555555-5555-5555-5555-555555555501', 'v1', 'export_import', 'test', 'm0');
select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'base'), '55555555-5555-5555-5555-555555555501', jsonb_build_array(
  pg_temp.rec('abcdef0123456789abcdef0123456789', 'baseline_2023_candidacy', 'a', jsonb_build_object('candidate_name', 'FIXTURE, Alex', 'candidacy_type', 'electorate',
    'party_name', 'Fixture Party', 'electorate_name', 'Fixture North', 'candidate_votes', 1200, 'nomination_status', 'officially_nominated'))));
select evidence_private.project_run((select (v ->> 'run_id')::uuid from t where k = 'base'), '55555555-5555-5555-5555-555555555501');
select evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'base'), '55555555-5555-5555-5555-555555555501', 'succeeded', false, null, null, null);

create temp table mid_counts as select
  (select count(*) from evidence_private.candidacies) as candidacies,
  (select count(*) from evidence_private.candidate_results) as candidate_results,
  (select count(*) from evidence_private.person_source_identities) as identities;

-- A competing nationwide total for the same election, published by another source and loaded FIRST, so the projection
-- below has to choose its comparison partner while two totals exist.
select evidence_private.acquire_lease('ab_pgtap_election_other', '55555555-5555-5555-5555-555555555503', 60);
insert into t select 'other', evidence_private.start_run('ab_pgtap_election_other', '55555555-5555-5555-5555-555555555503', 'v1', 'export_import', 'test', 'm2');
select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'other'), '55555555-5555-5555-5555-555555555503', jsonb_build_array(
  pg_temp.rec('other-total', 'election_nationwide_total', 'f', jsonb_build_object('election_year', 2023, 'result_scope', 'nationwide_party_vote_total', 'party_votes', 999, 'total_seats', 5))));
select evidence_private.project_run((select (v ->> 'run_id')::uuid from t where k = 'other'), '55555555-5555-5555-5555-555555555503');
select evidence_private.finish_run((select (v ->> 'run_id')::uuid from t where k = 'other'), '55555555-5555-5555-5555-555555555503', 'succeeded', false, null, null, null);

select evidence_private.acquire_lease('aa_pgtap_election_family', '55555555-5555-5555-5555-555555555502', 60);
insert into t select 'run', evidence_private.start_run('aa_pgtap_election_family', '55555555-5555-5555-5555-555555555502', 'v1', 'export_import', 'test', 'm1');
select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'run'), '55555555-5555-5555-5555-555555555502', jsonb_build_array(
  pg_temp.rec('nat-total', 'election_nationwide_total', '1', jsonb_build_object('election_year', 2023, 'result_scope', 'nationwide_party_vote_total', 'party_votes', 300, 'total_seats', 5)),
  pg_temp.rec('nat-a', 'election_nationwide_party_result', '2', jsonb_build_object('election_year', 2023, 'result_scope', 'nationwide_party_vote', 'party_name', 'Fixture Party', 'party_votes', 300, 'vote_percent', 100, 'list_seats', 5)),
  pg_temp.rec('nat-b', 'election_nationwide_party_result', '3', jsonb_build_object('election_year', 2023, 'result_scope', 'nationwide_party_vote', 'party_name', 'Seatless Party', 'party_votes', 0, 'vote_percent', 0)),
  pg_temp.rec('el-party-1', 'election_electorate_vote', '4', jsonb_build_object('election_year', 2023, 'electorate_number', 7, 'electorate_name', 'Fixture North', 'vote_type', 'party', 'name_at_source', 'Fixture Party', 'votes', 299)),
  pg_temp.rec('el-party-2', 'election_electorate_vote', '5', jsonb_build_object('election_year', 2023, 'electorate_number', 7, 'electorate_name', 'Fixture North', 'vote_type', 'party', 'name_at_source', 'Unreported Party')),
  pg_temp.rec('el-cand-1', 'election_electorate_vote', '6', jsonb_build_object('election_year', 2023, 'electorate_number', 7, 'electorate_name', 'Fixture North', 'vote_type', 'candidate', 'name_at_source', 'FIXTURE, Alex', 'votes', 1200, 'baseline_candidacy_ref', 'abcdefghijklmnopabcdefghijklmnop')),
  pg_temp.rec('el-cand-2', 'election_electorate_vote', '7', jsonb_build_object('election_year', 2023, 'electorate_number', 7, 'electorate_name', 'Fixture North', 'vote_type', 'candidate', 'name_at_source', 'FIXTURE, Alex', 'votes', 40)),
  pg_temp.rec('el-sum', 'election_electorate_summary', '8', jsonb_build_object('election_year', 2023, 'electorate_number', 7, 'electorate_name', 'Fixture North', 'candidate_total', 1250, 'candidate_informals', 10, 'party_total', 301, 'party_informals', 2)),
  pg_temp.rec('policy-1', 'party_policy_page', '9', jsonb_build_object('party_name', 'Fixture Party', 'document_title', 'Fixture policy', 'upstream_unreviewed_label', 'published_2026_manifesto', 'upstream_label_model_metadata', 'not_recorded')),
  pg_temp.rec('poll-1', 'party_vote_poll', 'a', jsonb_build_object('pollster', 'Fixture Research', 'methodology_status', 'unresolved', 'sample_size', 1000,
    'results', jsonb_build_array(jsonb_build_object('party_label', 'ZED', 'value_pct', 7.7, 'value_status', 'reported'), jsonb_build_object('party_label', 'ALPHA', 'value_status', 'not_reported'), jsonb_build_object('party_label', 'NIL', 'value_pct', 0, 'value_status', 'reported')))),
  pg_temp.rec('return-1', 'finance_candidate_return', 'b', jsonb_build_object('reporting_year', 2023, 'candidate_name_as_published', 'FIXTURE, Alex', 'electorate_as_published', 'Fixture North', 'party_name_as_published', 'Fixture Party', 'is_image_only', true,
    'expenses_as_published_status', 'reported', 'expenses_as_published_nzd', 1000.5, 'donations_as_published_status', 'reported_nil', 'donations_as_published_nzd', 0, 'loans_as_published_status', 'not_reported')),
  pg_temp.rec('agg-1', 'finance_party_aggregate', 'c', jsonb_build_object('reporting_year', 2025, 'party_name_as_published', 'Fixture Party',
    'aggregates', jsonb_build_array(jsonb_build_object('metric', 'party_donations_sum', 'value_status', 'reported', 'amount_nzd', 270), jsonb_build_object('metric', 'party_loans_sum', 'value_status', 'not_reported'), jsonb_build_object('metric', 'largest_entry', 'value_status', 'reported', 'amount_nzd', 5)))),
  pg_temp.rec('status-1', 'election_2026_official_page_status', 'd', jsonb_build_object('upstream_election_ref', 'NZGE2026', 'official_page_status', 'official_page_unavailable', 'candidate_details_available', 'unknown')),
  pg_temp.rec('map-1', 'election_2026_boundary_map_link', 'e', jsonb_build_object('boundary_edition', '2025', 'boundary_scope', 'Fixture summary map', 'boundary_type_at_source', 'General', 'link_kind', 'official_summary_map_document'))));
insert into t select 'p1', evidence_private.project_election_family((select (v ->> 'run_id')::uuid from t where k = 'run'), '55555555-5555-5555-5555-555555555502');

-- One fact, one counted row ----------------------------------------------------------------------------------------------
select is((select count(*) from evidence_private.candidate_results) - (select candidate_results from mid_counts), 0::bigint,
  'a candidate line on an electorate page never becomes a second candidate_results row');
select is((select count(*) from evidence_private.candidacies) - (select candidacies from mid_counts), 0::bigint, 'the family creates no candidacy');
select is((select count(*) from evidence_private.person_source_identities) - (select identities from mid_counts), 0::bigint, 'the family creates no person identity');
select is((select count(*) from evidence_private.people) - (select people from before_counts), 0::bigint, 'and no canonical person');
select is((select c.outcome || '/' || c.this_route_votes || '/' || c.other_route_votes from evidence_private.result_route_checks c
            join evidence_private.source_record_versions v on v.id = c.evidence_version_id join evidence_private.source_records r on r.id = v.record_id
            where r.source_id = 'aa_pgtap_election_family' and r.external_record_id = 'el-cand-1'), 'agrees/1200/1200',
  'a line carrying the other product''s identifier is checked against that product''s row');
select is((select c.outcome || '/' || (c.candidacy_id is null)::text from evidence_private.result_route_checks c
            join evidence_private.source_record_versions v on v.id = c.evidence_version_id join evidence_private.source_records r on r.id = v.record_id
            where r.source_id = 'aa_pgtap_election_family' and r.external_record_id = 'el-cand-2'), 'other_route_not_loaded/true',
  'the same published name without an identifier joins nothing');
select is((select c.outcome || '/' || c.this_route_votes || '/' || c.other_route_votes from evidence_private.result_route_checks c
            join evidence_private.source_record_versions v on v.id = c.evidence_version_id join evidence_private.source_records r on r.id = v.record_id
            where r.source_id = 'aa_pgtap_election_family' and c.check_kind = 'party_votes_sum_to_nationwide_total'), 'disagrees/299/300',
  'electorate party votes are compared with the nationwide total and a difference is recorded, not hidden');
-- The partner of the comparison is chosen by a stated rule, not by whichever surrogate key sorted first: the source's
-- OWN published total when it has one (300 here, never the other publisher's 999, and never a real total the store may
-- already hold), and the note says whose figure was used.
select is((select c.note like '%this source''s own published total.' from evidence_private.result_route_checks c
            join evidence_private.source_record_versions v on v.id = c.evidence_version_id join evidence_private.source_records r on r.id = v.record_id
            where r.source_id = 'aa_pgtap_election_family' and c.check_kind = 'party_votes_sum_to_nationwide_total'), true,
  'the check names the source of the national figure it used');
-- A source whose electorate lines have no total of their own: the remaining totals are taken in source order, so the
-- answer is the same however the rows were loaded, and the note names the publisher of the figure. The fixture ids are
-- prefixed to sort before any real source id, so this holds on an empty store and on a fully loaded one alike.
select evidence_private.acquire_lease('az_pgtap_election_pages', '55555555-5555-5555-5555-555555555504', 60);
insert into t select 'pages', evidence_private.start_run('az_pgtap_election_pages', '55555555-5555-5555-5555-555555555504', 'v1', 'export_import', 'test', 'm3');
select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'pages'), '55555555-5555-5555-5555-555555555504', jsonb_build_array(
  pg_temp.rec('zz-party-1', 'election_electorate_vote', '0', jsonb_build_object('election_year', 2023, 'electorate_number', 7, 'electorate_name', 'Fixture North', 'vote_type', 'party', 'name_at_source', 'Fixture Party', 'votes', 250))));
select evidence_private.project_run((select (v ->> 'run_id')::uuid from t where k = 'pages'), '55555555-5555-5555-5555-555555555504');
select is((select c.this_route_votes || '/' || c.other_route_votes || '/' || (c.note like '%published by aa\_pgtap\_election\_family.')::text
             from evidence_private.result_route_checks c
             join evidence_private.source_record_versions v on v.id = c.evidence_version_id join evidence_private.source_records r on r.id = v.record_id
            where r.source_id = 'az_pgtap_election_pages' and c.check_kind = 'party_votes_sum_to_nationwide_total'), '250/300/true',
  'without a total of its own, the partner is the first remaining total in source order, and the note says whose it is');
select is((select count(distinct c.other_route_votes)::int from evidence_private.result_route_checks c
            join evidence_private.source_record_versions v on v.id = c.evidence_version_id join evidence_private.source_records r on r.id = v.record_id
            where r.source_id in ('aa_pgtap_election_family', 'az_pgtap_election_pages') and c.check_kind = 'party_votes_sum_to_nationwide_total'), 1,
  'and the two sources agree on which national figure exists to compare with');
select is((select count(*)::int from evidence_private.election_party_totals e join evidence_private.lineage_result_set l on l.result_set_id = e.result_set_id
            where l.source_id = 'aa_pgtap_election_family'), 2, 'the published total line is not a third party row');
select is((select party_votes from evidence_private.election_result_totals e join evidence_private.lineage_result_set l on l.result_set_id = e.result_set_id
            where l.source_id = 'aa_pgtap_election_family'), 300::bigint, 'it is kept on its own');

-- Unknown is not zero ---------------------------------------------------------------------------------------------------------
select is((select e.value_status || '/' || e.party_votes || '/' || coalesce(e.list_seats::text, 'null') from evidence_private.election_party_totals e
            join evidence_private.party_source_identities p on p.id = e.party_identity_id where p.source_id = 'aa_pgtap_election_family' and p.name_at_source = 'Seatless Party'),
  'reported/0/null', 'a published zero stays zero and a blank seats cell stays null');
select is((select pr.value_status || '/' || coalesce(pr.votes::text, 'null') from evidence_private.party_results pr
            join evidence_private.party_source_identities p on p.id = pr.party_identity_id where p.source_id = 'aa_pgtap_election_family' and p.name_at_source = 'Unreported Party'),
  'not_reported/null', 'a line without a count is not reported, never zero');
select is((select string_agg(party_label_at_source || '=' || value_status || ':' || coalesce(value_pct::text, 'null'), ', ' order by party_label_at_source)
            from evidence_private.poll_results pr join evidence_private.lineage_document l on l.document_id = pr.poll_document_id where l.source_id = 'aa_pgtap_election_family'),
  'ALPHA=not_reported:null, NIL=reported:0.000, ZED=reported:7.700', 'a blank poll cell is not reported; a printed zero is a value');
select is((select count(*)::int from evidence_private.poll_results pr join evidence_private.lineage_document l on l.document_id = pr.poll_document_id
            where l.source_id = 'aa_pgtap_election_family' and pr.party_identity_id is not null), 0, 'a poll abbreviation is not resolved to a party');
select is((select string_agg(metric || '=' || value_status || ':' || coalesce(amount_nzd::text, 'null'), ', ' order by metric) from evidence_private.finance_published_aggregates a
            join evidence_private.source_records r on r.id = a.source_record_id where r.source_id = 'aa_pgtap_election_family'),
  'candidate_donations=reported_nil:0.00, candidate_expenses=reported:1000.50, candidate_loans=not_reported:null, party_donations_sum=reported:270.00, party_loans_sum=not_reported:null',
  'published totals keep reported, reported nil and not reported apart; a metric outside the vocabulary is not stored');
select ok((select count(*) = 1 from evidence_private.ingest_errors where run_id = (select (v ->> 'run_id')::uuid from t where k = 'run') and error_class = 'projection_skipped'),
  'the unknown metric is logged as skipped');

-- Policy pages, finance documents, civic links ----------------------------------------------------------------------------------------
select is((select p.policy_class || '/' || p.classification_basis || '/' || (p.model_run_id is null)::text from evidence_private.policy_sources p
            join evidence_private.lineage_document l on l.document_id = p.document_id where l.source_id = 'aa_pgtap_election_family'), 'unknown/none/true',
  'an upstream label without a recorded model run assigns no class');
select is((select f.return_type || '/' || f.filing_status || '/' || f.is_image_only::text || '/' || f.total_status || '/' || (f.candidacy_id is null)::text
            from evidence_private.finance_return_references f join evidence_private.lineage_document l on l.document_id = f.document_id where l.source_id = 'aa_pgtap_election_family'),
  'candidate_return/filed/true/not_extracted/true', 'a return is an official link with a status; it is not joined to a candidacy by name and no total is read from inside it');
select is((select page_status || '/' || candidate_details_available from evidence_private.election_official_page_status s
            join evidence_private.lineage_version l on l.version_id = s.evidence_version_id where l.source_id = 'aa_pgtap_election_family'),
  'official_page_unavailable/unknown', 'an unavailable official page is recorded as unavailable with candidate details unknown');
select is((select count(*)::int from evidence_private.electorate_versions ev join evidence_private.boundary_editions be on be.id = ev.boundary_edition_id where be.slug = 'boundary-review-2025'), 0,
  'a boundary map link creates no electorate');

-- Replay ---------------------------------------------------------------------------------------------------------------------------------
create temp table after_first as select
  (select count(*) from evidence_private.result_route_checks) as checks, (select count(*) from evidence_private.party_results) as party_results,
  (select count(*) from evidence_private.poll_results) as poll_results, (select count(*) from evidence_private.finance_published_aggregates) as aggregates,
  (select count(*) from evidence_private.documents) as documents;
select evidence_private.project_election_family((select (v ->> 'run_id')::uuid from t where k = 'run'), '55555555-5555-5555-5555-555555555502');
select is((select row(count(*)) from evidence_private.result_route_checks)::text || (select count(*) from evidence_private.party_results)::text
          || (select count(*) from evidence_private.poll_results)::text || (select count(*) from evidence_private.finance_published_aggregates)::text
          || (select count(*) from evidence_private.documents)::text,
          (select row(checks)::text || party_results::text || poll_results::text || aggregates::text || documents::text from after_first),
  'projecting the same run again changes no count');

-- Default deny -------------------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'evidence_private' and c.relrowsecurity
            and c.relname in ('election_result_totals', 'electorate_result_summaries', 'result_route_checks', 'finance_published_aggregates', 'election_official_page_status', 'boundary_map_links')), 6,
  'row level security is on for every new table');
select is((select count(*)::int from evidence_private.public_lineage where lineage_kind = 'source'
            and object_name in ('election_result_totals', 'electorate_result_summaries', 'result_route_checks', 'finance_published_aggregates', 'election_official_page_status', 'boundary_map_links')), 6,
  'every new table proves its source by foreign key');
select is((select count(*)::int from evidence_private.public_columns where release_class = 'link'
            and column_name in ('party_votes', 'this_route_votes', 'amount_nzd', 'electorate_seats', 'list_seats', 'total_seats', 'votes_counted', 'candidate_informals', 'party_informals', 'boundary_scope')), 0,
  'no vote figure, seat count or amount is classed as link metadata');
select is((select count(*)::int from information_schema.role_table_grants where grantee in ('anon', 'authenticated') and table_schema = 'evidence_private'
            and table_name in ('election_result_totals', 'electorate_result_summaries', 'result_route_checks', 'finance_published_aggregates', 'election_official_page_status', 'boundary_map_links')), 0,
  'browser roles hold nothing on the new tables');

select * from finish();
rollback;
