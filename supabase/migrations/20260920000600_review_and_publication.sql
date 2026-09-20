-- Model provenance, summaries, reviews, corrections and the gated publication path.
-- Nothing here clears a rights row or a summary automatically.

create table evidence_private.model_runs (
  id uuid primary key default gen_random_uuid(),
  metadata_status text not null check (metadata_status in ('recorded', 'historical_unknown')),
  provider text,
  model_name text,
  model_version text,
  prompt_or_schema_version text,
  parameters jsonb,
  started_at timestamptz,
  -- Recorded runs carry full provenance; historical gaps stay explicitly unknown.
  check (metadata_status = 'historical_unknown'
         or (provider is not null and model_name is not null and model_version is not null
             and prompt_or_schema_version is not null))
);

-- R9 for derived policy classifications: a model's class label always names the run that produced it, and
-- carries the same explicit confidence semantics as a summary. Any other basis has no model run.
alter table evidence_private.policy_sources
  add column model_run_id uuid references evidence_private.model_runs (id),
  add column confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  add column confidence_status text not null default 'not_applicable'
    check (confidence_status in ('reported', 'not_reported', 'not_applicable')),
  add column confidence_basis text,
  add constraint policy_sources_model_run_iff_model
    check ((classification_basis = 'unreviewed_model') = (model_run_id is not null)),
  add constraint policy_sources_confidence_value_iff_reported
    check ((confidence_status = 'reported') = (confidence is not null)),
  add constraint policy_sources_confidence_basis
    check (confidence_status <> 'reported' or coalesce(trim(confidence_basis), '') <> ''),
  -- a model label states whether the run reported a confidence; only non-model labels are not_applicable
  add constraint policy_sources_confidence_applies_to_models
    check ((classification_basis = 'unreviewed_model') = (confidence_status <> 'not_applicable'));

comment on column evidence_private.policy_sources.model_run_id is
  'The model run that produced policy_class. Required exactly when classification_basis = unreviewed_model (R9).';

