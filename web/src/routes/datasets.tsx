import { createColumnHelper } from '@tanstack/react-table'
import { getRouteApi, Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { DataTable, type CoreFeatures, type DataColumn } from '@/components/data-table'
import { FilterBar, SelectFilter, TextFilter } from '@/components/filters'
import { JsonViewer } from '@/components/json-viewer'
import { Note, PageHeader, Section } from '@/components/page'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import { formatCount } from '@/lib/format'
import { useListQuery, useRowsQuery, type DatasetRef } from '@/lib/queries'
import { ilikeContains, type ListSpec } from '@/lib/search'
import { datasetsSpec } from '@/lib/specs'
import type { OpenTableName, PublicViewName } from '@/lib/supabase'
import type { DatasetCatalogueRow, DatasetColumnRow, Json } from '@/lib/types'
import { filterPatch, useSetSearch } from '@/lib/use-set-search'
import { useSurfaceStatus } from './access'

const listRoute = getRouteApi('/_catalogue/datasets')
const detailRoute = getRouteApi('/_catalogue/datasets/$schema/$name')

export const LAYER_LABELS: Record<string, string> = {
  evidence_open: 'Table projection',
  evidence_public: 'Curated view',
}

export const DISPOSITION_LABELS: Record<string, string> = {
  public: 'Public',
  link_metadata: 'Link metadata — shown',
  rights_gated_content: 'Content — needs publisher approval',
  withheld: 'Withheld — reason given',
}

export function DispositionBadge({ disposition }: { disposition: string }) {
  const label = DISPOSITION_LABELS[disposition] ?? disposition
  return disposition === 'public' || disposition === 'link_metadata' ? <Badge variant="secondary">{label}</Badge> : <Badge variant="outline">{label}</Badge>
}

const helper = createColumnHelper<CoreFeatures, DatasetCatalogueRow>()
const columns = helper.columns([
  helper.accessor('dataset', {
    header: 'Dataset',
    cell: ({ row }) => (
      <Link to="/datasets/$schema/$name" params={{ schema: row.original.exposed_schema, name: row.original.dataset }} className="doc-link font-mono text-[13px]">
        {row.original.dataset}
      </Link>
    ),
  }),
  helper.accessor('exposed_schema', { header: 'Layer', cell: ({ getValue }) => LAYER_LABELS[getValue()] ?? getValue() }),
  helper.accessor('disposition', { header: 'Disposition', cell: ({ getValue }) => <DispositionBadge disposition={getValue()} /> }),
  helper.accessor('columns_total', { header: 'Columns', cell: ({ row }) => <span className="num">{row.original.columns_total}{row.original.columns_withheld > 0 ? ` (${row.original.columns_withheld} withheld)` : ''}{row.original.columns_rights_gated > 0 ? ` (${row.original.columns_rights_gated} rights-gated)` : ''}</span> }),
  helper.accessor('approximate_rows', { header: 'Rows (estimate)', cell: ({ getValue }) => { const v = getValue(); return <span className="num">{v === null ? 'not estimated' : formatCount(v)}</span> } }),
  helper.accessor('description', { header: 'Description', cell: ({ row }) => row.original.withheld_reason ?? row.original.row_rule_reason ?? row.original.description ?? 'no description recorded' }),
])

export function DatasetsPage() {
  const search = listRoute.useSearch()
  const setSearch = useSetSearch()
  const query = useListQuery<DatasetCatalogueRow, keyof typeof datasetsSpec.filters>({
    view: 'dataset_catalogue',
    select: '*',
    spec: datasetsSpec,
    search,
    filter: (q, s) => {
      let next = q
      if (s.layer) next = next.eq('exposed_schema', s.layer)
      if (s.disposition) next = next.eq('disposition', s.disposition)
      if (s.q) next = next.ilike('dataset', ilikeContains(s.q))
      return next
    },
  })
  return (
    <>
      <PageHeader eyebrow="Stewardship" title="Datasets and schema">
        <p>
          Every table in the evidence store is listed here, with every column and what happens to it. The rule is default deny: a
          dataset is shown only if every row can be traced to one source, and then only for sources whose publisher rights allow it.
          Link metadata is shown; content is blank unless that source's publisher has approved the field; withheld columns carry
          their reason.
        </p>
      </PageHeader>
      <div className="mb-4 space-y-2">
        <Note>Row estimates come from database statistics and can lag. An estimate of zero is not evidence that a dataset is empty.</Note>
        <Note tone="caution">Never published in any layer: account and sign-in records, credentials and secrets, scheduler internals, file or archive locations, donor contact details and full document bodies. The store does not hold the last three at all.</Note>
      </div>
      <FilterBar hasActive={!!(search.layer || search.disposition || search.q)} onClear={() => setSearch({ layer: undefined, disposition: undefined, q: undefined, page: 1 })}>
        <SelectFilter name="layer" label="Layer" value={search.layer} onChange={(v) => setSearch(filterPatch('layer', v), { replace: true })} options={datasetsSpec.filters.layer.values.map((v) => ({ value: v, label: LAYER_LABELS[v] ?? v }))} anyLabel="Both layers" />
        <SelectFilter name="disposition" label="Disposition" value={search.disposition} onChange={(v) => setSearch(filterPatch('disposition', v), { replace: true })} options={[{ value: 'public', label: 'Public' }, { value: 'withheld', label: 'Withheld' }]} anyLabel="Any" />
        <TextFilter name="q" label="Name contains" value={search.q} onCommit={(v) => setSearch(filterPatch('q', v), { replace: true })} />
      </FilterBar>
      <DataTable caption="Dataset catalogue" columns={columns} query={query} spec={datasetsSpec} search={search} onSearchChange={setSearch} getRowId={(row) => `${row.exposed_schema}.${row.dataset}`} />
    </>
  )
}

/** Generic cell: scalars as text, structured values in the collapsible JSON viewer, null said plainly. */
export function renderCell(value: unknown) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">null</span>
  if (typeof value === 'object') return <JsonViewer value={value as Json} label="Value" />
  const text = String(value)
  return <span className="break-words" title={text.length > 120 ? text : undefined}>{text.length > 120 ? `${text.slice(0, 120)}…` : text}</span>
}

