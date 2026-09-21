-- Round two of the public-values work, from an adversarial re-read of 20260921060100 against a loaded store.
--
-- THREE THINGS THE FIRST PASS GOT WRONG OR LEFT OUT.
--
-- 1. THE ALLOWLISTED PAYLOAD WAS NOT AUDITED AT ALL. `safe_payload` is ONE column, but its KEYS are released
--    one at a time against the same owner_fields list. The first audit measured columns, so it reported
--    "safe_payload carries a value" while the reader was in fact receiving 5 keys of 14 for the 2023 candidacy
--    product, 2 of 22 for the candidate finance returns, and 0 of 13 for the party policy pages. 108 keys were
--    held and not shown. `scripts/db/public_value_audit.sql` now has a Part D that measures keys, as anon.
--
-- 2. POLL FIGURES WERE WITHHELD FOR THE WRONG REASON. The first pass withheld them because the rights row is
--    pending -- which is true of EVERY source here, and is exactly the reason the owner's direction overrides.
--    They now have their own scope kind, on the same terms as the other figure scopes, with one extra rule that
--    the others do not need (below). What would still stop them is a publisher's recorded restriction, which is
--    unchanged: a refused, restricted or withheld rights row gives tier `none` and nothing is shown.
--
-- 3. A POLL FIGURE COULD HAVE APPEARED WITHOUT ITS METHODOLOGY LABEL. `evidence_open.poll_results` projects a
--    table that has no methodology column, so a reader browsing it would have seen a party percentage with no
--    indication that 3 of the 12 polls held disclose no methodology. The project already makes R9 model labels
--    travel with a model output unconditionally; this does the same for a poll figure:
--      * `methodology_status` becomes LINK metadata, so it is shown at every tier, for every source, whatever
--        any decision says. It can no longer be blank beside a figure;
--      * `value_pct` and `value_status` are WITHHELD from the raw table projection, and published only through
--        the new curated view `evidence_public.poll_figures`, where the pollster, the sponsor, the fieldwork
--        dates, the official link and the methodology label sit in the SAME ROW as the number.
--    This is not a claim that the methodology is sound. It is a guarantee that the reader is told.
--
-- Unchanged, and re-asserted by tests: no rights row moves off pending, no gate opens, `release_basis` still
-- reports `owner_override`, and a refused, restricted or withheld publisher still hides the source and
-- everything descended from it.
--
-- ON DONORS. The owner asked for officially disclosed donor names, amounts, dates and recipients. THERE IS NO
-- DONOR-LEVEL RECORD IN THIS STORE TO PUBLISH, and this migration does not pretend otherwise. The captured
-- finance products are an index of filed returns (P15, P17) and the Electoral Commission's own published
-- per-party and per-candidate totals (P16, and the index-page totals of P15). The loader's own contract refuses
-- any key matching `donor.*` or `contributor.*` at any depth, so no per-donation row has ever been read. What
-- this migration does do is publish every disclosed finance fact that WAS captured, which the first pass left
-- in the payload unread: the amounts as published, the filing dates, the audit-report status, the party and
-- candidate names as published, and the link to each original return document.

-- 1. The vetted exception list grows by six names, each read on a loaded store -------------------------------
-- `vote_type` is 'party' or 'candidate'; `candidate_votes_evidence` and `list_rank_evidence` are the single status
-- word 'number_found_in_captured_source_passage'; `text_layer_status` is one of three status words;
-- `transcription_scope` is this project's own sentence about what it entered from a return, not a transcript of
-- anything; `published_at_text` is a date as the publisher printed it ('1 August 2026'). None is a figure, a body
-- or an image. Kept equal to SOURCE_FIELD_EXCEPTIONS in tools/owner_authorization.ts.
alter table evidence_private.owner_authorization_scopes drop constraint owner_field_scope_forbidden;
alter table evidence_private.owner_authorization_scopes add constraint owner_field_scope_forbidden
  check (scope_kind is distinct from 'source_fields'
         or field_token in ('external_id', 'external_record_id', 'publisher_item_id', 'source_date_text',
                            'content_kind', 'text_extraction_status', 'publisher_modified_text',
                            'vote_type', 'candidate_votes_evidence', 'list_rank_evidence', 'text_layer_status',
                            'transcription_scope', 'published_at_text')
         or field_token !~ '(email|e_mail|phone|mobile|fax|address|postal|contact|twitter|facebook|instagram|linkedin|handle|body|content|html|text|passage|description|summary|excerpt|transcript|portrait|image|photo|donor|birth|gender|ethnic|vote|share|rank|seats|score|confidence|value|pct|percent|total|amount|sample|payload|external_id|external_record_id|publisher_item_id)');

