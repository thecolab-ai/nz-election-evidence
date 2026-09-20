/**
 * Row shapes the pages rely on. Each one is checked at compile time against the GENERATED database
 * types (src/lib/contract.ts): a column that is renamed, removed, withheld or retyped in a migration
 * stops the build. These shapes only add what Postgres cannot say about a view: which columns are
 * in practice never null.
 * Postgres bigint/numeric arrive as number or string depending on size, hence `Numeric`.
 */
export type Numeric = number | string
/** JSON exactly as the generated database types describe it. */
export type { Json } from './database.types'
import type { Json } from './database.types'

export interface SourceRow {
  source_id: string
  title: string
  publisher: string
  official_url: string
  adapter_kind: string
  adapter_name: string
  allowed_hosts: string[]
  view_scope: string
  snapshot_semantics: string
  expected_cadence_seconds: number | null
  enabled: boolean
  blocked_reason: string | null
  registry_key: string | null
  rights_id: string | null
  rights_review_status: string
  rights_default_release: string
  /** A source at tier none is not listed at all, so only link_only and fields are seen here. */
  public_release_tier: string
  public_approved_fields: string[]
  last_attempt_at: string | null
  last_attempt_status: string | null
  last_success_at: string | null
  last_change_at: string | null
  latest_source_published_at: string | null
  consecutive_failures: number | null
  last_error_class: string | null
  freshness_status: string
  live_records: Numeric
  tombstoned_records: Numeric
  content_versions: Numeric
  catalogue_product_ids: string[]
}

export interface RightsRow {
  rights_id: string
  publisher: string
  source_url: string
  review_status: string
  default_release: string
  licence_or_terms_url: string | null
  verified_permissions: string | null
  excluded_assets: string | null
  attribution: string | null
  reviewed_on: string | null
  synced_at: string | null
}

export interface ImportRunRow {
  id: string
  source_id: string
  adapter_version: string
  mode: string
  trigger_kind: string
  status: string
  complete_snapshot: boolean | null
  started_at: string
  finished_at: string | null
  resumed_from_run_id: string | null
  manifest_hash: string | null
  records_seen: Numeric | null
  versions_inserted: Numeric | null
  observations_inserted: Numeric | null
  unchanged: Numeric | null
  rejected: Numeric | null
  tombstoned: Numeric | null
  error_class: string | null
  checkpoints: Numeric
}

export interface FetchLogRow {
  id: Numeric
  run_id: string
  source_id: string
  request_method: string
  request_url: string
  request_host: string
  attempt: number
  outcome: string
  http_status: number | null
  response_bytes: Numeric | null
  body_sha256: string | null
  retrieved_at: string
  duration_ms: number | null
}

export interface IngestErrorRow {
  id: Numeric
  run_id: string | null
  source_id: string
  error_class: string
  occurred_at: string
}

export interface RecordRow {
  id: string
  source_id: string
  view_scope: string
  external_record_id: string | null
  record_kind: string
  label: string | null
  source_url: string | null
  source_published_at: string | null
  source_date_text: string | null
  current_version_first_retrieved_at: string | null
  first_seen_at: string
  last_seen_at: string
  tombstoned_at: string | null
  tombstone_reason: string | null
  current_version_id: string | null
  current_content_hash: string | null
  version_count: Numeric
}

export interface RecordVersionRow {
  id: string
  record_id: string
  source_id: string
  content_hash: string
  original_content_hash: string | null
  record_kind: string
  source_url: string
  source_published_at: string | null
  source_date_text: string | null
  first_retrieved_at: string
  loaded_at: string
  import_run_id: string
  predecessor_id: string | null
  projection_version: number
  safe_payload: Json
  omitted_fields: Json
  is_current: boolean
  observation_count: Numeric
  last_observed_at: string | null
}

export interface LifecycleEventRow {
  id: Numeric
  record_id: string
  run_id: string | null
  event: string
  occurred_at: string
}

export interface PersonIdentityRow {
  id: string
  source_id: string
  external_id: string | null
  identity_scheme: string
  name_at_source: string | null
  link_status: string
  first_version_id: string | null
  service_terms: Numeric
  candidacies: Numeric
  open_proposals: Numeric
}

export interface IdentityDecisionRow {
  id: string
  subject_kind: string
  person_identity_id: string | null
  party_identity_id: string | null
  decision: string
  method: string
  evidence: Json
  decided_at: string | null
  supersedes_id: string | null
}

export interface ServiceTermRow {
  id: string
  person_identity_id: string
  member_name: string | null
  source_id: string
  parliament_number: number | null
  representation: string | null
  electorate_name_at_source: string | null
  electorate_version_id: string | null
  party_identity_id: string | null
  party_label: string | null
  valid_from: string | null
  valid_to: string | null
  date_precision: string
  basis: string
  observed_first_at: string
  observed_last_at: string
  observed_absent_at: string | null
  evidence_version_id: string
}

