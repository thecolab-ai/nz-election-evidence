-- Finding 3: every string a record or an operation carries is validated or kept out of the public layer.
-- Hostile values below are synthetic. The credential-shaped strings are fixtures, not real secrets.
begin;
select plan(40);

select evidence_private.sync_registry(jsonb_build_object(
  'rights', jsonb_build_array(jsonb_build_object('rights_id', 'RIGHTS-89', 'publisher', 'Fixture', 'source_url', 'https://fixture.example/',
    'review_status', 'approved', 'default_release', 'approved-fields', 'reviewed_on', '2026-09-20',
    'approved_fields', jsonb_build_array('title', 'external_record_id', 'source_date_text'), 'register_hash', 'h')),
  'sources', jsonb_build_array(jsonb_build_object('source_id', 'pgtap_hostile', 'title', 'Fixture hostile', 'publisher', 'Fixture',
    'official_url', 'https://fixture.example/l', 'adapter_kind', 'live_fetch', 'adapter_name', 'fixture',
    'allowed_hosts', jsonb_build_array('fixture.example'), 'rights_id', 'RIGHTS-89', 'view_scope', 'general',
    'snapshot_semantics', 'append_only_feed', 'enabled', false, 'config_hash', 'c'))));
select evidence_private.acquire_lease('pgtap_hostile', '88888888-8888-8888-8888-888888888888', 120);
create temp table t as select (evidence_private.start_run('pgtap_hostile', '88888888-8888-8888-8888-888888888888', 'v1', 'incremental', 'test', 'm') ->> 'run_id')::uuid as run_id;

create function pg_temp.base(p_id text) returns jsonb language sql as $$
  select jsonb_build_object('external_record_id', p_id, 'record_kind', 'fixture_item', 'content_hash', 'sha256:' || repeat('a', 64),
    'source_url', 'https://fixture.example/item', 'retrieved_at', now(), 'safe_payload', jsonb_build_object('title', 'ok'));
$$;
create function pg_temp.try(p_rec jsonb) returns text language plpgsql as $$
declare v jsonb;
begin
  v := evidence_private.ingest_batch((select run_id from t), '88888888-8888-8888-8888-888888888888', jsonb_build_array(p_rec));
  if (v ->> 'rejected')::int = 1 then
    return (select message from evidence_private.ingest_errors where source_id = 'pgtap_hostile' order by id desc limit 1);
  end if;
  return 'ACCEPTED';
end $$;

