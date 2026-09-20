-- Typed projections from immutable record versions into the civic and document
-- model. Idempotent: replaying a run changes nothing. No projection links two
-- source identities to one person; that needs a reviewed identity decision.

create or replace function evidence_private.ensure_party_identity(p_source_id text, p_label text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_label text := trim(p_label);
begin
  if v_label is null or v_label = '' then
    return null;
  end if;
  insert into evidence_private.party_source_identities (source_id, external_id, name_at_source, is_independent_label)
  values (p_source_id, lower(v_label), v_label, lower(v_label) in ('independent', 'ind', 'no party'))
  on conflict (source_id, external_id) do update set name_at_source = excluded.name_at_source
  returning id into v_id;
  return v_id;
end
$$;

-- Members of Parliament directory -------------------------------------------------
-- A directory sighting records a sitting member. It creates no candidacy.

create or replace function evidence_private.project_mp_directory(p_run_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_row record;
  v_identity uuid;
  v_party uuid;
  v_term uuid;
  v_count integer := 0;
begin
  for v_row in
    select r.source_id, r.external_record_id, v.id as version_id, v.safe_payload as p, o.observed_at
    from evidence_private.source_observations o
    join evidence_private.source_record_versions v on v.id = o.version_id
    join evidence_private.source_records r on r.id = v.record_id
    where o.run_id = p_run_id and v.record_kind = 'mp_directory_entry'
  loop
    insert into evidence_private.person_source_identities (
      source_id, external_id, identity_scheme, name_at_source, first_version_id)
    values (v_row.source_id, v_row.external_record_id, 'parliament_profile_slug',
            v_row.p ->> 'name_display', v_row.version_id)
    on conflict (source_id, external_id) do update set name_at_source = excluded.name_at_source
    returning id into v_identity;

    v_party := evidence_private.ensure_party_identity(v_row.source_id, v_row.p ->> 'party_label');

    select t.id into v_term
    from evidence_private.parliamentary_service_terms t
    where t.person_identity_id = v_identity
      and t.basis = 'observed_in_directory'
      and t.representation = v_row.p ->> 'representation'
      and t.electorate_name_at_source is not distinct from nullif(v_row.p ->> 'electorate_label', '')
      and t.party_identity_id is not distinct from v_party
    order by t.observed_last_at desc
    limit 1;

    if v_term is null then
      insert into evidence_private.parliamentary_service_terms (
        person_identity_id, parliament_number, representation, electorate_name_at_source,
        party_identity_id, date_precision, basis, observed_first_at, observed_last_at, evidence_version_id)
      values (
        v_identity, nullif(v_row.p ->> 'parliament_number', '')::integer, v_row.p ->> 'representation',
        nullif(v_row.p ->> 'electorate_label', ''), v_party, 'unknown', 'observed_in_directory',
        v_row.observed_at, v_row.observed_at, v_row.version_id);
    else
      update evidence_private.parliamentary_service_terms
         set observed_first_at = least(observed_first_at, v_row.observed_at),
             observed_last_at = greatest(observed_last_at, v_row.observed_at),
             observed_absent_at = null
       where id = v_term;
    end if;

    if v_party is not null then
      insert into evidence_private.party_affiliations (
        person_identity_id, party_identity_id, date_precision, basis,
        observed_first_at, observed_last_at, evidence_version_id)
      select v_identity, v_party, 'unknown', 'observed_at_source', v_row.observed_at, v_row.observed_at, v_row.version_id
      where not exists (
        select 1 from evidence_private.party_affiliations a
        where a.person_identity_id = v_identity and a.party_identity_id = v_party
          and a.basis = 'observed_at_source');
      update evidence_private.party_affiliations
         set observed_first_at = least(observed_first_at, v_row.observed_at),
             observed_last_at = greatest(observed_last_at, v_row.observed_at)
       where person_identity_id = v_identity and party_identity_id = v_party and basis = 'observed_at_source';
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- Documents: bills and releases -------------------------------------------------------

create or replace function evidence_private.project_documents(p_run_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_row record;
  v_doc uuid;
  v_count integer := 0;
begin
  for v_row in
    select r.id as record_id, r.source_id, v.id as version_id, v.record_kind, v.safe_payload as p,
           v.source_published_at, s.view_scope
    from evidence_private.source_observations o
    join evidence_private.source_record_versions v on v.id = o.version_id
    join evidence_private.source_records r on r.id = v.record_id
    join evidence_private.sources s on s.source_id = r.source_id
    where o.run_id = p_run_id and v.record_kind in ('bill', 'release') and r.current_version_id = v.id
  loop
    insert into evidence_private.documents (source_record_id, document_type, title, official_url, view_scope)
    values (v_row.record_id, v_row.record_kind, v_row.p ->> 'title', v_row.p ->> 'public_page_url', v_row.view_scope)
    on conflict (source_record_id) do update
      set title = excluded.title, official_url = excluded.official_url
    returning id into v_doc;

    if v_row.record_kind = 'bill' then
      insert into evidence_private.bills (
        document_id, bill_number, bill_type, parliament_number, current_stage, select_committee,
        last_activity_at, member_name_at_source, party_label_at_source)
      values (
        v_doc, v_row.p ->> 'bill_number', v_row.p ->> 'bill_type',
        nullif(v_row.p ->> 'parliament_number', '')::integer, v_row.p ->> 'current_stage',
        v_row.p ->> 'select_committee', nullif(v_row.p ->> 'last_activity_at', '')::timestamptz,
        v_row.p ->> 'member_name', v_row.p ->> 'party_label')
      on conflict (document_id) do update set
        bill_number = excluded.bill_number, bill_type = excluded.bill_type,
        parliament_number = excluded.parliament_number, current_stage = excluded.current_stage,
        select_committee = excluded.select_committee, last_activity_at = excluded.last_activity_at,
        member_name_at_source = excluded.member_name_at_source,
        party_label_at_source = excluded.party_label_at_source;
    else
      insert into evidence_private.releases (document_id, published_at, publisher_item_id)
      values (v_doc, v_row.source_published_at, v_row.p ->> 'publisher_item_id')
      on conflict (document_id) do update set
        published_at = excluded.published_at, publisher_item_id = excluded.publisher_item_id;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- 2023 baseline candidacies and results (from an approved export) --------------------------
-- Each export row is its own source identity. Electorate and list rows for what may be
-- the same person stay separate; a name match only files a proposal for human review.

create or replace function evidence_private.project_baseline_candidacies(p_run_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_row record;
  v_election uuid;
  v_edition uuid;
  v_electorate uuid;
  v_ev uuid;
  v_contest uuid;
  v_identity uuid;
  v_party uuid;
  v_candidacy uuid;
  v_list uuid;
  v_result_set uuid;
  v_votes bigint;
  v_count integer := 0;
begin
  select id into v_election from evidence_private.elections where slug = 'general-2023';

  for v_row in
    select r.source_id, r.external_record_id, v.id as version_id, v.safe_payload as p
    from evidence_private.source_observations o
    join evidence_private.source_record_versions v on v.id = o.version_id
    join evidence_private.source_records r on r.id = v.record_id
    where o.run_id = p_run_id and v.record_kind = 'baseline_2023_candidacy' and r.current_version_id = v.id
    order by r.external_record_id
  loop
    if v_row.p ->> 'candidacy_type' not in ('electorate', 'list') or coalesce(v_row.p ->> 'candidate_name', '') = '' then
      insert into evidence_private.ingest_errors (run_id, source_id, error_class, message, record_ref)
      values (p_run_id, v_row.source_id, 'projection_skipped', 'candidacy_type or candidate_name missing', v_row.external_record_id);
      continue;
    end if;

    insert into evidence_private.person_source_identities (
      source_id, external_id, identity_scheme, name_at_source, first_version_id)
    values (v_row.source_id, v_row.external_record_id, 'upstream_candidacy_row', v_row.p ->> 'candidate_name', v_row.version_id)
    on conflict (source_id, external_id) do update set name_at_source = excluded.name_at_source
    returning id into v_identity;

    v_party := evidence_private.ensure_party_identity(v_row.source_id, v_row.p ->> 'party_name');

    if v_row.p ->> 'candidacy_type' = 'electorate' then
      if coalesce(v_row.p ->> 'electorate_name', '') = '' then
        insert into evidence_private.ingest_errors (run_id, source_id, error_class, message, record_ref)
        values (p_run_id, v_row.source_id, 'projection_skipped', 'electorate candidacy without electorate_name', v_row.external_record_id);
        continue;
      end if;
      insert into evidence_private.boundary_editions (slug, title, verified, basis_note)
      values ('boundaries-used-2023', 'Electorate boundaries used at the 2023 General Election', false,
              'Names taken from the 2023 results export. Official identifiers, types and geometry not yet verified.')
      on conflict (slug) do update set slug = excluded.slug
      returning id into v_edition;

      insert into evidence_private.electorates (slug, canonical_name)
      values (regexp_replace(lower(v_row.p ->> 'electorate_name'), '[^a-z0-9āēīōū]+', '-', 'g'), v_row.p ->> 'electorate_name')
      on conflict (slug) do update set slug = excluded.slug
      returning id into v_electorate;

      insert into evidence_private.electorate_versions (electorate_id, boundary_edition_id, name, electorate_type, evidence_version_id)
      values (v_electorate, v_edition, v_row.p ->> 'electorate_name', 'unverified', v_row.version_id)
      on conflict (electorate_id, boundary_edition_id) do update set name = excluded.name
      returning id into v_ev;

      select id into v_contest from evidence_private.contests
       where election_id = v_election and contest_type = 'electorate' and electorate_version_id = v_ev;
      if v_contest is null then
        insert into evidence_private.contests (election_id, contest_type, electorate_version_id)
        values (v_election, 'electorate', v_ev) returning id into v_contest;
      end if;
    else
      select id into v_contest from evidence_private.contests
       where election_id = v_election and contest_type = 'party_list';
      if v_contest is null then
        insert into evidence_private.contests (election_id, contest_type)
        values (v_election, 'party_list') returning id into v_contest;
      end if;
    end if;

    insert into evidence_private.candidacies (
      person_identity_id, election_id, contest_id, candidacy_type, party_identity_id,
      stood_as_independent, current_status, evidence_version_id)
    values (
      v_identity, v_election, v_contest, v_row.p ->> 'candidacy_type', v_party,
      coalesce((select is_independent_label from evidence_private.party_source_identities where id = v_party), false),
      'unknown', v_row.version_id)
    on conflict (person_identity_id, contest_id, candidacy_type) do update set party_identity_id = excluded.party_identity_id
    returning id into v_candidacy;

    -- Official nomination is recorded only when the export states it for an official results source.
    if v_row.p ->> 'nomination_status' = 'officially_nominated' then
      insert into evidence_private.candidacy_status_events (
        candidacy_id, status, date_precision, source_class, evidence_version_id)
      select v_candidacy, 'officially_nominated', 'unknown', 'official_electoral_commission', v_row.version_id
      where not exists (
        select 1 from evidence_private.candidacy_status_events e
        where e.candidacy_id = v_candidacy and e.status = 'officially_nominated');
      update evidence_private.candidacies set current_status = 'officially_nominated'
       where id = v_candidacy and current_status = 'unknown';
    end if;

    if v_row.p ->> 'candidacy_type' = 'list' and nullif(v_row.p ->> 'list_rank', '') is not null
       and (v_row.p ->> 'list_rank')::integer >= 1 and v_party is not null then
      insert into evidence_private.party_lists (election_id, party_identity_id, evidence_version_id)
      values (v_election, v_party, v_row.version_id)
      on conflict (election_id, party_identity_id, list_version) do update set list_version = excluded.list_version
      returning id into v_list;
      insert into evidence_private.party_list_entries (list_id, list_rank, person_identity_id, candidacy_id)
      values (v_list, (v_row.p ->> 'list_rank')::integer, v_identity, v_candidacy)
      on conflict do nothing;
    end if;

    if v_row.p ->> 'candidacy_type' = 'electorate' then
      select id into v_result_set from evidence_private.result_sets
       where election_id = v_election and result_status = 'final' order by id limit 1;
      if v_result_set is null then
        insert into evidence_private.result_sets (election_id, result_status, source_version_id)
        values (v_election, 'final', v_row.version_id) returning id into v_result_set;
      end if;
      -- The upstream column cannot hold null, so a zero there is ambiguous and stays "not reported".
      v_votes := nullif(v_row.p ->> 'candidate_votes', '')::bigint;
      insert into evidence_private.candidate_results (result_set_id, candidacy_id, votes, value_status)
      values (v_result_set, v_candidacy,
              case when v_votes > 0 then v_votes end,
              case when v_votes > 0 then 'reported' else 'not_reported' end)
      on conflict (result_set_id, candidacy_id) do update
        set votes = excluded.votes, value_status = excluded.value_status;
    end if;

    -- Same display name elsewhere in this source: nominate for review, never link.
    insert into evidence_private.identity_decisions (subject_kind, person_identity_id, decision, method, evidence)
    select 'person', v_identity, 'proposed', 'name_similarity_nomination',
           jsonb_build_object('same_name_identity_id', other.id, 'note', 'same name in same source; needs human review')
    from evidence_private.person_source_identities other
    where other.source_id = v_row.source_id and other.id <> v_identity
      and other.name_at_source = v_row.p ->> 'candidate_name'
      and not exists (
        select 1 from evidence_private.identity_decisions d
        where d.person_identity_id = v_identity
          and d.evidence ->> 'same_name_identity_id' = other.id::text);

    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

create or replace function evidence_private.project_run(p_run_id uuid, p_holder uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  perform evidence_private.assert_run_held(p_run_id, p_holder);
  return jsonb_build_object(
    'mp_directory', evidence_private.project_mp_directory(p_run_id),
    'documents', evidence_private.project_documents(p_run_id),
    'baseline_candidacies', evidence_private.project_baseline_candidacies(p_run_id));
end
$$;
