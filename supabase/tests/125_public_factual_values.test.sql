-- Published figures: an owner decision can show the numbers an official publisher printed, and nothing else.
--
-- The three rules this file exists to hold:
--   1. a `source_fields` decision still cannot name a figure, a body, a contact or an image; the seven vetted
--      exceptions are a closed list of names, not a widened pattern;
--   2. a figure scope is bound to the official product that publishes the figure, both when it is recorded and
--      every time a release tier is read, and a publisher restriction beats it;
--   3. with a figure decision in force an anonymous reader receives the REAL NUMBER, and the moment the decision
--      is revoked the same rows come back with the number null - the rows never depended on it.
-- TEST FIXTURES ONLY: synthetic, rolled back. Rights ids RIGHTS-77x are distinct from every other fixture's.
begin;
select plan(51);
grant evidence_ingest to current_user;

-- Isolation: this file is about the decisions it records, so any decision already in this (disposable) database
-- is set aside for the length of the transaction, and the review gates are closed. Rolled back with everything.
update evidence_private.owner_authorizations set revoked_at = now(), revoked_reason = 'pgTAP isolation; rolled back' where revoked_at is null;
update evidence_private.release_gates set state = 'closed', evidence_reference = null, decided_by = null, decided_at = null;

create function pg_temp.src(p_id text, p_rights text, p_registry text, p_scope text) returns jsonb language sql as $$
  select jsonb_build_object('source_id', p_id, 'registry_key', p_registry, 'title', 'Fixture ' || p_id,
    'publisher', 'Fixture Publisher', 'official_url', 'https://fixture.example/' || p_id,
    'adapter_kind', 'export_import', 'adapter_name', 'fixture', 'allowed_hosts', jsonb_build_array(),
    'rights_id', p_rights, 'view_scope', p_scope, 'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'f');
$$;
create function pg_temp.rights(p_id text, p_status text, p_release text) returns jsonb language sql as $$
  select jsonb_build_object('rights_id', p_id, 'publisher', 'Fixture Publisher', 'source_url', 'https://fixture.example/',
    'review_status', p_status, 'default_release', p_release, 'register_hash', 'h',
    'reviewed_on', case when p_status = 'pending' then null else '2026-09-20' end);
$$;

select evidence_private.sync_registry(jsonb_build_object(
  'rights', jsonb_build_array(
    pg_temp.rights('RIGHTS-771', 'pending', 'link-only'),   -- the official results publisher
    pg_temp.rights('RIGHTS-772', 'pending', 'link-only'),   -- the official finance publisher
    pg_temp.rights('RIGHTS-773', 'pending', 'link-only'),   -- a poll publisher
    pg_temp.rights('RIGHTS-774', 'pending', 'link-only')),  -- becomes restricted part way through
  'registry_products', jsonb_build_array(
    jsonb_build_object('registry_key', 'election_2023_results', 'title', 'Official 2023 results', 'domain', 'Elections'),
    jsonb_build_object('registry_key', 'party_finance_returns', 'title', 'Party finance returns', 'domain', 'Elections'),
    jsonb_build_object('registry_key', 'party_vote_polls', 'title', 'Party vote polls', 'domain', 'Elections')),
  'sources', jsonb_build_array(
    pg_temp.src('pgtap_fv_results', 'RIGHTS-771', 'election_2023_results', 'baseline_2023'),
    pg_temp.src('pgtap_fv_finance', 'RIGHTS-772', 'party_finance_returns', 'finance_2025'),
    pg_temp.src('pgtap_fv_polls', 'RIGHTS-773', 'party_vote_polls', 'primary_2026'),
    pg_temp.src('pgtap_fv_later', 'RIGHTS-774', 'election_2023_results', 'baseline_2023'))));

-- Two candidacies of the official results fixture: one electorate candidacy the source reported a figure for,
-- one list candidacy with a list position. The figures below are what the projection must end up publishing.
create function pg_temp.load(p_source text, p_prefix text, p_votes integer) returns void language plpgsql as $$
declare
  v_holder uuid := '77777777-0000-0000-0000-777777777777';
  v_run uuid;
begin
  perform evidence_private.acquire_lease(p_source, v_holder, 60);
  v_run := (evidence_private.start_run(p_source, v_holder, 'v1', 'export_import', 'test', 'm-' || p_prefix) ->> 'run_id')::uuid;
  perform evidence_private.ingest_batch(v_run, v_holder, jsonb_build_array(
    jsonb_build_object('external_record_id', p_prefix || '-seat', 'record_kind', 'baseline_2023_candidacy',
      'content_hash', 'sha256:' || repeat('7', 64), 'source_url', 'https://fixture.example/' || p_prefix || '/seat',
      'retrieved_at', now(), 'source_date_text', '14 October 2023',
      'safe_payload', jsonb_build_object('candidate_name', 'FIXTURE ' || p_prefix || ' Candidate', 'candidacy_type', 'electorate',
        'party_name', 'FIXTURE ' || p_prefix || ' Party', 'electorate_name', 'FIXTURE ' || p_prefix || ' Seat',
        'candidate_votes', p_votes, 'nomination_status', 'officially_nominated')),
    jsonb_build_object('external_record_id', p_prefix || '-list', 'record_kind', 'baseline_2023_candidacy',
      'content_hash', 'sha256:' || repeat('8', 64), 'source_url', 'https://fixture.example/' || p_prefix || '/list',
      'retrieved_at', now(), 'source_date_text', '14 October 2023',
      'safe_payload', jsonb_build_object('candidate_name', 'FIXTURE ' || p_prefix || ' Lister', 'candidacy_type', 'list',
        'party_name', 'FIXTURE ' || p_prefix || ' Party', 'list_rank', 3, 'nomination_status', 'officially_nominated'))));
  perform evidence_private.project_run(v_run, v_holder);
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', false, 'wm', null, null);
end
$$;
select pg_temp.load('pgtap_fv_results', 'fvres', 4321);

-- One owner decision, recorded directly so each scope can be offered to the guard on its own.
insert into evidence_private.owner_authorizations (
  authorization_id, decided_on, expires_on, decided_by, decided_by_role, request_source, statement, not_claimed, file_hash, entry_hash)
values ('OWNER-AUTH-2026-09-21-77', current_date, current_date + 30, 'Fixture Owner Name', 'repository owner',
  'TEST FIXTURE: owner direction relayed by the release coordinator', 'TEST FIXTURE: the owner directs that imported public figures be shown.',
  array['no R10 review exists', 'nobody accepted the R8 role', 'no publisher licence is claimed'],
  'sha256:' || repeat('a', 64), 'md5:' || repeat('b', 32));

create function pg_temp.scope(p_kind text, p_source text, p_rights text, p_field text) returns void language sql as $$
  insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, rights_id, field_token, basis)
  values ('OWNER-AUTH-2026-09-21-77', p_kind, p_source, p_rights, p_field,
    'TEST FIXTURE: exactly as the official published table prints it, shown with the official link.');
