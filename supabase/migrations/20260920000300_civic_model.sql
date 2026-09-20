-- Civic backbone. Facts attach to source-scoped identities. A canonical person or
-- party is linked only through a recorded, reviewed identity decision.
-- A shared name is a nomination for review and never an approval.

-- Canonical people and parties ----------------------------------------------

create table evidence_private.people (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  public_role_basis text not null
    check (public_role_basis in ('member_of_parliament', 'candidate', 'office_holder', 'party_official')),
  created_at timestamptz not null default now()
);

comment on table evidence_private.people is
  'Only people acting in a public capacity (R7). No name-derived key; two people may share a display name.';

create table evidence_private.parties (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  short_name text,
  created_at timestamptz not null default now()
);

create table evidence_private.person_source_identities (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references evidence_private.sources (source_id),
  external_id text not null,
  identity_scheme text not null,
  name_at_source text not null,
  person_id uuid references evidence_private.people (id),
  link_status text not null default 'unresolved'
    check (link_status in ('unresolved', 'proposed', 'approved', 'rejected')),
  first_version_id uuid references evidence_private.source_record_versions (id),
  created_at timestamptz not null default now(),
  unique (source_id, external_id),
  check ((link_status = 'approved') = (person_id is not null))
);

comment on column evidence_private.person_source_identities.external_id is
  'Opaque, source-scoped identifier such as a profile slug. Never an email address.';

create table evidence_private.party_source_identities (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references evidence_private.sources (source_id),
  external_id text not null,
  name_at_source text not null,
  party_id uuid references evidence_private.parties (id),
  link_status text not null default 'unresolved'
    check (link_status in ('unresolved', 'proposed', 'approved', 'rejected')),
  is_independent_label boolean not null default false,
  created_at timestamptz not null default now(),
  unique (source_id, external_id),
  check ((link_status = 'approved') = (party_id is not null)),
  -- "Independent" is a label on a candidacy, never a registered party.
  check (not (is_independent_label and party_id is not null))
);

create table evidence_private.party_aliases (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references evidence_private.parties (id),
  alias text not null,
  valid_from date,
  valid_to date,
  evidence_version_id uuid references evidence_private.source_record_versions (id),
  unique (party_id, alias)
);

