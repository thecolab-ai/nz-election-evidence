-- The scoped worker role: can run a full cycle through the ingestion functions, and
-- cannot rewrite history, approve identities, clear rights, activate schedules or publish.
-- TEST FIXTURES ONLY: synthetic records, rolled back.
begin;
select plan(25);

grant evidence_ingest, evidence_publisher to current_user;

-- review 14 fixture: one ACTIVE and one inactive schedule, created by the administrator before the worker acts.
select evidence_private.sync_registry(jsonb_build_object('rights', jsonb_build_array(jsonb_build_object('rights_id', 'RIGHTS-95', 'publisher', 'Fixture Publisher',
    'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h1')),
  'sources', jsonb_build_array(
    jsonb_build_object('source_id', 'pgtap_sched_a', 'title', 'Fixture A', 'publisher', 'Fixture Publisher', 'official_url', 'https://fixture.example/a',
      'adapter_kind', 'live_fetch', 'adapter_name', 'fixture', 'access_basis', 'public_page', 'allowed_hosts', jsonb_build_array('fixture.example'),
      'rights_id', 'RIGHTS-95', 'view_scope', 'general', 'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'c'),
    jsonb_build_object('source_id', 'pgtap_sched_b', 'title', 'Fixture B', 'publisher', 'Fixture Publisher', 'official_url', 'https://fixture.example/b',
      'adapter_kind', 'live_fetch', 'adapter_name', 'fixture', 'access_basis', 'public_page', 'allowed_hosts', jsonb_build_array('fixture.example'),
      'rights_id', 'RIGHTS-95', 'view_scope', 'general', 'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'c'))));
insert into evidence_private.ingest_schedules (schedule_key, source_id, cron_expr, function_slug, max_runtime_seconds, max_records, state, cron_jobid, activation_proof, activated_by, activated_at, config_hash)
values ('pgtap-role-active', 'pgtap_sched_a', '5 * * * *', 'ingest-run', 60, 100, 'active', 999999, '{"fixture": true}', 'TEST FIXTURE', now(), 'x'),
       ('pgtap-role-inactive', 'pgtap_sched_a', '5 * * * *', 'ingest-run', 60, 100, 'inactive', null, null, null, null, 'x');
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
  perform evidence_private.sync_registry(jsonb_build_object('rights', jsonb_build_array(jsonb_build_object('rights_id', 'RIGHTS-93', 'publisher', 'Fixture Publisher', 'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h1')), 'sources', jsonb_build_array(
    jsonb_build_object('source_id', 'pgtap_role', 'title', 'Fixture role source', 'publisher', 'Fixture Publisher',
      'official_url', 'https://fixture.example/mps', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture', 'access_basis', 'public_page',
      'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-93', 'view_scope', 'current_parliament',
      'snapshot_semantics', 'complete_snapshot', 'enabled', true, 'config_hash', 'c1'))));
  perform evidence_private.acquire_lease('pgtap_role', v_holder, 60);
  v_run := (evidence_private.start_run('pgtap_role', v_holder, 'v1', 'incremental', 'test', 'm') ->> 'run_id')::uuid;
  v_result := evidence_private.ingest_batch(v_run, v_holder, jsonb_build_array(
    jsonb_build_object('external_record_id', 'fixture-member', 'record_kind', 'mp_directory_entry',
      'content_hash', 'sha256:' || repeat('f', 64), 'source_url', 'https://fixture.example/mps/fixture-member',
      'retrieved_at', now(), 'safe_payload', jsonb_build_object('name_display', 'Fixture Member',
        'party_label', 'Fixture Party', 'representation', 'list'))));
  insert into outcome values ('cycle_versions', v_result ->> 'versions_inserted');
  perform evidence_private.log_fetch(v_run, 'pgtap_role', jsonb_build_array(jsonb_build_object(
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
    ('approve_rights', $q$select evidence_private.sync_registry(jsonb_build_object('rights', jsonb_build_array(jsonb_build_object(
        'rights_id', 'RIGHTS-92', 'publisher', 'Fixture Publisher', 'source_url', 'https://fixture.example/',
        'review_status', 'approved', 'default_release', 'approved-fields', 'reviewed_on', '2026-09-20', 'register_hash', 'h'))))$q$),
    ('repoint_active_schedule', $q$update evidence_private.ingest_schedules set source_id = 'pgtap_sched_b', cron_expr = '* * * * *' where schedule_key = 'pgtap-role-active'$q$),
    ('edit_inactive_schedule', $q$update evidence_private.ingest_schedules set source_id = 'pgtap_sched_b' where schedule_key = 'pgtap-role-inactive'$q$),
    ('self_activate_schedule', $q$update evidence_private.ingest_schedules set state = 'active' where schedule_key = 'pgtap-role-inactive'$q$),
    ('record_access_check', $q$insert into evidence_private.publisher_access_checks (source_id, check_kind, checked_url, checked_host, target_path, outcome, http_status, finding, checked_at, tool_version)
        values ('pgtap_role', 'robots_txt', 'https://fixture.example/robots.txt', 'fixture.example', '/mps', 'not_found', 404, 'no_rules_published', now(), 'TEST FIXTURE')$q$),
    ('write_terms_review', $q$insert into evidence_private.publisher_terms_reviews (source_id, rights_id, terms_url, terms_check_id, robots_check_id, automated_access, reviewed_by)
        values ('pgtap_role', 'RIGHTS-93', 'https://fixture.example/terms', 1, 1, 'permitted', 'worker')$q$),
    ('write_agreement_study', $q$insert into evidence_private.schema_agreement_validations (prompt_or_schema_version, output_kind, sample_size, agreements, method_url, validated_by)
        values ('v1', 'summary', 10, 10, 'https://fixture.example/method', 'worker')$q$),
    ('register_delete_withheld', $q$delete from evidence_private.public_withheld$q$),
    ('register_update_lineage', $q$update evidence_private.public_lineage set lineage_kind = 'not_source_data', lineage_sql = null$q$),
    ('register_insert_column', $q$insert into evidence_private.public_columns (object_schema, object_name, column_name, release_class) values ('evidence_private', 'app_memberships', 'user_id', 'link')$q$),
    ('register_delete_row_rule', $q$delete from evidence_private.public_row_rules$q$),
    ('register_classify', $q$select evidence_private.classify_public_columns()$q$),
    ('register_rebuild', $q$select evidence_private.rebuild_exposed_views()$q$),
    ('ddl_create_view', $q$create view evidence_open.leak as select * from evidence_private.app_memberships$q$),
    ('ddl_alter_table', $q$alter table evidence_private.source_rights disable row level security$q$),
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
            where i.source_id = 'pgtap_role' and t.representation = 'list' and t.electorate_name_at_source is null), 1,
  'worker projection creates the service term');
select is((select count(*)::int from evidence_private.candidacies c
            join evidence_private.person_source_identities i on i.id = c.person_identity_id
            where i.source_id = 'pgtap_role'), 0, 'a sitting member creates no candidacy');

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
select is((select state from outcome where name = 'approve_rights'), '42501', 'worker cannot clear a rights row, even through the registry sync');
select is((select state from outcome where name = 'publish'), '42501', 'worker cannot publish');
select is((select state from outcome where name = 'write_api'), '42501', 'worker cannot write published tables');

-- review 14
select is((select source_id || ' ' || cron_expr from evidence_private.ingest_schedules where schedule_key = 'pgtap-role-active'), 'pgtap_sched_a 5 * * * *',
  'review 14: the worker cannot repoint or retime an ACTIVE schedule (row level security hides it from UPDATE)');
select is((select source_id from evidence_private.ingest_schedules where schedule_key = 'pgtap-role-inactive'), 'pgtap_sched_b', 'the worker can still sync an inactive schedule');
select is((select state from outcome where name = 'self_activate_schedule'), '42501', 'the worker cannot flip a schedule to active');
-- publisher access
select is((select state from outcome where name = 'record_access_check'), 'ALLOWED', 'the worker can record a robots.txt or terms-page retrieval');
select is((select state from outcome where name = 'write_terms_review'), '42501', 'the worker can never write a terms review: that is a person''s reading');
select is((select state from outcome where name = 'write_agreement_study'), '42501', 'the worker can never write a human-agreement study');
-- projection registers and DDL
select is((select string_agg(name || '=' || state, ' ' order by name) from outcome where name like 'register_%'),
  'register_classify=42501 register_delete_row_rule=42501 register_delete_withheld=42501 register_insert_column=42501 register_rebuild=42501 register_update_lineage=42501',
  'the worker cannot edit a projection register or regenerate the public views');
select is((select string_agg(name || '=' || state, ' ' order by name) from outcome where name like 'ddl_%'), 'ddl_alter_table=42501 ddl_create_view=42501',
  'the worker cannot create a view in an exposed schema or switch off row level security');

select * from finish();
rollback;
