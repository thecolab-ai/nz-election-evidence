/**
 * Bounded relationship graph state. Pure functions only, so the bounds are unit-testable:
 *   - at most EDGES_PER_EXPANSION edge rows are accepted from any single expansion
 *   - at most MAX_NODES nodes ever sit on the canvas
 *   - nodes are keyed `${kind}:${id}` and edges by their server edge_id, so repeats are dropped
 * The whole graph is never requested; the client only ever asks for the edges of one node.
 */

export const EDGES_PER_EXPANSION = 50
export const MAX_NODES = 300

export interface EdgeRow {
  edge_id: string
  from_kind: string
  from_id: string
  from_label: string | null
  to_kind: string
  to_id: string
  to_label: string | null
  relationship: string
  evidence_version_id: string | null
}

export interface GraphNode {
  key: string
  kind: string
  id: string
  label: string
  expanded: boolean
  /** True when the expansion returned a full page, so more edges may exist on the server. */
  mayHaveMore: boolean
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  relationship: string
  evidenceVersionId: string | null
}

export interface GraphState {
  startKey: string
  nodes: Record<string, GraphNode>
  edges: Record<string, GraphEdge>
  limitReached: boolean
  /** Edges left off the canvas because an endpoint would have exceeded the node cap. */
  skippedEdges: number
}

export function nodeKey(kind: string, id: string): string {
  return `${kind}:${id}`
}

export function initialGraph(kind: string, id: string, label?: string): GraphState {
  const key = nodeKey(kind, id)
  return {
    startKey: key,
    nodes: { [key]: { key, kind, id, label: label ?? id, expanded: false, mayHaveMore: false } },
    edges: {},
    limitReached: false,
    skippedEdges: 0,
  }
}

export function nodeCount(state: GraphState): number {
  return Object.keys(state.nodes).length
}

const KIND_SHAPE = /^[a-z][a-z_]{1,40}$/
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The PostgREST `or` filter for one node's edges. A node is (kind, id): the same id can exist under two
 * kinds, so the filter names BOTH on each side. Values are quoted; ids are validated upstream.
 */
export function edgeFilterFor(kind: string, id: string): string {
  if (!KIND_SHAPE.test(kind)) throw new Error('graph node kind is not a plain identifier')
  const quoted = `"${id.replace(/["\\]/g, '')}"`
  return `and(from_kind.eq.${kind},from_id.eq.${quoted}),and(to_kind.eq.${kind},to_id.eq.${quoted})`
}

export type EntityRoute =
  | { to: '/people/$identityId'; params: { identityId: string } }
  | { to: '/parties/$identityId'; params: { identityId: string } }
  | { to: '/electorates/$versionId'; params: { versionId: string } }

/** The detail page for a node, when its kind has one. Labels and elections have no page of their own. */
export function entityRoute(kind: string, id: string): EntityRoute | null {
  if (!UUID_SHAPE.test(id)) return null
  if (kind === 'person_identity') return { to: '/people/$identityId', params: { identityId: id } }
  if (kind === 'party_identity') return { to: '/parties/$identityId', params: { identityId: id } }
  if (kind === 'electorate_version') return { to: '/electorates/$versionId', params: { versionId: id } }
  return null
}

export function mergeExpansion(state: GraphState, expandedKey: string, rows: readonly EdgeRow[]): GraphState {
  const accepted = rows.slice(0, EDGES_PER_EXPANSION)
  const nodes = { ...state.nodes }
  const edges = { ...state.edges }
  let limitReached = state.limitReached
  let skippedEdges = state.skippedEdges
  let count = Object.keys(nodes).length

  const ensure = (kind: string, id: string, label: string | null): string | null => {
    const key = nodeKey(kind, id)
    const existing = nodes[key]
    if (existing) {
      // A bare start node only knows its id; adopt the first real label seen.
      if (label && existing.label === existing.id) nodes[key] = { ...existing, label }
      return key
    }
    if (count >= MAX_NODES) {
      limitReached = true
      return null
    }
    nodes[key] = { key, kind, id, label: label ?? id, expanded: false, mayHaveMore: false }
    count += 1
    return key
  }

  const expandedNode = state.nodes[expandedKey]
  for (const row of accepted) {
    if (edges[row.edge_id]) continue
    if (!row.from_id || !row.to_id) continue
    // Defence in depth behind the server filter: keep an edge only if one END is the expanded (kind, id).
    if (expandedNode && nodeKey(row.from_kind, row.from_id) !== expandedKey && nodeKey(row.to_kind, row.to_id) !== expandedKey) continue
    const sourceExists = !!nodes[nodeKey(row.from_kind, row.from_id)]
    const targetExists = !!nodes[nodeKey(row.to_kind, row.to_id)]
    const needed = (sourceExists ? 0 : 1) + (targetExists ? 0 : 1)
    if (count + needed > MAX_NODES) {
      limitReached = true
      skippedEdges += 1
      continue
    }
    const source = ensure(row.from_kind, row.from_id, row.from_label)
    const target = ensure(row.to_kind, row.to_id, row.to_label)
    if (!source || !target) {
      skippedEdges += 1
      continue
    }
    edges[row.edge_id] = {
      id: row.edge_id,
      source,
      target,
      relationship: row.relationship,
      evidenceVersionId: row.evidence_version_id,
    }
  }

  const expanded = nodes[expandedKey]
  if (expanded) {
    nodes[expandedKey] = { ...expanded, expanded: true, mayHaveMore: rows.length >= EDGES_PER_EXPANSION }
  }
  if (count >= MAX_NODES) limitReached = true
  return { ...state, nodes, edges, limitReached, skippedEdges }
}

export function canExpand(state: GraphState, key: string): boolean {
  const node = state.nodes[key]
  return !!node && !node.expanded && nodeCount(state) < MAX_NODES
}

export const NODE_KIND_LABELS: Record<string, string> = {
  person_identity: 'Source identity',
  party_identity: 'Party label at source',
  electorate_label: 'Electorate label at source',
  electorate_version: 'Electorate (boundary edition)',
  election: 'Election',
  record_version: 'Record version',
}
