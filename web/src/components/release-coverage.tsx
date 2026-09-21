import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Pill } from '@/components/badges'
import { Note } from '@/components/page'
import { ErrorBlock, LoadingBlock } from '@/components/states'
import { formatCount } from '@/lib/format'
import { toDataError, useRowsQuery, type DataError, type SelectQuery } from '@/lib/queries'
import { coverageCounts, heldFor, ledgerRouteIds, NOT_PUBLISHED_FOR_2026, REFRESH_LABELS, RELEASE_COVERAGE, type HeldSource, type ProductCoverage, type ProductHeld, type RecordPresence, type RouteHeld } from '@/lib/release-coverage'
import { requireSupabase } from '@/lib/supabase'

/** The columns of the public `sources` view this panel reads. `live_records` is not one of them; see `HeldSource`. */
export const RELEASE_COVERAGE_SELECT = 'source_id,statistical_observations,statistical_catalogue_entries,last_success_at'

/** Said in place of a figure this panel does not ask the store for. Never a number, and never a zero standing in for one. */
export const RECORDS_NOT_COUNTED_HERE = 'holds source records; counted on the source’s own page'
/** A few at a time: enough to answer 30 routes quickly, few enough that the panel never opens 30 reads at once. */
const PROBE_CONCURRENCY = 6

/**
 * Does this route hold at least one source record? One bounded probe each: a single row, a single column, filtered
 * to that one source. Measured against the live store at about 0.24 s per probe, against 3.84 s and a server-side
 * statement timeout (HTTP 500, `57014`) for the single correlated `live_records` count this panel used to ask for.
 * A probe answers yes or no; it never returns a number, so no count is invented here.
 */
async function probeRecordPresence(sourceIds: readonly string[], signal: AbortSignal): Promise<Map<string, boolean>> {
  const source = requireSupabase() as unknown as { from(name: string): { select(columns: string): SelectQuery } }
  const found = new Map<string, boolean>()
  const queue = [...sourceIds]
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
    for (let sourceId = queue.shift(); sourceId !== undefined; sourceId = queue.shift()) {
      const { data, error, status } = await source.from('records').select('source_id').eq('source_id', sourceId).limit(1).abortSignal(signal)
      if (error) throw toDataError(error, status)
      found.set(sourceId, (data ?? []).length > 0)
    }
  })
  await Promise.all(workers)
  return found
}

function useRecordPresence(sourceIds: readonly string[], enabled: boolean): UseQueryResult<Map<string, boolean>, DataError> {
  return useQuery<Map<string, boolean>, DataError>({
    queryKey: ['release-coverage-presence', [...sourceIds].sort()],
    enabled: enabled && sourceIds.length > 0,
    queryFn: ({ signal }) => probeRecordPresence(sourceIds, signal),
  })
}

export function routeWords(route: RouteHeld): string {
  const parts: string[] = []
  if (route.holds_records) parts.push(RECORDS_NOT_COUNTED_HERE)
  if (route.statistical_observations > 0) parts.push(`${formatCount(route.statistical_observations)} observations`)
  if (route.catalogue_entries > 0) parts.push(`${formatCount(route.catalogue_entries)} catalogue entries`)
  return parts.join(' · ')
}

function SourceLinks({ ids }: { ids: readonly string[] }) {
  return (
    <>
      {ids.map((id, index) => (
        <span key={id}>
          {index > 0 ? ', ' : ''}
          <Link to="/sources/$sourceId" params={{ sourceId: id }} className="doc-link font-mono text-xs">
            {id}
          </Link>
        </span>
      ))}
    </>
  )
}

function ProductLine({ row, held }: { row: ProductCoverage; held: ProductHeld }) {
  const sourceIds = [...new Set([...row.backfill_source_ids, ...row.refresh_source_ids])]
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5" data-testid={`coverage-${row.product_id}`} data-held={held.held ? 'yes' : held.undetermined.length > 0 ? 'undetermined' : 'no'}>
      <div className="min-w-0 max-w-3xl">
        <p className="font-medium">
          <span className="font-mono text-xs text-muted-foreground">{row.product_id}</span> {row.title}
        </p>
        <p className="text-[13px] text-muted-foreground">
          {row.publisher} ·{' '}
          {held.held ? (
            <span data-testid="coverage-held-count">
              Held, route by route (routes reach overlapping publisher items, so they are not added together):{' '}
              {held.routes.map((route, index) => (
                <span key={route.source_id}>
                  {index > 0 ? '; ' : ''}
                  <Link to="/sources/$sourceId" params={{ sourceId: route.source_id }} className="doc-link font-mono text-xs">{route.source_id}</Link> {routeWords(route)}
                </span>
              ))}
              .
            </span>
          ) : held.undetermined.length > 0 ? (
            <span data-testid="coverage-undetermined-routes">
              An import route exists; whether this store holds any of it was not established on this page, so it is
              not reported either way. Open the route to see what it holds:{' '}
              <SourceLinks ids={held.undetermined} />.
            </span>
          ) : (
            <span>An import route exists; nothing of this product is in this store.</span>
          )}{' '}
          {row.refresh_gap ? <span>{row.refresh_gap} </span> : null}
          {held.held || held.undetermined.length > 0 ? null : <SourceLinks ids={sourceIds} />}
        </p>
      </div>
      <Pill tone={row.refresh === 'scheduled' || row.refresh === 'operator_run' ? 'plain' : 'muted'}>{REFRESH_LABELS[row.refresh]}</Pill>
    </li>
  )
}