-- 2. A scope kind for published poll figures ------------------------------------------------------------------

alter table evidence_private.owner_authorization_scopes drop constraint owner_authorization_scopes_scope_kind_check;
alter table evidence_private.owner_authorization_scopes add constraint owner_authorization_scopes_scope_kind_check
  check (scope_kind in ('pages_deploy', 'public_rows', 'source_fields', 'statistical_facts',
                        'official_result_figures', 'official_finance_figures', 'published_poll_figures'));

alter table evidence_private.owner_authorization_scopes drop constraint owner_scope_shape;
alter table evidence_private.owner_authorization_scopes add constraint owner_scope_shape check (
  (scope_kind = 'pages_deploy' and surface_id = 'explorer-pages' and source_id is null and rights_id is null and field_token is null)
  or (scope_kind = 'public_rows' and surface_id = 'evidence-store' and source_id is null and rights_id is null and field_token is null)
  or (scope_kind in ('source_fields', 'statistical_facts', 'official_result_figures', 'official_finance_figures', 'published_poll_figures')
      and surface_id is null and source_id is not null and rights_id is not null
      and field_token is not null and basis is not null and length(btrim(basis)) >= 40));

-- The published numbers of a poll and the payload key that carries them, and nothing else. A closed list.
-- Kept equal to POLL_FIGURE_FIELDS in tools/owner_authorization.ts (tested).
alter table evidence_private.owner_authorization_scopes add constraint owner_poll_figure_tokens
  check (scope_kind is distinct from 'published_poll_figures' or field_token in (
    'value_pct', 'value_status', 'sample_size', 'disclosure_sample_size', 'results'));

-- The result and finance figure lists gain the PAYLOAD KEY that carries the same fact the typed column does.
-- A payload key and a column name share one namespace, so a figure key has to be named where figures are named.
alter table evidence_private.owner_authorization_scopes drop constraint owner_result_figure_tokens;
alter table evidence_private.owner_authorization_scopes add constraint owner_result_figure_tokens
  check (scope_kind is distinct from 'official_result_figures' or field_token in (
    'candidate_informals', 'candidate_lines', 'candidate_total', 'candidate_votes', 'candidate_votes_with_informals',
    'electorate_seats', 'list_rank', 'list_seats', 'party_informals', 'party_lines', 'party_total', 'party_vote_share',
    'party_votes', 'party_votes_with_informals', 'this_route_votes', 'total_seats', 'value_status', 'vote_percent',
    'vote_share', 'votes', 'votes_counted', 'votes_counted_pct', 'votes_status'));
alter table evidence_private.owner_authorization_scopes drop constraint owner_finance_figure_tokens;
alter table evidence_private.owner_authorization_scopes add constraint owner_finance_figure_tokens
  check (scope_kind is distinct from 'official_finance_figures' or field_token in (
    'aggregates', 'amount_nzd', 'amounts_basis', 'donations_as_published_nzd', 'expenses_as_published_nzd',
    'is_image_only', 'loans_as_published_nzd', 'total_status', 'value_status'));

drop index evidence_private.owner_scope_field;
create unique index owner_scope_field on evidence_private.owner_authorization_scopes (authorization_id, scope_kind, source_id, field_token)
  where scope_kind in ('source_fields', 'statistical_facts', 'official_result_figures', 'official_finance_figures', 'published_poll_figures');

