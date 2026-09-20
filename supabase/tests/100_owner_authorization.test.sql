-- Owner authorization: a narrow, audited override that is never a review and never a publisher approval.
-- Narrow override versus absent authorization; private denial; rights stay independent; immutability; roles.
-- TEST FIXTURES ONLY: synthetic, rolled back. Rights ids RIGHTS-78x are distinct from every other fixture.
begin;
select plan(47);
grant evidence_ingest to current_user;

-- Isolation: these assertions are about the recorded reviews and rights alone, so any owner decision already in this
-- (disposable) database is set aside for the length of this transaction. Rolled back with everything else.
update evidence_private.owner_authorizations set revoked_at = now(), revoked_reason = 'pgTAP isolation; rolled back' where revoked_at is null;
update evidence_private.release_gates set state = 'closed', evidence_reference = null, decided_by = null, decided_at = null;

create function pg_temp.seed(p_source text, p_prefix text) returns void language plpgsql as $$
declare
  v_holder uuid := '78787878-7878-7878-7878-787878787878';
  v_run uuid;
begin
  perform evidence_private.acquire_lease(p_source, v_holder, 60);
  v_run := (evidence_private.start_run(p_source, v_holder, 'v1', 'incremental', 'test', 'm') ->> 'run_id')::uuid;
  perform evidence_private.ingest_batch(v_run, v_holder, jsonb_build_array(
    jsonb_build_object('external_record_id', p_prefix || '-member', 'record_kind', 'mp_directory_entry',
      'content_hash', 'sha256:' || repeat('1', 64), 'source_url', 'https://fixture.example/' || p_prefix || '/member',
      'retrieved_at', now(),
      'safe_payload', jsonb_build_object('name_display', 'FIXTURE ' || p_prefix || ' Member', 'party_label', 'FIXTURE ' || p_prefix || ' Party',
        'representation', 'electorate', 'electorate_label', 'FIXTURE ' || p_prefix || ' Electorate')),
    jsonb_build_object('external_record_id', p_prefix || '-bill', 'record_kind', 'bill',
      'content_hash', 'sha256:' || repeat('2', 64), 'source_url', 'https://fixture.example/' || p_prefix || '/bill',
      'retrieved_at', now(), 'safe_payload', jsonb_build_object('title', 'FIXTURE ' || p_prefix || ' Bill', 'bill_number', 'S-1',
        'public_page_url', 'https://fixture.example/' || p_prefix || '/bill'))));
  perform evidence_private.project_run(v_run, v_holder);
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', false, 'wm', null, null);
end
$$;

