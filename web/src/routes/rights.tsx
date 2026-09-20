import { createColumnHelper } from '@tanstack/react-table'
import { getRouteApi } from '@tanstack/react-router'
import { RightsBadge } from '@/components/badges'
import { DataTable, type CoreFeatures } from '@/components/data-table'
import { FilterBar, SelectFilter, TextFilter } from '@/components/filters'
import { ExternalLink, Note, PageHeader } from '@/components/page'
import { formatPlainDate, humanise } from '@/lib/format'
import { useListQuery } from '@/lib/queries'
import { ilikeContains } from '@/lib/search'
import { rightsSpec } from '@/lib/specs'
import type { RightsRow } from '@/lib/types'
import { filterPatch, useSetSearch } from '@/lib/use-set-search'

const route = getRouteApi('/_released/rights')
const helper = createColumnHelper<CoreFeatures, RightsRow>()
const columns = helper.columns([
  helper.accessor('rights_id', { header: 'Id', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span> }),
  helper.accessor('publisher', { header: 'Publisher', cell: ({ row }) => <><span className="font-medium">{row.original.publisher}</span><span className="block"><ExternalLink href={row.original.source_url} className="text-xs" /></span></> }),
  helper.accessor('review_status', { header: 'Review', cell: ({ getValue }) => <RightsBadge status={getValue()} /> }),
  helper.accessor('default_release', { header: 'Default release', cell: ({ getValue }) => humanise(getValue()) }),
  helper.accessor('verified_permissions', { header: 'Verified permissions', cell: ({ getValue }) => getValue() ?? 'none verified' }),
  helper.accessor('excluded_assets', { header: 'Excluded assets', cell: ({ getValue }) => getValue() ?? 'none recorded' }),
  helper.accessor('licence_or_terms_url', { header: 'Licence or terms', cell: ({ getValue }) => { const url = getValue(); return url ? <ExternalLink href={url}>Terms</ExternalLink> : 'not recorded' } }),
  helper.accessor('reviewed_on', { header: 'Reviewed on', cell: ({ getValue }) => formatPlainDate(getValue(), 'not reviewed') }),
])

export function RightsPage() {
  const search = route.useSearch()
  const setSearch = useSetSearch()
  const query = useListQuery<RightsRow, keyof typeof rightsSpec.filters>({
    view: 'rights_register',
    select: '*',
    spec: rightsSpec,
    search,
    filter: (q, s) => {
      let next = q
      if (s.status) next = next.eq('review_status', s.status)
      if (s.publisher) next = next.ilike('publisher', ilikeContains(s.publisher))
      return next
    },
  })
  return (
    <>
      <PageHeader eyebrow="Stewardship" title="Rights register">
        <p>One row per publisher. Until a row is reviewed, its material is link-only: this project points to the publisher and copies nothing beyond what identifies the item.</p>
      </PageHeader>
      <div className="mb-4"><Note tone="caution">A pending row is the default state. Pending does not mean permission was refused, and it does not mean permission was given.</Note></div>
      <FilterBar hasActive={!!(search.status || search.publisher)} onClear={() => setSearch({ status: undefined, publisher: undefined, page: 1 })}>
        <SelectFilter name="status" label="Review status" value={search.status} onChange={(v) => setSearch(filterPatch('status', v), { replace: true })} options={rightsSpec.filters.status.values.map((v) => ({ value: v, label: humanise(v) }))} anyLabel="Any status" />
        <TextFilter name="publisher" label="Publisher contains" value={search.publisher} onCommit={(v) => setSearch(filterPatch('publisher', v), { replace: true })} />
      </FilterBar>
      <DataTable caption="Rights register" columns={columns} query={query} spec={rightsSpec} search={search} onSearchChange={setSearch} getRowId={(row) => row.rights_id} />
    </>
  )
}
