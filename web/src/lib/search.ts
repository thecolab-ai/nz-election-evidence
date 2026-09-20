import { DEFAULT_PAGE_SIZE, isPageSize, type PageSize } from './pagination'

/**
 * URL search-param validation for every list route. Anything unexpected is dropped, never
 * passed through to a query: sort columns and enum filters are checked against an allowlist.
 */

export type SortDir = 'asc' | 'desc'

export interface SortRule {
  column: string
  dir: SortDir
}

export type FilterDef =
  | { kind: 'text'; maxLength?: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'flag' }

export interface ListSpec<F extends string = string> {
  sortable: readonly string[]
  /**
   * Only for a list whose columns are not known until run time (the generic dataset browser): the URL-level test
   * a sort key must pass. The page then narrows it again to the columns it actually offers.
   */
  acceptsSortKey?: (value: string) => boolean
  /** Applied when the URL carries no valid sort. */
  defaultSort: readonly SortRule[]
  /** Appended to every ordering so server pagination is stable. */
  tiebreak: string
  filters: Record<F, FilterDef>
}

export type ListSearch<F extends string = string> = {
  page: number
  size: PageSize
  sort?: string
  dir?: SortDir
} & Partial<Record<F, string>>

/** What a link may pass in: every key optional. The validator fills in the defaults. */
export type ListSearchInput<F extends string = string> = Partial<ListSearch<F>>

const MAX_PAGE = 100_000

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? '1' : undefined
  return undefined
}

export function parsePage(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(firstString(value) ?? '', 10)
  if (!Number.isInteger(n) || n < 1) return 1
  return Math.min(n, MAX_PAGE)
}

export function parseSize(value: unknown): PageSize {
  const n = typeof value === 'number' ? value : Number.parseInt(firstString(value) ?? '', 10)
  return isPageSize(n) ? n : DEFAULT_PAGE_SIZE
}

// Control characters never belong in a filter.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

export function parseText(value: unknown, maxLength = 100): string | undefined {
  const s = firstString(value)
  if (s === undefined) return undefined
  const cleaned = s.replace(CONTROL_CHARS, ' ').trim().slice(0, maxLength)
  return cleaned === '' ? undefined : cleaned
}

export function parseEnum(value: unknown, allowed: readonly string[]): string | undefined {
  const s = firstString(value)
  return s !== undefined && allowed.includes(s) ? s : undefined
}

export function parseFlag(value: unknown): '1' | undefined {
  return value === true || value === 1 || value === '1' || value === 'true' ? '1' : undefined
}

export function parseListSearch<F extends string>(spec: ListSpec<F>, raw: Record<string, unknown>): ListSearch<F> {
  const out: Record<string, unknown> = { page: parsePage(raw.page), size: parseSize(raw.size) }
  const rawSort = firstString(raw.sort)
  const sort = spec.acceptsSortKey ? (rawSort !== undefined && spec.acceptsSortKey(rawSort) ? rawSort : undefined) : parseEnum(raw.sort, spec.sortable)
  if (sort) {
    out.sort = sort
    out.dir = raw.dir === 'desc' ? 'desc' : 'asc'
  }
  for (const key of Object.keys(spec.filters) as F[]) {
    const def = spec.filters[key]
    let value: string | undefined
    if (def.kind === 'text') value = parseText(raw[key], def.maxLength)
    else if (def.kind === 'enum') value = parseEnum(raw[key], def.values)
    else value = parseFlag(raw[key])
    if (value !== undefined) out[key] = value
  }
  return out as ListSearch<F>
}

/** The ordering actually sent to the server: the chosen column (or the default) plus the tiebreak. */
export function effectiveSort<F extends string>(spec: ListSpec<F>, search: ListSearch<F>): SortRule[] {
  // A tabbed route shares one URL; a sort column that belongs to the other tab is ignored here.
  const rules: SortRule[] = search.sort && spec.sortable.includes(search.sort)
    ? [{ column: search.sort, dir: search.dir ?? 'asc' }]
    : spec.defaultSort.map((r) => ({ ...r }))
  // An empty tiebreak means "no stable column is safe to order by" (a generic dataset made only of figures).
  if (spec.tiebreak !== '' && !rules.some((r) => r.column === spec.tiebreak)) rules.push({ column: spec.tiebreak, dir: 'asc' })
  return rules
}

/** Next sort state when a header is activated: asc → desc → back to the default ordering. */
export function nextSort(current: { sort?: string; dir?: SortDir }, column: string): { sort?: string; dir?: SortDir } {
  if (current.sort !== column) return { sort: column, dir: 'asc' }
  if (current.dir !== 'desc') return { sort: column, dir: 'desc' }
  return { sort: undefined, dir: undefined }
}

/** Escape a user string for use inside a PostgREST `ilike` pattern, then wrap for "contains". */
export function ilikeContains(term: string): string {
  const escaped = term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  return `%${escaped}%`
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/** Kinds a graph may START from: each has rows a reader can find and a page of its own (or a record). */
export const GRAPH_ROOT_KINDS = ['person_identity', 'party_identity', 'electorate_version', 'record_version'] as const
export type GraphRootKind = (typeof GRAPH_ROOT_KINDS)[number]

/** Kinds that can appear as nodes. Canonical people and parties are withheld, so they are not among them. */
export const GRAPH_NODE_KINDS = [...GRAPH_ROOT_KINDS, 'electorate_label', 'election'] as const
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number]

export function isGraphRootKind(value: string | null | undefined): value is GraphRootKind {
  return (GRAPH_ROOT_KINDS as readonly string[]).includes(value ?? '')
}

export interface GraphSearch {
  kind?: GraphRootKind
  id?: string
}

/**
 * Graph start node. The id ends up inside a PostgREST `or=(...)` expression, so it is restricted
 * to characters that cannot break out of that expression.
 */
export function parseGraphSearch(raw: Record<string, unknown>): GraphSearch {
  const kind = parseEnum(raw.kind, GRAPH_ROOT_KINDS) as GraphRootKind | undefined
  const id = parseText(raw.id, 200)
  if (!kind || !id || !isSafeGraphId(id)) return {}
  return { kind, id }
}

export function isSafeGraphId(id: string): boolean {
  return /^[\p{L}\p{N} :._'-]{1,200}$/u.test(id)
}
