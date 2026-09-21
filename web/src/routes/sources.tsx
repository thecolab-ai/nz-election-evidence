import { createColumnHelper } from '@tanstack/react-table'
import { getRouteApi, Link } from '@tanstack/react-router'
import { FreshnessBadge, Pill, RightsBadge } from '@/components/badges'
import { DataTable, type CoreFeatures } from '@/components/data-table'
import { FilterBar, SelectFilter, TextFilter } from '@/components/filters'
import { Note, PageHeader } from '@/components/page'
import { formatCount, formatDateTime, FRESHNESS_LABELS, FRESHNESS_STATUSES, NOT_STATED, SCOPE_LABELS, SCOPE_ORDER, scopeLabel, UNAVAILABLE_EXPLANATION } from '@/lib/format'
import { useListQuery } from '@/lib/queries'
import { ilikeContains } from '@/lib/search'
import { sourcesSpec } from '@/lib/specs'
import type { SourceRow } from '@/lib/types'
import { filterPatch, useSetSearch } from '@/lib/use-set-search'

const route = getRouteApi('/_released/sources')
const helper = createColumnHelper<CoreFeatures, SourceRow>()

const columns = helper.columns([
  helper.accessor('title', {
    header: 'Source',
    cell: ({ row }) => (
      <div>
        <Link to="/sources/$sourceId" params={{ sourceId: row.original.source_id }} className="doc-link font-medium">
          {row.original.title}
        </Link>
        <p className="font-mono text-xs text-muted-foreground">{row.original.source_id}</p>
      </div>
    ),
  }),
  helper.accessor('publisher', { header: 'Publisher' }),
  helper.accessor('view_scope', { header: 'Scope', cell: ({ getValue }) => scopeLabel(getValue()) }),
  helper.accessor('freshness_status', { header: 'Freshness', cell: ({ getValue }) => <FreshnessBadge status={getValue()} /> }),
  helper.accessor('last_success_at', { header: 'Last retrieved', cell: ({ getValue }) => formatDateTime(getValue(), 'never retrieved') }),
  helper.accessor('latest_source_published_at', { header: 'Latest publisher date', cell: ({ getValue }) => formatDateTime(getValue(), NOT_STATED) }),
  helper.display({ id: 'live_records', header: 'Held in this store', cell: ({ row }) => <HeldCell source={row.original} /> }),
  helper.accessor('rights_review_status', { header: 'Rights', cell: ({ row }) => <><RightsBadge status={row.original.rights_review_status} /><span className="mt-1 block text-xs text-muted-foreground" data-testid="release-tier">{RELEASE_TIER_LABELS[row.original.public_release_tier] ?? row.original.public_release_tier}</span>{(row.original.owner_authorized_fields ?? []).length > 0 ? <span className="block text-xs text-muted-foreground" data-testid="owner-fields-count">{row.original.owner_authorized_fields.length} fields shown on the owner’s decision, not on a publisher approval</span> : null}</> }),
  helper.accessor('enabled', { header: 'Enabled', cell: ({ getValue }) => (getValue() ? <Pill>Enabled</Pill> : <Pill tone="muted">Not enabled</Pill>) }),
])

/** Said where this list does not read a count at all. Never a figure, and never a zero standing in for one. */
export const RECORDS_COUNTED_ON_THE_SOURCE_PAGE = 'counted on this source’s own page'

/**
 * What the store holds for one source. A statistics source writes typed observations rather than ledger records, so its
 * record count is 0 by design: its observations and catalogue entries are shown instead. Observations the publisher
 * printed no number for are counted apart and are never zeros.
 *
 * A ledger source's record count is NOT read by this list. Counting live records is a per-source scan of the largest
 * table in the store, and asking for it once per row is the slowest query this deployment serves — on the live store it
 * has timed out. The count is not guessed, rounded or cached here: the source's own page reads it for that one source,
 * and this cell says where it is. The statistics figures below are kept because they are counted when a load finishes
 * and read from a summary row, not recounted per request.
 */
