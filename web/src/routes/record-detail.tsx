import { getRouteApi, Link } from '@tanstack/react-router'
import { TableRow } from '@/components/ui/table'
import { Pill, TombstoneBadge } from '@/components/badges'
import { JsonViewer } from '@/components/json-viewer'
import { ExternalLink, KeyValueList, Mono, PageHeader, Section } from '@/components/page'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import { formatCount, formatDateTime, formatPublisherDate, humanise, scopeLabel } from '@/lib/format'
import { EDGES_PER_EXPANSION, type EdgeRow } from '@/lib/graph'
import { useOneQuery, useRowsQuery } from '@/lib/queries'
import type { GraphNodeKind } from '@/lib/search'
import type { LifecycleEventRow, RecordRow, RecordVersionRow } from '@/lib/types'
import { Cell, Panel } from './source-detail'

const route = getRouteApi('/_released/records/$recordId')

function omittedList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))) : []
}

function VersionCard({ version, index, total }: { version: RecordVersionRow; index: number; total: number }) {
  const omitted = omittedList(version.omitted_fields)
  const headingId = `version-${version.id}`
  return (
    <li data-testid="record-version" className="border border-border bg-paper">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-2.5">
        <h3 id={headingId} className="text-base">
          Version {total - index} of {total}
        </h3>
        <div className="flex flex-wrap gap-2">
          {version.is_current ? <Pill tone="accent" testId="current-version">Current version</Pill> : <Pill tone="muted">Superseded</Pill>}
        </div>
      </div>
      <div className="space-y-3 px-4 py-3">
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div><dt className="eyebrow">First retrieved</dt><dd>{formatDateTime(version.first_retrieved_at)}</dd></div>
          <div><dt className="eyebrow">Publisher date</dt><dd>{formatPublisherDate(version.source_published_at, version.source_date_text)}</dd></div>
          <div><dt className="eyebrow">Last observed</dt><dd>{formatDateTime(version.last_observed_at, 'no observation recorded')}</dd></div>
          <div><dt className="eyebrow">Observations</dt><dd className="num" data-testid="observation-count">{formatCount(version.observation_count)} sighting{Number(version.observation_count) === 1 ? '' : 's'} of this exact content</dd></div>
          <div className="sm:col-span-2"><dt className="eyebrow">Content hash</dt><dd><Mono>{version.content_hash}</Mono></dd></div>
          {version.original_content_hash ? <div className="sm:col-span-2"><dt className="eyebrow">Original content hash</dt><dd><Mono>{version.original_content_hash}</Mono></dd></div> : null}
          <div><dt className="eyebrow">Projection version</dt><dd className="num">{version.projection_version}</dd></div>
          <div className="sm:col-span-2"><dt className="eyebrow">Version id</dt><dd><Mono>{version.id}</Mono></dd></div>
        </dl>
        <div>
          <p className="eyebrow mb-1">Omitted fields</p>
          {omitted.length === 0 ? (
            <p className="text-sm text-muted-foreground">None recorded for this version.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5" data-testid="omitted-fields">
              {omitted.map((field) => (
                <li key={field}><Pill tone="muted">{field}</Pill></li>
              ))}
            </ul>
          )}
        </div>
        <JsonViewer value={version.safe_payload} />
      </div>
    </li>
  )
}

