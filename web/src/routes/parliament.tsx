import { createColumnHelper } from '@tanstack/react-table'
import { getRouteApi, Link } from '@tanstack/react-router'
import { EntityLink } from '@/components/entity-link'
import { DataTable, type CoreFeatures } from '@/components/data-table'
import { FilterBar, SelectFilter, TextFilter } from '@/components/filters'
import { Note, PageHeader } from '@/components/page'
import { formatDateTime, formatServiceDate, humanise, NOT_SHOWN } from '@/lib/format'
import { useListQuery } from '@/lib/queries'
import { ilikeContains } from '@/lib/search'
import { parliamentSpec } from '@/lib/specs'
import type { ServiceTermRow } from '@/lib/types'
import { filterPatch, useSetSearch } from '@/lib/use-set-search'

const route = getRouteApi('/_released/parliament')
export const SITTING_MP_NOTE = 'A sitting MP is not a candidate. Candidacy appears only from nomination or announcement sources.'

const helper = createColumnHelper<CoreFeatures, ServiceTermRow>()
const columns = helper.columns([
  helper.accessor('member_name', {
    header: 'Member (name at source)',
    cell: ({ row }) => (
      <Link to="/people/$identityId" params={{ identityId: row.original.person_identity_id }} className="doc-link font-medium">
        {row.original.member_name ?? NOT_SHOWN}
      </Link>
    ),
  }),
  helper.accessor('party_label', { header: 'Party label at source', cell: ({ row }) => <EntityLink kind="party_identity" id={row.original.party_identity_id} testId="party-link">{row.original.party_label ?? NOT_SHOWN}</EntityLink> }),
  helper.accessor('representation', { header: 'Representation', cell: ({ getValue }) => humanise(getValue()) }),
  helper.accessor('electorate_name_at_source', { header: 'Electorate at source', cell: ({ row }) => <EntityLink kind="electorate_version" id={row.original.electorate_version_id}>{row.original.electorate_name_at_source ?? (row.original.representation === 'list' ? 'none (list member)' : NOT_SHOWN)}</EntityLink> }),
  helper.accessor('observed_first_at', { header: 'Observed in directory from', cell: ({ getValue }) => formatDateTime(getValue()) }),
  helper.accessor('observed_last_at', {
    header: 'Observed in directory to',
    cell: ({ row }) => (
      <>
        {formatDateTime(row.original.observed_last_at)}
        {row.original.observed_absent_at ? <span className="block text-xs text-muted-foreground">absent from directory since {formatDateTime(row.original.observed_absent_at)}</span> : null}
      </>
    ),
  }),
  helper.accessor('valid_from', { header: 'Service from', cell: ({ getValue }) => formatServiceDate(getValue()) }),
  helper.accessor('valid_to', { header: 'Service to', cell: ({ getValue }) => formatServiceDate(getValue()) }),
  helper.accessor('source_id', { header: 'Source', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span> }),
])

export function ParliamentPage() {
  const search = route.useSearch()
  const setSearch = useSetSearch()
  const query = useListQuery<ServiceTermRow, keyof typeof parliamentSpec.filters>({
    view: 'service_terms',
    select: 'id,person_identity_id,party_identity_id,electorate_version_id,member_name,source_id,representation,electorate_name_at_source,party_label,valid_from,valid_to,observed_first_at,observed_last_at,observed_absent_at',
    spec: parliamentSpec,
    search,
    filter: (q, s) => {
      let next = q
      if (s.party) next = next.ilike('party_label', ilikeContains(s.party))
      if (s.representation) next = next.eq('representation', s.representation)
      if (s.source) next = next.eq('source_id', s.source)
      return next
    },
  })
  return (
    <>
      <PageHeader eyebrow="Civic model · Current Parliament" title="Members of Parliament">
        <p>
          Members as listed in the parliamentary directory. The observation dates say when this project saw the listing. Service
          dates are shown as “not established” unless an official event source sets them.
        </p>
      </PageHeader>
      <div className="mb-4"><Note testId="sitting-mp-note">{SITTING_MP_NOTE}</Note></div>
      <FilterBar hasActive={!!(search.party || search.representation || search.source)} onClear={() => setSearch({ party: undefined, representation: undefined, source: undefined, page: 1 })}>
        <TextFilter name="party" label="Party label contains" value={search.party} onCommit={(v) => setSearch(filterPatch('party', v), { replace: true })} />
        <SelectFilter name="representation" label="Representation" value={search.representation} onChange={(v) => setSearch(filterPatch('representation', v), { replace: true })} options={[{ value: 'electorate', label: 'Electorate' }, { value: 'list', label: 'List' }]} />
        <TextFilter name="source" label="Source id" value={search.source} onCommit={(v) => setSearch(filterPatch('source', v), { replace: true })} placeholder="exact source id" />
      </FilterBar>
      <DataTable caption="Members of Parliament" columns={columns} query={query} spec={parliamentSpec} search={search} onSearchChange={setSearch} getRowId={(row) => row.id} />
    </>
  )
}
