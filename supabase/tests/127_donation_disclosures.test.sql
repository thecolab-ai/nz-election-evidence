-- Donations disclosed inside a filed return: the guards that stand between a return document and a reader.
--
--   1. The store refuses a payload field whose name is not one of the three vetted donor names, and the three
--      it now allows are allowed one at a time; a field that could hold a location is still refused.
--   2. The donor-name COLUMN refuses a value holding a digit or a street word, whatever the loader believed.
--   3. An identity the law withholds is stored with no name and cannot be given one.
--   4. A donation fact is released by its own scope kind, for the two return-DISCLOSURE products only - not for
--      the document indexes those disclosures were read from - and a publisher's recorded restriction beats it.
--   5. The curated public view never gives a reader an amount without the status that says how complete the
--      reading of its part was.
-- TEST FIXTURES ONLY: synthetic, rolled back. Every donor name below is invented. Rights ids RIGHTS-77x are
-- distinct from every other fixture's.
begin;
select plan(31);
grant evidence_ingest to current_user;

update evidence_private.owner_authorizations set revoked_at = now(), revoked_reason = 'pgTAP isolation; rolled back' where revoked_at is null;
update evidence_private.release_gates set state = 'open', evidence_reference = 'fixture', decided_by = 'Fixture Reviewer Name', decided_at = now()
 where gate_key in ('r10_public_surface_review', 'r8_accountable_legal_entity');