/**
 * States what this store holds and, as prominently, what it does not. Which routes exist is a fact about the project;
 * what is held is read from the database every time, so a route that has never been loaded never reads as coverage.
 *
 * Two reads, both bounded, neither of them a count over the record table: the `sources` view for the statistics
 * figures the loader already wrote, and one existence probe per ledger route. A route nothing answered for is
 * reported as undetermined and is kept out of both the held and the not-held count.
 */
export function ReleaseCoveragePanel() {
  const sources = useRowsQuery<HeldSource>({ view: 'sources', select: RELEASE_COVERAGE_SELECT, key: ['release-coverage'], limit: 200 })
  const ledgerIds = ledgerRouteIds(sources.data ?? [])
  const presence = useRecordPresence(ledgerIds, sources.isSuccess)
  if (sources.isPending) return <LoadingBlock label="Loading coverage" rows={4} />
  if (sources.isError) return <ErrorBlock error={sources.error} onRetry={() => void sources.refetch()} />
  if (presence.isPending && ledgerIds.length > 0) return <LoadingBlock label="Loading coverage" rows={4} />
  const answered: RecordPresence = presence.data ?? new Map<string, boolean>()
  const counts = coverageCounts()
  const lines = RELEASE_COVERAGE.map((row) => ({ row, held: heldFor(row, sources.data, answered) }))
  const held = lines.filter((line) => line.held.held)
  const undetermined = lines.filter((line) => !line.held.held && line.held.undetermined.length > 0)
  const notHeld = lines.filter((line) => !line.held.held && line.held.undetermined.length === 0)
  return (
    <div className="space-y-4" data-testid="release-coverage">
      <Note tone="caution" testId="coverage-missing-note">
        <strong className="font-semibold">
          This store holds {held.length} of the {counts.total} catalogue products; {notHeld.length} are not in it.
          {undetermined.length > 0 ? <> A further {undetermined.length} were not established on this page, and are counted in neither figure.</> : null}
        </strong>{' '}
        Held means loaded from a verified export or a fresh public fetch, as answered by the database just now. It does not mean complete, and
        it does not mean a publisher has approved display: every rights row is pending, so content fields are blank unless a recorded owner
        decision names them. {counts.without_refresh_route} products have no working refresh route, so what is held of them will age.{' '}
        Record counts are not read here: counting the records of every source at once is the slowest query this store serves and has timed
        out for readers, so each source’s own page counts its own records. A figure this page does not ask for is unknown, not zero.
      </Note>
      {presence.isError ? (
        <Note tone="caution" testId="coverage-probe-error">
          The store did not answer whether the routes below hold anything ({presence.error.message}). Nothing is reported as empty on the
          strength of that silence. <button type="button" className="doc-link" onClick={() => void presence.refetch()}>Ask again</button>
        </Note>
      ) : null}
      {held.length > 0 ? (
        <ul className="divide-y divide-border border border-border bg-paper text-sm" data-testid="coverage-held">
          {held.map(({ row, held: h }) => <ProductLine key={row.product_id} row={row} held={h} />)}
        </ul>
      ) : null}
      {undetermined.length > 0 ? (
        <details className="border border-border bg-paper text-sm" data-testid="coverage-undetermined" open>
          <summary className="cursor-pointer px-4 py-2.5 font-medium">Not established on this page: {undetermined.length} catalogue products</summary>
          <ul className="divide-y divide-border border-t border-border">
            {undetermined.map(({ row, held: h }) => <ProductLine key={row.product_id} row={row} held={h} />)}
          </ul>
        </details>
      ) : null}
      {notHeld.length > 0 ? (
        <details className="border border-border bg-paper text-sm" data-testid="coverage-missing" open>
          <summary className="cursor-pointer px-4 py-2.5 font-medium">Not in this store: {notHeld.length} catalogue products</summary>
          <ul className="divide-y divide-border border-t border-border">
            {notHeld.map(({ row, held: h }) => <ProductLine key={row.product_id} row={row} held={h} />)}
          </ul>
        </details>
      ) : null}
      <div data-testid="coverage-2026-unpublished" className="max-w-3xl border-l-2 border-primary/50 py-1.5 pl-3 text-sm text-foreground">
        <strong className="font-semibold">Not published for the 2026 election by any route:</strong>
        <ul className="mt-1 list-disc pl-5">
          {NOT_PUBLISHED_FOR_2026.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
    </div>
  )
}
