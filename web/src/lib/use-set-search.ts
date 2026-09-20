import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import type { SearchPatch } from '@/components/data-table'

/**
 * Patch the current route's search params. Values are re-validated by the route's
 * `validateSearch` on the way back in, so nothing unchecked reaches a query.
 */
export function useSetSearch(): (patch: SearchPatch, options?: { replace?: boolean }) => void {
  const navigate = useNavigate()
  return useCallback(
    (patch, options) => {
      void navigate({
        to: '.',
        search: ((prev: Record<string, unknown>) => ({ ...prev, ...patch })) as never,
        replace: options?.replace ?? false,
        resetScroll: false,
      })
    },
    [navigate],
  )
}

/** Patch for a filter change: always returns to page 1 and replaces the history entry. */
export function filterPatch(key: string, value: string | undefined): SearchPatch {
  return { [key]: value, page: 1 }
}
