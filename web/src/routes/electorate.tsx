import { getRouteApi, Link } from '@tanstack/react-router'
import { ArrowLeft, Banknote, FileText, Map, Users } from 'lucide-react'
import { CandidacyStatusBadge, LinkStatusBadge, Pill } from '@/components/badges'
import { AvailabilityBlock, FactCard } from '@/components/fact-card'
import { EntityLink } from '@/components/entity-link'
import { EvidenceVersionLink } from '@/components/evidence-link'
import { ExternalLink, Note, PageHeader, Section } from '@/components/page'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import {
  ACTIVITY_NOT_EFFECTIVENESS_NOTE,
  BOUNDARY_NOT_COMPARABLE_NOTE,
  classify,
  classifyNamed,
  NOT_A_CANDIDATE_NOTE,
  PARTY_NOT_CANDIDATE_RECEIPT_NOTE,
  provenanceForSource,
  provenanceSpanning,
  REPRESENTATION_MATCH_NOTE,
  type SourceLike,
} from '@/lib/electorate'
import { formatCount, formatDate, formatDateTime, formatMoney, formatPlainDate, formatServiceDate, formatVotes, humanise, NOT_SHOWN, RIGHTS_NOTE } from '@/lib/format'
import type { CandidacyRow, DonationDisclosureRow, ElectorateVersionRow, ServiceTermRow } from '@/lib/types'
import {
  CANDIDACY_SOURCE_ID,
  CANDIDATE_DISCLOSURES_SOURCE_ID,
  disclosureSourceForKind,
  MEMBER_TERMS_SOURCE_ID,
  OFFICIAL_PAGE_SOURCE_ID,
  useBoundaryMaps,
  useCandidacies,
  useCandidacySources,
  useCandidateReturnLinkage,
  useDonationsAsPublished,
  useElectorateBySlug,
  useElectorateSources,
  useMemberActivity,
  useRepresentation,
  useResultSummary,
  type ActivityItem,
} from './electorate-data'

const route = getRouteApi('/_released/electorate/$slug')

export const ELECTORATE_PAGE_LEDE =
  'Everything below is scoped to one electorate in one boundary edition, and every card says who published it, when, when this project retrieved it, and what it does not know.'

export function ElectoratePage() {
  const { slug } = route.useParams()
  const electorate = useElectorateBySlug(slug)
  const sources = useElectorateSources()

  if (electorate.isPending) return <LoadingBlock label="Loading electorate" rows={5} />
  if (electorate.isError && electorate.error) return <ErrorBlock error={electorate.error} onRetry={() => electorate.refetch()} />
  const e = electorate.row
  if (!e) {
    return (
      <>
        <p className="mb-3 text-sm"><Link to="/" className="doc-link">← Find an electorate</Link></p>
        <PageHeader eyebrow="Electorate" title="No electorate with this address" />
        <EmptyBlock message={`No loaded electorate has the address “${slug}”. That is not evidence that no such electorate exists.`} />
      </>
    )
  }
  return <ElectorateBody electorate={e} sources={sources.data ?? []} />
}

/**
 * General or Māori, said only where this page actually holds it.
 *
 * Three different silences, and none of them may be printed as one of the other two. `unverified` is
 * the store's own flag: a type was recorded from nothing official. An ABSENT value is not that flag —
 * it means this deployment released no type for the row, either because the source stated none or
 * because the publisher's rights do not release the field, and the page must not report a withheld
 * value as a project finding of "unverified". Both say plainly that neither general nor Māori is
 * stated here, which is the only claim this page is entitled to make.
 */
function electorateTypeLabel(electorateType: string | null | undefined): string {
  if (electorateType === 'unverified') return 'not verified — neither general nor Māori is stated here'
  if (!electorateType) return 'not verified here — no electorate type is released for this row, so neither general nor Māori is stated'
  return humanise(electorateType)
}