$$;
create function pg_temp.try(p_kind text, p_source text, p_rights text, p_field text) returns text language sql as $$
  select format($q$select pg_temp.scope(%L, %L, %L, %L)$q$, p_kind, p_source, p_rights, p_field);
$$;

-- 1. The descriptive scope still cannot name a figure, a body, a contact or an image ------------------------------
select throws_ok(pg_temp.try('source_fields', 'pgtap_fv_results', 'RIGHTS-771', 'votes'), '23514', null,
  'source_fields: a vote count is refused by the table, not by a convention');
select throws_ok(pg_temp.try('source_fields', 'pgtap_fv_results', 'RIGHTS-771', 'party_vote_share'), '23514', null, 'source_fields: a published share is refused');
select throws_ok(pg_temp.try('source_fields', 'pgtap_fv_finance', 'RIGHTS-772', 'amount_nzd'), '23514', null, 'source_fields: a money amount is refused');
select throws_ok(pg_temp.try('source_fields', 'pgtap_fv_polls', 'RIGHTS-773', 'value_pct'), '23514', null, 'source_fields: a poll figure is refused');
select throws_ok(pg_temp.try('source_fields', 'pgtap_fv_polls', 'RIGHTS-773', 'sample_size'), '23514', null, 'source_fields: a poll sample size is refused');
select throws_ok(pg_temp.try('source_fields', 'pgtap_fv_results', 'RIGHTS-771', 'contact_email'), '23514', null, 'source_fields: contact data is refused');
select throws_ok(pg_temp.try('source_fields', 'pgtap_fv_results', 'RIGHTS-771', 'body_html'), '23514', null, 'source_fields: a body is refused');
select throws_ok(pg_temp.try('source_fields', 'pgtap_fv_results', 'RIGHTS-771', 'portrait_image'), '23514', null, 'source_fields: an image is refused');
select throws_ok(pg_temp.try('source_fields', 'pgtap_fv_results', 'RIGHTS-771', 'donor_address'), '23514', null, 'source_fields: the postal address of a donor is refused');

