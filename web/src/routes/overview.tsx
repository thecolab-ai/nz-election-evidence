import { Link } from '@tanstack/react-router'
import { StateBadge } from '@/components/badges'
import { Note, PageHeader, Section } from '@/components/page'
import { ReleaseCoveragePanel } from '@/components/release-coverage'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import { formatCount, formatDateTime, humanise, SCOPE_LABELS, SCOPE_ORDER, type ViewScope } from '@/lib/format'
import { coverageFromSources, type CoverageSource } from '@/lib/coverage'
import { RIGHTS_NOTE } from '@/lib/format'
import { useRowsQuery } from '@/lib/queries'
import type { CoverageRow, ReleaseGateRow, RightsRow } from '@/lib/types'

const SCOPE_NOTES: Record<ViewScope, string> = {
  primary_2026: 'Sources about the 7 November 2026 General Election. This is the primary view.',
  baseline_2023: 'Held results and candidacies from the 2023 General Election, kept as a comparison baseline only.',
  finance_2025: 'References to 2025 finance returns. Document references only; no donor data is held.',
  current_parliament: 'The sitting Parliament: members, bills and questions. A sitting member is not a candidate.',
  statistics: 'Official statistical series.',
  general: 'Sources that do not belong to one scope.',
}

const ELECTION_SCOPES: ViewScope[] = ['primary_2026', 'baseline_2023', 'finance_2025']

function ScopeCard({ scope, row }: { scope: ViewScope; row: CoverageRow | undefined }) {
  const headingId = `scope-${scope}`
  return (
    <article aria-labelledby={headingId} data-testid={`scope-${scope}`} className="flex flex-col border border-border bg-paper">
      <div className="border-b border-border px-4 py-3">
        <p className="eyebrow">{scope}</p>
        <h3 id={headingId} className="mt-0.5 text-lg">
          {SCOPE_LABELS[scope]}
        </h3>
        <p className="mt-1 text-[13px] text-muted-foreground">{SCOPE_NOTES[scope]}</p>
      </div>
      {row ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-4 text-sm">
          <div>
            <dt className="eyebrow">Sources registered</dt>
            <dd className="num text-xl">{formatCount(row.sources)}</dd>
          </div>
          <div>
            <dt className="eyebrow">Live records</dt>
            <dd className="num text-xl">{formatCount(row.live_records)}</dd>
          </div>
          <div>
            <dt className="eyebrow">With a successful run</dt>
            <dd className="num">{formatCount(row.sources_with_a_successful_run)}</dd>
          </div>
          <div>
            <dt className="eyebrow">Currently unavailable</dt>
            <dd className="num">{formatCount(row.sources_currently_unavailable)}</dd>
          </div>
          <div className="col-span-2">
            <dt className="eyebrow">Latest successful retrieval</dt>
            <dd>{formatDateTime(row.latest_successful_retrieval, 'no successful retrieval yet')}</dd>
          </div>
        </dl>
      ) : (
        <p className="px-4 py-4 text-sm text-muted-foreground">No sources are registered in this scope. Coverage is unknown, not zero.</p>
      )}
      <div className="mt-auto border-t border-border px-4 py-2.5 text-sm">
        <Link to="/sources" search={{ scope }} className="doc-link">
          Sources in this scope
        </Link>
      </div>
    </article>
  )
}

