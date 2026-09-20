-- TEST FIXTURES ONLY. Every source, name, title and number below is synthetic.
-- Used by the Evidence Explorer end-to-end tests against a LOCAL disposable stack.
-- Never run this against a hosted project.
--
-- Conventions that keep fixtures unmistakable:
--   * every source_id starts with `fixture_`
--   * every document title starts with `TEST FIXTURE`
--   * every person is called `Fixture Member ...` / `Fixture Candidate ...`
--   * every URL is on the reserved `fixture.example` host
--
-- Data is written through the real ingestion functions (sync_registry, acquire_lease,
-- start_run, ingest_batch, log_fetch, project_run, finish_run) so it has real provenance.
-- History tables are append-only, so the script is idempotent by guarding each source on
-- "has this source ever had a run?" rather than by deleting anything.

\set ON_ERROR_STOP on

begin;

select evidence_private.sync_registry(jsonb_build_object(
  'rights', jsonb_build_array(jsonb_build_object(
    'rights_id', 'RIGHTS-99', 'publisher', 'Fixture Publisher (TEST FIXTURE)', 'source_url', 'https://fixture.example/',
    'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'fixture-h1'),
    -- A second fixture publisher that stays pending, so the link-only presentation can be tested.
    jsonb_build_object('rights_id', 'RIGHTS-98', 'publisher', 'Fixture Pending Publisher (TEST FIXTURE)', 'source_url', 'https://fixture.example/',
    'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'fixture-h2')),
  'sources', jsonb_build_array(
    jsonb_build_object('source_id', 'fixture_bills', 'title', 'TEST FIXTURE bills list', 'publisher', 'Fixture Publisher (TEST FIXTURE)',
      'official_url', 'https://fixture.example/bills', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-99', 'view_scope', 'current_parliament',
      'expected_cadence_seconds', 86400, 'snapshot_semantics', 'complete_snapshot', 'enabled', true, 'config_hash', 'fixture-c1'),
    jsonb_build_object('source_id', 'fixture_mp_directory', 'title', 'TEST FIXTURE members directory', 'publisher', 'Fixture Publisher (TEST FIXTURE)',
      'official_url', 'https://fixture.example/members', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-99', 'view_scope', 'current_parliament',
      'expected_cadence_seconds', 86400, 'snapshot_semantics', 'complete_snapshot', 'enabled', true, 'config_hash', 'fixture-c2'),
    jsonb_build_object('source_id', 'fixture_releases', 'title', 'TEST FIXTURE releases feed', 'publisher', 'Fixture Publisher (TEST FIXTURE)',
      'official_url', 'https://fixture.example/releases', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-99', 'view_scope', 'general',
      'expected_cadence_seconds', 3600, 'snapshot_semantics', 'append_only_feed', 'enabled', true, 'config_hash', 'fixture-c3'),
    jsonb_build_object('source_id', 'fixture_baseline', 'title', 'TEST FIXTURE 2023 baseline export', 'publisher', 'Fixture Publisher (TEST FIXTURE)',
      'official_url', 'https://fixture.example/results-2023', 'adapter_kind', 'export_import', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array(), 'rights_id', 'RIGHTS-99', 'view_scope', 'baseline_2023',
      'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'fixture-c4'),
    jsonb_build_object('source_id', 'fixture_blocked', 'title', 'TEST FIXTURE blocked nominations endpoint', 'publisher', 'Fixture Publisher (TEST FIXTURE)',
      'official_url', 'https://fixture.example/nominations-2026', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-99', 'view_scope', 'primary_2026',
      'expected_cadence_seconds', 86400, 'snapshot_semantics', 'complete_snapshot', 'enabled', true,
      'blocked_reason', 'TEST FIXTURE: endpoint answers with a challenge page', 'config_hash', 'fixture-c5'),
    jsonb_build_object('source_id', 'fixture_pending_rights', 'title', 'TEST FIXTURE source with pending publisher rights', 'publisher', 'Fixture Pending Publisher (TEST FIXTURE)',
      'official_url', 'https://fixture.example/pending', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-98', 'view_scope', 'current_parliament',
      'expected_cadence_seconds', 86400, 'snapshot_semantics', 'complete_snapshot', 'enabled', true, 'config_hash', 'fixture-c6'))));

-- Bills: 65 records in one source (pagination), two versions of bill 001, bill 065 tombstoned,
-- and one record refused by the payload guard (so the errors panel has a row).
do $$
declare
  v_holder uuid := 'f1f1f1f1-0000-4000-8000-000000000001';
  v_run uuid;
begin
  if exists (select 1 from evidence_private.import_runs where source_id = 'fixture_bills') then
    raise notice 'fixture_bills already seeded';
    return;
  end if;

  -- Run 1: all 65 bills, retrieved two days ago.
  perform evidence_private.acquire_lease('fixture_bills', v_holder, 120);
  v_run := (evidence_private.start_run('fixture_bills', v_holder, 'fixture-v1', 'incremental', 'test', 'fixture-m1') ->> 'run_id')::uuid;
  perform evidence_private.log_fetch(v_run, 'fixture_bills', jsonb_build_array(jsonb_build_object(
    'method', 'GET', 'url', 'https://fixture.example/bills', 'host', 'fixture.example', 'attempt', 1,
    'outcome', 'ok', 'http_status', 200, 'bytes', 48213, 'retrieved_at', now() - interval '2 days', 'duration_ms', 412)));
  perform evidence_private.ingest_batch(v_run, v_holder, (
    select jsonb_agg(jsonb_build_object(
      'external_record_id', 'fixture-bill-' || lpad(g::text, 3, '0'),
      'record_kind', 'bill',
      'content_hash', 'sha256:' || encode(sha256(('fixture-bill-v1-' || g)::bytea), 'hex'),
      'source_url', 'https://fixture.example/bills/' || lpad(g::text, 3, '0'),
      'retrieved_at', now() - interval '2 days',
      'projection_version', 1,
      'omitted_fields', jsonb_build_array(jsonb_build_object('field', 'explanatory_note', 'reason', 'TEST FIXTURE: copied text is never stored'), jsonb_build_object('field', 'digest_text', 'reason', 'TEST FIXTURE: copied text is never stored')),
      'safe_payload', jsonb_build_object(
        'title', 'TEST FIXTURE Bill ' || lpad(g::text, 3, '0'),
        'public_page_url', 'https://fixture.example/bills/' || lpad(g::text, 3, '0'),
        'bill_number', 'F' || g || '-1',
        'bill_type', case when g % 3 = 0 then 'Member''s' else 'Government' end,
        'parliament_number', '54',
        'current_stage', case when g % 2 = 0 then 'First reading' else 'Select committee' end,
        'select_committee', 'Fixture Committee',
        'member_name', 'Fixture Member ' || lpad(((g % 8) + 1)::text, 2, '0'),
        'party_label', case when g % 2 = 0 then 'Fixture Party A' else 'Fixture Party B' end)))
    from generate_series(1, 65) g));
  perform evidence_private.ingest_batch(v_run, v_holder, jsonb_build_array(jsonb_build_object(
    'external_record_id', 'fixture-bill-refused', 'record_kind', 'bill',
    'content_hash', 'sha256:' || encode(sha256('fixture-bill-refused'::bytea), 'hex'),
    'source_url', 'https://fixture.example/bills/refused', 'retrieved_at', now() - interval '2 days',
    'safe_payload', jsonb_build_object('title', 'TEST FIXTURE refused record', 'body', 'a field the guard refuses'))));
  perform evidence_private.project_run(v_run, v_holder);
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', true, 'fixture-wm1', null, null);

  -- Run 2: bill 001 amended (second version), bill 065 absent (tombstoned), the rest unchanged.
  perform evidence_private.acquire_lease('fixture_bills', v_holder, 120);
  v_run := (evidence_private.start_run('fixture_bills', v_holder, 'fixture-v1', 'incremental', 'test', 'fixture-m1') ->> 'run_id')::uuid;
  perform evidence_private.log_fetch(v_run, 'fixture_bills', jsonb_build_array(jsonb_build_object(
    'method', 'GET', 'url', 'https://fixture.example/bills', 'host', 'fixture.example', 'attempt', 1,
    'outcome', 'ok', 'http_status', 200, 'bytes', 47990, 'retrieved_at', now(), 'duration_ms', 388)));
  perform evidence_private.ingest_batch(v_run, v_holder, (
    select jsonb_agg(jsonb_build_object(
      'external_record_id', 'fixture-bill-' || lpad(g::text, 3, '0'),
      'record_kind', 'bill',
      'content_hash', 'sha256:' || encode(sha256(((case when g = 1 then 'fixture-bill-v2-' else 'fixture-bill-v1-' end) || g)::bytea), 'hex'),
      'source_url', 'https://fixture.example/bills/' || lpad(g::text, 3, '0'),
      'retrieved_at', now(),
      'projection_version', 1,
      'omitted_fields', jsonb_build_array(jsonb_build_object('field', 'explanatory_note', 'reason', 'TEST FIXTURE: copied text is never stored'), jsonb_build_object('field', 'digest_text', 'reason', 'TEST FIXTURE: copied text is never stored')),
      'safe_payload', jsonb_build_object(
        'title', 'TEST FIXTURE Bill ' || lpad(g::text, 3, '0') || case when g = 1 then ' (amended)' else '' end,
        'public_page_url', 'https://fixture.example/bills/' || lpad(g::text, 3, '0'),
        'bill_number', 'F' || g || case when g = 1 then '-2' else '-1' end,
        'bill_type', case when g % 3 = 0 then 'Member''s' else 'Government' end,
        'parliament_number', '54',
        'current_stage', case when g = 1 then 'Second reading' when g % 2 = 0 then 'First reading' else 'Select committee' end,
        'select_committee', 'Fixture Committee',
        'member_name', 'Fixture Member ' || lpad(((g % 8) + 1)::text, 2, '0'),
        'party_label', case when g % 2 = 0 then 'Fixture Party A' else 'Fixture Party B' end)))
    from generate_series(1, 64) g));
  perform evidence_private.project_run(v_run, v_holder);
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', true, 'fixture-wm2', null, null);
end
$$;

-- Members directory: eight sitting members. A directory sighting creates no candidacy.
do $$
declare
  v_holder uuid := 'f1f1f1f1-0000-4000-8000-000000000002';
  v_run uuid;
begin
  if exists (select 1 from evidence_private.import_runs where source_id = 'fixture_mp_directory') then
    raise notice 'fixture_mp_directory already seeded';
    return;
  end if;
  perform evidence_private.acquire_lease('fixture_mp_directory', v_holder, 120);
  v_run := (evidence_private.start_run('fixture_mp_directory', v_holder, 'fixture-v1', 'incremental', 'test', 'fixture-m1') ->> 'run_id')::uuid;
  perform evidence_private.log_fetch(v_run, 'fixture_mp_directory', jsonb_build_array(jsonb_build_object(
    'method', 'GET', 'url', 'https://fixture.example/members', 'host', 'fixture.example', 'attempt', 1,
    'outcome', 'ok', 'http_status', 200, 'bytes', 9120, 'retrieved_at', now(), 'duration_ms', 201)));
  perform evidence_private.ingest_batch(v_run, v_holder, (
    select jsonb_agg(jsonb_build_object(
      'external_record_id', 'fixture-member-' || lpad(g::text, 2, '0'),
      'record_kind', 'mp_directory_entry',
      'content_hash', 'sha256:' || encode(sha256(('fixture-member-' || g)::bytea), 'hex'),
      'source_url', 'https://fixture.example/members/fixture-member-' || lpad(g::text, 2, '0'),
      'retrieved_at', now(),
      'safe_payload', jsonb_strip_nulls(jsonb_build_object(
        'name_display', 'Fixture Member ' || lpad(g::text, 2, '0'),
        'party_label', case when g % 2 = 0 then 'Fixture Party A' else 'Fixture Party B' end,
        'representation', case when g <= 5 then 'electorate' else 'list' end,
        'electorate_label', case when g <= 5 then 'Fixture Electorate ' || chr(64 + g) end,
        'parliament_number', '54'))))
    from generate_series(1, 8) g));
  perform evidence_private.project_run(v_run, v_holder);
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', true, null, null, null);
end
$$;

-- Releases feed: three items that carry a publisher date.
do $$
declare
  v_holder uuid := 'f1f1f1f1-0000-4000-8000-000000000003';
  v_run uuid;
begin
  if exists (select 1 from evidence_private.import_runs where source_id = 'fixture_releases') then
    raise notice 'fixture_releases already seeded';
    return;
  end if;
  perform evidence_private.acquire_lease('fixture_releases', v_holder, 120);
  v_run := (evidence_private.start_run('fixture_releases', v_holder, 'fixture-v1', 'incremental', 'test', 'fixture-m1') ->> 'run_id')::uuid;
  perform evidence_private.ingest_batch(v_run, v_holder, (
    select jsonb_agg(jsonb_build_object(
      'external_record_id', 'fixture-release-' || g,
      'record_kind', 'release',
      'content_hash', 'sha256:' || encode(sha256(('fixture-release-' || g)::bytea), 'hex'),
      'source_url', 'https://fixture.example/releases/' || g,
      'source_published_at', (timestamptz '2026-09-01 09:00:00+12' + make_interval(days => g)),
      'retrieved_at', now(),
      'safe_payload', jsonb_build_object(
        'title', 'TEST FIXTURE Release ' || g,
        'public_page_url', 'https://fixture.example/releases/' || g,
        'publisher_item_id', 'fixture-item-' || g)))
    from generate_series(1, 3) g));
  perform evidence_private.project_run(v_run, v_holder);
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', false, null, null, null);
end
$$;

-- 2023 baseline export: invented candidacies and numbers. One upstream zero, which the
-- projection stores as "not reported" and the UI must never show as 0.
do $$
declare
  v_holder uuid := 'f1f1f1f1-0000-4000-8000-000000000004';
  v_run uuid;
begin
  if exists (select 1 from evidence_private.import_runs where source_id = 'fixture_baseline') then
    raise notice 'fixture_baseline already seeded';
    return;
  end if;
  perform evidence_private.acquire_lease('fixture_baseline', v_holder, 120);
  v_run := (evidence_private.start_run('fixture_baseline', v_holder, 'fixture-v1', 'export_import', 'test', 'fixture-m1') ->> 'run_id')::uuid;
  perform evidence_private.ingest_batch(v_run, v_holder, (
    select jsonb_agg(jsonb_build_object(
      'external_record_id', 'fixture-cand-' || c.id,
      'record_kind', 'baseline_2023_candidacy',
      'content_hash', 'sha256:' || encode(sha256(('fixture-cand-' || c.id)::bytea), 'hex'),
      'source_url', 'https://fixture.example/results-2023/' || c.id,
      'retrieved_at', now(),
      'safe_payload', jsonb_strip_nulls(jsonb_build_object(
        'candidate_name', c.name, 'candidacy_type', c.kind, 'party_name', c.party,
        'electorate_name', c.electorate, 'candidate_votes', c.votes, 'list_rank', c.list_rank,
        'nomination_status', 'officially_nominated'))))
    from (values
      ('e1', 'Fixture Candidate Aroha', 'electorate', 'Fixture Party A', 'Fixture Electorate A', 1200, null::int),
      ('e2', 'Fixture Candidate Bryn',  'electorate', 'Fixture Party B', 'Fixture Electorate A', 950,  null),
      ('e3', 'Fixture Candidate Cass',  'electorate', 'Independent',     'Fixture Electorate A', 0,    null),
      ('e4', 'Fixture Candidate Dale',  'electorate', 'Fixture Party A', 'Fixture Electorate B', 701,  null),
      ('e5', 'Fixture Candidate Eru',   'electorate', 'Fixture Party B', 'Fixture Electorate B', 688,  null),
      ('l1', 'Fixture Candidate Aroha', 'list',       'Fixture Party A', null,                   null, 2),
      ('l2', 'Fixture Candidate Fern',  'list',       'Fixture Party B', null,                   null, 1)
    ) as c(id, name, kind, party, electorate, votes, list_rank)));
  perform evidence_private.project_run(v_run, v_holder);
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', true, null, null, null);
end
$$;

-- Blocked source: the publisher refused the request. No records, and no claim that none exist.
do $$
declare
  v_holder uuid := 'f1f1f1f1-0000-4000-8000-000000000005';
  v_run uuid;
begin
  if exists (select 1 from evidence_private.import_runs where source_id = 'fixture_blocked') then
    raise notice 'fixture_blocked already seeded';
    return;
  end if;
  perform evidence_private.acquire_lease('fixture_blocked', v_holder, 120);
  v_run := (evidence_private.start_run('fixture_blocked', v_holder, 'fixture-v1', 'incremental', 'test', 'fixture-m1') ->> 'run_id')::uuid;
  perform evidence_private.log_fetch(v_run, 'fixture_blocked', jsonb_build_array(jsonb_build_object(
    'method', 'GET', 'url', 'https://fixture.example/nominations-2026', 'host', 'fixture.example', 'attempt', 1,
    'outcome', 'challenge', 'http_status', 403, 'bytes', 1833, 'retrieved_at', now(), 'duration_ms', 95)));
  perform evidence_private.finish_run(v_run, v_holder, 'blocked', true, null, 'publisher_challenge', 'TEST FIXTURE: HTTP 403 interstitial');
end
$$;

-- Pending-rights source: one member and one bill whose content must never reach an anonymous reader.
do $$
declare
  v_holder uuid := 'f1f1f1f1-0000-4000-8000-000000000006';
  v_run uuid;
begin
  if exists (select 1 from evidence_private.import_runs where source_id = 'fixture_pending_rights') then
    raise notice 'fixture_pending_rights already seeded';
    return;
  end if;
  perform evidence_private.acquire_lease('fixture_pending_rights', v_holder, 120);
  v_run := (evidence_private.start_run('fixture_pending_rights', v_holder, 'fixture-v1', 'incremental', 'test', 'fixture-m1') ->> 'run_id')::uuid;
  perform evidence_private.ingest_batch(v_run, v_holder, jsonb_build_array(
    jsonb_build_object('external_record_id', 'fixture-pending-member', 'record_kind', 'mp_directory_entry',
      'content_hash', 'sha256:' || encode(sha256('fixture-pending-member'::bytea), 'hex'),
      'source_url', 'https://fixture.example/pending/member', 'retrieved_at', now(),
      'safe_payload', jsonb_build_object('name_display', 'WITHHELD Fixture Pending Member', 'party_label', 'WITHHELD Fixture Pending Party',
        'representation', 'list')),
    jsonb_build_object('external_record_id', 'fixture-pending-bill', 'record_kind', 'bill',
      'content_hash', 'sha256:' || encode(sha256('fixture-pending-bill'::bytea), 'hex'),
      'source_url', 'https://fixture.example/pending/bill', 'retrieved_at', now(),
      'safe_payload', jsonb_build_object('title', 'WITHHELD TEST FIXTURE pending bill', 'bill_number', 'W-1',
        'public_page_url', 'https://fixture.example/pending/bill'))));
  perform evidence_private.project_run(v_run, v_holder);
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', true, null, null, null);
end
$$;

-- The main fixture publisher stands in for a publisher whose review is APPROVED with release mode
-- approved-fields and who has cleared every content field, so the content pages can be tested. This is a
-- fixture decision on the local disposable database only; no real publisher has approved anything.
-- (The worker role cannot do this: only an administrator can record a rights row that is not pending.)
update evidence_private.source_rights
   set review_status = 'approved', default_release = 'approved-fields', reviewed_on = date '2026-09-20',
       approved_fields = (
         select array_agg(distinct f order by f) from (
           select field_token as f from evidence_private.public_columns where release_class = 'content'
           union
           select k from evidence_private.source_record_versions v
             join evidence_private.source_records r on r.id = v.record_id, lateral jsonb_object_keys(v.safe_payload) k
            where r.source_id like 'fixture\_%' escape '\') x
         where f ~ '^[a-z][a-z0-9_]*$')
 where rights_id = 'RIGHTS-99';

-- One inactive schedule, so the schedules panel has a row. Never activated.
insert into evidence_private.ingest_schedules (schedule_key, source_id, cron_expr, function_slug, max_runtime_seconds, max_records, config_hash)
values ('fixture-bills-daily', 'fixture_bills', '15 3 * * *', 'ingest-run', 120, 500, 'fixture-s1')
on conflict (schedule_key) do nothing;

commit;

select source_id,
       (select count(*) from evidence_private.source_records r where r.source_id = s.source_id) as records,
       (select count(*) from evidence_private.import_runs r where r.source_id = s.source_id) as runs
from evidence_private.sources s
where s.source_id like 'fixture\_%'
order by 1;