-- THE REGISTRY PRODUCTS A FIGURE SCOPE MAY BE RECORDED AGAINST. Literals in exactly two places, this guard and
-- evidence_private.source_release, mirrored by FIGURE_REGISTRIES in tools/owner_authorization.ts; a TypeScript
-- test reads this file and holds all three equal. Widening the list is a migration, never a file edit.
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
  if new.scope_kind in ('source_fields', 'statistical_facts', 'official_result_figures', 'official_finance_figures', 'published_poll_figures') then
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
       or (new.scope_kind = 'published_poll_figures' and v_registry_key is distinct from 'party_vote_polls') then
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
                                               'official_finance_figures', 'published_poll_figures')
                          and f.source_id = s.source_id and f.rights_id = r.rights_id
                          and (f.scope_kind <> 'statistical_facts' or (s.view_scope = 'statistics' and s.registry_key = 'statistics'))
                          -- The same literal lists as the guard above; kept equal by test.
                          and (f.scope_kind <> 'official_result_figures' or s.registry_key = 'election_2023_results')
                          and (f.scope_kind <> 'official_finance_figures' or s.registry_key in ('candidate_finance_returns', 'party_finance_returns'))
                          and (f.scope_kind <> 'published_poll_figures' or s.registry_key = 'party_vote_polls')
                          and o.revoked_at is null and (now() at time zone 'utc')::date between o.decided_on and o.expires_on), '{}'::text[])
       end as owner_fields
from evidence_private.sources s
left join evidence_private.source_rights r on r.rights_id = s.rights_id;

comment on view evidence_private.source_release is
  'none | link_only | fields per source, from its rights row only. owner_fields lists the field names and payload keys a current owner decision shows for that source (descriptive fields; for a statistics source its statistical-fact columns; for an official results, finance-returns or poll product its published figures); it never changes the tier and is empty when the tier is none.';

-- The mirror of governance/owner-authorizations.json, which now also records poll figure scopes.
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
      if v_s ->> 'scope' in ('source_fields', 'statistical_facts', 'official_result_figures', 'official_finance_figures', 'published_poll_figures') then
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

-- 3. A poll figure never appears without the label that says whether a methodology was disclosed --------------

-- The figure and its label in ONE row. Nothing is averaged, ranked or trended across polls (R1).
create or replace view evidence_views.poll_figures as
select pr.poll_document_id, d.official_url, p.pollster, p.sponsor, p.fieldwork_start, p.fieldwork_end,
       p.sample_size, p.methodology_status, pr.party_label_at_source, pr.party_identity_id,
       pr.value_pct, pr.value_status
from evidence_private.poll_results pr
join evidence_private.polls p on p.document_id = pr.poll_document_id
join evidence_private.documents d on d.id = pr.poll_document_id;

comment on view evidence_views.poll_figures is
  'One published party-vote figure per row, with the pollster, the sponsor, the fieldwork dates, the official link and the methodology-disclosure label beside it. The only public path to a poll figure.';

-- A base view is NEVER left owned by the owner of the private tables: that owner is exempt from row level
-- security, and a view runs its body with its owner's privileges. Caught by pgTAP 090 when this was missed.
grant usage, create on schema evidence_views to evidence_inspector_reader;
alter view evidence_views.poll_figures owner to evidence_inspector_reader;
revoke all on evidence_views.poll_figures from public, anon, authenticated;
revoke create on schema evidence_views from evidence_inspector_reader;
-- `polls` and `documents` are already readable by that role (evidence_views.polls and .documents read them);
-- `poll_results` was in no base view before this one, so it needs the same grant and the same read policy.
grant select on evidence_private.poll_results to evidence_inspector_reader;
create policy poll_results_reader_select on evidence_private.poll_results for select to evidence_inspector_reader using (true);

insert into evidence_private.public_lineage (object_schema, object_name, lineage_kind, lineage_sql, note) values
  ('evidence_views', 'poll_figures', 'source',
   '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.poll_document_id)',
   'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.');

-- The raw table projection has no methodology column, so the figure is not published there at all.
insert into evidence_private.public_withheld (object_schema, object_name, column_name, reason) values
  ('evidence_private', 'poll_results', 'value_pct',
   'A poll figure is published only through evidence_public.poll_figures, where the methodology-disclosure label travels in the same row. This table has no such column.'),
  ('evidence_private', 'poll_results', 'value_status',
   'A poll figure is published only through evidence_public.poll_figures, where the methodology-disclosure label travels in the same row. This table has no such column.');

