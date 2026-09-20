-- Public read-only transparency layer, and the inspector layer, generated from one definition.
--
--   evidence_public.<view>   curated views for anonymous readers (withheld columns removed)
--   evidence_open.<table>    one projection per domain table for anonymous readers
--   evidence_inspector.<view> every column, only for users with a current inspector membership
--
-- Nothing is omitted silently. A column or table is public unless it has a row in
-- evidence_private.public_withheld, and that row carries the reason. The catalogue views
-- evidence_public.dataset_catalogue and dataset_columns publish the full list, reasons included.
--
-- Rows reach anonymous readers only while BOTH the R10 surface review and the R8 accountable-entity
-- gates are recorded as open, and never for a source whose rights row is refused or restricted.
-- Browser roles receive SELECT on views and nothing else: no table, no function, no write.
-- Out of scope by construction (not domain data, never projected): auth.*, vault.*, cron.*, net.*,
-- storage.*, role passwords and any file or archive location (none is stored; see payload guard).

create table evidence_private.public_withheld (
  object_schema text not null check (object_schema in ('evidence_private', 'evidence_views')),
  object_name text not null,
  column_name text not null,
  reason text not null check (length(reason) >= 20),
  primary key (object_schema, object_name, column_name)
);

comment on table evidence_private.public_withheld is
  'Every column or whole object (column_name = *) kept out of the anonymous projections, with the reason. Published as evidence_public.dataset_columns.';

create table evidence_private.public_row_rules (
  object_schema text not null check (object_schema in ('evidence_private', 'evidence_views')),
  object_name text not null,
  predicate text not null,
  reason text not null check (length(reason) >= 20),
  primary key (object_schema, object_name)
);

comment on table evidence_private.public_row_rules is
  'Row conditions applied to an anonymous projection (alias b), with the reason. Maintained only through migrations.';

insert into evidence_private.public_withheld (object_schema, object_name, column_name, reason) values
  ('evidence_private', 'app_memberships', '*', 'Access-control records identify individual account holders; not domain data (R7).'),
  ('evidence_private', 'identity_decisions', 'decided_by', 'Names an individual reviewer. Accountability is published per surface in REVIEW-REGISTER.md, not per row (R7).'),
  ('evidence_views', 'identity_decisions', 'decided_by', 'Names an individual reviewer. Accountability is published per surface in REVIEW-REGISTER.md, not per row (R7).'),
  ('evidence_private', 'review_decisions', 'reviewer', 'Names an individual reviewer; the decision, rubric version and date stay public (R7).'),
  ('evidence_private', 'review_decisions', 'note', 'Free-text reviewer working note; may quote unreviewed material (R6, R9).'),
  ('evidence_private', 'rights_decisions', 'decided_by', 'Names an individual; the decision, scope and evidence link stay public (R7).'),
  ('evidence_private', 'rights_decisions', 'note', 'Free-text working note that may summarise private correspondence with a publisher.'),
  ('evidence_private', 'release_gates', 'decided_by', 'Names an individual; the gate state, evidence reference and date stay public (R7).'),
  ('evidence_views', 'release_gates', 'decided_by', 'Names an individual; the gate state, evidence reference and date stay public (R7).'),
  ('evidence_private', 'release_batches', 'created_by', 'Names an individual operator; batch status and dates stay public (R7).'),
  ('evidence_private', 'ingest_schedules', 'activated_by', 'Names an individual operator; schedule state and proof of activation stay public (R7).'),
  ('evidence_private', 'stat_route_reconciliation', 'decided_by', 'Names an individual; the route decision, note and date stay public (R7).'),
  ('evidence_views', 'stat_route_reconciliation', 'decided_by', 'Names an individual; the route decision, note and date stay public (R7).'),
  ('evidence_private', 'record_lifecycle_events', 'requested_by', 'Names the person who asked for a redaction, who may be a member of the public (R7).'),
  ('evidence_views', 'schedules', 'activated_by', 'Names an individual operator; schedule state and proof of activation stay public (R7).');

