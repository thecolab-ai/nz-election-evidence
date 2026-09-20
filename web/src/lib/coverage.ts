import type { CoverageRow, SourceRow } from './types'

export type CoverageSource = Pick<SourceRow, 'view_scope' | 'freshness_status' | 'last_success_at' | 'live_records'>

/**
 * Coverage by scope, derived in the browser from the rights-filtered public `sources` view. The database
 * does not publish a cross-source aggregate, because it would count sources whose rights allow no release.
 * Scopes are never added together.
 */
export function coverageFromSources(sources: readonly CoverageSource[]): CoverageRow[] {
  const byScope = new Map<string, CoverageRow>()
  for (const s of sources) {
    const row = byScope.get(s.view_scope) ?? { view_scope: s.view_scope, sources: 0, sources_with_a_successful_run: 0, sources_currently_unavailable: 0, live_records: 0, latest_successful_retrieval: null }
    row.sources = Number(row.sources) + 1
    if (s.last_success_at) {
      row.sources_with_a_successful_run = Number(row.sources_with_a_successful_run) + 1
      if (!row.latest_successful_retrieval || s.last_success_at > row.latest_successful_retrieval) row.latest_successful_retrieval = s.last_success_at
    }
    if (s.freshness_status === 'unavailable') row.sources_currently_unavailable = Number(row.sources_currently_unavailable) + 1
    row.live_records = Number(row.live_records) + Number(s.live_records ?? 0)
    byScope.set(s.view_scope, row)
  }
  return [...byScope.values()]
}
