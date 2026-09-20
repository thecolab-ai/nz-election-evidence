-- PR 8 review items that live in the database: R9 confidence and model provenance, human-agreement studies as a
-- thing apart from per-output review, withheld-table sizes, and the premises that make FORCE ROW LEVEL SECURITY moot.
-- TEST FIXTURES ONLY: synthetic, rolled back.
begin;
select plan(30);

-- R9 (review 10): confidence on summaries --------------------------------------------------------------------
insert into evidence_private.model_runs (id, metadata_status, provider, model_name, model_version, prompt_or_schema_version)
values ('a9000000-0000-0000-0000-000000000001', 'recorded', 'TEST FIXTURE provider', 'fixture-model', '1.0', 'fixture-schema-v1'),
       ('a9000000-0000-0000-0000-000000000002', 'recorded', 'TEST FIXTURE provider', 'fixture-model', '1.0', 'fixture-schema-v2');
create function pg_temp.summary(p_id uuid, p_conf numeric, p_status text, p_basis text, p_run uuid default 'a9000000-0000-0000-0000-000000000001')
returns text language sql as $f$
  select format($$insert into evidence_private.summary_versions (id, model_run_id, summary_text, output_hash, confidence, confidence_status, confidence_basis)
    values (%L, %L, 'TEST FIXTURE summary', 'sha256:%s', %L, %L, %L)$$, p_id, p_run, repeat('9', 64), p_conf, p_status, p_basis)
$f$;
insert into evidence_private.summary_versions (id, model_run_id, summary_text, output_hash)
values ('b9000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000001', 'TEST FIXTURE summary', 'sha256:' || repeat('9', 64));
select is((select confidence_status || ':' || coalesce(confidence::text, 'null') from evidence_private.summary_versions where id = 'b9000000-0000-0000-0000-000000000001'),
  'not_reported:null', 'with nothing said, confidence is NOT REPORTED and the value is null - never 0, never a default number');
select throws_ok(pg_temp.summary('b9000000-0000-0000-0000-000000000002', null, 'reported', 'self-reported 0-1'), '23514', null, '"reported" without a value is refused');
select throws_ok(pg_temp.summary('b9000000-0000-0000-0000-000000000002', 0.5, 'not_reported', null), '23514', null, 'a value without "reported" is refused: no number rides along with unknown');
select throws_ok(pg_temp.summary('b9000000-0000-0000-0000-000000000002', 0.5, 'reported', null), '23514', null, 'a reported value must say what the number is');
select throws_ok(pg_temp.summary('b9000000-0000-0000-0000-000000000002', 1.5, 'reported', 'self-reported 0-1'), '23514', null, 'a value outside 0-1 is refused');
select lives_ok(pg_temp.summary('b9000000-0000-0000-0000-000000000002', 0, 'reported', 'self-reported 0-1'), 'a reported 0 is kept as 0');
select lives_ok(pg_temp.summary('b9000000-0000-0000-0000-000000000003', null, 'not_applicable', null, 'a9000000-0000-0000-0000-000000000002'), 'a schema with no notion of confidence says so');
select is((select string_agg(confidence_status || ':' || coalesce(confidence::text, 'null'), ' ' order by id) from evidence_private.summary_versions where id::text like 'b9000000%'),
  'not_reported:null reported:0 not_applicable:null', 'unknown, zero and not-applicable stay three different things');
select throws_ok($$update evidence_private.summary_versions set confidence = 0.99, confidence_status = 'reported', confidence_basis = 'edited later' where id = 'b9000000-0000-0000-0000-000000000001'$$,
  'P0001', null, 'confidence is part of the immutable output: nobody fills one in afterwards');

-- R9: a human-agreement study is about a schema version, not about one output --------------------------------
select is((select string_agg(schema_agreement_documented::text, ',' order by id) from evidence_views.summaries where id::text like 'b9000000%'), 'false,false,false',
  'no study on record: every output is flagged as not yet checked against human review');
