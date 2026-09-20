import { createColumnHelper } from '@tanstack/react-table'
import { getRouteApi, Link } from '@tanstack/react-router'
import { CandidacyStatusBadge, LinkStatusBadge, Pill } from '@/components/badges'
import { DataTable, type CoreFeatures } from '@/components/data-table'
import { EvidenceVersionLink } from '@/components/evidence-link'
import { FilterBar, SelectFilter, TextFilter } from '@/components/filters'
import { KeyValueList, Note, PageHeader, Section } from '@/components/page'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import { CANDIDACY_STATUS_LABELS, CANDIDACY_STATUSES, formatCount, formatPlainDate, formatVotes, humanise, scopeLabel } from '@/lib/format'
import { useListQuery, useOneQuery, useRowsQuery } from '@/lib/queries'
import { ilikeContains } from '@/lib/search'
import { candidaciesSpec } from '@/lib/specs'
import type { CandidacyRow, ElectionRow } from '@/lib/types'
import { filterPatch, useSetSearch } from '@/lib/use-set-search'

export const NO_NOMINATIONS_NOTE = 'No official nominations loaded. Unknown, not zero.'

function isPrimary2026(election: Pick<ElectionRow, 'view_scope'>): boolean {
  return election.view_scope === 'primary_2026'
}