insert into evidence_private.public_row_rules (object_schema, object_name, predicate, reason) values
  ('evidence_private', 'summary_versions', $r$b.review_status = 'approved'$r$,
   'Model summaries stay private until a human review of that exact output is recorded (R9).'),
  ('evidence_views', 'summaries', $r$b.review_status = 'approved'$r$,
   'Model summaries stay private until a human review of that exact output is recorded (R9).'),
  ('evidence_private', 'summary_inputs',
   $r$exists (select 1 from evidence_private.summary_versions sv where sv.id = b.summary_id and sv.review_status = 'approved')$r$,
   'Inputs of a summary are listed only once that summary is approved (R9).');

create or replace function evidence_private.rebuild_exposed_views()
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  c_gate constant text :=
    $q$(select count(*) from evidence_private.release_gates g
        where g.gate_key in ('r10_public_surface_review', 'r8_accountable_legal_entity') and g.state = 'open') = 2$q$;
  c_member constant text :=
    $q$exists (select 1 from evidence_private.app_memberships m
        where m.user_id = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
          and m.app_role in ('inspector', 'admin') and m.revoked_at is null)$q$;
  c_rights constant text :=
    $q$not exists (select 1 from evidence_private.sources rs
        join evidence_private.source_rights rr on rr.rights_id = rs.rights_id
        where rs.source_id = b.source_id and rr.review_status in ('refused', 'restricted'))$q$;
  v_obj record;
  v_all text;
  v_public text;
  v_where text;
  v_rule text;
  v_has_source boolean;
  v_counts jsonb := '{}'::jsonb;
  v_n_public integer := 0;
  v_n_open integer := 0;
  v_n_inspector integer := 0;
