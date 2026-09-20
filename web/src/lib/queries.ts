import type { PostgrestFilterBuilder } from '@supabase/postgrest-js'
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { pageRange } from './pagination'
import { effectiveSort, type ListSearch, type ListSpec } from './search'
import { OPEN_SCHEMA, requireSupabase, type OpenTableName, type PublicViewName } from './supabase'

/** Read-only by construction: this module only ever calls `.select()`. There is no RPC and no write path. */

type LooseRow = Record<string, unknown>
type LooseSchema = { Tables: Record<string, never>; Views: Record<string, never>; Functions: Record<string, never> }
/**
 * Column lists are runtime strings, so filters are typed over a generic row. Dataset NAMES stay
 * strongly typed against the generated database types (see DatasetRef), which is what catches drift.
 */
export type SelectQuery = PostgrestFilterBuilder<{ PostgrestVersion: '12' }, LooseSchema, LooseRow, LooseRow[], string, unknown, 'GET'>

/** A curated public view, or a per-table projection in the open schema. Names come from the generated types. */
export type DatasetRef = PublicViewName | { open: OpenTableName }

/** Structural view of the client used for dynamic column lists; avoids instantiating every view's row type at once. */
interface LooseSource {
  from(name: string): { select(columns: string, options?: { count?: 'exact' | 'estimated' }): unknown }
  schema(name: string): LooseSource
}

function fromDataset(ref: DatasetRef) {
  const supabase = requireSupabase() as unknown as LooseSource
  return typeof ref === 'string' ? supabase.from(ref) : supabase.schema(OPEN_SCHEMA).from(ref.open)
}

function selectFrom(ref: DatasetRef, columns: string, options?: { count?: 'exact' | 'estimated' }): SelectQuery {
  return fromDataset(ref).select(columns, options) as unknown as SelectQuery
}

function datasetKey(ref: DatasetRef): string {
  return typeof ref === 'string' ? ref : `open:${ref.open}`
}

export interface ListResult<Row> {
  rows: Row[]
  /** Null when the server returned no count. Unknown, not zero. */
  total: number | null
  countIsEstimate: boolean
}

export class DataError extends Error {
  readonly code: string | null
  readonly hint: string | null
  constructor(message: string, code?: string | null, hint?: string | null) {
    super(message)
    this.name = 'DataError'
    this.code = code ?? null
    this.hint = hint ?? null
  }
}

interface PostgrestLikeError {
  message?: string
  code?: string
  hint?: string | null
  details?: string | null
}

export function toDataError(error: PostgrestLikeError | null | undefined, status?: number): DataError {
  const message = error?.message?.trim() || (status ? `The data service answered with HTTP ${status}.` : 'The data service did not answer.')
  return new DataError(message, error?.code ?? null, error?.hint ?? error?.details ?? null)
}

export interface ListQueryOptions<Row, F extends string> {
  view: DatasetRef
  select: string
  spec: ListSpec<F>
  search: ListSearch<F>
  /** `estimated` for the large tables; `exact` elsewhere. */
  count?: 'exact' | 'estimated'
  /** Extra identifying values for the cache key (for example a parent id). */
  scopeKey?: readonly unknown[]
  filter?: (query: SelectQuery, search: ListSearch<F>) => SelectQuery
  enabled?: boolean
  // Row is only used to type the result.
  _row?: Row
}

export function useListQuery<Row, F extends string = string>(
  options: ListQueryOptions<Row, F>,
): UseQueryResult<ListResult<Row>, DataError> {
  const { view, select, spec, search, count = 'exact', scopeKey = [], filter, enabled = true } = options
  return useQuery<ListResult<Row>, DataError>({
    queryKey: ['list', datasetKey(view), select, count, scopeKey, search],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      let query = selectFrom(view, select, { count })
      if (filter) query = filter(query, search)
      for (const rule of effectiveSort(spec, search)) {
        query = query.order(rule.column, { ascending: rule.dir === 'asc', nullsFirst: false })
      }
      const { from, to } = pageRange(search.page, search.size)
      const { data, error, count: total, status } = await query.range(from, to).abortSignal(signal)
      // Asking for a page past the end is HTTP 416 / PGRST103: an empty page, not a failure.
      if (error && (status === 416 || error.code === 'PGRST103')) {
        return { rows: [], total: null, countIsEstimate: count === 'estimated' }
      }
      if (error) throw toDataError(error, status)
      return { rows: (data ?? []) as unknown as Row[], total: total ?? null, countIsEstimate: count === 'estimated' }
    },
  })
}

export interface RowsQueryOptions {
  view: DatasetRef
  select: string
  key: readonly unknown[]
  build?: (query: SelectQuery) => SelectQuery
  /** Hard ceiling for small unpaginated panels. */
  limit?: number
  enabled?: boolean
}

/** Small bounded read for detail panels. Always limited; never an open-ended fetch. */
export function useRowsQuery<Row>(options: RowsQueryOptions): UseQueryResult<Row[], DataError> {
  const { view, select, key, build, limit = 50, enabled = true } = options
  return useQuery<Row[], DataError>({
    queryKey: ['rows', datasetKey(view), select, limit, key],
    enabled,
    queryFn: async ({ signal }) => {
      let query = selectFrom(view, select)
      if (build) query = build(query)
      const { data, error, status } = await query.limit(limit).abortSignal(signal)
      if (error) throw toDataError(error, status)
      return (data ?? []) as unknown as Row[]
    },
  })
}

/** A server-side count (HEAD request, no rows). Null when the server gives none: unknown, not zero. */
export function useCountQuery(options: { view: DatasetRef; key: readonly unknown[]; build?: (query: SelectQuery) => SelectQuery; enabled?: boolean }): UseQueryResult<number | null, DataError> {
  const { view, key, build, enabled = true } = options
  return useQuery<number | null, DataError>({
    queryKey: ['count', datasetKey(view), key],
    enabled,
    queryFn: async ({ signal }) => {
      const source = requireSupabase() as unknown as { from(name: string): { select(columns: string, options: { count: 'exact'; head: true }): unknown }; schema(name: string): { from(name: string): { select(columns: string, options: { count: 'exact'; head: true }): unknown } } }
      const table = typeof view === 'string' ? source.from(view) : source.schema(OPEN_SCHEMA).from(view.open)
      let query = table.select('id', { count: 'exact', head: true }) as SelectQuery
      if (build) query = build(query)
      const { error, count, status } = await query.abortSignal(signal)
      if (error) throw toDataError(error, status)
      return count ?? null
    },
  })
}

/** Exactly one row by key, or null when the view returns nothing for it. */
export function useOneQuery<Row>(options: {
  view: PublicViewName
  select: string
  column: string
  value: string
  enabled?: boolean
}): UseQueryResult<Row | null, DataError> {
  const { view, select, column, value, enabled = true } = options
  return useQuery<Row | null, DataError>({
    queryKey: ['one', view, select, column, value],
    enabled,
    queryFn: async ({ signal }) => {
      const { data, error, status } = await selectFrom(view, select).eq(column, value).limit(1).abortSignal(signal)
      if (error) throw toDataError(error, status)
      return ((data ?? [])[0] as unknown as Row | undefined) ?? null
    },
  })
}