create table evidence_private.summary_versions (
  id uuid primary key default gen_random_uuid(),
  model_run_id uuid not null references evidence_private.model_runs (id),
  summary_text text not null,
  output_hash text not null check (output_hash ~ '^sha256:[0-9a-f]{64}$'),
  uncertainty_note text,
  -- R9 confidence. Only a value the model run itself reported is stored; nothing here is estimated or defaulted.
  -- not_reported: the run gave none (unknown, which is not 0). not_applicable: the schema has no such notion.
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  confidence_status text not null default 'not_reported'
    check (confidence_status in ('reported', 'not_reported', 'not_applicable')),
  confidence_basis text,
  review_status text not null default 'unreviewed'
    check (review_status in ('unreviewed', 'in_review', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  check ((confidence_status = 'reported') = (confidence is not null)),
  check (confidence_status <> 'reported' or coalesce(trim(confidence_basis), '') <> '')
);

comment on column evidence_private.summary_versions.confidence is
  'The confidence the model run reported for this output, 0-1. Null unless confidence_status = reported. It describes the model''s output, never the accuracy or honesty of any person or party (R1, R4).';
comment on column evidence_private.summary_versions.confidence_basis is
  'What the reported number is, in the run''s own terms (for example "mean token log-probability" or "self-reported 0-1"). Required with a value.';

-- R9: "a documented human-agreement rate ... for that schema". This is a property of a schema or prompt
-- version measured on a sample, NOT of any one output: approving one summary (review_decisions) says nothing
-- about how often the schema agrees with people, and an agreement study approves no individual output.
create table evidence_private.schema_agreement_validations (
  id uuid primary key default gen_random_uuid(),
  prompt_or_schema_version text not null check (trim(prompt_or_schema_version) <> ''),
  output_kind text not null check (output_kind in ('summary', 'policy_classification')),
  sample_size integer not null check (sample_size > 0),
  agreements integer not null check (agreements >= 0),
  agreement_rate numeric generated always as (round(agreements::numeric / sample_size, 4)) stored,
  method_url text not null check (method_url ~ '^https://'),
  validated_by text not null check (trim(validated_by) <> ''),
  validated_at timestamptz not null default now(),
  check (agreements <= sample_size)
);

comment on table evidence_private.schema_agreement_validations is
  'Documented human-agreement studies per schema/prompt version (R9). Until a row exists for a version, every output of that version is shown as not yet checked against human review. Distinct from per-output review_decisions. Written only by an administrator on a person''s instruction.';

create trigger schema_agreement_validations_append_only
  before update or delete on evidence_private.schema_agreement_validations
  for each row execute function evidence_private.reject_mutation();

create table evidence_private.summary_inputs (
  summary_id uuid not null references evidence_private.summary_versions (id),
  version_id uuid not null references evidence_private.source_record_versions (id),
  primary key (summary_id, version_id)
);

create table evidence_private.review_decisions (
  id uuid primary key default gen_random_uuid(),
  subject_kind text not null check (subject_kind in ('summary_version', 'source_record_version', 'relationship')),
  subject_id uuid not null,
  subject_hash text not null,
  decision text not null check (decision in ('approved', 'rejected', 'needs_changes')),
  reviewer text not null,
  rubric_version text not null,
  note text,
  decided_at timestamptz not null default now()
);

create trigger review_decisions_append_only
  before update or delete on evidence_private.review_decisions
  for each row execute function evidence_private.reject_mutation();

-- A summary becomes approved only through a human review of that exact output.
create or replace function evidence_private.guard_summary_review()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.summary_text <> old.summary_text or new.output_hash <> old.output_hash
                            or new.model_run_id <> old.model_run_id
                            or new.confidence is distinct from old.confidence
                            or new.confidence_status <> old.confidence_status
                            or new.confidence_basis is distinct from old.confidence_basis) then
    raise exception 'summary text is immutable; a regenerated summary is a new row' using errcode = 'P0001';
  end if;
  if new.review_status = 'approved' and not exists (
    select 1 from evidence_private.review_decisions r
    where r.subject_kind = 'summary_version'
      and r.subject_id = new.id
      and r.subject_hash = new.output_hash
      and r.decision = 'approved')
  then
    raise exception 'summary approval needs a recorded human review of this exact output hash'
      using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger summary_versions_review_guard
  before insert or update on evidence_private.summary_versions
  for each row execute function evidence_private.guard_summary_review();

create trigger summary_versions_no_delete
  before delete on evidence_private.summary_versions
  for each row execute function evidence_private.reject_mutation();

create table evidence_private.corrections (
  id uuid primary key default gen_random_uuid(),
  subject_kind text not null,
  subject_id uuid not null,
  supersedes_correction_id uuid references evidence_private.corrections (id),
  description text not null,
  corrections_log_reference text not null,
  confirmed_at timestamptz not null,
  recorded_at timestamptz not null default now()
);

comment on column evidence_private.corrections.corrections_log_reference is
  'Pointer to the matching CORRECTIONS.md entry (R5). Corrections supersede; they never erase.';

create trigger corrections_append_only
  before update or delete on evidence_private.corrections
  for each row execute function evidence_private.reject_mutation();

-- Release gates ----------------------------------------------------------------

create table evidence_private.release_gates (
  gate_key text primary key check (gate_key in (
    'r10_public_surface_review', 'r8_accountable_legal_entity', 'election_day_freeze_clear')),
  state text not null default 'closed' check (state in ('closed', 'open')),
  evidence_reference text,
  decided_by text,
  decided_at timestamptz,
  check (state = 'closed' or (evidence_reference is not null and decided_by is not null and decided_at is not null))
);

insert into evidence_private.release_gates (gate_key) values
  ('r10_public_surface_review'), ('r8_accountable_legal_entity'), ('election_day_freeze_clear');

create table evidence_private.release_batches (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'draft' check (status in ('draft', 'released', 'withdrawn')),
  created_by text not null,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  withdrawn_at timestamptz,
  withdrawal_reason text
);

create table evidence_private.release_items (
  batch_id uuid not null references evidence_private.release_batches (id),
  item_kind text not null check (item_kind in ('source', 'document_reference')),
  source_id text references evidence_private.sources (source_id),
  document_id uuid references evidence_private.documents (id),
  version_id uuid references evidence_private.source_record_versions (id),
  check ((item_kind = 'source') = (source_id is not null and document_id is null)),
  check ((item_kind = 'document_reference') = (document_id is not null and version_id is not null))
);

create unique index release_items_source on evidence_private.release_items (batch_id, source_id) where item_kind = 'source';
create unique index release_items_document on evidence_private.release_items (batch_id, document_id) where item_kind = 'document_reference';

-- Published projections (physically separate) ------------------------------------

create table evidence_api.sources (
  source_id text primary key,
  title text not null,
  publisher text not null,
  official_url text not null,
  view_scope text not null,
  attribution text,
  release_batch_id uuid not null
);

create table evidence_api.document_references (
  document_id uuid primary key,
  source_id text not null references evidence_api.sources (source_id),
  document_type text not null,
  title text,
  official_url text not null,
  source_published_at timestamptz,
  first_retrieved_at timestamptz not null,
  release_batch_id uuid not null
);

comment on table evidence_api.document_references is
  'Link-only document references. Every row points at a published source row (referential closure).';

create or replace function evidence_private.gates_open()
returns boolean
language sql
stable
set search_path = ''
as $$
  select not exists (select 1 from evidence_private.release_gates where state <> 'open');
$$;

-- Gated release. Fails closed on any unmet condition and copies allowlisted
-- columns only. Takes a batch id; accepts no SQL text and no column list.
create or replace function evidence_private.publish_batch(p_batch_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_blocked text;
  v_count integer := 0;
  v_rows integer;
begin
  select status into v_status from evidence_private.release_batches where id = p_batch_id for update;
  if v_status is null then
    raise exception 'release batch not found' using errcode = 'P0001';
  end if;
  if v_status <> 'draft' then
    raise exception 'release batch is % and cannot be released again', v_status using errcode = 'P0001';
  end if;
  if not evidence_private.gates_open() then
    raise exception 'release gates are closed: R8/R10 review and the election-day check must be recorded first'
      using errcode = 'P0001';
  end if;

  -- Every item needs an approved rights row. Pending never publishes.
  select string_agg(distinct s.source_id, ', ') into v_blocked
  from evidence_private.release_items i
  left join evidence_private.documents d on d.id = i.document_id
  left join evidence_private.source_records r on r.id = d.source_record_id
  join evidence_private.sources s on s.source_id = coalesce(i.source_id, r.source_id)
  left join evidence_private.source_rights sr on sr.rights_id = s.rights_id
  where i.batch_id = p_batch_id
    and coalesce(sr.review_status, 'pending') <> 'approved';
  if v_blocked is not null then
    raise exception 'rights review is not approved for: %', v_blocked using errcode = 'P0001';
  end if;

  -- A document item must reference the record's current version (stale review fails closed).
  if exists (
    select 1
    from evidence_private.release_items i
    join evidence_private.documents d on d.id = i.document_id
    join evidence_private.source_records r on r.id = d.source_record_id
    where i.batch_id = p_batch_id
      and i.item_kind = 'document_reference'
      and (r.current_version_id is distinct from i.version_id or r.tombstoned_at is not null))
  then
    raise exception 'a document item is stale or tombstoned; rebuild the batch' using errcode = 'P0001';
  end if;

  -- Referential closure: a document's source must be published in this or an earlier batch.
  if exists (
    select 1
    from evidence_private.release_items i
    join evidence_private.documents d on d.id = i.document_id
    join evidence_private.source_records r on r.id = d.source_record_id
    where i.batch_id = p_batch_id
      and i.item_kind = 'document_reference'
      and not exists (select 1 from evidence_api.sources ps where ps.source_id = r.source_id)
      and not exists (
        select 1 from evidence_private.release_items si
        where si.batch_id = p_batch_id and si.item_kind = 'source' and si.source_id = r.source_id))
  then
    raise exception 'a document item references a source that is not published' using errcode = 'P0001';
  end if;

  insert into evidence_api.sources (source_id, title, publisher, official_url, view_scope, attribution, release_batch_id)
  select s.source_id, s.title, s.publisher, s.official_url, s.view_scope, sr.attribution, p_batch_id
  from evidence_private.release_items i
  join evidence_private.sources s on s.source_id = i.source_id
  left join evidence_private.source_rights sr on sr.rights_id = s.rights_id
  where i.batch_id = p_batch_id and i.item_kind = 'source'
  on conflict (source_id) do update
    set title = excluded.title, publisher = excluded.publisher, official_url = excluded.official_url,
        view_scope = excluded.view_scope, attribution = excluded.attribution,
        release_batch_id = excluded.release_batch_id;
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  insert into evidence_api.document_references (
    document_id, source_id, document_type, title, official_url, source_published_at, first_retrieved_at, release_batch_id)
  select d.id, r.source_id, d.document_type, d.title, d.official_url, v.source_published_at, v.first_retrieved_at, p_batch_id
  from evidence_private.release_items i
  join evidence_private.documents d on d.id = i.document_id
  join evidence_private.source_records r on r.id = d.source_record_id
  join evidence_private.source_record_versions v on v.id = i.version_id
  where i.batch_id = p_batch_id and i.item_kind = 'document_reference'
  on conflict (document_id) do update
    set title = excluded.title, official_url = excluded.official_url,
        source_published_at = excluded.source_published_at, release_batch_id = excluded.release_batch_id;
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  update evidence_private.release_batches set status = 'released', released_at = now() where id = p_batch_id;
  return v_count;
end
$$;

-- Withdrawal removes the published rows and keeps the batch record.
create or replace function evidence_private.withdraw_batch(p_batch_id uuid, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'withdrawal needs a written reason' using errcode = 'P0001';
  end if;
  delete from evidence_api.document_references where release_batch_id = p_batch_id;
  delete from evidence_api.sources s
   where s.release_batch_id = p_batch_id
     and not exists (select 1 from evidence_api.document_references dr where dr.source_id = s.source_id);
  update evidence_private.release_batches
     set status = 'withdrawn', withdrawn_at = now(), withdrawal_reason = p_reason
   where id = p_batch_id and status = 'released';
  if not found then
    raise exception 'only a released batch can be withdrawn' using errcode = 'P0001';
  end if;
end
$$;