function ElectorateBody({ electorate: e, sources }: { electorate: ElectorateVersionRow; sources: readonly SourceLike[] }) {
  const name = e.name ?? undefined
  const representation = useRepresentation(name)
  const memberIds = (representation.data ?? []).map((t) => t.person_identity_id)
  const typeStated = !!e.electorate_type && e.electorate_type !== 'unverified'

  return (
    <>
      <p className="mb-3 text-sm">
        <Link to="/" className="doc-link inline-flex items-center gap-1" data-testid="back-to-picker">
          <ArrowLeft aria-hidden="true" className="size-3.5" /> Find another electorate
        </Link>
      </p>
      <PageHeader eyebrow={`Electorate · ${e.boundary_edition_title ?? e.boundary_edition ?? 'boundary edition not recorded'}`} title={e.name ?? 'Electorate (name not shown)'}>
        <p>{ELECTORATE_PAGE_LEDE}</p>
      </PageHeader>

      <div className="mb-8 space-y-2">
        <Note tone="caution" testId="electorate-boundary-note">{BOUNDARY_NOT_COMPARABLE_NOTE}</Note>
        {!typeStated || e.boundary_edition_verified !== true ? (
          <Note tone="caution" testId="electorate-type-unverified">
            {e.electorate_type === 'unverified'
              ? 'Whether this is a general or a Māori electorate has not been verified against an official source in this store, so this page does not state it.'
              : !e.electorate_type
                ? 'Whether this is a general or a Māori electorate is not shown here: this deployment released no electorate type for this row — either the source stated none, or the type is not released for this source. The page states neither.'
                : ''}{' '}
            The boundary edition itself is recorded as {e.boundary_edition_verified === true ? 'verified' : 'not verified'}.
          </Note>
        ) : null}
        <Note testId="rights-note">{RIGHTS_NOTE}</Note>
      </div>

      <Section id="identity" title="What this page is about">
        <dl className="grid gap-x-8 gap-y-3 border-y border-border py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="eyebrow">Electorate</dt><dd className="mt-0.5">{e.name ?? NOT_SHOWN}</dd></div>
          <div><dt className="eyebrow">Type</dt><dd className="mt-0.5" data-testid="electorate-type">{electorateTypeLabel(e.electorate_type)}</dd></div>
          <div><dt className="eyebrow">Official code at source</dt><dd className="num mt-0.5">{e.official_code ?? 'not recorded'}</dd></div>
          <div><dt className="eyebrow">Boundary edition</dt><dd className="mt-0.5">{e.boundary_edition_title ?? e.boundary_edition ?? 'not recorded'}</dd></div>
        </dl>
        <p className="mt-3 text-sm text-muted-foreground">
          Share this page by its address; it holds nothing about you.{' '}
          <Link to="/electorates/$versionId" params={{ versionId: e.id }} className="doc-link" data-testid="to-version-record">
            Inspect this electorate version in the evidence explorer
          </Link>
          .
        </p>
      </Section>

      <div className="space-y-6">
        <StandingIn2026Card electorate={e} sources={sources} />
        <RepresentationCard electorate={e} representation={representation} sources={sources} />
        <ActivityCard memberIds={memberIds} representationReady={representation.isSuccess} sources={sources} />
        <Result2023Card electorate={e} sources={sources} />
        <MoneyCard electorate={e} sources={sources} />
      </div>
    </>
  )
}

// ---- 2026 --------------------------------------------------------------------------------------

