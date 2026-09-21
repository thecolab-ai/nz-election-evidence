import { CircleSlash, Clock, HelpCircle, Landmark } from 'lucide-react'
import type { ReactNode } from 'react'
import { ExternalLink } from '@/components/page'
import { ErrorBlock, LoadingBlock, NotLoadedBlock } from '@/components/states'
import { formatDateTime, formatPublisherDate, NOT_STATED } from '@/lib/format'
import type { Availability, Provenance } from '@/lib/electorate'
import { cn } from '@/lib/utils'

/**
 * A card that states a fact about an electorate. The provenance strip is not decoration and is not
 * optional: a card cannot be constructed without a publisher, and it always prints the publisher's
 * own date and the date this project retrieved the material as two separate values, because they
 * answer different questions. `unknowns` is the same idea for what the card does NOT know — it is
 * printed on the card, beside the fact, not hidden in a page-level footnote.
 */
export function FactCard({
  eyebrow,
  title,
  lede,
  provenance,
  unknowns,
  children,
  testId,
  tone = 'plain',
}: {
  eyebrow: string
  title: string
  lede?: ReactNode
  provenance: Provenance
  unknowns: readonly string[]
  children: ReactNode
  testId?: string
  tone?: 'plain' | 'caution'
}) {
  return (
    <article
      data-testid={testId}
      className={cn('flex flex-col border bg-paper', tone === 'caution' ? 'border-caution-foreground/40' : 'border-border')}
    >
      <header className="border-b border-border px-4 py-3 sm:px-5">
        <p className="eyebrow">{eyebrow}</p>
        <h3 className="mt-0.5 text-lg">{title}</h3>
        {lede ? <div className="mt-1.5 max-w-3xl text-[13.5px] text-muted-foreground">{lede}</div> : null}
      </header>
      <div className="px-4 py-4 text-sm sm:px-5">{children}</div>
      <ProvenanceStrip provenance={provenance} unknowns={unknowns} />
    </article>
  )
}

export function ProvenanceStrip({ provenance, unknowns }: { provenance: Provenance; unknowns: readonly string[] }) {
  return (
    <footer className="mt-auto border-t border-border bg-muted/40 px-4 py-3 text-[12.5px] sm:px-5" data-testid="provenance">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0">
          <dt className="eyebrow flex items-center gap-1">
            <Landmark aria-hidden="true" className="size-3" /> Publisher
          </dt>
          <dd className="mt-0.5 break-words" data-testid="provenance-publisher">{provenance.publisher}</dd>
        </div>
        <div className="min-w-0">
          <dt className="eyebrow">Date the publisher states</dt>
          <dd className="mt-0.5" data-testid="provenance-source-date">{formatPublisherDate(provenance.sourceDate, provenance.sourceDateText)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="eyebrow flex items-center gap-1">
            <Clock aria-hidden="true" className="size-3" /> Retrieved by this project
          </dt>
          <dd className="mt-0.5" data-testid="provenance-retrieved">{formatDateTime(provenance.retrievedAt, 'no successful retrieval recorded')}</dd>
        </div>
        <div className="min-w-0">
          <dt className="eyebrow">At the publisher</dt>
          <dd className="mt-0.5 break-words">
            {provenance.officialUrl ? <ExternalLink href={provenance.officialUrl}>Open the original</ExternalLink> : <span className="text-muted-foreground">{NOT_STATED}</span>}
          </dd>
        </div>
      </dl>
      {unknowns.length > 0 ? (
        <div className="mt-3 border-t border-border pt-2.5" data-testid="known-unknowns">
          <p className="eyebrow flex items-center gap-1">
            <HelpCircle aria-hidden="true" className="size-3" /> What this card does not know
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
            {unknowns.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </footer>
  )
}

/**
 * Renders the one honest state a panel is actually in. Four different silences are four different
 * sentences: a dataset that this deployment does not carry, a query this deployment would not
 * finish, a request that failed, and a store that genuinely holds no row.
 *
 * `statePrefix` names the panel when a card holds MORE THAN ONE of these blocks. The 2026 card holds
 * two — who is standing, and the publisher's own boundary maps — and with both silent they rendered
 * two identical `none-held` boxes carrying the same closing sentence. A reader could not tell which
 * question each was answering, and neither could an assertion about the card's own answer. The card's
 * answer keeps the plain names; a nested panel is named for itself. `loading-state` is deliberately
 * NOT scoped: "no panel is left spinning" has to be answerable for every panel at once.
 */
export function AvailabilityBlock<Row>({
  availability,
  loadingLabel,
  noneHeld,
  datasetName,
  onRetry,
  statePrefix,
  children,
}: {
  availability: Availability<Row>
  loadingLabel: string
  /** What it means that the store holds no row here. Always says what is unknown, never "zero". */
  noneHeld: ReactNode
  /** The dataset a reader would look for in the catalogue if it is not loaded here. */
  datasetName: string
  onRetry?: () => void
  /** Set on a panel nested inside a card that has an answer of its own. See the note above. */
  statePrefix?: string
  children: (rows: Row[]) => ReactNode
}) {
  const stateId = (state: string) => (statePrefix ? `${statePrefix}-${state}` : state)
  if (availability.state === 'loading') return <LoadingBlock label={loadingLabel} rows={3} />
  if (availability.state === 'ready') return <>{children(availability.rows)}</>
  if (availability.state === 'none_held') {
    return (
      <div role="status" data-testid={stateId('none-held')} className="flex items-start gap-3 border border-dashed border-rule px-4 py-4 text-sm text-muted-foreground">
        <CircleSlash aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <p className="text-foreground">{noneHeld}</p>
          <p>Nothing was found, and nothing is claimed about what exists at the publisher. This is unknown, not zero.</p>
        </div>
      </div>
    )
  }
  if (availability.state === 'not_loaded') return <NotLoadedBlock datasetName={datasetName} testId={stateId('not-loaded')} />
  if (availability.state === 'not_answerable') {
    return (
      <div role="status" data-testid={stateId('not-answerable')} className="flex items-start gap-3 border border-dashed border-caution-foreground/50 bg-caution px-4 py-4 text-sm text-caution-foreground">
        <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <p className="font-medium">This deployment could not answer the question in the time it allows.</p>
          <p>
            The request for <code className="font-mono text-[12.5px]">{datasetName}</code> was cancelled by the database, not answered with an empty
            result. Rows may well exist; this page cannot read them here.
          </p>
        </div>
      </div>
    )
  }
  return <ErrorBlock error={availability.error} onRetry={onRetry} />
}
