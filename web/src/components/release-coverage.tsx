import { Link } from '@tanstack/react-router'
import { Pill } from '@/components/badges'
import { Note } from '@/components/page'
import { coverageCounts, RELEASE_COVERAGE, type ProductRoute } from '@/lib/release-coverage'

const ROUTE_LABEL: Record<ProductRoute, string> = {
  live: 'Live adapter',
  export: 'Historical export',
  none: 'Not in this store',
}

/** States what this release holds and, as prominently, what it does not. A populated page is not a complete one. */
export function ReleaseCoveragePanel() {
  const counts = coverageCounts()
  const held = RELEASE_COVERAGE.filter((row) => row.route !== 'none')
  const missing = RELEASE_COVERAGE.filter((row) => row.route === 'none')
  return (
    <div className="space-y-4" data-testid="release-coverage">
      <Note tone="caution" testId="coverage-missing-note">
        <strong className="font-semibold">
          {counts.none} of the {counts.total} catalogue products are not in this store.
        </strong>{' '}
        This first release holds {counts.live} products through live adapters and {counts.export} through a verified historical export. For
        every other product nothing is held here, and that says nothing about what the publisher has published.
      </Note>
      <ul className="divide-y divide-border border border-border bg-paper text-sm" data-testid="coverage-held">
        {held.map((row) => (
          <li key={row.product_id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0 max-w-3xl">
              <p className="font-medium">
                <span className="font-mono text-xs text-muted-foreground">{row.product_id}</span> {row.title}
              </p>
              <p className="text-[13px] text-muted-foreground">
                {row.publisher}
                {row.note ? ` · ${row.note}` : ''}{' '}
                {row.source_id ? (
                  <Link to="/sources/$sourceId" params={{ sourceId: row.source_id }} className="doc-link">
                    Source and provenance
                  </Link>
                ) : null}
              </p>
            </div>
            <Pill>{ROUTE_LABEL[row.route]}</Pill>
          </li>
        ))}
      </ul>
      <details className="border border-border bg-paper text-sm" data-testid="coverage-missing" open>
        <summary className="cursor-pointer px-4 py-2.5 font-medium">
          Not in this store: {counts.none} catalogue products
        </summary>
        <ul className="divide-y divide-border border-t border-border">
          {missing.map((row) => (
            <li key={row.product_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
              <p className="min-w-0">
                <span className="font-mono text-xs text-muted-foreground">{row.product_id}</span> {row.title}
                <span className="text-muted-foreground"> · {row.publisher}</span>
              </p>
              <Pill tone="muted">{ROUTE_LABEL[row.route]}</Pill>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