function StandingIn2026Card({ electorate: e, sources }: { electorate: ElectorateVersionRow; sources: readonly SourceLike[] }) {
  const candidacies = useCandidacies(e.id, 'general-2026')
  const maps = useBoundaryMaps()
  const availability = classify(candidacies)
  // What this card states about 2026 comes from the official page status export: that the Commission has
  // published no nomination list yet. Any candidacy row listed below would come from somewhere else
  // entirely, so the strip may not go on naming the page-status export alone once there are rows. The
  // sources are resolved from the rows themselves and never assumed; with nothing listed, this is empty
  // and the strip is exactly the page-status export it has always been.
  const candidacySources = useCandidacySources(candidacies.data ?? [])
  const spansSources = candidacySources.ids.some((id) => id !== OFFICIAL_PAGE_SOURCE_ID)
  return (
    <FactCard
      testId="card-2026"
      eyebrow="2026 general election"
      title="Who is standing here"
      lede={
        <>
          <p>Only an official nomination or a party’s own announcement can put a name here, and each is labelled for which it is.</p>
          <p className="mt-1">{NOT_A_CANDIDATE_NOTE}</p>
        </>
      }
      tone="caution"
      provenance={provenanceSpanning(sources, [OFFICIAL_PAGE_SOURCE_ID, ...candidacySources.ids], 'Electoral Commission')}
      unknowns={[
        'Everyone standing: no 2026 nomination or announcement has been loaded for any electorate.',
        'Which 2026 electorate covers this area: the 2026 boundaries are a different edition and no 2026 electorate has been loaded here, so this page cannot carry a name across.',
        'Whether the sitting member is standing again: this store holds nothing that says either way.',
        ...(spansSources
          ? ['Exactly when each name below was retrieved: the check of the Commission’s official page and whatever recorded a name are separate sources, and the dates above are the oldest of them, never the newest. Every name names the source it was recorded by.']
          : []),
      ]}
    >
      <AvailabilityBlock
        availability={availability}
        loadingLabel="Loading 2026 candidacies"
        datasetName="evidence_public.candidacies"
        noneHeld="No candidate has been recorded for this electorate for the 2026 election."
        onRetry={() => void candidacies.refetch()}
      >
        {(rows) => <CandidacyList rows={rows} caption="Candidates recorded for 2026" sourceFor={candidacySources.sourceFor} />}
      </AvailabilityBlock>

      <div className="mt-5 border-t border-border pt-4">
        <p className="eyebrow flex items-center gap-1.5"><Map aria-hidden="true" className="size-3" /> The 2026 boundaries, from the publisher</p>
        <BoundaryMapList maps={maps} />
      </div>
    </FactCard>
  )
}

/**
 * The publisher's own map files, nested inside the 2026 card. It answers a DIFFERENT question from the
 * card it sits in — which maps are held, not who is standing — so its silences are named for itself.
 * Two unnamed silences in one card read as one answer given twice, and neither a reader nor a test can
 * tell which question was answered.
 */
function BoundaryMapList({ maps }: { maps: ReturnType<typeof useBoundaryMaps> }) {
  const availability = classify(maps)
  return (
    <AvailabilityBlock
      availability={availability}
      statePrefix="boundary-maps"
      loadingLabel="Loading boundary maps"
      datasetName="evidence_open.boundary_map_links"
      noneHeld="No 2026 boundary map has been loaded."
      onRetry={() => maps.refetch()}
    >
      {(rows) => (
        <ul className="mt-2 space-y-1.5 text-[13.5px]" data-testid="boundary-maps">
          {rows.map((m) => (
            <li key={m.documentId} className="flex flex-wrap items-baseline gap-x-2">
              <Pill tone="muted">{m.boundaryType ?? 'type not stated'}</Pill>
              <span>{m.scope ?? m.title ?? 'map'}</span>
              {m.officialUrl ? <ExternalLink href={m.officialUrl}>open the map at the publisher</ExternalLink> : null}
              <span className="text-muted-foreground">retrieved {formatDate(m.firstRetrievedAt, 'not recorded')}</span>
            </li>
          ))}
          <li className="pt-1 text-muted-foreground">
            These are the publisher’s own map files. This project has loaded no 2026 electorate area, so it cannot say whether this electorate’s
            boundary changed, or by how much.
          </li>
        </ul>
      )}
    </AvailabilityBlock>
  )
}

// ---- Representation -----------------------------------------------------------------------------

