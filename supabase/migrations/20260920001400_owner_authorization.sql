-- Owner authorization: the repository owner's own recorded decision to publish ahead of the independent reviews.
--
-- WHAT THIS IS NOT. It is not the R10 legal review, not the R8 acceptance of the accountable-person role and not a
-- publisher's permission. Nothing here opens a release gate, edits REVIEW-REGISTER.md, or touches a rights row:
--   * evidence_private.release_gates keeps its state (closed stays closed); surface_status reports the basis of any
--     release as 'owner_override', never as a recorded review
--   * evidence_private.source_rights keeps every row pending; source_release.tier is computed exactly as before, and a
--     source whose tier is 'none' (no rights row, refused, restricted, withheld) stays invisible whatever the owner says
--   * a field decision is per SOURCE and per FIELD NAME. There is no wildcard, and contact data, bodies, copied text,
--     images, figures and publisher identifiers are refused by a constraint
--   * model summaries still need the publisher 'fields' tier and a human review (their row rules are unchanged)
-- An authorization always lapses (at most 90 days), can be revoked at once, and is never edited: supersede it.
-- The source of truth is governance/owner-authorizations.json in the repository; an ADMINISTRATOR mirrors it with
-- scripts/db/sync_owner_authorizations.sql. The ingest worker and every browser role hold nothing here.

