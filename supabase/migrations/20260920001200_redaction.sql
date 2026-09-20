-- Documented erasure path. History is append-only for corrections, but a lawful privacy or
-- takedown request must still be honourable. Redaction blanks one stored projection, keeps the
-- row (so lineage and counts stay explainable), and records who did it and why.
-- Administrator only: no scoped role receives EXECUTE.

create or replace function evidence_private.guard_version_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and current_setting('evidence.redaction_in_progress', true) = 'on'
     and new.id = old.id and new.record_id = old.record_id and new.content_hash = old.content_hash
     and new.import_run_id = old.import_run_id and new.first_retrieved_at = old.first_retrieved_at
     and new.safe_payload = '{"redacted": true}'::jsonb
  then
    return new;
  end if;
  raise exception 'append-only: % on %.% is not permitted; supersede with a new row',
    tg_op, tg_table_schema, tg_table_name using errcode = 'P0001';
end
$$;

drop trigger source_record_versions_append_only on evidence_private.source_record_versions;
create trigger source_record_versions_append_only
  before update or delete on evidence_private.source_record_versions
  for each row execute function evidence_private.guard_version_mutation();

create or replace function evidence_private.redact_version(p_version_id uuid, p_reason text, p_requested_by text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_record uuid;
begin
  if coalesce(length(trim(p_reason)), 0) < 10 or coalesce(trim(p_requested_by), '') = '' then
    raise exception 'redaction needs a written reason and a named requester' using errcode = 'P0001';
  end if;
  select record_id into v_record from evidence_private.source_record_versions where id = p_version_id;
  if v_record is null then
    raise exception 'version not found' using errcode = 'P0001';
  end if;
  perform set_config('evidence.redaction_in_progress', 'on', true);
  update evidence_private.source_record_versions
     set safe_payload = '{"redacted": true}'::jsonb,
         omitted_fields = omitted_fields || jsonb_build_array(jsonb_build_object('field', '*', 'reason', 'redacted: ' || left(p_reason, 300)))
   where id = p_version_id;
  perform set_config('evidence.redaction_in_progress', 'off', true);
  insert into evidence_private.record_lifecycle_events (record_id, event, reason, requested_by)
  values (v_record, 'redacted', left(p_reason, 500), left(p_requested_by, 200));
end
$$;

revoke execute on function evidence_private.redact_version(uuid, text, text) from public;
revoke execute on function evidence_private.guard_version_mutation() from public;

comment on function evidence_private.redact_version(uuid, text, text) is
  'Administrator-only erasure path. Blanks one projection, keeps lineage, logs a lifecycle event. Remove any published copy with withdraw_batch first.';
