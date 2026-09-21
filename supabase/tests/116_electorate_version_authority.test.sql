-- A shared electorate version cites the same source version whichever order the sources are loaded in, and no source
-- loses its lineage for having arrived second. Both insert orders are run here, in one transaction, and compared.
-- TEST FIXTURES ONLY: invented electorates, sources and dates, rolled back.
begin;
select plan(12);

grant evidence_ingest to current_user;
create temp table seen (k text primary key, v text);
grant all on seen to evidence_ingest;

select evidence_private.sync_registry(jsonb_build_object('sources', jsonb_build_array(
  -- Two publishers that both name the same electorate. The one that sorts LATER by source id states the EARLIER date,
  -- so a rule that read the source id alone and a rule that reads the publisher's date cannot be confused here.
  jsonb_build_object('source_id', 'pgtap_auth_early_dated', 'title', 'Fixture results export', 'publisher', 'Fixture Publisher',
    'official_url', 'https://fixture.example/results', 'adapter_kind', 'export_import', 'adapter_name', 'fixture',
    'allowed_hosts', jsonb_build_array(), 'view_scope', 'baseline_2023', 'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'a1'),
  jsonb_build_object('source_id', 'pgtap_auth_bare', 'title', 'Fixture roster export', 'publisher', 'Fixture Publisher',
    'official_url', 'https://fixture.example/roster', 'adapter_kind', 'export_import', 'adapter_name', 'fixture',
    'allowed_hosts', jsonb_build_array(), 'view_scope', 'baseline_2023', 'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'a2'))));

-- One version per source, through the ledger, so each has a real record, content hash and publisher date.
create function pg_temp.version_of(p_source text, p_id text, p_hash char, p_published text) returns uuid language plpgsql as $$
declare v_holder uuid := gen_random_uuid(); v_run uuid; v_version uuid;
begin
  perform evidence_private.acquire_lease(p_source, v_holder, 120);
  v_run := (evidence_private.start_run(p_source, v_holder, 'v1', 'export_import', 'test', 'm-' || p_id) ->> 'run_id')::uuid;
  perform evidence_private.ingest_batch(v_run, v_holder, jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
    'external_record_id', p_id, 'record_kind', 'baseline_2023_candidacy', 'content_hash', 'sha256:' || repeat(p_hash, 64),
    'source_url', 'https://fixture.example/item/' || p_id, 'source_published_at', p_published, 'retrieved_at', now(),
    'safe_payload', jsonb_build_object('candidate_name', 'FIXTURE, Alex', 'candidacy_type', 'electorate',
      'electorate_name', 'Fixture Electorate', 'nomination_status', 'officially_nominated')))));
  perform evidence_private.finish_run(v_run, v_holder, 'succeeded', false, null, null, null);
  select v.id into v_version from evidence_private.source_record_versions v
    join evidence_private.source_records r on r.id = v.record_id
   where r.source_id = p_source and r.external_record_id = p_id;
  return v_version;
end $$;

create function pg_temp.electorate(p_slug text) returns uuid language sql as $$
  select id from evidence_private.electorates where slug = p_slug $$;

set local role evidence_ingest;
do $$
declare
  v_early uuid;   -- publisher date 2023-01-01, source id sorts SECOND
  v_bare uuid;    -- no publisher date, source id sorts FIRST
  v_edition uuid;
  v_electorate_one uuid;
  v_electorate_two uuid;
  v_cited uuid;
begin
  v_early := pg_temp.version_of('pgtap_auth_early_dated', 'early-1', '1', '2023-01-01T00:00:00Z');
  v_bare := pg_temp.version_of('pgtap_auth_bare', 'bare-1', '2', null);

  insert into evidence_private.boundary_editions (slug, title, verified, basis_note)
  values ('pgtap-auth-edition', 'Fixture boundary edition', false, 'fixture')
  on conflict (slug) do update set slug = excluded.slug returning id into v_edition;
  insert into evidence_private.electorates (slug, canonical_name) values ('pgtap-auth-one', 'Fixture One')
  on conflict (slug) do update set slug = excluded.slug returning id into v_electorate_one;
  insert into evidence_private.electorates (slug, canonical_name) values ('pgtap-auth-two', 'Fixture Two')
  on conflict (slug) do update set slug = excluded.slug returning id into v_electorate_two;

  -- ELECTORATE ONE: the bare-dated source arrives first, the early-dated source second.
  insert into evidence_private.electorate_versions (electorate_id, boundary_edition_id, name, electorate_type, evidence_version_id)
  values (v_electorate_one, v_edition, 'Fixture One', 'unverified', v_bare);
  -- The promotion is a DEFERRED constraint trigger, so in production it runs when the write's transaction commits (every
  -- write here is one autocommit statement). A test never commits, so each stage flushes the pending events the way a
  -- commit would and then restores deferred mode: leaving them IMMEDIATE would make the next insert promote inside its
  -- own statement, which is exactly what a projection's `on conflict do update` may not do.
  set constraints all immediate; set constraints all deferred;
  insert into seen values ('one_after_first', (select (evidence_version_id = v_bare)::text from evidence_private.electorate_versions
    where electorate_id = v_electorate_one and boundary_edition_id = v_edition));
  insert into evidence_private.electorate_versions (electorate_id, boundary_edition_id, name, electorate_type, evidence_version_id)
  values (v_electorate_one, v_edition, 'Fixture One', 'unverified', v_early)
  on conflict (electorate_id, boundary_edition_id) do update set name = excluded.name;   -- the real projections' shape
  set constraints all immediate; set constraints all deferred;
  select evidence_version_id into v_cited from evidence_private.electorate_versions
   where electorate_id = v_electorate_one and boundary_edition_id = v_edition;
  insert into seen values ('one_cites_early', (v_cited = v_early)::text),
    ('one_attestations', (select count(*)::text from evidence_private.electorate_version_attestations
       where electorate_id = v_electorate_one and boundary_edition_id = v_edition));

  -- ELECTORATE TWO: the same two sources, the other way round.
  insert into evidence_private.electorate_versions (electorate_id, boundary_edition_id, name, electorate_type, evidence_version_id)
  values (v_electorate_two, v_edition, 'Fixture Two', 'unverified', v_early);
  insert into evidence_private.electorate_versions (electorate_id, boundary_edition_id, name, electorate_type, evidence_version_id)
  values (v_electorate_two, v_edition, 'Fixture Two', 'unverified', v_bare)
  on conflict (electorate_id, boundary_edition_id) do update set name = excluded.name;
  set constraints all immediate; set constraints all deferred;
  select evidence_version_id into v_cited from evidence_private.electorate_versions
   where electorate_id = v_electorate_two and boundary_edition_id = v_edition;
  insert into seen values ('two_cites_early', (v_cited = v_early)::text),
    ('two_attestations', (select count(*)::text from evidence_private.electorate_version_attestations
       where electorate_id = v_electorate_two and boundary_edition_id = v_edition));

  -- A third assertion of a version already recorded changes nothing at all.
  insert into evidence_private.electorate_versions (electorate_id, boundary_edition_id, name, electorate_type, evidence_version_id)
  values (v_electorate_two, v_edition, 'Fixture Two', 'unverified', v_bare)
  on conflict (electorate_id, boundary_edition_id) do update set name = excluded.name;
  set constraints all immediate; set constraints all deferred;
  insert into seen values ('two_attestations_after_replay', (select count(*)::text from evidence_private.electorate_version_attestations
    where electorate_id = v_electorate_two and boundary_edition_id = v_edition));

  -- The worker may record an assertion but may not erase one, and may not rewrite one either.
  begin
    delete from evidence_private.electorate_version_attestations where electorate_id = v_electorate_two;
    insert into seen values ('delete', 'allowed');
  exception when others then insert into seen values ('delete', sqlstate);
  end;
  begin
    update evidence_private.electorate_version_attestations set evidence_version_id = v_early where electorate_id = v_electorate_two;
    insert into seen values ('update', 'allowed');
  exception when others then insert into seen values ('update', sqlstate);
  end;
end
$$;
reset role;

select is((select v from seen where k = 'one_after_first'), 'true', 'the first source to assert an electorate version is the one it cites while it is the only one');
select is((select v from seen where k = 'one_cites_early'), 'true', 'a later source with an earlier publisher date takes the citation from the source that arrived first');
select is((select v from seen where k = 'two_cites_early'), 'true', 'and the same two sources in the opposite order reach the same answer');
select is((select v from seen where k = 'one_attestations'), '2', 'both assertions are kept when the earlier-dated source arrives second');
select is((select v from seen where k = 'two_attestations'), '2', 'and when it arrives first: no source loses its lineage for arriving second');
select is((select v from seen where k = 'two_attestations_after_replay'), '2', 'asserting the same version again records nothing new');
select is((select v from seen where k = 'delete'), '42501', 'the worker cannot erase an assertion');
select is((select v from seen where k = 'update'), '42501', 'nor rewrite one');
-- The citation is always one of the recorded assertions, and always the one the rule names.
select is((select count(*)::int from evidence_private.electorate_versions ev
            where ev.evidence_version_id is not null
              and not exists (select 1 from evidence_private.electorate_version_attestations a
                               where a.electorate_id = ev.electorate_id and a.boundary_edition_id = ev.boundary_edition_id
                                 and a.evidence_version_id = ev.evidence_version_id)), 0,
  'every electorate version cites a version that is recorded as having asserted it');
select is((select count(*)::int from evidence_private.electorate_versions ev
            where ev.evidence_version_id is distinct from evidence_private.authoritative_electorate_version(ev.electorate_id, ev.boundary_edition_id)), 0,
  'and every one of them cites exactly what the rule names');
-- The rule reads publisher data only: no surrogate key, no collection time, nothing about the run.
select isnt((select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'evidence_private' and p.proname = 'authoritative_electorate_version'), null, 'the rule is one function');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'evidence_private'
              and p.proname in ('authoritative_electorate_version', 'record_electorate_version_attestation', 'promote_authoritative_electorate_version')
              and (p.prosecdef or p.proconfig is null)), 0,
  'none of the three functions runs as its owner, and each pins its search_path');

select * from finish();
rollback;
