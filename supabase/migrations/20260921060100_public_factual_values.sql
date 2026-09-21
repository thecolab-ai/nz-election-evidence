-- Public factual values: the figures, identifiers and provenance an anonymous reader receives.
--
-- WHY THIS EXISTS. Every source is still pending / link-only, so a content column is shown only when a current
-- owner decision names that field for that source. The owner decision could not name a figure at all: the
-- forbidden-name rule on a `source_fields` scope refuses any token holding "vote", "value", "total", "amount",
-- "seats", "rank", "share" or "pct". That rule is right as a backstop and wrong as a conclusion, and its effect
-- was that 963 candidacies, 1,224 party results, 17 nationwide party totals, 72 electorate summaries and 1,504
-- published finance aggregates were loaded and displayed as blank cells. Official published figures were being
-- withheld by a pattern match on a column name, not by any decision about them.
--
-- It also refused names that merely CONTAIN a forbidden word without being the forbidden thing:
-- `is_image_only` (a flag saying a PDF is a scan, not an image), `source_date_text` (a date as printed, not a
-- body), `content_kind` (a kind label, not content), `text_extraction_status`, `publisher_modified_text`, and
-- the publisher's own public identifiers `external_id`, `external_record_id`, `publisher_item_id`.
--
-- WHAT THIS IS NOT. It is not the R10 legal review, not the R8 acceptance, and not a publisher's permission.
-- It changes no rights row, opens no release gate, and marks nothing approved. It only makes it POSSIBLE for a
-- recorded owner decision to name these fields; whether any of them is actually shown still depends, field by
-- field and source by source, on an entry in governance/owner-authorizations.json that lapses and is revocable.
--
-- THREE CHANGES, each closed and named.
--
--   1. `source_fields` keeps its forbidden-name rule, with a CLOSED list of seven vetted exceptions. Every
--      exception is a column that was read on the real store before it was listed here.
--   2. Two new scope kinds for published figures, each with its own closed token list and its own eligibility
--      rule, exactly as `statistical_facts` has:
--        official_result_figures   the figures an official election-results product printed, for a source whose
--                                  registry product is on a closed list (today: election_2023_results)
--        official_finance_figures  the totals the Electoral Commission prints on its own public finance index
--                                  pages, for a source whose registry product is a finance-returns product
--      Both are re-checked WHERE THEY ARE READ (evidence_private.source_release), not only where they were
--      recorded, so a source that stops being that kind of product loses the figures at once.
--   3. `evidence_public.surface_status` publishes which figure scopes are in force, so a reader is told which
--      kinds of number rest on the owner's decision rather than on a publisher's approval.
--
-- STILL OUT, and not by accident:
--   * poll figures (`value_pct`, `sample_size`): a pollster's numbers are that pollster's own product, the
--     rights row is pending, and `methodology_status` is unresolved. No scope here can carry them.
--   * anything read from INSIDE a finance return (`approved_total` is not a token below): the loader records
--     `total_status = 'not_extracted'` and nothing is read from a return document. No donor, no amount from a
--     return, no signature.
--   * bodies, summaries, copied passages, contact details, images, canonical people and parties, model output.

-- 1. source_fields: the forbidden-name rule, with a closed exception list ------------------------------------

-- Kept equal to SOURCE_FIELD_EXCEPTIONS in tools/owner_authorization.ts (tested). Each name was read on a
-- loaded store first: external ids are the publisher's own public identifiers (GUIDs, page slugs, digests);
-- `source_date_text` is the publisher's date exactly as printed; `content_kind` is 'minister' or 'portfolio';
-- `text_extraction_status` is 'extracted'; `publisher_modified_text` is a publisher timestamp as printed;
-- `is_image_only` is false/true for "this PDF is a scan". None of them is a body, an image or a contact.
alter table evidence_private.owner_authorization_scopes drop constraint owner_field_scope_forbidden;
alter table evidence_private.owner_authorization_scopes add constraint owner_field_scope_forbidden
  check (scope_kind is distinct from 'source_fields'
         or field_token in ('external_id', 'external_record_id', 'publisher_item_id', 'source_date_text',
                            'content_kind', 'text_extraction_status', 'publisher_modified_text')
         or field_token !~ '(email|e_mail|phone|mobile|fax|address|postal|contact|twitter|facebook|instagram|linkedin|handle|body|content|html|text|passage|description|summary|excerpt|transcript|portrait|image|photo|donor|birth|gender|ethnic|vote|share|rank|seats|score|confidence|value|pct|percent|total|amount|sample|payload|external_id|external_record_id|publisher_item_id)');

