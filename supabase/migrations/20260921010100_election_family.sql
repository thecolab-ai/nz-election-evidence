-- Election family: destinations and projections for the 2023 results (nationwide and by electorate), party policy
-- pages, party-vote polls, the political finance document indexes with Commission-published totals, and the
-- 2026 civic links the upstream store really holds.
--
-- Rules this migration keeps:
--   * One fact, one counted row. Candidate votes arrive by two routes (the 2023 candidacy product and the electorate
--     pages). The electorate-page lines are NOT written to candidate_results a second time: each becomes a route
--     check against the candidacy product's row, joined by that product's identifier, never by name. Party votes by
--     electorate are checked against the nationwide table instead of being added to it.
--   * Unknown is not zero. A number exists only with value_status reported (or reported_nil where the publisher
--     printed NIL). Absent stays absent.
--   * No policy class without a recorded model run or a person's review: policy pages project as unknown / none.
--   * No name joins. Finance documents carry the published candidate and party labels; they are not linked to a
--     candidacy here.

-- Tables -----------------------------------------------------------------------------------------------------------

create table evidence_private.election_result_totals (
  result_set_id uuid primary key references evidence_private.result_sets (id),
  party_votes bigint check (party_votes >= 0),
  electorate_seats integer check (electorate_seats >= 0),
  list_seats integer check (list_seats >= 0),
  total_seats integer check (total_seats >= 0),
  value_status text not null check (value_status in ('reported', 'not_reported')),
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  check ((value_status = 'reported') = (party_votes is not null))
);
comment on table evidence_private.election_result_totals is
  'The total line a results table itself prints. Kept apart from the party lines so it is never added to them.';

create table evidence_private.electorate_result_summaries (
  result_set_id uuid not null references evidence_private.result_sets (id),
  contest_id uuid not null references evidence_private.contests (id),
  candidate_votes_with_informals bigint check (candidate_votes_with_informals >= 0),
  candidate_informals bigint check (candidate_informals >= 0),
  candidate_lines integer check (candidate_lines >= 0),
  party_votes_with_informals bigint check (party_votes_with_informals >= 0),
  party_informals bigint check (party_informals >= 0),
  party_lines integer check (party_lines >= 0),
  votes_counted bigint check (votes_counted >= 0),
  votes_counted_pct numeric(7, 3) check (votes_counted_pct between 0 and 100),
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  primary key (result_set_id, contest_id)
);
comment on table evidence_private.electorate_result_summaries is
  'Totals an official electorate page prints for itself. The published totals include informal votes; line items do not.';

create table evidence_private.result_route_checks (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references evidence_private.elections (id),
  check_kind text not null check (check_kind in ('candidate_votes_same_fact', 'party_votes_sum_to_nationwide_total')),
  source_record_id uuid not null references evidence_private.source_records (id),
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  other_version_id uuid references evidence_private.source_record_versions (id),
  candidacy_id uuid references evidence_private.candidacies (id),
  this_route_votes bigint check (this_route_votes >= 0),
  other_route_votes bigint check (other_route_votes >= 0),
  outcome text not null check (outcome in ('agrees', 'disagrees', 'other_route_not_loaded')),
  counted_route text not null,
  note text not null,
  -- One check per record, not per version: a new version of a line replaces its check instead of leaving a stale one.
  unique (check_kind, source_record_id),
  check ((outcome = 'other_route_not_loaded') = (other_route_votes is null))
);
comment on table evidence_private.result_route_checks is
  'Where one published fact reaches the store by two routes, the second route is recorded here as a check against the first. It is never a second counted row. counted_route names the source whose rows are the ones to count.';

create table evidence_private.finance_published_aggregates (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null references evidence_private.source_records (id),
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  finance_return_id uuid references evidence_private.finance_return_references (id),
  party_identity_id uuid references evidence_private.party_source_identities (id),
  reporting_year integer not null check (reporting_year between 1990 and 2100),
  metric text not null check (metric in (
    'candidate_expenses', 'candidate_donations', 'candidate_loans', 'party_donations_sum', 'party_loans_sum')),
  amount_nzd numeric(18, 2) check (amount_nzd >= 0),
  value_status text not null check (value_status in ('reported', 'reported_nil', 'not_reported')),
  basis text not null check (basis in ('commission_index_page_as_published', 'commission_published_summary_not_recomputed')),
  unique (source_record_id, metric),
  check ((value_status = 'not_reported') = (amount_nzd is null)),
  check (value_status <> 'reported_nil' or amount_nzd = 0)
);
comment on table evidence_private.finance_published_aggregates is
  'Totals exactly as the Electoral Commission prints them on its own pages. Nothing here is read from inside a return or recomputed from individual entries, and the table has no column that could hold one.';