export function ElectionsPage() {
  const elections = useRowsQuery<ElectionRow>({ view: 'elections', select: '*', key: ['all'], limit: 50, build: (q) => q.order('election_date', { ascending: false, nullsFirst: false }).order('slug') })
  return (
    <>
      <PageHeader eyebrow="Civic model" title="Elections">
        <p>Each election is its own scope. Candidacies are listed alphabetically; nothing here is arranged by votes, and no totals are drawn up by party.</p>
      </PageHeader>
      {elections.isPending ? <LoadingBlock label="Loading elections" rows={3} /> : elections.isError ? <ErrorBlock error={elections.error} onRetry={() => void elections.refetch()} /> : elections.data.length === 0 ? <EmptyBlock /> : (
        <ul className="grid gap-4 xl:grid-cols-2">
          {elections.data.map((e) => (
            <li key={e.id} className="border border-border bg-paper" data-testid={`election-${e.slug}`}>
              <div className="border-b border-border px-4 py-3">
                <p className="eyebrow">{scopeLabel(e.view_scope)}</p>
                <h2 className="mt-0.5 text-lg"><Link to="/elections/$slug" params={{ slug: e.slug }} className="doc-link">{e.title}</Link></h2>
                <p className="mt-1 text-[13px] text-muted-foreground">{humanise(e.election_type)} · {humanise(e.status)} · {formatPlainDate(e.election_date, 'date not established')}</p>
              </div>
              <dl className="grid grid-cols-3 gap-4 px-4 py-3 text-sm">
                <div><dt className="eyebrow">Candidacies loaded</dt><dd className="num text-lg">{formatCount(e.candidacies)}</dd></div>
                <div><dt className="eyebrow">Officially nominated</dt><dd className="num text-lg">{formatCount(e.officially_nominated)}</dd></div>
                <div><dt className="eyebrow">Announced only</dt><dd className="num text-lg">{formatCount(e.announced_only)}</dd></div>
              </dl>
              {isPrimary2026(e) && Number(e.officially_nominated) === 0 ? <div className="px-4 pb-3"><Note tone="caution" testId="no-nominations-note">{NO_NOMINATIONS_NOTE}</Note></div> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

const route = getRouteApi('/_released/elections/$slug')
const helper = createColumnHelper<CoreFeatures, CandidacyRow>()
const columns = helper.columns([
  helper.accessor('electorate_name', { header: 'Electorate', cell: ({ row }) => row.original.electorate_name ?? (row.original.candidacy_type === 'list' ? 'none (party list)' : 'not stated by source') }),
  helper.accessor('candidate_name', {
    header: 'Candidate (name at source)',
    cell: ({ row }) => (
      <div className="space-y-0.5">
        <Link to="/people/$identityId" params={{ identityId: row.original.person_identity_id }} className="doc-link font-medium">{row.original.candidate_name}</Link>
        {row.original.identity_link_status !== 'approved' ? <div><LinkStatusBadge status={row.original.identity_link_status} /></div> : null}
      </div>
    ),
  }),
  helper.accessor('party_label', { header: 'Party label at source', cell: ({ row }) => <>{row.original.party_label ?? 'not stated by source'}{row.original.stood_as_independent ? <span className="ml-1.5"><Pill tone="muted">label, not a registered party</Pill></span> : null}</> }),
  helper.accessor('candidacy_type', { header: 'Type', cell: ({ row }) => `${humanise(row.original.candidacy_type)}${row.original.list_rank ? ` · list position ${row.original.list_rank}` : ''}` }),
  helper.accessor('current_status', { header: 'Status', cell: ({ getValue }) => <CandidacyStatusBadge status={getValue()} /> }),
  helper.accessor('votes', {
    header: 'Candidate votes',
    cell: ({ row }) => (
      <span className="num" data-testid="votes-cell" data-votes-status={row.original.votes_status ?? 'none'}>
        {formatVotes(row.original.votes, row.original.votes_status, row.original.candidacy_type)}
        {row.original.result_status && row.original.votes_status === 'reported' ? <span className="ml-1 text-xs text-muted-foreground">({row.original.result_status})</span> : null}
      </span>
    ),
  }),
  helper.display({ id: 'evidence', header: 'Evidence', cell: ({ row }) => <EvidenceVersionLink versionId={row.original.evidence_version_id} /> }),
])

export function ElectionDetailPage() {
  const { slug } = route.useParams()
  const search = route.useSearch()
  const setSearch = useSetSearch()
  const election = useOneQuery<ElectionRow>({ view: 'elections', select: '*', column: 'slug', value: slug })
  const query = useListQuery<CandidacyRow, keyof typeof candidaciesSpec.filters>({
    view: 'candidacies',
    select: '*',
    spec: candidaciesSpec,
    search,
    scopeKey: [slug],
    filter: (q, s) => {
      let next = q.eq('election_slug', slug)
      if (s.status) next = next.eq('current_status', s.status)
      if (s.type) next = next.eq('candidacy_type', s.type)
      if (s.electorate) next = next.ilike('electorate_name', ilikeContains(s.electorate))
      if (s.party) next = next.ilike('party_label', ilikeContains(s.party))
      return next
    },
  })

  if (election.isPending) return <LoadingBlock label="Loading election" />
  if (election.isError) return <ErrorBlock error={election.error} onRetry={() => void election.refetch()} />
  const e = election.data
  if (!e) {
    return (
      <>
        <PageHeader eyebrow="Election" title="Election not found" />
        <EmptyBlock message={`No election with the slug "${slug}" was returned.`} />
      </>
    )
  }

  return (
    <>
      <p className="mb-3 text-sm"><Link to="/elections" className="doc-link">← All elections</Link></p>
      <PageHeader eyebrow={`Election · ${scopeLabel(e.view_scope)}`} title={e.title}>
        <p>Candidacies are listed alphabetically by electorate, then by candidate name. Vote counts are shown as the source reported them and cannot be used to order this list.</p>
      </PageHeader>

      {isPrimary2026(e) && Number(e.officially_nominated) === 0 ? <div className="mb-6"><Note tone="caution" testId="no-nominations-note">{NO_NOMINATIONS_NOTE}</Note></div> : null}

      <Section id="summary" title="What is loaded">
        <KeyValueList
          columns={3}
          items={[
            { label: 'Election date', value: `${formatPlainDate(e.election_date, 'not established')}${e.election_date_basis ? ` · ${e.election_date_basis}` : ''}` },
            { label: 'Status', value: humanise(e.status) },
            { label: 'Scope', value: scopeLabel(e.view_scope) },
            { label: 'Candidacies loaded', value: <span className="num">{formatCount(e.candidacies)}</span> },
            { label: 'Officially nominated', value: <span className="num">{formatCount(e.officially_nominated)}</span> },
            { label: 'Announced (not officially nominated)', value: <span className="num">{formatCount(e.announced_only)}</span> },
          ]}
        />
      </Section>

      <Section id="candidacies" title="Candidacies" description="“Announced” means a party or a news report said so. “Officially nominated” means an Electoral Commission source said so. They are not interchangeable.">
        <FilterBar hasActive={!!(search.status || search.type || search.electorate || search.party)} onClear={() => setSearch({ status: undefined, type: undefined, electorate: undefined, party: undefined, page: 1 })}>
          <SelectFilter name="status" label="Status" value={search.status} onChange={(v) => setSearch(filterPatch('status', v), { replace: true })} options={CANDIDACY_STATUSES.map((s) => ({ value: s, label: CANDIDACY_STATUS_LABELS[s] ?? s }))} anyLabel="Any status" />
          <SelectFilter name="type" label="Type" value={search.type} onChange={(v) => setSearch(filterPatch('type', v), { replace: true })} options={[{ value: 'electorate', label: 'Electorate' }, { value: 'list', label: 'List' }]} anyLabel="Any type" />
          <TextFilter name="electorate" label="Electorate contains" value={search.electorate} onCommit={(v) => setSearch(filterPatch('electorate', v), { replace: true })} />
          <TextFilter name="party" label="Party label contains" value={search.party} onCommit={(v) => setSearch(filterPatch('party', v), { replace: true })} />
        </FilterBar>
        <DataTable caption={`Candidacies for ${e.title}`} columns={columns} query={query} spec={candidaciesSpec} search={search} onSearchChange={setSearch} getRowId={(row) => row.id} />
      </Section>
    </>
  )
}
