import { Graph, layout } from '@dagrejs/dagre'
import type { GraphState } from '@/lib/graph'

export const NODE_WIDTH = 210
export const NODE_HEIGHT = 58

export interface Positioned {
  key: string
  x: number
  y: number
}

/** Left-to-right layered layout. Pure: same graph in, same positions out. */
export function layoutGraph(state: GraphState): Record<string, Positioned> {
  const g = new Graph({ multigraph: true })
  g.setGraph({ rankdir: 'LR', nodesep: 22, ranksep: 110, marginx: 16, marginy: 16 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const node of Object.values(state.nodes)) g.setNode(node.key, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of Object.values(state.edges)) g.setEdge(edge.source, edge.target, {}, edge.id)
  layout(g)
  const out: Record<string, Positioned> = {}
  for (const key of g.nodes()) {
    const n = g.node(key) as { x?: number; y?: number } | undefined
    out[key] = { key, x: (n?.x ?? 0) - NODE_WIDTH / 2, y: (n?.y ?? 0) - NODE_HEIGHT / 2 }
  }
  return out
}