create table evidence_private.election_official_page_status (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references evidence_private.elections (id),
  official_url text not null check (official_url ~ '^https://'),
  page_status text not null check (page_status in ('official_map_identified', 'official_page_unavailable')),
  candidate_details_available text not null check (candidate_details_available in ('unknown')),
  first_retrieved_at timestamptz not null,
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  unique (election_id, official_url)
);
comment on table evidence_private.election_official_page_status is
  'Availability of an official election page as observed. Unknown means unknown: this table never holds a candidate count.';

create table evidence_private.boundary_map_links (
  document_id uuid primary key references evidence_private.documents (id),
  boundary_edition_id uuid not null references evidence_private.boundary_editions (id),
  election_id uuid references evidence_private.elections (id),
  boundary_type_at_source text,
  boundary_scope text,
  evidence_version_id uuid not null references evidence_private.source_record_versions (id)
);
comment on table evidence_private.boundary_map_links is
  'Links to official boundary map documents. A link is not an electorate list: no electorate is created from one.';

-- Access: same two layers as every other table ------------------------------------------------------------------------

do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'election_result_totals', 'electorate_result_summaries', 'result_route_checks', 'finance_published_aggregates',
    'election_official_page_status', 'boundary_map_links']
  loop
    execute format('alter table evidence_private.%I enable row level security', v_name);
    execute format('revoke all on evidence_private.%I from public, anon, authenticated', v_name);
    execute format('grant select on evidence_private.%I to evidence_inspector_reader', v_name);
    execute format('create policy %I on evidence_private.%I for select to evidence_inspector_reader using (true)', v_name || '_reader_select', v_name);
    execute format('grant select, insert, update on evidence_private.%I to evidence_ingest', v_name);
    execute format('create policy %I on evidence_private.%I for all to evidence_ingest using (true) with check (true)', v_name || '_ingest_all', v_name);
  end loop;

  -- Existing destinations the worker could not write yet. Policy names carry the family so another family's
  -- migration can add its own without a clash.
  foreach v_name in array array[
    'party_results', 'election_party_totals', 'policy_sources', 'polls', 'poll_results', 'finance_return_references']
  loop
    execute format('grant select, insert, update on evidence_private.%I to evidence_ingest', v_name);
    execute format('create policy %I on evidence_private.%I for all to evidence_ingest using (true) with check (true)', v_name || '_ingest_election_family', v_name);
  end loop;
  -- A poll's table is rebuilt from its current version, so rows of a superseded version are removed.
  grant delete on evidence_private.poll_results to evidence_ingest;
end
$$;

-- Helpers -----------------------------------------------------------------------------------------------------------------