-- The exception list is names, not prefixes: each of the seven is accepted, a neighbour of one is not.
select lives_ok(pg_temp.try('source_fields', 'pgtap_fv_results', 'RIGHTS-771', 'external_record_id'), 'source_fields: a publisher identifier is a vetted exception');
select lives_ok(pg_temp.try('source_fields', 'pgtap_fv_results', 'RIGHTS-771', 'source_date_text'), 'source_fields: the publisher date as printed is a vetted exception');
select lives_ok(pg_temp.try('source_fields', 'pgtap_fv_results', 'RIGHTS-771', 'text_extraction_status'), 'source_fields: a text-extraction status is a vetted exception');
select lives_ok(pg_temp.try('source_fields', 'pgtap_fv_finance', 'RIGHTS-772', 'content_kind'), 'source_fields: a kind label is a vetted exception');
select throws_ok(pg_temp.try('source_fields', 'pgtap_fv_results', 'RIGHTS-771', 'external_id_hash'), '23514', null, 'the exception list is names, not prefixes: external_id_hash is still refused');
select throws_ok(pg_temp.try('source_fields', 'pgtap_fv_results', 'RIGHTS-771', 'source_date_text_raw'), '23514', null, 'the exception list is names, not prefixes: source_date_text_raw is still refused');

-- 2. A figure scope is bound to the official product that publishes the figure ------------------------------------
select lives_ok(pg_temp.try('official_result_figures', 'pgtap_fv_results', 'RIGHTS-771', 'votes'), 'result figures: accepted for the official results product');
select lives_ok(pg_temp.try('official_finance_figures', 'pgtap_fv_finance', 'RIGHTS-772', 'amount_nzd'), 'finance figures: accepted for the official finance product');
select throws_ok(pg_temp.try('official_result_figures', 'pgtap_fv_finance', 'RIGHTS-772', 'votes'), 'P0001', null,
  'result figures: refused for a finance source');
select throws_ok(pg_temp.try('official_result_figures', 'pgtap_fv_polls', 'RIGHTS-773', 'votes'), 'P0001', null,
  'result figures: refused for a poll source');
select throws_ok(pg_temp.try('official_finance_figures', 'pgtap_fv_results', 'RIGHTS-771', 'amount_nzd'), 'P0001', null,
  'finance figures: refused for a results source');
select throws_ok(pg_temp.try('official_finance_figures', 'pgtap_fv_polls', 'RIGHTS-773', 'amount_nzd'), 'P0001', null,
  'finance figures: refused for a poll source');
select throws_ok(pg_temp.try('statistical_facts', 'pgtap_fv_results', 'RIGHTS-771', 'value'), 'P0001', null,
  'statistical facts: still refused for anything that is not a statistics source');

