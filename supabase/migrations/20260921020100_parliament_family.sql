-- Parliament family (catalogue products P01, P02, P03, P05, P06, P07, P10, P24).
--
-- Typed destinations for the family's allowlisted records, one set-based projection, a per-source reconciliation
-- readout, and route de-duplication: the same publisher item can arrive by more than one route (a fresh fetch and
-- a reviewed export of an earlier collection), and a count across routes must count the item once.
--
-- Nothing here stores question, reply, report, bill or release text, a file name, a contact detail or a stored-copy
-- location. Publisher dates and the project's retrieval times stay in separate columns; a date the source does not
-- state stays null and is never filled from a retrieval time.
--
-- Additive only: no existing row is rewritten and no existing column changes meaning.

-- Ledger guard: the correction to the phone-number test that this family measured on its real exports (1,380 of 187,956
-- written questions refused for carrying a publisher id or a digest) lives in 20260921000100_import_shared.sql, the one
-- copy all three families share. Nothing in this file replaces evidence_private.text_violation.

-- Document types --------------------------------------------------------------------------------------------------

alter table evidence_private.documents drop constraint documents_document_type_check;
alter table evidence_private.documents add constraint documents_document_type_check check (document_type in (
  'bill', 'written_question', 'committee_report', 'release', 'policy_source',
  'poll', 'finance_return', 'other', 'committee_business'));

-- Written questions (P24) --------------------------------------------------------------------------------------------

alter table evidence_private.written_questions
  add column question_year integer check (question_year between 1990 and 2100),
  add column parliament_number integer,
  add column document_ref text,
  add column released_on date,
  add column source_last_modified_at timestamptz,
  add column asker_member_ref text,
  add column asker_name_at_source text,
  add column minister_name_at_source text,
  add column ministerial_title_at_source text,
  add column portfolio_ref text,
  add column status_ref integer,
  add column reply_present boolean,
  add column attachment_present boolean;

comment on column evidence_private.written_questions.released_on is
  'The publisher''s release date of the question. It is not a lodgement date, so lodged_on stays null for these rows.';
comment on column evidence_private.written_questions.source_last_modified_at is
  'The publisher''s modification time. It is not an answer date: the source states none, so answered_on stays null.';
comment on column evidence_private.written_questions.reply_present is
  'Whether the publisher record carried a reply when it was retrieved. Null when the route did not say.';
comment on column evidence_private.written_questions.minister_name_at_source is
  'The responsible minister as the question record names them. Not evidence of who drafted a reply, nor of an appointment interval.';

create index written_questions_released on evidence_private.written_questions (released_on);
create index written_questions_number on evidence_private.written_questions (question_year, question_number);

-- Committee reports (P07), their files (P06) and committee business (P05) ---------------------------------------------

alter table evidence_private.committee_reports
  add column subtitle text,
  add column report_type text,
  add column parliament_number integer,
  add column source_last_modified_at timestamptz,
  add column attachment_ref text;

create table evidence_private.committee_report_files (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null unique references evidence_private.source_records (id),
  attachment_ref text not null,
  parent_report_ref text,
  -- Set only when a report with that publisher id has been imported. Never matched on a title.
  report_document_id uuid references evidence_private.committee_reports (document_id),
  official_download_url text not null check (official_download_url ~ '^https://'),
  media_type text,
  file_sha256 text check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes bigint check (file_bytes > 0),
  text_extraction_status text,
  published_at timestamptz
);

comment on table evidence_private.committee_report_files is
  'What a committee report attachment IS (official link, size, digest), never what it says. A file is not a second report: it is not a documents row, so reports are not counted twice.';

create index committee_report_files_report on evidence_private.committee_report_files (report_document_id);
create index committee_report_files_parent on evidence_private.committee_report_files (parent_report_ref);

create table evidence_private.committee_business_items (
  document_id uuid primary key references evidence_private.documents (id),
  committee text,
  business_type text,
  item_type text,
  parliament_number integer,
  published_at timestamptz,
  source_last_modified_at timestamptz
);

-- Bills: register fields, stages, publications (P02, P03) -------------------------------------------------------------

