-- Round two: published poll figures, the label that must travel with them, and the allowlisted payload.
--
--   1. A poll figure is released by its own scope kind, for the poll product only, and a publisher's recorded
--      restriction still beats it.
--   2. `methodology_status` is LINK metadata: it is shown at every tier, for every source, with no decision at
--      all, so a figure can never appear beside a blank label. The raw table projection carries no figure; the
--      only public path is evidence_public.poll_figures, where the label is in the same row.
--   3. The payload is released KEY BY KEY against the same list, so a key needs naming in the scope that fits
--      what it holds: a figure key in a figure scope, a descriptive key in source_fields.
-- TEST FIXTURES ONLY: synthetic, rolled back. Rights ids RIGHTS-76x are distinct from every other fixture's.
begin;
select plan(36);
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
  'rights', jsonb_build_array(pg_temp.rights('RIGHTS-761'), pg_temp.rights('RIGHTS-762'), pg_temp.rights('RIGHTS-763')),
  'registry_products', jsonb_build_array(
    jsonb_build_object('registry_key', 'party_vote_polls', 'title', 'Party vote polls', 'domain', 'Elections'),
    jsonb_build_object('registry_key', 'election_2023_results', 'title', 'Official 2023 results', 'domain', 'Elections')),
  'sources', jsonb_build_array(
    pg_temp.src('pgtap_pf_polls', 'RIGHTS-761', 'party_vote_polls', 'primary_2026'),
    pg_temp.src('pgtap_pf_other', 'RIGHTS-762', 'election_2023_results', 'baseline_2023'),
    pg_temp.src('pgtap_pf_shut', 'RIGHTS-763', 'party_vote_polls', 'primary_2026'))));

-- One poll of each fixture poll source: one party at 31.5 per cent, one party the poll reported no figure for.
create function pg_temp.load_poll(p_source text, p_prefix text, p_methodology text) returns void language plpgsql as $$
declare
  v_holder uuid := '76767676-0000-0000-0000-767676767676';
  v_run uuid;
begin
  perform evidence_private.acquire_lease(p_source, v_holder, 60);
  v_run := (evidence_private.start_run(p_source, v_holder, 'v1', 'export_import', 'test', 'm-' || p_prefix) ->> 'run_id')::uuid;
  perform evidence_private.ingest_batch(v_run, v_holder, jsonb_build_array(
    jsonb_build_object('external_record_id', p_prefix || '-poll', 'record_kind', 'party_vote_poll',
      'content_hash', 'sha256:' || repeat('6', 64), 'source_url', 'https://fixture.example/' || p_prefix || '/poll',
      'retrieved_at', now(),
      'safe_payload', jsonb_build_object(
        'pollster', 'FIXTURE ' || p_prefix || ' Pollster', 'sponsor', 'FIXTURE ' || p_prefix || ' Sponsor',
        'methodology_status', p_methodology, 'sample_size', 1002, 'document_title', 'FIXTURE ' || p_prefix || ' poll',
        'index_url', 'https://fixture.example/' || p_prefix || '/index',
        'metadata_completeness_reason', 'FIXTURE: no poll-specific disclosure was found',
        'results', jsonb_build_array(
          jsonb_build_object('party_label', 'FIXTURE Party One', 'value_pct', 31.5, 'value_status', 'reported'),
          jsonb_build_object('party_label', 'FIXTURE Party Two', 'value_status', 'not_reported'))))));
  perform evidence_private.project_run(v_run, v_holder);
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', false, 'wm', null, null);
end
$$;
select pg_temp.load_poll('pgtap_pf_polls', 'pfpoll', 'unresolved');
select pg_temp.load_poll('pgtap_pf_shut', 'pfshut', 'verified');

insert into evidence_private.owner_authorizations (
  authorization_id, decided_on, expires_on, decided_by, decided_by_role, request_source, statement, not_claimed, file_hash, entry_hash)
