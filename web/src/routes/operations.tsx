import { createColumnHelper } from '@tanstack/react-table'
import { getRouteApi, Link } from '@tanstack/react-router'
import { RunStatusBadge, StateBadge } from '@/components/badges'
import { DataTable, type CoreFeatures } from '@/components/data-table'
import { FilterBar, SelectFilter, TextFilter } from '@/components/filters'
import { JsonViewer } from '@/components/json-viewer'
import { Mono, Note, PageHeader } from '@/components/page'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatCount, formatDateTime, humanise, UNAVAILABLE_EXPLANATION } from '@/lib/format'
import { useListQuery } from '@/lib/queries'
import { errorsSpec, RUN_STATUSES, runsSpec, schedulesSpec } from '@/lib/specs'
import type { ImportRunRow, IngestErrorRow, ScheduleRow } from '@/lib/types'
import { filterPatch, useSetSearch } from '@/lib/use-set-search'

const route = getRouteApi('/_released/operations')
type F = keyof typeof runsSpec.filters

const sourceLink = (sourceId: string) => (
  <Link to="/sources/$sourceId" params={{ sourceId }} className="doc-link font-mono text-xs">{sourceId}</Link>
)

const runHelper = createColumnHelper<CoreFeatures, ImportRunRow>()
const runColumns = runHelper.columns([
  runHelper.accessor('started_at', { header: 'Started', cell: ({ getValue }) => formatDateTime(getValue()) }),
  runHelper.accessor('source_id', { header: 'Source', cell: ({ getValue }) => sourceLink(getValue()) }),
  runHelper.accessor('status', { header: 'Status', cell: ({ getValue }) => <RunStatusBadge status={getValue()} /> }),
  runHelper.accessor('mode', { header: 'Mode', cell: ({ row }) => `${humanise(row.original.mode)} · ${row.original.trigger_kind}` }),
  runHelper.accessor('finished_at', { header: 'Finished', cell: ({ getValue }) => formatDateTime(getValue(), 'still running') }),
  runHelper.accessor('records_seen', { header: 'Seen', cell: ({ getValue }) => <span className="num">{formatCount(getValue())}</span> }),
  runHelper.accessor('versions_inserted', { header: 'New versions', cell: ({ getValue }) => <span className="num">{formatCount(getValue())}</span> }),
  runHelper.accessor('rejected', { header: 'Rejected', cell: ({ getValue }) => <span className="num">{formatCount(getValue())}</span> }),
  runHelper.accessor('tombstoned', { header: 'Tombstoned', cell: ({ getValue }) => <span className="num">{formatCount(getValue())}</span> }),
  runHelper.accessor('error_class', { header: 'Error', cell: ({ row }) => (row.original.error_class ? <><Mono>{row.original.error_class}</Mono></> : '—') }),
])

const errorHelper = createColumnHelper<CoreFeatures, IngestErrorRow>()
const errorColumns = errorHelper.columns([
  errorHelper.accessor('occurred_at', { header: 'Occurred', cell: ({ getValue }) => formatDateTime(getValue()) }),
  errorHelper.accessor('source_id', { header: 'Source', cell: ({ getValue }) => sourceLink(getValue()) }),
  errorHelper.accessor('error_class', { header: 'Class', cell: ({ getValue }) => <Mono>{getValue()}</Mono> }),
])

