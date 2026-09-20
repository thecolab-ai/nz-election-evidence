/**
 * Compile-time contract between the page-level row shapes (types.ts) and the GENERATED database types.
 * For each pair: every key the UI reads must exist in the generated view row, and the database's
 * non-null value type must fit the UI's. A migration that renames, removes, withholds or retypes a
 * column therefore fails `npm run typecheck` once `npm run types:generate` has been run - and CI
 * fails earlier still if the generated file was not refreshed (`npm run types:check`).
 */
import type { PublicRow, PublicViewName } from './supabase'
import type * as T from './types'

type Fits<Hand, Gen> = {
  [K in keyof Hand]-?: K extends keyof Gen
    ? [NonNullable<Gen[K]>] extends [NonNullable<Hand[K]>] ? true : ['type differs from database', K]
    : ['column missing from the public view', K]
}[keyof Hand]

// Anything other than `true` in the union is a mismatch; excluding `true` leaves a type the literal `true` cannot satisfy.
type Check<Hand, V extends PublicViewName> = [Fits<Hand, PublicRow<V>>] extends [true] ? true : Exclude<Fits<Hand, PublicRow<V>>, true>

export const CONTRACT: {
  sources: Check<T.SourceRow, 'sources'>
  rights_register: Check<T.RightsRow, 'rights_register'>
  import_runs: Check<T.ImportRunRow, 'import_runs'>
  fetch_log: Check<T.FetchLogRow, 'fetch_log'>
  ingest_errors: Check<T.IngestErrorRow, 'ingest_errors'>
  records: Check<T.RecordRow, 'records'>
  record_versions: Check<T.RecordVersionRow, 'record_versions'>
  record_lifecycle_events: Check<T.LifecycleEventRow, 'record_lifecycle_events'>
  person_identities: Check<T.PersonIdentityRow, 'person_identities'>
  people: Check<T.PersonRow, 'people'>
  identity_decisions: Check<T.IdentityDecisionRow, 'identity_decisions'>
  service_terms: Check<T.ServiceTermRow, 'service_terms'>
  party_affiliations: Check<T.PartyAffiliationRow, 'party_affiliations'>
  elections: Check<T.ElectionRow, 'elections'>
  candidacies: Check<T.CandidacyRow, 'candidacies'>
  documents: Check<T.DocumentRow, 'documents'>
  finance_returns: Check<T.FinanceReturnRow, 'finance_returns'>
  summaries: Check<T.SummaryRow, 'summaries'>
  stat_series: Check<T.StatSeriesRow, 'stat_series'>
  stat_observations: Check<T.StatObservationRow, 'stat_observations'>
  stat_route_reconciliation: Check<T.StatRouteRow, 'stat_route_reconciliation'>
  schedules: Check<T.ScheduleRow, 'schedules'>
  release_gates: Check<T.ReleaseGateRow, 'release_gates'>
  coverage_by_scope: Check<T.CoverageRow, 'coverage_by_scope'>
  surface_status: Check<T.SurfaceStatusRow, 'surface_status'>
  dataset_catalogue: Check<T.DatasetCatalogueRow, 'dataset_catalogue'>
  dataset_columns: Check<T.DatasetColumnRow, 'dataset_columns'>
} = {
  sources: true, rights_register: true, import_runs: true, fetch_log: true, ingest_errors: true, records: true,
  record_versions: true, record_lifecycle_events: true, person_identities: true, people: true, identity_decisions: true,
  service_terms: true, party_affiliations: true, elections: true, candidacies: true, documents: true, finance_returns: true,
  summaries: true, stat_series: true, stat_observations: true, stat_route_reconciliation: true, schedules: true,
  release_gates: true, coverage_by_scope: true, surface_status: true, dataset_catalogue: true, dataset_columns: true,
}