-- identifiers
select is(pg_temp.try(pg_temp.base('person@example.org')), 'external_record_id_email_like_value', 'id: contact');
select is(pg_temp.try(pg_temp.base('/ho' || 'me/operator/archive/file.pdf')), 'bad_external_record_id', 'id: private path');
select is(pg_temp.try(pg_temp.base('id with space')), 'bad_external_record_id', 'id: whitespace');
select is(pg_temp.try(pg_temp.base('<script>alert(1)</script>')), 'bad_external_record_id', 'id: markup');
select is(pg_temp.try(pg_temp.base('https://elsewhere.example/x')), 'bad_external_record_id', 'id: URL');
select is(pg_temp.try(pg_temp.base('token=abcdef1234567890')), 'external_record_id_credential_like_value', 'id: credential');
select is(pg_temp.try(jsonb_set(pg_temp.base('k1'), '{record_kind}', '"Bill; drop table x"')), 'bad_record_kind', 'kind: hostile');
-- links
select is(pg_temp.try(jsonb_set(pg_temp.base('u1'), '{source_url}', '"https://user:pw@fixture.example/x"')), 'source_url_userinfo', 'url: userinfo');
select is(pg_temp.try(jsonb_set(pg_temp.base('u2'), '{source_url}', '"https://fixture.example/x?api_key=abcdef"')), 'source_url_secret_parameter', 'url: secret query parameter');
select is(pg_temp.try(jsonb_set(pg_temp.base('u3'), '{source_url}', '"https://fixture.example/x?a=1&access_token=zzz"')), 'source_url_secret_parameter', 'url: access token');
select is(pg_temp.try(jsonb_set(pg_temp.base('u4'), '{source_url}', '"https://fixture.example/x#token=zzz"')), 'source_url_secret_parameter', 'url: fragment token');
select is(pg_temp.try(jsonb_set(pg_temp.base('u5'), '{source_url}', '"http://fixture.example/x"')), 'source_url_not_plain_https', 'url: not https');
select is(pg_temp.try(jsonb_set(pg_temp.base('u6'), '{source_url}', '"https://fixture.example/x?contact=someone@example.org"')), 'source_email_like_value', 'url: contact in query');
select is(pg_temp.try(jsonb_set(pg_temp.base('u7'), '{source_url}', '"https://fixture.example/x?id=42&page=2"')), 'ACCEPTED', 'url: an ordinary query string is fine');
-- publisher date text
select is(pg_temp.try(jsonb_set(pg_temp.base('d1'), '{source_date_text}', '"call 021 555 0199 <b>now</b>"')), 'bad_source_date_text', 'date text: hostile');
select is(pg_temp.try(jsonb_set(pg_temp.base('d2'), '{source_date_text}', '"Sat, 19 Sep 2026 11:56:18 +1200"')), 'ACCEPTED', 'date text: a real publisher date is fine');
-- omitted field names and reasons
select is(pg_temp.try(jsonb_set(pg_temp.base('o1'), '{omitted_fields}', '[{"field": "x\"; drop table y; --", "reason": "dropped"}]')), 'hostile_omitted_field', 'omitted: hostile name');
select is(pg_temp.try(jsonb_set(pg_temp.base('o2'), '{omitted_fields}', '[{"field": "donor_home", "reason": "lives at someone@example.org"}]')), 'omitted_reason_email_like_value', 'omitted: contact in reason');
select is(pg_temp.try(jsonb_set(pg_temp.base('o3'), '{omitted_fields}', '[{"field": "notes", "reason": "dropped", "value": "the dropped value itself"}]')), 'hostile_omitted_field', 'omitted: a value smuggled next to the name');
select is(pg_temp.try(jsonb_set(pg_temp.base('o4'), '{omitted_fields}', '"not an array"')), 'bad_omitted_fields', 'omitted: wrong shape');
-- payload
select is(pg_temp.try(jsonb_set(pg_temp.base('p1'), '{safe_payload}', '{"Title With Spaces": "x"}')), 'hostile_field_name', 'payload: hostile key');
select is(pg_temp.try(jsonb_set(pg_temp.base('p2'), '{safe_payload}', '{"title": "x", "nested": {"<img src=x>": 1}}')), 'hostile_field_name', 'payload: hostile nested key');
select is(pg_temp.try(jsonb_set(pg_temp.base('p3'), '{safe_payload}', '{"title": "x", "password": "hunter2hunter2"}')), 'forbidden_field_name', 'payload: credential key');
select is(pg_temp.try(jsonb_set(pg_temp.base('p4'), '{safe_payload}', '{"title": "connect with postgres://svc:pw12345@dbhost/x"}')), 'credential_like_value', 'payload: connection string');
select is(pg_temp.try(jsonb_set(pg_temp.base('p5'), '{safe_payload}', ('{"title": "' || 'eyJhbGciOiJIUzI1NiJ9' || '.' || 'eyJyb2xlIjoieCJ9' || '.' || 'c2lnbmF0dXJl"}')::jsonb)), 'credential_like_value', 'payload: token');
select is(pg_temp.try(jsonb_set(pg_temp.base('p6'), '{safe_payload}', ('{"title": "' || 'AKIA' || 'ABCDEFGHIJKLMNOP"}')::jsonb)), 'credential_like_value', 'payload: cloud key shape');
select is(pg_temp.try(jsonb_set(pg_temp.base('p7'), '{safe_payload}', ('{"title": "stored at C:' || '\\\\' || 'Users' || '\\\\' || 'x"}')::jsonb)), 'filesystem_location_value', 'payload: windows path');
select is(pg_temp.try(jsonb_set(pg_temp.base('p8'), '{safe_payload}', '{"title": "ring the office, ph 04 817 9999"}')), 'phone_like_value', 'payload: phone contact');
select is(pg_temp.try(jsonb_set(pg_temp.base('p9'), '{safe_payload}', '{"title": "Budget 2026: $1,200 million over 4 years (2026-2030)"}')), 'ACCEPTED', 'payload: ordinary numbers are not mistaken for contacts');

