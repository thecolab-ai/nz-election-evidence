import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DisclosedAmount, DisclosedDates, DonorName, NOT_RELEASED } from '@/components/donation'
import { donationRowKey, donationsRelease, isLinkOnlyDisclosure, returnDocumentLabel } from '@/lib/donations'
import { effectiveSort } from '@/lib/search'
import { donationsSpec } from '@/lib/specs'
import type { DonationDisclosureRow } from '@/lib/types'
import { DonationsLinkOnlyNote, EntryLinkOnlyCell, linkOnlyColumns } from './donations'
import { donationMeta } from './electorate'

// Invented values labelled as fixtures; none of this is evidence. The link is a fixture URL.
const LINK = 'https://example.invalid/returns/fixture-party-return-2023.pdf'

/** The shape a links-only deployment answers with: the publisher's link, and every stated field null. */
function linkOnlyRow(url = LINK): DonationDisclosureRow {
  return {
    official_url: url,
    return_kind: null,
    reporting_year: null,
    party_name_as_published: null,
    candidate_name_as_published: null,
    electorate_as_published: null,
    amendment_labelled: null,
    disclosure_part: null,
    part_label_as_published: null,
    disclosure_kind: null,
    entry_index: null,
    donor_name_as_published: null,
    donor_name_status: null,
    donor_identity_kind: null,
    disclosed_amount_nzd: null,
    donation_dates: null,
    date_disclosure: null,
    overlaps_election_year_notices: null,
    part_total_nzd: null,
    part_entries_disclosed: null,
    part_itemisation_status: null,
    amounts_basis: null,
    disclosure_reader_version: null,
  } as unknown as DonationDisclosureRow
}

function releasedRow(): DonationDisclosureRow {
  return {
    ...linkOnlyRow(),
    reporting_year: 2023,
    return_kind: 'party_annual_return',
    party_name_as_published: 'Fixture Party (TEST FIXTURE)',
    amendment_labelled: false,
    disclosure_part: '3',
    part_label_as_published: 'Donations (TEST FIXTURE)',
    disclosure_kind: 'donation',
    entry_index: 0,
    donor_name_as_published: 'Fixture Donor (TEST FIXTURE)',
    donor_name_status: 'published',
    donor_identity_kind: 'named',
    disclosed_amount_nzd: 1234,
    donation_dates: ['2023-04-01'],
    date_disclosure: 'dated',
    overlaps_election_year_notices: false,
  } as unknown as DonationDisclosureRow
}

describe('a donation row that is loaded and not released is read as exactly that', () => {
  it('a row carrying only its publisher link is link-only; one carrying any stated field is not', () => {
    expect(isLinkOnlyDisclosure(linkOnlyRow())).toBe(true)
    expect(isLinkOnlyDisclosure(releasedRow())).toBe(false)
    // A stated value that is falsy is still a stated value: entry 0 and "not amended" are facts, not blanks.
    expect(isLinkOnlyDisclosure({ ...linkOnlyRow(), entry_index: 0 })).toBe(false)
    expect(isLinkOnlyDisclosure({ ...linkOnlyRow(), amendment_labelled: false })).toBe(false)
    // Without the link there is nothing published at all, so there is no links-only claim to make.
    expect(isLinkOnlyDisclosure({ ...linkOnlyRow(), official_url: '' })).toBe(false)
  })

  it('the page state is read off the rows in hand, and no rows is not a release state', () => {
    expect(donationsRelease([linkOnlyRow(), linkOnlyRow('https://example.invalid/returns/other.pdf')])).toBe('link_only')
    expect(donationsRelease([linkOnlyRow(), releasedRow()])).toBe('fields')
    expect(donationsRelease([])).toBe('no_rows')
    expect(donationsRelease(undefined)).toBe('no_rows')
  })

  it('two entries of one return keep two row identities when the identifying columns are not released', () => {
    const rows = [linkOnlyRow(), linkOnlyRow()]
    const keys = rows.map((row, index) => donationRowKey(row, index))
    expect(new Set(keys).size).toBe(2)
    // A released row is still keyed by what the return states, not by its position in a page.
    expect(donationRowKey(releasedRow(), 7)).toBe(`${LINK}#3-0`)
  })

  it('pagination of a links-only list is ordered by a column that is published', () => {
    const rules = effectiveSort<keyof typeof donationsSpec.filters>(donationsSpec, { page: 1, size: 25 }).map((r) => r.column)
    expect(rules).toContain('official_url')
    // The content tiebreak stays first for a released list; the link is the fallback that is always there.
    expect(rules.indexOf('entry_index')).toBeLessThan(rules.indexOf('official_url'))
  })

  it('names the publisher document from its own URL, and invents nothing when it cannot', () => {
    expect(returnDocumentLabel(LINK)).toBe('fixture-party-return-2023.pdf')
    expect(returnDocumentLabel('not a url')).toBe('not a url')
    expect(returnDocumentLabel('https://example.invalid/')).toBe('https://example.invalid/')
  })
})

