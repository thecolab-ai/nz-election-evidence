import { createColumnHelper } from '@tanstack/react-table'
import { getRouteApi } from '@tanstack/react-router'
import { useMemo } from 'react'
import { TableRow } from '@/components/ui/table'
import { Pill } from '@/components/badges'
import { DataTable, type CoreFeatures } from '@/components/data-table'
import { FilterBar, TextFilter } from '@/components/filters'
import { JsonViewer } from '@/components/json-viewer'
import { Mono, Note, PageHeader, Section } from '@/components/page'
import { Button } from '@/components/ui/button'
import { formatCount, formatDateTime, formatPlainDate, formatStatValue, humanise, NOT_SHOWN } from '@/lib/format'
import { useListQuery, useRowsQuery } from '@/lib/queries'
import { ilikeContains, isUuid } from '@/lib/search'
import { statObservationsSpec, statSeriesSpec } from '@/lib/specs'
import type { StatObservationRow, StatRouteRow, StatSeriesRow } from '@/lib/types'
import { filterPatch, useSetSearch } from '@/lib/use-set-search'
import { Cell, Panel } from './source-detail'

const route = getRouteApi('/_released/statistics')
const seriesHelper = createColumnHelper<CoreFeatures, StatSeriesRow>()
type F = keyof typeof statSeriesSpec.filters

const obsHelper = createColumnHelper<CoreFeatures, StatObservationRow>()
const observationColumns = obsHelper.columns([
  obsHelper.accessor('period_label', { header: 'Period' }),
  obsHelper.accessor('geography_name', { header: 'Geography', cell: ({ row }) => (row.original.geography_name ? `${row.original.geography_name} (${row.original.geography_scheme ?? 'scheme unknown'} ${row.original.geography_edition ?? ''})`.trim() : 'not stated by source') }),
  obsHelper.accessor('value', {
    header: 'Value',
    cell: ({ row }) => <span className="num" data-testid="stat-value" data-value-status={row.original.value_status}>{formatStatValue(row.original.value, row.original.value_double, row.original.value_status)}</span>,
  }),
  obsHelper.accessor('value_status', { header: 'Value status', cell: ({ getValue }) => <Pill tone={getValue() === 'reported' ? 'plain' : 'caution'}>{humanise(getValue())}</Pill> }),
  obsHelper.accessor('raw_value', { header: 'As written by source', cell: ({ getValue }) => (getValue() ? <Mono>{getValue()}</Mono> : '—') }),
  obsHelper.accessor('release_key', { header: 'Release', cell: ({ row }) => `${row.original.release_key}${row.original.released_on ? ` · ${formatPlainDate(row.original.released_on)}` : ''}` }),
  obsHelper.accessor('canonical_route', { header: 'Route', cell: ({ getValue }) => humanise(getValue()) }),
])

export function StatisticsPage() {
  const search = route.useSearch()
  const setSearch = useSetSearch()
  const seriesId = isUuid(search.series) ? search.series : undefined

  const seriesColumns = useMemo(() => seriesHelper.columns([
    seriesHelper.accessor('dataset_title', { header: 'Dataset' }),
    seriesHelper.accessor('title', { header: 'Series', cell: ({ row }) => <>{row.original.title ?? NOT_SHOWN}<span className="block font-mono text-xs text-muted-foreground">{row.original.series_key}</span></> }),
    seriesHelper.accessor('unit', { header: 'Unit', cell: ({ row }) => [row.original.unit, row.original.magnitude].filter(Boolean).join(' · ') || 'not stated by source' }),
    seriesHelper.accessor('observations', { header: 'Observations', cell: ({ getValue }) => <span className="num">{formatCount(getValue())}</span> }),
    seriesHelper.display({
      id: 'open',
      header: 'Observations',
      cell: ({ row }) => (
        <Button type="button" variant="outline" size="sm" onClick={() => setSearch({ series: row.original.id, page: 1, sort: undefined, dir: undefined })}>
          View observations<span className="sr-only"> for {row.original.title ?? row.original.series_key}</span>
        </Button>
      ),
    }),
  ]), [setSearch])

  const series = useListQuery<StatSeriesRow, F>({
    view: 'stat_series',
    select: '*',
    spec: statSeriesSpec,
    search,
    enabled: !seriesId,
    filter: (q, s) => (s.q ? q.ilike('title', ilikeContains(s.q)) : q),
  })
  const observations = useListQuery<StatObservationRow, F>({
    view: 'stat_observations',
    select: '*',
    spec: statObservationsSpec,
    search,
    count: 'estimated',
    enabled: !!seriesId,
    scopeKey: [seriesId],
    filter: (q) => q.eq('series_id', seriesId ?? ''),
  })
  const routes = useRowsQuery<StatRouteRow>({ view: 'stat_route_reconciliation', select: '*', key: ['statistics'], limit: 50, build: (q) => q.order('observation_family') })

  return (
    <>
      <PageHeader eyebrow="Civic model · Statistics" title="Statistical series">
        <p>Official statistical series and their observations. Every observation carries a value status. A suppressed, confidential or missing value is written out in words and is never shown as 0.</p>
      </PageHeader>

      {seriesId ? (
        <Section id="observations" title="Observations">
          <p className="mb-3 text-sm">
            <Button type="button" variant="outline" size="sm" onClick={() => setSearch({ series: undefined, page: 1, sort: undefined, dir: undefined })}>← All series</Button>
            <span className="ml-3 text-muted-foreground">Series <Mono>{seriesId}</Mono></span>
          </p>
          <div className="mb-3"><Note>Unknown is not zero: only observations with a status of “reported” or “provisional” show a number.</Note></div>
          <DataTable caption="Statistical observations" columns={observationColumns} query={observations} spec={statObservationsSpec} search={search} onSearchChange={setSearch} getRowId={(row) => String(row.id)} />
        </Section>
      ) : (
        <Section id="series" title="Series">
          <FilterBar hasActive={!!search.q} onClear={() => setSearch({ q: undefined, page: 1 })}>
            <TextFilter name="q" label="Series title contains" value={search.q} onCommit={(v) => setSearch(filterPatch('q', v), { replace: true })} />
          </FilterBar>
          <DataTable caption="Statistical series" columns={seriesColumns} query={series} spec={statSeriesSpec} search={search} onSearchChange={setSearch} getRowId={(row) => row.id} />
        </Section>
      )}

      <Section id="routes" title="Route reconciliation" className="mt-12" description="Where one family of observations could arrive by more than one import route, exactly one route is canonical, so nothing is counted twice.">
        <Panel query={routes} caption="Route reconciliation" head={['Observation family', 'Canonical route', 'Overlapping routes', 'Upstream rows by route', 'Decision']} limit={50}>
          {(r) => (
            <TableRow key={r.observation_family}>
              <Cell><Mono>{r.observation_family}</Mono></Cell>
              <Cell>{humanise(r.canonical_route)}</Cell>
              <Cell><JsonViewer value={r.overlapping_routes} label="Overlapping routes" /></Cell>
              <Cell><JsonViewer value={r.upstream_rows_by_route} label="Upstream rows" /></Cell>
              <Cell>{r.decision_note ?? '—'}<span className="block text-xs text-muted-foreground">{r.decided_at ? `Decided ${formatDateTime(r.decided_at)}` : 'no decision recorded'}</span></Cell>
            </TableRow>
          )}
        </Panel>
      </Section>
    </>
  )
}
