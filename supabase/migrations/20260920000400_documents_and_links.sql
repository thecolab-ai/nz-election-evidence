-- Document references and typed extensions. Official URLs and approved fields
-- only: no document bodies, no stored PDFs, no donor identities, no contact data.

create table evidence_private.documents (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null unique references evidence_private.source_records (id),
  document_type text not null check (document_type in (
    'bill', 'written_question', 'committee_report', 'release', 'policy_source',
    'poll', 'finance_return', 'other')),
  title text,
  official_url text not null check (official_url ~ '^https://'),
  view_scope text not null check (view_scope in (
    'primary_2026', 'baseline_2023', 'finance_2025', 'current_parliament', 'statistics', 'general'))
);

comment on table evidence_private.documents is
  'Stable document identity. Revisions live in source_record_versions. official_url is always the publisher URL, never a storage or archive location.';

create table evidence_private.bills (
  document_id uuid primary key references evidence_private.documents (id),
  bill_number text,
  bill_type text,
  parliament_number integer,
  current_stage text,
  select_committee text,
  last_activity_at timestamptz,
  member_name_at_source text,
  member_identity_id uuid references evidence_private.person_source_identities (id),
  party_label_at_source text
);

create table evidence_private.written_questions (
  document_id uuid primary key references evidence_private.documents (id),
  question_number text,
  portfolio text,
  lodged_on date,
  answered_on date,
  answer_status text not null check (answer_status in ('answered', 'unanswered', 'unknown')),
  asked_by_identity_id uuid references evidence_private.person_source_identities (id),
  answered_by_identity_id uuid references evidence_private.person_source_identities (id)
);

create table evidence_private.committee_reports (
  document_id uuid primary key references evidence_private.documents (id),
  committee text,
  reported_on date
);

create table evidence_private.releases (
  document_id uuid primary key references evidence_private.documents (id),
  published_at timestamptz,
  publisher_item_id text
);

create table evidence_private.policy_sources (
  document_id uuid primary key references evidence_private.documents (id),
  party_identity_id uuid references evidence_private.party_source_identities (id),
  election_id uuid references evidence_private.elections (id),
  policy_class text not null check (policy_class in ('manifesto', 'collection', 'platform', 'hub', 'unknown')),
  classification_basis text not null
    check (classification_basis in ('unreviewed_model', 'human_reviewed', 'publisher_label', 'none'))
);

create table evidence_private.polls (
  document_id uuid primary key references evidence_private.documents (id),
  pollster text not null,
  sponsor text,
  fieldwork_start date,
  fieldwork_end date,
  sample_size integer check (sample_size > 0),
  methodology_status text not null check (methodology_status in ('verified', 'unresolved'))
);

create table evidence_private.poll_results (
  poll_document_id uuid not null references evidence_private.polls (document_id),
  party_label_at_source text not null,
  party_identity_id uuid references evidence_private.party_source_identities (id),
  value_pct numeric(7, 3) check (value_pct between 0 and 100),
  value_status text not null check (value_status in ('reported', 'not_reported')),
  primary key (poll_document_id, party_label_at_source),
  check ((value_status = 'reported') = (value_pct is not null))
);

comment on table evidence_private.poll_results is
  'Stored in source order. No project ranking, score or scoreboard is derived from these rows (R1).';

create table evidence_private.finance_return_references (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null unique references evidence_private.documents (id),
  return_type text not null check (return_type in (
    'candidate_return', 'party_annual_return', 'party_election_return',
    'party_donation_disclosure', 'party_loan_disclosure')),
  reporting_year integer check (reporting_year between 1990 and 2100),
  election_id uuid references evidence_private.elections (id),
  party_identity_id uuid references evidence_private.party_source_identities (id),
  candidacy_id uuid references evidence_private.candidacies (id),
  filing_status text not null
    check (filing_status in ('filed', 'filed_late', 'nil_return', 'not_filed', 'unknown')),
  filing_status_basis text not null,
  is_image_only boolean,
  approved_total numeric(18, 2),
  total_status text not null check (total_status in ('reported', 'not_extracted', 'unknown')),
  check ((total_status = 'reported') = (approved_total is not null))
);

comment on table evidence_private.finance_return_references is
  'Return status and the official URL. Deliberately has no donor, address or contact columns. is_image_only null means not yet checked.';

-- Relationship provenance: real foreign keys, explicit relationship types.

create table evidence_private.version_person_links (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references evidence_private.source_record_versions (id),
  person_identity_id uuid not null references evidence_private.person_source_identities (id),
  relationship_type text not null
    check (relationship_type in ('author', 'sponsor', 'asker', 'answerer', 'subject', 'mention')),
  evidence_locator text,
  method text not null check (method in ('source_structured_field', 'manual_review')),
  review_status text not null default 'unreviewed' check (review_status in ('unreviewed', 'confirmed', 'rejected')),
  unique (version_id, person_identity_id, relationship_type)
);

comment on column evidence_private.version_person_links.relationship_type is
  'A mention is not an endorsement and is never shown as one.';

create table evidence_private.version_party_links (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references evidence_private.source_record_versions (id),
  party_identity_id uuid not null references evidence_private.party_source_identities (id),
  relationship_type text not null check (relationship_type in ('author', 'sponsor', 'subject', 'mention')),
  evidence_locator text,
  method text not null check (method in ('source_structured_field', 'manual_review')),
  review_status text not null default 'unreviewed' check (review_status in ('unreviewed', 'confirmed', 'rejected')),
  unique (version_id, party_identity_id, relationship_type)
);

create table evidence_private.version_electorate_links (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references evidence_private.source_record_versions (id),
  electorate_version_id uuid not null references evidence_private.electorate_versions (id),
  relationship_type text not null check (relationship_type in ('subject', 'mention')),
  method text not null check (method in ('source_structured_field', 'manual_review')),
  review_status text not null default 'unreviewed' check (review_status in ('unreviewed', 'confirmed', 'rejected')),
  unique (version_id, electorate_version_id, relationship_type)
);

create table evidence_private.version_bill_links (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references evidence_private.source_record_versions (id),
  bill_document_id uuid not null references evidence_private.bills (document_id),
  relationship_type text not null check (relationship_type in ('subject', 'mention', 'report_on')),
  method text not null check (method in ('source_structured_field', 'manual_review')),
  review_status text not null default 'unreviewed' check (review_status in ('unreviewed', 'confirmed', 'rejected')),
  unique (version_id, bill_document_id, relationship_type)
);