create table evidence_private.party_registrations (
  id uuid primary key default gen_random_uuid(),
  party_identity_id uuid not null references evidence_private.party_source_identities (id),
  status text not null check (status in ('registered', 'deregistered', 'unknown')),
  valid_from date,
  valid_to date,
  date_precision text not null check (date_precision in ('day', 'month', 'year', 'unknown')),
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

-- Identity decisions -----------------------------------------------------------

create table evidence_private.identity_decisions (
  id uuid primary key default gen_random_uuid(),
  subject_kind text not null check (subject_kind in ('person', 'party')),
  person_identity_id uuid references evidence_private.person_source_identities (id),
  party_identity_id uuid references evidence_private.party_source_identities (id),
  target_person_id uuid references evidence_private.people (id),
  target_party_id uuid references evidence_private.parties (id),
  decision text not null check (decision in ('proposed', 'approved', 'rejected', 'superseded')),
  method text not null check (method in (
    'name_similarity_nomination', 'shared_official_identifier', 'manual_source_review')),
  evidence jsonb not null default '{}'::jsonb,
  decided_by text,
  decided_at timestamptz not null default now(),
  supersedes_id uuid references evidence_private.identity_decisions (id),
  check ((subject_kind = 'person') = (person_identity_id is not null and party_identity_id is null)),
  check ((subject_kind = 'party') = (party_identity_id is not null and person_identity_id is null)),
  -- A name match can nominate; it can never approve.
  check (not (decision = 'approved' and method = 'name_similarity_nomination')),
  -- Approval and rejection need a named human reviewer.
  check (decision = 'proposed' or decided_by is not null)
);

create trigger identity_decisions_append_only
  before update or delete on evidence_private.identity_decisions
  for each row execute function evidence_private.reject_mutation();

create or replace function evidence_private.require_identity_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.link_status = 'approved' then
    if tg_table_name = 'person_source_identities' then
      if not exists (
        select 1 from evidence_private.identity_decisions d
        where d.person_identity_id = new.id
          and d.target_person_id = new.person_id
          and d.decision = 'approved'
          and not exists (
            select 1 from evidence_private.identity_decisions s where s.supersedes_id = d.id)
      ) then
        raise exception 'identity link needs a current approved identity decision'
          using errcode = 'P0001';
      end if;
    else
      if not exists (
        select 1 from evidence_private.identity_decisions d
        where d.party_identity_id = new.id
          and d.target_party_id = new.party_id
          and d.decision = 'approved'
          and not exists (
            select 1 from evidence_private.identity_decisions s where s.supersedes_id = d.id)
      ) then
        raise exception 'identity link needs a current approved identity decision'
          using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end
$$;

create trigger person_identity_needs_decision
  before insert or update on evidence_private.person_source_identities
  for each row execute function evidence_private.require_identity_decision();

create trigger party_identity_needs_decision
  before insert or update on evidence_private.party_source_identities
  for each row execute function evidence_private.require_identity_decision();

-- Temporal affiliations --------------------------------------------------------

create table evidence_private.party_affiliations (
  id uuid primary key default gen_random_uuid(),
  person_identity_id uuid not null references evidence_private.person_source_identities (id),
  party_identity_id uuid not null references evidence_private.party_source_identities (id),
  valid_from date,
  valid_to date,
  date_precision text not null check (date_precision in ('day', 'month', 'year', 'unknown')),
  basis text not null check (basis in ('observed_at_source', 'established_event')),
  observed_first_at timestamptz not null,
  observed_last_at timestamptz not null,
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  -- An observation alone does not establish when membership began.
  check (basis = 'established_event' or (valid_from is null and date_precision = 'unknown')),
  check (observed_last_at >= observed_first_at),
  unique (person_identity_id, party_identity_id, observed_first_at)
);

-- Elections, boundaries, contests ----------------------------------------------

create table evidence_private.elections (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  election_type text not null check (election_type in ('general', 'by_election')),
  election_date date,
  election_date_basis text not null,
  status text not null check (status in ('scheduled', 'held')),
  view_scope text not null check (view_scope in ('primary_2026', 'baseline_2023', 'general')),
  official_source_version_id uuid references evidence_private.source_record_versions (id)
);

comment on column evidence_private.elections.election_date is 'Null when no official date is recorded. Never inferred.';

insert into evidence_private.elections (slug, title, election_type, election_date, election_date_basis, status, view_scope)
values
  ('general-2023', '2023 General Election', 'general', date '2023-10-14',
   'Electoral Commission 2023 General Election official results', 'held', 'baseline_2023'),
  ('general-2026', '2026 General Election', 'general', date '2026-11-07',
   'Project RED-LINES.md v1.0 records election day as Saturday 7 November 2026; confirm against the official writ source when reachable',
   'scheduled', 'primary_2026');

create table evidence_private.boundary_editions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  effective_from date,
  verified boolean not null default false,
  basis_note text not null
);

create table evidence_private.electorates (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  canonical_name text not null
);

create table evidence_private.electorate_versions (
  id uuid primary key default gen_random_uuid(),
  electorate_id uuid not null references evidence_private.electorates (id),
  boundary_edition_id uuid not null references evidence_private.boundary_editions (id),
  name text not null,
  electorate_type text not null check (electorate_type in ('general', 'maori', 'unverified')),
  official_code text,
  evidence_version_id uuid references evidence_private.source_record_versions (id),
  unique (electorate_id, boundary_edition_id)
);

comment on column evidence_private.electorate_versions.electorate_type is
  'general or maori only once verified against an official source; otherwise unverified.';

create table evidence_private.contests (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references evidence_private.elections (id),
  contest_type text not null check (contest_type in ('electorate', 'party_list')),
  electorate_version_id uuid references evidence_private.electorate_versions (id),
  check ((contest_type = 'electorate') = (electorate_version_id is not null))
);