type GenericRow = Record<string, unknown>

function DatasetRows({ dataset, publicColumns }: { dataset: DatasetRef; publicColumns: DatasetColumnRow[] }) {
  const search = detailRoute.useSearch()
  const setSearch = useSetSearch()
  const names = useMemo(() => publicColumns.map((c) => c.column_name), [publicColumns])
  // Sort keys are limited to the published column names of this dataset; anything else in the URL is dropped.
  const spec = useMemo<ListSpec<never>>(() => ({ sortable: names, defaultSort: names[0] ? [{ column: names[0], dir: 'asc' }] : [], tiebreak: names[0] ?? '', filters: {} as Record<never, never> }), [names])
  const safeSearch = useMemo(() => (search.sort && !names.includes(search.sort) ? { ...search, sort: undefined, dir: undefined } : search), [search, names])
  const genericHelper = useMemo(() => createColumnHelper<CoreFeatures, GenericRow>(), [])
  const tableColumns = useMemo<DataColumn<GenericRow>[]>(
    () => names.map((name) => genericHelper.accessor((row) => row[name], { id: name, header: name, cell: ({ getValue }) => renderCell(getValue()) })),
    [names, genericHelper],
  )
  const query = useListQuery<GenericRow, never>({ view: dataset, select: names.join(','), spec, search: safeSearch, count: 'estimated', enabled: names.length > 0 })
  return <DataTable caption="Rows" columns={tableColumns} query={query} spec={spec} search={safeSearch} onSearchChange={setSearch} getRowId={(row) => names.slice(0, 3).map((n) => String(row[n])).join('|')} />
}

