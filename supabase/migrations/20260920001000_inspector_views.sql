-- Read-only inspector surface. Every view:
--   * lists its columns explicitly (no select *, no unreviewed column reaches the API)
--   * returns rows only when the caller holds a current inspector membership
--   * is a security barrier owned by the read-only reader role
-- There is no RPC that accepts SQL text, table names or column lists.

create view evidence_inspector.sources as
select s.source_id, s.title, s.publisher, s.official_url, s.adapter_kind, s.adapter_name, s.allowed_hosts,
       s.view_scope, s.snapshot_semantics, s.expected_cadence_seconds, s.enabled, s.blocked_reason,
       s.registry_key, s.rights_id, coalesce(sr.review_status, 'pending') as rights_review_status,
       coalesce(sr.default_release, 'link-only') as rights_default_release,
       f.last_attempt_at, f.last_attempt_status, f.last_success_at, f.last_change_at,
       f.latest_source_published_at, f.consecutive_failures, f.last_error_class,
       case
         when f.last_attempt_at is null then 'never_run'
         -- The publisher page answered, but no parser is enabled: reachable, nothing imported, no count implied.
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
         where m.source_id = s.source_id) as catalogue_product_ids
from evidence_private.sources s
left join evidence_private.source_rights sr on sr.rights_id = s.rights_id
left join evidence_private.source_freshness f on f.source_id = s.source_id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.rights_register as
select rights_id, publisher, source_url, review_status, default_release, licence_or_terms_url,
       verified_permissions, excluded_assets, attribution, reviewed_on, synced_at
from evidence_private.source_rights
where (select evidence_inspector.is_inspector());

create view evidence_inspector.import_runs as
select r.id, r.source_id, r.adapter_version, r.mode, r.trigger_kind, r.status, r.complete_snapshot,
       r.started_at, r.finished_at, r.resumed_from_run_id, r.manifest_hash, r.source_watermark,
       r.records_seen, r.versions_inserted, r.observations_inserted, r.unchanged, r.rejected,
       r.tombstoned, r.error_class, r.error_detail,
       (select count(*) from evidence_private.run_checkpoints c where c.run_id = r.id) as checkpoints
from evidence_private.import_runs r
where (select evidence_inspector.is_inspector());

create view evidence_inspector.fetch_log as
select id, run_id, source_id, request_method, request_url, request_host, attempt, outcome,
       http_status, response_bytes, body_sha256, retrieved_at, duration_ms
from evidence_private.fetch_log
where (select evidence_inspector.is_inspector());

create view evidence_inspector.ingest_errors as
select id, run_id, source_id, error_class, message, record_ref, occurred_at
from evidence_private.ingest_errors
where (select evidence_inspector.is_inspector());

create view evidence_inspector.records as
select r.id, r.source_id, s.view_scope, r.external_record_id, r.record_kind,
       coalesce(v.safe_payload ->> 'title', v.safe_payload ->> 'name_display', v.safe_payload ->> 'candidate_name') as label,
       v.source_url, v.source_published_at, v.source_date_text, v.first_retrieved_at as current_version_first_retrieved_at,
       r.first_seen_at, r.last_seen_at, r.tombstoned_at, r.tombstone_reason, r.current_version_id,
       v.content_hash as current_content_hash,
       (select count(*) from evidence_private.source_record_versions x where x.record_id = r.id) as version_count
from evidence_private.source_records r
join evidence_private.sources s on s.source_id = r.source_id
left join evidence_private.source_record_versions v on v.id = r.current_version_id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.record_versions as
select v.id, v.record_id, r.source_id, v.content_hash, v.original_content_hash, v.record_kind, v.source_url,
       v.source_published_at, v.source_date_text, v.first_retrieved_at, v.loaded_at, v.import_run_id,
       v.predecessor_id, v.projection_version, v.safe_payload, v.omitted_fields,
       (r.current_version_id = v.id) as is_current,
       (select count(*) from evidence_private.source_observations o where o.version_id = v.id) as observation_count,
       (select max(o.observed_at) from evidence_private.source_observations o where o.version_id = v.id) as last_observed_at
from evidence_private.source_record_versions v
join evidence_private.source_records r on r.id = v.record_id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.record_lifecycle_events as
select e.id, e.record_id, e.run_id, e.event, e.reason, e.occurred_at
from evidence_private.record_lifecycle_events e
where (select evidence_inspector.is_inspector());

-- Civic ------------------------------------------------------------------------------

