import { createColumnHelper } from '@tanstack/react-table'
import { getRouteApi, Link } from '@tanstack/react-router'
import { TombstoneBadge } from '@/components/badges'
import { DataTable, type CoreFeatures } from '@/components/data-table'
import { FilterBar, SelectFilter, TextFilter } from '@/components/filters'
import { Mono, PageHeader } from '@/components/page'
import { formatCount, formatDateTime, formatPublisherDate, humanise, SCOPE_LABELS, SCOPE_ORDER, scopeLabel } from '@/lib/format'
import { useListQuery } from '@/lib/queries'
import { ilikeContains } from '@/lib/search'
import { RECORD_KINDS_HINT, recordsSpec } from '@/lib/specs'
import type { RecordRow } from '@/lib/types'
import { filterPatch, useSetSearch } from '@/lib/use-set-search'

const route = getRouteApi('/_released/records')
const helper = createColumnHelper<CoreFeatures, RecordRow>()

const columns = helper.columns([
  helper.accessor('label', {
    header: 'Record',
    cell: ({ row }) => (
      <div className="space-y-0.5">
        <Link to="/records/$recordId" params={{ recordId: row.original.id }} className="doc-link font-medium">
          {row.original.label ?? 'No label field in stored payload'}
        </Link>
        <p className="font-mono text-xs break-all text-muted-foreground">{row.original.external_record_id}</p>
        {row.original.tombstoned_at ? <TombstoneBadge reason={row.original.tombstone_reason} /> : null}
      </div>
    ),
  }),
  helper.accessor('record_kind', { header: 'Kind', cell: ({ getValue }) => <Mono>{getValue()}</Mono> }),
  helper.accessor('source_id', {
    header: 'Source',
    cell: ({ getValue }) => (
      <Link to="/sources/$sourceId" params={{ sourceId: getValue() }} className="doc-link font-mono text-xs">
        {getValue()}
      </Link>
    ),
  }),
  helper.accessor('view_scope', { header: 'Scope', cell: ({ getValue }) => scopeLabel(getValue()) }),
  helper.accessor('source_published_at', { header: 'Publisher date', cell: ({ row }) => formatPublisherDate(row.original.source_published_at, row.original.source_date_text) }),
  helper.accessor('last_seen_at', { header: 'Last retrieved', cell: ({ getValue }) => formatDateTime(getValue()) }),
  helper.accessor('version_count', { header: 'Versions', cell: ({ getValue }) => <span className="num">{formatCount(getValue())}</span> }),
])

const SELECT = 'id,source_id,view_scope,external_record_id,record_kind,label,source_published_at,source_date_text,last_seen_at,tombstoned_at,tombstone_reason,version_count'

export function RecordsPage() {
  const search = route.useSearch()
  const setSearch = useSetSearch()
  const query = useListQuery<RecordRow, keyof typeof recordsSpec.filters>({
    view: 'records',
    select: SELECT,
    spec: recordsSpec,
    search,
    filter: (q, s) => {
      let next = q
      if (s.source) next = next.eq('source_id', s.source)
      if (s.kind) next = next.eq('record_kind', s.kind)
      if (s.scope) next = next.eq('view_scope', s.scope)
      if (s.q) next = next.ilike('label', ilikeContains(s.q))
      if (s.tombstoned === 'only') next = next.not('tombstoned_at', 'is', null)
      else if (s.tombstoned !== 'include') next = next.is('tombstoned_at', null)
      return next
    },
  })

  const kinds: string[] = [...RECORD_KINDS_HINT]
  if (search.kind && !kinds.includes(search.kind)) kinds.push(search.kind)
  const active = !!(search.source || search.kind || search.scope || search.q || search.tombstoned)

  return (
    <>
      <PageHeader eyebrow="Evidence" title="Records">
        <p>
          One row per item retrieved from a source. Only fields that passed the storage allowlist are held; publisher text is linked,
          not copied. Tombstoned records are hidden unless you include them.
        </p>
      </PageHeader>
      <FilterBar hasActive={active} onClear={() => setSearch({ source: undefined, kind: undefined, scope: undefined, q: undefined, tombstoned: undefined, page: 1 })}>
        <TextFilter name="q" label="Label contains" value={search.q} onCommit={(v) => setSearch(filterPatch('q', v), { replace: true })} />
        <TextFilter name="source" label="Source id" value={search.source} onCommit={(v) => setSearch(filterPatch('source', v), { replace: true })} placeholder="exact source id" />
        <SelectFilter name="kind" label="Record kind" value={search.kind} onChange={(v) => setSearch(filterPatch('kind', v), { replace: true })} options={kinds.map((k) => ({ value: k, label: humanise(k) }))} anyLabel="Any kind" />
        <SelectFilter name="scope" label="Scope" value={search.scope} onChange={(v) => setSearch(filterPatch('scope', v), { replace: true })} options={SCOPE_ORDER.map((s) => ({ value: s, label: SCOPE_LABELS[s] }))} anyLabel="Any scope" />
        <SelectFilter
          name="tombstoned"
          label="Tombstoned"
          value={search.tombstoned}
          onChange={(v) => setSearch(filterPatch('tombstoned', v), { replace: true })}
          options={[
            { value: 'include', label: 'Include tombstoned' },
            { value: 'only', label: 'Only tombstoned' },
          ]}
          anyLabel="Exclude tombstoned"
        />
      </FilterBar>
      <DataTable caption="Records" columns={columns} query={query} spec={recordsSpec} search={search} onSearchChange={setSearch} getRowId={(row) => row.id} />
    </>
  )
}