export function DatasetDetailPage() {
  const { schema, name } = detailRoute.useParams()
  const status = useSurfaceStatus()
  const catalogue = useRowsQuery<DatasetCatalogueRow>({ view: 'dataset_catalogue', select: '*', key: [schema, name], limit: 1, build: (q) => q.eq('exposed_schema', schema).eq('dataset', name) })
  const cols = useRowsQuery<DatasetColumnRow>({ view: 'dataset_columns', select: '*', key: [schema, name], limit: 200, build: (q) => q.eq('exposed_schema', schema).eq('dataset', name).order('ordinal') })

  if (catalogue.isPending || cols.isPending) return <LoadingBlock label="Loading dataset description" rows={5} />
  if (catalogue.isError) return <ErrorBlock error={catalogue.error} onRetry={() => void catalogue.refetch()} />
  if (cols.isError) return <ErrorBlock error={cols.error} onRetry={() => void cols.refetch()} />
  const entry = catalogue.data[0]
  if (!entry) return <EmptyBlock message="There is no dataset with that name in the published catalogue." />

  // The name has just been confirmed against the published catalogue, so it is a real dataset of that layer.
  const dataset: DatasetRef = schema === 'evidence_open' ? { open: name as OpenTableName } : (name as PublicViewName)
  const publicColumns = cols.data.filter((c) => c.disposition !== 'withheld')
  const released = (status.data ?? []).length > 0 && (status.data ?? []).every((g) => g.public_rows_released === true)

  return (
    <>
      <PageHeader eyebrow={LAYER_LABELS[entry.exposed_schema] ?? entry.exposed_schema} title={entry.dataset}>
        <p>{entry.description ?? 'No description is recorded for this dataset.'}</p>
      </PageHeader>
      <div className="mb-6 space-y-2">
        {entry.disposition === 'withheld' ? <Note tone="caution" testId="dataset-withheld">This whole dataset is withheld. Reason: {entry.withheld_reason}</Note> : null}
        {entry.lineage_note ? <Note testId="dataset-lineage">Source lineage: {entry.lineage_note}</Note> : null}
        {entry.row_rule_reason ? <Note testId="dataset-row-rule">Some rows are withheld. Reason: {entry.row_rule_reason}</Note> : null}
      </div>
      <Section title="Columns" description="Every column of the underlying table or view, whether or not it is public.">
        <div className="overflow-x-auto border border-border bg-paper">
          <table className="w-full text-left text-sm" data-testid="dataset-columns">
            <caption className="sr-only">Columns of {entry.dataset}</caption>
            <thead>
              <tr className="border-b border-border">
                {['Column', 'Type', 'Nullable', 'Disposition', 'Notes'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {cols.data.map((c) => (
                <tr key={c.column_name} className="border-b border-border last:border-0 align-top">
                  <td className="px-3 py-2 font-mono text-[13px]">{c.column_name}</td>
                  <td className="px-3 py-2 font-mono text-[13px]">{c.data_type}</td>
                  <td className="px-3 py-2">{c.nullable ? 'yes' : 'no'}</td>
                  <td className="px-3 py-2"><DispositionBadge disposition={c.disposition} /></td>
                  <td className="px-3 py-2">{c.withheld_reason ?? c.description ?? ''}{c.field_token ? <span className="block font-mono text-xs text-muted-foreground">field token: {c.field_token}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      {entry.disposition === 'public' ? (
        <Section title="Rows" description="Read-only, paginated, in the order of the first column unless you choose another.">
          {released ? <DatasetRows dataset={dataset} publicColumns={publicColumns} /> : <Note tone="caution" testId="rows-withheld">Rows are withheld until the release gates are recorded as open. The column list above is always public.</Note>}
        </Section>
      ) : null}
    </>
  )
}