create view evidence_inspector.person_identities as
select i.id, i.source_id, i.external_id, i.identity_scheme, i.name_at_source, i.link_status, i.person_id,
       p.display_name as linked_person_name, i.first_version_id,
       (select count(*) from evidence_private.parliamentary_service_terms t where t.person_identity_id = i.id) as service_terms,
       (select count(*) from evidence_private.candidacies c where c.person_identity_id = i.id) as candidacies,
       (select count(*) from evidence_private.identity_decisions d where d.person_identity_id = i.id and d.decision = 'proposed') as open_proposals
from evidence_private.person_source_identities i
left join evidence_private.people p on p.id = i.person_id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.people as
select p.id, p.display_name, p.public_role_basis, p.created_at,
       (select count(*) from evidence_private.person_source_identities i where i.person_id = p.id) as linked_identities
from evidence_private.people p
where (select evidence_inspector.is_inspector());

create view evidence_inspector.party_identities as
select i.id, i.source_id, i.external_id, i.name_at_source, i.link_status, i.party_id,
       p.canonical_name as linked_party_name, i.is_independent_label
from evidence_private.party_source_identities i
left join evidence_private.parties p on p.id = i.party_id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.identity_decisions as
select d.id, d.subject_kind, d.person_identity_id, d.party_identity_id, d.target_person_id, d.target_party_id,
       d.decision, d.method, d.evidence, d.decided_by, d.decided_at, d.supersedes_id
from evidence_private.identity_decisions d
where (select evidence_inspector.is_inspector());

create view evidence_inspector.service_terms as
select t.id, t.person_identity_id, i.name_at_source as member_name, i.source_id, t.parliament_number,
       t.representation, t.electorate_name_at_source, t.electorate_version_id,
       t.party_identity_id, pi.name_at_source as party_label, t.valid_from, t.valid_to, t.date_precision,
       t.basis, t.observed_first_at, t.observed_last_at, t.observed_absent_at, t.evidence_version_id
from evidence_private.parliamentary_service_terms t
join evidence_private.person_source_identities i on i.id = t.person_identity_id
left join evidence_private.party_source_identities pi on pi.id = t.party_identity_id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.party_affiliations as
select a.id, a.person_identity_id, i.name_at_source as person_name, a.party_identity_id,
       pi.name_at_source as party_label, a.valid_from, a.valid_to, a.date_precision, a.basis,
       a.observed_first_at, a.observed_last_at, a.evidence_version_id
from evidence_private.party_affiliations a
join evidence_private.person_source_identities i on i.id = a.person_identity_id
join evidence_private.party_source_identities pi on pi.id = a.party_identity_id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.elections as
select e.id, e.slug, e.title, e.election_type, e.election_date, e.election_date_basis, e.status, e.view_scope,
       (select count(*) from evidence_private.candidacies c where c.election_id = e.id) as candidacies,
       (select count(*) from evidence_private.candidacies c where c.election_id = e.id
          and c.current_status = 'officially_nominated') as officially_nominated,
       (select count(*) from evidence_private.candidacies c where c.election_id = e.id
          and c.current_status = 'announced') as announced_only
from evidence_private.elections e
where (select evidence_inspector.is_inspector());

create view evidence_inspector.electorates as
select ev.id, ev.electorate_id, el.slug, ev.name, ev.electorate_type, ev.official_code,
       be.slug as boundary_edition, be.title as boundary_edition_title, be.verified as boundary_edition_verified,
       ev.evidence_version_id
from evidence_private.electorate_versions ev
join evidence_private.electorates el on el.id = ev.electorate_id
join evidence_private.boundary_editions be on be.id = ev.boundary_edition_id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.candidacies as
select c.id, e.slug as election_slug, e.view_scope, c.candidacy_type, c.current_status,
       c.person_identity_id, i.name_at_source as candidate_name, i.link_status as identity_link_status,
       c.party_identity_id, pi.name_at_source as party_label, c.stood_as_independent,
       c.contest_id, ev.name as electorate_name, ev.electorate_type,
       ple.list_rank, cr.votes, cr.value_status as votes_status, rs.result_status,
       c.evidence_version_id