-- `methodology_status` joins the short list of names that are LINK metadata everywhere, for every source and at
-- every tier, exactly as the R9 model labels are: a figure can never be released while its label is hidden.
-- Otherwise identical to 20260920001300.
create or replace function evidence_private.classify_public_columns()
returns integer
language plpgsql
set search_path = ''
as $fn$
declare
  v_count integer;
begin
  delete from evidence_private.public_columns;
  insert into evidence_private.public_columns (object_schema, object_name, column_name, release_class, field_token)
  select x.nspname, x.relname, x.attname, x.release_class, case when x.release_class = 'content' then x.attname end
  from (
  select n.nspname, c.relname, a.attname,
         case
           when l.lineage_kind = 'not_source_data' then 'link'
           when c.relname in ('sources', 'source_freshness', 'catalogue_product_map', 'import_runs', 'fetch_log', 'ingest_errors',
                              'run_checkpoints', 'source_leases', 'ingest_schedules', 'schedules', 'schedule_dispatch_log',
                              'publisher_access_checks', 'publisher_terms_reviews',
                              'source_observations', 'record_lifecycle_events', 'release_items') then 'link'
           when a.attname in ('external_id', 'external_record_id', 'publisher_item_id') then 'content'
           when a.attname = 'id' or a.attname like '%\_id' escape '\' or a.attname like '%\_at' escape '\'
                or a.attname like '%\_hash' escape '\' then 'link'
           when a.attname in ('record_kind', 'document_type', 'view_scope', 'source_url', 'official_url', 'projection_version',
                              'tombstone_reason', 'is_current', 'version_count', 'observation_count', 'link_status',
                              'review_status', 'method', 'subject_kind', 'decision', 'service_terms', 'candidacies',
                              'open_proposals', 'edge_id', 'from_kind', 'to_kind', 'omitted_fields',
                              -- R9 labelling travels with a model output unconditionally: a class or summary can
                              -- never be released by a rights row while its model label stays hidden
                              'classification_basis', 'model_metadata_status', 'provider', 'model_name', 'model_version',
                              'prompt_or_schema_version', 'confidence', 'confidence_status', 'confidence_basis',
                              'schema_agreement_rate', 'schema_agreement_sample', 'schema_agreement_method_url',
                              'schema_agreement_documented',
                              -- The same rule for a poll. `methodology_status` is the PROJECT'S OWN one-word
                              -- record of whether a methodology disclosure was found for that poll ('verified'
                              -- or 'unresolved'), not anything a publisher wrote, so releasing it unconditionally
                              -- takes nothing from a publisher and guarantees a figure is never shown beside a
                              -- blank label, at every tier and for every source
                              'methodology_status',
                              -- the project's own reference data and review flags, not publisher content
                              'election_slug', 'boundary_edition', 'boundary_edition_verified') then 'link'
           else 'content'
         end as release_class
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  join evidence_private.public_lineage l on l.object_schema = n.nspname and l.object_name = c.relname
  where ((n.nspname = 'evidence_private' and c.relkind = 'r') or (n.nspname = 'evidence_views' and c.relkind = 'v'))
    and not exists (select 1 from evidence_private.public_withheld w
                    where w.object_schema = n.nspname and w.object_name = c.relname and w.column_name in (a.attname, '*'))
  ) x;
  -- graph node ids can be label-derived ("electorate:<name>"), so they are content too.
  update evidence_private.public_columns set release_class = 'content', field_token = column_name
   where object_name = 'graph_edges' and column_name in ('from_id', 'to_id');
  get diagnostics v_count = row_count;
  select count(*) into v_count from evidence_private.public_columns;
  return v_count;
end
$fn$;
revoke execute on function evidence_private.classify_public_columns() from public;

-- 4. The generator -------------------------------------------------------------------------------------------
-- As in 20260921060100, with one change: the list of figure scope kinds surface_status reports is now derived
-- (every field scope that is not the descriptive one), so a later figure scope needs no edit here.