describe('cells never state what the deployment does not publish', () => {
  it('a donor cell with no status says the field is not released, and does not say the return named anyone', () => {
    render(<DonorName row={linkOnlyRow()} />)
    expect(screen.getByTestId('donor-not-released').textContent).toBe(NOT_RELEASED)
    expect(document.body.textContent).not.toMatch(/named in the return/i)
    expect(document.body.textContent).not.toMatch(/anonymous|protected from disclosure/i)
  })

  it('the donor readings the return does state are unchanged', () => {
    const { unmount } = render(<DonorName row={releasedRow()} />)
    expect(document.body.textContent).toContain('Fixture Donor (TEST FIXTURE)')
    unmount()
    const withheld = render(<DonorName row={{ ...linkOnlyRow(), donor_name_status: 'withheld_by_publisher', donor_identity_kind: 'anonymous' }} />)
    expect(document.body.textContent).toContain('Anonymous — no name is disclosed')
    withheld.unmount()
    render(<DonorName row={{ ...linkOnlyRow(), donor_name_status: 'not_separable', donor_identity_kind: 'named' }} />)
    expect(document.body.textContent).toMatch(/could not be separated/)
  })

  it('an amount that is not released is words, never a figure and never a zero', () => {
    render(<DisclosedAmount row={linkOnlyRow()} />)
    expect(screen.getByTestId('amount-not-released').textContent).toBe(NOT_RELEASED)
    expect(document.body.textContent).not.toMatch(/\$|\b0\b|unknown/i)
  })

  it('dates that are not released are not reported as a return that printed no date', () => {
    const { unmount } = render(<DisclosedDates row={linkOnlyRow()} />)
    expect(document.body.textContent).toBe(NOT_RELEASED)
    unmount()
    render(<DisclosedDates row={{ ...linkOnlyRow(), date_disclosure: 'described_not_dated' }} />)
    expect(document.body.textContent).toContain('described in words, not as dates')
  })
})

/** The note links to other routes, so it is rendered inside a throwaway router, as the app renders it. */
function renderInRouter(node: React.ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <>{node}</> })
  const rights = createRoute({ getParentRoute: () => rootRoute, path: '/rights', component: () => <p>rights</p> })
  const sources = createRoute({ getParentRoute: () => rootRoute, path: '/sources', component: () => <p>sources</p> })
  const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, rights, sources]), history: createMemoryHistory({ initialEntries: ['/'] }) })
  render(<RouterProvider router={router as never} />)
}

describe('the links-only state of the donations page', () => {
  it('says the entries are loaded and not released, and refuses both readings of a blank', async () => {
    renderInRouter(<DonationsLinkOnlyNote />)
    const note = await screen.findByTestId('donations-link-only')
    const text = note.textContent ?? ''
    // Said of the rows this page is holding, which is all the page can read. A deployment-wide claim
    // would be made from one page of rows on a store that may release other sources differently.
    expect(text).toContain('the entries on this page are not released here')
    expect(text).toMatch(/Other pages of this list, and other sources, may be released differently/)
    expect(text).not.toMatch(/not released on this deployment|no donation fields are released anywhere/i)
    expect(text).toContain('a blank is not a zero')
    expect(text).toContain('Nothing below states who gave what to whom')
    // It must not read as an absence of donations, nor as a claim that any name or amount is published here.
    expect(text).not.toMatch(/no donations|none were made|nothing was donated/i)
    expect(text).not.toMatch(/donor names (are|is) (published|shown)|amounts are published/i)
    // The publisher's own document is where the figures are, and the note says so.
    expect(text).toMatch(/figures are\s+printed in the publisher’s document/)
  })

  it('every row keeps its publisher link and says what is published of it', () => {
    render(<EntryLinkOnlyCell />)
    expect(screen.getByTestId('entry-link-only').textContent).toBe('Link only')
    expect(document.body.textContent).toContain('not released here')
  })

  it('the links-only table offers the document and the state, and no column that would be blank', () => {
    const headers = linkOnlyColumns.map((column) => String((column as { header?: unknown }).header ?? ''))
    expect(headers).toEqual(['Official return document', 'Published on this deployment'])
    for (const header of headers) expect(header).not.toMatch(/donor|amount|received by/i)
  })
})

describe('the line under one entry on the electorate money card', () => {
  it('prints every reading the return states, in the order a reader meets them', () => {
    expect(donationMeta({ ...releasedRow(), amendment_labelled: true, overlaps_election_year_notices: true })).toEqual([
      'Party return 2023',
      'Fixture Party (TEST FIXTURE)',
      'Part 3: Donations (TEST FIXTURE)',
      'donation',
      'amended return',
      'overlaps the separately published election-year notices',
    ])
  })

  it('leaves out a field this deployment did not release, rather than printing a reading over the null', () => {
    // Reachable under a partial field release: some columns of the return published, others null.
    const partial = { ...releasedRow(), return_kind: null, disclosure_part: null, part_label_as_published: null } as unknown as DonationDisclosureRow
    const segments = donationMeta(partial)
    // The year is stated, so it is shown; the kind of return is not, so no kind is asserted for it.
    expect(segments).toContain('2023')
    expect(segments.join(' · ')).not.toMatch(/Party return|Candidate return|Part\s*:/)
    // Nothing renders as an empty fragment where a value is missing.
    for (const segment of segments) expect(segment.trim()).not.toBe('')
  })

  it('a row carrying nothing but its link states nothing at all on this line', () => {
    expect(donationMeta(linkOnlyRow())).toEqual([])
  })
})
