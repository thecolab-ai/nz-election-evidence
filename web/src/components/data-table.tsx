import { tableFeatures, useTable, type ColumnDef, type RowData } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { useId } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { describeRange, hasNextPage, pageCount, PAGE_SIZES, type PageSize } from '@/lib/pagination'
import type { DataError, ListResult } from '@/lib/queries'
import { nextSort, type SortDir } from '@/lib/search'
import { EmptyBlock, ErrorBlock, LoadingBlock } from './states'

/** Core row/column model only: sorting, filtering and pagination all happen on the server. */
export const tableCoreFeatures = tableFeatures({})
export type CoreFeatures = typeof tableCoreFeatures
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataColumn<Row extends RowData> = ColumnDef<CoreFeatures, Row, any>

export type SearchPatch = Record<string, string | number | undefined>

/** The parts of a validated list search the table itself needs. */
export interface TableSearch {
  page: number
  size: PageSize
  sort?: string
  dir?: SortDir
}

interface DataTableProps<Row extends RowData> {
  caption: string
  columns: DataColumn<Row>[]
  query: UseQueryResult<ListResult<Row>, DataError>
  spec: { sortable: readonly string[] }
  search: TableSearch
  onSearchChange: (patch: SearchPatch, options?: { replace?: boolean }) => void
  getRowId: (row: Row) => string
  emptyMessage?: string
}

const EMPTY_ROWS: never[] = []

export function DataTable<Row extends RowData>({ caption, columns, query, spec, search, onSearchChange, getRowId, emptyMessage }: DataTableProps<Row>) {
  const rows = query.data?.rows ?? (EMPTY_ROWS as Row[])
  const total = query.data?.total ?? null
  const table = useTable({ features: tableCoreFeatures, columns, data: rows, getRowId: (row) => getRowId(row) })
  const sizeId = useId()

  if (query.isPending) return <LoadingBlock label={`Loading ${caption}`} />
  if (query.isError) return <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />

  const pages = pageCount(total, search.size)
  const canNext = hasNextPage(search.page, search.size, total, rows.length)

  return (
    <div className="space-y-3">
      <div aria-live="polite" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm text-muted-foreground">
        <p data-testid="table-summary" className="num">
          {describeRange(search.page, search.size, total, rows.length)}
          {query.data?.countIsEstimate && total !== null ? ' (estimated total)' : ''}
          {query.isFetching ? <span className="ml-2" data-testid="table-refreshing">Updating…</span> : null}
        </p>
        <div className="flex items-center gap-2">
          <label htmlFor={sizeId}>Rows per page</label>
          <select
            id={sizeId}
            value={search.size}
            onChange={(event) => onSearchChange({ size: Number(event.target.value), page: 1 })}
            className="h-8 rounded-sm border border-input bg-paper px-2 text-sm text-foreground"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyBlock {...(emptyMessage ? { message: emptyMessage } : {})} />
      ) : (
        <div className="border border-border bg-paper">
          <Table className="text-[13.5px]">
            <TableCaption className="sr-only">{caption}</TableCaption>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="border-rule hover:bg-transparent">
                  {group.headers.map((header) => {
                    const columnId = header.column.id
                    const sortable = spec.sortable.includes(columnId)
                    const active = search.sort === columnId
                    const direction = active ? (search.dir === 'desc' ? 'descending' : 'ascending') : 'none'
                    return (
                      <TableHead key={header.id} scope="col" aria-sort={sortable ? direction : undefined} className="h-9 whitespace-nowrap bg-muted/60 align-middle text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        {header.isPlaceholder ? null : sortable ? (
                          <button
                            type="button"
                            onClick={() => onSearchChange({ ...nextSort(search, columnId), page: 1 })}
                            className="-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 uppercase hover:text-foreground"
                          >
                            <table.FlexRender header={header} />
                            {active ? search.dir === 'desc' ? <ArrowDown aria-hidden="true" className="size-3" /> : <ArrowUp aria-hidden="true" className="size-3" /> : <ArrowUpDown aria-hidden="true" className="size-3 opacity-40" />}
                            <span className="sr-only">{active ? `, sorted ${direction}` : ', not sorted'}. Activate to change sort.</span>
                          </button>
                        ) : (
                          <table.FlexRender header={header} />
                        )}
                      </TableHead>
                    )
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-testid="data-row">
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id} className="max-w-[28rem] py-2 align-top whitespace-normal">
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <nav aria-label={`Pagination for ${caption}`} className="flex items-center justify-between gap-4 text-sm">
        <Button type="button" variant="outline" size="sm" disabled={search.page <= 1} onClick={() => onSearchChange({ page: search.page - 1 })}>
          <ChevronLeft aria-hidden="true" /> Previous
        </Button>
        <p className="num text-muted-foreground" data-testid="page-indicator">
          Page {search.page}
          {pages === null ? '' : ` of ${Math.max(pages, 1)}`}
        </p>
        <Button type="button" variant="outline" size="sm" disabled={!canNext} onClick={() => onSearchChange({ page: search.page + 1 })}>
          Next <ChevronRight aria-hidden="true" />
        </Button>
      </nav>
    </div>
  )
}
