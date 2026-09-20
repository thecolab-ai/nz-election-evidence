import generated from './release-coverage.json' with { type: 'json' }

/**
 * Coverage of the project's 24-product catalogue, in two parts that are kept apart on purpose.
 *
 *   ROUTES (static, generated)   which import routes exist for a product: a backfill from a verified private export,
 *                                and how the product is kept current. Generated from the ingestion route coverage
 *                                (ingest/src/loaders/coverage.ts) and held equal to it by a test. A route is a way in;
 *                                it is never a claim that anything has been loaded.
 *   HELD (read from the store)   what this store really holds for the product right now, from the rights-filtered
 *                                public `sources` view. Nothing is shown as held unless the database says so.
 */
export type RefreshKind = 'scheduled' | 'operator_run' | 'exercised_only' | 'pending_decision' | 'none'

export interface ProductCoverage {
  product_id: string
  title: string
  publisher: string
  catalogue_record_count: number
  backfill_source_ids: string[]
  refresh_source_ids: string[]
  refresh: RefreshKind
  /** Why there is no working refresh route, where that is the case. */
  refresh_gap: string | null
}

export const RELEASE_COVERAGE: readonly ProductCoverage[] = generated.products as ProductCoverage[]

/** What is NOT published for the 2026 election by any route. Unknown and unpublished: never zero, never "none". */
export const NOT_PUBLISHED_FOR_2026: readonly string[] = generated.not_published_for_2026

export const REFRESH_LABELS: Record<RefreshKind, string> = {
  scheduled: 'Refreshed by a scheduled fetch',
  operator_run: 'Refreshed by an operator-run fetch',
  exercised_only: 'Refresh route tested, not yet run in full',
  pending_decision: 'Refresh route waits on a decision',
  none: 'No refresh route',
}

/** The columns of the public `sources` view this statement reads. Declared here so release tooling can import this file on its own. */
export interface HeldSource {
  source_id: string
  live_records: number | string | null
  statistical_observations: number | string | null
  statistical_catalogue_entries: number | string | null
  last_success_at: string | null
}

export interface ProductHeld {
  /** Sources of this product the store returned (a source whose rights allow no release is not returned at all). */
  sources_seen: number
  /** Sources with at least one successful load or fetch. */
  sources_loaded: number
  ledger_records: number
  statistical_observations: number
  catalogue_entries: number
  held: boolean
}

/**
 * What the store holds for one product, from the rows of the public `sources` view. Counts of different sources of
 * one product are routes to overlapping publisher items, so they are shown per source elsewhere; here they only
 * decide whether anything is held at all. They are never presented as one total of distinct items.
 */
export function heldFor(product: ProductCoverage, sources: readonly HeldSource[]): ProductHeld {
  const ids = new Set([...product.backfill_source_ids, ...product.refresh_source_ids])
  const mine = sources.filter((s) => ids.has(s.source_id))
  const sum = (pick: (s: HeldSource) => unknown) => mine.reduce((total, s) => total + Number(pick(s) ?? 0), 0)
  const ledger = sum((s) => s.live_records)
  const observations = sum((s) => s.statistical_observations)
  const entries = sum((s) => s.statistical_catalogue_entries)
  return {
    sources_seen: mine.length, sources_loaded: mine.filter((s) => s.last_success_at).length,
    ledger_records: ledger, statistical_observations: observations, catalogue_entries: entries, held: ledger + observations + entries > 0,
  }
}

export function coverageCounts(rows: readonly ProductCoverage[] = RELEASE_COVERAGE): { total: number; with_backfill_route: number; with_refresh_route: number; without_refresh_route: number } {
  const refreshed = rows.filter((row) => row.refresh === 'scheduled' || row.refresh === 'operator_run').length
  return { total: rows.length, with_backfill_route: rows.filter((row) => row.backfill_source_ids.length > 0).length, with_refresh_route: refreshed, without_refresh_route: rows.length - refreshed }
}
