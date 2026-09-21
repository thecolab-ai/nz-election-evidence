import generated from './release-coverage.json' with { type: 'json' }

/**
 * Coverage of the project's 26-product catalogue, in two parts that are kept apart on purpose.
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

/**
 * The columns of the public `sources` view this statement reads. Declared here so release tooling can import this
 * file on its own.
 *
 * `live_records` is deliberately absent: it is a correlated `count(*)` over the record table, once per source row,
 * and reading it here timed out on the live store (HTTP 500, `57014`, 3.84 s cold) for the first anonymous reader
 * of `/overview`. The statistics figures stay, because they are written by the loader when a load finishes and read
 * from a summary row, not recounted per request. Whether a ledger route holds anything is answered by a bounded
 * existence probe instead (see `RecordPresence`), and the number itself is read on the source's own page.
 */
export interface HeldSource {
  source_id: string
  statistical_observations: number | string | null
  statistical_catalogue_entries: number | string | null
  last_success_at: string | null
}

/**
 * The answer to one bounded existence question per ledger route: did the store return a record for this source?
 * A source absent from the map has not been answered for — that is unknown, and is never read as a no.
 */
export type RecordPresence = ReadonlyMap<string, boolean>

/** A source row the store returned whose record count is not a cheap read: it is not a statistics source. */
export function isLedgerSource(source: HeldSource): boolean {
  return source.statistical_observations === null || source.statistical_observations === undefined
}

/**
 * The ledger route sources of the catalogue that the store actually returned. These are the only sources worth
 * probing: a statistics source's holdings are already counted exactly in the row, and a source the store did not
 * return (its rights allow no release) must not be asked about at all.
 */
export function ledgerRouteIds(sources: readonly HeldSource[], rows: readonly ProductCoverage[] = RELEASE_COVERAGE): string[] {
  const routes = new Set(rows.flatMap((row) => [...row.backfill_source_ids, ...row.refresh_source_ids]))
  return [...new Set(sources.filter((s) => routes.has(s.source_id) && isLedgerSource(s)).map((s) => s.source_id))]
}

/** What ONE route of a product holds. Routes to the same publisher items overlap, so they are never added together. */
export interface RouteHeld {
  source_id: string
  /**
   * Source records this route holds. Always null: this panel does not count them, because that count is the slowest
   * query the store serves. Kept in the shape so a reader of these rows cannot mistake the absence for a zero.
   */
  ledger_records: null
  statistical_observations: number
  catalogue_entries: number
  /** A bounded existence probe found at least one source record for this route. The number is not read here. */
  holds_records: boolean
}

export interface ProductHeld {
  /** Sources of this product the store returned (a source whose rights allow no release is not returned at all). */
  sources_seen: number
  /** Routes that hold at least one row, each with its own figures. */
  routes: RouteHeld[]
  held: boolean
  /** Routes the store returned but whose contents this page has no answer for. Unknown, and never read as empty. */
  undetermined: string[]
}

/**
 * What the store holds for one product, route by route, from the rows of the public `sources` view. A product's
 * routes reach overlapping publisher items (an export and a live fetch of the same questions), so no total across
 * routes is ever computed or shown: a sum would count the same item two or three times.
 *
 * A statistics route brings its own exact figures. A ledger route brings none: it is held when, and only when,
 * `presence` carries a yes for it from an existence probe. A ledger route the probe has not answered for is
 * reported as undetermined, not as empty — the two are different things and are never merged here.
 */
export function heldFor(product: ProductCoverage, sources: readonly HeldSource[], presence: RecordPresence = new Map()): ProductHeld {
  // A statistics source is both the backfill and the refresh route of its product: one source, counted once.
  const ids = [...new Set([...product.backfill_source_ids, ...product.refresh_source_ids])]
  const mine = ids.map((id) => sources.find((s) => s.source_id === id)).filter((s): s is HeldSource => s !== undefined)
  const routes: RouteHeld[] = []
  const undetermined: string[] = []
  for (const s of mine) {
    const observations = Number(s.statistical_observations ?? 0)
    const entries = Number(s.statistical_catalogue_entries ?? 0)
    const probed = isLedgerSource(s) ? presence.get(s.source_id) : false
    if (observations + entries > 0 || probed === true) {
      routes.push({ source_id: s.source_id, ledger_records: null, statistical_observations: observations, catalogue_entries: entries, holds_records: probed === true })
    } else if (probed === undefined) {
      undetermined.push(s.source_id)
    }
  }
  return { sources_seen: mine.length, routes, held: routes.length > 0, undetermined }
}

export function coverageCounts(rows: readonly ProductCoverage[] = RELEASE_COVERAGE): { total: number; with_backfill_route: number; with_refresh_route: number; without_refresh_route: number } {
  const refreshed = rows.filter((row) => row.refresh === 'scheduled' || row.refresh === 'operator_run').length
  return { total: rows.length, with_backfill_route: rows.filter((row) => row.backfill_source_ids.length > 0).length, with_refresh_route: refreshed, without_refresh_route: rows.length - refreshed }
}
