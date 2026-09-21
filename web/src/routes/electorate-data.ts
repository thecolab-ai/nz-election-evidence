/**
 * The reads behind the electorate journey. Every one of them is a select against a view that
 * already exists for anonymous readers; nothing here invents a relationship the store does not
 * record, and where two reads have to be put side by side the page says on what basis.
 */
import type { DataError } from '@/lib/queries'
import { useCountQuery, useRowsQuery } from '@/lib/queries'
import type { CandidacyRow, DocumentRow, ElectionRow, ElectorateVersionRow, ServiceTermRow, SourceRow } from '@/lib/types'
import { resolveSlug, type SourceLike } from '@/lib/electorate'

/** Registry keys of the sources these panels read. They are the store's own identifiers, not labels. */
export const ELECTORATE_SOURCE_ID = 'election_2023_electorate_results_export'
export const CANDIDACY_SOURCE_ID = 'baseline_2023_candidacies_export'
export const MEMBER_TERMS_SOURCE_ID = 'parliament_export_member_terms'
export const OFFICIAL_PAGE_SOURCE_ID = 'election_2026_official_page_status_export'
export const BOUNDARY_MAPS_SOURCE_ID = 'election_2026_boundary_map_links_export'
export const POLICY_SOURCE_ID = 'party_policy_pages_2026_export'
export const CANDIDATE_RETURNS_SOURCE_ID = 'finance_2023_candidate_returns_export'
export const PARTY_RETURNS_SOURCE_ID = 'finance_2025_party_returns_export'

const SOURCE_COLUMNS = 'source_id,title,publisher,official_url,last_success_at,latest_source_published_at,freshness_status,view_scope'

export type ProvenanceSource = Pick<SourceRow, 'source_id' | 'title' | 'publisher' | 'official_url' | 'last_success_at' | 'latest_source_published_at' | 'freshness_status' | 'view_scope'>

/** One read of the rights-filtered sources view; every card on the page takes its provenance from it. */
export function useElectorateSources() {
  return useRowsQuery<ProvenanceSource & SourceLike>({ view: 'sources', select: SOURCE_COLUMNS, key: ['journey-sources'], limit: 200 })
}

export interface OfficialPageStatusRow {
  official_url: string
  page_status: string
  candidate_details_available: string
  first_retrieved_at: string | null
}

/** What happened the last time this project asked the Commission's own 2026 electorate page for itself. */
export function useOfficialPageStatus() {
  return useRowsQuery<OfficialPageStatusRow>({
    view: { open: 'election_official_page_status' },
    select: 'official_url,page_status,candidate_details_available,first_retrieved_at',
    key: ['official-page-status'],
    limit: 5,
  })
}

export interface BoundaryMapRow {
  document_id: string
  boundary_type_at_source: string | null
  boundary_scope: string | null
}

export function useBoundaryMapLinks() {
  return useRowsQuery<BoundaryMapRow>({
    view: { open: 'boundary_map_links' },
    select: 'document_id,boundary_type_at_source,boundary_scope',
    key: ['boundary-map-links'],
    limit: 20,
  })
}

type DocumentRef = Pick<DocumentRow, 'id' | 'title' | 'official_url' | 'source_published_at' | 'first_retrieved_at' | 'source_id'>

/** Documents by id. Only ever called with a bounded list of ids this page already holds. */
function useDocumentsByIds(ids: readonly string[]) {
  return useRowsQuery<DocumentRef>({
    view: 'documents',
    select: 'id,title,official_url,source_published_at,first_retrieved_at,source_id',
    key: ['documents-by-id', [...ids].sort().join(',')],
    limit: 100,
    enabled: ids.length > 0,
    build: (q) => q.in('id', [...ids]),
  })
}

/** The shape `classify` reads. Composed hooks report the first real problem of their parts. */
export interface ComposedQuery<Row> {
  isPending: boolean
  isError: boolean
  error: DataError | null
  data: Row[] | undefined
  refetch: () => void
}

function compose<Row>(parts: ReadonlyArray<{ isPending: boolean; isError: boolean; error: DataError | null; refetch: () => unknown }>, rows: Row[] | undefined): ComposedQuery<Row> {
  const failed = parts.find((p) => p.isError)
  return {
    isPending: !failed && parts.some((p) => p.isPending),
    isError: !!failed,
    error: failed?.error ?? null,
    data: rows,
    refetch: () => parts.forEach((p) => void p.refetch()),
  }
}

export interface PartyPolicyPage {
  documentId: string
  partyName: string | null
  officialUrl: string
  sourcePublishedAt: string | null
  firstRetrievedAt: string | null
}

