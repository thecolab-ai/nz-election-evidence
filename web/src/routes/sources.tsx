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
  helper.accessor('live_records', { header: 'Live records', cell: ({ getValue }) => <span className="num">{formatCount(getValue())}</span> }),
  helper.accessor('rights_review_status', { header: 'Rights', cell: ({ row }) => <><RightsBadge status={row.original.rights_review_status} /><span className="mt-1 block text-xs text-muted-foreground" data-testid="release-tier">{RELEASE_TIER_LABELS[row.original.public_release_tier] ?? row.original.public_release_tier}</span></> }),
  helper.accessor('enabled', { header: 'Enabled', cell: ({ getValue }) => (getValue() ? <Pill>Enabled</Pill> : <Pill tone="muted">Not enabled</Pill>) }),
])

export const RELEASE_TIER_LABELS: Record<string, string> = {
  link_only: 'Links and metadata only',
  fields: 'Approved fields shown',
}

const SELECT = 'source_id,title,publisher,view_scope,freshness_status,last_success_at,latest_source_published_at,live_records,rights_review_status,public_release_tier,enabled'

export function SourcesPage() {
  const search = route.useSearch()
  const setSearch = useSetSearch()
  const query = useListQuery<SourceRow, keyof typeof sourcesSpec.filters>({
    view: 'sources',
    select: SELECT,
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
      <FilterBar hasActive={!!(search.scope || search.freshness || search.publisher)} onClear={() => setSearch({ scope: undefined, freshness: undefined, publisher: undefined, page: 1 })}>
        <SelectFilter name="scope" label="Scope" value={search.scope} onChange={(v) => setSearch(filterPatch('scope', v), { replace: true })} options={SCOPE_ORDER.map((s) => ({ value: s, label: SCOPE_LABELS[s] }))} anyLabel="Any scope" />
        <SelectFilter name="freshness" label="Freshness" value={search.freshness} onChange={(v) => setSearch(filterPatch('freshness', v), { replace: true })} options={FRESHNESS_STATUSES.map((s) => ({ value: s, label: FRESHNESS_LABELS[s] }))} anyLabel="Any freshness" />
        <TextFilter name="publisher" label="Publisher contains" value={search.publisher} onCommit={(v) => setSearch(filterPatch('publisher', v), { replace: true })} />
      </FilterBar>
      <DataTable caption="Sources" columns={columns} query={query} spec={sourcesSpec} search={search} onSearchChange={setSearch} getRowId={(row) => row.source_id} />
    </>
  )
}