values ('OWNER-AUTH-2026-09-21-76', current_date, current_date + 30, 'Fixture Owner Name', 'repository owner',
  'TEST FIXTURE: owner direction relayed by the release coordinator', 'TEST FIXTURE: the owner directs that published poll figures be shown with their provenance.',
  array['no R10 review exists', 'nobody accepted the R8 role', 'no publisher licence is claimed'],
  'sha256:' || repeat('c', 64), 'md5:' || repeat('d', 32));

create function pg_temp.scope(p_kind text, p_source text, p_rights text, p_field text) returns void language sql as $$
  insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, rights_id, field_token, basis)
  values ('OWNER-AUTH-2026-09-21-76', p_kind, p_source, p_rights, p_field,
    'TEST FIXTURE: exactly as the publisher printed it, shown with the official link and the methodology label.');
$$;
create function pg_temp.try(p_kind text, p_source text, p_rights text, p_field text) returns text language sql as $$
  select format($q$select pg_temp.scope(%L, %L, %L, %L)$q$, p_kind, p_source, p_rights, p_field);
$$;

-- 1. Before any decision: the label is already there, and the figure is not -------------------------------------
set local role anon;
select is((select count(*) from evidence_public.poll_figures
            where methodology_status = 'unresolved' and poll_document_id in
            (select d.id from evidence_open.documents d join evidence_open.source_records r on r.id = d.source_record_id
              where r.source_id = 'pgtap_pf_polls')), 2::bigint,
  'no decision at all: the methodology label is link metadata and is on BOTH rows anyway');
select is((select count(*) from evidence_public.poll_figures where value_pct is not null), 0::bigint,
  'no decision at all: not one poll figure is shown');
select is((select count(*) from evidence_public.poll_figures where pollster is not null), 0::bigint,
  'no decision at all: the pollster is content and stays blank');
select throws_ok('select value_pct from evidence_open.poll_results', '42703', null,
  'the raw table projection has no figure column at all: there is one public path to a poll figure, and it carries the label');
select throws_ok('select value_status from evidence_open.poll_results', '42703', null, 'and no status column either');
reset role;

-- 2. The scope kind: the poll product only, and the closed token list ---------------------------------------------
select lives_ok(pg_temp.try('published_poll_figures', 'pgtap_pf_polls', 'RIGHTS-761', 'value_pct'), 'poll figures: accepted for the poll product');
select throws_ok(pg_temp.try('published_poll_figures', 'pgtap_pf_other', 'RIGHTS-762', 'value_pct'), 'P0001', null,
  'poll figures: refused for an election-results source');
select throws_ok(pg_temp.try('official_result_figures', 'pgtap_pf_polls', 'RIGHTS-761', 'votes'), 'P0001', null,
  'result figures: still refused for a poll source');
select throws_ok(pg_temp.try('official_finance_figures', 'pgtap_pf_polls', 'RIGHTS-761', 'amount_nzd'), 'P0001', null,
  'finance figures: still refused for a poll source');
select throws_ok(pg_temp.try('published_poll_figures', 'pgtap_pf_polls', 'RIGHTS-761', 'methodology_status'), '23514', null,
  'the methodology label is not a figure token: it is link metadata and needs no decision');
select throws_ok(pg_temp.try('published_poll_figures', 'pgtap_pf_polls', 'RIGHTS-761', 'votes'), '23514', null, 'poll figures: a vote count is not on the list');
select throws_ok(pg_temp.try('published_poll_figures', 'pgtap_pf_polls', 'RIGHTS-761', 'amount_nzd'), '23514', null, 'poll figures: a money amount is not on the list');
select throws_ok(pg_temp.try('published_poll_figures', 'pgtap_pf_polls', 'RIGHTS-761', 'pollster'), '23514', null, 'poll figures: a descriptive field is not on the list');
select throws_ok(pg_temp.try('source_fields', 'pgtap_pf_polls', 'RIGHTS-761', 'value_pct'), '23514', null,
  'and the descriptive scope still cannot name a poll figure');