interface PolicyClassificationRef {
  document_id: string
  official_url: string
  party_identity_id: string | null
  policy_class: string | null
  classification_basis: string | null
}

/**
 * The party policy pages published for 2026: the classification row (which carries the party identity
 * and the official link), the party's own label from the identity it belongs to, and the document's
 * publisher and retrieval dates. Every hop is an id recorded in this store, not a name comparison.
 */
export function usePartyPolicyPages(): ComposedQuery<PartyPolicyPage> {
  const classifications = useRowsQuery<PolicyClassificationRef>({
    view: 'policy_classifications',
    select: 'document_id,official_url,party_identity_id,policy_class,classification_basis',
    key: ['policy-pages'],
    limit: 100,
  })
  const rows = classifications.data ?? []
  const partyIds = rows.map((r) => r.party_identity_id).filter((id): id is string => !!id)
  const parties = useRowsQuery<{ id: string; name_at_source: string | null }>({
    view: 'party_identities',
    select: 'id,name_at_source',
    key: ['policy-parties', [...partyIds].sort().join(',')],
    limit: 100,
    enabled: partyIds.length > 0,
    build: (q) => q.in('id', partyIds),
  })
  const documents = useDocumentsByIds(rows.map((r) => r.document_id))

  const nameById = new Map((parties.data ?? []).map((p) => [p.id, p.name_at_source]))
  const documentById = new Map((documents.data ?? []).map((d) => [d.id, d]))
  const settled = classifications.isSuccess && (partyIds.length === 0 || parties.isSuccess) && (rows.length === 0 || documents.isSuccess)
  const pages: PartyPolicyPage[] | undefined = settled
    ? rows
        .map((r) => ({
          documentId: r.document_id,
          partyName: r.party_identity_id ? (nameById.get(r.party_identity_id) ?? null) : null,
          officialUrl: r.official_url,
          sourcePublishedAt: documentById.get(r.document_id)?.source_published_at ?? null,
          firstRetrievedAt: documentById.get(r.document_id)?.first_retrieved_at ?? null,
        }))
        .sort((a, b) => (a.partyName ?? '').localeCompare(b.partyName ?? '', 'en-NZ'))
    : undefined
  return compose([classifications, parties, documents], pages)
}

export interface BoundaryMap {
  documentId: string
  boundaryType: string | null
  scope: string | null
  title: string | null
  officialUrl: string | null
  firstRetrievedAt: string | null
}

/** The Commission's final 2026 boundary maps, as published files. */
export function useBoundaryMaps(): ComposedQuery<BoundaryMap> {
  const links = useBoundaryMapLinks()
  const rows = links.data ?? []
  const documents = useDocumentsByIds(rows.map((r) => r.document_id))
  const byId = new Map((documents.data ?? []).map((d) => [d.id, d]))
  const settled = links.isSuccess && (rows.length === 0 || documents.isSuccess)
  const maps: BoundaryMap[] | undefined = settled
    ? rows
        .map((r) => ({
          documentId: r.document_id,
          boundaryType: r.boundary_type_at_source,
          scope: r.boundary_scope,
          title: byId.get(r.document_id)?.title ?? null,
          officialUrl: byId.get(r.document_id)?.official_url ?? null,
          firstRetrievedAt: byId.get(r.document_id)?.first_retrieved_at ?? null,
        }))
        .sort((a, b) => (a.scope ?? '').localeCompare(b.scope ?? '', 'en-NZ'))
    : undefined
  return compose([links, documents], maps)
}

// ---- Per-electorate reads ---------------------------------------------------------------------

/**
 * One electorate version by the slug in the address.
 *
 * Fourteen of the loaded slugs carry a macron, so a link shared through a client that strips them
 * would otherwise 404. When the exact slug matches nothing, the loaded slugs are folded the same
 * way the picker folds what a reader types, and a unique fold match resolves. This compares this
 * store's own slugs with the address bar; it never decides that two publishers mean the same thing.
 */
