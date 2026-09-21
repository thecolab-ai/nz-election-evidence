import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { classify } from '@/lib/electorate'
import { useRowsQuery } from '@/lib/queries'

/**
 * The reads behind the electorate journey, against a stand-in for the data service.
 *
 * The case these tests exist for: a read in two hops — find the rows, then fetch the documents they
 * point at — where the FIRST hop honestly finds nothing. The second hop is then switched off and
 * never runs, and a switched-off query reports itself as pending for ever. A panel that believes its
 * parts would sit on a loading skeleton for ever on exactly the electorates this product most has to
 * be honest about: the ones where the store holds nothing.
 */

type Answer = { rows?: unknown[]; error?: { message: string; code: string } }

const answers: Record<string, Answer> = {}
const asked: string[] = []

function builder(key: string): Record<string, unknown> {
  const self: Record<string, unknown> = {}
  for (const method of ['select', 'in', 'eq', 'not', 'order', 'limit', 'abortSignal']) self[method] = () => self
  self.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
    asked.push(key)
    const answer = answers[key] ?? { rows: [] }
    return Promise.resolve(answer.error ? { data: null, error: answer.error, status: 400 } : { data: answer.rows ?? [], error: null, status: 200 }).then(resolve, reject)
  }
  return self
}

vi.mock('@/lib/supabase', () => ({
  PUBLIC_SCHEMA: 'evidence_public',
  OPEN_SCHEMA: 'evidence_open',
  getSupabase: () => null,
  requireSupabase: () => ({
    from: (name: string) => builder(`evidence_public.${name}`),
    schema: (schema: string) => ({ from: (name: string) => builder(`${schema}.${name}`) }),
  }),
}))

// Imported after the mock so the hooks build on it.
const { useBoundaryMaps, useMemberActivity, usePartyPolicyPages } = await import('./electorate-data')

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  for (const key of Object.keys(answers)) delete answers[key]
  asked.length = 0
})

describe('a read in two hops whose first hop finds nothing', () => {
  it('is the trap: a switched-off query calls itself pending for ever', async () => {
    const { result } = renderHook(() => useRowsQuery({ view: 'documents', select: 'id', key: ['disabled-fixture'], enabled: false }), { wrapper })
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    // This is the library's behaviour, not a bug: it is why the composed reads below must not ask their parts.
    expect(result.current.isPending).toBe(true)
    expect(result.current.isSuccess).toBe(false)
    expect(asked).toEqual([])
  })

  it('reports that no activity is held, rather than loading for ever, when a member has none', async () => {
    answers['evidence_open.bills'] = { rows: [] }
    answers['evidence_open.written_questions'] = { rows: [] }
    const { result } = renderHook(() => useMemberActivity(['identity-1', 'identity-2']), { wrapper })
    await waitFor(() => expect(result.current.isPending).toBe(false))
    expect(result.current.data).toEqual([])
    expect(classify(result.current)).toEqual({ state: 'none_held' })
    // Nothing was asked of the document register: there was nothing to look up.
    expect(asked).not.toContain('evidence_public.documents')
  })

  it('reports that no party policy page is held, rather than loading for ever', async () => {
    answers['evidence_public.policy_classifications'] = { rows: [] }
    const { result } = renderHook(() => usePartyPolicyPages(), { wrapper })
    await waitFor(() => expect(result.current.isPending).toBe(false))
    expect(classify(result.current)).toEqual({ state: 'none_held' })
  })

  it('reports that no boundary map is held, rather than loading for ever', async () => {
    answers['evidence_open.boundary_map_links'] = { rows: [] }
    const { result } = renderHook(() => useBoundaryMaps(), { wrapper })
    await waitFor(() => expect(result.current.isPending).toBe(false))
    expect(classify(result.current)).toEqual({ state: 'none_held' })
  })

  it('still waits while a hop it actually needs is unanswered', async () => {
    answers['evidence_open.bills'] = { rows: [{ document_id: 'doc-1', bill_number: '1-1', introduced_at: '2026-02-01', member_identity_id: 'identity-1', member_name_at_source: 'Fixture Member (TEST FIXTURE)' }] }
    answers['evidence_open.written_questions'] = { rows: [] }
    // The document register answers nothing yet: the panel is loading, not empty.
    const { result } = renderHook(() => useMemberActivity(['identity-1']), { wrapper })
    expect(classify(result.current)).toEqual({ state: 'loading' })
    await waitFor(() => expect(result.current.isPending).toBe(false))
  })
})

describe('what a composed read hands the page once it has answered', () => {
  it('keeps each item’s own source and link, and puts the most recent first', async () => {
    answers['evidence_open.bills'] = { rows: [{ document_id: 'doc-bill', bill_number: '12-2', bill_type: 'Government', current_stage: 'First reading', member_identity_id: 'identity-1', member_name_at_source: 'Fixture Member (TEST FIXTURE)', introduced_at: '2026-03-04' }] }
    answers['evidence_open.written_questions'] = { rows: [{ document_id: 'doc-wq', question_number: '00123', portfolio: 'Fixture portfolio (TEST FIXTURE)', lodged_on: '2026-06-09', asked_by_identity_id: 'identity-1', asker_name_at_source: 'Fixture Member (TEST FIXTURE)' }] }
    answers['evidence_public.documents'] = {
      rows: [
        { id: 'doc-bill', title: 'A fixture bill (TEST FIXTURE)', official_url: 'https://example.invalid/bill', source_id: 'parliament_export_bill_register', source_published_at: '2026-03-04', first_retrieved_at: '2026-09-01T00:00:00Z' },
        { id: 'doc-wq', title: 'A fixture question (TEST FIXTURE)', official_url: 'https://example.invalid/wq', source_id: 'parliament_export_written_questions', source_published_at: '2026-06-09', first_retrieved_at: '2026-09-02T00:00:00Z' },
      ],
    }
    const { result } = renderHook(() => useMemberActivity(['identity-1']), { wrapper })
    await waitFor(() => expect(result.current.isPending).toBe(false))
    const items = result.current.data ?? []
    expect(items.map((i) => i.kind)).toEqual(['written_question', 'bill'])
    expect(items.map((i) => i.sourceId)).toEqual(['parliament_export_written_questions', 'parliament_export_bill_register'])
    expect(items[0]?.occurredLabel).toBe('Lodged')
    expect(items[1]?.officialUrl).toBe('https://example.invalid/bill')
  })

  it('reports a failing hop as a failure, never as an empty answer', async () => {
    answers['evidence_open.bills'] = { error: { message: 'relation does not exist (TEST FIXTURE)', code: 'PGRST205' } }
    answers['evidence_open.written_questions'] = { rows: [] }
    const { result } = renderHook(() => useMemberActivity(['identity-1']), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(classify(result.current).state).toBe('not_loaded')
    expect(result.current.isPending).toBe(false)
  })
})