export function OverviewPage() {
  // Derived from the rights-filtered sources view; the database publishes no cross-source aggregate.
  const coverage = useRowsQuery<CoverageSource>({ view: 'sources', select: 'view_scope,freshness_status,last_success_at,live_records', key: ['overview-coverage'], limit: 200 })
  const gates = useRowsQuery<ReleaseGateRow>({ view: 'release_gates', select: 'gate_key,state,evidence_reference,decided_at', key: ['overview'], limit: 20, build: (q) => q.order('gate_key') })
  const rights = useRowsQuery<Pick<RightsRow, 'rights_id' | 'review_status'>>({ view: 'rights_register', select: 'rights_id,review_status', key: ['overview'], limit: 200 })

  const byScope = new Map(coverageFromSources(coverage.data ?? []).map((row) => [row.view_scope, row]))
  const otherScopes = SCOPE_ORDER.filter((scope) => !ELECTION_SCOPES.includes(scope))
  const rightsRows = rights.data ?? []
  const notPending = rightsRows.filter((row) => row.review_status !== 'pending').length

  return (
    <>
      <PageHeader eyebrow="Overview" title="What has been retrieved, by scope">
        <p>
          Coverage is reported separately for each scope and is never added together: the 2026 election, the 2023 baseline and the
          2025 finance returns answer different questions. A count is what was retrieved, not what exists. Sources whose
          rights allow no release are not listed or counted.
        </p>
        <p data-testid="rights-note">{RIGHTS_NOTE}</p>
      </PageHeader>

      <Section id="release-coverage" title="What this release holds, and what it does not" description="Counted against the project's public catalogue of 24 products. Most of the catalogue is not in this store yet.">
        <ReleaseCoveragePanel />
      </Section>

      <Section id="election-scopes" title="Election scopes" description="Three scopes, always kept apart.">
        {coverage.isPending ? (
          <LoadingBlock label="Loading coverage" rows={4} />
        ) : coverage.isError ? (
          <ErrorBlock error={coverage.error} onRetry={() => void coverage.refetch()} />
        ) : (
          <>
            {coverage.data.length === 0 ? <div className="mb-4"><EmptyBlock /></div> : null}
            <div className="grid gap-4 xl:grid-cols-3">
              {ELECTION_SCOPES.map((scope) => (
                <ScopeCard key={scope} scope={scope} row={byScope.get(scope)} />
              ))}
            </div>
          </>
        )}
      </Section>

      {coverage.isSuccess ? (
        <Section id="other-scopes" title="Other scopes">
          <div className="grid gap-4 xl:grid-cols-3">
            {otherScopes.map((scope) => (
              <ScopeCard key={scope} scope={scope} row={byScope.get(scope)} />
            ))}
          </div>
        </Section>
      ) : null}

      <Section id="release-gates" title="Release gates" description="A gate records an independent review: R10 (legal review of this surface) and R8 (a named accountable person). A gate is open only when that review is on record. While a gate reads closed, any rows shown here are shown on the repository owner's own recorded decision, stated at the top of every page, which does not open or replace a gate. The election-day gate governs new releases and deployments, not reading.">
        {gates.isPending ? (
          <LoadingBlock label="Loading release gates" rows={3} />
        ) : gates.isError ? (
          <ErrorBlock error={gates.error} onRetry={() => void gates.refetch()} />
        ) : gates.data.length === 0 ? (
          <EmptyBlock />
        ) : (
          <ul className="divide-y divide-border border border-border bg-paper text-sm" data-testid="release-gates">
            {gates.data.map((gate) => (
              <li key={gate.gate_key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="font-medium">{humanise(gate.gate_key)}</p>
                  <p className="text-[13px] text-muted-foreground">
                    {gate.decided_at ? `Recorded ${formatDateTime(gate.decided_at)}` : 'No decision recorded'}
                    {gate.evidence_reference ? ` · ${gate.evidence_reference}` : ''}
                  </p>
                </div>
                <StateBadge state={gate.state} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="rights" title="Publisher rights">
        {rights.isPending ? (
          <LoadingBlock label="Loading rights register" rows={2} />
        ) : rights.isError ? (
          <ErrorBlock error={rights.error} onRetry={() => void rights.refetch()} />
        ) : (
          <Note testId="rights-statement" tone="caution">
            {rightsRows.length === 0
              ? 'No publisher rights rows are loaded. Rights are treated as pending for every source: nothing is cleared for release.'
              : notPending === 0
                ? `All ${formatCount(rightsRows.length)} publisher rights rows are pending. No publisher has approved or licensed any field. Where a source shows names or titles, it does so on the repository owner's recorded decision for that source, listed on the source's page.`
                : `${formatCount(rightsRows.length - notPending)} of ${formatCount(rightsRows.length)} publisher rights rows are pending review.`}{' '}
            <Link to="/rights" className="doc-link">
              Rights register
            </Link>
          </Note>
        )}
      </Section>
    </>
  )
}