export function useElectorateBySlug(slug: string): { row: ElectorateVersionRow | null; isPending: boolean; isError: boolean; error: DataError | null; refetch: () => void } {
  const exact = useRowsQuery<ElectorateVersionRow>({
    view: 'electorates',
    select: '*',
    key: ['electorate-by-slug', slug],
    limit: 1,
    build: (q) => q.eq('slug', slug),
  })
  const exactMissed = exact.isSuccess && exact.data.length === 0
  const folded = useRowsQuery<Pick<ElectorateVersionRow, 'id' | 'slug' | 'name'>>({
    view: 'electorates',
    select: 'id,slug,name',
    key: ['electorate-slugs'],
    limit: 200,
    enabled: exactMissed,
  })
  const resolvedId = resolveSlug(folded.data ?? [], slug)?.id
  const full = useRowsQuery<ElectorateVersionRow>({
    view: 'electorates',
    select: '*',
    key: ['electorate-by-id', resolvedId ?? ''],
    limit: 1,
    enabled: !!resolvedId,
    build: (q) => q.eq('id', resolvedId ?? ''),
  })

  // Every hook above runs on every render; only the reading of their results branches.
  const refetchAll = () => {
    void exact.refetch()
    if (exactMissed) void folded.refetch()
    if (resolvedId) void full.refetch()
  }
  if (exact.isError) return { row: null, isPending: false, isError: true, error: exact.error, refetch: refetchAll }
  if (exact.data?.[0]) return { row: exact.data[0], isPending: false, isError: false, error: null, refetch: refetchAll }
  if (!exactMissed) return { row: null, isPending: true, isError: false, error: null, refetch: refetchAll }
  if (folded.isError) return { row: null, isPending: false, isError: true, error: folded.error, refetch: refetchAll }
  if (!folded.isSuccess) return { row: null, isPending: true, isError: false, error: null, refetch: refetchAll }
  if (!resolvedId) return { row: null, isPending: false, isError: false, error: null, refetch: refetchAll }
  if (full.isError) return { row: null, isPending: false, isError: true, error: full.error, refetch: refetchAll }
  return { row: full.data?.[0] ?? null, isPending: full.isPending, isError: false, error: null, refetch: refetchAll }
}

/**
 * Candidacies recorded against THIS boundary version, for one election. The filter is the
 * `electorate_version_id` foreign key the store records, not the electorate's name.
 */
export function useCandidacies(electorateVersionId: string | undefined, electionSlug: string) {
  return useRowsQuery<CandidacyRow>({
    view: 'candidacies',
    select: '*',
    key: ['electorate-candidacies', electorateVersionId ?? '', electionSlug],
    limit: 100,
    enabled: !!electorateVersionId,
    build: (q) => q.eq('electorate_version_id', electorateVersionId ?? '').eq('election_slug', electionSlug).order('candidate_name'),
  })
}

export interface ResultSummaryRow {
  contest_id: string
  candidate_votes_with_informals: number | null
  candidate_informals: number | null
  candidate_lines: number | null
  party_votes_with_informals: number | null
  party_informals: number | null
  votes_counted: number | null
  votes_counted_pct: number | null
}

/** The Commission's own completeness figures for one contest, keyed by the contest id on the candidacy. */
export function useResultSummary(contestId: string | undefined) {
  return useRowsQuery<ResultSummaryRow>({
    view: { open: 'electorate_result_summaries' },
    select: 'contest_id,candidate_votes_with_informals,candidate_informals,candidate_lines,party_votes_with_informals,party_informals,votes_counted,votes_counted_pct',
    key: ['result-summary', contestId ?? ''],
    limit: 5,
    enabled: !!contestId,
    build: (q) => q.eq('contest_id', contestId ?? ''),
  })
}

/**
 * Member terms whose publisher wrote THIS electorate's name. This is a text correspondence and the
 * page says so: `electorate_version_id` is the column that would carry a reviewed link, and it is
 * empty on the member terms loaded here.
 */
export function useRepresentation(electorateName: string | undefined) {
  return useRowsQuery<ServiceTermRow>({
    view: 'service_terms',
    select: '*',
    key: ['representation', electorateName ?? ''],
    limit: 50,
    enabled: !!electorateName,
    build: (q) => q.eq('electorate_name_at_source', electorateName ?? '').order('member_name').order('source_id'),
  })
}

/**
 * Donations disclosed inside filed returns that name THIS electorate on the face of the return.
 * The column is the return's own printed text; no donation is attributed to a candidacy here.
 */
export function useDonationsAsPublished(electorateName: string | undefined) {
  return useRowsQuery<import('@/lib/types').DonationDisclosureRow>({
    view: 'donation_disclosures',
    select: '*',
    key: ['donations-electorate', electorateName ?? ''],
    limit: 100,
    enabled: !!electorateName,
    build: (q) => q.eq('electorate_as_published', electorateName ?? '').order('reporting_year', { ascending: false }).order('entry_index'),
  })
}

interface BillRef {
  document_id: string
  bill_number: string | null
  bill_type: string | null
  current_stage: string | null
  member_identity_id: string | null
  member_name_at_source: string | null
  introduced_at: string | null
  last_activity_at: string | null
}

interface WrittenQuestionRef {
  document_id: string
  question_number: string | null
  portfolio: string | null
  lodged_on: string | null
  answered_on: string | null
  answer_status: string | null
  asked_by_identity_id: string | null
  asker_name_at_source: string | null
}

