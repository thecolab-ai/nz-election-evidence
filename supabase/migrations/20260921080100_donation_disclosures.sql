-- Officially disclosed donations: what a party or candidate declared INSIDE a filed Electoral Commission return.
--
-- WHAT THIS ADDS, AND WHY IT IS NEW. Until now the store held the Commission's INDEX of filed returns (P15, P17)
-- and the totals the Commission prints on its own pages (P16, and the index-page totals of P15). It held no
-- donation. Migration 20260921070100 said so in as many words: "THERE IS NO DONOR-LEVEL RECORD IN THIS STORE TO
-- PUBLISH". This migration is the record. Two new products, P25 (2023 candidate returns) and P26 (2025 party
-- annual returns), carry what each return discloses part by part, and - for the parts where the form's own
-- arithmetic proves the reading is complete - each itemised donation, loan or contribution inside it.
--
-- THE DONOR NAME, AND THE THING THAT IS NEVER TAKEN WITH IT. The form's Part A table has ONE cell headed with the
-- donor's name and their street address together. The name is a disclosure Parliament requires to be public; the
-- other half is a private individual's home. The loader separates them and keeps only the name, and this migration
-- does not take that on trust: `donation_disclosures.donor_name_as_published` carries a CHECK that refuses any
-- value holding a digit or a street word, so a value of the wrong kind cannot be stored even by a worker that
-- meant to. That is the third independent guard on the same fact, after the reader and the import contract.
--
-- WHAT THE PUBLISHER WITHHOLDS STAYS WITHHELD. Parts C and F of the form are the law's own categories for an
-- anonymous donation and a donation protected from disclosure. Their entries are stored with no name and with
-- `donor_name_status = 'withheld_by_publisher'`. Nothing here tries to work out who they were.
--
-- NOTHING IS ADDED TO ANYTHING. A part total read from a return is the same money the Commission prints on its own
-- index page: the two are RECONCILED by the loader and never summed. Part A of an annual return for a
-- general-election year also carries that year's separately published donations-over-$20,000 notices, so every row
-- carries `overlaps_election_year_notices`; the notices themselves are not collected at all (that page answers this
-- host with a challenge) and no view adds one publication to the other.
--
-- OWNER AUTHORIZATION. Releasing a donor's name is not a rights review and is not compliance. It is an owner
-- decision, recorded as OWNER-AUTH-2026-09-21-03 in governance/owner-authorizations.json and mirrored here as a new
-- scope kind, `published_donation_facts`, on exactly the two new registry products. Every rights row stays pending,
-- every gate stays as it was, and `release_basis` still reports `owner_override`. The legal reviews this decision
-- does not stand in for are listed in the entry's `not_claimed`.

-- 1. The typed destinations ------------------------------------------------------------------------------------

