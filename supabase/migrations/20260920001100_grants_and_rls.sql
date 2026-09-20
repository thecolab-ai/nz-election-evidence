-- Grants and row level security. Two independent layers:
--   1. SQL grants: browser roles hold nothing on evidence_private or evidence_api.
--   2. RLS: enabled on every table with policies only for the scoped server roles,
--      so a mistaken future grant to a browser role still returns and writes nothing.

-- RLS on everything -------------------------------------------------------------------

do $$
declare
  v_table record;
begin
  for v_table in
    select n.nspname, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('evidence_private', 'evidence_api') and c.relkind = 'r'
  loop
    execute format('alter table %I.%I enable row level security', v_table.nspname, v_table.relname);
    execute format('revoke all on %I.%I from public, anon, authenticated', v_table.nspname, v_table.relname);
  end loop;
end
$$;

-- Inspector reader: SELECT on the allowlisted tables behind the inspector views --------------

do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'sources', 'source_rights', 'source_freshness', 'catalogue_product_map', 'import_runs', 'run_checkpoints',
    'fetch_log', 'ingest_errors', 'source_records', 'source_record_versions', 'source_observations',
    'record_lifecycle_events', 'people', 'parties', 'person_source_identities', 'party_source_identities',
    'identity_decisions', 'parliamentary_service_terms', 'party_affiliations', 'elections', 'boundary_editions',
    'electorates', 'electorate_versions', 'contests', 'candidacies', 'candidacy_status_events',
    'party_list_entries', 'candidate_results', 'result_sets', 'documents', 'bills', 'finance_return_references',
    'polls', 'summary_versions', 'model_runs', 'stat_datasets', 'stat_series', 'stat_releases',
    'geography_versions', 'stat_observations', 'stat_route_reconciliation', 'ingest_schedules',
    'schedule_dispatch_log', 'release_gates', 'version_person_links']
  loop
    execute format('grant select on evidence_private.%I to evidence_inspector_reader', v_name);
    execute format('create policy %I on evidence_private.%I for select to evidence_inspector_reader using (true)',
                   v_name || '_reader_select', v_name);
  end loop;
end
$$;

-- Ingest worker ------------------------------------------------------------------------------------

do $$
declare
  v_name text;
begin
  -- Mutable operational and projection tables.
  foreach v_name in array array[
    'sources', 'source_rights', 'registry_products', 'source_freshness', 'import_runs', 'source_records',
    'person_source_identities', 'party_source_identities', 'parliamentary_service_terms', 'party_affiliations',
    'boundary_editions', 'electorates', 'electorate_versions', 'contests', 'candidacies', 'party_lists',
    'party_list_entries', 'result_sets', 'candidate_results', 'documents', 'bills', 'releases']
  loop
    execute format('grant select, insert, update on evidence_private.%I to evidence_ingest', v_name);
    execute format('create policy %I on evidence_private.%I for all to evidence_ingest using (true) with check (true)',
                   v_name || '_ingest_all', v_name);
  end loop;

  -- Append-only history: insert and read, never update or delete.
  foreach v_name in array array[
    'source_record_versions', 'source_observations', 'run_checkpoints', 'fetch_log', 'ingest_errors',
    'record_lifecycle_events', 'candidacy_status_events', 'schedule_dispatch_log']
  loop
    execute format('grant select, insert on evidence_private.%I to evidence_ingest', v_name);
    execute format('create policy %I on evidence_private.%I for select to evidence_ingest using (true)',
                   v_name || '_ingest_select', v_name);
    execute format('create policy %I on evidence_private.%I for insert to evidence_ingest with check (true)',
                   v_name || '_ingest_insert', v_name);
  end loop;
end
$$;

grant select on evidence_private.elections to evidence_ingest;
create policy elections_ingest_select on evidence_private.elections for select to evidence_ingest using (true);

grant select, insert, update, delete on evidence_private.source_leases to evidence_ingest;
create policy source_leases_ingest_all on evidence_private.source_leases for all to evidence_ingest using (true) with check (true);

grant select, insert, delete on evidence_private.catalogue_product_map to evidence_ingest;
create policy catalogue_product_map_ingest_all on evidence_private.catalogue_product_map for all to evidence_ingest using (true) with check (true);

-- Schedules: config columns only. State, proof and the cron job id are out of the worker's reach.
grant select, insert on evidence_private.ingest_schedules to evidence_ingest;
grant update (source_id, cron_expr, function_slug, max_runtime_seconds, max_records, config_hash)
  on evidence_private.ingest_schedules to evidence_ingest;
create policy ingest_schedules_ingest_select on evidence_private.ingest_schedules for select to evidence_ingest using (true);
create policy ingest_schedules_ingest_insert on evidence_private.ingest_schedules for insert to evidence_ingest
  with check (state = 'inactive' and cron_jobid is null and activation_proof is null);
