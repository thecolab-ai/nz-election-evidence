import { createColumnHelper } from '@tanstack/react-table'
import { getRouteApi, Link } from '@tanstack/react-router'
import { TombstoneBadge } from '@/components/badges'
import { DataTable, type CoreFeatures } from '@/components/data-table'
import { FilterBar, SelectFilter, TextFilter } from '@/components/filters'
import { ExternalLink, PageHeader, Section } from '@/components/page'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import { SummaryCard } from '@/components/summary-card'
import { formatDate, formatDateTime, humanise, NOT_STATED, SCOPE_LABELS, SCOPE_ORDER, scopeLabel } from '@/lib/format'
import { useListQuery, useRowsQuery } from '@/lib/queries'
import { ilikeContains } from '@/lib/search'
import { DOCUMENT_TYPES, documentsSpec } from '@/lib/specs'
import type { DocumentRow, SummaryRow } from '@/lib/types'
import { filterPatch, useSetSearch } from '@/lib/use-set-search'

const route = getRouteApi('/_released/documents')
const helper = createColumnHelper<CoreFeatures, DocumentRow>()
const columns = helper.columns([
  helper.accessor('title', {
    header: 'Document',
    cell: ({ row }) => (
      <div className="space-y-0.5">
        <Link to="/records/$recordId" params={{ recordId: row.original.source_record_id }} className="doc-link font-medium">{row.original.title ?? 'Untitled at source'}</Link>
        {row.original.bill_number ? <p className="text-xs text-muted-foreground">Bill {row.original.bill_number}{row.original.current_stage ? ` · ${row.original.current_stage}` : ''}{row.original.select_committee ? ` · ${row.original.select_committee}` : ''}</p> : null}
        {row.original.member_name_at_source ? <p className="text-xs text-muted-foreground">Member in charge at source: {row.original.member_name_at_source}{row.original.party_label_at_source ? ` (${row.original.party_label_at_source})` : ''}</p> : null}
        {row.original.tombstoned_at ? <TombstoneBadge /> : null}
      </div>
    ),
  }),
  helper.accessor('document_type', { header: 'Type', cell: ({ getValue }) => humanise(getValue()) }),
  helper.accessor('view_scope', { header: 'Scope', cell: ({ getValue }) => scopeLabel(getValue()) }),
  helper.accessor('source_published_at', { header: 'Publisher date', cell: ({ getValue }) => formatDate(getValue(), NOT_STATED) }),
  helper.accessor('first_retrieved_at', { header: 'First retrieved', cell: ({ getValue }) => formatDateTime(getValue()) }),
  helper.accessor('official_url', { header: 'Publisher page', cell: ({ getValue }) => <ExternalLink href={getValue()}>Open at publisher</ExternalLink> }),
])

export function DocumentsPage() {
  const search = route.useSearch()
  const setSearch = useSetSearch()
  const query = useListQuery<DocumentRow, keyof typeof documentsSpec.filters>({
    view: 'documents',
    select: '*',
    spec: documentsSpec,
    search,
    filter: (q, s) => {
      let next = q
      if (s.type) next = next.eq('document_type', s.type)
      if (s.scope) next = next.eq('view_scope', s.scope)
      if (s.source) next = next.eq('source_id', s.source)
      if (s.q) next = next.ilike('title', ilikeContains(s.q))
      return next
    },
  })
  const summaries = useRowsQuery<SummaryRow>({ view: 'summaries', select: '*', key: ['documents'], limit: 25, build: (q) => q.order('created_at', { ascending: false }) })

  return (
    <>
      <PageHeader eyebrow="Evidence" title="Documents">
        <p>Bills, releases and other documents, by reference. Titles and links only: document bodies are never stored or shown here. Read the document at the publisher.</p>
      </PageHeader>
      <FilterBar hasActive={!!(search.type || search.scope || search.q || search.source)} onClear={() => setSearch({ type: undefined, scope: undefined, q: undefined, source: undefined, page: 1 })}>
        <TextFilter name="q" label="Title contains" value={search.q} onCommit={(v) => setSearch(filterPatch('q', v), { replace: true })} />
        <SelectFilter name="type" label="Type" value={search.type} onChange={(v) => setSearch(filterPatch('type', v), { replace: true })} options={DOCUMENT_TYPES.map((t) => ({ value: t, label: humanise(t) }))} anyLabel="Any type" />
        <SelectFilter name="scope" label="Scope" value={search.scope} onChange={(v) => setSearch(filterPatch('scope', v), { replace: true })} options={SCOPE_ORDER.map((s) => ({ value: s, label: SCOPE_LABELS[s] }))} anyLabel="Any scope" />
        <TextFilter name="source" label="Source id" value={search.source} onCommit={(v) => setSearch(filterPatch('source', v), { replace: true })} placeholder="exact source id" />
      </FilterBar>
      <DataTable caption="Documents" columns={columns} query={query} spec={documentsSpec} search={search} onSearchChange={setSearch} getRowId={(row) => row.id} />

      <Section id="summaries" title="Model-assisted summaries" className="mt-12" description="Any text below was produced by a model. It is labelled with the model, version and prompt, and is not a finding about any person. The primary source is always the authority.">
        {summaries.isPending ? <LoadingBlock label="Loading summaries" rows={2} /> : summaries.isError ? <ErrorBlock error={summaries.error} onRetry={() => void summaries.refetch()} /> : summaries.data.length === 0 ? <EmptyBlock message="No rows. No model output has been stored — it is not evidence of absence." /> : (
          <div className="space-y-4">{summaries.data.map((s) => <SummaryCard key={s.id} summary={s} />)}</div>
        )}
      </Section>
    </>
  )
}
