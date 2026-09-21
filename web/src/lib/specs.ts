import { CANDIDACY_STATUSES, FRESHNESS_STATUSES, SCOPE_ORDER } from './format'
import { isAcceptableGenericSortKey } from './generic-sort'
import type { ListSpec } from './search'

/** One spec per list: the only sort columns and filter values a URL can ever send to the server. */

export const RECORD_KINDS_HINT = ['mp_directory_entry', 'bill', 'release', 'baseline_2023_candidacy'] as const

export const sourcesSpec = {
  sortable: ['source_id', 'title', 'publisher', 'view_scope', 'freshness_status', 'last_success_at', 'latest_source_published_at', 'live_records', 'enabled', 'rights_review_status'],
  defaultSort: [{ column: 'source_id', dir: 'asc' }],
  tiebreak: 'source_id',
  filters: {
    scope: { kind: 'enum', values: SCOPE_ORDER },
    freshness: { kind: 'enum', values: FRESHNESS_STATUSES },
    publisher: { kind: 'text' },
  },
} as const satisfies ListSpec

export const recordsSpec = {
  sortable: ['label', 'record_kind', 'source_id', 'view_scope', 'source_published_at', 'first_seen_at', 'last_seen_at', 'version_count'],
  defaultSort: [{ column: 'last_seen_at', dir: 'desc' }],
  tiebreak: 'id',
  filters: {
    source: { kind: 'text', maxLength: 63 },
    kind: { kind: 'text', maxLength: 63 },
    scope: { kind: 'enum', values: SCOPE_ORDER },
    q: { kind: 'text' },
    tombstoned: { kind: 'enum', values: ['include', 'only'] },
  },
} as const satisfies ListSpec

/**
 * R1: names and link state only. The per-person counts (service terms, candidacies, open proposals) are shown
 * but are not sort keys, the same stance candidaciesSpec takes with votes: no "by person" ordering by a number.
 */
export const identitiesSpec = {
  sortable: ['name_at_source', 'source_id', 'link_status'],
  defaultSort: [{ column: 'name_at_source', dir: 'asc' }],
  tiebreak: 'id',
  filters: {
    q: { kind: 'text' },
    source: { kind: 'text', maxLength: 63 },
    link: { kind: 'enum', values: ['unresolved', 'proposed', 'approved', 'rejected'] },
  },
} as const satisfies ListSpec

export const parliamentSpec = {
  sortable: ['member_name', 'party_label', 'representation', 'electorate_name_at_source', 'observed_first_at', 'observed_last_at'],
  defaultSort: [{ column: 'member_name', dir: 'asc' }],
  tiebreak: 'id',
  filters: {
    party: { kind: 'text' },
    representation: { kind: 'enum', values: ['electorate', 'list'] },
    source: { kind: 'text', maxLength: 63 },
  },
} as const satisfies ListSpec

/**
 * R1: vote counts are deliberately not sortable and the default order is alphabetical
 * (electorate, then candidate name). Nothing in this list can be arranged as a ranking.
 */
export const candidaciesSpec = {
  sortable: ['electorate_name', 'candidate_name', 'party_label', 'candidacy_type', 'current_status'],
  defaultSort: [
    { column: 'electorate_name', dir: 'asc' },
    { column: 'candidate_name', dir: 'asc' },
  ],
  tiebreak: 'id',
  filters: {
    status: { kind: 'enum', values: CANDIDACY_STATUSES },
    type: { kind: 'enum', values: ['electorate', 'list'] },
    electorate: { kind: 'text' },
    party: { kind: 'text' },
  },
} as const satisfies ListSpec

export const DOCUMENT_TYPES = ['bill', 'written_question', 'committee_report', 'release', 'policy_source', 'poll', 'finance_return', 'other'] as const

export const documentsSpec = {
  sortable: ['title', 'document_type', 'view_scope', 'source_id', 'source_published_at', 'first_retrieved_at'],
  defaultSort: [{ column: 'title', dir: 'asc' }],
  tiebreak: 'id',
  filters: {
    type: { kind: 'enum', values: DOCUMENT_TYPES },
    scope: { kind: 'enum', values: SCOPE_ORDER },
    q: { kind: 'text' },
    source: { kind: 'text', maxLength: 63 },
  },
} as const satisfies ListSpec

export const financeSpec = {
  sortable: ['return_type', 'reporting_year', 'filing_status'],
  defaultSort: [
    { column: 'reporting_year', dir: 'desc' },
    { column: 'return_type', dir: 'asc' },
  ],
  tiebreak: 'id',
  filters: {
    type: { kind: 'enum', values: ['candidate_return', 'party_annual_return', 'party_election_return', 'party_donation_disclosure', 'party_loan_disclosure'] },
    filing: { kind: 'enum', values: ['filed', 'filed_late', 'nil_return', 'not_filed', 'unknown'] },
  },
} as const satisfies ListSpec

/**
 * The disclosures inside filed returns. Sorting defaults to the largest amount in the most recent year, which is
 * the order the Commission's own form prints them in; nothing is ranked across returns.
 */