create or replace function evidence_private.rebuild_exposed_views()
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  c_reviews constant text :=
    $q$(select count(*) from evidence_private.release_gates g
        where g.gate_key in ('r10_public_surface_review', 'r8_accountable_legal_entity') and g.state = 'open') = 2$q$;
  c_owner constant text := $q$(select o.public_rows_authorized from evidence_private.owner_release o)$q$;
  c_gate constant text := '(' || c_reviews || ' or ' || c_owner || ')';
  c_member constant text :=
    $q$exists (select 1 from evidence_private.app_memberships m
        where m.user_id = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
          and m.app_role in ('inspector', 'admin') and m.revoked_at is null)$q$;
  -- Which kinds of figure rest on a current owner decision. Every field scope that is not the descriptive one
  -- releases figures, so this needs no list to keep up to date.
  c_figures constant text :=
    $q$(select coalesce(array_agg(distinct f.scope_kind order by f.scope_kind), '{}'::text[])
        from evidence_private.owner_authorization_scopes f
        join evidence_private.owner_authorizations o on o.authorization_id = f.authorization_id
        where f.scope_kind not in ('pages_deploy', 'public_rows', 'source_fields')
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

  grant select (gate_key, state, evidence_reference, decided_at) on evidence_private.release_gates to evidence_public_reader;
  grant select on evidence_private.owner_release, evidence_private.source_release, evidence_private.lineage_record, evidence_private.lineage_version,
    evidence_private.lineage_run, evidence_private.lineage_document, evidence_private.lineage_result_set,
    evidence_private.lineage_party_list, evidence_private.lineage_stat_series to evidence_public_reader;
  grant select (authorization_id, scope_kind) on evidence_private.owner_authorization_scopes to evidence_public_reader;
  grant select (authorization_id, decided_on, expires_on, revoked_at) on evidence_private.owner_authorizations to evidence_public_reader;
  grant select (id, source_id) on evidence_private.person_source_identities, evidence_private.party_source_identities,
    evidence_private.stat_datasets to evidence_public_reader;
  grant select (schedule_key, source_id) on evidence_private.ingest_schedules to evidence_public_reader;
  grant select (id, review_status) on evidence_private.summary_versions to evidence_public_reader;
  grant select (summary_id, version_id) on evidence_private.summary_inputs to evidence_public_reader;
  grant select on evidence_private.public_withheld, evidence_private.public_row_rules,
    evidence_private.public_lineage, evidence_private.public_columns to evidence_public_reader;

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
      v_n_denied := v_n_denied + 1;
      continue;
    end if;

    select string_agg(
             case
               when v_lineage.lineage_kind = 'not_source_data' or pc.release_class = 'link' then format('b.%I', a.attname)
               when a.atttypid = 'jsonb'::regtype and a.attname = 'safe_payload' then
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

  execute 'create view evidence_inspector.my_access with (security_barrier = true) as select ' || c_member || ' as is_inspector';
  alter view evidence_inspector.my_access owner to evidence_inspector_reader;
  revoke all on evidence_inspector.my_access from public, anon, authenticated;
  grant select on evidence_inspector.my_access to authenticated;

  execute $v$create view evidence_public.surface_status as
    select g.gate_key, g.state, g.evidence_reference, g.decided_at,
           $v$ || c_gate || $v$ as public_rows_released,
           case when $v$ || c_reviews || $v$ then 'reviews_recorded'
                when $v$ || c_owner || $v$ then 'owner_override' else 'none' end as release_basis,
           o.authorization_id as owner_authorization_id, o.decided_on as owner_decided_on,
           o.expires_on as owner_expires_on, o.request_source as owner_request_source,
           exists (select 1 from evidence_private.source_release sr where cardinality(sr.owner_fields) > 0) as owner_fields_in_force,
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
               'Shown only for a source whose rights review is approved with release mode approved-fields and whose approved_fields names this field, or where a current owner decision (owner_authorization_scopes) names this field for that source — as a descriptive field, as a statistical fact of an official statistics source, or as a published figure of an official election-results, finance-returns or poll product. An owner decision is not a publisher approval. Null otherwise.'
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