const scheduleHelper = createColumnHelper<CoreFeatures, ScheduleRow>()
const scheduleColumns = scheduleHelper.columns([
  scheduleHelper.accessor('schedule_key', { header: 'Schedule', cell: ({ getValue }) => <Mono>{getValue()}</Mono> }),
  scheduleHelper.accessor('source_id', { header: 'Source', cell: ({ getValue }) => sourceLink(getValue()) }),
  scheduleHelper.accessor('cron_expr', { header: 'Cron (UTC)', cell: ({ getValue }) => <Mono>{getValue()}</Mono> }),
  scheduleHelper.accessor('state', { header: 'State', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
  scheduleHelper.accessor('activation_proof', {
    header: 'Activation proof',
    cell: ({ row }) =>
      row.original.state === 'active' ? (
        <div className="space-y-1">
          <p>Activated {formatDateTime(row.original.activated_at)} <span className="text-muted-foreground">(operator name withheld)</span></p>
          {row.original.activation_proof ? <JsonViewer value={row.original.activation_proof} label="Activation proof" /> : <p className="text-muted-foreground">no proof recorded</p>}
        </div>
      ) : (
        'not activated — no proof expected'
      ),
  }),
  scheduleHelper.accessor('max_records', { header: 'Limits', cell: ({ row }) => <span className="num">{row.original.max_records} records · {row.original.max_runtime_seconds}s</span> }),
  scheduleHelper.accessor('last_dispatch_at', { header: 'Last dispatch', cell: ({ row }) => (row.original.last_dispatch_at ? `${formatDateTime(row.original.last_dispatch_at)} · ${humanise(row.original.last_dispatch_outcome)}` : 'never dispatched') }),
])

export function OperationsPage() {
  const search = route.useSearch()
  const setSearch = useSetSearch()
  const tab = search.tab ?? 'runs'

  const runs = useListQuery<ImportRunRow, F>({
    view: 'import_runs', select: '*', spec: runsSpec, search, enabled: tab === 'runs',
    filter: (q, s) => {
      let next = q
      if (s.source) next = next.eq('source_id', s.source)
      if (s.status) next = next.eq('status', s.status)
      return next
    },
  })
  const errors = useListQuery<IngestErrorRow, F>({
    view: 'ingest_errors', select: '*', spec: errorsSpec, search, enabled: tab === 'errors',
    filter: (q, s) => (s.source ? q.eq('source_id', s.source) : q),
  })
  const schedules = useListQuery<ScheduleRow, F>({
    view: 'schedules', select: '*', spec: schedulesSpec, search, enabled: tab === 'schedules',
    filter: (q, s) => (s.source ? q.eq('source_id', s.source) : q),
  })

  return (
    <>
      <PageHeader eyebrow="Stewardship" title="Operations">
        <p>The ingestion ledger: every run, every recorded error and every schedule. This page reads the ledger; it cannot start, stop or change anything.</p>
      </PageHeader>
      <Tabs value={tab} onValueChange={(value) => setSearch({ tab: value === 'runs' ? undefined : value, page: 1, sort: undefined, dir: undefined, status: undefined })} className="mb-4">
        <TabsList>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="errors">Errors</TabsTrigger>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'runs' && search.status === 'blocked' ? <div className="mb-4"><Note tone="caution">{UNAVAILABLE_EXPLANATION}</Note></div> : null}
      <FilterBar hasActive={!!(search.source || search.status)} onClear={() => setSearch({ source: undefined, status: undefined, page: 1 })}>
        <TextFilter name="source" label="Source id" value={search.source} onCommit={(v) => setSearch(filterPatch('source', v), { replace: true })} placeholder="exact source id" />
        {tab === 'runs' ? <SelectFilter name="status" label="Run status" value={search.status} onChange={(v) => setSearch(filterPatch('status', v), { replace: true })} options={RUN_STATUSES.map((v) => ({ value: v, label: humanise(v) }))} anyLabel="Any status" /> : null}
      </FilterBar>
      {tab === 'runs' ? (
        <DataTable caption="Import runs" columns={runColumns} query={runs} spec={runsSpec} search={search} onSearchChange={setSearch} getRowId={(row) => row.id} />
      ) : tab === 'errors' ? (
        <DataTable caption="Ingest errors" columns={errorColumns} query={errors} spec={errorsSpec} search={search} onSearchChange={setSearch} getRowId={(row) => String(row.id)} />
      ) : (
        <DataTable caption="Schedules" columns={scheduleColumns} query={schedules} spec={schedulesSpec} search={search} onSearchChange={setSearch} getRowId={(row) => row.schedule_key} />
      )}
    </>
  )
}
