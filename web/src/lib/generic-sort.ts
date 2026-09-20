/**
 * R1 in the generic dataset browser. The curated lists never offer a vote count as a sort key; this keeps the
 * browse-any-dataset page to the same rule, for every dataset present and future, by default deny:
 *
 *   - only identifier, text, date/time and boolean columns can be sort keys (every numeric, array, json, range,
 *     domain or unknown type is refused), and
 *   - nor is any column whose NAME says it is a tally, share, seat count, rank, total or model confidence,
 *     whatever its type (a figure stored as text is still a figure).
 *
 * So no URL and no header can arrange people, parties or electorates by a number. The figures stay visible in
 * their cells exactly as the source reported them. They are counts and amounts, not measures of anyone's
 * accuracy, honesty or merit, and this page gives no way to read them as a league table.
 */

/**
 * An allowlist, not a list of numeric spellings: identifiers, words, dates and flags. Anything else - every numeric
 * type, arrays, ranges, json, and any domain or custom type whose nature this page cannot know - is not a sort key.
 */
const ORDERABLE_TYPES = /^(uuid|text|character varying|varchar|character|char|bpchar|citext|name|date|timestamp|timestamptz|timestamp with time zone|timestamp without time zone|time|time with time zone|time without time zone|boolean|bool)(\(\d+\))?$/

const RESULT_WORDS = ['vote', 'votes', 'share', 'seat', 'seats', 'rank', 'ranking', 'margin', 'majority', 'swing', 'turnout', 'total', 'totals', 'pct',
  'percent', 'percentage', 'score', 'confidence', 'rate', 'amount', 'value', 'size', 'count', 'donations', 'expenses'] as const

export function isOrderableType(dataType: string | null | undefined): boolean {
  return ORDERABLE_TYPES.test((dataType ?? '').trim().toLowerCase())
}

/** True when any underscore-separated word of the column name is a result word: party_votes, list_rank, value_pct. */
export function isResultLikeName(column: string): boolean {
  const words = column.toLowerCase().split('_')
  return words.some((w) => (RESULT_WORDS as readonly string[]).includes(w))
}

export interface SortCandidate { column_name: string; data_type?: string | null }

/** The only columns the generic browser will ever sort by. An unknown or unlisted type is denied. */
export function genericSortableColumns(columns: readonly SortCandidate[]): string[] {
  return columns
    .filter((c) => isOrderableType(c.data_type) && !isResultLikeName(c.column_name))
    .map((c) => c.column_name)
}

/** URL-level check, before the column catalogue has loaded: identifier-shaped and not a result name. */
export function isAcceptableGenericSortKey(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,62}$/.test(value) && !isResultLikeName(value)
}