create function pg_temp.src(p_id text, p_rights text) returns jsonb language sql as $$
  select jsonb_build_object('source_id', p_id, 'title', 'Fixture ' || p_id, 'publisher', 'Fixture Publisher',
    'official_url', 'https://fixture.example/' || p_id, 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture', 'access_basis', 'public_page',
    'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', p_rights, 'view_scope', 'general',
    'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'c');
$$;

create function pg_temp.auth(p_id text, p_from date, p_to date, p_scopes jsonb, p_status text default 'active') returns jsonb language sql as $$
  select jsonb_build_object('schema_version', 1, 'authorizations', jsonb_build_array(jsonb_build_object(
    'authorization_id', p_id, 'status', p_status, 'decided_on', p_from, 'expires_on', p_to,
    'decided_by', 'Fixture Owner Name', 'decided_by_role', 'repository owner',
    'request_source', 'TEST FIXTURE: owner request over a messaging app, relayed by the coordinator',
    'statement', 'TEST FIXTURE: the owner authorizes release of rows and listed fields ahead of the reviews.',
    'revoked_reason', 'TEST FIXTURE: the owner withdrew the decision',
    'not_claimed', jsonb_build_array('no R10 review exists', 'nobody accepted the R8 role', 'no publisher licence is claimed'),
    'scopes', p_scopes)));
$$;
create function pg_temp.fields(p_source text, p_rights text, p_fields text[]) returns jsonb language sql as $$
  select jsonb_build_object('scope', 'source_fields', 'source_id', p_source, 'rights_id', p_rights, 'fields', to_jsonb(p_fields),
    'basis', 'TEST FIXTURE: name and party as the publisher lists them, shown with the official link.');
$$;
create function pg_temp.hash() returns text language sql as $$ select 'sha256:' || repeat('a', 64) $$;

select evidence_private.sync_registry(jsonb_build_object(
  'rights', jsonb_build_array(
    jsonb_build_object('rights_id', 'RIGHTS-781', 'publisher', 'Fixture', 'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h'),
    jsonb_build_object('rights_id', 'RIGHTS-782', 'publisher', 'Fixture', 'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h'),
    jsonb_build_object('rights_id', 'RIGHTS-783', 'publisher', 'Fixture', 'source_url', 'https://fixture.example/', 'review_status', 'refused', 'default_release', 'withheld', 'reviewed_on', '2026-09-20', 'register_hash', 'h')),
  'sources', jsonb_build_array(pg_temp.src('pgtap_own', 'RIGHTS-781'), pg_temp.src('pgtap_other', 'RIGHTS-782'), pg_temp.src('pgtap_no', 'RIGHTS-783'))));
select pg_temp.seed('pgtap_own', 'own');
select pg_temp.seed('pgtap_other', 'other');
select pg_temp.seed('pgtap_no', 'no');

create temp table rights_before as select rights_id, review_status, default_release, approved_fields, reviewed_on from evidence_private.source_rights;
create temp table gates_before as select * from evidence_private.release_gates;
grant select on rights_before, gates_before to anon;

-- 1. ABSENT authorization: nothing is released -------------------------------------------------------------------
select is((select count(*) from evidence_private.release_gates where state = 'open'), 0::bigint, 'fixture premise: every release gate is closed');
set local role anon;
select is((select count(*) from evidence_public.records), 0::bigint, 'no authorization and closed gates: anonymous readers get no rows');
select is((select string_agg(distinct release_basis, ',') from evidence_public.surface_status), 'none', 'surface_status reports no release basis');
select is((select count(*) from evidence_public.surface_status where public_rows_released), 0::bigint, 'and no rows released');
reset role;

-- a decision that has LAPSED releases nothing
select evidence_private.sync_owner_authorizations(pg_temp.auth('OWNER-AUTH-2026-01-01-01', current_date - 30, current_date - 1,
  jsonb_build_array(jsonb_build_object('scope', 'public_rows', 'surface_id', 'evidence-store'),
                    pg_temp.fields('pgtap_own', 'RIGHTS-781', array['name_at_source']))), pg_temp.hash());
set local role anon;
select is((select count(*) from evidence_public.records), 0::bigint, 'a lapsed owner decision releases no rows');
reset role;
select is((select owner_fields from evidence_private.source_release where source_id = 'pgtap_own'), '{}'::text[], 'and no fields');

-- a decision for the Pages deployment ONLY does not release database rows
select evidence_private.sync_owner_authorizations(pg_temp.auth('OWNER-AUTH-2026-01-01-02', current_date, current_date + 30,
  jsonb_build_array(jsonb_build_object('scope', 'pages_deploy', 'surface_id', 'explorer-pages'))), pg_temp.hash());
set local role anon;
select is((select count(*) from evidence_public.records), 0::bigint, 'a pages_deploy decision alone releases no database rows: scopes do not imply each other');
reset role;

-- 2. NARROW override ---------------------------------------------------------------------------------------------
select is(evidence_private.sync_owner_authorizations(pg_temp.auth('OWNER-AUTH-2026-01-01-03', current_date, current_date + 30,
  jsonb_build_array(jsonb_build_object('scope', 'public_rows', 'surface_id', 'evidence-store'),
                    pg_temp.fields('pgtap_own', 'RIGHTS-781', array['label', 'name_at_source', 'member_name', 'party_label', 'name_display', 'title']))), pg_temp.hash()),
  '{"recorded": 1, "revoked": 0, "unchanged": 0}'::jsonb, 'the owner decision is recorded');
select is(evidence_private.sync_owner_authorizations(pg_temp.auth('OWNER-AUTH-2026-01-01-03', current_date, current_date + 30,
  jsonb_build_array(jsonb_build_object('scope', 'public_rows', 'surface_id', 'evidence-store'))), pg_temp.hash()),
  '{"recorded": 0, "revoked": 0, "unchanged": 1}'::jsonb, 'syncing again changes nothing, even if the file was edited: a decision is never rewritten');

select is((select count(*) from evidence_private.release_gates g join gates_before b using (gate_key) where g.state = b.state and g.state = 'closed'
           and g.decided_by is null and g.evidence_reference is null), 3::bigint, 'NO release gate was opened or given an evidence reference by the owner decision');
select is((select count(*) from evidence_private.source_rights r join rights_before b using (rights_id)
           where (r.review_status, r.default_release, r.approved_fields, r.reviewed_on) is distinct from (b.review_status, b.default_release, b.approved_fields, b.reviewed_on)),
  0::bigint, 'NO rights row was changed: nothing is marked approved, dated or given fields');
select is((select string_agg(source_id || '=' || tier, ',' order by source_id) from evidence_private.source_release where source_id like 'pgtap_%'),
  'pgtap_no=none,pgtap_other=link_only,pgtap_own=link_only', 'release tiers still come from the rights rows alone');

set local role anon;
select is((select string_agg(distinct release_basis, ',') from evidence_public.surface_status), 'owner_override', 'surface_status names the basis: owner_override, not recorded reviews');
select is((select count(*) from evidence_public.surface_status where state = 'open'), 0::bigint, 'while every gate still reads closed to the public');
select is((select string_agg(distinct owner_authorization_id, ',') from evidence_public.surface_status), 'OWNER-AUTH-2026-01-01-03', 'and points at the decision');
select ok((select count(*) = 2 from evidence_public.records where source_id = 'pgtap_own'), 'rows of the pending source are released');
select is((select count(*) from evidence_public.records where source_id = 'pgtap_no'), 0::bigint, 'a source whose publisher REFUSED stays invisible: rights are independent of the owner');

-- fields: only the named ones, only for the named source
select is((select name_at_source from evidence_public.person_identities where source_id = 'pgtap_own'), 'FIXTURE own Member', 'a named field of the named source is shown');
select is((select party_label from evidence_public.service_terms where source_id = 'pgtap_own'), 'FIXTURE own Party', 'party label shown');
select is((select electorate_name_at_source from evidence_public.service_terms where source_id = 'pgtap_own'), null, 'a field the decision does not name stays blank');
select is((select external_id from evidence_public.person_identities where source_id = 'pgtap_own'), null, 'publisher identifiers stay blank');
select is((select safe_payload from evidence_public.record_versions where source_id = 'pgtap_own' and record_kind = 'mp_directory_entry'),
  '{"name_display": "FIXTURE own Member", "party_label": "FIXTURE own Party"}'::jsonb, 'the payload is filtered key by key: there is no general payload release');
select is((select title from evidence_public.documents where source_id = 'pgtap_own'), 'FIXTURE own Bill', 'bill title shown');
select is((select bill_number from evidence_public.documents where source_id = 'pgtap_own'), null, 'bill number not named, so blank');
select is((select count(*) from evidence_public.person_identities where source_id = 'pgtap_other' and name_at_source is not null), 0::bigint, 'the OTHER pending source gets no fields: a decision is per source');
select is((select count(*) from evidence_public.record_versions where source_id = 'pgtap_other' and safe_payload is not null), 0::bigint, 'and no payload');
select is((select owner_authorized_fields from evidence_public.sources where source_id = 'pgtap_own'),
  array['label', 'member_name', 'name_at_source', 'name_display', 'party_label', 'title'], 'the sources view says which fields rest on the owner decision');
select is((select rights_review_status || '/' || public_release_tier from evidence_public.sources where source_id = 'pgtap_own'), 'pending/link_only', 'beside a rights status that still says pending, link only');
select is((select count(*) from evidence_open.owner_authorizations where authorization_id = 'OWNER-AUTH-2026-01-01-03' and request_source like 'TEST FIXTURE: owner request%'),
  1::bigint, 'the decision, its dates and where the request came from are public');
select is((select count(*) from evidence_public.dataset_columns where dataset = 'owner_authorizations' and column_name = 'decided_by' and disposition = 'withheld'), 1::bigint,
  'the individual name is withheld like every other per-row name (R7)');
select throws_ok($$select * from evidence_private.owner_authorizations$$, '42501', null, 'anonymous readers cannot read the private table');
select throws_ok($$select evidence_private.sync_owner_authorizations('{}'::jsonb, 'x')$$, '42501', null, 'or record a decision');
reset role;

-- 3. PRIVATE denial: what no owner decision can release ---------------------------------------------------------------
select throws_ok(format($$select evidence_private.sync_owner_authorizations(%L::jsonb, pg_temp.hash())$$, pg_temp.auth('OWNER-AUTH-2026-01-02-01', current_date, current_date + 30,
  jsonb_build_array(pg_temp.fields('pgtap_own', 'RIGHTS-781', array['contact_email'])))), '23514', null, 'contact data can never be named');
select throws_ok(format($$select evidence_private.sync_owner_authorizations(%L::jsonb, pg_temp.hash())$$, pg_temp.auth('OWNER-AUTH-2026-01-02-02', current_date, current_date + 30,
  jsonb_build_array(pg_temp.fields('pgtap_own', 'RIGHTS-781', array['safe_payload'])))), '23514', null, 'nor the whole payload');
select throws_ok(format($$select evidence_private.sync_owner_authorizations(%L::jsonb, pg_temp.hash())$$, pg_temp.auth('OWNER-AUTH-2026-01-02-03', current_date, current_date + 30,
  jsonb_build_array(pg_temp.fields('pgtap_own', 'RIGHTS-781', array['release_text'])))), '23514', null, 'nor a body');
select throws_ok(format($$select evidence_private.sync_owner_authorizations(%L::jsonb, pg_temp.hash())$$, pg_temp.auth('OWNER-AUTH-2026-01-02-04', current_date, current_date + 30,
  jsonb_build_array(pg_temp.fields('pgtap_own', 'RIGHTS-781', array['votes'])))), '23514', null, 'nor vote figures');
select throws_ok(format($$select evidence_private.sync_owner_authorizations(%L::jsonb, pg_temp.hash())$$, pg_temp.auth('OWNER-AUTH-2026-01-02-05', current_date, current_date + 30,
  jsonb_build_array(pg_temp.fields('pgtap_own', 'RIGHTS-781', array['*'])))), '23514', null, 'there is no wildcard');
select throws_ok(format($$select evidence_private.sync_owner_authorizations(%L::jsonb, pg_temp.hash())$$, pg_temp.auth('OWNER-AUTH-2026-01-02-06', current_date, current_date + 30,
  jsonb_build_array(pg_temp.fields('pgtap_no', 'RIGHTS-783', array['name_at_source'])))), 'P0001', null, 'a field decision against a REFUSED rights row is rejected outright');
select throws_ok(format($$select evidence_private.sync_owner_authorizations(%L::jsonb, pg_temp.hash())$$, pg_temp.auth('OWNER-AUTH-2026-01-02-07', current_date, current_date + 30,
  jsonb_build_array(pg_temp.fields('pgtap_own', 'RIGHTS-782', array['name_at_source'])))), 'P0001', null, 'a field decision must name the source''s real rights row');
select throws_ok(format($$select evidence_private.sync_owner_authorizations(%L::jsonb, pg_temp.hash())$$, pg_temp.auth('OWNER-AUTH-2026-01-02-08', current_date, current_date + 91,
  jsonb_build_array(jsonb_build_object('scope', 'public_rows', 'surface_id', 'evidence-store')))), '23514', null, 'a decision in force for more than 90 days is refused');
select throws_ok(format($$select evidence_private.sync_owner_authorizations(%L::jsonb, pg_temp.hash())$$, pg_temp.auth('OWNER-AUTH-2026-01-02-09', current_date, current_date + 30,
  jsonb_build_array(jsonb_build_object('scope', 'public_rows', 'surface_id', 'evidence-atlas')))), '23514', null, 'and so is any surface other than the two it is defined for');

-- the ingest worker holds nothing here (the worker role cannot call the test functions, so outcomes go through a table)
create temp table outcome (name text primary key, state text);
grant all on outcome to evidence_ingest;
set local role evidence_ingest;
do $$
begin
  begin
    insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, surface_id) values ('OWNER-AUTH-2026-01-01-02', 'public_rows', 'evidence-store');
    insert into outcome values ('widen', 'allowed');
  exception when insufficient_privilege then insert into outcome values ('widen', 'denied');
  end;
  begin
    perform evidence_private.sync_owner_authorizations('{}'::jsonb, 'x');
    insert into outcome values ('record', 'allowed');
  exception when insufficient_privilege then insert into outcome values ('record', 'denied');
  end;