export interface ActivityItem {
  documentId: string
  kind: 'bill' | 'written_question'
  headline: string
  detail: string | null
  /** The date the publisher puts on the act itself — lodged, introduced, or last moved. */
  occurredAt: string | null
  occurredLabel: string
  memberNameAtSource: string | null
  officialUrl: string | null
  title: string | null
}

/**
 * Dated parliamentary activity attributable to the given member identities.
 *
 * This is the ONLY link this page will accept between a member and a piece of activity: the
 * identity id the store records on the bill or the question. Matching a member's name against the
 * name printed on a question would join two publishers' text, and those texts are not even written
 * the same way ("Watts, Hon Simon" against "Hon Rachel Brooking" against "Tim Costley"), so a name
 * match here would be a guess dressed as a record. When the identity columns are empty the panel
 * reports that it found nothing rather than falling back to the name.
 */
export function useMemberActivity(personIdentityIds: readonly string[]): ComposedQuery<ActivityItem> {
  const ids = [...new Set(personIdentityIds)].sort()
  const key = ids.join(',')
  const bills = useRowsQuery<BillRef>({
    view: { open: 'bills' },
    select: 'document_id,bill_number,bill_type,current_stage,member_identity_id,member_name_at_source,introduced_at,last_activity_at',
    key: ['activity-bills', key],
    limit: 25,
    enabled: ids.length > 0,
    build: (q) => q.in('member_identity_id', ids),
  })
  const questions = useRowsQuery<WrittenQuestionRef>({
    view: { open: 'written_questions' },
    select: 'document_id,question_number,portfolio,lodged_on,answered_on,answer_status,asked_by_identity_id,asker_name_at_source',
    key: ['activity-questions', key],
    limit: 25,
    enabled: ids.length > 0,
    build: (q) => q.in('asked_by_identity_id', ids),
  })
  const documentIds = [...(bills.data ?? []).map((b) => b.document_id), ...(questions.data ?? []).map((w) => w.document_id)]
  const documents = useDocumentsByIds(documentIds)
  const byId = new Map((documents.data ?? []).map((d) => [d.id, d]))

  const settled = ids.length === 0 || (bills.isSuccess && questions.isSuccess && (documentIds.length === 0 || documents.isSuccess))
  const items: ActivityItem[] | undefined = settled
    ? [
        ...(bills.data ?? []).map((b): ActivityItem => ({
          documentId: b.document_id,
          kind: 'bill',
          headline: b.bill_number ? `Bill ${b.bill_number}` : 'Bill',
          detail: [b.bill_type, b.current_stage].filter(Boolean).join(' · ') || null,
          occurredAt: b.introduced_at ?? b.last_activity_at,
          occurredLabel: b.introduced_at ? 'Introduced' : 'Last recorded activity',
          memberNameAtSource: b.member_name_at_source,
          officialUrl: byId.get(b.document_id)?.official_url ?? null,
          title: byId.get(b.document_id)?.title ?? null,
        })),
        ...(questions.data ?? []).map((w): ActivityItem => ({
          documentId: w.document_id,
          kind: 'written_question',
          headline: w.question_number ? `Written question ${w.question_number}` : 'Written question',
          detail: [w.portfolio, w.answer_status].filter(Boolean).join(' · ') || null,
          occurredAt: w.lodged_on ?? w.answered_on,
          occurredLabel: w.lodged_on ? 'Lodged' : 'Answered',
          memberNameAtSource: w.asker_name_at_source,
          officialUrl: byId.get(w.document_id)?.official_url ?? null,
          title: byId.get(w.document_id)?.title ?? null,
        })),
      ].sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? ''))
    : undefined
  return compose([bills, questions, documents], items)
}

/**
 * How many filed candidate returns there are, and how many of them record WHICH candidacy they
 * belong to. Two server-side counts, no rows: the page uses this only to say honestly that a
 * return cannot be attributed to a candidate here, never to attribute one.
 */
export function useCandidateReturnLinkage(): { total: number | null; linked: number | null; settled: boolean } {
  const total = useCountQuery({ view: 'finance_returns', key: ['candidate-returns', 'total'], build: (q) => q.eq('return_type', 'candidate_return') })
  const linked = useCountQuery({ view: 'finance_returns', key: ['candidate-returns', 'linked'], build: (q) => q.eq('return_type', 'candidate_return').not('candidacy_id', 'is', null) })
  return { total: total.data ?? null, linked: linked.data ?? null, settled: total.isSuccess && linked.isSuccess }
}

export function useElections() {
  return useRowsQuery<ElectionRow>({ view: 'elections', select: '*', key: ['journey-elections'], limit: 10, build: (q) => q.order('election_date', { ascending: false, nullsFirst: false }) })
}