create table evidence_private.owner_authorizations (
  authorization_id text primary key check (authorization_id ~ '^OWNER-AUTH-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}$'),
  decided_on date not null,
  expires_on date not null,
  decided_by text not null check (length(btrim(decided_by)) >= 3),
  decided_by_role text not null check (decided_by_role ~* 'owner'),
  request_source text not null check (length(btrim(request_source)) >= 20),
  statement text not null check (length(btrim(statement)) >= 40),
  not_claimed text[] not null check (cardinality(not_claimed) >= 3),
  file_hash text not null check (file_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- Fingerprint of the entry as first mirrored (status and revocation fields excluded). A later sync that finds the
  -- same id with different content stops: a decision is superseded by a new id, never rewritten.
  entry_hash text not null check (entry_hash ~ '^md5:[0-9a-f]{32}$'),
  recorded_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text,
  constraint owner_authorization_lapses check (expires_on > decided_on and expires_on <= decided_on + 90),
  constraint owner_authorization_not_postdated check (decided_on <= (recorded_at at time zone 'utc')::date + 1),
  check ((revoked_at is null) = (revoked_reason is null)),
  check (revoked_reason is null or length(btrim(revoked_reason)) >= 10)
);

create table evidence_private.owner_authorization_scopes (
  authorization_id text not null references evidence_private.owner_authorizations (authorization_id),
  scope_kind text not null check (scope_kind in ('pages_deploy', 'public_rows', 'source_fields')),
  surface_id text,
  source_id text references evidence_private.sources (source_id),
  rights_id text references evidence_private.source_rights (rights_id),
  field_token text,
  basis text,
  constraint owner_scope_shape check (
    (scope_kind = 'pages_deploy' and surface_id = 'explorer-pages' and source_id is null and rights_id is null and field_token is null)
    or (scope_kind = 'public_rows' and surface_id = 'evidence-store' and source_id is null and rights_id is null and field_token is null)
    or (scope_kind = 'source_fields' and surface_id is null and source_id is not null and rights_id is not null
        and field_token is not null and basis is not null and length(btrim(basis)) >= 40)),
  constraint owner_field_scope_shape check (field_token is null or field_token ~ '^[a-z][a-z0-9_]{1,62}$'),
  -- Kept equal to FORBIDDEN_FIELD in tools/owner_authorization.ts (tested).
  constraint owner_field_scope_forbidden check (field_token !~ '(email|e_mail|phone|mobile|fax|address|postal|contact|twitter|facebook|instagram|linkedin|handle|body|content|html|text|passage|description|summary|excerpt|transcript|portrait|image|photo|donor|birth|gender|ethnic|vote|share|rank|seats|score|confidence|value|pct|percent|total|amount|sample|payload|external_id|external_record_id|publisher_item_id)')
);
create unique index owner_scope_surface on evidence_private.owner_authorization_scopes (authorization_id, scope_kind) where scope_kind <> 'source_fields';
create unique index owner_scope_field on evidence_private.owner_authorization_scopes (authorization_id, source_id, field_token) where scope_kind = 'source_fields';

comment on table evidence_private.owner_authorizations is
  'Decisions of the repository owner to publish ahead of the independent reviews. Not an R10 review, not an R8 acceptance, not a publisher licence. Always lapses; revocable; never edited.';
comment on table evidence_private.owner_authorization_scopes is
  'What one owner decision covers: the Pages deployment, release of anonymous rows, or named fields of ONE source beside its still-pending rights row. No wildcards.';

-- A field decision sits beside the source's real rights row, and only while that row has not said no.
create or replace function evidence_private.owner_scope_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_rights text;
  v_status text;
  v_release text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'owner authorization scopes are append-only; revoke the authorization and record a new one' using errcode = 'P0001';
  end if;
  if new.scope_kind = 'source_fields' then
    select s.rights_id, r.review_status, r.default_release into v_rights, v_status, v_release
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
  end if;
  return new;
end
$$;
create trigger owner_scope_guard before insert or update or delete on evidence_private.owner_authorization_scopes
  for each row execute function evidence_private.owner_scope_guard();

-- The decision itself is immutable. The one permitted change is a single revocation.
create or replace function evidence_private.owner_authorization_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'owner authorizations are never deleted; revoke instead' using errcode = 'P0001';
  end if;
  if old.revoked_at is not null then
    raise exception 'authorization % is revoked; record a new one', old.authorization_id using errcode = 'P0001';
  end if;
  if new.revoked_at is null or (to_jsonb(new) - 'revoked_at' - 'revoked_reason') <> (to_jsonb(old) - 'revoked_at' - 'revoked_reason') then
    raise exception 'an owner authorization is never edited; the only change allowed is a revocation' using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger owner_authorization_guard before update or delete on evidence_private.owner_authorizations
  for each row execute function evidence_private.owner_authorization_guard();

-- A publisher's "no" is an administrator's record. Found in review of this change: the worker's registry sync could
-- reset a refused, restricted or withheld rights row to pending (its policy checked only the NEW row), and could
-- repoint a source from such a row to a pending one. With rows now releasable on an owner decision, either would put
-- a restricted source back in public view. For any session subject to row level security (the worker; never the
-- administrator) such a row is left exactly as it is, with a warning, and the rest of the sync carries on.
create or replace function evidence_private.rights_restriction_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_catalog.row_security_active('evidence_private.source_rights')
     and (old.review_status <> 'pending' or old.default_release = 'withheld') then
    raise warning 'rights row % is %/% and can be changed only by an administrator; left unchanged', old.rights_id, old.review_status, old.default_release;
    return null;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;
create trigger rights_restriction_guard before update or delete on evidence_private.source_rights
  for each row execute function evidence_private.rights_restriction_guard();

create or replace function evidence_private.source_rights_link_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.rights_id is distinct from old.rights_id
     and pg_catalog.row_security_active('evidence_private.sources')
     and exists (select 1 from evidence_private.source_rights r where r.rights_id = old.rights_id
                 and (r.review_status <> 'pending' or r.default_release = 'withheld')) then
    raise warning 'source % stays under rights row %, which records a restriction; only an administrator can move it', old.source_id, old.rights_id;
    new.rights_id := old.rights_id;
  end if;
  return new;
end
$$;
create trigger source_rights_link_guard before update on evidence_private.sources
  for each row execute function evidence_private.source_rights_link_guard();
revoke execute on function evidence_private.rights_restriction_guard(), evidence_private.source_rights_link_guard() from public;

-- What is in force right now. Always exactly one row, so it can sit in a view predicate.
create view evidence_private.owner_release as
select (a.authorization_id is not null) as public_rows_authorized,
       a.authorization_id, a.decided_on, a.expires_on, a.request_source
from (select 1) one
left join lateral (
  select o.authorization_id, o.decided_on, o.expires_on, o.request_source
  from evidence_private.owner_authorizations o
  join evidence_private.owner_authorization_scopes s on s.authorization_id = o.authorization_id
  where s.scope_kind = 'public_rows' and s.surface_id = 'evidence-store'
    and o.revoked_at is null and (now() at time zone 'utc')::date between o.decided_on and o.expires_on
  order by o.decided_on desc, o.authorization_id desc
  limit 1) a on true;
comment on view evidence_private.owner_release is
  'Whether a current owner decision releases anonymous rows, and which one. Independent of release_gates, which it never changes.';

-- Release tier: computed from the rights row EXACTLY as before. owner_fields is a separate column and is
-- empty whenever the tier is none, so a publisher restriction always wins over an owner decision.
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
                        where f.scope_kind = 'source_fields' and f.source_id = s.source_id and f.rights_id = r.rights_id
                          and o.revoked_at is null and (now() at time zone 'utc')::date between o.decided_on and o.expires_on), '{}'::text[])
       end as owner_fields
from evidence_private.sources s
left join evidence_private.source_rights r on r.rights_id = s.rights_id;

