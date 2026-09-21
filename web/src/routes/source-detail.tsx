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

/**
 * Every column this page renders, named one by one. Deliberately not `*`.
 *
 * `evidence_views.sources` computes four of its columns as correlated subqueries over the ledger, and
 * one of them — `content_versions` — joins source_record_versions back through source_records for the
 * whole source. Measured against the deployed anonymous endpoint on 2026-09-21, that column alone took
 * 0.8–1.1 s warm and timed out (57014) cold for the written-questions export, which holds 187,956 of
 * the store's 203,536 records. It was by far the most expensive thing this page asked for, and this
 * page was the only reader of it anywhere in the app — asked for only because `*` asks for everything.
 *
 * The columns that remain are cheap: live_records is answered from an index (migration
 * 20260921090100_source_records_live_index), and tombstoned_records and catalogue_product_ids both
 * measured under 0.2 s. Naming them also means a column added to the view later cannot quietly make
 * this page slow again.
 */
const SOURCE_DETAIL_COLUMNS = [
  'source_id', 'title', 'publisher', 'official_url', 'adapter_kind', 'adapter_name', 'allowed_hosts',
  'view_scope', 'snapshot_semantics', 'expected_cadence_seconds', 'enabled', 'blocked_reason',
  'registry_key', 'rights_id', 'rights_review_status', 'rights_default_release',
  'public_release_tier', 'public_approved_fields', 'last_attempt_at', 'last_attempt_status',
  'last_success_at', 'last_change_at', 'latest_source_published_at', 'consecutive_failures',
  'last_error_class', 'freshness_status', 'live_records', 'tombstoned_records',
  'catalogue_product_ids', 'owner_authorized_fields', 'statistical_observations',
  'statistical_observations_without_a_number', 'statistical_series', 'statistical_catalogue_entries',
  'statistics_counted_at',
].join(',')

/** The page no longer fetches content_versions, so its row type stops claiming a number it does not have. */
type SourceDetailRow = Omit<SourceRow, 'content_versions'>

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
  const source = useOneQuery<SourceDetailRow>({ view: 'sources', select: SOURCE_DETAIL_COLUMNS, column: 'source_id', value: sourceId })
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

      <div className="mb-8" data-testid="source-release-basis">
        {s.owner_authorized_fields.length > 0 ? (
          <Note tone="caution" testId="owner-fields-note">
            <strong className="font-semibold">Fields shown on the repository owner’s decision, not on the publisher’s approval.</strong> {s.publisher} has
            not approved or licensed these fields and its rights review reads {humanise(s.rights_review_status).toLowerCase()}. They are shown as the
            official source published them, with a link to it: <Mono>{s.owner_authorized_fields.join(', ')}</Mono>. Every other field of this source
            stays blank.
          </Note>
        ) : s.public_release_tier === 'fields' ? null : (
          <Note testId="link-only-note">
            Links, identifiers, dates and hashes only. No field of this source is released: its rights review reads{' '}
            {humanise(s.rights_review_status).toLowerCase()} and no owner decision names a field for it.
          </Note>
        )}
      </div>

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
            // No total is printed here because none is read here: totalling versions across a source costs more
            // than the rest of this page put together. The per-record counts are the same facts, unaggregated.
            { label: 'Content versions', value: <Link to="/records" search={{ source: s.source_id }} className="doc-link">counted per record, not totalled here</Link> },
            // A statistics source writes typed observations, not ledger records: its counts are recorded when a load finishes.
            ...(s.statistical_observations === null || s.statistical_observations === undefined ? [] : [
              { label: 'Statistical observations', value: <Link to="/statistics" className="doc-link num" data-testid="source-observations">{formatCount(s.statistical_observations)}</Link> },
              { label: 'Observations with no number printed', value: <span className="num" data-testid="source-observations-withheld">{formatCount(s.statistical_observations_without_a_number)}</span> },
              { label: 'Series · catalogue entries', value: <span className="num">{formatCount(s.statistical_series)} · {formatCount(s.statistical_catalogue_entries)}</span> },
              { label: 'Statistics counted', value: formatDateTime(s.statistics_counted_at, 'never counted') },
            ]),
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
            { label: 'Public release tier', testId: 'release-tier', value: s.public_release_tier === 'fields' ? `Approved fields: ${s.public_approved_fields.join(', ') || 'none named'}` : 'Links and metadata only. Content fields are blank until the publisher approves them.' },
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
              <Cell>{run.error_class ? <><Mono>{run.error_class}</Mono></> : '—'}</Cell>
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