end
$$;
reset role;
select is((select state from outcome where name = 'widen'), 'denied', 'the ingest worker cannot widen an owner decision');
select is((select state from outcome where name = 'record'), 'denied', 'or record one');

-- 4. Audited: never edited, never deleted; revocation is immediate; a publisher restriction always wins -------------------
select throws_ok($$update evidence_private.owner_authorizations set expires_on = expires_on + 30 where authorization_id = 'OWNER-AUTH-2026-01-01-03'$$, 'P0001', null, 'a decision cannot be extended by editing it');
select throws_ok($$delete from evidence_private.owner_authorization_scopes where authorization_id = 'OWNER-AUTH-2026-01-01-03'$$, 'P0001', null, 'scopes are append-only');

update evidence_private.source_rights set review_status = 'restricted', reviewed_on = current_date where rights_id = 'RIGHTS-781';
set local role anon;
select is((select count(*) from evidence_public.records where source_id = 'pgtap_own'), 0::bigint, 'when the publisher''s rights row turns restricted, the owner decision shows nothing of that source');
reset role;

select evidence_private.sync_owner_authorizations(pg_temp.auth('OWNER-AUTH-2026-01-01-03', current_date, current_date + 30, '[]'::jsonb, 'revoked'), pg_temp.hash());
set local role anon;
select is((select count(*)::text || '/' || (select string_agg(distinct release_basis, ',') from evidence_public.surface_status) from evidence_public.records), '0/none',
  'revoking the decision withholds every row again at once, with no deployment');
reset role;

select * from finish();
rollback;
