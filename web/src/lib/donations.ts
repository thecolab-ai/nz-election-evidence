import type { DonationDisclosureRow } from './types'

/**
 * Reading a donations row that a deployment has loaded but not released.
 *
 * A source whose rights review has not finished is published as LINK METADATA ONLY: its rows are
 * listed — the catalogue entry and the publisher's link are exactly what "link only" publishes —
 * while every column carrying something the document SAYS comes back null. The row is therefore
 * evidence that an entry was read, and evidence of nothing else. A page that prints those nulls as
 * blank cells tells a reader the return said nothing, which is the opposite of the truth.
 */

/**
 * Every column of the curated donations view that carries what the return states. `official_url` is
 * deliberately not among them: the link to the publisher's own document is the link metadata, and it
 * is the one value a links-only release does publish.
 */
export const DONATION_CONTENT_COLUMNS = [
  'return_kind',
  'reporting_year',
  'party_name_as_published',
  'candidate_name_as_published',
  'electorate_as_published',
  'amendment_labelled',
  'disclosure_part',
  'part_label_as_published',
  'disclosure_kind',
  'entry_index',
  'donor_name_as_published',
  'donor_name_status',
  'donor_identity_kind',
  'disclosed_amount_nzd',
  'donation_dates',
  'date_disclosure',
  'overlaps_election_year_notices',
  'part_total_nzd',
  'part_entries_disclosed',
  'part_itemisation_status',
  'amounts_basis',
  'disclosure_reader_version',
] as const satisfies readonly (keyof DonationDisclosureRow)[]

/** A row the store returned with its publisher link and nothing the return says. */
export function isLinkOnlyDisclosure(row: Partial<DonationDisclosureRow>): boolean {
  if (typeof row.official_url !== 'string' || row.official_url === '') return false
  return DONATION_CONTENT_COLUMNS.every((column) => {
    const value = row[column]
    return value === null || value === undefined
  })
}

/**
 * What the rows in hand are, never what the dataset is: this is read off the rows a deployment
 * actually returned, so every sentence the page then prints is a sentence about those rows.
 */
export type DonationsRelease = 'no_rows' | 'link_only' | 'fields'

export function donationsRelease(rows: readonly Partial<DonationDisclosureRow>[] | undefined): DonationsRelease {
  if (!rows || rows.length === 0) return 'no_rows'
  return rows.every(isLinkOnlyDisclosure) ? 'link_only' : 'fields'
}

/**
 * A row identity that survives the link-only state. `disclosure_part` and `entry_index` are content
 * columns, so on a links-only deployment they are null for every row and two entries of the same
 * return would otherwise collide into one key — the table would then drop rows it was given.
 */
export function donationRowKey(row: Partial<DonationDisclosureRow>, index: number): string {
  const part = row.disclosure_part ?? 'part not released'
  const entry = row.entry_index ?? `row ${index}`
  return `${row.official_url ?? 'no link'}#${part}-${entry}`
}

/**
 * The document a link points at, for a row that has nothing else to show. The file name is what the
 * Commission itself names the return; it is read off the published URL and nothing is added to it.
 */
export function returnDocumentLabel(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop()
    if (!last) return url
    return decodeURIComponent(last)
  } catch {
    return url
  }
}