alter table evidence_private.bills
  add column status_label text,
  add column introduced_at timestamptz,
  add column source_last_updated_at timestamptz,
  add column legislation_url text check (legislation_url ~ '^https://');

create table evidence_private.bill_stages (
  bill_document_id uuid not null references evidence_private.bills (document_id),
  stage_order integer not null check (stage_order >= 1),
  stage_name text,
  stage_code text,
  stage_at timestamptz,
  outcome_label text,
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  primary key (bill_document_id, stage_order)
);

comment on table evidence_private.bill_stages is
  'Stages in the publisher''s order with the publisher''s dates. A null outcome_label means the publisher recorded none.';

create table evidence_private.bill_publication_sets (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null unique references evidence_private.source_records (id),
  bill_ref text not null,
  bill_number text,
  title text,
  legislation_url text check (legislation_url ~ '^https://'),
  -- Null means the publisher's index was not read: unknown, not zero.
  publication_revision_count integer check (publication_revision_count >= 0),
  index_status text not null check (index_status in ('read', 'unavailable'))
);

create table evidence_private.bill_publications (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null unique references evidence_private.source_records (id),
  bill_ref text,
  bill_number text,
  bill_title text,
  revision_ref text not null,
  version_date date,
  official_pdf_url text not null check (official_pdf_url ~ '^https://'),
  file_sha256 text check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes bigint check (file_bytes > 0)
);

comment on table evidence_private.bill_publications is
  'One published revision of a bill: official link, publisher date, size and digest. Proposed bill text is not enacted law and is not stored.';

create index bill_publications_bill on evidence_private.bill_publications (bill_ref);

-- Releases (P01): who the publisher names on an item -------------------------------------------------------------------

create table evidence_private.release_attributions (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null unique references evidence_private.source_records (id),
  official_url text not null check (official_url ~ '^https://'),
  content_kind text,
  minister_names_at_source text[] not null default '{}',
  portfolio_names_at_source text[] not null default '{}'
);

comment on table evidence_private.release_attributions is
  'Ministers and portfolios the publisher names on an item. Attribution by the publisher; never shown as endorsement or authorship beyond that.';

create index release_attributions_url on evidence_private.release_attributions (official_url);

-- Route de-duplication ----------------------------------------------------------------------------------------------------

create table evidence_private.record_route_keys (
  record_id uuid primary key references evidence_private.source_records (id),
  item_family text not null check (item_family in ('bill', 'release', 'written_question', 'committee_report', 'committee_business_item')),
  route_key text not null
);

comment on table evidence_private.record_route_keys is
  'The publisher''s own identity of an item (its id, or its official link for releases), so an item that arrived by two routes is counted once. Routes are never merged or overwritten: each keeps its own records and history.';

create index record_route_keys_key on evidence_private.record_route_keys (item_family, route_key);

-- Projector registry (created in 20260921000100_import_shared.sql): this family registers its projection ------------------

insert into evidence_private.run_projectors (projector_key, function_name)
values ('parliament_family', 'project_parliament_family')
on conflict (projector_key) do nothing;

-- Projection --------------------------------------------------------------------------------------------------------------

-- Current versions a run observed, for the family's kinds only. A function rather than a temporary table: the worker
-- may sit behind a transaction-mode pooler and holds no TEMP privilege.
create or replace function evidence_private.parliament_family_run_rows(p_run_id uuid)
returns table (record_id uuid, source_id text, external_record_id text, version_id uuid, record_kind text,
               p jsonb, source_published_at timestamptz, observed_at timestamptz, view_scope text)
language sql
stable
set search_path = ''
as $$
  select r.id, r.source_id, r.external_record_id, v.id, v.record_kind, v.safe_payload, v.source_published_at, o.observed_at, s.view_scope
  from evidence_private.source_observations o
  join evidence_private.source_record_versions v on v.id = o.version_id
  join evidence_private.source_records r on r.id = v.record_id
  join evidence_private.sources s on s.source_id = r.source_id
  where o.run_id = p_run_id and r.current_version_id = v.id
    and v.record_kind in ('written_question', 'committee_report', 'committee_report_file', 'committee_business_item',
                          'bill_register_entry', 'bill_publication', 'bill_publication_set', 'release_attribution',
                          'member_service_term', 'minister_role', 'bill', 'release');