select is((select count(*)::int from evidence_private.source_records where source_id = 'pgtap_hostile'), 3, 'only the three clean records were stored');
select is((select count(*)::int from evidence_private.ingest_errors where source_id = 'pgtap_hostile' and record_ref !~ '^sha256:[0-9a-f]{16}$'), 0,
  'a rejected record is referenced by a hash, never by its hostile identifier');
select is((select count(*)::int from evidence_private.ingest_errors where source_id = 'pgtap_hostile' and (message ~ '@' or message ~ 'hunter2' or message ~ 'script')), 0,
  'stored error messages are codes; no hostile input is echoed');

-- operations
select throws_ok($$select evidence_private.save_checkpoint((select run_id from t), '88888888-8888-8888-8888-888888888888',
  '{"next": "https://user:pw@fixture.example/next"}'::jsonb, 1, 60)$$, 'P0001', null, 'checkpoint: credentials refused');
select throws_ok($$select evidence_private.save_checkpoint((select run_id from t), '88888888-8888-8888-8888-888888888888',
  jsonb_build_object('blob', repeat('x', 3000)), 1, 60)$$, 'P0001', null, 'checkpoint: oversize refused');
select throws_ok($$select evidence_private.log_fetch((select run_id from t), 'pgtap_hostile', '[{"method":"GET","url":"https://fixture.example/x?token=abc","host":"fixture.example","attempt":1,"outcome":"ok","retrieved_at":"2026-09-20T00:00:00Z"}]'::jsonb)$$,
  'P0001', null, 'fetch log: secret-bearing URL refused');
select evidence_private.finish_run((select run_id from t), '88888888-8888-8888-8888-888888888888', 'failed', false, null, 'upstream_fault',
  'could not reach postgres://svc:pw12345@10.0.0.5/x from /ho' || 'me/operator/run.log, mail admin@example.org, token=abcdef123456');
select is((select error_detail from evidence_private.import_runs where id = (select run_id from t)),
  'could not reach [url] from [location] mail [contact], [credential]', 'run error text is redacted before storage');
select throws_ok($$update evidence_private.import_runs set error_class = 'Bad Class!' where id = (select run_id from t)$$, '23514', null, 'error class is a code, not free text');

-- what the public can see of all that, even at the most permissive tier
update evidence_private.release_gates set state = 'open', evidence_reference = 'fixture', decided_by = 'Fixture Owner Name', decided_at = now()
 where gate_key in ('r10_public_surface_review', 'r8_accountable_legal_entity');
set local role anon;
select is((select count(*)::int from evidence_open.source_records where source_id = 'pgtap_hostile'), 3, 'clean records are public for an approved-fields source');
select is((select count(*)::int from (select to_jsonb(r)::text as j from evidence_open.import_runs r where r.source_id = 'pgtap_hostile'
            union all select to_jsonb(e)::text from evidence_open.ingest_errors e where e.source_id = 'pgtap_hostile'
            union all select to_jsonb(c)::text from evidence_open.run_checkpoints c) x
            where j ~* '(hunter2|example\.org|operator|redacted|\[url\]|script|drop table|akia)'), 0,
  'no hostile input and no operational error text appears in any public operational projection');
select is((select string_agg(distinct error_class, ',') from evidence_open.ingest_errors where source_id = 'pgtap_hostile'), 'record_rejected', 'the public sees the error class only');
reset role;

select * from finish();
rollback;
