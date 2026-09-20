import { getRouteApi, Link } from '@tanstack/react-router'
import { FreshnessBadge, Pill, RightsBadge, RunStatusBadge, StateBadge } from '@/components/badges'
import { JsonViewer } from '@/components/json-viewer'
import { ExternalLink, KeyValueList, Mono, Note, PageHeader, Section } from '@/components/page'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatBytes, formatCadence, formatCount, formatDateTime, FRESHNESS_EXPLANATIONS, humanise, isFreshnessStatus, NOT_STATED, scopeLabel } from '@/lib/format'
import { useOneQuery, useRowsQuery, type DataError } from '@/lib/queries'
import type { FetchLogRow, ImportRunRow, IngestErrorRow, ScheduleRow, SourceRow } from '@/lib/types'
import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const route = getRouteApi('/_released/sources/$sourceId')
const PANEL_LIMIT = 25

export function Panel<Row>({ query, caption, head, children, limit = PANEL_LIMIT }: { query: UseQueryResult<Row[], DataError>; caption: string; head: string[]; children: (row: Row) => ReactNode; limit?: number }) {
  if (query.isPending) return <LoadingBlock label={`Loading ${caption}`} rows={3} />
  if (query.isError) return <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />
  if (query.data.length === 0) return <EmptyBlock />
  return (
    <div className="border border-border bg-paper">
      <Table className="text-[13.5px]">
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {head.map((label) => (
              <TableHead key={label} scope="col" className="h-9 bg-muted/60 text-xs font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase">
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{query.data.map((row) => children(row))}</TableBody>
      </Table>
      {query.data.length >= limit ? <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">Showing the most recent {limit}. Older rows exist and are not shown here.</p> : null}
    </div>
  )
}

export const Cell = ({ children, className }: { children: ReactNode; className?: string }) => <TableCell className={`py-2 align-top whitespace-normal ${className ?? ''}`}>{children}</TableCell>

export function SourceDetailPage() {
  const { sourceId } = route.useParams()
  const source = useOneQuery<SourceRow>({ view: 'sources', select: '*', column: 'source_id', value: sourceId })
  const runs = useRowsQuery<ImportRunRow>({ view: 'import_runs', select: '*', key: [sourceId], limit: PANEL_LIMIT, build: (q) => q.eq('source_id', sourceId).order('started_at', { ascending: false }) })
  const fetches = useRowsQuery<FetchLogRow>({ view: 'fetch_log', select: '*', key: [sourceId], limit: PANEL_LIMIT, build: (q) => q.eq('source_id', sourceId).order('retrieved_at', { ascending: false }) })
  const errors = useRowsQuery<IngestErrorRow>({ view: 'ingest_errors', select: '*', key: [sourceId], limit: PANEL_LIMIT, build: (q) => q.eq('source_id', sourceId).order('occurred_at', { ascending: false }) })
  const schedules = useRowsQuery<ScheduleRow>({ view: 'schedules', select: '*', key: [sourceId], limit: PANEL_LIMIT, build: (q) => q.eq('source_id', sourceId).order('schedule_key') })

  if (source.isPending) return <LoadingBlock label="Loading source" />
  if (source.isError) return <ErrorBlock error={source.error} onRetry={() => void source.refetch()} />
  const s = source.data
  if (!s) {
    return (
      <>
        <PageHeader eyebrow="Source" title="Source not found" />
        <EmptyBlock message={`No source with the id "${sourceId}" was returned. It may not be registered — this is not evidence that the publisher has no such material.`} />
      </>
    )
  }

  return (
    <>
      <p className="mb-3 text-sm">
        <Link to="/sources" className="doc-link">
          ← All sources
        </Link>
      </p>
      <PageHeader eyebrow={`Source · ${scopeLabel(s.view_scope)}`} title={s.title}>
        <p>
          <Mono>{s.source_id}</Mono> · {s.publisher}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <FreshnessBadge status={s.freshness_status} />
          <RightsBadge status={s.rights_review_status} />
          {s.enabled ? <Pill>Enabled</Pill> : <Pill tone="muted">Not enabled</Pill>}
        </div>
      </PageHeader>

      {isFreshnessStatus(s.freshness_status) && s.freshness_status !== 'fresh' ? (
        <div className="mb-8">
          <Note tone="caution" testId="freshness-explanation">
            {FRESHNESS_EXPLANATIONS[s.freshness_status]}
          </Note>
        </div>
      ) : null}

      <Section id="freshness" title="Freshness" description="Retrieval time is when this project fetched the source. Publisher date is what the publisher wrote on its newest item.">
        <KeyValueList
          columns={3}
          items={[
            { label: 'Last retrieved (last success)', value: formatDateTime(s.last_success_at, 'never retrieved') },
            { label: 'Latest publisher date', value: formatDateTime(s.latest_source_published_at, NOT_STATED) },
            { label: 'Last attempt', value: `${formatDateTime(s.last_attempt_at, 'never attempted')}${s.last_attempt_status ? ` · ${humanise(s.last_attempt_status).toLowerCase()}` : ''}` },
            { label: 'Last content change', value: formatDateTime(s.last_change_at, 'no change recorded') },
            { label: 'Consecutive failed attempts', value: formatCount(s.consecutive_failures) },
            { label: 'Last error class', value: s.last_error_class ? <Mono>{s.last_error_class}</Mono> : 'none recorded' },
            { label: 'Live records', value: <Link to="/records" search={{ source: s.source_id }} className="doc-link num">{formatCount(s.live_records)}</Link> },
            { label: 'Tombstoned records', value: <span className="num">{formatCount(s.tombstoned_records)}</span> },
            { label: 'Content versions', value: <span className="num">{formatCount(s.content_versions)}</span> },
          ]}
        />
      </Section>

      <Section id="config" title="Configuration">
        <KeyValueList
          columns={3}
          items={[
            { label: 'Official URL', value: <ExternalLink href={s.official_url} /> },
            { label: 'Allowed hosts', value: s.allowed_hosts.length ? <Mono>{s.allowed_hosts.join(', ')}</Mono> : 'none (export import only)' },
            { label: 'Expected cadence', value: formatCadence(s.expected_cadence_seconds) },
            { label: 'Snapshot semantics', value: humanise(s.snapshot_semantics) },
            { label: 'Adapter', value: `${s.adapter_name} (${humanise(s.adapter_kind).toLowerCase()})` },
            { label: 'Blocked reason', value: s.blocked_reason ?? 'none recorded' },
            { label: 'Rights', value: s.rights_id ? `${s.rights_id} · ${s.rights_review_status} · default release ${s.rights_default_release}` : `no rights row · treated as ${s.rights_review_status}, ${s.rights_default_release}` },
            { label: 'Registry key', value: s.registry_key ?? 'none' },
            { label: 'Catalogue products', value: s.catalogue_product_ids.length ? s.catalogue_product_ids.join(', ') : 'none mapped' },
          ]}
        />
      </Section>

      <Section id="runs" title="Recent runs">
        <Panel query={runs} caption="Recent import runs" head={['Started', 'Status', 'Mode', 'Seen', 'New versions', 'Unchanged', 'Rejected', 'Tombstoned', 'Error']}>
          {(run) => (
            <TableRow key={run.id}>
              <Cell>{formatDateTime(run.started_at)}</Cell>
              <Cell><RunStatusBadge status={run.status} /></Cell>
              <Cell>{humanise(run.mode)} · {run.trigger_kind}</Cell>
              <Cell className="num">{formatCount(run.records_seen)}</Cell>
              <Cell className="num">{formatCount(run.versions_inserted)}</Cell>
              <Cell className="num">{formatCount(run.unchanged)}</Cell>
              <Cell className="num">{formatCount(run.rejected)}</Cell>
              <Cell className="num">{formatCount(run.tombstoned)}</Cell>
              <Cell>{run.error_class ? <><Mono>{run.error_class}</Mono>{run.error_detail ? <span className="block text-muted-foreground">{run.error_detail}</span> : null}</> : '—'}</Cell>
            </TableRow>
          )}
        </Panel>
      </Section>

      <Section id="fetch-log" title="Fetch log" description="Each outbound request made for this source.">
        <Panel query={fetches} caption="Fetch log" head={['Retrieved', 'Request', 'Attempt', 'Outcome', 'HTTP', 'Size', 'Duration']}>
          {(f) => (
            <TableRow key={String(f.id)}>
              <Cell>{formatDateTime(f.retrieved_at)}</Cell>
              <Cell><Mono>{f.request_method} {f.request_url}</Mono></Cell>
              <Cell className="num">{f.attempt}</Cell>
              <Cell>{humanise(f.outcome)}</Cell>
              <Cell className="num">{f.http_status ?? 'no response'}</Cell>
              <Cell className="num">{formatBytes(f.response_bytes === null ? null : Number(f.response_bytes))}</Cell>
              <Cell className="num">{f.duration_ms === null ? 'unknown' : `${f.duration_ms} ms`}</Cell>
            </TableRow>
          )}
        </Panel>
      </Section>

      <Section id="errors" title="Errors">
        <Panel query={errors} caption="Ingest errors" head={['Occurred', 'Class', 'Message', 'Record reference']}>
          {(e) => (
            <TableRow key={String(e.id)}>
              <Cell>{formatDateTime(e.occurred_at)}</Cell>
              <Cell><Mono>{e.error_class}</Mono></Cell>
              <Cell>{e.message}</Cell>
              <Cell>{e.record_ref ? <Mono>{e.record_ref}</Mono> : '—'}</Cell>
            </TableRow>
          )}
        </Panel>
      </Section>

      <Section id="schedules" title="Schedules">
        <Panel query={schedules} caption="Schedules" head={['Schedule', 'Cron', 'State', 'Activation', 'Last dispatch']}>
          {(sc) => (
            <TableRow key={sc.schedule_key}>
              <Cell><Mono>{sc.schedule_key}</Mono></Cell>
              <Cell><Mono>{sc.cron_expr}</Mono></Cell>
              <Cell><StateBadge state={sc.state} /></Cell>
              <Cell>{sc.state === 'active' ? <>{formatDateTime(sc.activated_at)}{sc.activation_proof ? <div className="mt-1"><JsonViewer value={sc.activation_proof} label="Activation proof" /></div> : null}</> : 'not activated'}</Cell>
              <Cell>{sc.last_dispatch_at ? `${formatDateTime(sc.last_dispatch_at)} · ${humanise(sc.last_dispatch_outcome)}` : 'never dispatched'}</Cell>
            </TableRow>
          )}
        </Panel>
      </Section>
    </>
  )
}