insert into evidence_private.review_decisions (subject_kind, subject_id, subject_hash, decision, reviewer, rubric_version)
values ('summary_version', 'b9000000-0000-0000-0000-000000000001', 'sha256:' || repeat('9', 64), 'approved', 'TEST FIXTURE reviewer', 'r1');
update evidence_private.summary_versions set review_status = 'approved' where id = 'b9000000-0000-0000-0000-000000000001';
select is((select schema_agreement_documented from evidence_views.summaries where id = 'b9000000-0000-0000-0000-000000000001'), false,
  'approving ONE output does not document an agreement rate for its schema');
select throws_ok($$insert into evidence_private.schema_agreement_validations (prompt_or_schema_version, output_kind, sample_size, agreements, method_url, validated_by)
  values ('fixture-schema-v1', 'summary', 10, 11, 'https://fixture.example/method', 'TEST FIXTURE')$$, '23514', null, 'more agreements than samples is refused');
insert into evidence_private.schema_agreement_validations (prompt_or_schema_version, output_kind, sample_size, agreements, method_url, validated_by)
values ('fixture-schema-v1', 'summary', 40, 34, 'https://fixture.example/method', 'TEST FIXTURE validator');
select is((select string_agg(schema_agreement_documented::text || ':' || coalesce(schema_agreement_rate::text, '-') || ':' || coalesce(schema_agreement_sample::text, '-'), ' ' order by id)
           from evidence_views.summaries where id::text like 'b9000000%'), 'true:0.8500:40 true:0.8500:40 false:-:-',
  'the study covers every output of THAT schema version and no other; the rate is computed, not typed');
select is((select review_status from evidence_private.summary_versions where id = 'b9000000-0000-0000-0000-000000000002'), 'unreviewed',
  'and a study approves no individual output');
select throws_ok($$update evidence_private.schema_agreement_validations set agreements = 40$$, 'P0001', null, 'agreement studies are append-only');

-- R9 (review 11): a model-made policy class always names its run ------------------------------------------------
select evidence_private.sync_registry(jsonb_build_object('rights', jsonb_build_array(jsonb_build_object('rights_id', 'RIGHTS-96', 'publisher', 'Fixture Publisher',
    'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h1')),
  'sources', jsonb_build_array(jsonb_build_object('source_id', 'pgtap_policy', 'title', 'Fixture policy pages', 'publisher', 'Fixture Publisher',
    'official_url', 'https://fixture.example/policy', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture', 'access_basis', 'public_page',
    'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-96', 'view_scope', 'general', 'snapshot_semantics', 'append_only_feed',
    'enabled', false, 'config_hash', 'c'))));
insert into evidence_private.source_records (id, source_id, external_record_id, record_kind, first_seen_at, last_seen_at)
select ('c9000000-0000-0000-0000-00000000000' || n)::uuid, 'pgtap_policy', 'policy-' || n, 'policy_source', now(), now() from generate_series(1, 4) n;
insert into evidence_private.documents (id, source_record_id, document_type, official_url, view_scope)
select ('d9000000-0000-0000-0000-00000000000' || n)::uuid, ('c9000000-0000-0000-0000-00000000000' || n)::uuid, 'policy_source', 'https://fixture.example/policy/' || n, 'general'
from generate_series(1, 4) n;
select throws_ok($$insert into evidence_private.policy_sources (document_id, policy_class, classification_basis, confidence_status)
  values ('d9000000-0000-0000-0000-000000000001', 'manifesto', 'unreviewed_model', 'not_reported')$$, '23514', null, 'a model classification without its model run is refused');
select throws_ok($$insert into evidence_private.policy_sources (document_id, policy_class, classification_basis, model_run_id)
  values ('d9000000-0000-0000-0000-000000000001', 'manifesto', 'publisher_label', 'a9000000-0000-0000-0000-000000000001')$$, '23514', null, 'a publisher label cannot borrow a model run');
select throws_ok($$insert into evidence_private.policy_sources (document_id, policy_class, classification_basis, model_run_id)
  values ('d9000000-0000-0000-0000-000000000001', 'manifesto', 'unreviewed_model', 'a9000000-0000-0000-0000-000000000001')$$, '23514', null,
  'a model classification must say whether the run reported a confidence (not_applicable is for non-model labels)');
