/**
 * The electorate journey's pure logic: how a reader finds an electorate, and how this application
 * decides what it is allowed to say once it has one.
 *
 * Two rules run through everything here.
 *
 * 1. FOLDING IS FOR SEARCHING, NEVER FOR JOINING. `foldForSearch` exists so that someone typing
 *    "otaki" on a phone keyboard finds Ōtaki. It is applied to the reader's own query against a
 *    list already fetched from one view. It is never used to decide that a row from one publisher
 *    describes the same thing as a row from another: that is an identity decision, and this store
 *    records identity decisions as reviewed evidence, not as string equality.
 *
 * 2. AN ANSWER THAT DID NOT ARRIVE IS NOT AN ANSWER OF ZERO. `classify` separates the four ways a
 *    panel can have nothing to show — the dataset is not loaded on this deployment, the deployment
 *    could not answer in time, the request failed, or the query succeeded and the store genuinely
 *    holds no row — because a reader who is told "none" deserves to know which of those it was.
 */

import type { DataError } from './queries'

// ---- Finding an electorate -----------------------------------------------------------------

/**
 * Case- and diacritic-insensitive form of a name, for matching what a reader TYPED against a list
 * this application already holds. Macrons matter to the name and are always displayed; they must
 * not be required to find it. Never use this to link two publishers' records — see the file note.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export interface ElectorateChoice {
  id: string
  slug: string | null
  name: string | null
}

/**
 * Electorates whose name matches the query, names that START with it first, then the rest,
 * each group alphabetical. A blank query returns the whole list unchanged: the reader is
 * offered every electorate, not a guess about which one is theirs.
 */
export function matchElectorates<T extends ElectorateChoice>(electorates: readonly T[], query: string): T[] {
  const needle = foldForSearch(query)
  if (!needle) return [...electorates]
  const starts: T[] = []
  const contains: T[] = []
  for (const e of electorates) {
    const hay = foldForSearch(e.name ?? '')
    if (!hay) continue
    if (hay.startsWith(needle)) starts.push(e)
    else if (hay.includes(needle)) contains.push(e)
  }
  return [...starts, ...contains]
}

/**
 * The electorate a shared address is asking for, when the address does not match a slug exactly.
 * Fourteen of the loaded slugs carry a macron, and a link passed through a client that strips them
 * would otherwise lead nowhere. Only a UNIQUE fold match resolves: if two electorates fold to the
 * same key the address is genuinely ambiguous and the page says it found nothing rather than pick.
 */
export function resolveSlug<T extends { id: string; slug: string | null }>(electorates: readonly T[], wanted: string): T | null {
  const key = foldForSearch(wanted)
  if (!key) return null
  const matches = electorates.filter((e) => foldForSearch(e.slug ?? '') === key)
  return matches.length === 1 ? (matches[0] as T) : null
}

