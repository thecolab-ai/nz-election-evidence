import type { SourceRow } from './types'

/**
 * The columns of the public `sources` view the overview reads, and no others.
 *
 * `live_records` is deliberately absent. It is a correlated `count(*)` over the record table evaluated once per
 * source row, and one source alone holds 187,956 records; asking for it here made the first anonymous read of
 * `/overview` after a quiet period take 3.84 s and return HTTP 500 (`57014`, statement timeout) from the live
 * store. The same read without it answered in 0.17 s. Record counts are read on a source's own page, for that one
 * source. A scope card says where, and never prints a zero in place of a count it did not ask for.
 */
export type CoverageSource = Pick<SourceRow, 'view_scope' | 'freshness_status' | 'last_success_at'>

/** Coverage of one scope. There is no record count here: this shape carries only what the page actually read. */
export interface ScopeCoverage {
  view_scope: string
  sources: number
  sources_with_a_successful_run: number
  sources_currently_unavailable: number
  latest_successful_retrieval: string | null
}

/**
 * Coverage by scope, derived in the browser from the rights-filtered public `sources` view. The database
 * does not publish a cross-source aggregate, because it would count sources whose rights allow no release.
 * Scopes are never added together.
 */
export function coverageFromSources(sources: readonly CoverageSource[]): ScopeCoverage[] {
  const byScope = new Map<string, ScopeCoverage>()
  for (const s of sources) {
    const row = byScope.get(s.view_scope) ?? { view_scope: s.view_scope, sources: 0, sources_with_a_successful_run: 0, sources_currently_unavailable: 0, latest_successful_retrieval: null }
    row.sources += 1
    if (s.last_success_at) {
      row.sources_with_a_successful_run += 1
      if (!row.latest_successful_retrieval || s.last_success_at > row.latest_successful_retrieval) row.latest_successful_retrieval = s.last_success_at
    }
    if (s.freshness_status === 'unavailable') row.sources_currently_unavailable += 1
    byScope.set(s.view_scope, row)
  }
  return [...byScope.values()]
}
