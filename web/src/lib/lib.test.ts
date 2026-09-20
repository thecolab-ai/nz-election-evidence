import { describe, expect, it } from 'vitest'
import { bundleProblems } from '../../scripts/check-bundle.ts'
import { coverageFromSources } from './coverage'
import { looksLikeServiceRoleKey, resolveConfig, routerBasePath } from './env'
import { formatMoney, formatStatValue, formatVotes } from './format'
import { EDGES_PER_EXPANSION, edgeFilterFor, entityRoute, initialGraph, MAX_NODES, mergeExpansion, nodeCount, type EdgeRow } from './graph'
import { describeRange, hasNextPage, pageCount, pageRange, SERVER_MAX_ROWS } from './pagination'
import { effectiveSort, GRAPH_ROOT_KINDS, ilikeContains, parseGraphSearch, parseListSearch } from './search'
import { candidaciesSpec, recordsSpec } from './specs'

const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role, iss: 'fixture' })).toString('base64url')}.c2lnbmF0dXJlLWZpeHR1cmU`

describe('unknown is not zero', () => {
  it('shows a vote count only when the source reported one', () => {
    expect(formatVotes(1200, 'reported')).toBe('1,200')
    expect(formatVotes(0, 'reported')).toBe('0')
    expect(formatVotes(0, 'not_reported')).toBe('not reported')
    expect(formatVotes(null, 'suppressed')).toBe('suppressed')
    expect(formatVotes(null, null, 'list')).toBe('not applicable (list candidacy)')
    expect(formatVotes(null, null)).toBe('no result shown')
  })
  it('never renders a suppressed, confidential or missing statistic as a number', () => {
    expect(formatStatValue(0, null, 'suppressed')).toBe('suppressed')
    expect(formatStatValue(0, 0, 'confidential')).toBe('confidential')
    expect(formatStatValue(null, null, 'missing')).toBe('missing')
    expect(formatStatValue(null, null, 'reported')).toBe('value unavailable')
    expect(formatStatValue('12.5', null, 'provisional')).toBe('12.5 (provisional)')
  })
  it('shows a finance total only when it was reported', () => {
    expect(formatMoney(0, 'unknown')).not.toMatch(/\$|0/)
    expect(formatMoney(null, 'not_extracted')).toBe('not extracted')
    expect(formatMoney(1500, 'reported')).toContain('1,500')
  })
})

describe('pagination', () => {
  it('computes inclusive server ranges and never exceeds the server row cap', () => {
    expect(pageRange(1, 25)).toEqual({ from: 0, to: 24 })
    expect(pageRange(3, 50)).toEqual({ from: 100, to: 149 })
    expect(pageRange(-4, 25)).toEqual({ from: 0, to: 24 })
    const huge = pageRange(1, 10_000)
    expect(huge.to - huge.from + 1).toBe(SERVER_MAX_ROWS)
  })
  it('treats a missing total as unknown, not as zero', () => {
    expect(pageCount(null, 25)).toBeNull()
    expect(pageCount(65, 25)).toBe(3)
    expect(hasNextPage(1, 25, null, 25)).toBe(true)
    expect(hasNextPage(3, 25, 65, 15)).toBe(false)
    expect(describeRange(2, 25, 65, 25)).toBe('Rows 26–50 of 65')
    expect(describeRange(1, 25, null, 25)).toContain('an unknown total')
  })
})

describe('URL search validation', () => {
  it('drops unknown sort columns, bad enums, oversize pages and unexpected keys', () => {
    const parsed = parseListSearch(recordsSpec, { page: '-3', size: '5000', sort: 'safe_payload; drop table', dir: 'sideways', scope: 'everything', tombstoned: 'only', evil: 'x', q: 'Bill' })
    expect(parsed).toEqual({ page: 1, size: 25, tombstoned: 'only', q: 'Bill' })
  })
  it('never lets vote counts order a candidate list (R1)', () => {
    expect(candidaciesSpec.sortable).not.toContain('votes')
    const parsed = parseListSearch(candidaciesSpec, { sort: 'votes', dir: 'desc' })
    expect(parsed.sort).toBeUndefined()
    expect(effectiveSort(candidaciesSpec, parsed).map((r) => r.column)).toEqual(['electorate_name', 'candidate_name', 'id'])
  })
  it('escapes pattern characters and validates graph start nodes', () => {
    expect(ilikeContains('50%_a*')).not.toMatch(/^%.*[^\\]%.*%$/)
    expect(parseGraphSearch({ kind: 'table; drop', id: 'x' })).toEqual({})
    expect(edgeFilterFor('person_identity', 'ab"c\\d')).toBe('and(from_kind.eq.person_identity,from_id.eq."abcd"),and(to_kind.eq.person_identity,to_id.eq."abcd")')
    expect(() => edgeFilterFor('person_identity),or(id.neq.x', 'abc')).toThrow()
  })
})

describe('bounded graph', () => {
  const edge = (n: number, from = 'start'): EdgeRow => ({ edge_id: `e${n}`, from_kind: 'person_identity', from_id: from, from_label: 'Fixture start', to_kind: 'party_identity', to_id: `p${n}`, to_label: `Fixture party ${n}`, relationship: 'fixture', evidence_version_id: null })
  it('accepts at most 50 edges per expansion and de-duplicates', () => {
    const rows = Array.from({ length: 80 }, (_, i) => edge(i))
    const once = mergeExpansion(initialGraph('person_identity', 'start'), 'person_identity:start', rows)
    expect(Object.keys(once.edges)).toHaveLength(EDGES_PER_EXPANSION)
    expect(once.nodes['person_identity:start']?.mayHaveMore).toBe(true)
    const twice = mergeExpansion(once, 'person_identity:start', rows)
    expect(Object.keys(twice.edges)).toHaveLength(EDGES_PER_EXPANSION)
    expect(nodeCount(twice)).toBe(EDGES_PER_EXPANSION + 1)
  })
  it('never exceeds 300 nodes and says when the limit is reached', () => {
    let state = initialGraph('person_identity', 'start')
    for (let batch = 0; batch < 10; batch++) {
      state = mergeExpansion(state, 'person_identity:start', Array.from({ length: 50 }, (_, i) => edge(batch * 50 + i)))
    }
    expect(nodeCount(state)).toBe(MAX_NODES)
    expect(state.limitReached).toBe(true)
    expect(state.skippedEdges).toBeGreaterThan(0)
  })
})

describe('configuration and bundle safety', () => {
  it('is not configured without both public values, with placeholders, or with a privileged key', () => {
    expect(resolveConfig({})).toBeNull()
    expect(resolveConfig({ VITE_SUPABASE_URL: 'https://your-project-ref.supabase.co', VITE_SUPABASE_ANON_KEY: jwt('anon') })).toBeNull()
    expect(resolveConfig({ VITE_SUPABASE_URL: 'https://fixture.example', VITE_SUPABASE_ANON_KEY: jwt('service_role') })).toBeNull()
    expect(resolveConfig({ VITE_SUPABASE_URL: 'https://fixture.example/', VITE_SUPABASE_ANON_KEY: jwt('anon') })).toEqual({ supabaseUrl: 'https://fixture.example', supabaseAnonKey: jwt('anon') })
    expect(looksLikeServiceRoleKey('sb_secret_fixture')).toBe(true)
    expect(routerBasePath('/nz-election-evidence/')).toBe('/nz-election-evidence')
    expect(routerBasePath('/')).toBe('/')
  })
  it('flags key material, private names and fixture evidence in a bundle, but not the guard words', () => {
    expect(bundleProblems([{ name: 'ok.js', text: `if(k.startsWith("sb_secret_"))return; role==="service_role"; const key="${jwt('anon')}"` }])).toEqual([])
    expect(bundleProblems([{ name: 'a.js', text: `const k="${jwt('service_role')}"` }])[0]).toContain('service_role')
    expect(bundleProblems([{ name: 'b.js', text: 'sb_secret_abcdefghijkl' }])[0]).toContain('secret-style')
    expect(bundleProblems([{ name: 'c.js', text: 'from("evidence_private.source_records")' }])[0]).toContain('private schema')
  })
})

describe('coverage is derived from the rights-filtered sources view', () => {
  it('counts per scope, never across scopes, and treats an absent success as none yet', () => {
    const rows = coverageFromSources([
      { view_scope: 'current_parliament', freshness_status: 'fresh', last_success_at: '2026-09-20T01:00:00Z', live_records: 122 },
      { view_scope: 'current_parliament', freshness_status: 'fresh', last_success_at: '2026-09-20T03:00:00Z', live_records: '93' },
      { view_scope: 'primary_2026', freshness_status: 'unavailable', last_success_at: null, live_records: 0 },
    ])
    const parliament = rows.find((r) => r.view_scope === 'current_parliament')
    expect(parliament).toMatchObject({ sources: 2, sources_with_a_successful_run: 2, sources_currently_unavailable: 0, live_records: 215, latest_successful_retrieval: '2026-09-20T03:00:00Z' })
    expect(rows.find((r) => r.view_scope === 'primary_2026')).toMatchObject({ sources: 1, sources_with_a_successful_run: 0, sources_currently_unavailable: 1, latest_successful_retrieval: null })
    expect(rows.find((r) => r.view_scope === 'baseline_2023')).toBeUndefined()
    expect(coverageFromSources([])).toEqual([])
  })
})

describe('graph nodes are (kind, id): the same id under two kinds is two nodes', () => {
  const SHARED = '11111111-1111-4111-8111-111111111111'
  const row = (edge: string, fromKind: string, toKind: string, toId: string): EdgeRow => ({ edge_id: edge, from_kind: fromKind, from_id: SHARED, from_label: `Fixture ${fromKind}`, to_kind: toKind, to_id: toId, to_label: `Fixture ${toId}`, relationship: 'fixture', evidence_version_id: null })

  it('asks the server for edges of that kind AND that id, never the id alone', () => {
    const filter = edgeFilterFor('party_identity', SHARED)
    expect(filter).toContain('from_kind.eq.party_identity')
    expect(filter).toContain('to_kind.eq.party_identity')
    expect(filter).not.toMatch(/^from_id\.eq/)
  })

  it('collision regression: expanding one kind never pulls in the edges of another kind with the same id', () => {
    // What an id-only query would have returned: edges of BOTH the person identity and the party identity.
    const mixed = [row('e-person', 'person_identity', 'electorate_label', 'electorate:Fixture North'), row('e-party', 'party_identity', 'election', 'fixture-election')]
    const state = mergeExpansion(initialGraph('person_identity', SHARED), `person_identity:${SHARED}`, mixed)
    expect(Object.keys(state.edges)).toEqual(['e-person'])
    expect(Object.keys(state.nodes).sort()).toEqual(['electorate_label:electorate:Fixture North', `person_identity:${SHARED}`])
    expect(state.nodes[`party_identity:${SHARED}`]).toBeUndefined()
    // And the other way round.
    const party = mergeExpansion(initialGraph('party_identity', SHARED), `party_identity:${SHARED}`, mixed)
    expect(Object.keys(party.edges)).toEqual(['e-party'])
  })

  it('offers only supported roots, and routes each entity kind to its own page', () => {
    expect([...GRAPH_ROOT_KINDS]).toEqual(['person_identity', 'party_identity', 'electorate_version', 'record_version'])
    expect(parseGraphSearch({ kind: 'person', id: SHARED })).toEqual({})
    expect(parseGraphSearch({ kind: 'party_identity', id: SHARED })).toEqual({ kind: 'party_identity', id: SHARED })
    expect(entityRoute('person_identity', SHARED)).toEqual({ to: '/people/$identityId', params: { identityId: SHARED } })
    expect(entityRoute('party_identity', SHARED)).toEqual({ to: '/parties/$identityId', params: { identityId: SHARED } })
    expect(entityRoute('electorate_version', SHARED)).toEqual({ to: '/electorates/$versionId', params: { versionId: SHARED } })
    expect(entityRoute('electorate_label', 'electorate:Fixture North')).toBeNull()
    expect(entityRoute('party_identity', 'not-a-uuid')).toBeNull()
  })
})