select lives_ok($$insert into evidence_private.policy_sources (document_id, policy_class, classification_basis, model_run_id, confidence_status)
  values ('d9000000-0000-0000-0000-000000000001', 'manifesto', 'unreviewed_model', 'a9000000-0000-0000-0000-000000000001', 'not_reported')$$,
  'historical model classifications load with their run and an honest "not reported"');
select lives_ok($$insert into evidence_private.policy_sources (document_id, policy_class, classification_basis)
  values ('d9000000-0000-0000-0000-000000000002', 'hub', 'publisher_label')$$, 'a non-model label needs no run');
select is((select string_agg(classification_basis || '/' || coalesce(model_name, '-') || '/' || coalesce(prompt_or_schema_version, '-') || '/' || confidence_status || '/' || schema_agreement_documented, ' ' order by document_id)
           from evidence_views.policy_classifications where document_id::text like 'd9000000%'),
  'unreviewed_model/fixture-model/fixture-schema-v1/not_reported/false publisher_label/-/-/not_applicable/false',
  'the view labels a model class with model, schema version and confidence state; a summary study does not vouch for a classification schema');
select is((select count(*)::int from evidence_private.public_columns
            where object_name in ('policy_classifications', 'policy_sources', 'summaries')
              and column_name in ('classification_basis', 'model_name', 'model_version', 'prompt_or_schema_version', 'confidence_status', 'schema_agreement_documented')
              and release_class <> 'link'), 0, 'R9 labels are unconditional columns: no rights row can release a class while hiding its model label');
select is((select release_class from evidence_private.public_columns where object_schema = 'evidence_views' and object_name = 'policy_classifications' and column_name = 'policy_class'),
  'content', 'the class itself stays rights-gated content');

-- review 13: no size for a withheld table ---------------------------------------------------------------------------
analyze evidence_private.app_memberships;
analyze evidence_private.source_rights;
set local role anon;
select is((select count(*)::int from evidence_public.dataset_catalogue where disposition = 'withheld' and approximate_rows is not null), 0,
  'review 13: an anonymous reader is given no row count for any withheld table');
select ok((select count(*) from evidence_public.dataset_catalogue where disposition = 'withheld' and dataset = 'app_memberships') = 1,
  'the withheld table is still LISTED with its reason: nothing is silently omitted');
select ok((select approximate_rows is not null from evidence_public.dataset_catalogue where dataset = 'source_rights' and exposed_schema = 'evidence_open'),
  'published tables keep their approximate size');
reset role;

-- FORCE ROW LEVEL SECURITY: evaluated, not added. It only changes anything for a table OWNER without BYPASSRLS. -----
-- These are the premises that make it moot; if one stops holding, this test fails and the decision is revisited.
select is((select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'evidence_private' and c.relkind = 'r' and not c.relrowsecurity), null, 'every private table has row level security enabled');
select is((select string_agg(distinct pg_get_userbyid(c.relowner), ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('evidence_private', 'evidence_api') and c.relkind = 'r'
              and (pg_get_userbyid(c.relowner) like 'evidence\_%' or pg_get_userbyid(c.relowner) in ('anon', 'authenticated', 'authenticator', 'service_role'))), null,
  'no private table is owned by a role a client or the worker can become');
select is((select string_agg(n.nspname || '.' || c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('evidence_public', 'evidence_open', 'evidence_inspector', 'evidence_views') and c.relkind = 'v'
              and c.relowner in (select t.relowner from pg_class t join pg_namespace tn on tn.oid = t.relnamespace where tn.nspname = 'evidence_private' and t.relkind = 'r')), null,
  'no view is owned by the table owner, so no view reads a private table with the owner''s exemption from row level security');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname like 'evidence\_%' and p.prosecdef), 0,
  'no SECURITY DEFINER function exists, so nothing runs as the table owner on a caller''s behalf');

select * from finish();
rollback;
