import { getRouteApi, Link } from '@tanstack/react-router'
import { lazy, Suspense, useState } from 'react'
import { FilterBar, TextFilter } from '@/components/filters'
import { Note, PageHeader, Section } from '@/components/page'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import { EDGES_PER_EXPANSION, MAX_NODES, NODE_KIND_LABELS } from '@/lib/graph'
import { useRowsQuery } from '@/lib/queries'
import { ilikeContains } from '@/lib/search'
import type { PersonIdentityRow } from '@/lib/types'

// React Flow and dagre are only fetched when a graph is actually opened.
export const LazyGraphExplorer = lazy(() => import('@/graph/graph-explorer'))

const route = getRouteApi('/_released/graph')

function StartNodePicker() {
  const [term, setTerm] = useState<string | undefined>(undefined)
  const results = useRowsQuery<Pick<PersonIdentityRow, 'id' | 'name_at_source' | 'source_id'>>({
    view: 'person_identities',
    select: 'id,name_at_source,source_id',
    key: ['graph-picker', term],
    limit: 15,
    enabled: !!term,
    build: (q) => q.ilike('name_at_source', ilikeContains(term ?? '')).order('name_at_source'),
  })
  return (
    <Section id="start" title="Choose one start node" description="The graph always begins from a single node. Search for a source identity by the name the source used.">
      <FilterBar hasActive={!!term} onClear={() => setTerm(undefined)} label="Find a start node">
        <TextFilter name="name" label="Name at source contains" value={term} onCommit={setTerm} />
      </FilterBar>
      {!term ? (
        <EmptyBlock message="Nothing is loaded until you choose a start node. The whole graph is never loaded." />
      ) : results.isPending ? (
        <LoadingBlock label="Searching identities" rows={3} />
      ) : results.isError ? (
        <ErrorBlock error={results.error} onRetry={() => void results.refetch()} />
      ) : results.data.length === 0 ? (
        <EmptyBlock />
      ) : (
        <ul className="divide-y divide-border border border-border bg-paper text-sm">
          {results.data.map((identity) => (
            <li key={identity.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2">
              <Link to="/graph" search={{ kind: 'person_identity', id: identity.id }} className="doc-link font-medium">{identity.name_at_source}</Link>
              <span className="font-mono text-xs text-muted-foreground">{identity.source_id}</span>
            </li>
          ))}
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
            <Note>Start node: {NODE_KIND_LABELS[kind] ?? kind}. Select any node to load its edges.</Note>
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