export function HeldCell({ source }: { source: Pick<SourceRow, 'statistical_observations' | 'statistical_observations_without_a_number' | 'statistical_catalogue_entries'> & { live_records?: SourceRow['live_records'] } }) {
  if (source.statistical_observations === null || source.statistical_observations === undefined) {
    if (source.live_records === undefined) return <span className="text-xs text-muted-foreground" data-testid="held-deferred">{RECORDS_COUNTED_ON_THE_SOURCE_PAGE}</span>
    return <span className="num" data-testid="held-records">{formatCount(source.live_records)} records</span>
  }
  const withheld = Number(source.statistical_observations_without_a_number ?? 0)
  const entries = Number(source.statistical_catalogue_entries ?? 0)
  return (
    <span data-testid="held-statistics">
      <span className="num">{formatCount(source.statistical_observations)}</span> observations
      {entries > 0 ? <span className="block text-xs text-muted-foreground"><span className="num">{formatCount(entries)}</span> catalogue entries</span> : null}
      {withheld > 0 ? <span className="block text-xs text-muted-foreground"><span className="num">{formatCount(withheld)}</span> with no number printed by the publisher</span> : null}
    </span>
  )
}

export const RELEASE_TIER_LABELS: Record<string, string> = {
  link_only: 'Links and metadata only',
  fields: 'Approved fields shown',
}

// Every column this page renders, and no other. `live_records` is deliberately absent: it is a correlated
// count over the record table for each row, and one list of it costs more than everything else here put
// together. It is read on a source's own page, for that one source.
export const SOURCES_SELECT = 'source_id,title,publisher,view_scope,freshness_status,last_success_at,latest_source_published_at,statistical_observations,statistical_observations_without_a_number,statistical_catalogue_entries,rights_review_status,public_release_tier,owner_authorized_fields,enabled'

export function SourcesPage() {
  const search = route.useSearch()
  const setSearch = useSetSearch()
  const query = useListQuery<SourceRow, keyof typeof sourcesSpec.filters>({
    view: 'sources',
    select: SOURCES_SELECT,
    spec: sourcesSpec,
    search,
    filter: (q, s) => {
      let next = q
      if (s.scope) next = next.eq('view_scope', s.scope)
      if (s.freshness) next = next.eq('freshness_status', s.freshness)
      if (s.publisher) next = next.ilike('publisher', ilikeContains(s.publisher))
      return next
    },
  })

  return (
    <>
      <PageHeader eyebrow="Evidence" title="Sources">
        <p>
          Every registered source, with two separate dates: when this project last retrieved it, and the latest date the publisher
          itself put on an item. Neither is the date an underlying event happened.
        </p>
      </PageHeader>
      {search.freshness === 'unavailable' ? <div className="mb-4"><Note tone="caution">{UNAVAILABLE_EXPLANATION}</Note></div> : null}
      <div className="mb-4">
        <Note testId="held-counts-note">
          How many records a source holds is counted on that source’s own page, one source at a time. Counting every source’s records to draw one
          list is the slowest read this store serves, and a list that times out is worse than one that says where the count is. Statistics sources
          show the observation counts recorded when their load finished.
        </Note>
      </div>
      <FilterBar hasActive={!!(search.scope || search.freshness || search.publisher)} onClear={() => setSearch({ scope: undefined, freshness: undefined, publisher: undefined, page: 1 })}>
        <SelectFilter name="scope" label="Scope" value={search.scope} onChange={(v) => setSearch(filterPatch('scope', v), { replace: true })} options={SCOPE_ORDER.map((s) => ({ value: s, label: SCOPE_LABELS[s] }))} anyLabel="Any scope" />
        <SelectFilter name="freshness" label="Freshness" value={search.freshness} onChange={(v) => setSearch(filterPatch('freshness', v), { replace: true })} options={FRESHNESS_STATUSES.map((s) => ({ value: s, label: FRESHNESS_LABELS[s] }))} anyLabel="Any freshness" />
        <TextFilter name="publisher" label="Publisher contains" value={search.publisher} onCommit={(v) => setSearch(filterPatch('publisher', v), { replace: true })} />
      </FilterBar>
      <DataTable caption="Sources" columns={columns} query={query} spec={sourcesSpec} search={search} onSearchChange={setSearch} getRowId={(row) => row.source_id} />
    </>
  )
}