comment on view evidence_private.source_release is
  'none | link_only | fields per source, from its rights row only. owner_fields lists field names a current owner decision shows for that source; it never changes the tier and is empty when the tier is none.';

-- The sources view says, per source, which fields are shown on the owner's decision rather than a publisher's.
create or replace view evidence_views.sources as
select s.source_id, s.title, s.publisher, s.official_url, s.adapter_kind, s.adapter_name, s.allowed_hosts,
       s.view_scope, s.snapshot_semantics, s.expected_cadence_seconds, s.enabled, s.blocked_reason,
       s.registry_key, s.rights_id, coalesce(sr.review_status, 'no rights row') as rights_review_status,
       coalesce(sr.default_release, 'withheld') as rights_default_release,
       rel.tier as public_release_tier, rel.approved_fields as public_approved_fields,
       f.last_attempt_at, f.last_attempt_status, f.last_success_at, f.last_change_at,
       f.latest_source_published_at, f.consecutive_failures, f.last_error_class,
       case
         when f.last_attempt_at is null then 'never_run'
         when f.last_error_class = 'parser_not_enabled' then 'reachable_not_parsed'
         when f.last_attempt_status in ('blocked', 'failed') then 'unavailable'
         when f.last_success_at is null then 'unavailable'
         when s.expected_cadence_seconds is not null
              and f.last_success_at < now() - make_interval(secs => 2 * s.expected_cadence_seconds) then 'stale'
         when f.last_attempt_status = 'partial' then 'partial'
         else 'fresh'
       end as freshness_status,
       (select count(*) from evidence_private.source_records r where r.source_id = s.source_id and r.tombstoned_at is null) as live_records,
       (select count(*) from evidence_private.source_records r where r.source_id = s.source_id and r.tombstoned_at is not null) as tombstoned_records,
       (select count(*) from evidence_private.source_record_versions v join evidence_private.source_records r on r.id = v.record_id
         where r.source_id = s.source_id) as content_versions,
       (select coalesce(array_agg(m.product_id order by m.product_id), '{}') from evidence_private.catalogue_product_map m
         where m.source_id = s.source_id) as catalogue_product_ids,
       rel.owner_fields as owner_authorized_fields
from evidence_private.sources s
left join evidence_private.source_rights sr on sr.rights_id = s.rights_id
left join evidence_private.source_freshness f on f.source_id = s.source_id
join evidence_private.source_release rel on rel.source_id = s.source_id;

-- Administrator-only mirror of governance/owner-authorizations.json. Idempotent. Recording is insert-only; a
-- status of revoked in the file revokes the row. Anything the file says that the constraints refuse stops the whole call.
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
  -- The file is the whole truth. A decision that is in force here but missing from the file is never left running
  -- silently, and never silently revoked by what may be the wrong file: the operator must mark it revoked.
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
      v_unchanged := v_unchanged + 1;  -- a decision revoked before it was ever mirrored is simply never recorded
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
      if v_s ->> 'scope' = 'source_fields' then
        if jsonb_typeof(v_s -> 'fields') is distinct from 'array' or jsonb_array_length(v_s -> 'fields') = 0 then
          raise exception 'field decision for % names no fields', v_s ->> 'source_id' using errcode = 'P0001';
        end if;
        for v_f in select jsonb_array_elements_text(v_s -> 'fields') loop
          insert into evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, rights_id, field_token, basis)
          values (v_id, 'source_fields', v_s ->> 'source_id', v_s ->> 'rights_id', v_f, v_s ->> 'basis');
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
revoke execute on function evidence_private.owner_scope_guard(), evidence_private.owner_authorization_guard() from public;
comment on function evidence_private.sync_owner_authorizations(jsonb, text) is
  'Administrator-only. Mirrors governance/owner-authorizations.json. Never touches release_gates, source_rights or any review table.';

alter table evidence_private.owner_authorizations enable row level security;
alter table evidence_private.owner_authorization_scopes enable row level security;
revoke all on evidence_private.owner_authorizations, evidence_private.owner_authorization_scopes from public, anon, authenticated, evidence_ingest;
revoke all on evidence_private.owner_release from public, anon, authenticated, evidence_ingest;

-- Published like every other governance table: the decision, its scope, dates, source and disclaimers are public.
insert into evidence_private.public_lineage (object_schema, object_name, lineage_kind, lineage_sql, note) values
  ('evidence_private', 'owner_authorizations', 'not_source_data', null, 'Project governance: the owner''s recorded decisions to publish ahead of the reviews. Not a review and not a publisher licence.'),
  ('evidence_private', 'owner_authorization_scopes', 'not_source_data', null, 'Project governance: the surfaces, sources and field names each owner decision covers. Holds no item from any source.');
