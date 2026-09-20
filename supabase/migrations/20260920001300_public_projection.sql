-- Public read-only transparency layer and the inspector layer, generated from registers.
--
--   evidence_public.<view>    curated views for anonymous readers
--   evidence_open.<table>     one projection per domain table for anonymous readers
--   evidence_inspector.<view> every column, only for users with a current inspector membership
--
-- DEFAULT DENY. An object reaches anonymous readers only if evidence_private.public_lineage proves where
-- its rows come from: either a foreign-key path from each row to exactly ONE source, or an explicit
-- statement that it holds no source data. A column reaches them only if evidence_private.public_columns
-- classifies it. Anything else is not exposed, and the published catalogue says so.
--
-- PUBLIC TRANSPARENCY DOES NOT WAIVE SOURCE RIGHTS. Each source has a release tier, from its rights row:
--   none       no rights row, or review refused/restricted, or default release withheld: no row of that
--              source, or of anything descended from it, is shown in any projection
--   link_only  pending, or approved for links only: rows are shown with LINK METADATA columns only
--              (identifiers, kinds, official URLs, dates, hashes, statuses). Every content column is null
--   fields     review approved AND release mode approved-fields: a content column or payload key is
--              shown only if its name is in that rights row's approved_fields. There is no general
--              payload release at any tier
-- Rows also need BOTH the R10 and R8 gates recorded as open. Browser roles hold SELECT on views only.
-- Never projected (not in these schemas): auth.*, vault.*, cron.*, net.*, storage.*, role passwords.

create table evidence_private.public_withheld (
  object_schema text not null check (object_schema in ('evidence_private', 'evidence_views')),
  object_name text not null,
  column_name text not null,
  reason text not null check (length(reason) >= 20),
  primary key (object_schema, object_name, column_name)
);
comment on table evidence_private.public_withheld is
  'Columns or whole objects (column_name = *) never shown to anonymous readers at any tier, with the reason.';

create table evidence_private.public_row_rules (
  object_schema text not null check (object_schema in ('evidence_private', 'evidence_views')),
  object_name text not null,
  predicate text not null,
  reason text not null check (length(reason) >= 20),
  primary key (object_schema, object_name)
);
comment on table evidence_private.public_row_rules is
  'Extra row conditions on an anonymous projection (alias b), with the reason. Maintained only through migrations.';

create table evidence_private.public_lineage (
  object_schema text not null check (object_schema in ('evidence_private', 'evidence_views')),
  object_name text not null,
  lineage_kind text not null check (lineage_kind in ('source', 'not_source_data')),
  lineage_sql text,
  note text not null check (length(note) >= 20),
  primary key (object_schema, object_name),
  check ((lineage_kind = 'source') = (lineage_sql is not null))
);
comment on table evidence_private.public_lineage is
  'How each exposed object proves the source of every row (alias b). An object without a row here is not exposed.';

create table evidence_private.public_columns (
  object_schema text not null check (object_schema in ('evidence_private', 'evidence_views')),
  object_name text not null,
  column_name text not null,
  release_class text not null check (release_class in ('link', 'content')),
  field_token text,
  primary key (object_schema, object_name, column_name),
  check ((release_class = 'content') = (field_token is not null))
);
comment on table evidence_private.public_columns is
  'Release class of every exposed column. link = minimal metadata shown at link_only; content = shown only when field_token is in the source rights row approved_fields. An unclassified column is not exposed.';