export const donationsSpec = {
  sortable: ['reporting_year', 'disclosed_amount_nzd', 'donor_name_as_published', 'party_name_as_published'],
  defaultSort: [
    { column: 'reporting_year', dir: 'desc' },
    { column: 'disclosed_amount_nzd', dir: 'desc' },
  ],
  // `entry_index` is a content column: on a deployment that releases these returns as links only it is
  // null in every row, and an ordering made only of nulls is no ordering — the same page could come
  // back twice and another never. The link is published whatever the release state, so it orders last.
  tiebreak: ['entry_index', 'official_url'],
  filters: {
    kind: { kind: 'enum', values: ['donation', 'loan', 'expense'] },
    identity: { kind: 'enum', values: ['named', 'anonymous', 'protected_from_disclosure', 'overseas', 'not_itemised'] },
    year: { kind: 'enum', values: ['2023', '2025'] },
    q: { kind: 'text' },
  },
} as const satisfies ListSpec

export const statSeriesSpec = {
  sortable: ['dataset_title', 'title', 'series_key', 'unit', 'observations'],
  defaultSort: [
    { column: 'dataset_title', dir: 'asc' },
    { column: 'series_key', dir: 'asc' },
  ],
  tiebreak: 'id',
  filters: {
    q: { kind: 'text' },
    series: { kind: 'text', maxLength: 36 },
  },
} as const satisfies ListSpec

export const statObservationsSpec = {
  sortable: ['period_label', 'period_start', 'value_status', 'geography_name'],
  defaultSort: [{ column: 'period_start', dir: 'desc' }],
  tiebreak: 'id',
  filters: statSeriesSpec.filters,
} as const satisfies ListSpec

export const rightsSpec = {
  sortable: ['rights_id', 'publisher', 'review_status', 'default_release', 'reviewed_on'],
  defaultSort: [{ column: 'rights_id', dir: 'asc' }],
  tiebreak: 'rights_id',
  filters: {
    status: { kind: 'enum', values: ['pending', 'approved', 'restricted', 'refused'] },
    publisher: { kind: 'text' },
  },
} as const satisfies ListSpec

export const RUN_STATUSES = ['running', 'succeeded', 'partial', 'failed', 'blocked', 'abandoned'] as const

export const runsSpec = {
  sortable: ['started_at', 'finished_at', 'source_id', 'status', 'records_seen'],
  defaultSort: [{ column: 'started_at', dir: 'desc' }],
  tiebreak: 'id',
  filters: {
    tab: { kind: 'enum', values: ['runs', 'errors', 'schedules'] },
    source: { kind: 'text', maxLength: 63 },
    status: { kind: 'enum', values: RUN_STATUSES },
  },
} as const satisfies ListSpec

export const errorsSpec = {
  sortable: ['occurred_at', 'source_id', 'error_class'],
  defaultSort: [{ column: 'occurred_at', dir: 'desc' }],
  tiebreak: 'id',
  filters: runsSpec.filters,
} as const satisfies ListSpec

export const schedulesSpec = {
  sortable: ['schedule_key', 'source_id', 'state'],
  defaultSort: [{ column: 'schedule_key', dir: 'asc' }],
  tiebreak: 'schedule_key',
  filters: runsSpec.filters,
} as const satisfies ListSpec

/** Source detail has several small paginated panels; only the run list is URL-driven. */
export const sourceDetailSpec = {
  sortable: ['started_at', 'status'],
  defaultSort: [{ column: 'started_at', dir: 'desc' }],
  tiebreak: 'id',
  filters: {},
} as const satisfies ListSpec

function union(...lists: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(lists.flat())]
}

/** Tabbed routes validate the URL against the union of their tabs' sort columns. */
export const statisticsRouteSpec = { ...statSeriesSpec, sortable: union(statSeriesSpec.sortable, statObservationsSpec.sortable) } satisfies ListSpec
export const operationsRouteSpec = { ...runsSpec, sortable: union(runsSpec.sortable, errorsSpec.sortable, schedulesSpec.sortable) } satisfies ListSpec

export type FilterKeys<S extends ListSpec> = Extract<keyof S['filters'], string>

export const datasetsSpec = {
  sortable: ['dataset', 'exposed_schema', 'dataset_kind', 'disposition', 'columns_total', 'columns_withheld', 'approximate_rows'],
  defaultSort: [
    { column: 'exposed_schema', dir: 'asc' },
    { column: 'dataset', dir: 'asc' },
  ],
  tiebreak: 'dataset',
  filters: {
    layer: { kind: 'enum', values: ['evidence_open', 'evidence_public'] },
    disposition: { kind: 'enum', values: ['public', 'withheld'] },
    q: { kind: 'text', maxLength: 63 },
  },
} as const satisfies ListSpec

/**
 * Generic row browser: the columns are only known at run time, so the URL is held to a shape test that already
 * refuses every result-like name (R1, lib/generic-sort.ts); the page then narrows to the non-numeric published columns.
 */
export const datasetRowsSpec = {
  sortable: [],
  acceptsSortKey: isAcceptableGenericSortKey,
  defaultSort: [],
  tiebreak: '',
  filters: {},
} as const satisfies ListSpec