create unique index contests_one_per_electorate on evidence_private.contests (election_id, electorate_version_id)
  where contest_type = 'electorate';
create unique index contests_one_list_per_election on evidence_private.contests (election_id)
  where contest_type = 'party_list';

-- Candidacies -------------------------------------------------------------------

create table evidence_private.candidacies (
  id uuid primary key default gen_random_uuid(),
  person_identity_id uuid not null references evidence_private.person_source_identities (id),
  election_id uuid not null references evidence_private.elections (id),
  contest_id uuid not null references evidence_private.contests (id),
  candidacy_type text not null check (candidacy_type in ('electorate', 'list')),
  party_identity_id uuid references evidence_private.party_source_identities (id),
  stood_as_independent boolean not null default false,
  current_status text not null
    check (current_status in ('announced', 'officially_nominated', 'withdrawn', 'elected', 'not_elected', 'unknown')),
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  unique (person_identity_id, contest_id, candidacy_type)
);

comment on table evidence_private.candidacies is
  'Electorate and list candidacies are separate rows; one person may hold both. Sitting as an MP creates no candidacy.';

create table evidence_private.candidacy_status_events (
  id uuid primary key default gen_random_uuid(),
  candidacy_id uuid not null references evidence_private.candidacies (id),
  status text not null
    check (status in ('announced', 'officially_nominated', 'withdrawn', 'elected', 'not_elected')),
  status_date date,
  date_precision text not null check (date_precision in ('day', 'month', 'year', 'unknown')),
  source_class text not null
    check (source_class in ('official_electoral_commission', 'party_announcement', 'media_report')),
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  recorded_at timestamptz not null default now(),
  -- Only the Electoral Commission establishes nomination or election.
  check (status not in ('officially_nominated', 'elected', 'not_elected')
         or source_class = 'official_electoral_commission')
);

create trigger candidacy_status_events_append_only
  before update or delete on evidence_private.candidacy_status_events
  for each row execute function evidence_private.reject_mutation();

create or replace function evidence_private.guard_candidacy_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.current_status in ('officially_nominated', 'elected', 'not_elected')
     and not exists (
       select 1 from evidence_private.candidacy_status_events e
       where e.candidacy_id = new.id
         and e.status = new.current_status
         and e.source_class = 'official_electoral_commission')
  then
    raise exception 'status % needs an official Electoral Commission status event first', new.current_status
      using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger candidacies_status_guard
  before update of current_status on evidence_private.candidacies
  for each row execute function evidence_private.guard_candidacy_status();

create or replace function evidence_private.guard_candidacy_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.current_status not in ('announced', 'unknown') then
    raise exception 'a candidacy starts as announced or unknown; official status arrives through status events'
      using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger candidacies_insert_guard
  before insert on evidence_private.candidacies
  for each row execute function evidence_private.guard_candidacy_insert();

create table evidence_private.party_lists (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references evidence_private.elections (id),
  party_identity_id uuid not null references evidence_private.party_source_identities (id),
  list_version integer not null default 1 check (list_version >= 1),
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  unique (election_id, party_identity_id, list_version)
);

create table evidence_private.party_list_entries (
  list_id uuid not null references evidence_private.party_lists (id),
  list_rank integer not null check (list_rank >= 1),
  person_identity_id uuid not null references evidence_private.person_source_identities (id),
  candidacy_id uuid references evidence_private.candidacies (id),
  primary key (list_id, list_rank),
  unique (list_id, person_identity_id)
);

-- Results -------------------------------------------------------------------------

create table evidence_private.result_sets (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references evidence_private.elections (id),
  result_status text not null check (result_status in ('preliminary', 'final', 'recount', 'corrected')),
  source_version_id uuid not null references evidence_private.source_record_versions (id),
  declared_on date,
  supersedes_id uuid references evidence_private.result_sets (id)
);