-- The three names added to the vetted exception list, and their near-neighbours.
select lives_ok(pg_temp.try('source_fields', 'pgtap_pf_other', 'RIGHTS-762', 'vote_type'), 'exception: a vote TYPE is a label, not a count');
select lives_ok(pg_temp.try('source_fields', 'pgtap_pf_other', 'RIGHTS-762', 'text_layer_status'), 'exception: a text-layer status is a status word');
select throws_ok(pg_temp.try('source_fields', 'pgtap_pf_other', 'RIGHTS-762', 'vote_type_count'), '23514', null,
  'the exception list is names, not prefixes: vote_type_count is still refused');
select throws_ok(pg_temp.try('source_fields', 'pgtap_pf_other', 'RIGHTS-762', 'candidate_votes'), '23514', null,
  'a payload key that holds a figure belongs in a figure scope, not in source_fields');
select lives_ok(pg_temp.try('official_result_figures', 'pgtap_pf_other', 'RIGHTS-762', 'candidate_votes'),
  'and the result-figure scope is where that payload key is named');

-- 3. With the decision in force: the figure and its label in one row ----------------------------------------------
select pg_temp.scope('published_poll_figures', 'pgtap_pf_polls', 'RIGHTS-761', 'value_status');
select pg_temp.scope('published_poll_figures', 'pgtap_pf_polls', 'RIGHTS-761', 'sample_size');
select pg_temp.scope('published_poll_figures', 'pgtap_pf_polls', 'RIGHTS-761', 'results');
select pg_temp.scope('source_fields', 'pgtap_pf_polls', 'RIGHTS-761', 'pollster');
select pg_temp.scope('source_fields', 'pgtap_pf_polls', 'RIGHTS-761', 'metadata_completeness_reason');
select pg_temp.scope('source_fields', 'pgtap_pf_polls', 'RIGHTS-761', 'party_label_at_source');
-- The shut-out source gets the same decision, and is then restricted by its publisher.
select pg_temp.scope('published_poll_figures', 'pgtap_pf_shut', 'RIGHTS-763', 'value_pct');
insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, surface_id)
values ('OWNER-AUTH-2026-09-21-76', 'public_rows', 'evidence-store');

set local role anon;
select is((select value_pct from evidence_public.poll_figures
            where party_label_at_source = 'FIXTURE Party One' and pollster = 'FIXTURE pfpoll Pollster'), 31.5,
  'anonymous: the published party-vote figure is the number the pollster printed');
select is((select value_status from evidence_public.poll_figures
            where party_label_at_source = 'FIXTURE Party Two' and pollster = 'FIXTURE pfpoll Pollster'), 'not_reported',
  'anonymous: a party the poll reported no figure for reads not_reported, never zero');
select ok((select bool_and(methodology_status = 'unresolved' and sample_size = 1002 and official_url is not null)
           from evidence_public.poll_figures where pollster = 'FIXTURE pfpoll Pollster'),
  'anonymous: the methodology label, the sample size and the official link are in the same row as the figure');
select is((select count(*) from evidence_public.surface_status where 'published_poll_figures' = any (owner_figure_scopes)), 3::bigint,
  'surface_status names the poll figure scope, so the page notice can say so without being told');
-- The payload is released key by key: the named keys and nothing else.
select is((select v.safe_payload - 'results' from evidence_open.source_record_versions v
            join evidence_open.source_records r on r.id = v.record_id where r.source_id = 'pgtap_pf_polls'),
  '{"pollster": "FIXTURE pfpoll Pollster", "sample_size": 1002, "metadata_completeness_reason": "FIXTURE: no poll-specific disclosure was found"}'::jsonb,
  'the payload carries exactly the keys the decision names: not the sponsor, not the index url, not the title');
