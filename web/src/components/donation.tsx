import { Pill } from '@/components/badges'
import { formatDate, formatMoney } from '@/lib/format'
import type { DonationDisclosureRow } from '@/lib/types'

/**
 * The cells shared by the donations table and the electorate page's money card, so one row of one
 * return reads the same way wherever it is shown — including when the deployment holds the entry but
 * releases none of its fields.
 */

/** Said of a column the store returned as null on a row it did list: held, and not released here. */
export const NOT_RELEASED = 'Not released here — read the return'

/** What the return says about the donor. An identity the law withholds is shown as withheld, never as missing. */
export function DonorName({ row }: { row: Pick<DonationDisclosureRow, 'donor_name_status' | 'donor_name_as_published' | 'donor_identity_kind'> }) {
  if (row.donor_name_status === 'published') return <>{row.donor_name_as_published}</>
  if (row.donor_name_status === 'withheld_by_publisher') {
    return <Pill tone="muted">{row.donor_identity_kind === 'anonymous' ? 'Anonymous — no name is disclosed' : 'Protected from disclosure by law'}</Pill>
  }
  // `not_separable` covers every reason a name was refused, not the address alone: a cell carrying a
  // digit or a street word is refused too, so the sentence names the cell rather than one cause of it.
  if (row.donor_name_status === 'not_separable') {
    return <Pill tone="caution">Named in the return; the name could not be separated from the other text printed in the same cell</Pill>
  }
  // No status at all. The row exists, so an entry was read; its fields are simply not released on this
  // deployment. Saying anything else here — "named", "withheld", "none" — would be inventing a reading
  // of a document this deployment does not publish.
  return <Pill tone="muted" testId="donor-not-released">{NOT_RELEASED}</Pill>
}

/** The amount the return states. A row whose fields are not released shows that, never a figure and never a zero. */
export function DisclosedAmount({ row }: { row: Pick<DonationDisclosureRow, 'disclosed_amount_nzd'> }) {
  if (row.disclosed_amount_nzd === null || row.disclosed_amount_nzd === undefined) {
    return <span className="text-xs text-muted-foreground" data-testid="amount-not-released">{NOT_RELEASED}</span>
  }
  return <span className="num">{formatMoney(row.disclosed_amount_nzd, 'reported')}</span>
}

/** The dates the return itself states. An empty list is never shown as a date. */
export function DisclosedDates({ row }: { row: Pick<DonationDisclosureRow, 'donation_dates' | 'date_disclosure'> }) {
  if (row.donation_dates && row.donation_dates.length > 0) {
    return <span className="text-xs">{row.donation_dates.map((d) => formatDate(d)).join(', ')}</span>
  }
  if (!row.date_disclosure) return <span className="text-xs text-muted-foreground">{NOT_RELEASED}</span>
  return <span className="text-xs text-muted-foreground">{row.date_disclosure === 'described_not_dated' ? 'described in words, not as dates' : 'no date printed'}</span>
}