function RepresentationCard({
  electorate: e,
  representation,
  sources,
}: {
  electorate: ElectorateVersionRow
  representation: ReturnType<typeof useRepresentation>
  sources: readonly SourceLike[]
}) {
  const availability = classifyNamed(e.name, representation)
  const rows = representation.data ?? []
  const publishers = [...new Set(rows.map((r) => r.source_id))]
  return (
    <FactCard
      testId="card-representation"
      eyebrow="The current Parliament"
      title="Who represents this electorate now"
      lede={<p>{NOT_A_CANDIDATE_NOTE}</p>}
      provenance={provenanceForSource(sources, MEMBER_TERMS_SOURCE_ID, 'New Zealand Parliament')}
      unknowns={[
        'Whether these records describe this exact boundary version: the reviewed link is not recorded, so the match below is between two pieces of text.',
        rows.length > 1 && publishers.length > 1
          ? `The same person may appear more than once: ${publishers.length} publishers’ records are shown side by side and this store has not reviewed whether they name the same person.`
          : 'Whether a record here names the same person as a record from another publisher: identity links are unresolved in this store.',
        'When a term began or ended, where the publisher states no date: this page prints “not established” rather than a guess.',
      ]}
    >
      <Note tone="caution" testId="representation-basis">{REPRESENTATION_MATCH_NOTE}</Note>
      <div className="mt-3">
        <AvailabilityBlock
          availability={availability}
          loadingLabel="Loading member records"
          datasetName="evidence_public.service_terms"
          noneHeld={
            e.name
              ? `No loaded member record writes the electorate name “${e.name}”.`
              : 'This electorate version carries no name in this store, and the only thing that could connect a member record to it is the name the publisher writes. So there is nothing to correspond with, and none was looked for.'
          }
          onRetry={() => void representation.refetch()}
        >
          {(terms) => (
            <ul className="divide-y divide-border" data-testid="representation-list">
              {terms.map((t) => (
                <RepresentationRow key={t.id} term={t} />
              ))}
            </ul>
          )}
        </AvailabilityBlock>
      </div>
    </FactCard>
  )
}

function RepresentationRow({ term }: { term: ServiceTermRow }) {
  return (
    <li className="py-3" data-testid="representation-row">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-base font-medium">
          <EntityLink kind="person_identity" id={term.person_identity_id}>{term.member_name ?? NOT_SHOWN}</EntityLink>
        </p>
        <span className="flex flex-wrap items-center gap-2">
          <Pill tone="muted">{humanise(term.representation)}</Pill>
          <LinkStatusBadge status="unresolved" />
        </span>
      </div>
      <dl className="mt-1.5 grid gap-x-6 gap-y-1 text-[13px] text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="inline">Party label at source: </dt><dd className="inline text-foreground"><EntityLink kind="party_identity" id={term.party_identity_id}>{term.party_label ?? NOT_SHOWN}</EntityLink></dd></div>
        <div><dt className="inline">Electorate as the publisher writes it: </dt><dd className="inline text-foreground">{term.electorate_name_at_source ?? NOT_SHOWN}</dd></div>
        <div><dt className="inline">Term from: </dt><dd className="inline text-foreground">{formatServiceDate(term.valid_from)}{term.date_precision && term.date_precision !== 'day' ? ` (date precision: ${humanise(term.date_precision).toLowerCase()})` : ''}</dd></div>
        <div><dt className="inline">Recorded by: </dt><dd className="inline text-foreground font-mono text-[12px]">{term.source_id}</dd></div>
        <div><dt className="inline">First seen: </dt><dd className="inline text-foreground">{formatDateTime(term.observed_first_at)}</dd></div>
        <div><dt className="inline">Last seen: </dt><dd className="inline text-foreground">{formatDateTime(term.observed_last_at)}</dd></div>
        <div><dt className="inline">Basis: </dt><dd className="inline text-foreground">{humanise(term.basis)}</dd></div>
        <div><dt className="inline">Evidence: </dt><dd className="inline text-foreground"><EvidenceVersionLink versionId={term.evidence_version_id} /></dd></div>
      </dl>
    </li>
  )
}

// ---- Activity -----------------------------------------------------------------------------------

