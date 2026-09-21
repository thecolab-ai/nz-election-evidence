import { Link } from '@tanstack/react-router'
import { ArrowRight, Database, FileText, Landmark, MapPin } from 'lucide-react'
import { ElectoratePicker } from '@/components/electorate-picker'
import { AvailabilityBlock, FactCard } from '@/components/fact-card'
import { ExternalLink, Note, PageHeader, Section } from '@/components/page'
import { ErrorBlock, LoadingBlock } from '@/components/states'
import {
  BOUNDARY_NOT_COMPARABLE_NOTE,
  classify,
  NO_ADDRESS_NOTE,
  NOT_A_CANDIDATE_NOTE,
  provenanceForSource,
  type SourceLike,
} from '@/lib/electorate'
import { formatCount, formatDate, formatDateTime, formatPlainDate, humanise } from '@/lib/format'
import { useCountQuery, useRowsQuery } from '@/lib/queries'
import type { ElectionRow, ElectorateVersionRow } from '@/lib/types'
import { OFFICIAL_PAGE_SOURCE_ID, POLICY_SOURCE_ID, useElectorateSources, useOfficialPageStatus, usePartyPolicyPages } from './electorate-data'

export const HOME_TITLE = 'Start with your electorate'

export const HOME_LEDE =
  'One page per electorate, built only from what official publishers have put out and this project has actually retrieved. Every fact carries its publisher, its date, the date it was retrieved, and what is still unknown about it.'

/** Ordered by name so the list reads as a directory, never as a ranking. */
function useElectorates() {
  return useRowsQuery<ElectorateVersionRow>({
    view: 'electorates',
    select: 'id,slug,name,electorate_type,official_code,boundary_edition,boundary_edition_title,boundary_edition_verified',
    key: ['home-electorates'],
    limit: 200,
    build: (q) => q.order('name'),
  })
}