$$;

create or replace function evidence_private.project_parliament_family(p_run_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_questions integer := 0;
  v_reports integer := 0;
  v_files integer := 0;
  v_business integer := 0;
  v_register integer := 0;
  v_stages integer := 0;
  v_sets integer := 0;
  v_publications integer := 0;
  v_attributions integer := 0;
  v_terms integer := 0;
  v_roles integer := 0;
  v_keys integer := 0;
begin
  -- Documents for the kinds that are documents.
  insert into evidence_private.documents (source_record_id, document_type, title, official_url, view_scope)
  select f.record_id,
         case f.record_kind when 'written_question' then 'written_question' when 'committee_report' then 'committee_report'
                            when 'committee_business_item' then 'committee_business' else 'bill' end,
         f.p ->> 'title', f.p ->> 'public_page_url', f.view_scope
  from evidence_private.parliament_family_run_rows(p_run_id) f
  where f.record_kind in ('written_question', 'committee_report', 'committee_business_item', 'bill_register_entry')
  on conflict (source_record_id) do update set title = excluded.title, official_url = excluded.official_url;

  insert into evidence_private.written_questions as w (
    document_id, question_number, answer_status, question_year, parliament_number, document_ref, released_on,
    source_last_modified_at, asker_member_ref, asker_name_at_source, minister_name_at_source, ministerial_title_at_source,
    portfolio_ref, status_ref, reply_present, attachment_present)
  select d.id, f.p ->> 'question_number',
         case when (f.p ->> 'reply_present')::boolean is true then 'answered'
              when (f.p ->> 'reply_present')::boolean is false then 'unanswered' else 'unknown' end,
         (f.p ->> 'question_year')::integer, (f.p ->> 'parliament_number')::integer, f.p ->> 'document_ref',
         (f.p ->> 'question_released_on')::date, (f.p ->> 'source_last_modified_at')::timestamptz, f.p ->> 'asker_member_ref',
         f.p ->> 'asker_name_at_source', f.p ->> 'minister_name', f.p ->> 'ministerial_title', f.p ->> 'portfolio_ref',
         (f.p ->> 'status_ref')::integer, (f.p ->> 'reply_present')::boolean, (f.p ->> 'attachment_present')::boolean
  from evidence_private.parliament_family_run_rows(p_run_id) f join evidence_private.documents d on d.source_record_id = f.record_id
  where f.record_kind = 'written_question'
  on conflict (document_id) do update set
    question_number = excluded.question_number, answer_status = excluded.answer_status, question_year = excluded.question_year,
    parliament_number = excluded.parliament_number, document_ref = excluded.document_ref, released_on = excluded.released_on,
    source_last_modified_at = excluded.source_last_modified_at, asker_member_ref = excluded.asker_member_ref,
    asker_name_at_source = excluded.asker_name_at_source, minister_name_at_source = excluded.minister_name_at_source,
    ministerial_title_at_source = excluded.ministerial_title_at_source, portfolio_ref = excluded.portfolio_ref,
    status_ref = excluded.status_ref, reply_present = excluded.reply_present, attachment_present = excluded.attachment_present;
  get diagnostics v_questions = row_count;

  insert into evidence_private.committee_reports as c (
    document_id, committee, reported_on, subtitle, report_type, parliament_number, source_last_modified_at, attachment_ref)
  select d.id, f.p ->> 'select_committee', ((f.p ->> 'publication_date')::timestamptz at time zone 'UTC')::date, f.p ->> 'subtitle',
         f.p ->> 'report_type', (f.p ->> 'parliament_number')::integer, (f.p ->> 'source_last_modified_at')::timestamptz, f.p ->> 'attachment_ref'
  from evidence_private.parliament_family_run_rows(p_run_id) f join evidence_private.documents d on d.source_record_id = f.record_id
  where f.record_kind = 'committee_report'
  on conflict (document_id) do update set
    committee = excluded.committee, reported_on = excluded.reported_on, subtitle = excluded.subtitle, report_type = excluded.report_type,
    parliament_number = excluded.parliament_number, source_last_modified_at = excluded.source_last_modified_at,
    attachment_ref = excluded.attachment_ref;
  get diagnostics v_reports = row_count;

  insert into evidence_private.committee_business_items as b (
    document_id, committee, business_type, item_type, parliament_number, published_at, source_last_modified_at)
  select d.id, f.p ->> 'select_committee', f.p ->> 'document_type', f.p ->> 'item_type', (f.p ->> 'parliament_number')::integer,
         (f.p ->> 'publication_date')::timestamptz, (f.p ->> 'source_last_modified_at')::timestamptz
  from evidence_private.parliament_family_run_rows(p_run_id) f join evidence_private.documents d on d.source_record_id = f.record_id
  where f.record_kind = 'committee_business_item'
  on conflict (document_id) do update set
    committee = excluded.committee, business_type = excluded.business_type, item_type = excluded.item_type,
    parliament_number = excluded.parliament_number, published_at = excluded.published_at,
    source_last_modified_at = excluded.source_last_modified_at;
  get diagnostics v_business = row_count;

  -- A file attaches to its report only through the publisher's own report id.
  insert into evidence_private.committee_report_files as cf (
    source_record_id, attachment_ref, parent_report_ref, report_document_id, official_download_url, media_type, file_sha256,
    file_bytes, text_extraction_status, published_at)
  select f.record_id, f.p ->> 'attachment_ref', f.p ->> 'parent_report_ref',
         (select cr.document_id from evidence_private.committee_reports cr
            join evidence_private.documents d on d.id = cr.document_id
            join evidence_private.source_records r on r.id = d.source_record_id
           where r.external_record_id = f.p ->> 'parent_report_ref' and r.record_kind = 'committee_report'
           order by r.first_seen_at, r.id limit 1),
         f.p ->> 'official_download_url', f.p ->> 'media_type', f.p ->> 'file_sha256', (f.p ->> 'file_bytes')::bigint,
         f.p ->> 'text_extraction_status', (f.p ->> 'publication_date')::timestamptz
  from evidence_private.parliament_family_run_rows(p_run_id) f where f.record_kind = 'committee_report_file'
  on conflict (source_record_id) do update set
    attachment_ref = excluded.attachment_ref, parent_report_ref = excluded.parent_report_ref,
    report_document_id = coalesce(excluded.report_document_id, cf.report_document_id),
    official_download_url = excluded.official_download_url, media_type = excluded.media_type, file_sha256 = excluded.file_sha256,
    file_bytes = excluded.file_bytes, text_extraction_status = excluded.text_extraction_status, published_at = excluded.published_at;
  get diagnostics v_files = row_count;

  -- Reports imported after their files pick the files up here.
  update evidence_private.committee_report_files cf
     set report_document_id = d.id
    from evidence_private.parliament_family_run_rows(p_run_id) f join evidence_private.documents d on d.source_record_id = f.record_id
   where f.record_kind = 'committee_report' and cf.report_document_id is null and cf.parent_report_ref = f.external_record_id;

  -- Bill register: a bills row with the register's extra fields, and the dated stages.
  insert into evidence_private.bills as b (
    document_id, bill_number, bill_type, parliament_number, current_stage, select_committee, member_name_at_source,
    status_label, introduced_at, source_last_updated_at, legislation_url)
  select d.id, f.p ->> 'bill_number', f.p ->> 'bill_type', (f.p ->> 'parliament_number')::integer, f.p ->> 'current_stage',
         f.p ->> 'select_committee', f.p -> 'member_names_at_source' ->> 0, f.p ->> 'status_label',
         (f.p ->> 'introduced_at')::timestamptz, (f.p ->> 'source_last_updated_at')::timestamptz, f.p ->> 'legislation_url'
  from evidence_private.parliament_family_run_rows(p_run_id) f join evidence_private.documents d on d.source_record_id = f.record_id
  where f.record_kind = 'bill_register_entry'
  on conflict (document_id) do update set
    bill_number = excluded.bill_number, bill_type = excluded.bill_type, parliament_number = excluded.parliament_number,
    current_stage = excluded.current_stage, select_committee = excluded.select_committee,
    member_name_at_source = excluded.member_name_at_source, status_label = excluded.status_label,
    introduced_at = excluded.introduced_at, source_last_updated_at = excluded.source_last_updated_at,
    legislation_url = excluded.legislation_url;
  get diagnostics v_register = row_count;

  insert into evidence_private.bill_stages as bs (bill_document_id, stage_order, stage_name, stage_code, stage_at, outcome_label, evidence_version_id)
  select d.id, st.ordinality::integer, st.stage ->> 'stage_name', st.stage ->> 'stage_code', (st.stage ->> 'stage_date')::timestamptz,
         st.stage ->> 'outcome_label', f.version_id
  from evidence_private.parliament_family_run_rows(p_run_id) f
  join evidence_private.documents d on d.source_record_id = f.record_id
  cross join lateral jsonb_array_elements(coalesce(f.p -> 'stages', '[]'::jsonb)) with ordinality as st (stage, ordinality)
  where f.record_kind = 'bill_register_entry'
  on conflict (bill_document_id, stage_order) do update set
    stage_name = excluded.stage_name, stage_code = excluded.stage_code, stage_at = excluded.stage_at,
    outcome_label = excluded.outcome_label, evidence_version_id = excluded.evidence_version_id;
  get diagnostics v_stages = row_count;

  insert into evidence_private.bill_publication_sets as ps (
    source_record_id, bill_ref, bill_number, title, legislation_url, publication_revision_count, index_status)
  select f.record_id, f.p ->> 'bill_ref', f.p ->> 'bill_number', f.p ->> 'title', f.p ->> 'legislation_url',
         (f.p ->> 'publication_revision_count')::integer,
         case when f.p ->> 'publication_index_status' = 'unavailable' or f.p ->> 'publication_revision_count' is null then 'unavailable' else 'read' end
  from evidence_private.parliament_family_run_rows(p_run_id) f where f.record_kind = 'bill_publication_set'
  on conflict (source_record_id) do update set
    bill_ref = excluded.bill_ref, bill_number = excluded.bill_number, title = excluded.title, legislation_url = excluded.legislation_url,
    publication_revision_count = excluded.publication_revision_count, index_status = excluded.index_status;
  get diagnostics v_sets = row_count;

  insert into evidence_private.bill_publications as bp (
    source_record_id, bill_ref, bill_number, bill_title, revision_ref, version_date, official_pdf_url, file_sha256, file_bytes)
  select f.record_id, f.p ->> 'bill_ref', f.p ->> 'bill_number', f.p ->> 'bill_title', f.p ->> 'revision_ref', (f.p ->> 'version_date')::date,
         f.p ->> 'official_pdf_url', f.p ->> 'file_sha256', (f.p ->> 'file_bytes')::bigint
  from evidence_private.parliament_family_run_rows(p_run_id) f where f.record_kind = 'bill_publication'
  on conflict (source_record_id) do update set
    bill_ref = excluded.bill_ref, bill_number = excluded.bill_number, bill_title = excluded.bill_title, revision_ref = excluded.revision_ref,
    version_date = excluded.version_date, official_pdf_url = excluded.official_pdf_url, file_sha256 = excluded.file_sha256,
    file_bytes = excluded.file_bytes;
  get diagnostics v_publications = row_count;

  insert into evidence_private.release_attributions as ra (
    source_record_id, official_url, content_kind, minister_names_at_source, portfolio_names_at_source)
  select f.record_id, f.p ->> 'public_page_url', f.p ->> 'content_kind',
         coalesce(array(select jsonb_array_elements_text(f.p -> 'minister_names_at_source')), '{}'),
         coalesce(array(select jsonb_array_elements_text(f.p -> 'portfolio_names_at_source')), '{}')
  from evidence_private.parliament_family_run_rows(p_run_id) f where f.record_kind = 'release_attribution'
  on conflict (source_record_id) do update set
    official_url = excluded.official_url, content_kind = excluded.content_kind,
    minister_names_at_source = excluded.minister_names_at_source, portfolio_names_at_source = excluded.portfolio_names_at_source;
  get diagnostics v_attributions = row_count;

  -- Members and ministers: one source identity per upstream member reference. No identity is linked to a person here.
  -- One member is usually mentioned by several records (a term and a ministerial role), and the version cited as the
  -- first sighting is chosen by the PUBLISHER's own ordering: the earliest date the publisher states, then the
  -- publisher's own record id. It was previously chosen by version_id, a random uuid, which made the stored
  -- first_version_id differ between two loads of the very same export; comparing the content of two stores loaded in
  -- opposite family order is what exposed it.
  insert into evidence_private.person_source_identities (source_id, external_id, identity_scheme, name_at_source, first_version_id)
  select distinct on (f.source_id, f.p ->> 'person_ref')
         f.source_id, f.p ->> 'person_ref', 'upstream_member_ref', f.p ->> 'person_name_at_source', f.version_id
  from evidence_private.parliament_family_run_rows(p_run_id) f
  where f.record_kind in ('member_service_term', 'minister_role') and f.p ->> 'person_ref' is not null and f.p ->> 'person_name_at_source' is not null
  order by f.source_id, f.p ->> 'person_ref', coalesce(f.source_published_at, 'infinity'::timestamptz), f.external_record_id
  on conflict (source_id, external_id) do update set name_at_source = excluded.name_at_source;

  -- A term row carries a date only when the official file states one; otherwise it is a sighting with unknown dates.
  insert into evidence_private.parliamentary_service_terms (
    person_identity_id, representation, electorate_name_at_source, party_identity_id, valid_from, valid_to, date_precision,
    basis, observed_first_at, observed_last_at, evidence_version_id)
  select i.id, f.p ->> 'representation', f.p ->> 'electorate_label',
         evidence_private.ensure_party_identity(f.source_id, f.p ->> 'party_label'),
         (f.p ->> 'valid_from')::date, (f.p ->> 'valid_to')::date,
         case when f.p ->> 'valid_from' is not null or f.p ->> 'valid_to' is not null then 'day' else 'unknown' end,
         case when f.p ->> 'valid_from' is not null or f.p ->> 'valid_to' is not null then 'official_event' else 'observed_in_directory' end,
         f.observed_at, f.observed_at, f.version_id
  from evidence_private.parliament_family_run_rows(p_run_id) f
  join evidence_private.person_source_identities i on i.source_id = f.source_id and i.external_id = f.p ->> 'person_ref'
  where f.record_kind = 'member_service_term' and f.p ->> 'representation' in ('electorate', 'list')
    and (f.p ->> 'representation' = 'list' or f.p ->> 'electorate_label' is not null)
    and not exists (select 1 from evidence_private.parliamentary_service_terms t where t.evidence_version_id = f.version_id);
  get diagnostics v_terms = row_count;

  -- A minister's page names the role; it states no appointment date, so none is stored.
  insert into evidence_private.role_terms (
    person_identity_id, role_type, role_title, valid_from, valid_to, date_precision, observed_first_at, observed_last_at, evidence_version_id)
  select i.id, 'ministerial_portfolio', concat_ws(': ', f.p ->> 'role_name', f.p ->> 'portfolio_name'),
         (f.p ->> 'valid_from')::date, (f.p ->> 'valid_to')::date,
         case when f.p ->> 'valid_from' is not null or f.p ->> 'valid_to' is not null then 'day' else 'unknown' end,
         f.observed_at, f.observed_at, f.version_id
  from evidence_private.parliament_family_run_rows(p_run_id) f
  join evidence_private.person_source_identities i on i.source_id = f.source_id and i.external_id = f.p ->> 'person_ref'
  where f.record_kind = 'minister_role' and coalesce(f.p ->> 'role_name', f.p ->> 'portfolio_name') is not null
    and not exists (select 1 from evidence_private.role_terms t where t.evidence_version_id = f.version_id);
  get diagnostics v_roles = row_count;

  -- Route keys: the publisher's identity of the item, whichever route brought it.
  insert into evidence_private.record_route_keys (record_id, item_family, route_key)
  select f.record_id,
         case f.record_kind when 'bill_register_entry' then 'bill' else f.record_kind end,
         case f.record_kind when 'release' then f.p ->> 'public_page_url' else lower(f.external_record_id) end
  from evidence_private.parliament_family_run_rows(p_run_id) f
  where f.record_kind in ('bill', 'bill_register_entry', 'release', 'written_question', 'committee_report', 'committee_business_item')
    and (f.record_kind <> 'release' or f.p ->> 'public_page_url' is not null)
  on conflict (record_id) do update set route_key = excluded.route_key;
  get diagnostics v_keys = row_count;

  return jsonb_build_object(
    'written_questions', v_questions, 'committee_reports', v_reports, 'committee_report_files', v_files,
    'committee_business_items', v_business, 'bill_register_entries', v_register, 'bill_stages', v_stages,
    'bill_publication_sets', v_sets, 'bill_publications', v_publications, 'release_attributions', v_attributions,
    'member_service_terms', v_terms, 'minister_roles', v_roles, 'route_keys', v_keys);
end
$$;

-- Reconciliation readout ---------------------------------------------------------------------------------------------------
-- Counts only. What the destination holds for one source, so an import receipt can be checked against the export manifest.

create or replace function evidence_private.source_reconciliation(p_source_id text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'source_id', p_source_id,
    'records', (select count(*) from evidence_private.source_records r where r.source_id = p_source_id),
    'records_tombstoned', (select count(*) from evidence_private.source_records r where r.source_id = p_source_id and r.tombstoned_at is not null),
    'records_by_kind', (select coalesce(jsonb_object_agg(k.record_kind, k.n), '{}'::jsonb)
                          from (select r.record_kind, count(*) as n from evidence_private.source_records r
                                 where r.source_id = p_source_id group by r.record_kind) k),
    'versions', (select count(*) from evidence_private.source_record_versions v
                  join evidence_private.source_records r on r.id = v.record_id where r.source_id = p_source_id),
    'observations', (select count(*) from evidence_private.source_observations o
                      join evidence_private.source_record_versions v on v.id = o.version_id
                      join evidence_private.source_records r on r.id = v.record_id where r.source_id = p_source_id),
    'records_without_current_version', (select count(*) from evidence_private.source_records r
                                         where r.source_id = p_source_id and r.current_version_id is null),
    'versions_with_publisher_date', (select count(*) from evidence_private.source_record_versions v
                                      join evidence_private.source_records r on r.id = v.record_id
                                     where r.source_id = p_source_id and v.source_published_at is not null),
    'rejected_records', (select count(*) from evidence_private.ingest_errors e
                          where e.source_id = p_source_id and e.error_class = 'record_rejected'),
    'documents', (select count(*) from evidence_private.documents d
                   join evidence_private.source_records r on r.id = d.source_record_id where r.source_id = p_source_id),
    'route_keys', (select count(*) from evidence_private.record_route_keys k
                    join evidence_private.source_records r on r.id = k.record_id where r.source_id = p_source_id),
    'runs_succeeded', (select count(*) from evidence_private.import_runs i where i.source_id = p_source_id and i.status = 'succeeded'));
$$;

-- Route-aware coverage: items per route, and items counted once across routes ----------------------------------------------

create view evidence_views.route_coverage as
select k.item_family,
       count(*) as records_across_routes,
       count(distinct k.route_key) as distinct_items,
       count(distinct r.source_id) as routes,
       count(*) - count(distinct k.route_key) as records_shared_between_routes
from evidence_private.record_route_keys k
join evidence_private.source_records r on r.id = k.record_id
where r.tombstoned_at is null
group by k.item_family;

comment on view evidence_views.route_coverage is
  'distinct_items is the number to quote. records_across_routes adds the routes together and therefore counts an item once per route that saw it.';

create view evidence_views.route_coverage_by_source as
select k.item_family, r.source_id, count(*) as records,
       count(*) filter (where exists (
         select 1 from evidence_private.record_route_keys k2
         join evidence_private.source_records r2 on r2.id = k2.record_id
         where k2.item_family = k.item_family and k2.route_key = k.route_key and r2.source_id <> r.source_id)) as also_seen_by_another_route
from evidence_private.record_route_keys k
join evidence_private.source_records r on r.id = k.record_id
where r.tombstoned_at is null
group by k.item_family, r.source_id;

-- Grants and row level security -----------------------------------------------------------------------------------------------

do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'committee_report_files', 'committee_business_items', 'bill_stages', 'bill_publication_sets', 'bill_publications',
    'release_attributions', 'record_route_keys']
  loop
    execute format('alter table evidence_private.%I enable row level security', v_name);
    execute format('revoke all on evidence_private.%I from public, anon, authenticated', v_name);
  end loop;

  -- The worker writes the family's projection tables, and two existing ones it could not write before.
  foreach v_name in array array[
    'committee_report_files', 'committee_business_items', 'bill_stages', 'bill_publication_sets', 'bill_publications',
    'release_attributions', 'record_route_keys', 'written_questions', 'committee_reports', 'role_terms']
  loop
    execute format('grant select, insert, update on evidence_private.%I to evidence_ingest', v_name);
    execute format('create policy %I on evidence_private.%I for all to evidence_ingest using (true) with check (true)',
                   v_name || '_ingest_all', v_name);
  end loop;

  foreach v_name in array array[
    'committee_report_files', 'committee_business_items', 'bill_stages', 'bill_publication_sets', 'bill_publications',
    'release_attributions', 'record_route_keys', 'written_questions', 'committee_reports', 'role_terms']
  loop
    execute format('grant select on evidence_private.%I to evidence_inspector_reader', v_name);
    if not exists (select 1 from pg_policies where schemaname = 'evidence_private' and tablename = v_name and policyname = v_name || '_reader_select') then
      execute format('create policy %I on evidence_private.%I for select to evidence_inspector_reader using (true)', v_name || '_reader_select', v_name);
    end if;
  end loop;