create policy ingest_schedules_ingest_update on evidence_private.ingest_schedules for update to evidence_ingest
  using (true) with check (true);

-- The worker may file identity proposals. It can never approve or reject one.
grant select, insert on evidence_private.identity_decisions to evidence_ingest;
create policy identity_decisions_ingest_select on evidence_private.identity_decisions for select to evidence_ingest using (true);
create policy identity_decisions_ingest_propose on evidence_private.identity_decisions for insert to evidence_ingest
  with check (decision = 'proposed' and decided_by is null);

-- The worker may create and refresh unresolved identities, never link them.
drop policy person_source_identities_ingest_all on evidence_private.person_source_identities;
create policy person_source_identities_ingest_select on evidence_private.person_source_identities for select to evidence_ingest using (true);
create policy person_source_identities_ingest_insert on evidence_private.person_source_identities for insert to evidence_ingest
  with check (person_id is null and link_status in ('unresolved', 'proposed'));
create policy person_source_identities_ingest_update on evidence_private.person_source_identities for update to evidence_ingest
  using (true) with check (person_id is null and link_status in ('unresolved', 'proposed'));

drop policy party_source_identities_ingest_all on evidence_private.party_source_identities;
create policy party_source_identities_ingest_select on evidence_private.party_source_identities for select to evidence_ingest using (true);
create policy party_source_identities_ingest_insert on evidence_private.party_source_identities for insert to evidence_ingest
  with check (party_id is null and link_status in ('unresolved', 'proposed'));
create policy party_source_identities_ingest_update on evidence_private.party_source_identities for update to evidence_ingest
  using (true) with check (party_id is null and link_status in ('unresolved', 'proposed'));

-- Rights rows arrive only as the register states them; the worker cannot mark one reviewed by itself
-- unless the synced register row carries the review date (enforced by the table check).

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'payload_violation(jsonb)', 'sync_registry(jsonb)', 'sync_schedules(jsonb)',
    'acquire_lease(text, uuid, integer)', 'release_lease(text, uuid)', 'assert_run_held(uuid, uuid)',
    'start_run(text, uuid, text, text, text, text)', 'save_checkpoint(uuid, uuid, jsonb, integer, integer)',
    'log_fetch(uuid, text, jsonb)', 'ingest_batch(uuid, uuid, jsonb)',
    'finish_run(uuid, uuid, text, boolean, text, text, text)', 'ensure_party_identity(text, text)',
    'project_mp_directory(uuid)', 'project_documents(uuid)', 'project_baseline_candidacies(uuid)',
    'project_run(uuid, uuid)']
  loop
    execute format('revoke execute on function evidence_private.%s from public', v_fn);
    execute format('grant execute on function evidence_private.%s to evidence_ingest', v_fn);
  end loop;

  -- Administrative functions: no scoped role may run them.
  foreach v_fn in array array[
    'vault_secret(text)', 'dispatch_ingest(text)', 'activate_schedule(text, uuid, text, text)',
    'deactivate_schedule(text)', 'functions_base_url_ok(text)', 'gates_open()']
  loop
    execute format('revoke execute on function evidence_private.%s from public', v_fn);
  end loop;
end
$$;

-- Publisher: the gated release functions and exactly the rows they touch ------------------------------

do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'release_gates', 'release_items', 'documents', 'source_records', 'source_record_versions', 'sources', 'source_rights']
  loop
    execute format('grant select on evidence_private.%I to evidence_publisher', v_name);
    execute format('create policy %I on evidence_private.%I for select to evidence_publisher using (true)',
                   v_name || '_publisher_select', v_name);
  end loop;
end
$$;

grant select, update on evidence_private.release_batches to evidence_publisher;
create policy release_batches_publisher_all on evidence_private.release_batches for all to evidence_publisher using (true) with check (true);

grant usage on schema evidence_api to evidence_publisher;
grant select, insert, update, delete on evidence_api.sources, evidence_api.document_references to evidence_publisher;
create policy api_sources_publisher_all on evidence_api.sources for all to evidence_publisher using (true) with check (true);
create policy api_document_references_publisher_all on evidence_api.document_references for all to evidence_publisher using (true) with check (true);

revoke execute on function evidence_private.publish_batch(uuid) from public;
revoke execute on function evidence_private.withdraw_batch(uuid, text) from public;
grant execute on function evidence_private.gates_open() to evidence_publisher;
grant execute on function evidence_private.publish_batch(uuid) to evidence_publisher;
grant execute on function evidence_private.withdraw_batch(uuid, text) to evidence_publisher;

-- evidence_api stays closed to browser roles. Opening it is a separate, reviewed migration that
-- may be written only after the R8/R10 gates are recorded (docs/database/publication-policy.md).