-- The closed token lists: a figure scope cannot carry another family's figure, a poll figure, or a number read
-- from inside a return document.
select throws_ok(pg_temp.try('official_result_figures', 'pgtap_fv_results', 'RIGHTS-771', 'amount_nzd'), '23514', null, 'result figures: a money amount is not on the list');
select throws_ok(pg_temp.try('official_result_figures', 'pgtap_fv_results', 'RIGHTS-771', 'value_pct'), '23514', null, 'result figures: a poll figure is not on the list');
select throws_ok(pg_temp.try('official_result_figures', 'pgtap_fv_results', 'RIGHTS-771', 'title'), '23514', null, 'result figures: a descriptive field is not on the list');
select throws_ok(pg_temp.try('official_result_figures', 'pgtap_fv_results', 'RIGHTS-771', 'result_status'), '23514', null,
  'result figures: the publisher''s own result status is a descriptive field, and belongs in a source_fields scope');
select throws_ok(pg_temp.try('official_finance_figures', 'pgtap_fv_finance', 'RIGHTS-772', 'approved_total'), '23514', null,
  'finance figures: a total read from INSIDE a return is on no list anywhere');
select throws_ok(pg_temp.try('official_finance_figures', 'pgtap_fv_finance', 'RIGHTS-772', 'votes'), '23514', null, 'finance figures: a vote count is not on the list');
select throws_ok(pg_temp.try('official_finance_figures', 'pgtap_fv_finance', 'RIGHTS-772', 'sample_size'), '23514', null, 'finance figures: a sample size is not on the list');

-- A publisher's recorded restriction beats an owner decision, at the moment it is recorded ...
update evidence_private.source_rights set review_status = 'restricted', reviewed_on = current_date where rights_id = 'RIGHTS-774';
select throws_ok(pg_temp.try('official_result_figures', 'pgtap_fv_later', 'RIGHTS-774', 'votes'), 'P0001', null,
  'a figure decision cannot be recorded against a restricted rights row');
select is((select tier from evidence_private.source_release where source_id = 'pgtap_fv_later'), 'none',
  'and that source is invisible whatever any decision says');

-- ... and a scope is append-only.
select throws_ok($$update evidence_private.owner_authorization_scopes set field_token = 'party_votes' where scope_kind = 'official_result_figures'$$,
  'P0001', null, 'owner scopes are append-only: a recorded scope is never edited');

-- 3. What an anonymous reader receives ----------------------------------------------------------------------------
select pg_temp.scope('official_result_figures', 'pgtap_fv_results', 'RIGHTS-771', 'value_status');
select pg_temp.scope('official_result_figures', 'pgtap_fv_results', 'RIGHTS-771', 'list_rank');
select pg_temp.scope('official_result_figures', 'pgtap_fv_results', 'RIGHTS-771', 'votes_status');
select pg_temp.scope('source_fields', 'pgtap_fv_results', 'RIGHTS-771', 'result_status');
select pg_temp.scope('source_fields', 'pgtap_fv_results', 'RIGHTS-771', 'candidate_name');
insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, surface_id)
values ('OWNER-AUTH-2026-09-21-77', 'public_rows', 'evidence-store');

select is((select count(*) from evidence_private.candidate_results cr
            join evidence_private.candidacies c on c.id = cr.candidacy_id
            join evidence_private.person_source_identities i on i.id = c.person_identity_id
            where i.source_id = 'pgtap_fv_results' and cr.votes = 4321), 1::bigint,
  'fixture premise: the store holds the figure the source reported');

set local role anon;
select is((select votes from evidence_public.candidacies where candidate_name = 'FIXTURE fvres Candidate'), 4321::bigint,
  'anonymous: the candidate vote count is the number the source reported');
select is((select votes_status from evidence_public.candidacies where candidate_name = 'FIXTURE fvres Candidate'), 'reported',
  'anonymous: the value status travels with the figure');
select is((select result_status from evidence_public.candidacies where candidate_name = 'FIXTURE fvres Candidate'), 'final',
  'anonymous: the publisher''s own result status is shown beside it');
select is((select list_rank from evidence_public.candidacies where candidate_name = 'FIXTURE fvres Lister'), 3,
  'anonymous: the list position is shown');