-- 2. Two scope kinds for published figures ----------------------------------------------------------------

alter table evidence_private.owner_authorization_scopes drop constraint owner_authorization_scopes_scope_kind_check;
alter table evidence_private.owner_authorization_scopes add constraint owner_authorization_scopes_scope_kind_check
  check (scope_kind in ('pages_deploy', 'public_rows', 'source_fields', 'statistical_facts',
                        'official_result_figures', 'official_finance_figures'));

alter table evidence_private.owner_authorization_scopes drop constraint owner_scope_shape;
alter table evidence_private.owner_authorization_scopes add constraint owner_scope_shape check (
  (scope_kind = 'pages_deploy' and surface_id = 'explorer-pages' and source_id is null and rights_id is null and field_token is null)
  or (scope_kind = 'public_rows' and surface_id = 'evidence-store' and source_id is null and rights_id is null and field_token is null)
  or (scope_kind in ('source_fields', 'statistical_facts', 'official_result_figures', 'official_finance_figures')
      and surface_id is null and source_id is not null and rights_id is not null
      and field_token is not null and basis is not null and length(btrim(basis)) >= 40));

-- Closed lists, not patterns. Kept equal to RESULT_FIGURE_FIELDS and FINANCE_FIGURE_FIELDS in
-- tools/owner_authorization.ts (tested). `approved_total` is deliberately absent from both: it would be a
-- number read from inside a return document, and nothing here may publish one.
alter table evidence_private.owner_authorization_scopes add constraint owner_result_figure_tokens
  check (scope_kind is distinct from 'official_result_figures' or field_token in (
    'candidate_informals', 'candidate_lines', 'candidate_votes_with_informals', 'electorate_seats', 'list_rank',
    'list_seats', 'party_informals', 'party_lines', 'party_vote_share', 'party_votes', 'party_votes_with_informals',
    'this_route_votes', 'total_seats', 'value_status', 'vote_share', 'votes', 'votes_counted', 'votes_counted_pct',
    'votes_status'));
alter table evidence_private.owner_authorization_scopes add constraint owner_finance_figure_tokens
  check (scope_kind is distinct from 'official_finance_figures' or field_token in (
    'amount_nzd', 'is_image_only', 'total_status', 'value_status'));

drop index evidence_private.owner_scope_field;
create unique index owner_scope_field on evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, field_token)
  where scope_kind in ('source_fields', 'statistical_facts', 'official_result_figures', 'official_finance_figures');

comment on table evidence_private.owner_authorization_scopes is
  'What one owner decision covers: the Pages deployment, release of anonymous rows, named descriptive fields of ONE source, the statistical-fact columns of ONE statistics source, or the published figure columns of ONE official election-results or finance-returns source, always beside that source''s still-pending rights row. No wildcards.';

-- THE REGISTRY PRODUCTS A FIGURE SCOPE MAY BE RECORDED AGAINST. Written out as literal arrays in exactly two
-- places -- this guard and evidence_private.source_release below -- and mirrored by FIGURE_REGISTRIES in
-- tools/owner_authorization.ts. A TypeScript test reads this file and holds all three equal, and pgTAP asserts
-- what they do from both ends (a scope refused for the wrong product; a figure gone the moment it is). They are literals
-- rather than a helper function on purpose: the view is read by the anonymous projection role, and a stored
-- view's function privileges are resolved against the view owner, which is a subtlety this layer should not
-- depend on. A product not on the list needs a migration, which is the point: widening it is a reviewed change,
-- never an entry in a JSON file.
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
  if new.scope_kind in ('source_fields', 'statistical_facts', 'official_result_figures', 'official_finance_figures') then
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
           and (v_registry_key is null or v_registry_key not in ('candidate_finance_returns', 'party_finance_returns'))) then
      raise exception 'source % is registered as %, which is not a % product: figures can be released only for the official product that publishes them',
        new.source_id, coalesce(v_registry_key, 'no registry product'), new.scope_kind using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;