create function pg_temp.src(p_id text, p_rights text, p_registry text, p_scope text) returns jsonb language sql as $$
  select jsonb_build_object('source_id', p_id, 'registry_key', p_registry, 'title', 'Fixture ' || p_id,
    'publisher', 'Fixture Publisher', 'official_url', 'https://fixture.example/' || p_id,
    'adapter_kind', 'export_import', 'adapter_name', 'fixture', 'allowed_hosts', jsonb_build_array(),
    'rights_id', p_rights, 'view_scope', p_scope, 'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'f');
$$;
create function pg_temp.rights(p_id text) returns jsonb language sql as $$
  select jsonb_build_object('rights_id', p_id, 'publisher', 'Fixture Publisher', 'source_url', 'https://fixture.example/',
    'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h');
$$;

select evidence_private.sync_registry(jsonb_build_object(
  'rights', jsonb_build_array(pg_temp.rights('RIGHTS-771'), pg_temp.rights('RIGHTS-772'), pg_temp.rights('RIGHTS-773')),
  'registry_products', jsonb_build_array(
    jsonb_build_object('registry_key', 'party_return_disclosures', 'title', 'Disclosures inside party returns', 'domain', 'Political finance'),
    jsonb_build_object('registry_key', 'party_finance_returns', 'title', 'Party finance returns', 'domain', 'Political finance')),
  'sources', jsonb_build_array(
    pg_temp.src('pgtap_dd_disclosures', 'RIGHTS-771', 'party_return_disclosures', 'finance_2025'),
    pg_temp.src('pgtap_dd_index', 'RIGHTS-772', 'party_finance_returns', 'finance_2025'),
    pg_temp.src('pgtap_dd_shut', 'RIGHTS-773', 'party_return_disclosures', 'finance_2025'))));

-- One return with one part and two entries: a named donor, and an anonymous one the law withholds.
create function pg_temp.load(p_source text, p_prefix text) returns void language plpgsql as $$
declare
  v_holder uuid := '77777777-0000-0000-0000-777777777777';
  v_run uuid;
  v_context jsonb := jsonb_build_object(
    'reporting_year', 2025, 'return_kind', 'party_annual_return', 'party_name_as_published', 'FIXTURE Example Party',
    'disclosure_part', 'A', 'part_label_as_published', 'Party donations of more than $5,000',
    'disclosure_kind', 'donation', 'amounts_basis', 'return_document_as_filed',
    'disclosure_reader_version', 'ec-return-parts-1', 'overlaps_election_year_notices', false, 'amendment_labelled', false);
begin
  perform evidence_private.acquire_lease(p_source, v_holder, 60);
  v_run := (evidence_private.start_run(p_source, v_holder, 'v1', 'export_import', 'test', 'm-' || p_prefix) ->> 'run_id')::uuid;
  perform evidence_private.ingest_batch(v_run, v_holder, jsonb_build_array(
    jsonb_build_object('external_record_id', p_prefix || '#part-A', 'record_kind', 'donation_return_part',
      'content_hash', 'sha256:' || repeat('7', 64), 'source_url', 'https://fixture.example/' || p_prefix || '/return.pdf',
      'retrieved_at', now(),
      'safe_payload', v_context || jsonb_build_object(
        'donor_identity_kind', 'named', 'disclosed_total_nzd', 15000, 'disclosed_total_status', 'reported',
        'entries_disclosed', 2, 'itemisation_status', 'reconciled', 'itemisation_note', 'entries_sum_equals_printed_total')),
    jsonb_build_object('external_record_id', p_prefix || '#part-A-entry-0001', 'record_kind', 'donation_disclosure_entry',
      'content_hash', 'sha256:' || repeat('8', 64), 'source_url', 'https://fixture.example/' || p_prefix || '/return.pdf',
      'retrieved_at', now(),
      'safe_payload', v_context || jsonb_build_object(
        'donor_identity_kind', 'named', 'entry_index', 1, 'donor_name_status', 'published',
        'donor_name_as_published', 'FIXTURE Kahu Whitiwhiti', 'disclosed_amount_nzd', 10000,
        'donation_dates', jsonb_build_array('2025-03-01'), 'date_disclosure', 'single_date')),
    jsonb_build_object('external_record_id', p_prefix || '#part-A-entry-0002', 'record_kind', 'donation_disclosure_entry',
      'content_hash', 'sha256:' || repeat('9', 64), 'source_url', 'https://fixture.example/' || p_prefix || '/return.pdf',
      'retrieved_at', now(),
      'safe_payload', v_context || jsonb_build_object(
        'donor_identity_kind', 'anonymous', 'entry_index', 2, 'donor_name_status', 'withheld_by_publisher',
        'disclosed_amount_nzd', 5000, 'donation_dates', jsonb_build_array(), 'date_disclosure', 'no_date_printed'))));
  perform evidence_private.project_run(v_run, v_holder);
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', false, 'wm', null, null);
end
$$;
select pg_temp.load('pgtap_dd_disclosures', 'ddfix');
select pg_temp.load('pgtap_dd_shut', 'ddshut');

-- The rows this test made, and nothing else. Every assertion below is scoped to these, so the file says the same
-- thing on an empty store and on a store that already holds the real returns.
create view pg_temp.fixture_records as
  select id from evidence_private.source_records where source_id in ('pgtap_dd_disclosures', 'pgtap_dd_shut');

-- 1. The payload guard: three names in, everything else still out -------------------------------------------------
select is(evidence_private.payload_violation(jsonb_build_object('donor_name_as_published', 'FIXTURE Ari Templeton')), null,
  'the vetted donor name is accepted by the store');
select is(evidence_private.payload_violation(jsonb_build_object('donor_name_status', 'published')), null,
  'the vetted donor name status is accepted');
select is(evidence_private.payload_violation(jsonb_build_object('donor_identity_kind', 'anonymous')), null,
  'the vetted donor identity kind is accepted');
select is(evidence_private.payload_violation(jsonb_build_object('donor_address', 'FIXTURE 1 Example Road')), 'forbidden_field_name',
  'a donor field that could hold a location is still refused');
select is(evidence_private.payload_violation(jsonb_build_object('donor_name', 'FIXTURE Ari Templeton')), 'forbidden_field_name',
  'a donor field that is not on the closed list is refused, even one that holds only a name');
select is(evidence_private.payload_violation(jsonb_build_object('contributor_name_as_published', 'FIXTURE Ari Templeton')), 'forbidden_field_name',
  'the contributor prefix was not widened by any of this');
select is(evidence_private.payload_violation(jsonb_build_object('street', 'FIXTURE Example Road')), 'forbidden_field_name',
  'street is refused on its own');
select is(evidence_private.payload_violation(jsonb_build_object('full_text', 'FIXTURE the whole return')), 'forbidden_field_name',
  'the document text is refused on its own');
select is(evidence_private.payload_violation(jsonb_build_object('donor_name_as_published', 'FIXTURE Ari Templeton', 'donor_address', 'FIXTURE 1 Example Road')),
  'forbidden_field_name', 'a vetted name beside a forbidden one refuses the whole payload');

-- 2. The column refuses what the reader should never have produced -------------------------------------------------
-- Each update touches this test's own rows only: on a loaded store the unscoped form rewrote every real donor name
-- in the table before the column could refuse it, which is not what any of these four assertions mean to say.
select throws_ok(
  $$update evidence_private.donation_disclosures set donor_name_as_published = 'FIXTURE Ari Templeton, 9 Willow Place' where donor_name_status = 'published' and source_record_id in (select id from pg_temp.fixture_records)$$,
  '23514', null, 'a donor name holding a digit is refused by the column itself');
select throws_ok(
  $$update evidence_private.donation_disclosures set donor_name_as_published = 'FIXTURE Willow Place Sampleton' where donor_name_status = 'published' and source_record_id in (select id from pg_temp.fixture_records)$$,
  '23514', null, 'a donor name holding a street word is refused by the column itself');
select throws_ok(
  $$update evidence_private.donation_disclosures set donor_name_as_published = 'FIXTURE Ari Templeton' where donor_name_status = 'withheld_by_publisher' and source_record_id in (select id from pg_temp.fixture_records)$$,
  '23514', null, 'an identity the law withholds cannot be given a name');
select lives_ok(
  $$update evidence_private.donation_disclosures set donor_name_as_published = 'FIXTURE Marama Kopu' where donor_name_status = 'published' and source_record_id in (select id from pg_temp.fixture_records)$$,
  'a plain name is accepted');

-- 3. What the projection built ------------------------------------------------------------------------------------
-- Every assertion below counts THIS TEST'S fixture rows, never "everything in the table". The two donation tables
-- hold real loaded returns on any store that has run a combined import (1,335 parts and 291 entries at 8a94a1f), and
-- a test that passes only on an empty store proves nothing about the store the projection actually runs against.
select is((select count(*) from evidence_private.donation_return_parts where source_record_id in (select id from pg_temp.fixture_records)),
  2::bigint, 'one part row per fixture return');
select is((select count(*) from evidence_private.donation_disclosures where source_record_id in (select id from pg_temp.fixture_records)),
  4::bigint, 'two entries per fixture return');
select is((select count(*) from evidence_private.donation_disclosures d
            join evidence_private.donation_return_parts p on p.id = d.return_part_id
            where d.source_record_id in (select id from pg_temp.fixture_records)), 4::bigint,
  'every entry names the part it was disclosed under');
select is((select donor_name_as_published from evidence_private.donation_disclosures
            where donor_name_status = 'withheld_by_publisher'
              and source_record_id in (select id from pg_temp.fixture_records) limit 1), null,
  'an anonymous entry holds no name at all');
select is((select disclosed_amount_nzd from evidence_private.donation_disclosures
            where donor_name_status = 'withheld_by_publisher'
              and source_record_id in (select id from pg_temp.fixture_records) limit 1), 5000::numeric,
  'and its amount is published all the same: what the law withholds is the identity, not the money');

-- 4. The owner decision ---------------------------------------------------------------------------------------------
insert into evidence_private.owner_authorizations (
  authorization_id, decided_on, expires_on, decided_by, decided_by_role, request_source, statement, not_claimed, file_hash, entry_hash)
values ('OWNER-AUTH-2026-09-21-77', current_date, current_date + 30, 'Fixture Owner Name', 'repository owner',
  'TEST FIXTURE: owner direction relayed by the release coordinator', 'TEST FIXTURE: the owner directs that disclosed donation facts be shown with their provenance.',
  array['no R10 review exists', 'nobody accepted the R8 role', 'no publisher licence is claimed'],
  'sha256:' || repeat('c', 64), 'md5:' || repeat('e', 32));

create function pg_temp.scope(p_kind text, p_source text, p_rights text, p_field text) returns void language sql as $$
  insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, rights_id, field_token, basis)
  values ('OWNER-AUTH-2026-09-21-77', p_kind, p_source, p_rights, p_field,
    'TEST FIXTURE: exactly as the filed return discloses it, shown with the official link to that return.');