function ActivityCard({ memberIds, representationReady, sources }: { memberIds: readonly string[]; representationReady: boolean; sources: readonly SourceLike[] }) {
  const activity = useMemberActivity(memberIds)
  const availability = classify(activity)
  // Bills and written questions are not one export. The strip names the sources of what is actually
  // listed, and falls back to the written-questions register when nothing is listed at all.
  const itemSources = (activity.data ?? []).map((item) => item.sourceId).filter((id): id is string => !!id)
  return (
    <FactCard
      testId="card-activity"
      eyebrow="Parliamentary record"
      title="Selected dated activity by the members named above"
      lede={<p>{ACTIVITY_NOT_EFFECTIVENESS_NOTE}</p>}
      provenance={provenanceSpanning(sources, itemSources.length ? itemSources : ['parliament_export_written_questions'], 'New Zealand Parliament')}
      unknowns={[
        'Most of what a member does: this panel shows only bills and written questions that carry a recorded link to the member’s identity.',
        'Exactly when each entry below was retrieved, where more than one register is listed: the dates above are the oldest of them, and every entry names the register it came from.',
        'Anything attributable only by name: a question printed “Hon Rachel Brooking” and a member record reading “Rachel Brooking” are two publishers’ texts, and this page will not join them.',
        'How anyone voted, and whether any of this achieved anything: neither is held here, and neither is inferred.',
      ]}
    >
      {!representationReady && memberIds.length === 0 ? (
        <LoadingBlock label="Waiting for member records" rows={2} />
      ) : (
        <AvailabilityBlock
          availability={memberIds.length === 0 ? { state: 'none_held' } : availability}
          loadingLabel="Loading parliamentary activity"
          datasetName="evidence_open.bills and evidence_open.written_questions"
          noneHeld={
            memberIds.length === 0
              ? 'There is no member record for this electorate to look up activity for.'
              : 'No bill or written question in this store carries a recorded link to any of these member identities.'
          }
          onRetry={() => activity.refetch()}
        >
          {(items) => (
            <ul className="divide-y divide-border" data-testid="activity-list">
              {items.map((item) => (
                <ActivityRow key={`${item.kind}-${item.documentId}`} item={item} />
              ))}
            </ul>
          )}
        </AvailabilityBlock>
      )}
      <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-[13px]">
        <Link to="/documents" className="doc-link inline-flex items-center gap-1" data-testid="activity-to-documents">
          <FileText aria-hidden="true" className="size-3.5" /> Browse every parliamentary document held
        </Link>
        <Link to="/parliament" className="doc-link inline-flex items-center gap-1">
          <Users aria-hidden="true" className="size-3.5" /> Browse members and their terms
        </Link>
      </p>
    </FactCard>
  )
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <li className="py-2.5" data-testid="activity-row">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium">{item.title ?? item.headline}</span>
        <span className="text-[13px] text-muted-foreground">
          {item.occurredLabel} {formatPlainDate(item.occurredAt, 'date not stated')}
        </span>
      </div>
      <p className="mt-0.5 text-[13px] text-muted-foreground">
        <Pill tone="muted">{item.kind === 'bill' ? 'Bill' : 'Written question'}</Pill>{' '}
        {item.headline}
        {item.detail ? ` · ${item.detail}` : ''}
        {item.memberNameAtSource ? ` · named at source as ${item.memberNameAtSource}` : ''}
        {item.sourceId ? <> · recorded by <span className="font-mono text-[12px] text-foreground">{item.sourceId}</span></> : null}
        {item.officialUrl ? <> · <ExternalLink href={item.officialUrl}>open at the publisher</ExternalLink></> : null}
      </p>
    </li>
  )
}

// ---- 2023 --------------------------------------------------------------------------------------