export function HomePage() {
  const electorates = useElectorates()
  const elections = useRowsQuery<ElectionRow>({ view: 'elections', select: '*', key: ['home-elections'], limit: 10, build: (q) => q.order('election_date', { ascending: false, nullsFirst: false }) })
  const sources = useElectorateSources()

  const rows = electorates.data ?? []
  const editions = [...new Set(rows.map((e) => e.boundary_edition_title ?? e.boundary_edition).filter((v): v is string => !!v))]
  const upcoming = (elections.data ?? []).find((e) => e.view_scope === 'primary_2026')

  return (
    <>
      <PageHeader eyebrow="NZ Election Evidence" title={HOME_TITLE}>
        <p>{HOME_LEDE}</p>
      </PageHeader>

      <section aria-labelledby="pick-heading" className="mb-10 border border-rule bg-paper px-5 py-6 sm:px-7 sm:py-7">
        <h2 id="pick-heading" className="text-xl">
          Which electorate do you want to read about?
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{NO_ADDRESS_NOTE}</p>
        <div className="mt-4">
          {electorates.isPending ? (
            <LoadingBlock label="Loading the electorate list" rows={2} />
          ) : electorates.isError ? (
            <ErrorBlock error={electorates.error} onRetry={() => void electorates.refetch()} />
          ) : (
            <ElectoratePicker electorates={rows} />
          )}
        </div>
        <div className="mt-5 flex flex-col gap-2 border-t border-border pt-4 text-sm sm:flex-row sm:items-center sm:gap-6">
          <OfficialLookupLink />
          <Link to="/overview" className="doc-link inline-flex items-center gap-1" data-testid="home-to-explorer">
            Browse all of the data instead <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </div>
      </section>

      <Section
        id="boundaries"
        title="Which boundaries these pages use"
        description="An electorate page is a page about one electorate in one boundary edition. This is stated everywhere rather than smoothed over."
      >
        {electorates.isSuccess ? (
          <div className="space-y-2">
            <Note testId="home-boundary-editions">
              {editions.length === 0
                ? 'No boundary edition is recorded for the loaded electorates.'
                : `Every one of the ${formatCount(rows.length)} electorates loaded here belongs to ${editions.length === 1 ? 'a single boundary edition' : `${editions.length} boundary editions`}: ${editions.join('; ')}.`}{' '}
              {rows.some((e) => e.boundary_edition_verified !== true)
                ? 'The edition has not been verified against an official source, so it is shown as recorded and not as confirmed.'
                : ''}
            </Note>
            <Note tone="caution" testId="home-boundary-warning">
              {BOUNDARY_NOT_COMPARABLE_NOTE}
            </Note>
            <Note testId="home-electorate-type">
              {rows.every((e) => e.electorate_type === 'unverified')
                ? 'Whether an electorate is a general or a Māori electorate has not been verified against an official source for any electorate loaded here, so no page states it. The Commission publishes its boundary maps separately for each; both are linked from every electorate page.'
                : 'Where an electorate’s type has been verified against an official source, the page states it; where it has not, the page says so.'}
            </Note>
          </div>
        ) : null}
      </Section>

      <Section id="the-2026-election" title="The 2026 election, as this store holds it">
        {upcoming ? <UpcomingElectionCard election={upcoming} sources={sources.data ?? []} /> : elections.isPending ? <LoadingBlock label="Loading elections" rows={2} /> : null}
      </Section>

      <Section
        id="party-policy"
        title="What each party published for 2026"
        description="The parties’ own policy pages, as pages. This is separate from anything done in Parliament, and nothing on it has been read, summarised or classified by this project."
      >
        <PartyPolicyPages sources={sources.data ?? []} />
      </Section>

      <Section id="explorer" title="The whole evidence register is still here">
        <ul className="grid gap-3 sm:grid-cols-3" data-testid="explorer-links">
          {[
            { to: '/overview' as const, icon: Database, title: 'Overview by scope', body: 'What has been retrieved for each scope, the release gates, and publisher rights.' },
            { to: '/records' as const, icon: FileText, title: 'Every record', body: 'Each retrieved record with its versions, hashes, dates and original link.' },
            { to: '/datasets' as const, icon: Landmark, title: 'Datasets and schema', body: 'Every dataset, column by column, including what is withheld and why.' },
          ].map((item) => (
            <li key={item.to}>
              <Link to={item.to} className="block h-full border border-border bg-paper px-4 py-3 no-underline hover:border-rule">
                <span className="flex items-center gap-2 font-medium">
                  <item.icon aria-hidden="true" className="size-4 text-muted-foreground" />
                  {item.title}
                </span>
                <span className="mt-1 block text-[13px] text-muted-foreground">{item.body}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </>
  )
}

/** The Commission's own address lookup, with the status this project last recorded for that page. */
function OfficialLookupLink() {
  const status = useOfficialPageStatus()
  const row = (status.data ?? [])[0]
  if (!row) return null
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5" data-testid="official-lookup">
      <MapPin aria-hidden="true" className="size-3.5 shrink-0 self-center text-muted-foreground" />
      <ExternalLink href={row.official_url}>Find an electorate by address at the Electoral Commission</ExternalLink>
      <span className="text-[12.5px] text-muted-foreground">
        ({row.page_status === 'official_page_unavailable' ? 'this page did not answer this project when last checked' : humanise(row.page_status).toLowerCase()}
        {row.first_retrieved_at ? `, ${formatDate(row.first_retrieved_at)}` : ''})
      </span>
    </span>
  )
}

function UpcomingElectionCard({ election, sources }: { election: ElectionRow; sources: readonly SourceLike[] }) {
  const nominations = useCountQuery({ view: 'candidacies', key: ['home', election.slug, 'nominated'], build: (q) => q.eq('election_slug', election.slug).eq('current_status', 'officially_nominated') })
  const announced = useCountQuery({ view: 'candidacies', key: ['home', election.slug, 'announced'], build: (q) => q.eq('election_slug', election.slug).eq('current_status', 'announced') })
  const officialPage = useOfficialPageStatus()
  const page = (officialPage.data ?? [])[0]

  return (
    <FactCard
      testId="home-2026-card"
      eyebrow={election.slug}
      title={election.title}
      lede={<p>{NOT_A_CANDIDATE_NOTE}</p>}
      provenance={provenanceForSource(sources, OFFICIAL_PAGE_SOURCE_ID, 'Electoral Commission')}
      unknowns={[
        'Who will stand: no official nomination for 2026 has been loaded into this store.',
        'The 2026 boundaries: the Commission’s final maps are linked, but no 2026 electorate has been loaded, so no page can say which area a 2026 electorate covers.',
        election.election_date_basis ? `The election date here rests on: ${election.election_date_basis}` : 'How the election date was established is not recorded.',
      ]}
    >
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
        <div>
          <dt className="eyebrow">Election day</dt>
          <dd className="num mt-0.5 text-lg">{formatPlainDate(election.election_date, 'not established')}</dd>
        </div>
        <div>
          <dt className="eyebrow">Officially nominated candidates loaded</dt>
          <dd className="mt-0.5 text-lg" data-testid="home-2026-nominations">
            {nominations.isSuccess ? (nominations.data === 0 ? 'none published here yet' : formatCount(nominations.data)) : 'unknown'}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Announced only</dt>
          <dd className="mt-0.5 text-lg">{announced.isSuccess ? (announced.data === 0 ? 'none held' : formatCount(announced.data)) : 'unknown'}</dd>
        </div>
      </dl>
      <p className="mt-4 max-w-3xl text-muted-foreground">
        “Officially nominated” means an Electoral Commission source said so. “Announced” means a party or a report said so. Neither is loaded for 2026
        yet, so no electorate page can list a 2026 candidate. That is a gap in what has been retrieved, not a statement that nobody is standing.
      </p>
      {page ? (
        <p className="mt-2 max-w-3xl text-muted-foreground" data-testid="home-official-page-status">
          The Commission’s 2026 electorate page was recorded as <span className="text-foreground">{humanise(page.page_status).toLowerCase()}</span> when this
          project last requested it{page.first_retrieved_at ? ` on ${formatDateTime(page.first_retrieved_at)}` : ''}; whether candidate details are available there is{' '}
          {humanise(page.candidate_details_available).toLowerCase()}.
        </p>
      ) : null}
    </FactCard>
  )
}

function PartyPolicyPages({ sources }: { sources: readonly SourceLike[] }) {
  const policy = usePartyPolicyPages()
  const availability = classify(policy)
  return (
    <AvailabilityBlock
      availability={availability}
      loadingLabel="Loading party policy pages"
      datasetName="evidence_public.policy_classifications"
      noneHeld="No party policy page has been loaded for the 2026 election."
      onRetry={() => void policy.refetch()}
    >
      {(pages) => (
        <div className="space-y-3">
          <FactCard
            testId="policy-card"
            eyebrow="Parties’ own publications"
            title={`${formatCount(pages.length)} party policy pages, as published`}
            lede={
              <p>
                Listed alphabetically by the label the party uses for itself. This project links these pages; it does not quote, summarise, score or
                compare them, and it does not say whether a party is standing a candidate in any electorate.
              </p>
            }
            provenance={provenanceForSource(sources, POLICY_SOURCE_ID, 'Registered New Zealand political parties')}
            unknowns={[
              'What each page promises: nothing on these pages has been read or classified by this project, and every classification row is recorded as “unknown” with no basis.',
              'Whether a page has changed since it was retrieved: the retrieval date below is when this project last fetched the page, not when the party last edited it.',
              'Which parties are missing: a party without a page here may simply not have been retrieved.',
            ]}
          >
            <ul className="divide-y divide-border" data-testid="policy-pages">
              {pages.map((page) => (
                <li key={page.documentId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                  <span className="min-w-0 font-medium">{page.partyName ?? 'party label not shown'}</span>
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-[13px] text-muted-foreground">
                    <span>Published {page.sourcePublishedAt ? formatDate(page.sourcePublishedAt) : 'date not stated by the party'}</span>
                    <span>Retrieved {formatDate(page.firstRetrievedAt, 'not recorded')}</span>
                    <ExternalLink href={page.officialUrl}>Open the party’s page</ExternalLink>
                  </span>
                </li>
              ))}
            </ul>
          </FactCard>
        </div>
      )}
    </AvailabilityBlock>
  )
}
