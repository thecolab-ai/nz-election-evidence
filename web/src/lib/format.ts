/**
 * Display formatters. The rule throughout: unknown is not zero. A missing, suppressed or
 * unreported value is always rendered as words, never as 0 and never as an empty cell.
 */

export const NOT_STATED = 'not stated by source'
export const NOT_ESTABLISHED = 'not established'
export const UNKNOWN = 'unknown'
export const EM_DASH = '—'

const NZ_DATE_TIME = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZoneName: 'short',
})

const NZ_DATE = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

const NZ_PLAIN_DATE = new Intl.DateTimeFormat('en-NZ', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Timestamp in New Zealand time. `fallback` is what to say when there is no value. */
export function formatDateTime(value: string | null | undefined, fallback: string = EM_DASH): string {
  const d = toDate(value)
  return d ? NZ_DATE_TIME.format(d) : fallback
}

export function formatDate(value: string | null | undefined, fallback: string = EM_DASH): string {
  const d = toDate(value)
  return d ? NZ_DATE.format(d) : fallback
}

/** A calendar date column (no time zone shift). */
export function formatPlainDate(value: string | null | undefined, fallback: string = EM_DASH): string {
  if (!value) return fallback
  const d = toDate(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value)
  return d ? NZ_PLAIN_DATE.format(d) : fallback
}

/** Publisher date: the timestamp if parsed, else the publisher's own date text, else "not stated by source". */
export function formatPublisherDate(publishedAt: string | null | undefined, dateText?: string | null): string {
  const d = toDate(publishedAt)
  if (d) return NZ_DATE.format(d)
  const text = dateText?.trim()
  if (text) return `${text} (as written by source)`
  return NOT_STATED
}

export function formatServiceDate(value: string | null | undefined): string {
  return value ? formatPlainDate(value) : NOT_ESTABLISHED
}

export function formatCount(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return UNKNOWN
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n.toLocaleString('en-NZ') : UNKNOWN
}

export type VotesStatus = 'reported' | 'not_reported' | 'suppressed'

/**
 * Candidate votes. Only a `reported` status with a number shows a number. Everything else is
 * text, including a stray 0 paired with a non-reported status.
 */
export function formatVotes(
  votes: number | string | null | undefined,
  status: string | null | undefined,
  candidacyType?: string | null,
): string {
  if (status === 'reported' && votes !== null && votes !== undefined && votes !== '') return formatCount(votes)
  if (status === 'not_reported') return 'not reported'
  if (status === 'suppressed') return 'suppressed'
  if (status === 'reported') return 'reported, value unavailable'
  if (candidacyType === 'list') return 'not applicable (list candidacy)'
  return 'no result loaded'
}

const STAT_STATUS_TEXT: Record<string, string> = {
  suppressed: 'suppressed',
  confidential: 'confidential',
  missing: 'missing',
  not_applicable: 'not applicable',
}

/** Statistical observation: suppressed, confidential and missing values are words, never 0. */
export function formatStatValue(
  value: number | string | null | undefined,
  valueDouble: number | null | undefined,
  status: string | null | undefined,
): string {
  const statusKey = status ?? ''
  if (statusKey in STAT_STATUS_TEXT) return STAT_STATUS_TEXT[statusKey] as string
  const raw = value ?? valueDouble
  if (raw === null || raw === undefined || raw === '') return 'value unavailable'
  const n = typeof raw === 'number' ? raw : Number(raw)
  const text = Number.isFinite(n) ? n.toLocaleString('en-NZ', { maximumFractionDigits: 6 }) : String(raw)
  return statusKey === 'provisional' ? `${text} (provisional)` : text
}

export function formatMoney(value: number | string | null | undefined, status: string | null | undefined): string {
  if (status !== 'reported' || value === null || value === undefined || value === '') {
    return status === 'not_extracted' ? 'not extracted' : UNKNOWN
  }
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' }) : UNKNOWN
}

export function formatCadence(seconds: number | null | undefined): string {
  if (!seconds) return 'no expected cadence set'
  if (seconds % 86_400 === 0) return `every ${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`
  if (seconds % 3_600 === 0) return `every ${seconds / 3_600} hour${seconds === 3_600 ? '' : 's'}`
  if (seconds % 60 === 0) return `every ${seconds / 60} minutes`
  return `every ${seconds} seconds`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return UNKNOWN
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return EM_DASH
  const [algo, digest] = hash.includes(':') ? (hash.split(':', 2) as [string, string]) : ['', hash]
  const short = digest.length > 16 ? `${digest.slice(0, 12)}…` : digest
  return algo ? `${algo}:${short}` : short
}

export function humanise(value: string | null | undefined, fallback: string = UNKNOWN): string {
  if (!value) return fallback
  const text = value.replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// ---- Labels with compliance meaning -------------------------------------------------------

export const SCOPE_ORDER = ['primary_2026', 'baseline_2023', 'finance_2025', 'current_parliament', 'statistics', 'general'] as const
export type ViewScope = (typeof SCOPE_ORDER)[number]

export const SCOPE_LABELS: Record<ViewScope, string> = {
  primary_2026: '2026 election (primary view)',
  baseline_2023: '2023 baseline',
  finance_2025: '2025 finance returns',
  current_parliament: 'Current Parliament',
  statistics: 'Statistics',
  general: 'General',
}

export function scopeLabel(scope: string | null | undefined): string {
  return scope && scope in SCOPE_LABELS ? SCOPE_LABELS[scope as ViewScope] : humanise(scope)
}

export const CANDIDACY_STATUSES = ['announced', 'officially_nominated', 'withdrawn', 'elected', 'not_elected', 'unknown'] as const

export const CANDIDACY_STATUS_LABELS: Record<string, string> = {
  announced: 'Announced (not officially nominated)',
  officially_nominated: 'Officially nominated',
  withdrawn: 'Withdrawn',
  elected: 'Elected',
  not_elected: 'Not elected',
  unknown: 'Status unknown',
}

export function candidacyStatusLabel(status: string | null | undefined): string {
  return (status && CANDIDACY_STATUS_LABELS[status]) || 'Status unknown'
}

export const FRESHNESS_STATUSES = ['fresh', 'stale', 'partial', 'unavailable', 'reachable_not_parsed', 'never_run'] as const
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number]

export const FRESHNESS_LABELS: Record<FreshnessStatus, string> = {
  fresh: 'Fresh',
  stale: 'Stale',
  partial: 'Partial',
  unavailable: 'Unavailable',
  reachable_not_parsed: 'Reachable — nothing imported; no count implied',
  never_run: 'Never run',
}

export const UNAVAILABLE_EXPLANATION =
  'The publisher endpoint was unavailable or refused the request. This does not mean no records exist.'

export const REACHABLE_NOT_PARSED_EXPLANATION =
  'The publisher page answered, but no parser is enabled for it, so nothing was imported. No record count is implied — not zero, and not any other number.'

export const FRESHNESS_EXPLANATIONS: Record<FreshnessStatus, string> = {
  fresh: 'The last attempt succeeded within twice the expected cadence.',
  stale: 'The last successful retrieval is older than twice the expected cadence. Records shown may be out of date.',
  partial: 'The last attempt retrieved only part of the source. Absence of a record is not evidence that it was removed.',
  unavailable: UNAVAILABLE_EXPLANATION,
  reachable_not_parsed: REACHABLE_NOT_PARSED_EXPLANATION,
  never_run: 'No retrieval has been attempted for this source. Nothing is known about its contents.',
}

export function isFreshnessStatus(value: string | null | undefined): value is FreshnessStatus {
  return !!value && (FRESHNESS_STATUSES as readonly string[]).includes(value)
}

export interface ModelProvenance {
  model: string
  version: string
  prompt: string
  humanReviewNote: string | null
}

const UNKNOWN_HISTORICAL = 'unknown (historical)'
export const NOT_HUMAN_REVIEWED = 'not yet checked against human review'

/** R9: every model output shows its model, version and prompt (or says they are unknown), and a review flag. */
export function modelProvenance(row: {
  model_metadata_status?: string | null
  model_name?: string | null
  model_version?: string | null
  prompt_or_schema_version?: string | null
  review_status?: string | null
}): ModelProvenance {
  const historical = row.model_metadata_status === 'historical_unknown'
  const pick = (v: string | null | undefined) => (!historical && v && v.trim() ? v : UNKNOWN_HISTORICAL)
  return {
    model: pick(row.model_name),
    version: pick(row.model_version),
    prompt: pick(row.prompt_or_schema_version),
    humanReviewNote: row.review_status === 'approved' ? null : NOT_HUMAN_REVIEWED,
  }
}