select is((select votes from evidence_open.candidate_results cr join evidence_open.candidacies c on c.id = cr.candidacy_id
            where c.evidence_version_id in (select v.id from evidence_open.source_record_versions v
              join evidence_open.source_records r on r.id = v.record_id where r.source_id = 'pgtap_fv_results')
              and cr.votes is not null), 4321::bigint,
  'anonymous: the same figure in the table projection');
select ok((select bool_and(release_basis = 'owner_override' and state = 'closed') from evidence_public.surface_status),
  'the figures rest on the owner''s decision, and both review gates still read closed');
select ok((select 'official_result_figures' = any (owner_figure_scopes) and 'official_finance_figures' = any (owner_figure_scopes)
           from evidence_public.surface_status limit 1),
  'surface_status names the kinds of figure that rest on the owner''s decision');
reset role;

select is((select count(*) from evidence_private.source_rights where review_status <> 'pending'), 1::bigint,
  'no rights row was approved by any of this: the only non-pending row is the one this test restricted itself');

-- Revoking the decision takes the numbers away and leaves the rows ------------------------------------------------
update evidence_private.owner_authorizations set revoked_at = now(), revoked_reason = 'TEST FIXTURE: the owner withdrew it'
 where authorization_id = 'OWNER-AUTH-2026-09-21-77';
update evidence_private.release_gates set state = 'open', evidence_reference = 'fixture', decided_by = 'Fixture Reviewer Name', decided_at = now()
 where gate_key in ('r10_public_surface_review', 'r8_accountable_legal_entity');
set local role anon;
select is((select count(*) from evidence_public.candidacies c
            where c.evidence_version_id in (select v.id from evidence_open.source_record_versions v
              join evidence_open.source_records r on r.id = v.record_id where r.source_id = 'pgtap_fv_results')), 2::bigint,
  'revoked: both rows are still there, and it is the figure that went, not the row');
select is((select count(*) from evidence_open.candidate_results cr join evidence_open.candidacies c on c.id = cr.candidacy_id
            where c.evidence_version_id in (select v.id from evidence_open.source_record_versions v
              join evidence_open.source_records r on r.id = v.record_id where r.source_id = 'pgtap_fv_results')
              and cr.votes is not null), 0::bigint,
  'revoked: not one figure survives, even with both review gates open');
select is((select count(*) from evidence_public.surface_status where owner_figure_scopes <> '{}'), 0::bigint,
  'revoked: surface_status stops naming any figure scope');

-- 4. Nothing else moved: private reads and every write stay denied --------------------------------------------------
select throws_ok('select count(*) from evidence_private.candidate_results', '42501', null, 'anon: the private table is denied');
select throws_ok('select count(*) from evidence_private.owner_authorization_scopes', '42501', null, 'anon: owner scopes are read through the projection only');
select throws_ok('select count(*) from evidence_private.source_release', '42501', null, 'anon: release tiers are read through the views only');
-- Refused twice over: the projection is not an updatable view (55000), and anon holds no privilege on it either.
select throws_ok($$update evidence_open.candidate_results set votes = 1$$, null, null, 'anon: a figure cannot be written');
select throws_ok($$delete from evidence_open.election_party_totals$$, null, null, 'anon: delete denied');
select throws_ok($$insert into evidence_open.owner_authorization_scopes (scope_kind) values ('official_result_figures')$$, null, null,
  'anon: an owner scope cannot be inserted');
reset role;
-- Checked with the privileges in the catalogue rather than by attempting a write: the projection refuses an
-- update because it is not an updatable view, and anon holds no write grant on it or on the table behind it.
select ok(not has_table_privilege('anon', 'evidence_open.candidate_results', 'UPDATE')
          and not has_table_privilege('anon', 'evidence_open.candidate_results', 'INSERT')
          and not has_table_privilege('anon', 'evidence_private.candidate_results', 'UPDATE'),
  'anon holds no write privilege on the figure projection or on the table behind it');

select * from finish();
rollback;