from evidence_private.candidacies c
join evidence_private.elections e on e.id = c.election_id
join evidence_private.person_source_identities i on i.id = c.person_identity_id
join evidence_private.contests ct on ct.id = c.contest_id
left join evidence_private.electorate_versions ev on ev.id = ct.electorate_version_id
left join evidence_private.party_source_identities pi on pi.id = c.party_identity_id
left join evidence_private.party_list_entries ple on ple.candidacy_id = c.id
left join evidence_private.candidate_results cr on cr.candidacy_id = c.id
left join evidence_private.result_sets rs on rs.id = cr.result_set_id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.candidacy_status_events as
select s.id, s.candidacy_id, s.status, s.status_date, s.date_precision, s.source_class, s.evidence_version_id, s.recorded_at
from evidence_private.candidacy_status_events s
where (select evidence_inspector.is_inspector());

-- Documents ----------------------------------------------------------------------------

create view evidence_inspector.documents as
select d.id, d.document_type, d.title, d.official_url, d.view_scope, r.source_id, d.source_record_id,
       r.current_version_id, v.source_published_at, v.first_retrieved_at, r.tombstoned_at,
       b.bill_number, b.bill_type, b.current_stage, b.select_committee, b.last_activity_at,
       b.member_name_at_source, b.party_label_at_source, b.parliament_number
from evidence_private.documents d
join evidence_private.source_records r on r.id = d.source_record_id
left join evidence_private.source_record_versions v on v.id = r.current_version_id
left join evidence_private.bills b on b.document_id = d.id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.finance_returns as
select f.id, f.document_id, d.official_url, d.view_scope, f.return_type, f.reporting_year, f.filing_status,
       f.filing_status_basis, f.is_image_only, f.approved_total, f.total_status,
       f.party_identity_id, f.candidacy_id
from evidence_private.finance_return_references f
join evidence_private.documents d on d.id = f.document_id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.polls as
select p.document_id, d.official_url, p.pollster, p.sponsor, p.fieldwork_start, p.fieldwork_end,
       p.sample_size, p.methodology_status
from evidence_private.polls p
join evidence_private.documents d on d.id = p.document_id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.summaries as
select s.id, s.summary_text, s.output_hash, s.uncertainty_note, s.review_status, s.created_at,
       m.metadata_status as model_metadata_status, m.provider, m.model_name, m.model_version, m.prompt_or_schema_version
from evidence_private.summary_versions s
join evidence_private.model_runs m on m.id = s.model_run_id
where (select evidence_inspector.is_inspector());

-- Statistics ---------------------------------------------------------------------------------

create view evidence_inspector.stat_series as
select s.id, d.source_id, d.dataset_key, d.title as dataset_title, s.series_key, s.title, s.unit, s.magnitude,
       s.seasonal_adjustment, s.dimensions,
       (select count(*) from evidence_private.stat_observations o where o.series_id = s.id) as observations
from evidence_private.stat_series s
join evidence_private.stat_datasets d on d.id = s.dataset_id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.stat_observations as
select o.id, o.series_id, rl.release_key, rl.released_on, g.scheme as geography_scheme, g.edition as geography_edition,
       g.code as geography_code, g.name as geography_name, o.period_label, o.period_start, o.period_end,
       o.value, o.value_double, o.raw_value, o.value_status, o.parse_status, o.row_locator, o.canonical_route
from evidence_private.stat_observations o
join evidence_private.stat_releases rl on rl.id = o.release_id
left join evidence_private.geography_versions g on g.id = o.geography_version_id
where (select evidence_inspector.is_inspector());

create view evidence_inspector.stat_route_reconciliation as
select observation_family, canonical_route, overlapping_routes, upstream_rows_by_route, decision_note, decided_by, decided_at
from evidence_private.stat_route_reconciliation
where (select evidence_inspector.is_inspector());

-- Operations -----------------------------------------------------------------------------------

create view evidence_inspector.schedules as
select s.schedule_key, s.source_id, s.cron_expr, s.function_slug, s.max_runtime_seconds, s.max_records,
       s.state, s.cron_jobid, s.activated_by, s.activated_at, s.activation_proof,
       (select max(l.dispatched_at) from evidence_private.schedule_dispatch_log l where l.schedule_key = s.schedule_key) as last_dispatch_at,
       (select l.outcome from evidence_private.schedule_dispatch_log l where l.schedule_key = s.schedule_key
         order by l.dispatched_at desc limit 1) as last_dispatch_outcome
from evidence_private.ingest_schedules s
where (select evidence_inspector.is_inspector());

create view evidence_inspector.release_gates as
select gate_key, state, evidence_reference, decided_by, decided_at
from evidence_private.release_gates
where (select evidence_inspector.is_inspector());