insert into evidence_private.public_withheld (object_schema, object_name, column_name, reason) values
  ('evidence_private', 'app_memberships', '*', 'Access-control records identify individual account holders; not domain data (R7).'),
  ('evidence_private', 'people', '*', 'Canonical people are assembled by reviewers from several sources, so a row has no single provable source. Their source identities are published instead.'),
  ('evidence_views', 'people', '*', 'Canonical people are assembled by reviewers from several sources, so a row has no single provable source. Their source identities are published instead.'),
  ('evidence_private', 'parties', '*', 'Canonical parties are assembled by reviewers from several sources, so a row has no single provable source. Their source identities are published instead.'),
  ('evidence_private', 'electorates', '*', 'Electorate identity rows carry a name with no foreign key to the version that evidenced it. Electorate versions are published instead.'),
  ('evidence_private', 'boundary_editions', '*', 'No foreign key to a source version yet; default deny until lineage is recorded.'),
  ('evidence_private', 'geography_versions', '*', 'No foreign key to a source dataset yet; default deny until lineage is recorded.'),
  ('evidence_views', 'coverage_by_scope', '*', 'Aggregates across sources, so it would count rows of sources whose rights do not allow release. The explorer derives coverage from the rights-filtered sources view.'),
  ('evidence_views', 'elections', 'candidacies', 'Counts across sources would include sources whose rights do not allow release.'),
  ('evidence_views', 'elections', 'officially_nominated', 'Counts across sources would include sources whose rights do not allow release.'),
  ('evidence_views', 'elections', 'announced_only', 'Counts across sources would include sources whose rights do not allow release.'),
  ('evidence_private', 'import_runs', 'error_detail', 'Operational error text is never published, even redacted. The error class is.'),
  ('evidence_views', 'import_runs', 'error_detail', 'Operational error text is never published, even redacted. The error class is.'),
  ('evidence_private', 'import_runs', 'source_watermark', 'Adapter-supplied position marker; operational, not reviewed for release.'),
  ('evidence_views', 'import_runs', 'source_watermark', 'Adapter-supplied position marker; operational, not reviewed for release.'),
  ('evidence_private', 'import_runs', 'holder', 'Worker process identifier; operational.'),
  ('evidence_private', 'source_leases', 'holder', 'Worker process identifier; operational.'),
  ('evidence_private', 'ingest_errors', 'message', 'Operational error text is never published. The error class is.'),
  ('evidence_views', 'ingest_errors', 'message', 'Operational error text is never published. The error class is.'),
  ('evidence_private', 'ingest_errors', 'record_ref', 'Points at a rejected record; operational and possibly hostile input.'),
  ('evidence_views', 'ingest_errors', 'record_ref', 'Points at a rejected record; operational and possibly hostile input.'),
  ('evidence_private', 'run_checkpoints', 'cursor_state', 'Adapter resume state; operational JSON that is not reviewed for release.'),
  ('evidence_private', 'schedule_dispatch_log', 'detail', 'Operational dispatcher text.'),
  ('evidence_private', 'record_lifecycle_events', 'reason', 'Free text; a redaction reason may refer to a request from a member of the public (R7). The event type is published.'),
  ('evidence_views', 'record_lifecycle_events', 'reason', 'Free text; a redaction reason may refer to a request from a member of the public (R7). The event type is published.'),
  ('evidence_private', 'record_lifecycle_events', 'requested_by', 'Names the person who asked for a redaction, who may be a member of the public (R7).'),
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
  ('evidence_views', 'schedules', 'activated_by', 'Names an individual operator; schedule state and proof of activation stay public (R7).'),
  ('evidence_private', 'stat_route_reconciliation', 'decided_by', 'Names an individual; the route decision, note and date stay public (R7).'),
  ('evidence_views', 'stat_route_reconciliation', 'decided_by', 'Names an individual; the route decision, note and date stay public (R7).');

-- Model summaries: a human review of the exact output AND every input source cleared at the fields tier.
insert into evidence_private.public_row_rules (object_schema, object_name, predicate, reason) values
  ('evidence_private', 'summary_versions',
   $r$b.review_status = 'approved' and exists (select 1 from evidence_private.summary_inputs si where si.summary_id = b.id)
      and not exists (select 1 from evidence_private.summary_inputs si
                      left join evidence_private.lineage_version lv on lv.version_id = si.version_id
                      left join evidence_private.source_release sr on sr.source_id = lv.source_id
                      where si.summary_id = b.id and coalesce(sr.tier, 'none') <> 'fields')$r$,
   'A model summary is public only after a human review of that exact output, and only if every input source is cleared for field release (R9, source rights).'),
  ('evidence_views', 'summaries',
   $r$b.review_status = 'approved' and exists (select 1 from evidence_private.summary_inputs si where si.summary_id = b.id)
      and not exists (select 1 from evidence_private.summary_inputs si
                      left join evidence_private.lineage_version lv on lv.version_id = si.version_id
                      left join evidence_private.source_release sr on sr.source_id = lv.source_id
                      where si.summary_id = b.id and coalesce(sr.tier, 'none') <> 'fields')$r$,
   'A model summary is public only after a human review of that exact output, and only if every input source is cleared for field release (R9, source rights).'),
  ('evidence_private', 'summary_inputs',
   $r$exists (select 1 from evidence_private.summary_versions sv where sv.id = b.summary_id and sv.review_status = 'approved')
      and coalesce((select sr.tier from evidence_private.lineage_version lv join evidence_private.source_release sr on sr.source_id = lv.source_id
                    where lv.version_id = b.version_id), 'none') = 'fields'$r$,
   'Inputs of a summary are listed only once that summary is approved and the input source is cleared for field release.');