create table evidence_private.candidate_results (
  result_set_id uuid not null references evidence_private.result_sets (id),
  candidacy_id uuid not null references evidence_private.candidacies (id),
  votes bigint check (votes >= 0),
  vote_share numeric(9, 6),
  value_status text not null check (value_status in ('reported', 'not_reported', 'suppressed')),
  primary key (result_set_id, candidacy_id),
  -- Unknown is not zero: a number exists only when the source reported one.
  check ((value_status = 'reported') = (votes is not null))
);

create table evidence_private.party_results (
  result_set_id uuid not null references evidence_private.result_sets (id),
  contest_id uuid not null references evidence_private.contests (id),
  party_identity_id uuid not null references evidence_private.party_source_identities (id),
  votes bigint check (votes >= 0),
  value_status text not null check (value_status in ('reported', 'not_reported', 'suppressed')),
  primary key (result_set_id, contest_id, party_identity_id),
  check ((value_status = 'reported') = (votes is not null))
);

create table evidence_private.election_party_totals (
  result_set_id uuid not null references evidence_private.result_sets (id),
  party_identity_id uuid not null references evidence_private.party_source_identities (id),
  party_votes bigint check (party_votes >= 0),
  party_vote_share numeric(9, 6),
  electorate_seats integer check (electorate_seats >= 0),
  list_seats integer check (list_seats >= 0),
  denominator_note text,
  value_status text not null check (value_status in ('reported', 'not_reported', 'suppressed')),
  primary key (result_set_id, party_identity_id),
  check ((value_status = 'reported') = (party_votes is not null))
);

create table evidence_private.staged_unmatched_results (
  id uuid primary key default gen_random_uuid(),
  result_set_id uuid not null references evidence_private.result_sets (id),
  label_at_source text not null,
  safe_payload jsonb not null,
  reason text not null,
  staged_at timestamptz not null default now()
);

comment on table evidence_private.staged_unmatched_results is
  'Result labels without a verified candidacy stay here. They are never fuzzy-joined.';

-- Parliament ------------------------------------------------------------------------

create table evidence_private.parliamentary_service_terms (
  id uuid primary key default gen_random_uuid(),
  person_identity_id uuid not null references evidence_private.person_source_identities (id),
  parliament_number integer,
  representation text not null check (representation in ('electorate', 'list')),
  electorate_name_at_source text,
  electorate_version_id uuid references evidence_private.electorate_versions (id),
  party_identity_id uuid references evidence_private.party_source_identities (id),
  valid_from date,
  valid_to date,
  date_precision text not null check (date_precision in ('day', 'month', 'year', 'unknown')),
  basis text not null check (basis in ('observed_in_directory', 'official_event')),
  observed_first_at timestamptz not null,
  observed_last_at timestamptz not null,
  observed_absent_at timestamptz,
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  -- A list member has no electorate.
  check (representation = 'electorate'
         or (electorate_name_at_source is null and electorate_version_id is null)),
  check (representation = 'list' or electorate_name_at_source is not null),
  -- A directory sighting gives observation dates only, never service dates.
  check (basis = 'official_event' or (valid_from is null and valid_to is null and date_precision = 'unknown'))
);

create index service_terms_identity on evidence_private.parliamentary_service_terms (person_identity_id);

comment on column evidence_private.parliamentary_service_terms.observed_absent_at is
  'First complete directory snapshot that no longer listed the member. Not a service end date.';

create table evidence_private.role_terms (
  id uuid primary key default gen_random_uuid(),
  person_identity_id uuid not null references evidence_private.person_source_identities (id),
  role_type text not null check (role_type in ('ministerial_portfolio', 'party_office', 'parliamentary_office')),
  role_title text not null,
  valid_from date,
  valid_to date,
  date_precision text not null check (date_precision in ('day', 'month', 'year', 'unknown')),
  observed_first_at timestamptz not null,
  observed_last_at timestamptz not null,
  evidence_version_id uuid not null references evidence_private.source_record_versions (id)
);