end
$$;

-- Views are owned by the inspector reader, never by the table owner, so they read through row level security.
grant usage, create on schema evidence_views to evidence_inspector_reader;
alter view evidence_views.route_coverage owner to evidence_inspector_reader;
alter view evidence_views.route_coverage_by_source owner to evidence_inspector_reader;
revoke all on evidence_views.route_coverage, evidence_views.route_coverage_by_source from public, anon, authenticated;
revoke create on schema evidence_views from evidence_inspector_reader;

revoke execute on function evidence_private.project_parliament_family(uuid) from public;
revoke execute on function evidence_private.parliament_family_run_rows(uuid) from public;
grant execute on function evidence_private.parliament_family_run_rows(uuid) to evidence_ingest;
revoke execute on function evidence_private.source_reconciliation(text) from public;
grant execute on function evidence_private.project_parliament_family(uuid) to evidence_ingest;
grant execute on function evidence_private.source_reconciliation(text) to evidence_ingest;

-- Public projection registers: default deny stays; each new object states its lineage ----------------------------------------

insert into evidence_private.public_lineage (object_schema, object_name, lineage_kind, lineage_sql, note) values
  ('evidence_private', 'committee_report_files', 'source', '(select l.source_id from evidence_private.lineage_record l where l.record_id = b.source_record_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'committee_business_items', 'source', '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.document_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'bill_stages', 'source', '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.bill_document_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'bill_publication_sets', 'source', '(select l.source_id from evidence_private.lineage_record l where l.record_id = b.source_record_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'bill_publications', 'source', '(select l.source_id from evidence_private.lineage_record l where l.record_id = b.source_record_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'release_attributions', 'source', '(select l.source_id from evidence_private.lineage_record l where l.record_id = b.source_record_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'record_route_keys', 'source', '(select l.source_id from evidence_private.lineage_record l where l.record_id = b.record_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.')
on conflict do nothing;

-- The coverage views aggregate across sources, so no single source can vouch for a row: withheld, with the reason recorded.
insert into evidence_private.public_withheld (object_schema, object_name, column_name, reason) values
  ('evidence_views', 'route_coverage', '*', 'Aggregates across several sources, so a row has no single source whose rights could release it. Inspector only.'),
  ('evidence_views', 'route_coverage_by_source', '*', 'Counts derived from cross-source comparison of publisher identifiers. Inspector only.')
on conflict do nothing;

select evidence_private.classify_public_columns();
select evidence_private.rebuild_exposed_views();
