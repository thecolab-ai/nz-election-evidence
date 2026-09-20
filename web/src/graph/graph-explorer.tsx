import '@xyflow/react/dist/style.css'
import { useQueryClient } from '@tanstack/react-query'
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pill } from '@/components/badges'
import { EvidenceVersionLink } from '@/components/evidence-link'
import { Note } from '@/components/page'
import { ErrorBlock } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { canExpand, edgeFilterFor, EDGES_PER_EXPANSION, initialGraph, MAX_NODES, mergeExpansion, NODE_KIND_LABELS, nodeCount, type EdgeRow, type GraphNode, type GraphState } from '@/lib/graph'
import { toDataError, type DataError } from '@/lib/queries'
import { requireSupabase } from '@/lib/supabase'
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from './layout'

export const LIMIT_NOTICE = 'limit reached — narrow your start node'

type FlowNodeData = { node: GraphNode; isStart: boolean; busy: boolean }
type FlowNode = Node<FlowNodeData, 'evidence'>

function EvidenceNode({ data }: NodeProps<FlowNode>) {
  const { node, isStart, busy } = data
  return (
    <div
      data-testid="graph-node"
      data-node-key={node.key}
      data-expanded={node.expanded}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={`flex flex-col justify-center border bg-paper px-2.5 text-left text-foreground ${isStart ? 'border-2 border-primary' : node.expanded ? 'border-rule' : 'border-dashed border-rule'}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="opacity-0!" />
      <span className="truncate text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {NODE_KIND_LABELS[node.kind] ?? node.kind}
        {isStart ? ' · start' : ''}
      </span>
      <span className="truncate text-[13px] font-medium" title={node.label}>{node.label}</span>
      <span className="truncate text-[10px] text-muted-foreground">{busy ? 'Loading edges…' : node.expanded ? (node.mayHaveMore ? `Expanded · first ${EDGES_PER_EXPANSION} edges only` : 'Expanded') : 'Select to expand'}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} className="opacity-0!" />
    </div>
  )
}

const nodeTypes = { evidence: EvidenceNode }

async function fetchEdges(id: string, signal?: AbortSignal): Promise<EdgeRow[]> {
  const supabase = requireSupabase()
  // One node, one bounded page. The whole graph is never requested.
  let query = supabase.from('graph_edges').select('*').or(edgeFilterFor(id)).order('edge_id').limit(EDGES_PER_EXPANSION)
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query
  if (error) throw toDataError(error, status)
  return (data ?? []) as EdgeRow[]
}

export default function GraphExplorer({ kind, id, height = 560 }: { kind: string; id: string; height?: number }) {
  const queryClient = useQueryClient()
  const [graph, setGraph] = useState<GraphState>(() => initialGraph(kind, id))
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<{ key: string; error: DataError } | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const graphRef = useRef(graph)
  graphRef.current = graph

  const expand = useCallback(
    async (key: string) => {
      const node = graphRef.current.nodes[key]
      if (!node || !canExpand(graphRef.current, key)) return
      setBusyKey(key)
      setError(null)
      try {
        const rows = await queryClient.fetchQuery({ queryKey: ['graph-edges', node.id], queryFn: ({ signal }) => fetchEdges(node.id, signal), staleTime: 60_000 })
        setGraph((current) => mergeExpansion(current, key, rows))
      } catch (caught) {
        setError({ key, error: caught instanceof Error ? (caught as DataError) : toDataError({ message: String(caught) }) })
      } finally {
        setBusyKey(null)
      }
    },
    [queryClient],
  )

  // A new start node resets the canvas and loads that one node's edges.
  useEffect(() => {
    const fresh = initialGraph(kind, id)
    graphRef.current = fresh
    setGraph(fresh)
    setSelectedEdgeId(null)
    void expand(fresh.startKey)
  }, [kind, id, expand])

  const positions = useMemo(() => layoutGraph(graph), [graph])

  const flowNodes = useMemo<FlowNode[]>(
    () =>
      Object.values(graph.nodes).map((node) => ({
        id: node.key,
        type: 'evidence',
        position: { x: positions[node.key]?.x ?? 0, y: positions[node.key]?.y ?? 0 },
        data: { node, isStart: node.key === graph.startKey, busy: busyKey === node.key },
        draggable: false,
        connectable: false,
        ariaLabel: `${NODE_KIND_LABELS[node.kind] ?? node.kind}: ${node.label}. ${node.expanded ? 'Expanded.' : 'Press Enter to expand.'}`,
      })),
    [graph, positions, busyKey],
  )

  const flowEdges = useMemo<Edge[]>(
    () =>
      Object.values(graph.edges).map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.relationship,
        selected: edge.id === selectedEdgeId,
        markerEnd: { type: MarkerType.ArrowClosed },
        labelStyle: { fontSize: 10.5 },
        labelBgPadding: [4, 2] as [number, number],
        ariaLabel: `${graph.nodes[edge.source]?.label ?? edge.source} — ${edge.relationship} — ${graph.nodes[edge.target]?.label ?? edge.target}`,
      })),
    [graph, selectedEdgeId],
  )

  const count = nodeCount(graph)
  const edgeList = Object.values(graph.edges)
  const selectedEdge = selectedEdgeId ? graph.edges[selectedEdgeId] : undefined
  const unexpanded = Object.values(graph.nodes).filter((n) => !n.expanded)

  return (
    <div className="space-y-4" data-testid="graph-explorer">
      <div aria-live="polite" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span className="num" data-testid="graph-counts">{count} of at most {MAX_NODES} nodes · {edgeList.length} edges on canvas</span>
        <Pill tone="muted">At most {EDGES_PER_EXPANSION} edges per expansion</Pill>
        {busyKey ? <span role="status">Loading edges…</span> : null}
      </div>

      {graph.limitReached ? (
        <Note tone="caution" testId="graph-limit-notice">
          Node {LIMIT_NOTICE}. {graph.skippedEdges > 0 ? `${graph.skippedEdges} further edge${graph.skippedEdges === 1 ? ' was' : 's were'} left off the canvas.` : ''}
        </Note>
      ) : null}
      {error ? <ErrorBlock error={error.error} onRetry={() => void expand(error.key)} title="Could not load edges for this node" /> : null}

      <div style={{ height }} className="border border-border bg-paper" role="region" aria-label="Relationship graph canvas. The same relationships are listed in the table below.">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          minZoom={0.1}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable
          nodesFocusable
          deleteKeyCode={null}
          proOptions={{ hideAttribution: false }}
          onNodeClick={(_event, node) => void expand(node.id)}
          onEdgeClick={(_event, edge) => setSelectedEdgeId(edge.id)}
          onPaneClick={() => setSelectedEdgeId(null)}
          key={`${graph.startKey}:${count}`}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <div className="border border-border bg-paper px-4 py-3 text-sm" data-testid="edge-detail" aria-live="polite">
        <p className="eyebrow mb-1">Selected relationship</p>
        {selectedEdge ? (
          <p>
            <strong className="font-semibold">{graph.nodes[selectedEdge.source]?.label}</strong> — {selectedEdge.relationship} —{' '}
            <strong className="font-semibold">{graph.nodes[selectedEdge.target]?.label}</strong>. <EvidenceVersionLink versionId={selectedEdge.evidenceVersionId} label="Open the evidence record for this relationship" />
          </p>
        ) : (
          <p className="text-muted-foreground">Select an edge on the canvas, or use the table below, to see the evidence behind a relationship.</p>
        )}
      </div>

      <section aria-labelledby="graph-fallback-heading">
        <h2 id="graph-fallback-heading" className="text-lg">The same relationships, as a list</h2>
        <p className="mt-1 text-sm text-muted-foreground">Everything on the canvas is also here, for keyboard and screen-reader use.</p>

        {unexpanded.length > 0 ? (
          <div className="mt-3">
            <p className="eyebrow mb-1.5">Nodes not yet expanded</p>
            <ul className="flex flex-wrap gap-1.5" data-testid="graph-expand-list">
              {unexpanded.slice(0, 60).map((node) => (
                <li key={node.key}>
                  <Button type="button" variant="outline" size="sm" disabled={busyKey !== null || !canExpand(graph, node.key)} onClick={() => void expand(node.key)}>
                    Expand {node.label}<span className="sr-only"> ({NODE_KIND_LABELS[node.kind] ?? node.kind})</span>
                  </Button>
                </li>
              ))}
            </ul>
            {unexpanded.length > 60 ? <p className="mt-1 text-xs text-muted-foreground">{unexpanded.length - 60} more unexpanded nodes are on the canvas.</p> : null}
          </div>
        ) : null}

        <div className="mt-3 border border-border bg-paper">
          {edgeList.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground" data-testid="graph-no-edges">{busyKey ? 'Loading edges…' : 'No relationships were returned for this node. This is not evidence that none exist.'}</p>
          ) : (
            <Table className="text-[13.5px]" data-testid="graph-edge-table">
              <TableCaption className="sr-only">Relationships currently on the canvas</TableCaption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {['From', 'Relationship', 'To', 'Evidence'].map((h) => (
                    <TableHead key={h} scope="col" className="h-9 bg-muted/60 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {edgeList.map((edge) => (
                  <TableRow key={edge.id} data-testid="graph-edge-row" data-state={edge.id === selectedEdgeId ? 'selected' : undefined}>
                    <TableCell className="py-2 whitespace-normal">{graph.nodes[edge.source]?.label}</TableCell>
                    <TableCell className="py-2 whitespace-normal">{edge.relationship}</TableCell>
                    <TableCell className="py-2 whitespace-normal">{graph.nodes[edge.target]?.label}</TableCell>
                    <TableCell className="py-2 whitespace-normal"><EvidenceVersionLink versionId={edge.evidenceVersionId} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </section>
    </div>
  )
}