insert into evidence_private.public_withheld (object_schema, object_name, column_name, reason) values
  ('evidence_private', 'owner_authorizations', 'decided_by', 'Names an individual; per-row names are not published here (R7). The owner is named in governance/owner-authorizations.json in the public repository.');

-- Source-specific lineage, found while rehearsing this release with two candidacy sources in one database: the
-- baseline projection reused the FIRST 'final' result set of an election for every source, so a second source's
-- candidate_results resolved to the first source's lineage and release tier. One source exists in production, so
-- nothing was exposed; the lookup is now per source. Otherwise identical to 20260920000800.
create or replace function evidence_private.project_baseline_candidacies(p_run_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_row record;
  v_election uuid;
  v_edition uuid;
  v_electorate uuid;
  v_ev uuid;
  v_contest uuid;
  v_identity uuid;
  v_party uuid;
  v_candidacy uuid;
  v_list uuid;
  v_result_set uuid;
  v_votes bigint;
  v_count integer := 0;
begin
  select id into v_election from evidence_private.elections where slug = 'general-2023';

  for v_row in
    select r.source_id, r.external_record_id, v.id as version_id, v.safe_payload as p
    from evidence_private.source_observations o
    join evidence_private.source_record_versions v on v.id = o.version_id
    join evidence_private.source_records r on r.id = v.record_id
    where o.run_id = p_run_id and v.record_kind = 'baseline_2023_candidacy' and r.current_version_id = v.id
    order by r.external_record_id
  loop
    if v_row.p ->> 'candidacy_type' not in ('electorate', 'list') or coalesce(v_row.p ->> 'candidate_name', '') = '' then
      insert into evidence_private.ingest_errors (run_id, source_id, error_class, message, record_ref)
      values (p_run_id, v_row.source_id, 'projection_skipped', 'candidacy_type or candidate_name missing', v_row.external_record_id);
      continue;
    end if;

    insert into evidence_private.person_source_identities (
      source_id, external_id, identity_scheme, name_at_source, first_version_id)
    values (v_row.source_id, v_row.external_record_id, 'upstream_candidacy_row', v_row.p ->> 'candidate_name', v_row.version_id)
    on conflict (source_id, external_id) do update set name_at_source = excluded.name_at_source
    returning id into v_identity;

    v_party := evidence_private.ensure_party_identity(v_row.source_id, v_row.p ->> 'party_name');

    if v_row.p ->> 'candidacy_type' = 'electorate' then
      if coalesce(v_row.p ->> 'electorate_name', '') = '' then
        insert into evidence_private.ingest_errors (run_id, source_id, error_class, message, record_ref)
        values (p_run_id, v_row.source_id, 'projection_skipped', 'electorate candidacy without electorate_name', v_row.external_record_id);
        continue;
      end if;
      insert into evidence_private.boundary_editions (slug, title, verified, basis_note)
      values ('boundaries-used-2023', 'Electorate boundaries used at the 2023 General Election', false,
              'Names taken from the 2023 results export. Official identifiers, types and geometry not yet verified.')
      on conflict (slug) do update set slug = excluded.slug
      returning id into v_edition;

      insert into evidence_private.electorates (slug, canonical_name)
      values (regexp_replace(lower(v_row.p ->> 'electorate_name'), '[^a-z0-9āēīōū]+', '-', 'g'), v_row.p ->> 'electorate_name')
      on conflict (slug) do update set slug = excluded.slug
      returning id into v_electorate;

      insert into evidence_private.electorate_versions (electorate_id, boundary_edition_id, name, electorate_type, evidence_version_id)
      values (v_electorate, v_edition, v_row.p ->> 'electorate_name', 'unverified', v_row.version_id)
      on conflict (electorate_id, boundary_edition_id) do update set name = excluded.name
      returning id into v_ev;

      select id into v_contest from evidence_private.contests
       where election_id = v_election and contest_type = 'electorate' and electorate_version_id = v_ev;
      if v_contest is null then
        insert into evidence_private.contests (election_id, contest_type, electorate_version_id)
        values (v_election, 'electorate', v_ev) returning id into v_contest;
      end if;
    else
      select id into v_contest from evidence_private.contests
       where election_id = v_election and contest_type = 'party_list';
      if v_contest is null then
        insert into evidence_private.contests (election_id, contest_type)
        values (v_election, 'party_list') returning id into v_contest;
      end if;
    end if;

    insert into evidence_private.candidacies (
      person_identity_id, election_id, contest_id, candidacy_type, party_identity_id,
      stood_as_independent, current_status, evidence_version_id)
    values (
      v_identity, v_election, v_contest, v_row.p ->> 'candidacy_type', v_party,
      coalesce((select is_independent_label from evidence_private.party_source_identities where id = v_party), false),
      'unknown', v_row.version_id)
    on conflict (person_identity_id, contest_id, candidacy_type) do update set party_identity_id = excluded.party_identity_id
    returning id into v_candidacy;

    -- Official nomination is recorded only when the export states it for an official results source.
    if v_row.p ->> 'nomination_status' = 'officially_nominated' then
      insert into evidence_private.candidacy_status_events (
        candidacy_id, status, date_precision, source_class, evidence_version_id)
      select v_candidacy, 'officially_nominated', 'unknown', 'official_electoral_commission', v_row.version_id
      where not exists (
        select 1 from evidence_private.candidacy_status_events e
        where e.candidacy_id = v_candidacy and e.status = 'officially_nominated');
      update evidence_private.candidacies set current_status = 'officially_nominated'
       where id = v_candidacy and current_status = 'unknown';
    end if;

    if v_row.p ->> 'candidacy_type' = 'list' and nullif(v_row.p ->> 'list_rank', '') is not null
       and (v_row.p ->> 'list_rank')::integer >= 1 and v_party is not null then
      insert into evidence_private.party_lists (election_id, party_identity_id, evidence_version_id)
      values (v_election, v_party, v_row.version_id)
      on conflict (election_id, party_identity_id, list_version) do update set list_version = excluded.list_version
      returning id into v_list;
      insert into evidence_private.party_list_entries (list_id, list_rank, person_identity_id, candidacy_id)
      values (v_list, (v_row.p ->> 'list_rank')::integer, v_identity, v_candidacy)
      on conflict do nothing;
    end if;

    if v_row.p ->> 'candidacy_type' = 'electorate' then
      -- A result set belongs to ONE source. Reusing another source's set would give these rows that source's
      -- lineage, and with it that source's release tier.
      select rs.id into v_result_set from evidence_private.result_sets rs
        join evidence_private.source_record_versions sv on sv.id = rs.source_version_id
        join evidence_private.source_records sr on sr.id = sv.record_id
       where rs.election_id = v_election and rs.result_status = 'final' and sr.source_id = v_row.source_id
       order by rs.id limit 1;
      if v_result_set is null then
        insert into evidence_private.result_sets (election_id, result_status, source_version_id)
        values (v_election, 'final', v_row.version_id) returning id into v_result_set;
      end if;
      -- The importer keeps candidate_votes only when the captured source passage shows the number, so a key
      -- that is present is a reported value - zero included - and an absent key is "not reported". This
      -- function never turns a zero into a missing value or a missing value into zero.
      v_votes := nullif(v_row.p ->> 'candidate_votes', '')::bigint;
      insert into evidence_private.candidate_results (result_set_id, candidacy_id, votes, value_status)
      values (v_result_set, v_candidacy,
              case when v_row.p ? 'candidate_votes' then v_votes end,
              case when v_row.p ? 'candidate_votes' and v_votes is not null then 'reported' else 'not_reported' end)
      on conflict (result_set_id, candidacy_id) do update
        set votes = excluded.votes, value_status = excluded.value_status;
    end if;

    -- Same display name elsewhere in this source: nominate for review, never link.
    insert into evidence_private.identity_decisions (subject_kind, person_identity_id, decision, method, evidence)
    select 'person', v_identity, 'proposed', 'name_similarity_nomination',
           jsonb_build_object('same_name_identity_id', other.id, 'note', 'same name in same source; needs human review')
    from evidence_private.person_source_identities other
    where other.source_id = v_row.source_id and other.id <> v_identity
      and other.name_at_source = v_row.p ->> 'candidate_name'
      and not exists (
        select 1 from evidence_private.identity_decisions d
        where d.person_identity_id = v_identity
          and d.evidence ->> 'same_name_identity_id' = other.id::text);

    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- The generator, as in 20260920001300, with three changes: rows are released by the recorded reviews OR a current owner
-- decision; a content column is shown for a publisher-approved field OR a field a current owner decision names for that
-- source; surface_status reports which basis applies. Everything else is unchanged.
create or replace function evidence_private.rebuild_exposed_views()
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  -- The recorded reviews, unchanged: both gates open.
  c_reviews constant text :=
    $q$(select count(*) from evidence_private.release_gates g
        where g.gate_key in ('r10_public_surface_review', 'r8_accountable_legal_entity') and g.state = 'open') = 2$q$;
  -- A current owner decision with the public_rows scope. It releases rows WITHOUT opening either gate: the
  -- gates keep saying "closed", and surface_status reports the basis as owner_override.
  c_owner constant text := $q$(select o.public_rows_authorized from evidence_private.owner_release o)$q$;
  c_gate constant text := '(' || c_reviews || ' or ' || c_owner || ')';
  c_member constant text :=
    $q$exists (select 1 from evidence_private.app_memberships m
        where m.user_id = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
          and m.app_role in ('inspector', 'admin') and m.revoked_at is null)$q$;
  v_obj record;
  v_lineage evidence_private.public_lineage%rowtype;
  v_all text;
  v_select text;
  v_grant text;
  v_rule text;
  v_target text;
  v_n_public integer := 0;
  v_n_open integer := 0;
  v_n_inspector integer := 0;
  v_n_denied integer := 0;
begin
  grant create on schema evidence_public, evidence_open to evidence_public_reader;
  grant create on schema evidence_inspector to evidence_inspector_reader;

  for v_obj in
    select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('evidence_public', 'evidence_open', 'evidence_inspector') and c.relkind = 'v'
  loop
    execute format('drop view %I.%I cascade', v_obj.nspname, v_obj.relname);
  end loop;

  -- What the public owner role needs beyond the projected columns: gate state, release tiers, lineage.
  grant select (gate_key, state, evidence_reference, decided_at) on evidence_private.release_gates to evidence_public_reader;
  grant select on evidence_private.owner_release, evidence_private.source_release, evidence_private.lineage_record, evidence_private.lineage_version,
    evidence_private.lineage_run, evidence_private.lineage_document, evidence_private.lineage_result_set,
    evidence_private.lineage_party_list, evidence_private.lineage_stat_series to evidence_public_reader;
  grant select (id, source_id) on evidence_private.person_source_identities, evidence_private.party_source_identities,
    evidence_private.stat_datasets to evidence_public_reader;
  grant select (schedule_key, source_id) on evidence_private.ingest_schedules to evidence_public_reader;
  grant select (id, review_status) on evidence_private.summary_versions to evidence_public_reader;
  grant select (summary_id, version_id) on evidence_private.summary_inputs to evidence_public_reader;
  grant select on evidence_private.public_withheld, evidence_private.public_row_rules,
    evidence_private.public_lineage, evidence_private.public_columns to evidence_public_reader;

  -- Inspector layer: every column of every base view, membership only -------------------------------------
  for v_obj in
    select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'evidence_views' and c.relkind = 'v' order by c.relname
  loop
    select string_agg(format('b.%I', a.attname), ', ' order by a.attnum) into v_all
    from pg_attribute a where a.attrelid = v_obj.oid and a.attnum > 0 and not a.attisdropped;
    execute format('create view evidence_inspector.%I with (security_barrier = true) as select %s from evidence_views.%I b where %s',
                   v_obj.relname, v_all, v_obj.relname, c_member);
    execute format('alter view evidence_inspector.%I owner to evidence_inspector_reader', v_obj.relname);
    execute format('revoke all on evidence_inspector.%I from public, anon, authenticated', v_obj.relname);
    execute format('grant select on evidence_inspector.%I to authenticated', v_obj.relname);
    v_n_inspector := v_n_inspector + 1;
  end loop;

  -- Anonymous layers: curated views and one projection per table, from the registers only ----------------------
  for v_obj in
    select c.oid, n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where (n.nspname = 'evidence_views' and c.relkind = 'v') or (n.nspname = 'evidence_private' and c.relkind = 'r')
    order by n.nspname, c.relname
  loop
    if exists (select 1 from evidence_private.public_withheld w
               where w.object_schema = v_obj.nspname and w.object_name = v_obj.relname and w.column_name = '*') then
      continue;
    end if;
    select * into v_lineage from evidence_private.public_lineage l
     where l.object_schema = v_obj.nspname and l.object_name = v_obj.relname;
    if not found then
      -- Default deny: no recorded lineage, no projection.
      v_n_denied := v_n_denied + 1;
      continue;
    end if;

    select string_agg(
             case
               when v_lineage.lineage_kind = 'not_source_data' or pc.release_class = 'link' then format('b.%I', a.attname)
               when a.atttypid = 'jsonb'::regtype and a.attname = 'safe_payload' then
                 -- Key by key: a publisher-approved field, or a field named in a current owner decision for this source.
                 format($e$case when rel.tier = 'fields' or cardinality(rel.owner_fields) > 0 then
                          (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(b.%I) e
                            where (rel.tier = 'fields' and e.key = any (rel.approved_fields)) or e.key = any (rel.owner_fields)) end as %I$e$,
                        a.attname, a.attname)
               else format($e$case when (rel.tier = 'fields' and %L = any (rel.approved_fields)) or %L = any (rel.owner_fields) then b.%I end as %I$e$,
                           pc.field_token, pc.field_token, a.attname, a.attname)
             end, ', ' order by a.attnum),
           string_agg(format('%I', a.attname), ', ' order by a.attnum)
      into v_select, v_grant
    from pg_attribute a
    join evidence_private.public_columns pc
      on pc.object_schema = v_obj.nspname and pc.object_name = v_obj.relname and pc.column_name = a.attname
    where a.attrelid = v_obj.oid and a.attnum > 0 and not a.attisdropped
      and not exists (select 1 from evidence_private.public_withheld w
                      where w.object_schema = v_obj.nspname and w.object_name = v_obj.relname and w.column_name = a.attname);
    if v_select is null then
      v_n_denied := v_n_denied + 1;
      continue;
    end if;

    select r.predicate into v_rule from evidence_private.public_row_rules r
     where r.object_schema = v_obj.nspname and r.object_name = v_obj.relname;
    if v_lineage.lineage_kind = 'not_source_data' and v_obj.relname in ('summary_versions', 'summary_inputs', 'summaries') and v_rule is null then
      raise exception 'multi-source object % needs its row rule', v_obj.relname;
    end if;
    v_target := case v_obj.nspname when 'evidence_views' then 'evidence_public' else 'evidence_open' end;

    execute format('grant select (%s) on %I.%I to evidence_public_reader', v_grant, v_obj.nspname, v_obj.relname);
    if v_obj.relkind = 'r' then
      execute format('drop policy if exists %I on evidence_private.%I', v_obj.relname || '_public_reader_select', v_obj.relname);
      execute format('create policy %I on evidence_private.%I for select to evidence_public_reader using (true)',
                     v_obj.relname || '_public_reader_select', v_obj.relname);
    end if;

    if v_lineage.lineage_kind = 'source' then
      -- The inner join is the default deny: a row whose lineage resolves to no source, or to a source
      -- whose tier is none, does not appear.
      execute format(
        'create view %I.%I with (security_barrier = true) as select %s from %I.%I b '
        'join lateral (select sr.tier, sr.approved_fields, sr.owner_fields from evidence_private.source_release sr where sr.source_id = (%s)) rel on true '
        'where %s and rel.tier <> ''none''%s',
        v_target, v_obj.relname, v_select, v_obj.nspname, v_obj.relname, v_lineage.lineage_sql, c_gate,
        case when v_rule is not null then ' and (' || v_rule || ')' else '' end);
    else
      execute format('create view %I.%I with (security_barrier = true) as select %s from %I.%I b where %s%s',
        v_target, v_obj.relname, v_select, v_obj.nspname, v_obj.relname, c_gate,
        case when v_rule is not null then ' and (' || v_rule || ')' else '' end);
    end if;
    execute format('alter view %I.%I owner to evidence_public_reader', v_target, v_obj.relname);
    execute format('revoke all on %I.%I from public, anon, authenticated', v_target, v_obj.relname);
    execute format('grant select on %I.%I to anon, authenticated', v_target, v_obj.relname);
    if v_target = 'evidence_public' then v_n_public := v_n_public + 1; else v_n_open := v_n_open + 1; end if;
    v_rule := null;
  end loop;

  -- Membership readback for a signed-in user (there is no membership function) -----------------------------
  execute 'create view evidence_inspector.my_access with (security_barrier = true) as select ' || c_member || ' as is_inspector';
  alter view evidence_inspector.my_access owner to evidence_inspector_reader;
  revoke all on evidence_inspector.my_access from public, anon, authenticated;
  grant select on evidence_inspector.my_access to authenticated;

  -- Catalogue: never gated, so a reader can always see what exists, what is withheld or gated, and why -------
  execute $v$create view evidence_public.surface_status as
    select g.gate_key, g.state, g.evidence_reference, g.decided_at,
           $v$ || c_gate || $v$ as public_rows_released,
           case when $v$ || c_reviews || $v$ then 'reviews_recorded'
                when $v$ || c_owner || $v$ then 'owner_override' else 'none' end as release_basis,
           o.authorization_id as owner_authorization_id, o.decided_on as owner_decided_on,
           o.expires_on as owner_expires_on, o.request_source as owner_request_source,
           -- True while ANY field is shown on an owner decision, whatever releases the rows. The reviews being
           -- recorded later does not turn an owner-shown field into a publisher-approved one.
           exists (select 1 from evidence_private.source_release sr where cardinality(sr.owner_fields) > 0) as owner_fields_in_force
    from evidence_private.release_gates g
    cross join evidence_private.owner_release o$v$;

  create view evidence_public.dataset_columns as
    select case n.nspname when 'evidence_private' then 'evidence_open' else 'evidence_public' end as exposed_schema,
           c.relname::text as dataset, a.attnum::integer as ordinal, a.attname::text as column_name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type, not a.attnotnull as nullable,
           case
             when w.column_name is not null or ww.column_name is not null then 'withheld'
             when l.object_name is null or pc.column_name is null then 'withheld'
             when l.lineage_kind = 'not_source_data' then 'public'
             when pc.release_class = 'link' then 'link_metadata'
             else 'rights_gated_content'
           end as disposition,
           case
             when w.column_name is not null or ww.column_name is not null then coalesce(w.reason, ww.reason)
             when l.object_name is null then 'Default deny: no source lineage is recorded for this dataset.'
             when pc.column_name is null then 'Default deny: this column has no release class yet.'
             when l.lineage_kind = 'source' and pc.release_class = 'content' then
               'Shown only for a source whose rights review is approved with release mode approved-fields and whose approved_fields names this field, or where a current owner decision (owner_authorization_scopes) names this field for that source; an owner decision is not a publisher approval. Null otherwise.'
           end as withheld_reason,
           pc.field_token,
           pg_catalog.col_description(c.oid, a.attnum) as description
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join evidence_private.public_withheld w
      on w.object_schema = n.nspname and w.object_name = c.relname and w.column_name = a.attname
    left join evidence_private.public_withheld ww
      on ww.object_schema = n.nspname and ww.object_name = c.relname and ww.column_name = '*'
    left join evidence_private.public_lineage l on l.object_schema = n.nspname and l.object_name = c.relname
    left join evidence_private.public_columns pc
      on pc.object_schema = n.nspname and pc.object_name = c.relname and pc.column_name = a.attname
    where (n.nspname = 'evidence_private' and c.relkind = 'r') or (n.nspname = 'evidence_views' and c.relkind = 'v');

  create view evidence_public.dataset_catalogue as
    select case n.nspname when 'evidence_private' then 'evidence_open' else 'evidence_public' end as exposed_schema,
           c.relname::text as dataset,
           case when c.relkind = 'r' then 'table projection' else 'curated view' end as dataset_kind,
           case when ww.column_name is not null or l.object_name is null then 'withheld' else 'public' end as disposition,
           case when ww.column_name is not null then ww.reason
                when l.object_name is null then 'Default deny: no source lineage is recorded for this dataset.' end as withheld_reason,
           rr.reason as row_rule_reason,
           l.lineage_kind,
           case when l.lineage_kind = 'source' then
             'Rows are shown only for sources whose rights allow it; content columns are null unless that source has approved the field or a current owner decision names it. ' || l.note
             else l.note end as lineage_note,
           pg_catalog.obj_description(c.oid, 'pg_class') as description,
           (select count(*) from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)::integer as columns_total,
           (select count(*) from evidence_private.public_withheld w
             where w.object_schema = n.nspname and w.object_name = c.relname and w.column_name <> '*')::integer as columns_withheld,
           (select count(*) from evidence_private.public_columns pc
             where pc.object_schema = n.nspname and pc.object_name = c.relname and pc.release_class = 'content'
               and l.lineage_kind = 'source')::integer as columns_rights_gated,
           -- No size for a withheld table: the count of app_memberships, say, is the number of inspector accounts.
           case when c.relkind = 'r' and c.reltuples >= 0 and ww.object_name is null then c.reltuples::bigint end as approximate_rows
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    left join evidence_private.public_withheld ww
      on ww.object_schema = n.nspname and ww.object_name = c.relname and ww.column_name = '*'
    left join evidence_private.public_lineage l on l.object_schema = n.nspname and l.object_name = c.relname
    left join evidence_private.public_row_rules rr on rr.object_schema = n.nspname and rr.object_name = c.relname
    where (n.nspname = 'evidence_private' and c.relkind = 'r') or (n.nspname = 'evidence_views' and c.relkind = 'v');

  for v_obj in select unnest(array['surface_status', 'dataset_columns', 'dataset_catalogue']) as relname loop
    execute format('alter view evidence_public.%I owner to evidence_public_reader', v_obj.relname);
    execute format('revoke all on evidence_public.%I from public, anon, authenticated', v_obj.relname);
    execute format('grant select on evidence_public.%I to anon, authenticated', v_obj.relname);
  end loop;

  revoke create on schema evidence_public, evidence_open from evidence_public_reader;
  revoke create on schema evidence_inspector from evidence_inspector_reader;

  return jsonb_build_object('public_views', v_n_public, 'open_tables', v_n_open, 'inspector_views', v_n_inspector,
                            'not_exposed_default_deny', v_n_denied);
end
$fn$;


revoke execute on function evidence_private.rebuild_exposed_views() from public;

select evidence_private.classify_public_columns();
select evidence_private.rebuild_exposed_views();