revoke execute on function evidence_private.owner_scope_guard() from public;

-- Release tier: computed from the rights row EXACTLY as before. owner_fields now also lists the figure columns
-- of a current figure decision; it never changes the tier and is empty when the tier is none. Every scope kind
-- with an eligibility rule is re-checked here, on every read.
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
                        where f.scope_kind in ('source_fields', 'statistical_facts', 'official_result_figures', 'official_finance_figures')
                          and f.source_id = s.source_id and f.rights_id = r.rights_id
                          and (f.scope_kind <> 'statistical_facts' or (s.view_scope = 'statistics' and s.registry_key = 'statistics'))
                          -- The same two literal lists as the guard above; kept equal by test.
                          and (f.scope_kind <> 'official_result_figures' or s.registry_key = 'election_2023_results')
                          and (f.scope_kind <> 'official_finance_figures' or s.registry_key in ('candidate_finance_returns', 'party_finance_returns'))
                          and o.revoked_at is null and (now() at time zone 'utc')::date between o.decided_on and o.expires_on), '{}'::text[])
       end as owner_fields
from evidence_private.sources s
left join evidence_private.source_rights r on r.rights_id = s.rights_id;

comment on view evidence_private.source_release is
  'none | link_only | fields per source, from its rights row only. owner_fields lists the field names a current owner decision shows for that source (descriptive fields; for a statistics source its statistical-fact columns; for an official results or finance-returns source its published figure columns); it never changes the tier and is empty when the tier is none.';

-- The mirror of governance/owner-authorizations.json, unchanged except that it also records figure scopes.
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
      if v_s ->> 'scope' in ('source_fields', 'statistical_facts', 'official_result_figures', 'official_finance_figures') then
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

-- 3. The generator ------------------------------------------------------------------------------------------
-- As in 20260920001400, with two changes: surface_status names the figure scopes in force, and the published
-- column catalogue says that a figure scope is one of the ways a content column can carry a value. The row and
-- column rules themselves are untouched: a content column is still shown only for a publisher-approved field or
-- a field a current owner decision names for that source.

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
  -- Which kinds of figure rest on a current owner decision right now. Read from the scopes, so it cannot go stale.
  c_figures constant text :=
    $q$(select coalesce(array_agg(distinct f.scope_kind order by f.scope_kind), '{}'::text[])
        from evidence_private.owner_authorization_scopes f
        join evidence_private.owner_authorizations o on o.authorization_id = f.authorization_id
        where f.scope_kind in ('statistical_facts', 'official_result_figures', 'official_finance_figures')
          and o.revoked_at is null and (now() at time zone 'utc')::date between o.decided_on and o.expires_on)$q$;
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
  -- surface_status names the figure scopes in force; that needs the scope kind and its dates, nothing else.
  grant select (authorization_id, scope_kind) on evidence_private.owner_authorization_scopes to evidence_public_reader;
  grant select (authorization_id, decided_on, expires_on, revoked_at) on evidence_private.owner_authorizations to evidence_public_reader;
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
           exists (select 1 from evidence_private.source_release sr where cardinality(sr.owner_fields) > 0) as owner_fields_in_force,
           -- Which kinds of published FIGURE rest on a current owner decision, by scope kind. Empty when none does.
           $v$ || c_figures || $v$ as owner_figure_scopes
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
               'Shown only for a source whose rights review is approved with release mode approved-fields and whose approved_fields names this field, or where a current owner decision (owner_authorization_scopes) names this field for that source — as a descriptive field, as a statistical fact of an official statistics source, or as a published figure of an official election-results or finance-returns source. An owner decision is not a publisher approval. Null otherwise.'
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