/** Moves the highlighted option, clamped to the list. Returns -1 when there is nothing to highlight. */
export function moveActiveIndex(current: number, count: number, key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): number {
  if (count <= 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowDown') return current >= count - 1 ? 0 : current + 1
  return current <= 0 ? count - 1 : current - 1
}

// ---- What this application is allowed to say -------------------------------------------------

/** PostgREST: the relation is not in the schema cache, or Postgres: the relation does not exist. */
const MISSING_RELATION_CODES = new Set(['PGRST205', 'PGRST202', '42P01'])
/** Postgres: the statement was cancelled because it ran past this deployment's timeout. */
const TIMEOUT_CODES = new Set(['57014'])

export function isMissingDataset(error: Pick<DataError, 'code'> | null | undefined): boolean {
  return !!error?.code && MISSING_RELATION_CODES.has(error.code)
}

export function isDeploymentTooSlow(error: Pick<DataError, 'code'> | null | undefined): boolean {
  return !!error?.code && TIMEOUT_CODES.has(error.code)
}

export type Availability<Row> =
  | { state: 'loading' }
  | { state: 'ready'; rows: Row[] }
  /** The query succeeded and the store holds no row for it. Unknown, not zero. */
  | { state: 'none_held' }
  /** The dataset this panel reads is not present on the deployment being read. */
  | { state: 'not_loaded'; error: DataError }
  /** The deployment gave up on the query before answering it. */
  | { state: 'not_answerable'; error: DataError }
  | { state: 'failed'; error: DataError }

export interface QueryLike<Row> {
  isPending: boolean
  isError: boolean
  error: DataError | null
  data: Row[] | undefined
}

/** One place that decides which honest state a panel is in, so no panel can invent a different one. */
export function classify<Row>(query: QueryLike<Row>): Availability<Row> {
  if (query.isError && query.error) {
    if (isMissingDataset(query.error)) return { state: 'not_loaded', error: query.error }
    if (isDeploymentTooSlow(query.error)) return { state: 'not_answerable', error: query.error }
    return { state: 'failed', error: query.error }
  }
  if (query.isPending) return { state: 'loading' }
  const rows = query.data ?? []
  return rows.length === 0 ? { state: 'none_held' } : { state: 'ready', rows }
}

/**
 * A panel whose only filter is a name, when the store records no name for this electorate version.
 * The query cannot even be asked, so it is never sent: the panel reports that it holds nothing rather
 * than waiting for a request that will never be made. The sentence the card shows says which it is.
 */
export function classifyNamed<Row>(name: string | null | undefined, query: QueryLike<Row>): Availability<Row> {
  return name ? classify(query) : { state: 'none_held' }
}

// ---- Sentences this product must never get wrong ---------------------------------------------

/**
 * Why a member's record is shown beside an electorate, said plainly. Parliament writes the
 * electorate it represents as text; this store has an `electorate_version_id` column for the
 * reviewed link and it is empty on every member term loaded. So the correspondence below is
 * between two strings, and the page says so rather than presenting it as a verified link.
 */
export const REPRESENTATION_MATCH_NOTE =
  'Shown because Parliament’s own record writes this electorate’s name. That is a correspondence between two pieces of text, not a reviewed link: the member records loaded here carry no link to the boundary version above, and the same name can belong to different boundaries in different years.'

export const NOT_A_CANDIDATE_NOTE =
  'A sitting member is not a candidate. Nothing on this page says that any member listed here is standing, or is not standing, in 2026.'

export const ACTIVITY_NOT_EFFECTIVENESS_NOTE =
  'Parliamentary activity is a record of what was lodged, introduced or reported, with the date and the link. It is not a measure of effectiveness, influence or how anyone voted, and it is never counted up into a score.'

export const PARTY_NOT_CANDIDATE_RECEIPT_NOTE =
  'A party’s return is the party’s money. It is not a receipt by any candidate in this electorate, and this page never presents it as one.'

export const BOUNDARY_NOT_COMPARABLE_NOTE =
  'Boundaries are reviewed between elections. An electorate with the same name in two boundary editions is not the same area, so a 2023 figure and a 2026 figure for one name cannot be compared or carried across.'

export const NO_ADDRESS_NOTE =
  'This page never asks for, stores or sends an address or a location. To find which electorate an address is in, use the Electoral Commission’s own tool.'

// ---- Provenance ------------------------------------------------------------------------------

export interface Provenance {
  /** The organisation that published the material. */
  publisher: string
  /** The publisher's own page or file. */
  officialUrl: string | null
  /** The date the publisher put on it, when it states one. */
  sourceDate: string | null
  /** Free text the publisher wrote as its date, when it did not state a machine-readable one. */
  sourceDateText?: string | null
  /** When this project retrieved it. Different from the date above, and never shown as if it were. */
  retrievedAt: string | null
  /** The registry key of the source, for the reader who wants the ingest record. */
  sourceId?: string | null
}

export type SourceLike = { source_id: string | null; publisher: string | null; official_url: string | null; last_success_at: string | null; latest_source_published_at: string | null }

/** Provenance for a panel backed by one registered source, taken from the store's own sources view. */
export function provenanceForSource(sources: readonly SourceLike[], sourceId: string, fallbackPublisher: string): Provenance {
  const row = sources.find((s) => s.source_id === sourceId)
  return {
    publisher: row?.publisher ?? fallbackPublisher,
    officialUrl: row?.official_url ?? null,
    sourceDate: row?.latest_source_published_at ?? null,
    retrievedAt: row?.last_success_at ?? null,
    sourceId,
  }
}

/** The earliest of the dates given, ignoring the ones that are not stated. Null when none is stated. */
function earliest(values: ReadonlyArray<string | null | undefined>): string | null {
  const stated = values.filter((v): v is string => !!v).sort()
  return stated[0] ?? null
}

/**
 * Provenance for a panel that shows rows from MORE THAN ONE registered source — disclosures read from
 * two kinds of return, activity taken from several parliamentary exports.
 *
 * A single strip cannot carry several dates, so it carries the EARLIEST of them: the oldest publisher
 * date and the oldest retrieval behind anything on the card. That is a lower bound, never a claim that
 * the whole card is as fresh as its freshest part, and it is the one direction a reader is not misled
 * by. There is no single "original" for several sources, so the link is dropped and each row keeps its
 * own. A card doing this must say so in its `unknowns`.
 */
export function provenanceSpanning(sources: readonly SourceLike[], sourceIds: readonly string[], fallbackPublisher: string): Provenance {
  const ids = [...new Set(sourceIds.filter((id): id is string => !!id))].sort()
  if (ids.length <= 1) return provenanceForSource(sources, ids[0] ?? '', fallbackPublisher)
  const rows = ids.map((id) => sources.find((s) => s.source_id === id)).filter((r): r is SourceLike => !!r)
  const publishers = [...new Set(rows.map((r) => r.publisher).filter((p): p is string => !!p))]
  return {
    publisher: publishers.length === 1 ? (publishers[0] as string) : publishers.length === 0 ? fallbackPublisher : `${publishers.length} publishers, each named on its own entry`,
    officialUrl: null,
    sourceDate: earliest(rows.map((r) => r.latest_source_published_at)),
    retrievedAt: earliest(rows.map((r) => r.last_success_at)),
    sourceId: ids.join(' + '),
  }
}