create view evidence_inspector.coverage_by_scope as
select s.view_scope,
       count(distinct s.source_id) as sources,
       count(distinct s.source_id) filter (where f.last_success_at is not null) as sources_with_a_successful_run,
       count(distinct s.source_id) filter (where f.last_attempt_status in ('blocked', 'failed')) as sources_currently_unavailable,
       count(r.id) filter (where r.tombstoned_at is null) as live_records,
       max(f.last_success_at) as latest_successful_retrieval
from evidence_private.sources s
left join evidence_private.source_freshness f on f.source_id = s.source_id
left join evidence_private.source_records r on r.source_id = s.source_id
where (select evidence_inspector.is_inspector())
group by s.view_scope;

-- Relationship edges for the bounded graph. The client asks for the edges of one
-- node at a time with a row limit; nothing here returns the whole graph at once.

create view evidence_inspector.graph_edges as
select * from (
  select 'aff:' || a.id as edge_id, 'person_identity' as from_kind, a.person_identity_id::text as from_id,
         i.name_at_source as from_label, 'party_identity' as to_kind, a.party_identity_id::text as to_id,
         pi.name_at_source as to_label, 'observed party affiliation' as relationship, a.evidence_version_id
  from evidence_private.party_affiliations a
  join evidence_private.person_source_identities i on i.id = a.person_identity_id
  join evidence_private.party_source_identities pi on pi.id = a.party_identity_id
  union all
  select 'term:' || t.id, 'person_identity', t.person_identity_id::text, i.name_at_source,
         'electorate_label', 'electorate:' || t.electorate_name_at_source, t.electorate_name_at_source,
         'observed as electorate member', t.evidence_version_id
  from evidence_private.parliamentary_service_terms t
  join evidence_private.person_source_identities i on i.id = t.person_identity_id
  where t.representation = 'electorate'
  union all
  select 'link:' || i.id, 'person_identity', i.id::text, i.name_at_source, 'person', i.person_id::text,
         p.display_name, 'reviewed identity link', i.first_version_id
  from evidence_private.person_source_identities i
  join evidence_private.people p on p.id = i.person_id
  union all
  select 'cand:' || c.id, 'person_identity', c.person_identity_id::text, i.name_at_source,
         case when c.candidacy_type = 'electorate' then 'electorate_version' else 'election' end,
         case when c.candidacy_type = 'electorate' then ct.electorate_version_id::text else c.election_id::text end,
         case when c.candidacy_type = 'electorate' then ev.name || ' (' || e.slug || ')' else e.title || ' party list' end,
         c.candidacy_type || ' candidacy: ' || c.current_status, c.evidence_version_id
  from evidence_private.candidacies c
  join evidence_private.person_source_identities i on i.id = c.person_identity_id
  join evidence_private.contests ct on ct.id = c.contest_id
  join evidence_private.elections e on e.id = c.election_id
  left join evidence_private.electorate_versions ev on ev.id = ct.electorate_version_id
  union all
  select 'candparty:' || c.id, 'person_identity', c.person_identity_id::text, i.name_at_source,
         'party_identity', c.party_identity_id::text, pi.name_at_source, 'stood for party (' || e.slug || ')', c.evidence_version_id
  from evidence_private.candidacies c
  join evidence_private.person_source_identities i on i.id = c.person_identity_id
  join evidence_private.party_source_identities pi on pi.id = c.party_identity_id
  join evidence_private.elections e on e.id = c.election_id
  union all
  select 'vpl:' || l.id, 'record_version', l.version_id::text, coalesce(v.safe_payload ->> 'title', v.record_kind),
         'person_identity', l.person_identity_id::text, i.name_at_source, l.relationship_type || ' (' || l.review_status || ')', l.version_id
  from evidence_private.version_person_links l
  join evidence_private.source_record_versions v on v.id = l.version_id
  join evidence_private.person_source_identities i on i.id = l.person_identity_id
) edges
where (select evidence_inspector.is_inspector());

-- Ownership, barrier and grants --------------------------------------------------------------------

do $$
declare
  v_view text;
begin
  for v_view in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'evidence_inspector' and c.relkind = 'v'
  loop
    execute format('alter view evidence_inspector.%I set (security_barrier = true)', v_view);
    execute format('alter view evidence_inspector.%I owner to evidence_inspector_reader', v_view);
    execute format('revoke all on evidence_inspector.%I from public, anon, authenticated', v_view);
    execute format('grant select on evidence_inspector.%I to authenticated', v_view);
  end loop;
end
$$;

revoke create on schema evidence_inspector from evidence_inspector_reader;