-- Lineage helpers: id to source, by foreign key only ----------------------------------------------------
create view evidence_private.lineage_record as
  select r.id as record_id, r.source_id from evidence_private.source_records r;
create view evidence_private.lineage_version as
  select v.id as version_id, r.source_id from evidence_private.source_record_versions v
  join evidence_private.source_records r on r.id = v.record_id;
create view evidence_private.lineage_run as
  select i.id as run_id, i.source_id from evidence_private.import_runs i;
create view evidence_private.lineage_document as
  select d.id as document_id, r.source_id from evidence_private.documents d
  join evidence_private.source_records r on r.id = d.source_record_id;
create view evidence_private.lineage_result_set as
  select s.id as result_set_id, l.source_id from evidence_private.result_sets s
  join evidence_private.lineage_version l on l.version_id = s.source_version_id;
create view evidence_private.lineage_party_list as
  select p.id as list_id, l.source_id from evidence_private.party_lists p
  join evidence_private.lineage_version l on l.version_id = p.evidence_version_id;
create view evidence_private.lineage_stat_series as
  select s.id as series_id, d.source_id from evidence_private.stat_series s
  join evidence_private.stat_datasets d on d.id = s.dataset_id;

insert into evidence_private.public_lineage (object_schema, object_name, lineage_kind, lineage_sql, note) values
  ('evidence_private', 'bills', 'source', '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.document_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'candidacies', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'candidacy_status_events', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'candidate_results', 'source', '(select l.source_id from evidence_private.lineage_result_set l where l.result_set_id = b.result_set_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'catalogue_product_map', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'committee_reports', 'source', '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.document_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'documents', 'source', '(select l.source_id from evidence_private.lineage_record l where l.record_id = b.source_record_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'election_party_totals', 'source', '(select l.source_id from evidence_private.lineage_result_set l where l.result_set_id = b.result_set_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'electorate_versions', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'fetch_log', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'finance_return_references', 'source', '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.document_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'identity_decisions', 'source', 'coalesce((select l.source_id from evidence_private.person_source_identities l where l.id = b.person_identity_id), (select l.source_id from evidence_private.party_source_identities l where l.id = b.party_identity_id))', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'import_runs', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'ingest_errors', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'ingest_schedules', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'parliamentary_service_terms', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'party_affiliations', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'party_aliases', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'party_list_entries', 'source', '(select l.source_id from evidence_private.lineage_party_list l where l.list_id = b.list_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'party_lists', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'party_registrations', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'party_results', 'source', '(select l.source_id from evidence_private.lineage_result_set l where l.result_set_id = b.result_set_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'party_source_identities', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'person_source_identities', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'policy_sources', 'source', '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.document_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'poll_results', 'source', '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.poll_document_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'polls', 'source', '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.document_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'record_lifecycle_events', 'source', '(select l.source_id from evidence_private.lineage_record l where l.record_id = b.record_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'release_items', 'source', 'coalesce(b.source_id, (select l.source_id from evidence_private.lineage_document l where l.document_id = b.document_id))', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'releases', 'source', '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.document_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'result_sets', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.source_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'role_terms', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'run_checkpoints', 'source', '(select l.source_id from evidence_private.lineage_run l where l.run_id = b.run_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'schedule_dispatch_log', 'source', '(select l.source_id from evidence_private.ingest_schedules l where l.schedule_key = b.schedule_key)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'source_freshness', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'source_leases', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'source_observations', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'source_record_versions', 'source', '(select l.source_id from evidence_private.lineage_record l where l.record_id = b.record_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'source_records', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'sources', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'staged_unmatched_results', 'source', '(select l.source_id from evidence_private.lineage_result_set l where l.result_set_id = b.result_set_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'stat_datasets', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'stat_observations', 'source', '(select l.source_id from evidence_private.lineage_stat_series l where l.series_id = b.series_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'stat_releases', 'source', '(select l.source_id from evidence_private.stat_datasets l where l.id = b.dataset_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'stat_series', 'source', '(select l.source_id from evidence_private.stat_datasets l where l.id = b.dataset_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'version_bill_links', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'version_electorate_links', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'version_party_links', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'version_person_links', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'written_questions', 'source', '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.document_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'candidacies', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'candidacy_status_events', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'documents', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'electorates', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'fetch_log', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'finance_returns', 'source', '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.document_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'graph_edges', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'identity_decisions', 'source', 'coalesce((select l.source_id from evidence_private.person_source_identities l where l.id = b.person_identity_id), (select l.source_id from evidence_private.party_source_identities l where l.id = b.party_identity_id))', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'import_runs', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'ingest_errors', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'party_affiliations', 'source', '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'party_identities', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'person_identities', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'polls', 'source', '(select l.source_id from evidence_private.lineage_document l where l.document_id = b.document_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'record_lifecycle_events', 'source', '(select l.source_id from evidence_private.lineage_record l where l.record_id = b.record_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'record_versions', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'records', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'schedules', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'service_terms', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'sources', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'stat_observations', 'source', '(select l.source_id from evidence_private.lineage_stat_series l where l.series_id = b.series_id)', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_views', 'stat_series', 'source', 'b.source_id', 'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.'),
  ('evidence_private', 'contests', 'not_source_data', null, 'Structural keys only (election and electorate version ids); no source content.'),
  ('evidence_private', 'corrections', 'not_source_data', null, 'Project-authored corrections log entries (R5).'),
  ('evidence_private', 'elections', 'not_source_data', null, 'Project-authored reference rows with a stated basis for each date.'),
  ('evidence_private', 'model_runs', 'not_source_data', null, 'Provenance of project model runs; no source content.'),
  ('evidence_private', 'public_columns', 'not_source_data', null, 'The published register of column release classes.'),
  ('evidence_private', 'public_lineage', 'not_source_data', null, 'The published register of source lineage.'),
  ('evidence_private', 'public_row_rules', 'not_source_data', null, 'The published register of row rules.'),
  ('evidence_private', 'public_withheld', 'not_source_data', null, 'The published register of withheld columns.'),
  ('evidence_private', 'registry_products', 'not_source_data', null, 'Project-authored registry of products.'),
  ('evidence_private', 'release_batches', 'not_source_data', null, 'Project governance state.'),
  ('evidence_private', 'release_gates', 'not_source_data', null, 'Project governance state.'),
  ('evidence_private', 'review_decisions', 'not_source_data', null, 'Project review decisions: ids, outcome, rubric version and date.'),
  ('evidence_private', 'rights_decisions', 'not_source_data', null, 'Project decisions about a publisher. Holds no item from any source.'),
  ('evidence_private', 'source_rights', 'not_source_data', null, 'Publisher-level rights register, mirrored from the public catalogue. Holds no item from any source.'),
  ('evidence_private', 'stat_route_reconciliation', 'not_source_data', null, 'Project-authored import route decisions.'),
  ('evidence_views', 'elections', 'not_source_data', null, 'Project-authored reference rows; per-source counts are withheld.'),
  ('evidence_views', 'release_gates', 'not_source_data', null, 'Project governance state.'),
  ('evidence_views', 'rights_register', 'not_source_data', null, 'Publisher-level rights register. Holds no item from any source.'),
  ('evidence_views', 'stat_route_reconciliation', 'not_source_data', null, 'Project-authored import route decisions.');

-- The model summaries have several inputs, so their release is decided by a row rule instead of one lineage.
insert into evidence_private.public_lineage (object_schema, object_name, lineage_kind, lineage_sql, note) values
  ('evidence_private', 'summary_versions', 'not_source_data', null, 'Multi-source: released only by its row rule (human review and every input source at the fields tier).'),
  ('evidence_private', 'summary_inputs', 'not_source_data', null, 'Multi-source: released only by its row rule (approved summary and input source at the fields tier).'),
  ('evidence_views', 'summaries', 'not_source_data', null, 'Multi-source: released only by its row rule (human review and every input source at the fields tier).');

-- Column classes -----------------------------------------------------------------------------------------------
-- Operational and project-authored objects hold no publisher content: every non-withheld column is link
-- metadata. Everywhere else a column is link metadata ONLY if its name is on the short list below; every
-- other column is content and needs its own name in the source's approved_fields. Unknown means content.
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
                              'source_observations', 'record_lifecycle_events', 'release_items') then 'link'
           when a.attname in ('external_id', 'external_record_id', 'publisher_item_id') then 'content'
           when a.attname = 'id' or a.attname like '%\_id' escape '\' or a.attname like '%\_at' escape '\'
                or a.attname like '%\_hash' escape '\' then 'link'
           when a.attname in ('record_kind', 'document_type', 'view_scope', 'source_url', 'official_url', 'projection_version',
                              'tombstone_reason', 'is_current', 'version_count', 'observation_count', 'link_status',
                              'review_status', 'method', 'subject_kind', 'decision', 'service_terms', 'candidacies',
                              'open_proposals', 'edge_id', 'from_kind', 'to_kind', 'omitted_fields') then 'link'
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
  grant select on evidence_private.source_release, evidence_private.lineage_record, evidence_private.lineage_version,
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
                 format($e$case when rel.tier = 'fields' then (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                          from jsonb_each(b.%I) e where e.key = any (rel.approved_fields)) end as %I$e$, a.attname, a.attname)
               else format($e$case when rel.tier = 'fields' and %L = any (rel.approved_fields) then b.%I end as %I$e$,
                           pc.field_token, a.attname, a.attname)
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
        'join lateral (select sr.tier, sr.approved_fields from evidence_private.source_release sr where sr.source_id = (%s)) rel on true '
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
           $v$ || c_gate || $v$ as public_rows_released
    from evidence_private.release_gates g$v$;

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
               'Shown only for a source whose rights review is approved with release mode approved-fields and whose approved_fields names this field. Null otherwise.'
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
             'Rows are shown only for sources whose rights allow it; content columns are null unless that source has approved the field. ' || l.note
             else l.note end as lineage_note,
           pg_catalog.obj_description(c.oid, 'pg_class') as description,
           (select count(*) from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)::integer as columns_total,
           (select count(*) from evidence_private.public_withheld w
             where w.object_schema = n.nspname and w.object_name = c.relname and w.column_name <> '*')::integer as columns_withheld,
           (select count(*) from evidence_private.public_columns pc
             where pc.object_schema = n.nspname and pc.object_name = c.relname and pc.release_class = 'content'
               and l.lineage_kind = 'source')::integer as columns_rights_gated,
           case when c.relkind = 'r' and c.reltuples >= 0 then c.reltuples::bigint end as approximate_rows
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

comment on function evidence_private.rebuild_exposed_views() is
  'Administrator-only. Regenerates every exposed view from the registers. After a migration adds a table, column or base view: record its lineage (or withhold it), run classify_public_columns(), review the classes, then run this. The pgTAP drift tests fail otherwise.';

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
alter table evidence_private.public_lineage enable row level security;
alter table evidence_private.public_columns enable row level security;
revoke all on evidence_private.public_withheld, evidence_private.public_row_rules,
  evidence_private.public_lineage, evidence_private.public_columns from public, anon, authenticated;
revoke all on evidence_private.source_release, evidence_private.lineage_record, evidence_private.lineage_version,
  evidence_private.lineage_run, evidence_private.lineage_document, evidence_private.lineage_result_set,
  evidence_private.lineage_party_list, evidence_private.lineage_stat_series from public, anon, authenticated;

comment on table evidence_private.public_lineage is
  'How each exposed object proves the source of every row. An object without a row here is not exposed (default deny).';
comment on table evidence_private.public_columns is
  'Release class of every exposed column: link metadata, or content that needs the field in the source rights row approved_fields.';
comment on table evidence_private.staged_unmatched_results is
  'Result labels without a verified candidacy stay here. They are never fuzzy-joined.';

select evidence_private.classify_public_columns();
select evidence_private.rebuild_exposed_views();
