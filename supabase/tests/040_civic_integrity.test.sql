-- Civic model rules: no name-only merges, announced is not nominated, a list member has no
-- electorate, unknown is not zero, dual candidacies, baseline projection replay.
-- TEST FIXTURES ONLY: invented names and numbers, rolled back. Not real people or results.
begin;
select plan(26);

select evidence_private.sync_registry(jsonb_build_object('sources', jsonb_build_array(
  jsonb_build_object('source_id', 'pgtap_baseline', 'title', 'Fixture baseline export', 'publisher', 'Fixture Publisher',
    'official_url', 'https://fixture.example/results', 'adapter_kind', 'export_import', 'adapter_name', 'fixture',
    'allowed_hosts', jsonb_build_array(), 'view_scope', 'baseline_2023',
    'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'c1'))));

create temp table t (k text primary key, v jsonb);
create function pg_temp.cand(p_id text, p_name text, p_type text, p_party text, p_electorate text, p_votes int, p_rank int, p_hash text)
returns jsonb language sql as $$
  select jsonb_build_object('external_record_id', p_id, 'record_kind', 'baseline_2023_candidacy',
    'content_hash', 'sha256:' || repeat(p_hash, 64), 'source_url', 'https://fixture.example/results/' || p_id,
    'retrieved_at', now(), 'safe_payload', jsonb_strip_nulls(jsonb_build_object('candidate_name', p_name,
      'candidacy_type', p_type, 'party_name', p_party, 'electorate_name', p_electorate, 'candidate_votes', p_votes,
      'list_rank', p_rank, 'nomination_status', 'officially_nominated')));
$$;

-- Deltas, not absolute counts: the local stack may hold other fixtures.
create temp table before_counts as select
  (select count(*) from evidence_private.people) as people,
  (select count(*) from evidence_private.identity_decisions where decision = 'approved') as approved,
  (select count(*) from evidence_private.candidacies) as candidacies,
  (select count(*) from evidence_private.candidacy_status_events) as status_events;

select evidence_private.acquire_lease('pgtap_baseline', '44444444-4444-4444-4444-444444444444', 60);
insert into t select 'run', evidence_private.start_run('pgtap_baseline', '44444444-4444-4444-4444-444444444444', 'v1', 'export_import', 'test', 'm');
select evidence_private.ingest_batch((select (v ->> 'run_id')::uuid from t where k = 'run'), '44444444-4444-4444-4444-444444444444', jsonb_build_array(
  pg_temp.cand('c-1', 'Alex Fixture', 'electorate', 'Fixture Party', 'Fixture North', 1200, null, '1'),
  pg_temp.cand('c-2', 'Alex Fixture', 'list', 'Fixture Party', null, 0, 3, '2'),
  pg_temp.cand('c-3', 'Alex Fixture', 'electorate', 'Other Party', 'Fixture South', 900, null, '3'),
  pg_temp.cand('c-4', 'Sam Sample', 'electorate', 'Independent', 'Fixture North', 0, null, '4'),
  pg_temp.cand('c-5', 'Uma Unevidenced', 'electorate', 'Fixture Party', 'Fixture South', null, null, '5')));
insert into t select 'p1', evidence_private.project_run((select (v ->> 'run_id')::uuid from t where k = 'run'), '44444444-4444-4444-4444-444444444444');

select is((select (v ->> 'baseline_candidacies')::int from t where k = 'p1'), 5, 'five candidacies projected');
select is((select count(*)::int from evidence_private.person_source_identities where source_id = 'pgtap_baseline'), 5,
  'three rows sharing one name stay three separate identities (plus two others)');
select is((select count(*)::int from evidence_private.person_source_identities where source_id = 'pgtap_baseline' and person_id is not null), 0,
  'no identity is linked to a person automatically');
select is((select count(*)::int from evidence_private.people) - (select people::int from before_counts), 0, 'no canonical person is created from a name');
select ok((select count(*) > 0 from evidence_private.identity_decisions d join evidence_private.person_source_identities i on i.id = d.person_identity_id
            where i.source_id = 'pgtap_baseline' and d.decision = 'proposed' and d.method = 'name_similarity_nomination'),
  'a shared name files a proposal for human review');
select is((select count(*)::int from evidence_private.identity_decisions where decision = 'approved') - (select approved::int from before_counts), 0, 'nothing is approved automatically');

select is((select count(*)::int from evidence_private.candidacies c join evidence_private.person_source_identities i on i.id = c.person_identity_id
            where i.source_id = 'pgtap_baseline' and i.name_at_source = 'Alex Fixture' and c.candidacy_type = 'list'), 1, 'list candidacy is its own row');
select is((select e.list_rank from evidence_private.party_list_entries e join evidence_private.person_source_identities i on i.id = e.person_identity_id
            where i.source_id = 'pgtap_baseline' and i.external_id = 'c-2'), 3, 'list rank kept');
select is((select votes from evidence_private.candidate_results r join evidence_private.candidacies c on c.id = r.candidacy_id
            join evidence_private.person_source_identities i on i.id = c.person_identity_id where i.source_id = 'pgtap_baseline' and i.external_id = 'c-1'), 1200::bigint, 'reported votes kept');
select is((select value_status || '/' || coalesce(votes::text, 'null') from evidence_private.candidate_results r
            join evidence_private.candidacies c on c.id = r.candidacy_id
            join evidence_private.person_source_identities i on i.id = c.person_identity_id where i.source_id = 'pgtap_baseline' and i.external_id = 'c-4'),
  'reported/0', 'a source-reported zero stays zero');
select is((select value_status || '/' || coalesce(votes::text, 'null') from evidence_private.candidate_results r
            join evidence_private.candidacies c on c.id = r.candidacy_id
            join evidence_private.person_source_identities i on i.id = c.person_identity_id where i.source_id = 'pgtap_baseline' and i.external_id = 'c-5'),
  'not_reported/null', 'a vote figure the importer did not keep is not reported, and never becomes zero');
select is((select count(*)::int from evidence_private.candidate_results r join evidence_private.candidacies c on c.id = r.candidacy_id
            join evidence_private.person_source_identities i on i.id = c.person_identity_id
            where i.source_id = 'pgtap_baseline' and c.candidacy_type = 'list'), 0, 'list candidacies get no electorate vote row');
select is((select is_independent_label and party_id is null from evidence_private.party_source_identities where source_id = 'pgtap_baseline' and external_id = 'independent'),
  true, 'Independent is a label, not a registered party');
select is((select distinct ev.electorate_type from evidence_private.electorate_versions ev
            join evidence_private.source_record_versions v on v.id = ev.evidence_version_id
            join evidence_private.source_records r on r.id = v.record_id where r.source_id = 'pgtap_baseline'), 'unverified', 'electorate type stays unverified until checked officially');

-- replay
insert into t select 'p2', evidence_private.project_run((select (v ->> 'run_id')::uuid from t where k = 'run'), '44444444-4444-4444-4444-444444444444');
select is((select count(*)::int from evidence_private.candidacies) - (select candidacies::int from before_counts), 5, 'projection replay adds no candidacies');
select is((select count(*)::int from evidence_private.candidacy_status_events) - (select status_events::int from before_counts), 5, 'projection replay adds no status events');

-- name-only approval is impossible
select throws_ok($$insert into evidence_private.identity_decisions (subject_kind, person_identity_id, decision, method, decided_by)
  select 'person', id, 'approved', 'name_similarity_nomination', 'reviewer' from evidence_private.person_source_identities where source_id = 'pgtap_baseline' limit 1$$,
  '23514', null, 'a name match can never be an approval');
select throws_ok($$insert into evidence_private.identity_decisions (subject_kind, person_identity_id, decision, method)
  select 'person', id, 'approved', 'manual_source_review' from evidence_private.person_source_identities where source_id = 'pgtap_baseline' limit 1$$,
  '23514', null, 'approval needs a named reviewer');
insert into evidence_private.people (id, display_name, public_role_basis) values ('bbbbbbbb-0000-0000-0000-000000000001', 'Alex Fixture', 'candidate');
select throws_ok($$update evidence_private.person_source_identities set person_id = 'bbbbbbbb-0000-0000-0000-000000000001', link_status = 'approved'
  where source_id = 'pgtap_baseline' and external_id = 'c-1'$$, 'P0001', null, 'linking without an approved decision is refused');
insert into evidence_private.identity_decisions (subject_kind, person_identity_id, target_person_id, decision, method, decided_by)
  select 'person', id, 'bbbbbbbb-0000-0000-0000-000000000001', 'approved', 'manual_source_review', 'fixture reviewer'
  from evidence_private.person_source_identities where source_id = 'pgtap_baseline' and external_id = 'c-1';
select lives_ok($$update evidence_private.person_source_identities set person_id = 'bbbbbbbb-0000-0000-0000-000000000001', link_status = 'approved'
  where source_id = 'pgtap_baseline' and external_id = 'c-1'$$, 'linking succeeds after a reviewed decision');

-- announced is not nominated
insert into evidence_private.contests (id, election_id, contest_type)
select 'cccccccc-0000-0000-0000-000000000009', id, 'party_list' from evidence_private.elections where slug = 'general-2026';
insert into evidence_private.candidacies (id, person_identity_id, election_id, contest_id, candidacy_type, current_status, evidence_version_id)
select 'cccccccc-0000-0000-0000-000000000001', i.id, e.id, 'cccccccc-0000-0000-0000-000000000009', 'list', 'announced', i.first_version_id
from evidence_private.person_source_identities i, evidence_private.elections e
where i.source_id = 'pgtap_baseline' and i.external_id = 'c-3' and e.slug = 'general-2026';
select throws_ok($$update evidence_private.candidacies set current_status = 'officially_nominated' where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  'P0001', null, 'an announced candidacy cannot become nominated without an official event');
select throws_ok($$insert into evidence_private.candidacy_status_events (candidacy_id, status, date_precision, source_class, evidence_version_id)
  select 'cccccccc-0000-0000-0000-000000000001', 'officially_nominated', 'unknown', 'party_announcement', evidence_version_id
  from evidence_private.candidacies where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  '23514', null, 'a party announcement cannot establish official nomination');

-- a list member has no electorate; a sighting sets no service dates
select throws_ok($$insert into evidence_private.parliamentary_service_terms (person_identity_id, representation, electorate_name_at_source,
    date_precision, basis, observed_first_at, observed_last_at, evidence_version_id)
  select id, 'list', 'Fixture North', 'unknown', 'observed_in_directory', now(), now(), first_version_id
  from evidence_private.person_source_identities where source_id = 'pgtap_baseline' limit 1$$, '23514', null, 'a list member cannot carry an electorate');
select throws_ok($$insert into evidence_private.parliamentary_service_terms (person_identity_id, representation, valid_from,
    date_precision, basis, observed_first_at, observed_last_at, evidence_version_id)
  select id, 'list', current_date, 'day', 'observed_in_directory', now(), now(), first_version_id
  from evidence_private.person_source_identities where source_id = 'pgtap_baseline' limit 1$$, '23514', null, 'a directory sighting cannot set a service start date');

-- unknown is not zero in statistics
-- The statistics tables accept rows only inside a running, leased run of a statistics source (the table boundary), so
-- the fixture opens one.
select evidence_private.sync_registry(jsonb_build_object('sources', jsonb_build_array(
  jsonb_build_object('source_id', 'pgtap_stat_fixture', 'title', 'Fixture statistics', 'publisher', 'Fixture Publisher',
    'official_url', 'https://fixture.example/stats', 'adapter_kind', 'export_import', 'adapter_name', 'fixture',
    'allowed_hosts', jsonb_build_array(), 'view_scope', 'statistics',
    'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'c1'))));
select evidence_private.acquire_lease('pgtap_stat_fixture', '55555555-5555-5555-5555-555555555555', 60);
create temp table stat_run as
  select (evidence_private.start_run('pgtap_stat_fixture', '55555555-5555-5555-5555-555555555555', 'v1', 'export_import', 'test', 'm-stat') ->> 'run_id')::uuid as id;
insert into evidence_private.stat_datasets (id, source_id, dataset_key, title, publisher, route)
values ('dddddddd-0000-0000-0000-000000000001', 'pgtap_stat_fixture', 'fixture_family', 'Fixture', 'Fixture', 'dedicated_series');
insert into evidence_private.stat_route_reconciliation (observation_family, canonical_route, decision_note, decided_by)
values ('fixture_family', 'dedicated_series', 'fixture', 'fixture');
insert into evidence_private.stat_releases (id, dataset_id, release_key, import_run_id)
select 'dddddddd-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000001', 'r1', id from stat_run;
insert into evidence_private.stat_series (id, dataset_id, series_key) values ('dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000001', 's1');
select throws_ok($$insert into evidence_private.stat_observations (series_id, release_id, period_label, value, value_status, parse_status, content_hash, canonical_route, import_run_id)
  select 'dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000002', '2023', 0, 'suppressed', 'parsed',
         'sha256:' || repeat('a', 64), 'dedicated_series', id from stat_run$$,
  '23514', null, 'a suppressed observation cannot carry a number');
select throws_ok($$insert into evidence_private.stat_observations (series_id, release_id, period_label, value, value_status, parse_status, content_hash, canonical_route, import_run_id)
  select 'dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000002', '2023', 5, 'reported', 'parsed',
         'sha256:' || repeat('a', 64), 'operational', id from stat_run$$,
  'P0001', null, 'an observation family cannot be imported through a second, overlapping route');

select * from finish();
rollback;
