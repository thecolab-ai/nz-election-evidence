export const PAGE_SIZES = [25, 50, 100] as const
export type PageSize = (typeof PAGE_SIZES)[number]
export const DEFAULT_PAGE_SIZE: PageSize = 25

/** PostgREST is configured with max_rows = 200; no page may ask for more than this. */
export const SERVER_MAX_ROWS = 200

export function isPageSize(value: number): value is PageSize {
  return (PAGE_SIZES as readonly number[]).includes(value)
}

/** Zero-based inclusive range for supabase-js `.range(from, to)`. */
export function pageRange(page: number, size: number): { from: number; to: number } {
  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
  const safeSize = Math.min(Math.max(1, Math.floor(size)), SERVER_MAX_ROWS)
  const from = (safePage - 1) * safeSize
  return { from, to: from + safeSize - 1 }
}

/** Null total means the server did not give a count: the page count is unknown, not zero. */
export function pageCount(total: number | null, size: number): number | null {
  if (total === null) return null
  if (total <= 0) return 0
  return Math.ceil(total / size)
}

export function hasNextPage(page: number, size: number, total: number | null, rowsOnPage: number): boolean {
  if (total === null) return rowsOnPage >= size
  return page * size < total
}

export function describeRange(page: number, size: number, total: number | null, rowsOnPage: number): string {
  if (rowsOnPage === 0) return total === null ? 'No rows on this page' : `0 of ${total.toLocaleString('en-NZ')} rows`
  const { from } = pageRange(page, size)
  const first = from + 1
  const last = from + rowsOnPage
  const totalText = total === null ? 'an unknown total' : total.toLocaleString('en-NZ')
  return `Rows ${first.toLocaleString('en-NZ')}–${last.toLocaleString('en-NZ')} of ${totalText}`
}