$$;
create function pg_temp.try(p_kind text, p_source text, p_rights text, p_field text) returns text language sql as $$
  select format($q$select pg_temp.scope(%L, %L, %L, %L)$q$, p_kind, p_source, p_rights, p_field);
$$;

select throws_ok(pg_temp.try('published_donation_facts', 'pgtap_dd_index', 'RIGHTS-772', 'donor_name_as_published'), 'P0001', null,
  'a donation fact cannot be released for the document INDEX the disclosure was read from');
select throws_ok(pg_temp.try('published_donation_facts', 'pgtap_dd_disclosures', 'RIGHTS-771', 'official_url'), '23514', null,
  'the donation scope names donation facts only: a link is not one');
select throws_ok(pg_temp.try('source_fields', 'pgtap_dd_disclosures', 'RIGHTS-771', 'donor_name_as_published'), '23514', null,
  'and the descriptive scope can never release a donor name');
select throws_ok(pg_temp.try('source_fields', 'pgtap_dd_disclosures', 'RIGHTS-771', 'disclosed_amount_nzd'), '23514', null,
  'nor an amount');
select lives_ok(pg_temp.try('published_donation_facts', 'pgtap_dd_disclosures', 'RIGHTS-771', 'donor_name_as_published'),
  'the donation scope releases the donor name for the disclosure product');