begin
  grant create on schema evidence_public, evidence_open to evidence_public_reader;
  grant create on schema evidence_inspector to evidence_inspector_reader;

  for v_obj in
    select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('evidence_public', 'evidence_open', 'evidence_inspector') and c.relkind = 'v'
  loop
    execute format('drop view %I.%I cascade', v_obj.nspname, v_obj.relname);
  end loop;

  -- Gate inputs the public owner role needs, column by column.
  grant select (gate_key, state, evidence_reference, decided_at) on evidence_private.release_gates to evidence_public_reader;
  grant select (source_id, rights_id) on evidence_private.sources to evidence_public_reader;
  grant select (rights_id, review_status) on evidence_private.source_rights to evidence_public_reader;
  grant select on evidence_private.public_withheld, evidence_private.public_row_rules to evidence_public_reader;

  -- Curated views ---------------------------------------------------------------------------------
  for v_obj in
    select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'evidence_views' and c.relkind = 'v' order by c.relname
  loop
    select string_agg(format('b.%I', a.attname), ', ' order by a.attnum),
           string_agg(format('b.%I', a.attname), ', ' order by a.attnum) filter (where not exists (
             select 1 from evidence_private.public_withheld w
             where w.object_schema = 'evidence_views' and w.object_name = v_obj.relname and w.column_name = a.attname)),
           bool_or(a.attname = 'source_id')
      into v_all, v_public, v_has_source
    from pg_attribute a where a.attrelid = v_obj.oid and a.attnum > 0 and not a.attisdropped;

    execute format('create view evidence_inspector.%I with (security_barrier = true) as select %s from evidence_views.%I b where %s',
                   v_obj.relname, v_all, v_obj.relname, c_member);
    execute format('alter view evidence_inspector.%I owner to evidence_inspector_reader', v_obj.relname);
    execute format('revoke all on evidence_inspector.%I from public, anon, authenticated', v_obj.relname);
    execute format('grant select on evidence_inspector.%I to authenticated', v_obj.relname);
    v_n_inspector := v_n_inspector + 1;

    if exists (select 1 from evidence_private.public_withheld w
               where w.object_schema = 'evidence_views' and w.object_name = v_obj.relname and w.column_name = '*') then
      continue;
    end if;
    select r.predicate into v_rule from evidence_private.public_row_rules r
     where r.object_schema = 'evidence_views' and r.object_name = v_obj.relname;
    v_where := c_gate || case when v_has_source then ' and ' || c_rights else '' end
                      || case when v_rule is not null then ' and (' || v_rule || ')' else '' end;
    execute format('grant select (%s) on evidence_views.%I to evidence_public_reader', replace(v_public, 'b.', ''), v_obj.relname);
    execute format('create view evidence_public.%I with (security_barrier = true) as select %s from evidence_views.%I b where %s',
                   v_obj.relname, v_public, v_obj.relname, v_where);
    execute format('alter view evidence_public.%I owner to evidence_public_reader', v_obj.relname);
    execute format('revoke all on evidence_public.%I from public, anon, authenticated', v_obj.relname);
    execute format('grant select on evidence_public.%I to anon, authenticated', v_obj.relname);
    v_n_public := v_n_public + 1;
    v_rule := null;
  end loop;

  -- One projection per domain table ---------------------------------------------------------------
  for v_obj in
    select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'evidence_private' and c.relkind = 'r' order by c.relname
  loop
    if exists (select 1 from evidence_private.public_withheld w
               where w.object_schema = 'evidence_private' and w.object_name = v_obj.relname and w.column_name = '*') then
      continue;
    end if;
    select string_agg(format('b.%I', a.attname), ', ' order by a.attnum), bool_or(a.attname = 'source_id')
      into v_public, v_has_source
    from pg_attribute a
    where a.attrelid = v_obj.oid and a.attnum > 0 and not a.attisdropped
      and not exists (select 1 from evidence_private.public_withheld w
                      where w.object_schema = 'evidence_private' and w.object_name = v_obj.relname and w.column_name = a.attname);
    select r.predicate into v_rule from evidence_private.public_row_rules r
     where r.object_schema = 'evidence_private' and r.object_name = v_obj.relname;
    v_where := c_gate || case when v_has_source then ' and ' || c_rights else '' end
                      || case when v_rule is not null then ' and (' || v_rule || ')' else '' end;

    execute format('grant select (%s) on evidence_private.%I to evidence_public_reader', replace(v_public, 'b.', ''), v_obj.relname);
    execute format('drop policy if exists %I on evidence_private.%I', v_obj.relname || '_public_reader_select', v_obj.relname);
    execute format('create policy %I on evidence_private.%I for select to evidence_public_reader using (true)',
                   v_obj.relname || '_public_reader_select', v_obj.relname);
    execute format('create view evidence_open.%I with (security_barrier = true) as select %s from evidence_private.%I b where %s',
                   v_obj.relname, v_public, v_obj.relname, v_where);
    execute format('alter view evidence_open.%I owner to evidence_public_reader', v_obj.relname);
    execute format('revoke all on evidence_open.%I from public, anon, authenticated', v_obj.relname);
    execute format('grant select on evidence_open.%I to anon, authenticated', v_obj.relname);
    v_n_open := v_n_open + 1;
    v_rule := null;
  end loop;

  -- Membership readback for a signed-in user (replaces any membership function) ------------------------
  execute 'create view evidence_inspector.my_access with (security_barrier = true) as select ' || c_member || ' as is_inspector';
  alter view evidence_inspector.my_access owner to evidence_inspector_reader;
  revoke all on evidence_inspector.my_access from public, anon, authenticated;
  grant select on evidence_inspector.my_access to authenticated;

  -- Catalogue: never gated, so a reader can always see what exists, what is withheld and why -----------
  execute $v$create view evidence_public.surface_status as
    select g.gate_key, g.state, g.evidence_reference, g.decided_at,
           $v$ || c_gate || $v$ as public_rows_released
    from evidence_private.release_gates g$v$;

  create view evidence_public.dataset_columns as
    select case n.nspname when 'evidence_private' then 'evidence_open' else 'evidence_public' end as exposed_schema,
           c.relname::text as dataset, a.attnum::integer as ordinal, a.attname::text as column_name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type, not a.attnotnull as nullable,
           case when w.column_name is not null or ww.column_name is not null then 'withheld' else 'public' end as disposition,
           coalesce(w.reason, ww.reason) as withheld_reason,
           pg_catalog.col_description(c.oid, a.attnum) as description
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join evidence_private.public_withheld w
      on w.object_schema = n.nspname and w.object_name = c.relname and w.column_name = a.attname
    left join evidence_private.public_withheld ww
      on ww.object_schema = n.nspname and ww.object_name = c.relname and ww.column_name = '*'
    where (n.nspname = 'evidence_private' and c.relkind = 'r') or (n.nspname = 'evidence_views' and c.relkind = 'v');

  create view evidence_public.dataset_catalogue as
    select case n.nspname when 'evidence_private' then 'evidence_open' else 'evidence_public' end as exposed_schema,
           c.relname::text as dataset,
           case when c.relkind = 'r' then 'table projection' else 'curated view' end as dataset_kind,
           case when ww.column_name is not null then 'withheld' else 'public' end as disposition,
           ww.reason as withheld_reason,
           rr.reason as row_rule_reason,
           pg_catalog.obj_description(c.oid, 'pg_class') as description,
           (select count(*) from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)::integer as columns_total,
           (select count(*) from evidence_private.public_withheld w
             where w.object_schema = n.nspname and w.object_name = c.relname and w.column_name <> '*')::integer as columns_withheld,
           case when c.relkind = 'r' and c.reltuples >= 0 then c.reltuples::bigint end as approximate_rows
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    left join evidence_private.public_withheld ww
      on ww.object_schema = n.nspname and ww.object_name = c.relname and ww.column_name = '*'
    left join evidence_private.public_row_rules rr on rr.object_schema = n.nspname and rr.object_name = c.relname
    where (n.nspname = 'evidence_private' and c.relkind = 'r') or (n.nspname = 'evidence_views' and c.relkind = 'v');

  for v_obj in select unnest(array['surface_status', 'dataset_columns', 'dataset_catalogue']) as relname loop
    execute format('alter view evidence_public.%I owner to evidence_public_reader', v_obj.relname);
    execute format('revoke all on evidence_public.%I from public, anon, authenticated', v_obj.relname);
    execute format('grant select on evidence_public.%I to anon, authenticated', v_obj.relname);
  end loop;

  revoke create on schema evidence_public, evidence_open from evidence_public_reader;
  revoke create on schema evidence_inspector from evidence_inspector_reader;

  return jsonb_build_object('public_views', v_n_public, 'open_tables', v_n_open, 'inspector_views', v_n_inspector);
