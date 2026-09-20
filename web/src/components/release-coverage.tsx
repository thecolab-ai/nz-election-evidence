import { Link } from '@tanstack/react-router'
import { Pill } from '@/components/badges'
import { Note } from '@/components/page'
import { ErrorBlock, LoadingBlock } from '@/components/states'
import { formatCount } from '@/lib/format'
import { useRowsQuery } from '@/lib/queries'
import { coverageCounts, heldFor, NOT_PUBLISHED_FOR_2026, REFRESH_LABELS, RELEASE_COVERAGE, type HeldSource, type ProductCoverage, type ProductHeld } from '@/lib/release-coverage'

function heldWords(held: ProductHeld): string {
  const parts: string[] = []
  if (held.ledger_records > 0) parts.push(`${formatCount(held.ledger_records)} source records`)
  if (held.statistical_observations > 0) parts.push(`${formatCount(held.statistical_observations)} observations`)
  if (held.catalogue_entries > 0) parts.push(`${formatCount(held.catalogue_entries)} catalogue entries`)
  return parts.join(' · ')
}

function ProductLine({ row, held }: { row: ProductCoverage; held: ProductHeld }) {
  const sourceIds = [...row.backfill_source_ids, ...row.refresh_source_ids]
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5" data-testid={`coverage-${row.product_id}`} data-held={held.held ? 'yes' : 'no'}>
      <div className="min-w-0 max-w-3xl">
        <p className="font-medium">
          <span className="font-mono text-xs text-muted-foreground">{row.product_id}</span> {row.title}
        </p>
        <p className="text-[13px] text-muted-foreground">
          {row.publisher} ·{' '}
          {held.held ? (
            <span data-testid="coverage-held-count">Held across {held.sources_loaded} {held.sources_loaded === 1 ? 'route' : 'routes'}: {heldWords(held)}. Routes to the same publisher items overlap, so these are not one total.</span>
          ) : (
            <span>An import route exists; nothing of this product is in this store.</span>
          )}{' '}
          {row.refresh_gap ? <span>{row.refresh_gap} </span> : null}
          {sourceIds.map((id, index) => (
            <span key={id}>
              {index > 0 ? ', ' : ''}
              <Link to="/sources/$sourceId" params={{ sourceId: id }} className="doc-link font-mono text-xs">
                {id}
              </Link>
            </span>
          ))}
        </p>
      </div>
      <Pill tone={row.refresh === 'scheduled' || row.refresh === 'operator_run' ? 'plain' : 'muted'}>{REFRESH_LABELS[row.refresh]}</Pill>
    </li>
  )
}

/**
 * States what this store holds and, as prominently, what it does not. Which routes exist is a fact about the project;
 * what is held is read from the database every time, so a route that has never been loaded never reads as coverage.
 */
export function ReleaseCoveragePanel() {
  const sources = useRowsQuery<HeldSource>({ view: 'sources', select: 'source_id,live_records,statistical_observations,statistical_catalogue_entries,last_success_at', key: ['release-coverage'], limit: 200 })
  if (sources.isPending) return <LoadingBlock label="Loading coverage" rows={4} />
  if (sources.isError) return <ErrorBlock error={sources.error} onRetry={() => void sources.refetch()} />
  const counts = coverageCounts()
  const lines = RELEASE_COVERAGE.map((row) => ({ row, held: heldFor(row, sources.data) }))
  const held = lines.filter((line) => line.held.held)
  const notHeld = lines.filter((line) => !line.held.held)
  return (
    <div className="space-y-4" data-testid="release-coverage">
      <Note tone="caution" testId="coverage-missing-note">
        <strong className="font-semibold">
          This store holds {held.length} of the {counts.total} catalogue products; {notHeld.length} are not in it.
        </strong>{' '}
        Held means loaded from a verified export or a fresh public fetch, as counted by the database just now. It does not mean complete, and
        it does not mean a publisher has approved display: every rights row is pending, so content fields are blank unless a recorded owner
        decision names them. {counts.without_refresh_route} products have no working refresh route, so what is held of them will age.
      </Note>
      {held.length > 0 ? (
        <ul className="divide-y divide-border border border-border bg-paper text-sm" data-testid="coverage-held">
          {held.map(({ row, held: h }) => <ProductLine key={row.product_id} row={row} held={h} />)}
        </ul>
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