create table evidence_private.donation_return_parts (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null references evidence_private.source_records (id),
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  party_identity_id uuid references evidence_private.party_source_identities (id),
  return_kind text not null check (return_kind in ('party_annual_return', 'candidate_election_return')),
  reporting_year integer not null check (reporting_year between 1990 and 2100),
  -- True where an annual return for a general-election year also carries that year's separately published
  -- donations-over-$20,000 notices. A reader adding the two publications would count the same money twice.
  overlaps_election_year_notices boolean not null,
  party_name_as_published text,
  candidate_name_as_published text,
  electorate_as_published text,
  document_version_type text,
  amendment_labelled boolean not null default false,
  -- The publisher's own link to the return this row was read from. Named `official_url` because that is
  -- what every other table in this store calls a publisher link, and what the column classifier reads as LINK
  -- metadata: a reader is never shown a figure without the document it came from, at any tier.
  official_url text not null check (official_url ~ '^https://'),
  catalogue_page_url text check (catalogue_page_url is null or catalogue_page_url ~ '^https://'),
  disclosure_part text not null check (disclosure_part in ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I')),
  part_label_as_published text not null,
  disclosure_kind text not null check (disclosure_kind in ('donation', 'loan', 'expense')),
  donor_identity_kind text not null check (donor_identity_kind in (
    'named', 'anonymous', 'protected_from_disclosure', 'overseas', 'not_itemised')),
  disclosed_total_nzd numeric(18, 2) check (disclosed_total_nzd >= 0),
  disclosed_total_status text not null check (disclosed_total_status in ('reported', 'reported_nil', 'not_reported')),
  entries_disclosed integer not null check (entries_disclosed >= 0),
  itemisation_status text not null check (itemisation_status in (
    'reconciled', 'not_itemised', 'no_entries', 'no_table', 'not_reconciled')),
  itemisation_note text not null check (itemisation_note in (
    'entries_sum_equals_printed_total', 'no_printed_total_for_part', 'an_entry_has_no_readable_amount',
    'an_entry_has_more_than_one_amount', 'entry_numbers_are_not_consecutive', 'entries_do_not_sum_to_printed_total',
    'part_is_a_count_and_total_only', 'part_table_not_present', 'part_total_is_nil')),
  amounts_basis text not null check (amounts_basis = 'return_document_as_filed'),
  disclosure_reader_version text not null,
  unique (source_record_id),
  check ((disclosed_total_status = 'not_reported') = (disclosed_total_nzd is null)),
  check (disclosed_total_status <> 'reported_nil' or disclosed_total_nzd = 0),
  -- A candidate return names a candidate and an electorate; a party return names a party.
  check (return_kind <> 'candidate_election_return' or (candidate_name_as_published is not null and electorate_as_published is not null)),
  check (return_kind <> 'party_annual_return' or party_name_as_published is not null)
);
comment on table evidence_private.donation_return_parts is
  'One part of one filed return: the total the return prints for that part, how many entries it lists, and whether those entries could be read completely. A part that did not reconcile keeps its printed total and has no entry row anywhere.';
comment on column evidence_private.donation_return_parts.itemisation_status is
  'reconciled = the entries of this part are stored and sum exactly to the total printed on the form. Anything else means no entry of this part is stored; itemisation_note says which rule stopped it.';

create table evidence_private.donation_disclosures (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null references evidence_private.source_records (id),
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  return_part_id uuid references evidence_private.donation_return_parts (id),
  party_identity_id uuid references evidence_private.party_source_identities (id),
  return_kind text not null check (return_kind in ('party_annual_return', 'candidate_election_return')),
  reporting_year integer not null check (reporting_year between 1990 and 2100),
  overlaps_election_year_notices boolean not null,
  party_name_as_published text,
  candidate_name_as_published text,
  electorate_as_published text,
  amendment_labelled boolean not null default false,
  -- The publisher's own link to the return this row was read from. Named `official_url` because that is
  -- what every other table in this store calls a publisher link, and what the column classifier reads as LINK
  -- metadata: a reader is never shown a figure without the document it came from, at any tier.
  official_url text not null check (official_url ~ '^https://'),
  disclosure_part text not null check (disclosure_part in ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I')),
  part_label_as_published text not null,
  disclosure_kind text not null check (disclosure_kind in ('donation', 'loan', 'expense')),
  entry_index integer not null check (entry_index >= 1),
  -- THE NAME, AND ONLY THE NAME. Refused outright: anything with a digit in it (a street number, a postcode, a
  -- unit number) and anything holding a word that belongs to a postal address. The loader already separates the
  -- two halves of the form's cell and proves the result; this is the store refusing to hold the other half even
  -- if it were offered.
  donor_name_as_published text check (
    donor_name_as_published is null
    or (length(donor_name_as_published) between 2 and 200
        and donor_name_as_published !~ '[0-9]'
        and donor_name_as_published !~* '\y(road|rd|street|avenue|ave|drive|lane|place|terrace|crescent|quay|parade|highway|close|grove|court|esplanade|boulevard|mews|heights|flat|level|floor|unit|suite|apartment|po box|postcode)\y')),
  donor_name_status text not null check (donor_name_status in ('published', 'not_separable', 'withheld_by_publisher')),
  donor_identity_kind text not null check (donor_identity_kind in (
    'named', 'anonymous', 'protected_from_disclosure', 'overseas', 'not_itemised')),
  disclosed_amount_nzd numeric(18, 2) not null check (disclosed_amount_nzd >= 0),
  -- The dates the return itself states for this entry, in the order the form prints them. An empty list means the
  -- return printed no date this reader could read as one; date_disclosure says which of those it was.
  donation_dates date[] not null default '{}',
  date_disclosure text not null check (date_disclosure in (
    'single_date', 'several_dates', 'described_not_dated', 'no_date_printed')),
  amounts_basis text not null check (amounts_basis = 'return_document_as_filed'),
  disclosure_reader_version text not null,
  unique (source_record_id),
  -- A name is present exactly when the status says it is. `withheld_by_publisher` is the law's own answer for an
  -- anonymous or protected donation and can never carry one.
  check ((donor_name_as_published is not null) = (donor_name_status = 'published')),
  check (donor_name_status <> 'withheld_by_publisher' or donor_identity_kind in ('anonymous', 'protected_from_disclosure')),
  check (return_kind <> 'candidate_election_return' or (candidate_name_as_published is not null and electorate_as_published is not null)),
  check (return_kind <> 'party_annual_return' or party_name_as_published is not null)
);
comment on table evidence_private.donation_disclosures is
  'One donation, loan or contribution as a filed return itemises it: the recipient, the part it was disclosed under, the amount, the dates the return states, and the donor name where the return names one. It holds no address column, and the name column refuses a value that looks like one.';
comment on column evidence_private.donation_disclosures.donor_name_status is
  'published = the return named a donor and the name could be separated from the address printed with it. withheld_by_publisher = the law withholds this identity (anonymous, or protected from disclosure). not_separable = the return named someone but this project could not prove which part of the cell was the name, so it kept none of it.';

create index donation_disclosures_by_part on evidence_private.donation_disclosures (return_part_id);
create index donation_return_parts_by_year on evidence_private.donation_return_parts (reporting_year, disclosure_part);

-- Access: the same two layers as every other table ----------------------------------------------------------------

do $$
declare
  v_name text;
begin
  foreach v_name in array array['donation_return_parts', 'donation_disclosures']
  loop
    execute format('alter table evidence_private.%I enable row level security', v_name);
    execute format('revoke all on evidence_private.%I from public, anon, authenticated', v_name);
    execute format('grant select on evidence_private.%I to evidence_inspector_reader', v_name);
    execute format('create policy %I on evidence_private.%I for select to evidence_inspector_reader using (true)', v_name || '_reader_select', v_name);
    execute format('grant select, insert, update, delete on evidence_private.%I to evidence_ingest', v_name);
    execute format('create policy %I on evidence_private.%I for all to evidence_ingest using (true) with check (true)', v_name || '_ingest_all', v_name);
  end loop;
end
$$;

-- 2. The payload guard learns three names, and no more -------------------------------------------------------------
--
-- `payload_violation` refuses any field whose name begins with `donor` or `contributor`, at any depth. That rule was
-- right while nothing donor-shaped was ever meant to be stored. Three typed fields now are, and they are named
-- here, one at a time, as an exception - the pattern otherwise stands exactly as it was, and `address`, `street`
-- and `postcode` stay refused whatever they are attached to, so a field holding an address is refused twice over.
-- Kept equal to VETTED_DONOR_FIELDS in ingest/src/families/election/contracts.ts (tested).
create or replace function evidence_private.payload_violation(p_payload jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text := p_payload::text;
  v_scan text;
  v_key text;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    return 'payload_not_object';
  end if;
  if length(v_text) > 8192 then
    return 'payload_too_large';
  end if;
  -- Field names are part of what gets published: plain snake_case only, at every depth.
  for v_key in select jsonb_path_query(p_payload, '$.** ? (@.type() == "object").keyvalue().key') #>> '{}' loop
    if v_key !~ '^[a-z][a-z0-9_]{0,62}$' then
      return 'hostile_field_name';
    end if;
  end loop;
  -- The three vetted donation fields are taken out of the name scan and nothing else is.
  v_scan := regexp_replace(v_text, '"(donor_name_as_published|donor_name_status|donor_identity_kind)"(\s*):', '"vetted_donation_field"\2:', 'g');
  if v_scan ~* '"(e[-_]?mail|phone|mobile|fax|address|street|postcode|donor[a-z_]*|contributor[a-z_]*|body|html|raw[a-z_]*|full_text|content_html|file_path|archive_path|local_path|storage_url|signed_url|source_record_json|payload_json|source_passage|password|secret|token|api_key|credential[a-z_]*)"\s*:' then
    return 'forbidden_field_name';
  end if;
  return evidence_private.text_violation(v_text);
end
$$;
revoke execute on function evidence_private.payload_violation(jsonb) from public;
grant execute on function evidence_private.payload_violation(jsonb) to evidence_ingest;

-- 3. The projection --------------------------------------------------------------------------------------------
--
-- Registered beside the election family's own projector rather than folded into it: 20260921010100 is applied and
-- is never edited. Parts are written before entries so an entry can name the part it belongs to.

create or replace function evidence_private.project_donation_disclosures(p_run_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row record;
  v_part uuid;
  v_party uuid;
  v_counts jsonb := '{}'::jsonb;
begin
  for v_row in
    select r.id as record_id, r.source_id, r.external_record_id, v.id as version_id, v.record_kind, v.source_url, v.safe_payload as p
    from evidence_private.source_observations o
    join evidence_private.source_record_versions v on v.id = o.version_id
    join evidence_private.source_records r on r.id = v.record_id
    where o.run_id = p_run_id and r.current_version_id = v.id
      and v.record_kind in ('donation_return_part', 'donation_disclosure_entry')
    -- Parts first: an entry names the part it was disclosed under.
    order by case v.record_kind when 'donation_return_part' then 0 else 1 end, r.external_record_id
  loop
    v_party := case when v_row.p ? 'party_name_as_published'
                    then evidence_private.ensure_party_identity(v_row.source_id, v_row.p ->> 'party_name_as_published') end;

    if v_row.record_kind = 'donation_return_part' then
      insert into evidence_private.donation_return_parts (
        source_record_id, evidence_version_id, party_identity_id, return_kind, reporting_year,
        overlaps_election_year_notices, party_name_as_published, candidate_name_as_published, electorate_as_published,
        document_version_type, amendment_labelled, official_url, catalogue_page_url, disclosure_part,
        part_label_as_published, disclosure_kind, donor_identity_kind, disclosed_total_nzd, disclosed_total_status,
        entries_disclosed, itemisation_status, itemisation_note, amounts_basis, disclosure_reader_version)
      values (
        v_row.record_id, v_row.version_id, v_party, v_row.p ->> 'return_kind', (v_row.p ->> 'reporting_year')::integer,
        coalesce((v_row.p ->> 'overlaps_election_year_notices')::boolean, false),
        v_row.p ->> 'party_name_as_published', v_row.p ->> 'candidate_name_as_published', v_row.p ->> 'electorate_as_published',
        v_row.p ->> 'document_version_type', coalesce((v_row.p ->> 'amendment_labelled')::boolean, false),
        v_row.source_url, v_row.p ->> 'catalogue_page_url', v_row.p ->> 'disclosure_part',
        v_row.p ->> 'part_label_as_published', v_row.p ->> 'disclosure_kind', v_row.p ->> 'donor_identity_kind',
        (v_row.p ->> 'disclosed_total_nzd')::numeric, v_row.p ->> 'disclosed_total_status',
        coalesce((v_row.p ->> 'entries_disclosed')::integer, 0), v_row.p ->> 'itemisation_status',
        v_row.p ->> 'itemisation_note', v_row.p ->> 'amounts_basis', v_row.p ->> 'disclosure_reader_version')
      on conflict (source_record_id) do update set
        evidence_version_id = excluded.evidence_version_id, party_identity_id = excluded.party_identity_id,
        disclosed_total_nzd = excluded.disclosed_total_nzd, disclosed_total_status = excluded.disclosed_total_status,
        entries_disclosed = excluded.entries_disclosed, itemisation_status = excluded.itemisation_status,
        itemisation_note = excluded.itemisation_note, amendment_labelled = excluded.amendment_labelled,
        document_version_type = excluded.document_version_type;
    else
      -- The part this entry belongs to is the record whose id is this one with the entry suffix removed. Both are
      -- records of the same source, so the link never crosses a rights row.
      select p.id into v_part
      from evidence_private.donation_return_parts p
      join evidence_private.source_records r on r.id = p.source_record_id
      where r.source_id = v_row.source_id
        and r.external_record_id = regexp_replace(v_row.external_record_id, '-entry-[0-9]+$', '');

      insert into evidence_private.donation_disclosures (
        source_record_id, evidence_version_id, return_part_id, party_identity_id, return_kind, reporting_year,
        overlaps_election_year_notices, party_name_as_published, candidate_name_as_published, electorate_as_published,
        amendment_labelled, official_url, disclosure_part, part_label_as_published, disclosure_kind,
        entry_index, donor_name_as_published, donor_name_status, donor_identity_kind, disclosed_amount_nzd,
        donation_dates, date_disclosure, amounts_basis, disclosure_reader_version)
      values (
        v_row.record_id, v_row.version_id, v_part, v_party, v_row.p ->> 'return_kind', (v_row.p ->> 'reporting_year')::integer,
        coalesce((v_row.p ->> 'overlaps_election_year_notices')::boolean, false),
        v_row.p ->> 'party_name_as_published', v_row.p ->> 'candidate_name_as_published', v_row.p ->> 'electorate_as_published',
        coalesce((v_row.p ->> 'amendment_labelled')::boolean, false), v_row.source_url,
        v_row.p ->> 'disclosure_part', v_row.p ->> 'part_label_as_published', v_row.p ->> 'disclosure_kind',
        (v_row.p ->> 'entry_index')::integer, v_row.p ->> 'donor_name_as_published', v_row.p ->> 'donor_name_status',
        v_row.p ->> 'donor_identity_kind', (v_row.p ->> 'disclosed_amount_nzd')::numeric,
        coalesce((select array_agg(d::date order by d::date) from jsonb_array_elements_text(coalesce(v_row.p -> 'donation_dates', '[]'::jsonb)) as d), '{}'::date[]),
        v_row.p ->> 'date_disclosure', v_row.p ->> 'amounts_basis', v_row.p ->> 'disclosure_reader_version')
      on conflict (source_record_id) do update set
        evidence_version_id = excluded.evidence_version_id, return_part_id = excluded.return_part_id,
        party_identity_id = excluded.party_identity_id, donor_name_as_published = excluded.donor_name_as_published,
        donor_name_status = excluded.donor_name_status, disclosed_amount_nzd = excluded.disclosed_amount_nzd,
        donation_dates = excluded.donation_dates, date_disclosure = excluded.date_disclosure;
    end if;
    v_counts := jsonb_set(v_counts, array[v_row.record_kind], to_jsonb(coalesce((v_counts ->> v_row.record_kind)::integer, 0) + 1));
  end loop;
  return v_counts;
end
$$;

revoke execute on function evidence_private.project_donation_disclosures(uuid) from public;
grant execute on function evidence_private.project_donation_disclosures(uuid) to evidence_ingest;

insert into evidence_private.run_projectors (projector_key, function_name)
values ('election_donations', 'project_donation_disclosures')
on conflict (projector_key) do nothing;

-- 4. The owner decision: a scope kind for published donation facts --------------------------------------------------

alter table evidence_private.owner_authorization_scopes drop constraint owner_authorization_scopes_scope_kind_check;
alter table evidence_private.owner_authorization_scopes add constraint owner_authorization_scopes_scope_kind_check
  check (scope_kind in ('pages_deploy', 'public_rows', 'source_fields', 'statistical_facts',
                        'official_result_figures', 'official_finance_figures', 'published_poll_figures',
                        'published_donation_facts'));

alter table evidence_private.owner_authorization_scopes drop constraint owner_scope_shape;
alter table evidence_private.owner_authorization_scopes add constraint owner_scope_shape check (
  (scope_kind = 'pages_deploy' and surface_id = 'explorer-pages' and source_id is null and rights_id is null and field_token is null)
  or (scope_kind = 'public_rows' and surface_id = 'evidence-store' and source_id is null and rights_id is null and field_token is null)
  or (scope_kind in ('source_fields', 'statistical_facts', 'official_result_figures', 'official_finance_figures',
                     'published_poll_figures', 'published_donation_facts')
      and surface_id is null and source_id is not null and rights_id is not null
      and field_token is not null and basis is not null and length(btrim(basis)) >= 40));

-- The donation facts a return discloses, and nothing else. A closed list, kept equal to DONATION_FACT_FIELDS in
-- tools/owner_authorization.ts (tested). It carries no name that could hold a location, a contact or a document.
alter table evidence_private.owner_authorization_scopes add constraint owner_donation_fact_tokens
  check (scope_kind is distinct from 'published_donation_facts' or field_token in (
    'donor_name_as_published', 'donor_name_status', 'donor_identity_kind',
    'disclosed_amount_nzd', 'disclosed_total_nzd', 'disclosed_total_status', 'part_total_nzd', 'amounts_basis'));

drop index evidence_private.owner_scope_field;
create unique index owner_scope_field on evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, field_token)
  where scope_kind in ('source_fields', 'statistical_facts', 'official_result_figures', 'official_finance_figures',
                       'published_poll_figures', 'published_donation_facts');

-- The registry products a donation fact may be released for: the two disclosure products only. The document
-- INDEXES those disclosures were read from (candidate_finance_returns, party_finance_returns) are deliberately not
-- on this list, so an owner decision about a donor can never widen to a different product by accident. Literals in
-- exactly two places, this guard and evidence_private.source_release, mirrored by FIGURE_REGISTRIES in
-- tools/owner_authorization.ts; a TypeScript test reads this file and holds all three equal.
create or replace function evidence_private.owner_scope_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_rights text;
  v_status text;
  v_release text;
  v_view_scope text;
  v_registry_key text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'owner authorization scopes are append-only; revoke the authorization and record a new one' using errcode = 'P0001';
  end if;
  if new.scope_kind in ('source_fields', 'statistical_facts', 'official_result_figures', 'official_finance_figures',
                        'published_poll_figures', 'published_donation_facts') then
    select s.rights_id, r.review_status, r.default_release, s.view_scope, s.registry_key
      into v_rights, v_status, v_release, v_view_scope, v_registry_key
    from evidence_private.sources s left join evidence_private.source_rights r on r.rights_id = s.rights_id
    where s.source_id = new.source_id;
    if v_rights is distinct from new.rights_id then
      raise exception 'owner field decision for % names rights row %, but the source is governed by %', new.source_id, new.rights_id, coalesce(v_rights, 'no rights row')
        using errcode = 'P0001';
    end if;
    if v_status in ('refused', 'restricted') or v_release = 'withheld' then
      raise exception 'rights row % is %/%: an owner decision cannot publish against a recorded publisher restriction', new.rights_id, v_status, v_release
        using errcode = 'P0001';
    end if;
    -- A number is released as a statistical fact only for a source registered as official statistics.
    if new.scope_kind = 'statistical_facts' and (v_view_scope is distinct from 'statistics' or v_registry_key is distinct from 'statistics') then
      raise exception 'source % is not a statistics source: statistical facts can be released for official statistics only', new.source_id
        using errcode = 'P0001';
    end if;
    -- A published figure is released only for a source of the official product that prints it.
    if (new.scope_kind = 'official_result_figures' and v_registry_key is distinct from 'election_2023_results')
       or (new.scope_kind = 'official_finance_figures'
           and (v_registry_key is null or v_registry_key not in ('candidate_finance_returns', 'party_finance_returns')))
       or (new.scope_kind = 'published_poll_figures' and v_registry_key is distinct from 'party_vote_polls')
       or (new.scope_kind = 'published_donation_facts'
           and (v_registry_key is null or v_registry_key not in ('candidate_return_disclosures', 'party_return_disclosures'))) then
      raise exception 'source % is registered as %, which is not a % product: figures can be released only for the official product that publishes them',
        new.source_id, coalesce(v_registry_key, 'no registry product'), new.scope_kind using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;
revoke execute on function evidence_private.owner_scope_guard() from public;

create or replace view evidence_private.source_release as
select s.source_id,
       case
         when r.rights_id is null then 'none'
         when r.review_status in ('refused', 'restricted') then 'none'
         when r.default_release = 'withheld' then 'none'
         when r.review_status = 'approved' and r.default_release = 'approved-fields' then 'fields'
         else 'link_only'
       end as tier,
       case when r.review_status = 'approved' and r.default_release = 'approved-fields' then r.approved_fields else '{}'::text[] end as approved_fields,
       case
         when r.rights_id is null or r.review_status in ('refused', 'restricted') or r.default_release = 'withheld' then '{}'::text[]
         else coalesce((select array_agg(distinct f.field_token order by f.field_token)
                        from evidence_private.owner_authorization_scopes f
                        join evidence_private.owner_authorizations o on o.authorization_id = f.authorization_id
                        where f.scope_kind in ('source_fields', 'statistical_facts', 'official_result_figures',
                                               'official_finance_figures', 'published_poll_figures', 'published_donation_facts')
                          and f.source_id = s.source_id and f.rights_id = r.rights_id
                          and (f.scope_kind <> 'statistical_facts' or (s.view_scope = 'statistics' and s.registry_key = 'statistics'))
                          -- The same literal lists as the guard above; kept equal by test.
                          and (f.scope_kind <> 'official_result_figures' or s.registry_key = 'election_2023_results')
                          and (f.scope_kind <> 'official_finance_figures' or s.registry_key in ('candidate_finance_returns', 'party_finance_returns'))
                          and (f.scope_kind <> 'published_poll_figures' or s.registry_key = 'party_vote_polls')
                          and (f.scope_kind <> 'published_donation_facts' or s.registry_key in ('candidate_return_disclosures', 'party_return_disclosures'))
                          and o.revoked_at is null and (now() at time zone 'utc')::date between o.decided_on and o.expires_on), '{}'::text[])
       end as owner_fields
from evidence_private.sources s
left join evidence_private.source_rights r on r.rights_id = s.rights_id;

comment on view evidence_private.source_release is
  'none | link_only | fields per source, from its rights row only. owner_fields lists the field names and payload keys a current owner decision shows for that source (descriptive fields; for a statistics source its statistical-fact columns; for an official results, finance-returns, poll or return-disclosure product its published figures and donation facts); it never changes the tier and is empty when the tier is none.';

-- The mirror of governance/owner-authorizations.json, which now also records donation fact scopes.
create or replace function evidence_private.sync_owner_authorizations(p_doc jsonb, p_file_hash text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_a jsonb;
  v_s jsonb;
  v_f text;
  v_id text;
  v_hash text;
  v_new integer := 0;
  v_revoked integer := 0;
  v_unchanged integer := 0;
begin
  if p_doc ->> 'schema_version' is distinct from '1' or jsonb_typeof(p_doc -> 'authorizations') is distinct from 'array' then
    raise exception 'not an owner authorization file (schema_version 1)' using errcode = 'P0001';
  end if;
  select o.authorization_id into v_id from evidence_private.owner_authorizations o
   where o.revoked_at is null
     and not exists (select 1 from jsonb_array_elements(p_doc -> 'authorizations') e where e ->> 'authorization_id' = o.authorization_id)
   limit 1;
  if v_id is not null then
    raise exception 'authorization % is in force in the database but absent from the file; mark it revoked in the file instead of deleting it', v_id
      using errcode = 'P0001';
  end if;
  for v_a in select * from jsonb_array_elements(p_doc -> 'authorizations') loop
    v_id := v_a ->> 'authorization_id';
    if v_a ->> 'status' is null or v_a ->> 'status' not in ('active', 'revoked') then
      raise exception 'authorization % has no valid status', coalesce(v_id, '(no id)') using errcode = 'P0001';
    end if;
    v_hash := 'md5:' || md5((v_a - 'status' - 'revoked_on' - 'revoked_reason')::text);
    if exists (select 1 from evidence_private.owner_authorizations o where o.authorization_id = v_id) then
      if exists (select 1 from evidence_private.owner_authorizations o where o.authorization_id = v_id and o.entry_hash <> v_hash) then
        raise exception 'authorization % differs from what was recorded; a decision is never edited. Revoke it and record a new id', v_id
          using errcode = 'P0001';
      end if;
      if v_a ->> 'status' = 'revoked' and exists (select 1 from evidence_private.owner_authorizations o where o.authorization_id = v_id and o.revoked_at is null) then
        update evidence_private.owner_authorizations set revoked_at = now(), revoked_reason = v_a ->> 'revoked_reason' where authorization_id = v_id;
        v_revoked := v_revoked + 1;
      else
        v_unchanged := v_unchanged + 1;
      end if;
      continue;
    end if;
    if v_a ->> 'status' = 'revoked' then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;
    if jsonb_typeof(v_a -> 'scopes') is distinct from 'array' or jsonb_array_length(v_a -> 'scopes') = 0 then
      raise exception 'authorization % names no scope', v_id using errcode = 'P0001';
    end if;
    insert into evidence_private.owner_authorizations (
      authorization_id, decided_on, expires_on, decided_by, decided_by_role, request_source, statement, not_claimed, file_hash, entry_hash)
    values (v_id, (v_a ->> 'decided_on')::date, (v_a ->> 'expires_on')::date, v_a ->> 'decided_by', v_a ->> 'decided_by_role',
            v_a ->> 'request_source', v_a ->> 'statement',
            array(select jsonb_array_elements_text(v_a -> 'not_claimed')), p_file_hash, v_hash);
    for v_s in select * from jsonb_array_elements(v_a -> 'scopes') loop
      if v_s ->> 'scope' in ('source_fields', 'statistical_facts', 'official_result_figures', 'official_finance_figures',
                             'published_poll_figures', 'published_donation_facts') then
        if jsonb_typeof(v_s -> 'fields') is distinct from 'array' or jsonb_array_length(v_s -> 'fields') = 0 then
          raise exception 'field decision for % names no fields', v_s ->> 'source_id' using errcode = 'P0001';
        end if;
        for v_f in select jsonb_array_elements_text(v_s -> 'fields') loop
          insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, rights_id, field_token, basis)
          values (v_id, v_s ->> 'scope', v_s ->> 'source_id', v_s ->> 'rights_id', v_f, v_s ->> 'basis');
        end loop;
      else
        insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, surface_id)
        values (v_id, v_s ->> 'scope', v_s ->> 'surface_id');
      end if;
    end loop;
    v_new := v_new + 1;
  end loop;
  return jsonb_build_object('recorded', v_new, 'revoked', v_revoked, 'unchanged', v_unchanged);
end
$$;
revoke execute on function evidence_private.sync_owner_authorizations(jsonb, text) from public;

-- 5. What a reader sees ----------------------------------------------------------------------------------------

insert into evidence_private.public_lineage (object_schema, object_name, lineage_kind, lineage_sql, note) values
  ('evidence_private', 'donation_return_parts', 'source', '(select l.source_id from evidence_private.lineage_record l where l.record_id = b.source_record_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'donation_disclosures', 'source', '(select l.source_id from evidence_private.lineage_record l where l.record_id = b.source_record_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.');

select evidence_private.classify_public_columns();
select evidence_private.rebuild_exposed_views();

-- A donation is only meaningful beside the thing that says how complete the reading is. This curated view puts the
-- donor, the recipient, the amount, the dates and the official link in ONE row with the part's own itemisation
-- status and the double-counting flag, so a reader can never receive a figure without being told what it is.
create or replace view evidence_views.donation_disclosures as
select d.official_url,
       d.return_kind,
       d.reporting_year,
       d.party_name_as_published,
       d.candidate_name_as_published,
       d.electorate_as_published,
       d.amendment_labelled,
       d.disclosure_part,
       d.part_label_as_published,
       d.disclosure_kind,
       d.entry_index,
       d.donor_name_as_published,
       d.donor_name_status,
       d.donor_identity_kind,
       d.disclosed_amount_nzd,
       d.donation_dates,
       d.date_disclosure,
       d.overlaps_election_year_notices,
       p.disclosed_total_nzd as part_total_nzd,
       p.entries_disclosed as part_entries_disclosed,
       p.itemisation_status as part_itemisation_status,
       p.amounts_basis,
       p.disclosure_reader_version
from evidence_private.donation_disclosures d
left join evidence_private.donation_return_parts p on p.id = d.return_part_id;

comment on view evidence_views.donation_disclosures is
  'One disclosed donation, loan or contribution with everything a reader needs to read it honestly: who received it, which part of the return disclosed it, the amount and dates the return states, the donor name where the return names one, the official link to the return, and the part''s own itemisation status. Rows exist only for parts whose entries sum exactly to the total the form prints.';

-- A base view is NEVER left owned by the owner of the private tables: that owner is exempt from row level
-- security, and a view runs its body with its owner's privileges (pgTAP 090).
grant usage, create on schema evidence_views to evidence_inspector_reader;
alter view evidence_views.donation_disclosures owner to evidence_inspector_reader;
revoke all on evidence_views.donation_disclosures from public, anon, authenticated;
revoke create on schema evidence_views from evidence_inspector_reader;

insert into evidence_private.public_lineage (object_schema, object_name, lineage_kind, lineage_sql, note) values
  ('evidence_views', 'donation_disclosures', 'source', '(select l.source_id from evidence_private.lineage_record l join evidence_private.donation_disclosures x on x.source_record_id = l.record_id where x.official_url = b.official_url and x.entry_index = b.entry_index limit 1)', 'Every row resolves to exactly one source through the disclosure it curates; rows that do not are not shown.');

select evidence_private.classify_public_columns();
select evidence_private.rebuild_exposed_views();