end
$fn$;

revoke execute on function evidence_private.rebuild_exposed_views() from public;

comment on function evidence_private.rebuild_exposed_views() is
  'Administrator-only. Regenerates every exposed view from the base views, the domain tables and the withheld register. Run at the end of any migration that adds a table, a column or a base view; the pgTAP drift test fails otherwise.';

-- Dataset descriptions, published through evidence_public.dataset_catalogue.
comment on table evidence_private.sources is 'Registered sources: publisher, official URL, adapter, host allowlist, scope, snapshot semantics, cadence.';
comment on table evidence_private.registry_products is 'Upstream registry products, kept distinct from source ids and public catalogue product ids.';
comment on table evidence_private.rights_decisions is 'Append-only per-publisher rights decisions with scope and evidence link.';
comment on table evidence_private.import_runs is 'Run ledger: one row per ingestion attempt with status, counts, manifest hash and resume link.';
comment on table evidence_private.run_checkpoints is 'Append-only resume cursors, written after a page is durably stored.';
comment on table evidence_private.fetch_log is 'Every outbound request attempt: URL, outcome, status, bytes and body hash. Never a body.';
comment on table evidence_private.ingest_errors is 'Rejected records and run-level faults, by class.';
comment on table evidence_private.source_records is 'Stable record identity per source, with the pointer to its current version and tombstone state.';
comment on table evidence_private.source_record_versions is 'Immutable content versions of a record: allowlisted projection, hashes, publisher date and retrieval date.';
comment on table evidence_private.source_observations is 'Each sighting of a version in a run. A refresh with unchanged content adds a row here, not a version.';
comment on table evidence_private.source_freshness is 'Per source: last attempt, last success, last change, latest publisher date, consecutive failures.';
comment on table evidence_private.parties is 'Canonical parties, created only through reviewed identity decisions.';
comment on table evidence_private.person_source_identities is 'People as named by one source. Linked to a canonical person only after a reviewed decision; never by name.';
comment on table evidence_private.party_source_identities is 'Party labels as used by one source. "Independent" is a label, not a party.';
comment on table evidence_private.party_aliases is 'Dated alternative names of a canonical party.';
comment on table evidence_private.party_registrations is 'Dated registration status from the official register.';
comment on table evidence_private.identity_decisions is 'Append-only identity proposals, approvals and rejections. A name match can only ever be a proposal.';
comment on table evidence_private.party_affiliations is 'Person-to-party links over time. An observation alone sets no start date.';
comment on table evidence_private.elections is 'General elections and by-elections. The date is null unless officially recorded.';
comment on table evidence_private.boundary_editions is 'Editions of electorate boundaries. Nothing assumes a fixed number of electorates.';
comment on table evidence_private.electorates is 'Electorate identity across boundary editions.';
comment on table evidence_private.electorate_versions is 'An electorate within one boundary edition; type is unverified until checked officially.';
comment on table evidence_private.contests is 'One electorate contest per election and electorate version, plus one party-list contest per election.';
comment on table evidence_private.candidacy_status_events is 'Append-only dated status events with their source class. Only the Electoral Commission establishes nomination or election.';
comment on table evidence_private.party_lists is 'A party list for an election, by version.';
comment on table evidence_private.party_list_entries is 'Ranked entries of a party list.';
comment on table evidence_private.result_sets is 'A published set of results with its status (preliminary, final, recount, corrected). Statuses are never mixed.';
comment on table evidence_private.candidate_results is 'Electorate candidate votes with a value status. A number exists only when the source reported one.';
comment on table evidence_private.party_results is 'Party votes per electorate contest with a value status.';
comment on table evidence_private.election_party_totals is 'Nationwide party totals and seats with a value status and a denominator note.';
comment on table evidence_private.parliamentary_service_terms is 'Members of Parliament as observed or as established by official events. A sighting sets observation dates only.';
comment on table evidence_private.role_terms is 'Ministerial portfolios and party or parliamentary offices, separate from the MP mandate.';
comment on table evidence_private.bills is 'Bill metadata (number, type, stage, committee). Never bill text.';
comment on table evidence_private.written_questions is 'Written question metadata and answer status.';
comment on table evidence_private.committee_reports is 'Select committee report references.';
comment on table evidence_private.releases is 'Government release references: title, link and publisher date only.';
comment on table evidence_private.policy_sources is 'Party policy page references with the basis of any classification.';
comment on table evidence_private.polls is 'Poll references with methodology verification status.';
comment on table evidence_private.version_person_links is 'Typed links from a record version to a person identity. A mention is not an endorsement.';
comment on table evidence_private.version_party_links is 'Typed links from a record version to a party identity.';
comment on table evidence_private.version_electorate_links is 'Typed links from a record version to an electorate version.';
comment on table evidence_private.version_bill_links is 'Typed links from a record version to a bill.';
comment on table evidence_private.stat_datasets is 'Statistical datasets by source.';
comment on table evidence_private.stat_releases is 'Release vintages of a dataset. Overlapping releases are never merged.';
comment on table evidence_private.stat_series is 'Series definitions: unit, magnitude, seasonal adjustment, dimensions.';
comment on table evidence_private.stat_observations is 'Aggregate observations with value status. Suppressed, confidential or missing is never zero.';
comment on table evidence_private.model_runs is 'Provenance of any model output: provider, model, version, prompt version, or explicitly historical-unknown.';
comment on table evidence_private.summary_versions is 'Model summaries. Public only after a human review of that exact output.';
comment on table evidence_private.summary_inputs is 'Which record versions a summary was generated from.';
comment on table evidence_private.review_decisions is 'Append-only human review decisions tied to an exact output hash.';
comment on table evidence_private.corrections is 'Append-only corrections that supersede and point at the CORRECTIONS.md entry.';
comment on table evidence_private.release_gates is 'R8, R10 and election-day gates. Anonymous readers receive evidence rows only while R8 and R10 are open.';
comment on table evidence_private.release_batches is 'Reviewed release batches for the separate release schema.';
comment on table evidence_private.release_items is 'Items of a release batch.';
comment on table evidence_private.schedule_dispatch_log is 'Append-only log of scheduler dispatches and skips.';

alter table evidence_private.public_withheld enable row level security;
alter table evidence_private.public_row_rules enable row level security;
revoke all on evidence_private.public_withheld, evidence_private.public_row_rules from public, anon, authenticated;

select evidence_private.rebuild_exposed_views();
