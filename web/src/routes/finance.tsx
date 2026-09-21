import { createColumnHelper } from '@tanstack/react-table'
import { getRouteApi, Link } from '@tanstack/react-router'
import { Pill } from '@/components/badges'
import { DataTable, type CoreFeatures } from '@/components/data-table'
import { FilterBar, SelectFilter } from '@/components/filters'
import { ExternalLink, Note, PageHeader } from '@/components/page'
import { formatMoney, humanise, SCOPE_LABELS, scopeLabel } from '@/lib/format'
import { useListQuery } from '@/lib/queries'
import { financeSpec } from '@/lib/specs'
import type { FinanceReturnRow } from '@/lib/types'
import { filterPatch, useSetSearch } from '@/lib/use-set-search'

const route = getRouteApi('/_released/finance')
const helper = createColumnHelper<CoreFeatures, FinanceReturnRow>()
const columns = helper.columns([
  helper.accessor('return_type', { header: 'Return type', cell: ({ getValue }) => humanise(getValue()) }),
  helper.accessor('reporting_year', { header: 'Reporting year', cell: ({ getValue }) => <span className="num">{getValue() ?? 'not stated by source'}</span> }),
  helper.accessor('filing_status', { header: 'Filing status', cell: ({ row }) => <>{humanise(row.original.filing_status)}{row.original.filing_status_basis ? <span className="block text-xs text-muted-foreground">{row.original.filing_status_basis}</span> : null}</> }),
  helper.accessor('approved_total', { header: 'Total as filed', cell: ({ row }) => <span className="num">{formatMoney(row.original.approved_total, row.original.total_status)}</span> }),
  helper.accessor('is_image_only', { header: 'Format', cell: ({ getValue }) => (getValue() === null ? 'unknown' : getValue() ? <Pill tone="caution">Image only — not machine readable</Pill> : 'Text') }),
  helper.accessor('view_scope', { header: 'Scope', cell: ({ getValue }) => scopeLabel(getValue()) }),
  helper.accessor('official_url', { header: 'Publisher page', cell: ({ getValue }) => <ExternalLink href={getValue()}>Open at publisher</ExternalLink> }),
])

export function FinancePage() {
  const search = route.useSearch()
  const setSearch = useSetSearch()
  const query = useListQuery<FinanceReturnRow, keyof typeof financeSpec.filters>({
    view: 'finance_returns',
    select: '*',
    spec: financeSpec,
    search,
    filter: (q, s) => {
      let next = q
      if (s.type) next = next.eq('return_type', s.type)
      if (s.filing) next = next.eq('filing_status', s.filing)
      return next
    },
  })
  return (
    <>
      <PageHeader eyebrow={`Civic model · ${SCOPE_LABELS.finance_2025}`} title="Finance returns">
        <p>References to finance returns in the {SCOPE_LABELS.finance_2025.toLowerCase()} scope. This is a separate scope from the 2026 election and the 2023 baseline, and is never combined with them.</p>
      </PageHeader>
      <div className="mb-4"><Note tone="caution" testId="no-donor-data">This page is the INDEX of filed returns: one row per return document, with the total as filed. What each return discloses inside it — including donors the return names — is a separate page, <Link to="/donations" className="underline">Donations</Link>. No street address is held on either.</Note></div>
      <FilterBar hasActive={!!(search.type || search.filing)} onClear={() => setSearch({ type: undefined, filing: undefined, page: 1 })}>
        <SelectFilter name="type" label="Return type" value={search.type} onChange={(v) => setSearch(filterPatch('type', v), { replace: true })} options={financeSpec.filters.type.values.map((v) => ({ value: v, label: humanise(v) }))} anyLabel="Any type" />
        <SelectFilter name="filing" label="Filing status" value={search.filing} onChange={(v) => setSearch(filterPatch('filing', v), { replace: true })} options={financeSpec.filters.filing.values.map((v) => ({ value: v, label: humanise(v) }))} anyLabel="Any status" />
      </FilterBar>
      <DataTable caption="Finance returns" columns={columns} query={query} spec={financeSpec} search={search} onSearchChange={setSearch} getRowId={(row) => row.id} />
    </>
  )
}