select pg_temp.scope('published_donation_facts', 'pgtap_dd_disclosures', 'RIGHTS-771', 'disclosed_amount_nzd');
select pg_temp.scope('published_donation_facts', 'pgtap_dd_disclosures', 'RIGHTS-771', 'donor_name_status');
select pg_temp.scope('published_donation_facts', 'pgtap_dd_disclosures', 'RIGHTS-771', 'part_total_nzd');
select pg_temp.scope('source_fields', 'pgtap_dd_disclosures', 'RIGHTS-771', 'part_label_as_published');
select pg_temp.scope('source_fields', 'pgtap_dd_disclosures', 'RIGHTS-771', 'part_itemisation_status');
select pg_temp.scope('source_fields', 'pgtap_dd_disclosures', 'RIGHTS-771', 'part_entries_disclosed');
select pg_temp.scope('source_fields', 'pgtap_dd_disclosures', 'RIGHTS-771', 'date_disclosure');
select pg_temp.scope('source_fields', 'pgtap_dd_disclosures', 'RIGHTS-771', 'donation_dates');

select is((select count(*) from evidence_private.source_release where source_id = 'pgtap_dd_disclosures'
            and 'donor_name_as_published' = any(owner_fields)), 1::bigint,
  'the decision reaches the tier that is actually read');
select is((select count(*) from evidence_private.source_release where source_id = 'pgtap_dd_shut'
            and 'donor_name_as_published' = any(owner_fields)), 0::bigint,
  'and reaches no other source, even one of the same product');

-- 5. What a reader gets ------------------------------------------------------------------------------------------
select evidence_private.rebuild_exposed_views();
set local role anon;
select is((select count(*) from evidence_public.donation_disclosures where disclosed_amount_nzd is not null
            and part_itemisation_status is null), 0::bigint,
  'anon: an amount is never shown without the status that says how complete the reading of its part was');
select is((select count(*) from evidence_public.donation_disclosures where donor_name_as_published is not null), 1::bigint,
  'anon: exactly the one fixture donor the decision covers is named');
select is((select count(*) from evidence_public.donation_disclosures
            where donor_name_status = 'withheld_by_publisher' and donor_name_as_published is not null), 0::bigint,
  'anon: an identity the law withholds is never named to a reader');
select throws_ok($$update evidence_public.donation_disclosures set disclosed_amount_nzd = 1$$, null, null,
  'anon: a donation row cannot be written');
reset role;

-- A rights row cannot leave pending without a dated review, so a recorded restriction carries its date.
update evidence_private.source_rights set review_status = 'restricted', reviewed_on = current_date where rights_id = 'RIGHTS-771';
select evidence_private.rebuild_exposed_views();
set local role anon;
select is((select count(*) from evidence_public.donation_disclosures where donor_name_as_published is not null), 0::bigint,
  'a publisher''s recorded restriction hides the donor names the owner had released');
reset role;

select is((select count(*) from evidence_private.source_rights where review_status = 'approved'), 0::bigint,
  'no rights row was approved by any of this');

select * from finish();
rollback;