export interface PartyAffiliationRow {
  id: string
  person_identity_id: string
  person_name: string
  party_identity_id: string
  party_label: string | null
  valid_from: string | null
  valid_to: string | null
  date_precision: string
  basis: string
  observed_first_at: string
  observed_last_at: string
  evidence_version_id: string
}

export interface ElectionRow {
  id: string
  slug: string
  title: string
  election_type: string
  election_date: string | null
  election_date_basis: string | null
  status: string
  view_scope: string
}

export interface CandidacyRow {
  id: string
  election_slug: string
  view_scope: string
  candidacy_type: string | null
  current_status: string | null
  person_identity_id: string
  candidate_name: string | null
  identity_link_status: string
  party_identity_id: string | null
  party_label: string | null
  stood_as_independent: boolean
  contest_id: string
  electorate_name: string | null
  electorate_type: string | null
  list_rank: number | null
  votes: Numeric | null
  votes_status: string | null
  result_status: string | null
  evidence_version_id: string
  electorate_version_id: string | null
}

export interface DocumentRow {
  id: string
  document_type: string
  title: string | null
  official_url: string
  view_scope: string
  source_id: string
  source_record_id: string
  current_version_id: string | null
  source_published_at: string | null
  first_retrieved_at: string | null
  tombstoned_at: string | null
  bill_number: string | null
  bill_type: string | null
  current_stage: string | null
  select_committee: string | null
  last_activity_at: string | null
  member_name_at_source: string | null
  party_label_at_source: string | null
  parliament_number: number | null
}

export interface FinanceReturnRow {
  id: string
  document_id: string
  official_url: string
  view_scope: string
  return_type: string
  reporting_year: number | null
  filing_status: string
  filing_status_basis: string | null
  is_image_only: boolean | null
  approved_total: Numeric | null
  total_status: string
  party_identity_id: string | null
  candidacy_id: string | null
}

export interface SummaryRow {
  id: string
  summary_text: string
  output_hash: string
  uncertainty_note: string | null
  review_status: string
  created_at: string
  model_metadata_status: string
  provider: string | null
  model_name: string | null
  model_version: string | null
  prompt_or_schema_version: string | null
}

export interface StatSeriesRow {
  id: string
  source_id: string
  dataset_key: string
  dataset_title: string
  series_key: string
  title: string | null
  unit: string | null
  magnitude: string | null
  seasonal_adjustment: string | null
  dimensions: Json
  observations: Numeric
}

export interface StatObservationRow {
  id: Numeric
  series_id: string
  release_key: string
  released_on: string | null
  geography_scheme: string | null
  geography_edition: string | null
  geography_code: string | null
  geography_name: string | null
  period_label: string
  period_start: string | null
  period_end: string | null
  value: Numeric | null
  value_double: number | null
  raw_value: string | null
  value_status: string
  parse_status: string
  row_locator: string | null
  canonical_route: string
}

export interface StatRouteRow {
  observation_family: string
  canonical_route: string
  overlapping_routes: Json
  upstream_rows_by_route: Json
  decision_note: string | null
  decided_at: string | null
}

export interface ScheduleRow {
  schedule_key: string
  source_id: string
  cron_expr: string
  function_slug: string
  max_runtime_seconds: number
  max_records: number
  state: string
  cron_jobid: Numeric | null
  activated_at: string | null
  activation_proof: Json
  last_dispatch_at: string | null
  last_dispatch_outcome: string | null
}

export interface ReleaseGateRow {
  gate_key: string
  state: string
  evidence_reference: string | null
  decided_at: string | null
}

export interface CoverageRow {
  view_scope: string
  sources: Numeric
  sources_with_a_successful_run: Numeric
  sources_currently_unavailable: Numeric
  live_records: Numeric
  latest_successful_retrieval: string | null
}

export interface SurfaceStatusRow {
  gate_key: string | null
  state: string | null
  evidence_reference: string | null
  decided_at: string | null
  public_rows_released: boolean | null
}

export interface DatasetCatalogueRow {
  exposed_schema: string
  dataset: string
  dataset_kind: string
  disposition: string
  withheld_reason: string | null
  row_rule_reason: string | null
  lineage_kind: string | null
  lineage_note: string | null
  columns_rights_gated: number
  description: string | null
  columns_total: number
  columns_withheld: number
  approximate_rows: Numeric | null
}

export interface DatasetColumnRow {
  exposed_schema: string
  dataset: string
  ordinal: number
  column_name: string
  data_type: string
  nullable: boolean
  disposition: string
  withheld_reason: string | null
  field_token: string | null
  description: string | null
}

export interface PartyIdentityRow {
  id: string
  source_id: string
  external_id: string | null
  name_at_source: string | null
  link_status: string
  is_independent_label: boolean | null
}

export interface ElectorateVersionRow {
  id: string
  electorate_id: string
  slug: string | null
  name: string | null
  electorate_type: string | null
  official_code: string | null
  boundary_edition: string | null
  boundary_edition_title: string | null
  boundary_edition_verified: boolean | null
  evidence_version_id: string | null
}