function Result2023Card({ electorate: e, sources }: { electorate: ElectorateVersionRow; sources: readonly SourceLike[] }) {
  const candidacies = useCandidacies(e.id, 'general-2023')
  const rows = candidacies.data ?? []
  const contestId = rows[0]?.contest_id
  const summary = useResultSummary(contestId)
  const summaryRow = (summary.data ?? [])[0]
  const availability = classify(candidacies)
  // The same rule as the 2026 card: the strip names the sources the listed rows were really loaded
  // from, resolved through each row's own record version. The declared roster export is the fallback
  // for the strip only while nothing has resolved, never a claim about a row.
  const candidacySources = useCandidacySources(rows)
  return (
    <FactCard
      testId="card-2023"
      eyebrow="Historical · 2023 general election"
      title="What happened here in 2023"
      lede={
        <p>
          Kept separate on purpose. This is a past election held under the boundary edition named at the top of this page, and it is not a forecast,
          a baseline or a comparison for 2026.
        </p>
      }
      provenance={provenanceSpanning(sources, candidacySources.ids.length ? candidacySources.ids : [CANDIDACY_SOURCE_ID], 'Electoral Commission')}
      unknowns={[
        'What any of it implies about 2026: nothing here is carried forward, and the boundaries differ.',
        'Who each candidate is beyond the name the Commission printed: candidate identities are unresolved in this store.',
        ...(candidacySources.ids.length > 1
          ? ['Exactly when each name below was retrieved, where more than one source is listed: the dates above are the oldest of them, and every name names the source it was recorded by.']
          : []),
        summaryRow ? 'Nothing: the completeness figures below are the Commission’s own.' : 'How complete the count was: no result summary has been loaded for this contest.',
      ]}
    >
      <AvailabilityBlock
        availability={availability}
        loadingLabel="Loading 2023 candidacies"
        datasetName="evidence_public.candidacies"
        noneHeld="No 2023 candidacy has been recorded against this boundary version."
        onRetry={() => void candidacies.refetch()}
      >
        {(list) => (
          <>
            <CandidacyList rows={list} caption="Candidates in this electorate in 2023" sourceFor={candidacySources.sourceFor} />
            {summaryRow ? (
              <dl className="mt-4 grid gap-x-8 gap-y-3 border-t border-border pt-3 text-[13.5px] sm:grid-cols-2 lg:grid-cols-4" data-testid="result-summary">
                <div><dt className="eyebrow">Candidate votes incl. informal</dt><dd className="num mt-0.5">{formatCount(summaryRow.candidate_votes_with_informals)}</dd></div>
                <div><dt className="eyebrow">Informal candidate votes</dt><dd className="num mt-0.5">{formatCount(summaryRow.candidate_informals)}</dd></div>
                <div><dt className="eyebrow">Candidate lines on the return</dt><dd className="num mt-0.5">{formatCount(summaryRow.candidate_lines)}</dd></div>
                <div><dt className="eyebrow">Votes counted</dt><dd className="num mt-0.5">{summaryRow.votes_counted_pct === null ? 'unknown' : `${summaryRow.votes_counted_pct}%`}</dd></div>
              </dl>
            ) : null}
          </>
        )}
      </AvailabilityBlock>
    </FactCard>
  )
}

/**
 * Alphabetical by the name the source printed. Votes are shown as reported and never order the list.
 *
 * `sourceFor` answers which registered source ONE listed name was loaded from, resolved from that
 * row's own record version. A card's strip can only ever carry one set of dates, so each name also
 * states its own source, the way each parliamentary item does. A name whose source has not resolved
 * says that, rather than borrowing the card's.
 */