create or replace function evidence_private.election_family_result_set(p_election uuid, p_source_id text, p_version uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- A result set belongs to ONE source, so its rows carry that source's lineage and release tier.
  select rs.id into v_id from evidence_private.result_sets rs
    join evidence_private.source_record_versions sv on sv.id = rs.source_version_id
    join evidence_private.source_records sr on sr.id = sv.record_id
   where rs.election_id = p_election and rs.result_status = 'final' and sr.source_id = p_source_id
   order by rs.id limit 1;
  if v_id is null then
    insert into evidence_private.result_sets (election_id, result_status, source_version_id)
    values (p_election, 'final', p_version) returning id into v_id;
  end if;
  return v_id;
end
$$;

create or replace function evidence_private.election_family_party_vote_check(p_election uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_total record;
  v_set record;
begin
  -- The published nationwide total, if one is loaded. With several, the first result set is used; each source's
  -- electorate figures are still summed on their own, never together.
  select t.party_votes, t.evidence_version_id into v_total
    from evidence_private.election_result_totals t
    join evidence_private.result_sets rs on rs.id = t.result_set_id
   where rs.election_id = p_election and t.value_status = 'reported'
   order by t.result_set_id limit 1;

  -- One check per result set that holds electorate party votes: a source's lines are summed within that source only.
  for v_set in
    select rs.id, rs.source_version_id, sum(pr.votes) as votes
      from evidence_private.party_results pr
      join evidence_private.result_sets rs on rs.id = pr.result_set_id
      join evidence_private.contests c on c.id = pr.contest_id
     where rs.election_id = p_election and c.contest_type = 'electorate' and pr.value_status = 'reported'
     group by rs.id, rs.source_version_id
  loop
    insert into evidence_private.result_route_checks (
      election_id, check_kind, source_record_id, evidence_version_id, other_version_id, this_route_votes, other_route_votes, outcome, counted_route, note)
    values (
      p_election, 'party_votes_sum_to_nationwide_total',
      (select sv.record_id from evidence_private.source_record_versions sv where sv.id = v_set.source_version_id), v_set.source_version_id, v_total.evidence_version_id, v_set.votes, v_total.party_votes,
      case when v_total.party_votes is null then 'other_route_not_loaded' when v_total.party_votes = v_set.votes then 'agrees' else 'disagrees' end,
      'nationwide table for the national figure; electorate pages for electorate figures',
      'Party votes by electorate and the nationwide party-vote total are the same votes. They are compared, never added together.')
    on conflict (check_kind, source_record_id) do update set
      evidence_version_id = excluded.evidence_version_id,
      other_version_id = excluded.other_version_id, this_route_votes = excluded.this_route_votes,
      other_route_votes = excluded.other_route_votes, outcome = excluded.outcome;
  end loop;
end
$$;

-- P08: nationwide table -------------------------------------------------------------------------------------------------

create or replace function evidence_private.project_election_nationwide(p_run_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_row record;
  v_election uuid;
  v_set uuid;
  v_party uuid;
  v_count integer := 0;
begin
  select id into v_election from evidence_private.elections where slug = 'general-2023';
  for v_row in
    select r.source_id, r.external_record_id, v.id as version_id, v.record_kind, v.safe_payload as p
    from evidence_private.source_observations o
    join evidence_private.source_record_versions v on v.id = o.version_id
    join evidence_private.source_records r on r.id = v.record_id
    where o.run_id = p_run_id and r.current_version_id = v.id
      and v.record_kind in ('election_nationwide_party_result', 'election_nationwide_total')
    order by r.external_record_id
  loop
    if (v_row.p ->> 'election_year') is distinct from '2023' then
      insert into evidence_private.ingest_errors (run_id, source_id, error_class, message, record_ref)
      values (p_run_id, v_row.source_id, 'projection_skipped', 'nationwide row is not for the 2023 election', v_row.external_record_id);
      continue;
    end if;
    v_set := evidence_private.election_family_result_set(v_election, v_row.source_id, v_row.version_id);

    if v_row.record_kind = 'election_nationwide_total' then
      insert into evidence_private.election_result_totals (
        result_set_id, party_votes, electorate_seats, list_seats, total_seats, value_status, evidence_version_id)
      values (
        v_set, (v_row.p ->> 'party_votes')::bigint, (v_row.p ->> 'electorate_seats')::integer,
        (v_row.p ->> 'list_seats')::integer, (v_row.p ->> 'total_seats')::integer,
        case when v_row.p ? 'party_votes' then 'reported' else 'not_reported' end, v_row.version_id)
      on conflict (result_set_id) do update set
        party_votes = excluded.party_votes, electorate_seats = excluded.electorate_seats, list_seats = excluded.list_seats,
        total_seats = excluded.total_seats, value_status = excluded.value_status, evidence_version_id = excluded.evidence_version_id;
    else
      v_party := evidence_private.ensure_party_identity(v_row.source_id, v_row.p ->> 'party_name');
      if v_party is null then
        insert into evidence_private.ingest_errors (run_id, source_id, error_class, message, record_ref)
        values (p_run_id, v_row.source_id, 'projection_skipped', 'party line without a party name', v_row.external_record_id);
        continue;
      end if;
      -- A seats cell the table leaves blank stays null here; it is not turned into zero.
      insert into evidence_private.election_party_totals (
        result_set_id, party_identity_id, party_votes, party_vote_share, electorate_seats, list_seats, denominator_note, value_status)
      values (
        v_set, v_party, (v_row.p ->> 'party_votes')::bigint, (v_row.p ->> 'vote_percent')::numeric,
        (v_row.p ->> 'electorate_seats')::integer, (v_row.p ->> 'list_seats')::integer,
        'Share exactly as the official table prints it (per cent of valid party votes).',
        case when v_row.p ? 'party_votes' then 'reported' else 'not_reported' end)
      on conflict (result_set_id, party_identity_id) do update set
        party_votes = excluded.party_votes, party_vote_share = excluded.party_vote_share,
        electorate_seats = excluded.electorate_seats, list_seats = excluded.list_seats, value_status = excluded.value_status;
    end if;
    v_count := v_count + 1;
  end loop;
  if v_count > 0 then
    perform evidence_private.election_family_party_vote_check(v_election);
  end if;
  return v_count;
end
$$;

-- P09: electorate pages -------------------------------------------------------------------------------------------------

create or replace function evidence_private.project_election_electorates(p_run_id uuid)
returns jsonb
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
  v_set uuid;
  v_party uuid;
  v_other record;
  v_party_lines integer := 0;
  v_summaries integer := 0;
  v_checks integer := 0;
begin
  select id into v_election from evidence_private.elections where slug = 'general-2023';
  for v_row in
    select r.id as record_id, r.source_id, r.external_record_id, v.id as version_id, v.record_kind, v.safe_payload as p
    from evidence_private.source_observations o
    join evidence_private.source_record_versions v on v.id = o.version_id
    join evidence_private.source_records r on r.id = v.record_id
    where o.run_id = p_run_id and r.current_version_id = v.id
      and v.record_kind in ('election_electorate_vote', 'election_electorate_summary')
    order by r.external_record_id
  loop
    if (v_row.p ->> 'election_year') is distinct from '2023' or coalesce(v_row.p ->> 'electorate_name', '') = '' then
      insert into evidence_private.ingest_errors (run_id, source_id, error_class, message, record_ref)
      values (p_run_id, v_row.source_id, 'projection_skipped', 'electorate row without the 2023 election or an electorate name', v_row.external_record_id);
      continue;
    end if;
    v_set := evidence_private.election_family_result_set(v_election, v_row.source_id, v_row.version_id);

    -- Same edition, slug and contest the 2023 candidacy product uses, so both routes meet on one contest.
    insert into evidence_private.boundary_editions (slug, title, verified, basis_note)
    values ('boundaries-used-2023', 'Electorate boundaries used at the 2023 General Election', false,
            'Names taken from the 2023 results export. Official identifiers, types and geometry not yet verified.')
    on conflict (slug) do update set slug = excluded.slug
    returning id into v_edition;
    insert into evidence_private.electorates (slug, canonical_name)
    values (regexp_replace(lower(v_row.p ->> 'electorate_name'), '[^a-z0-9āēīōū]+', '-', 'g'), v_row.p ->> 'electorate_name')
    on conflict (slug) do update set slug = excluded.slug
    returning id into v_electorate;
    -- official_code is the number in the official page address (electorate-details-NN), filled only where still empty.
    insert into evidence_private.electorate_versions (electorate_id, boundary_edition_id, name, electorate_type, official_code, evidence_version_id)
    values (v_electorate, v_edition, v_row.p ->> 'electorate_name', 'unverified', v_row.p ->> 'electorate_number', v_row.version_id)
    on conflict (electorate_id, boundary_edition_id) do update
      set official_code = coalesce(evidence_private.electorate_versions.official_code, excluded.official_code)
    returning id into v_ev;
    select id into v_contest from evidence_private.contests
     where election_id = v_election and contest_type = 'electorate' and electorate_version_id = v_ev;
    if v_contest is null then
      insert into evidence_private.contests (election_id, contest_type, electorate_version_id)
      values (v_election, 'electorate', v_ev) returning id into v_contest;
    end if;

    if v_row.record_kind = 'election_electorate_summary' then
      insert into evidence_private.electorate_result_summaries (
        result_set_id, contest_id, candidate_votes_with_informals, candidate_informals, candidate_lines,
        party_votes_with_informals, party_informals, party_lines, votes_counted, votes_counted_pct, evidence_version_id)
      values (
        v_set, v_contest, (v_row.p ->> 'candidate_total')::bigint, (v_row.p ->> 'candidate_informals')::bigint,
        (v_row.p ->> 'candidate_result_count')::integer, (v_row.p ->> 'party_total')::bigint,
        (v_row.p ->> 'party_informals')::bigint, (v_row.p ->> 'party_result_count')::integer,
        (v_row.p ->> 'votes_counted')::bigint, (v_row.p ->> 'votes_counted_pct')::numeric, v_row.version_id)
      on conflict (result_set_id, contest_id) do update set
        candidate_votes_with_informals = excluded.candidate_votes_with_informals, candidate_informals = excluded.candidate_informals,
        candidate_lines = excluded.candidate_lines, party_votes_with_informals = excluded.party_votes_with_informals,
        party_informals = excluded.party_informals, party_lines = excluded.party_lines, votes_counted = excluded.votes_counted,
        votes_counted_pct = excluded.votes_counted_pct, evidence_version_id = excluded.evidence_version_id;
      v_summaries := v_summaries + 1;

    elsif v_row.p ->> 'vote_type' = 'party' then
      v_party := evidence_private.ensure_party_identity(v_row.source_id, v_row.p ->> 'name_at_source');
      insert into evidence_private.party_results (result_set_id, contest_id, party_identity_id, votes, value_status)
      values (v_set, v_contest, v_party, (v_row.p ->> 'votes')::bigint,
              case when v_row.p ? 'votes' then 'reported' else 'not_reported' end)
      on conflict (result_set_id, contest_id, party_identity_id) do update
        set votes = excluded.votes, value_status = excluded.value_status;
      v_party_lines := v_party_lines + 1;

    elsif v_row.p ->> 'vote_type' = 'candidate' then
      -- The same fact as the candidacy product's candidate_results row. Found by that product's identifier only.
      select c.id as candidacy_id, cr.votes, i.first_version_id as version_id, i.source_id into v_other
        from evidence_private.person_source_identities i
        join evidence_private.candidacies c on c.person_identity_id = i.id and c.candidacy_type = 'electorate'
        left join evidence_private.candidate_results cr on cr.candidacy_id = c.id and cr.value_status = 'reported'
       -- The reference is the candidacy product's hex identifier with digits written as the letters g-p.
       where i.source_id = 'baseline_2023_candidacies_export'
         and i.external_id = translate(v_row.p ->> 'baseline_candidacy_ref', 'ghijklmnop', '0123456789')
       limit 1;
      insert into evidence_private.result_route_checks (
        election_id, check_kind, source_record_id, evidence_version_id, other_version_id, candidacy_id, this_route_votes, other_route_votes,
        outcome, counted_route, note)
      values (
        v_election, 'candidate_votes_same_fact', v_row.record_id, v_row.version_id, v_other.version_id, v_other.candidacy_id,
        (v_row.p ->> 'votes')::bigint, v_other.votes,
        case when v_other.votes is null then 'other_route_not_loaded'
             when v_other.votes = (v_row.p ->> 'votes')::bigint then 'agrees' else 'disagrees' end,
        'baseline_2023_candidacies_export',
        'A candidate line on an official electorate page. The candidacy product already counts this vote figure, so this line is a check on it and is never a second counted row.')
      on conflict (check_kind, source_record_id) do update set
        evidence_version_id = excluded.evidence_version_id, this_route_votes = excluded.this_route_votes,
        other_version_id = excluded.other_version_id, candidacy_id = excluded.candidacy_id,
        other_route_votes = excluded.other_route_votes, outcome = excluded.outcome;
      v_checks := v_checks + 1;
    end if;
  end loop;
  if v_party_lines > 0 then
    perform evidence_private.election_family_party_vote_check(v_election);
  end if;
  return jsonb_build_object('party_lines', v_party_lines, 'summaries', v_summaries, 'candidate_route_checks', v_checks);
end
$$;

-- P13, P14, P15, P17 and boundary links: documents with typed extensions -------------------------------------------------------

create or replace function evidence_private.project_election_documents(p_run_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_row record;
  v_doc uuid;
  v_ref uuid;
  v_party uuid;
  v_election uuid;
  v_edition uuid;
  v_item jsonb;
  v_metric text;
  v_counts jsonb := '{}'::jsonb;
begin
  for v_row in
    select r.id as record_id, r.source_id, r.external_record_id, v.id as version_id, v.record_kind, v.source_url,
           v.safe_payload as p, s.view_scope
    from evidence_private.source_observations o
    join evidence_private.source_record_versions v on v.id = o.version_id
    join evidence_private.source_records r on r.id = v.record_id
    join evidence_private.sources s on s.source_id = r.source_id
    where o.run_id = p_run_id and r.current_version_id = v.id
      and v.record_kind in ('party_policy_page', 'party_vote_poll', 'finance_candidate_return', 'finance_party_return',
                            'election_2026_boundary_map_link')
    order by r.external_record_id
  loop
    insert into evidence_private.documents (source_record_id, document_type, title, official_url, view_scope)
    values (
      v_row.record_id,
      case v_row.record_kind when 'party_policy_page' then 'policy_source' when 'party_vote_poll' then 'poll'
           when 'election_2026_boundary_map_link' then 'other' else 'finance_return' end,
      coalesce(v_row.p ->> 'document_title', v_row.p ->> 'boundary_scope'), v_row.source_url, v_row.view_scope)
    on conflict (source_record_id) do update set title = excluded.title, official_url = excluded.official_url
    returning id into v_doc;

    if v_row.record_kind = 'party_policy_page' then
      select id into v_election from evidence_private.elections where slug = 'general-2026';
      v_party := evidence_private.ensure_party_identity(v_row.source_id, v_row.p ->> 'party_name');
      -- The upstream label stays in the version payload, marked unreviewed. With no recorded model run and no
      -- review by a person there is no class to assign.
      insert into evidence_private.policy_sources (document_id, party_identity_id, election_id, policy_class, classification_basis)
      values (v_doc, v_party, v_election, 'unknown', 'none')
      on conflict (document_id) do update set party_identity_id = excluded.party_identity_id;

    elsif v_row.record_kind = 'party_vote_poll' then
      insert into evidence_private.polls (document_id, pollster, sponsor, fieldwork_start, fieldwork_end, sample_size, methodology_status)
      values (
        v_doc, v_row.p ->> 'pollster', coalesce(v_row.p ->> 'sponsor', v_row.p ->> 'disclosure_sponsor'),
        (v_row.p ->> 'fieldwork_start')::date, (v_row.p ->> 'fieldwork_end')::date,
        coalesce((v_row.p ->> 'sample_size')::integer, (v_row.p ->> 'disclosure_sample_size')::integer),
        case when v_row.p ->> 'methodology_status' = 'verified' then 'verified' else 'unresolved' end)
      on conflict (document_id) do update set
        pollster = excluded.pollster, sponsor = excluded.sponsor, fieldwork_start = excluded.fieldwork_start,
        fieldwork_end = excluded.fieldwork_end, sample_size = excluded.sample_size, methodology_status = excluded.methodology_status;
      -- The table mirrors the current version exactly, in source order. Labels stay as printed: an abbreviation
      -- is not resolved to a party here.
      -- Only labels the current version no longer prints are removed, so a reviewed party link on a label survives.
      delete from evidence_private.poll_results pr where pr.poll_document_id = v_doc
        and not exists (select 1 from jsonb_array_elements(v_row.p -> 'results') e where e ->> 'party_label' = pr.party_label_at_source);
      for v_item in select * from jsonb_array_elements(v_row.p -> 'results') loop
        insert into evidence_private.poll_results (poll_document_id, party_label_at_source, value_pct, value_status)
        values (v_doc, v_item ->> 'party_label',
                case when v_item ->> 'value_status' = 'reported' then (v_item ->> 'value_pct')::numeric end,
                case when v_item ->> 'value_status' = 'reported' and v_item ? 'value_pct' then 'reported' else 'not_reported' end)
        on conflict (poll_document_id, party_label_at_source) do update
          set value_pct = excluded.value_pct, value_status = excluded.value_status;
      end loop;

    elsif v_row.record_kind in ('finance_candidate_return', 'finance_party_return') then
      v_party := evidence_private.ensure_party_identity(v_row.source_id, v_row.p ->> 'party_name_as_published');
      select id into v_election from evidence_private.elections where slug = 'general-2023';
      insert into evidence_private.finance_return_references (
        document_id, return_type, reporting_year, election_id, party_identity_id, filing_status, filing_status_basis,
        is_image_only, total_status)
      values (
        v_doc, case when v_row.record_kind = 'finance_candidate_return' then 'candidate_return' else 'party_annual_return' end,
        (v_row.p ->> 'reporting_year')::integer,
        case when v_row.record_kind = 'finance_candidate_return' then v_election end, v_party, 'filed',
        'The Electoral Commission publishes this return document on its own index of filed returns. The filing date is not recorded here.',
        (v_row.p ->> 'is_image_only')::boolean, 'not_extracted')
      on conflict (document_id) do update set
        party_identity_id = excluded.party_identity_id, is_image_only = excluded.is_image_only
      returning id into v_ref;

      if v_row.record_kind = 'finance_candidate_return' then
        foreach v_metric in array array['expenses', 'donations', 'loans'] loop
          insert into evidence_private.finance_published_aggregates (
            source_record_id, evidence_version_id, finance_return_id, party_identity_id, reporting_year, metric, amount_nzd, value_status, basis)
          values (
            v_row.record_id, v_row.version_id, v_ref, v_party, (v_row.p ->> 'reporting_year')::integer, 'candidate_' || v_metric,
            case when v_row.p ->> (v_metric || '_as_published_status') in ('reported', 'reported_nil')
                 then (v_row.p ->> (v_metric || '_as_published_nzd'))::numeric end,
            case when v_row.p ->> (v_metric || '_as_published_status') in ('reported', 'reported_nil')
                      and v_row.p ? (v_metric || '_as_published_nzd')
                 then v_row.p ->> (v_metric || '_as_published_status') else 'not_reported' end,
            'commission_index_page_as_published')
          on conflict (source_record_id, metric) do update set
            evidence_version_id = excluded.evidence_version_id, amount_nzd = excluded.amount_nzd, value_status = excluded.value_status;
        end loop;
      end if;

    else
      insert into evidence_private.boundary_editions (slug, title, verified, basis_note)
      values ('boundary-review-' || (v_row.p ->> 'boundary_edition'),
              'Boundary review ' || (v_row.p ->> 'boundary_edition') || ' (official summary maps)', false,
              'Known only from links to the official summary map documents. No electorate list, identifiers or geometry loaded.')
      on conflict (slug) do update set slug = excluded.slug
      returning id into v_edition;
      select id into v_election from evidence_private.elections where slug = 'general-2026';
      insert into evidence_private.boundary_map_links (document_id, boundary_edition_id, election_id, boundary_type_at_source, boundary_scope, evidence_version_id)
      values (v_doc, v_edition, v_election, v_row.p ->> 'boundary_type_at_source', v_row.p ->> 'boundary_scope', v_row.version_id)
      on conflict (document_id) do update set
        boundary_type_at_source = excluded.boundary_type_at_source, boundary_scope = excluded.boundary_scope,
        evidence_version_id = excluded.evidence_version_id;
    end if;
    v_counts := jsonb_set(v_counts, array[v_row.record_kind], to_jsonb(coalesce((v_counts ->> v_row.record_kind)::integer, 0) + 1));
  end loop;
  return v_counts;
end
$$;

-- P16 and the 2026 page status: not documents ------------------------------------------------------------------------------

create or replace function evidence_private.project_election_facts(p_run_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_row record;
  v_party uuid;
  v_election uuid;
  v_item jsonb;
  v_aggregates integer := 0;
  v_status integer := 0;
begin
  for v_row in
    select r.id as record_id, r.source_id, r.external_record_id, v.id as version_id, v.record_kind, v.source_url,
           v.first_retrieved_at, v.safe_payload as p
    from evidence_private.source_observations o
    join evidence_private.source_record_versions v on v.id = o.version_id
    join evidence_private.source_records r on r.id = v.record_id
    where o.run_id = p_run_id and r.current_version_id = v.id
      and v.record_kind in ('finance_party_aggregate', 'election_2026_official_page_status')
    order by r.external_record_id
  loop
    if v_row.record_kind = 'finance_party_aggregate' then
      v_party := evidence_private.ensure_party_identity(v_row.source_id, v_row.p ->> 'party_name_as_published');
      for v_item in select * from jsonb_array_elements(v_row.p -> 'aggregates') loop
        if v_item ->> 'metric' not in ('party_donations_sum', 'party_loans_sum') then
          insert into evidence_private.ingest_errors (run_id, source_id, error_class, message, record_ref)
          values (p_run_id, v_row.source_id, 'projection_skipped', 'aggregate metric outside the documented vocabulary', v_row.external_record_id);
          continue;
        end if;
        insert into evidence_private.finance_published_aggregates (
          source_record_id, evidence_version_id, party_identity_id, reporting_year, metric, amount_nzd, value_status, basis)
        values (
          v_row.record_id, v_row.version_id, v_party, (v_row.p ->> 'reporting_year')::integer, v_item ->> 'metric',
          case when v_item ->> 'value_status' in ('reported', 'reported_nil') then (v_item ->> 'amount_nzd')::numeric end,
          case when v_item ->> 'value_status' in ('reported', 'reported_nil') and v_item ? 'amount_nzd'
               then v_item ->> 'value_status' else 'not_reported' end,
          'commission_published_summary_not_recomputed')
        on conflict (source_record_id, metric) do update set
          evidence_version_id = excluded.evidence_version_id, amount_nzd = excluded.amount_nzd, value_status = excluded.value_status;
        v_aggregates := v_aggregates + 1;
      end loop;
    else
      select id into v_election from evidence_private.elections where slug = 'general-2026';
      insert into evidence_private.election_official_page_status (
        election_id, official_url, page_status, candidate_details_available, first_retrieved_at, evidence_version_id)
      values (v_election, v_row.source_url, v_row.p ->> 'official_page_status', 'unknown', v_row.first_retrieved_at, v_row.version_id)
      on conflict (election_id, official_url) do update set
        page_status = excluded.page_status, first_retrieved_at = excluded.first_retrieved_at, evidence_version_id = excluded.evidence_version_id;
      v_status := v_status + 1;
    end if;
  end loop;
  return jsonb_build_object('published_aggregates', v_aggregates, 'official_page_status', v_status);
end
$$;

-- Entry point. project_run reaches it through the projector registry (20260921000100_import_shared.sql), which calls
-- project_election_family_run below after asserting the lease itself. The two-argument form stays for a direct call.
create or replace function evidence_private.project_election_family(p_run_id uuid, p_holder uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  perform evidence_private.assert_run_held(p_run_id, p_holder);
  return jsonb_build_object(
    'nationwide', evidence_private.project_election_nationwide(p_run_id),
    'electorates', evidence_private.project_election_electorates(p_run_id),
    'documents', evidence_private.project_election_documents(p_run_id),
    'facts', evidence_private.project_election_facts(p_run_id));
end
$$;

-- Registered form: project_run has already asserted that the caller holds the run.
create or replace function evidence_private.project_election_family_run(p_run_id uuid)
returns jsonb
language sql
set search_path = ''
as $$
  select jsonb_build_object(
    'nationwide', evidence_private.project_election_nationwide(p_run_id),
    'electorates', evidence_private.project_election_electorates(p_run_id),
    'documents', evidence_private.project_election_documents(p_run_id),
    'facts', evidence_private.project_election_facts(p_run_id));
$$;

insert into evidence_private.run_projectors (projector_key, function_name)
values ('election_family', 'project_election_family_run')
on conflict (projector_key) do nothing;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'project_election_family_run(uuid)', 'election_family_result_set(uuid, text, uuid)', 'election_family_party_vote_check(uuid)',
    'project_election_nationwide(uuid)', 'project_election_electorates(uuid)', 'project_election_documents(uuid)',
    'project_election_facts(uuid)', 'project_election_family(uuid, uuid)']
  loop
    execute format('revoke execute on function evidence_private.%s from public', v_fn);
    execute format('grant execute on function evidence_private.%s to evidence_ingest', v_fn);
  end loop;
end
$$;

-- Public projection registers: default deny, lineage by foreign key only -----------------------------------------------------

insert into evidence_private.public_lineage (object_schema, object_name, lineage_kind, lineage_sql, note) values
  ('evidence_private', 'election_result_totals', 'source', '(select l.source_id from evidence_private.lineage_result_set l where l.result_set_id = b.result_set_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'electorate_result_summaries', 'source', '(select l.source_id from evidence_private.lineage_result_set l where l.result_set_id = b.result_set_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'result_route_checks', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'finance_published_aggregates', 'source', '(select l.source_id from evidence_private.lineage_record l where l.record_id = b.source_record_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'election_official_page_status', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'boundary_map_links', 'source', '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.document_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.');

-- A route check holds the OTHER route's vote figure too. That column is withheld outright, so one source's rights can
-- never publish another source's number. this_route_votes is a content column of its own source and needs that
-- source's approved fields; an outcome of "agrees" beside it does imply the other figure, which is the same
-- published fact.
insert into evidence_private.public_withheld (object_schema, object_name, column_name, reason) values
  ('evidence_private', 'result_route_checks', 'other_route_votes', 'This figure belongs to a second source with its own rights row. The outcome of the comparison is published; the other source publishes its own figure.'),
  ('evidence_private', 'result_route_checks', 'note', 'Project-authored explanation repeated on every row; documented once in the family README instead.');

select evidence_private.classify_public_columns();
select evidence_private.rebuild_exposed_views();