select ok((select (v.safe_payload -> 'results') is not null from evidence_open.source_record_versions v
            join evidence_open.source_records r on r.id = v.record_id where r.source_id = 'pgtap_pf_polls'),
  'the results key is carried by the poll figure decision, because it holds the figures');
reset role;

-- 4. A publisher's restriction still beats the owner's direction ---------------------------------------------------
update evidence_private.source_rights set review_status = 'restricted', reviewed_on = current_date where rights_id = 'RIGHTS-763';
set local role anon;
select is((select count(*) from evidence_public.poll_figures where pollster = 'FIXTURE pfshut Pollster'), 0::bigint,
  'a restricted publisher: the whole poll disappears, figure and label together');
select is((select count(*) from evidence_open.documents d join evidence_open.source_records r on r.id = d.source_record_id
            where r.source_id = 'pgtap_pf_shut'), 0::bigint, 'and so does everything descended from that source');
reset role;
select is((select cardinality(owner_fields) from evidence_private.source_release where source_id = 'pgtap_pf_shut'), 0,
  'the owner fields of a restricted source are emptied where the tier is read, not only where the decision was recorded');

-- 4b. Two adversarial paths that must fail CLOSED -------------------------------------------------------------------
-- A shared civic row can be evidenced by a source other than the one whose row displays it. Nothing published may
-- show a value whose evidencing source is invisible. Measured over whatever this database holds, real or fixture.
select is((select count(*) from evidence_public.candidacies c
            join evidence_private.contests ct on ct.id = c.contest_id
            join evidence_private.electorate_versions ev on ev.id = ct.electorate_version_id
            join evidence_private.lineage_version lv on lv.version_id = ev.evidence_version_id
            join evidence_private.source_release sr on sr.source_id = lv.source_id
           where c.electorate_name is not null and sr.tier = 'none'), 0::bigint,
  'no published candidacy shows an electorate name evidenced by a source that is invisible');

-- The registry is worker-writable. Re-pointing a source at another product cannot GAIN a figure: the eligibility
-- rule is re-checked where the tier is read, so every path through it fails closed.
select is((select cardinality(owner_fields) from evidence_private.source_release where source_id = 'pgtap_pf_polls'), 7,
  'premise: the poll fixture source shows seven field names on the owner decision, four of them poll figures');
update evidence_private.sources set registry_key = 'election_2023_results' where source_id = 'pgtap_pf_polls';
select is((select cardinality(owner_fields) from evidence_private.source_release where source_id = 'pgtap_pf_polls'), 3,
  'a source re-pointed at another product keeps only its descriptive fields: the four poll figures are gone');
update evidence_private.sources set registry_key = 'party_vote_polls' where source_id = 'pgtap_pf_polls';

-- 5. Revoking takes the figure and leaves the label --------------------------------------------------------------
update evidence_private.owner_authorizations set revoked_at = now(), revoked_reason = 'TEST FIXTURE: the owner withdrew it'
 where authorization_id = 'OWNER-AUTH-2026-09-21-76';
set local role anon;
select is((select count(*) from evidence_public.poll_figures where value_pct is not null), 0::bigint, 'revoked: no figure survives');
select is((select count(*) from evidence_public.poll_figures
            where methodology_status = 'unresolved' and poll_document_id in
            (select d.id from evidence_open.documents d join evidence_open.source_records r on r.id = d.source_record_id
              where r.source_id = 'pgtap_pf_polls')), 2::bigint,
  'revoked: the label is still on both rows, because it never depended on a decision');
select is((select count(*) from evidence_public.surface_status where owner_figure_scopes <> '{}'), 0::bigint,
  'revoked: surface_status stops naming any figure scope');
select throws_ok($$update evidence_public.poll_figures set value_pct = 1$$, null, null, 'anon: a poll figure cannot be written');
reset role;
select is((select count(*) from evidence_private.source_rights where review_status <> 'pending'), 1::bigint,
  'no rights row was approved by any of this: the only non-pending row is the one this test restricted itself');

select * from finish();
rollback;
