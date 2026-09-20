import { createColumnHelper } from '@tanstack/react-table'
import { getRouteApi, Link } from '@tanstack/react-router'
import { LinkStatusBadge } from '@/components/badges'
import { DataTable, type CoreFeatures } from '@/components/data-table'
import { FilterBar, SelectFilter, TextFilter } from '@/components/filters'
import { Note, PageHeader } from '@/components/page'
import { formatCount, humanise , NOT_SHOWN } from '@/lib/format'
import { useListQuery } from '@/lib/queries'
import { ilikeContains } from '@/lib/search'
import { identitiesSpec } from '@/lib/specs'
import type { PersonIdentityRow } from '@/lib/types'
import { filterPatch, useSetSearch } from '@/lib/use-set-search'

const route = getRouteApi('/_released/people')
export const UNRESOLVED_NOTE = 'Not linked to a canonical person — identities are never merged by name'

const identityHelper = createColumnHelper<CoreFeatures, PersonIdentityRow>()
const identityColumns = identityHelper.columns([
  identityHelper.accessor('name_at_source', {
    header: 'Name at source',
    cell: ({ row }) => (
      <Link to="/people/$identityId" params={{ identityId: row.original.id }} className="doc-link font-medium">
        {row.original.name_at_source ?? NOT_SHOWN}
      </Link>
    ),
  }),
  identityHelper.accessor('source_id', { header: 'Source', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span> }),
  identityHelper.accessor('link_status', {
    header: 'Canonical person',
    cell: ({ row }) =>
      row.original.person_id ? (
        <div className="space-y-0.5"><LinkStatusBadge status={row.original.link_status} /><p>{row.original.linked_person_name}</p></div>
      ) : (
        <div className="space-y-0.5"><LinkStatusBadge status={row.original.link_status} /><p className="text-xs text-muted-foreground">{UNRESOLVED_NOTE}</p></div>
      ),
  }),
  identityHelper.accessor('service_terms', { header: 'Service terms', cell: ({ getValue }) => <span className="num">{formatCount(getValue())}</span> }),
  identityHelper.accessor('candidacies', { header: 'Candidacies', cell: ({ getValue }) => <span className="num">{formatCount(getValue())}</span> }),
  identityHelper.accessor('open_proposals', { header: 'Open proposals', cell: ({ getValue }) => <span className="num">{formatCount(getValue())}</span> }),
])

type F = keyof typeof identitiesSpec.filters

export function PeoplePage() {
  const search = route.useSearch()
  const setSearch = useSetSearch()

  const identities = useListQuery<PersonIdentityRow, F>({
    view: 'person_identities',
    select: 'id,source_id,name_at_source,link_status,person_id,linked_person_name,service_terms,candidacies,open_proposals',
    spec: identitiesSpec,
    search,
    filter: (q, s) => {
      let next = q
      if (s.q) next = next.ilike('name_at_source', ilikeContains(s.q))
      if (s.source) next = next.eq('source_id', s.source)
      if (s.link) next = next.eq('link_status', s.link)
      return next
    },
  })


  return (
    <>
      <PageHeader eyebrow="Civic model" title="People">
        <p>
          Only elected members, candidates and office-holders acting in a public capacity appear here. A source identity is one name
          as one source wrote it. Two identities become one person only through a reviewed decision by a named reviewer.
        </p>
      </PageHeader>
      <div className="mb-4"><Note testId="unresolved-note">{UNRESOLVED_NOTE}. The same name in two sources, or twice in one source, stays as separate identities until a person reviews the evidence.</Note></div>

      <div className="mb-4"><Note testId="people-withheld-note">Reviewed canonical people are not published: a canonical person is assembled from several sources, so a row has no single source whose rights could govern it. Source identities are published instead; the reason is listed under Datasets and schema.</Note></div>

      <FilterBar hasActive={!!(search.q || search.source || search.link)} onClear={() => setSearch({ q: undefined, source: undefined, link: undefined, page: 1 })}>
        <TextFilter name="q" label="Name contains" value={search.q} onCommit={(v) => setSearch(filterPatch('q', v), { replace: true })} />
        <>
            <TextFilter name="source" label="Source id" value={search.source} onCommit={(v) => setSearch(filterPatch('source', v), { replace: true })} placeholder="exact source id" />
            <SelectFilter name="link" label="Link status" value={search.link} onChange={(v) => setSearch(filterPatch('link', v), { replace: true })} options={['unresolved', 'proposed', 'approved', 'rejected'].map((v) => ({ value: v, label: humanise(v) }))} anyLabel="Any status" />
        </>
      </FilterBar>

      <DataTable caption="Source identities" columns={identityColumns} query={identities} spec={identitiesSpec} search={search} onSearchChange={setSearch} getRowId={(row) => row.id} />
    </>
  )
}
