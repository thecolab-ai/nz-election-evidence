import { NOT_SHOWN, RIGHTS_NOTE } from '@/lib/format'
import { getRouteApi, Link } from '@tanstack/react-router'
import { lazy, Suspense, useState } from 'react'
import { FilterBar, SelectFilter, TextFilter } from '@/components/filters'
import { Note, PageHeader, Section } from '@/components/page'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import { EDGES_PER_EXPANSION, MAX_NODES, NODE_KIND_LABELS } from '@/lib/graph'
import { useRowsQuery } from '@/lib/queries'
import { GRAPH_ROOT_KINDS, ilikeContains, isGraphRootKind, isUuid, type GraphRootKind } from '@/lib/search'

// React Flow and dagre are only fetched when a graph is actually opened.
export const LazyGraphExplorer = lazy(() => import('@/graph/graph-explorer'))

const route = getRouteApi('/_released/graph')

interface RootSpec {
  label: string
  view: 'person_identities' | 'party_identities' | 'electorates' | 'records'
  /** Column searched and shown. It is a content field, so it is blank for a source with link-only rights. */
  nameColumn: string
  /** Column holding the node id for this kind. */
  idColumn: string
  hint: string
}

export const GRAPH_ROOTS: Record<GraphRootKind, RootSpec> = {
  person_identity: { label: 'Source identity (a person as one source named them)', view: 'person_identities', nameColumn: 'name_at_source', idColumn: 'id', hint: 'Name at source contains' },
  party_identity: { label: 'Party label at source', view: 'party_identities', nameColumn: 'name_at_source', idColumn: 'id', hint: 'Party label contains' },
  electorate_version: { label: 'Electorate (boundary edition)', view: 'electorates', nameColumn: 'name', idColumn: 'id', hint: 'Electorate name contains' },
  record_version: { label: 'Record (its current version)', view: 'records', nameColumn: 'label', idColumn: 'current_version_id', hint: 'Record label contains' },
}

function StartNodePicker() {
  const [rootKind, setRootKind] = useState<GraphRootKind>('person_identity')
  const [term, setTerm] = useState<string | undefined>(undefined)
  const [directId, setDirectId] = useState<string | undefined>(undefined)
  const spec = GRAPH_ROOTS[rootKind]
  const results = useRowsQuery<Record<string, string | null>>({
    view: spec.view,
    select: `${spec.idColumn},${spec.nameColumn},source_id`.replace(/,source_id$/, spec.view === 'electorates' ? '' : ',source_id'),
    key: ['graph-picker', rootKind, term],
    limit: 15,
    enabled: !!term,
    build: (q) => q.ilike(spec.nameColumn, ilikeContains(term ?? '')).not(spec.idColumn, 'is', null).order(spec.nameColumn),
  })
  return (
    <Section id="start" title="Choose one start node" description="The graph always begins from a single node of a kind you choose. Nothing is loaded until then.">
      <FilterBar hasActive={!!term || !!directId} onClear={() => { setTerm(undefined); setDirectId(undefined) }} label="Find a start node">
        <SelectFilter name="root-kind" label="Start from a" value={rootKind} anyLabel="Source identity" onChange={(v) => { setRootKind(isGraphRootKind(v) ? v : 'person_identity'); setTerm(undefined) }} options={GRAPH_ROOT_KINDS.map((k) => ({ value: k, label: GRAPH_ROOTS[k].label }))} />
        <TextFilter name="name" label={spec.hint} value={term} onCommit={setTerm} />
        <TextFilter name="node-id" label="Or open by id" value={directId} onCommit={setDirectId} placeholder="UUID" />
      </FilterBar>
      <div className="mb-3"><Note>{RIGHTS_NOTE} A source with link-only rights has no searchable name; open it by id from its page instead.</Note></div>
      {directId ? (
        isUuid(directId) ? (
          <p className="text-sm"><Link to="/graph" search={{ kind: rootKind, id: directId }} className="doc-link" data-testid="open-by-id">Open the graph from this {NODE_KIND_LABELS[rootKind] ?? rootKind}</Link></p>
        ) : (
          <EmptyBlock message="That is not an id. An id is a UUID such as the one shown on an entity's page." />
        )
      ) : !term ? (
        <EmptyBlock message="Nothing is loaded until you choose a start node. The whole graph is never loaded." />
      ) : results.isPending ? (
        <LoadingBlock label="Searching" rows={3} />
      ) : results.isError ? (
        <ErrorBlock error={results.error} onRetry={() => void results.refetch()} />
      ) : results.data.length === 0 ? (
        <EmptyBlock />
      ) : (
        <ul className="divide-y divide-border border border-border bg-paper text-sm" data-testid="root-results">
          {results.data.map((row) => {
            const id = row[spec.idColumn]
            if (!id) return null
            return (
              <li key={id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2">
                <Link to="/graph" search={{ kind: rootKind, id }} className="doc-link font-medium">{row[spec.nameColumn] ?? NOT_SHOWN}</Link>
                <span className="font-mono text-xs text-muted-foreground">{row.source_id ?? ''}</span>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

export function GraphPage() {
  const { kind, id } = route.useSearch()
  return (
    <>
      <PageHeader eyebrow="Civic model" title="Relationships">
        <p>
          A bounded view of recorded relationships, grown one node at a time. Each expansion loads at most {EDGES_PER_EXPANSION} edges
          and the canvas holds at most {MAX_NODES} nodes. An edge records that a source said something; it does not show influence,
          agreement or cause.
        </p>
      </PageHeader>
      {kind && id ? (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <Note>Start node: {NODE_KIND_LABELS[kind] ?? kind}. Select any node to load its edges; each node links to its own page where it has one.</Note>
            <Link to="/graph" search={{}} className="doc-link text-sm">Choose a different start node</Link>
          </div>
          <Suspense fallback={<LoadingBlock label="Loading graph tools" rows={5} />}>
            <LazyGraphExplorer kind={kind} id={id} />
          </Suspense>
        </>
      ) : (
        <StartNodePicker />
      )}
    </>
  )
}