function CandidacyList({ rows, caption, sourceFor }: { rows: readonly CandidacyRow[]; caption: string; sourceFor: (row: CandidacyRow) => string | null }) {
  return (
    <>
      <p className="sr-only">{caption}. Listed alphabetically; the order carries no meaning.</p>
      <ul className="divide-y divide-border" data-testid="candidacy-list">
        {rows.map((c) => (
          <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5" data-testid="candidacy-row">
            <span className="min-w-0">
              <span className="font-medium"><EntityLink kind="person_identity" id={c.person_identity_id}>{c.candidate_name ?? NOT_SHOWN}</EntityLink></span>
              <span className="ml-2 text-[13px] text-muted-foreground"><EntityLink kind="party_identity" id={c.party_identity_id}>{c.party_label ?? NOT_SHOWN}</EntityLink></span>
              <span className="ml-2 text-[13px] text-muted-foreground" data-testid="candidacy-source">
                {sourceFor(c) ? <>recorded by <span className="font-mono text-[12px] text-foreground">{sourceFor(c)}</span></> : 'source not resolved here'}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2 text-[13px]">
              <CandidacyStatusBadge status={c.current_status} />
              <span className="num" data-testid="votes-cell">{formatVotes(c.votes, c.votes_status, c.candidacy_type)}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

// ---- Money --------------------------------------------------------------------------------------

function MoneyCard({ electorate: e, sources }: { electorate: ElectorateVersionRow; sources: readonly SourceLike[] }) {
  const donations = useDonationsAsPublished(e.name ?? undefined)
  const returns = useCandidateReturnLinkage()
  const availability = classifyNamed(e.name, donations)
  // The entries come from the disclosures read out of the returns, and a party return and a candidate
  // return are two different sources with two different dates. The strip names the ones actually shown.
  const shownSources = (donations.data ?? []).map((d) => disclosureSourceForKind(d.return_kind))
  const spansSources = new Set(shownSources).size > 1
  return (
    <FactCard
      testId="card-money"
      eyebrow="Political finance"
      title="Money disclosed against this electorate’s name"
      lede={
        <>
          <p>
            Two different things are kept apart here. A <strong>candidate’s return</strong> is money a candidate declared. A <strong>party’s return</strong>{' '}
            is money the party declared. {PARTY_NOT_CANDIDATE_RECEIPT_NOTE}
          </p>
          <p className="mt-1">
            Entries below appear only where the return prints this electorate’s name on its own face. That is the publisher’s text, not a link to the
            candidacies listed above.
          </p>
        </>
      }
      provenance={provenanceSpanning(sources, shownSources.length ? shownSources : [CANDIDATE_DISCLOSURES_SOURCE_ID], 'Electoral Commission')}
      unknowns={[
        'Which candidacy a filed return belongs to: this store records no link from a return to a candidacy.',
        'Which boundary edition the electorate name printed on a return refers to: a return prints a name, not an edition, and the same name can describe a different area in a different year.',
        ...(spansSources
          ? ['Exactly when each entry below was retrieved: candidate returns and party returns are two separate sources, and the dates above are the older of the two, never the newer.']
          : []),
        'Most donations: an entry is published only where the entries of its part add up exactly to the total the Commission’s own form prints, and many returns are scans that cannot be read at all.',
        'Donations the law withholds: an anonymous donation, or one protected from disclosure, keeps its amount and has no donor name here either.',
        'Donations over $20,000 published separately during an election year: this project does not collect them, and nothing here is added to them.',
      ]}
    >
      <AvailabilityBlock
        availability={availability}
        loadingLabel="Loading disclosed donations"
        datasetName="evidence_public.donation_disclosures"
        noneHeld={
          e.name
            ? `No filed return loaded here prints the electorate name “${e.name}” on its face.`
            : 'This electorate version carries no name in this store, and a return is matched here only by the name printed on its face. So no return was looked for.'
        }
        onRetry={() => void donations.refetch()}
      >
        {(rows) => <DonationList rows={rows} />}
      </AvailabilityBlock>

      {returns.settled ? (
        <p className="mt-4 border-t border-border pt-3 text-[13px] text-muted-foreground" data-testid="returns-not-linked">
          {formatCount(returns.total)} candidate returns are held as filed documents
          {returns.linked === 0
            ? ', and none of them records which candidacy it belongs to. So no return can be attributed to a candidate in this electorate from this store alone.'
            : `, of which ${formatCount(returns.linked)} record the candidacy they belong to.`}{' '}
          <Link to="/finance" className="doc-link">Browse the filed returns</Link> ·{' '}
          <Link to="/donations" className="doc-link" data-testid="money-to-donations">Browse every disclosed donation</Link>
        </p>
      ) : null}
    </FactCard>
  )
}

function DonationList({ rows }: { rows: readonly DonationDisclosureRow[] }) {
  return (
    <ul className="divide-y divide-border" data-testid="donation-list">
      {rows.map((d) => (
        <li key={`${d.official_url}#${d.disclosure_part}-${d.entry_index}`} className="py-2.5" data-testid="donation-row">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="font-medium">
              {d.donor_name_status === 'published' ? (
                d.donor_name_as_published
              ) : d.donor_name_status === 'withheld_by_publisher' ? (
                <Pill tone="muted">{d.donor_identity_kind === 'anonymous' ? 'Anonymous — no name is disclosed' : 'Protected from disclosure by law'}</Pill>
              ) : (
                <Pill tone="caution">Named in the return; the name could not be separated from the other text printed in the same cell</Pill>
              )}
            </span>
            <span className="num">{formatMoney(d.disclosed_amount_nzd, 'reported')}</span>
          </div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            <Banknote aria-hidden="true" className="mr-1 inline size-3" />
            {d.return_kind === 'candidate_election_return' ? 'Candidate return' : 'Party return'} {d.reporting_year} ·{' '}
            {d.candidate_name_as_published ?? d.party_name_as_published ?? 'recipient not printed'} · Part {d.disclosure_part}: {d.part_label_as_published} ·{' '}
            {humanise(d.disclosure_kind).toLowerCase()}
            {d.amendment_labelled ? ' · amended return' : ''}
            {d.overlaps_election_year_notices ? ' · overlaps the separately published election-year notices' : ''} ·{' '}
            <ExternalLink href={d.official_url}>open the return</ExternalLink>
          </p>
        </li>
      ))}
    </ul>
  )
}