export function RecordDetailPage() {
  const { recordId } = route.useParams()
  const record = useOneQuery<RecordRow>({ view: 'records', select: '*', column: 'id', value: recordId })
  const versions = useRowsQuery<RecordVersionRow>({ view: 'record_versions', select: '*', key: [recordId], limit: 50, build: (q) => q.eq('record_id', recordId).order('first_retrieved_at', { ascending: false }).order('loaded_at', { ascending: false }) })
  const events = useRowsQuery<LifecycleEventRow>({ view: 'record_lifecycle_events', select: '*', key: [recordId], limit: 50, build: (q) => q.eq('record_id', recordId).order('occurred_at', { ascending: false }) })
  const currentVersionId = record.data?.current_version_id ?? null
  const edges = useRowsQuery<EdgeRow>({
    view: 'graph_edges',
    select: '*',
    key: ['record', currentVersionId],
    limit: EDGES_PER_EXPANSION,
    enabled: !!currentVersionId,
    build: (q) => q.or(`from_id.eq."${currentVersionId}",to_id.eq."${currentVersionId}",evidence_version_id.eq.${currentVersionId}`),
  })

  if (record.isPending) return <LoadingBlock label="Loading record" />
  if (record.isError) return <ErrorBlock error={record.error} onRetry={() => void record.refetch()} />
  const r = record.data
  if (!r) {
    return (
      <>
        <PageHeader eyebrow="Record" title="Record not found" />
        <EmptyBlock message="No record with this id was returned. This is not evidence that the publisher holds no such item." />
      </>
    )
  }

  return (
    <>
      <p className="mb-3 text-sm">
        <Link to="/records" className="doc-link">← All records</Link>
      </p>
      <PageHeader eyebrow={`Record · ${humanise(r.record_kind)} · ${scopeLabel(r.view_scope)}`} title={r.label ?? 'No label field in stored payload'}>
        <p><Mono>{r.external_record_id}</Mono></p>
        {r.tombstoned_at ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <TombstoneBadge reason={r.tombstone_reason} />
            <span>Last absent from the source on {formatDateTime(r.tombstoned_at)}. The history below is kept.</span>
          </div>
        ) : null}
      </PageHeader>

      <Section id="provenance" title="Provenance">
        <KeyValueList
          columns={3}
          items={[
            { label: 'Source URL', value: r.source_url ? <ExternalLink href={r.source_url} /> : 'no URL on the current version', testId: 'provenance-source-url' },
            { label: 'Source', value: <Link to="/sources/$sourceId" params={{ sourceId: r.source_id }} className="doc-link font-mono text-[13px]">{r.source_id}</Link> },
            { label: 'Publisher date', value: formatPublisherDate(r.source_published_at, r.source_date_text), testId: 'provenance-publisher-date' },
            { label: 'First retrieved', value: formatDateTime(r.first_seen_at), testId: 'provenance-first-retrieved' },
            { label: 'Last retrieved', value: formatDateTime(r.last_seen_at) },
            { label: 'Current version first retrieved', value: formatDateTime(r.current_version_first_retrieved_at, 'no current version') },
            { label: 'Current content hash', value: r.current_content_hash ? <Mono>{r.current_content_hash}</Mono> : 'no current version', testId: 'provenance-hash' },
            { label: 'Record id', value: <Mono>{r.id}</Mono> },
            { label: 'Versions held', value: <span className="num">{formatCount(r.version_count)}</span> },
          ]}
        />
      </Section>

      <Section id="versions" title="Version history" description="Newest first. A new version is stored only when the content hash changes; a repeat sighting of the same content is counted as an observation.">
        {versions.isPending ? <LoadingBlock label="Loading versions" rows={4} /> : versions.isError ? <ErrorBlock error={versions.error} onRetry={() => void versions.refetch()} /> : versions.data.length === 0 ? <EmptyBlock /> : (
          <ol className="space-y-4" aria-label="Versions, newest first">
            {versions.data.map((version, index) => (
              <VersionCard key={version.id} version={version} index={index} total={versions.data.length} />
            ))}
          </ol>
        )}
      </Section>

      <Section id="lifecycle" title="Lifecycle events">
        <Panel query={events} caption="Lifecycle events" head={['Occurred', 'Event', 'Reason']} limit={50}>
          {(event) => (
            <TableRow key={String(event.id)} data-testid="lifecycle-event">
              <Cell>{formatDateTime(event.occurred_at)}</Cell>
              <Cell>{humanise(event.event)}</Cell>
              <Cell>{event.reason ? humanise(event.reason) : '—'}</Cell>
            </TableRow>
          )}
        </Panel>
      </Section>

      <Section id="relationships" title="Relationships" description={`Relationship edges that touch, or cite as evidence, the current version. At most ${EDGES_PER_EXPANSION} are loaded.`}>
        {!currentVersionId ? <EmptyBlock message="This record has no current version, so no relationships can be looked up." /> : (
          <Panel query={edges} caption="Relationships" head={['From', 'Relationship', 'To', 'Graph']} limit={EDGES_PER_EXPANSION}>
            {(edge) => (
              <TableRow key={edge.edge_id} data-testid="relationship-row">
                <Cell>{edge.from_label ?? edge.from_id}</Cell>
                <Cell>{edge.relationship}</Cell>
                <Cell>{edge.to_label ?? edge.to_id}</Cell>
                <Cell>
                  <Link to="/graph" search={{ kind: edge.from_kind as GraphNodeKind, id: edge.from_id }} className="doc-link">Open in graph</Link>
                </Cell>
              </TableRow>
            )}
          </Panel>
        )}
      </Section>
    </>
  )
}
