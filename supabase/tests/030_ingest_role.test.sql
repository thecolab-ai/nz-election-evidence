-- The scoped worker role: can run a full cycle through the ingestion functions, and
-- cannot rewrite history, approve identities, clear rights, activate schedules or publish.
-- TEST FIXTURES ONLY: synthetic records, rolled back.
begin;
select plan(16);

grant evidence_ingest, evidence_publisher to current_user;
create temp table outcome (name text primary key, state text);
grant all on outcome to evidence_ingest, evidence_publisher;

set local role evidence_ingest;
do $$
declare
  v_holder uuid := '33333333-3333-3333-3333-333333333333';
  v_run uuid;
  v_result jsonb;
  v_case record;
begin
  perform evidence_private.sync_registry(jsonb_build_object('sources', jsonb_build_array(
    jsonb_build_object('source_id', 'fixture_role', 'title', 'Fixture role source', 'publisher', 'Fixture Publisher',
      'official_url', 'https://fixture.example/mps', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
      'allowed_hosts', jsonb_build_array('fixture.example'), 'view_scope', 'current_parliament',
      'snapshot_semantics', 'complete_snapshot', 'enabled', true, 'config_hash', 'c1'))));
  perform evidence_private.acquire_lease('fixture_role', v_holder, 60);
  v_run := (evidence_private.start_run('fixture_role', v_holder, 'v1', 'incremental', 'test', 'm') ->> 'run_id')::uuid;
  v_result := evidence_private.ingest_batch(v_run, v_holder, jsonb_build_array(
    jsonb_build_object('external_record_id', 'fixture-member', 'record_kind', 'mp_directory_entry',
      'content_hash', 'sha256:' || repeat('f', 64), 'source_url', 'https://fixture.example/mps/fixture-member',
      'retrieved_at', now(), 'safe_payload', jsonb_build_object('name_display', 'Fixture Member',
        'party_label', 'Fixture Party', 'representation', 'list'))));
  insert into outcome values ('cycle_versions', v_result ->> 'versions_inserted');
  perform evidence_private.log_fetch(v_run, 'fixture_role', jsonb_build_array(jsonb_build_object(
    'method', 'GET', 'url', 'https://fixture.example/mps', 'host', 'fixture.example', 'attempt', 1,
    'outcome', 'ok', 'http_status', 200, 'bytes', 10, 'retrieved_at', now(), 'duration_ms', 5)));
  perform evidence_private.project_run(v_run, v_holder);
  v_result := evidence_private.finish_run(v_run, v_holder, 'succeeded', true, null, null, null);
  insert into outcome values ('cycle_status', v_result ->> 'status');

  for v_case in select * from (values
    ('update_version', $q$update evidence_private.source_record_versions set safe_payload = '{}'::jsonb$q$),
    ('delete_version', $q$delete from evidence_private.source_record_versions$q$),
    ('delete_record', $q$delete from evidence_private.source_records$q$),
    ('delete_run', $q$delete from evidence_private.import_runs$q$),
    ('approve_identity', $q$insert into evidence_private.identity_decisions (subject_kind, person_identity_id, decision, method, decided_by)
        select 'person', id, 'approved', 'manual_source_review', 'worker' from evidence_private.person_source_identities limit 1$q$),
    ('create_person', $q$insert into evidence_private.people (display_name, public_role_basis) values ('X', 'candidate')$q$),
    ('read_memberships', $q$select count(*) from evidence_private.app_memberships$q$),
    ('activate_schedule', $q$select evidence_private.activate_schedule('x', gen_random_uuid(), 'v', 'worker')$q$),
    ('read_vault', $q$select evidence_private.vault_secret('evidence_cron_secret')$q$),
    ('open_gate', $q$update evidence_private.release_gates set state = 'open', evidence_reference = 'x', decided_by = 'w', decided_at = now()$q$),
    ('publish', $q$select evidence_private.publish_batch(gen_random_uuid())$q$),
    ('write_api', $q$insert into evidence_api.sources values ('x', 'x', 'x', 'https://x', 'general', null, gen_random_uuid())$q$)
  ) as c(name, stmt) loop
    begin
      execute v_case.stmt;
      insert into outcome values (v_case.name, 'ALLOWED');
    exception when others then
      insert into outcome values (v_case.name, sqlstate);
    end;
  end loop;
end
$$;
reset role;

select is((select state from outcome where name = 'cycle_versions'), '1', 'worker role can ingest through the functions');
select is((select state from outcome where name = 'cycle_status'), 'succeeded', 'worker role can finish a run');
select is((select count(*)::int from evidence_private.parliamentary_service_terms t
            join evidence_private.person_source_identities i on i.id = t.person_identity_id
            where i.source_id = 'fixture_role' and t.representation = 'list' and t.electorate_name_at_source is null), 1,
  'worker projection creates the service term');
select is((select count(*)::int from evidence_private.candidacies), 0, 'a sitting member creates no candidacy');

select is((select state from outcome where name = 'update_version'), '42501', 'worker cannot update versions');
select is((select state from outcome where name = 'delete_version'), '42501', 'worker cannot delete versions');
select is((select state from outcome where name = 'delete_record'), '42501', 'worker cannot delete records');
select is((select state from outcome where name = 'delete_run'), '42501', 'worker cannot delete run history');
select is((select state from outcome where name = 'approve_identity'), '42501', 'worker cannot approve an identity decision');
select is((select state from outcome where name = 'create_person'), '42501', 'worker cannot create canonical people');
select is((select state from outcome where name = 'read_memberships'), '42501', 'worker cannot read memberships');
select is((select state from outcome where name = 'activate_schedule'), '42501', 'worker cannot activate a schedule');
select is((select state from outcome where name = 'read_vault'), '42501', 'worker cannot read vault secrets');
select is((select state from outcome where name = 'open_gate'), '42501', 'worker cannot open a release gate');
select is((select state from outcome where name = 'publish'), '42501', 'worker cannot publish');
select is((select state from outcome where name = 'write_api'), '42501', 'worker cannot write published tables');

select * from finish();
rollback;
