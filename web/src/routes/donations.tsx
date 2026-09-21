import { createColumnHelper } from '@tanstack/react-table'
import { getRouteApi, Link } from '@tanstack/react-router'
import { Pill } from '@/components/badges'
import { DataTable, type CoreFeatures } from '@/components/data-table'
import { DisclosedAmount, DisclosedDates, DonorName, NOT_RELEASED } from '@/components/donation'
import { FilterBar, SelectFilter, TextFilter } from '@/components/filters'
import { ExternalLink, Note, PageHeader } from '@/components/page'
import { NotLoadedBlock } from '@/components/states'
import { donationRowKey, donationsRelease, isLinkOnlyDisclosure, returnDocumentLabel } from '@/lib/donations'
import { isMissingDataset } from '@/lib/electorate'
import { humanise } from '@/lib/format'
import { useListQuery } from '@/lib/queries'
import { donationsSpec } from '@/lib/specs'
import type { DonationDisclosureRow } from '@/lib/types'
import { filterPatch, useSetSearch } from '@/lib/use-set-search'

const route = getRouteApi('/_released/donations')
const helper = createColumnHelper<CoreFeatures, DonationDisclosureRow>()

/** A content column that came back null on a row the store did list: held here, released elsewhere. */
function NotReleased() {
  return <span className="text-xs text-muted-foreground">{NOT_RELEASED}</span>
}

const columns = helper.columns([
  helper.accessor('reporting_year', { header: 'Year', cell: ({ getValue }) => (getValue() === null || getValue() === undefined ? <NotReleased /> : <span className="num">{getValue()}</span>) }),
  helper.accessor('donor_name_as_published', { header: 'Donor as disclosed', cell: ({ row }) => <DonorName row={row.original} /> }),
  helper.accessor('disclosed_amount_nzd', { header: 'Amount disclosed', cell: ({ row }) => <DisclosedAmount row={row.original} /> }),
  helper.accessor('party_name_as_published', {
    header: 'Received by',
    cell: ({ row }) => {
      const recipient = row.original.candidate_name_as_published ?? row.original.party_name_as_published
      // A row whose fields are not released is not a return that printed no recipient, and must not read as one.
      if (recipient === null || recipient === undefined) return isLinkOnlyDisclosure(row.original) ? <NotReleased /> : <span className="text-xs text-muted-foreground">recipient not printed</span>
      return (
        <>
          {recipient}
          {row.original.candidate_name_as_published ? (
            <span className="block text-xs text-muted-foreground">
              {row.original.party_name_as_published ?? 'no party stated'} · {row.original.electorate_as_published ?? 'no electorate printed'}
            </span>
          ) : null}
        </>
      )
    },
  }),
  helper.accessor('donation_dates', { header: 'Dates the return states', cell: ({ row }) => <DisclosedDates row={row.original} /> }),
  helper.accessor('part_label_as_published', {
    header: 'Disclosed under',
    cell: ({ row }) =>
      row.original.disclosure_part ? (
        <>
          Part {row.original.disclosure_part}: {row.original.part_label_as_published}
          <span className="block text-xs text-muted-foreground">{humanise(row.original.disclosure_kind)}</span>
        </>
      ) : (
        <NotReleased />
      ),
  }),
  // A null is not "as first filed": whether the document was amended is itself a field of the return.
  helper.accessor('amendment_labelled', { header: 'Document', cell: ({ getValue }) => (getValue() === null || getValue() === undefined ? <NotReleased /> : getValue() ? <Pill tone="caution">Amended return</Pill> : 'As first filed') }),
  helper.accessor('official_url', { header: 'Official return', cell: ({ getValue }) => <ExternalLink href={getValue()}>Open at publisher</ExternalLink> }),
])

/**
 * What a deployment shows for entries it has loaded and not released: the publisher's own document,
 * named, and a column that says in as many words that nothing inside it is published here. Eight
 * columns of nulls would read as a return that stated nothing; this reads as what it is.
 */
export const linkOnlyColumns = helper.columns([
  helper.accessor('official_url', {
    header: 'Official return document',
    cell: ({ getValue }) => <ExternalLink href={getValue()}>{returnDocumentLabel(getValue())}</ExternalLink>,
  }),
  helper.display({ id: 'release', header: 'Published on this deployment', cell: () => <EntryLinkOnlyCell /> }),
])

/** One entry of a return this deployment has read and does not release. It states that, and claims nothing else. */
export function EntryLinkOnlyCell() {
  return (
    <span className="text-xs text-muted-foreground">
      <Pill tone="muted" testId="entry-link-only">Link only</Pill>{' '}
      One entry was read from this return. Its donor, amount, recipient and dates are not released here.
    </span>
  )
}

/**
 * The state a reader meets when this deployment has loaded these returns and releases none of their
 * fields. It says which is which — read, not released — and refuses the two readings a blank invites:
 * that the return said nothing, and that nothing was given.
 */
export function DonationsLinkOnlyNote() {
  return (
    <Note tone="caution" testId="donations-link-only">
      <strong className="font-semibold">Loaded here, published by the Commission — not released on this deployment.</strong> Every entry listed
      below came back with one value: the link to the Electoral Commission’s own return document. The donor, the amount, the recipient, the dates
      and the part each entry was disclosed under are not released here, so this page lists the documents instead of printing empty cells. Nothing
      below states who gave what to whom, and a blank is not a zero and not a denial — the figures are printed in the publisher’s document, which
      every row opens. Why material is published as links only is on the <Link to="/rights" className="doc-link">rights</Link> page, source by
      source on <Link to="/sources" className="doc-link">sources</Link>.
    </Note>
  )
}

const EMPTY_WITH_FILTERS =
  'No row matched these filters. A filter can only match a field that is published, so where a return is released as a link only, filtering by donor, kind, identity or year matches nothing. Clearing the filters shows what this deployment does hold.'

export function DonationsPage() {
  const search = route.useSearch()
  const setSearch = useSetSearch()
  const query = useListQuery<DonationDisclosureRow, keyof typeof donationsSpec.filters>({
    // The curated view: the figure and the label that says how complete it is, in one row.
    view: 'donation_disclosures',
    select: '*',
    spec: donationsSpec,
    search,
    filter: (q, s) => {
      let next = q
      if (s.kind) next = next.eq('disclosure_kind', s.kind)
      if (s.identity) next = next.eq('donor_identity_kind', s.identity)
      if (s.year) next = next.eq('reporting_year', Number(s.year))
      if (s.q) next = next.ilike('donor_name_as_published', `%${s.q}%`)
      return next
    },
  })
  const datasetNotLoaded = query.isError && isMissingDataset(query.error)
  const hasActiveFilters = !!(search.kind || search.identity || search.year || search.q)
  // Read off the rows in hand, so what the page then says is said about those rows and nothing wider.
  const linkOnly = donationsRelease(query.data?.rows) === 'link_only'
  return (
    <>
      <PageHeader eyebrow="Civic model · Political finance" title="Donations disclosed in filed returns">
        <p>
          What each party and candidate declared inside the return they filed with the Electoral Commission, part by part, as the return states it.
          Every row links to the original return document. Nothing here is added to anything: a figure read from a return is the same money the
          Commission prints on its own index pages, and the two are compared rather than summed.
        </p>
      </PageHeader>
      <div className="mb-4 space-y-2">
        {linkOnly ? <DonationsLinkOnlyNote /> : null}
        <Note tone="caution" testId="donations-incomplete">
          This is not a complete record of donations in New Zealand. An entry appears only where the entries of its part add up exactly to the
          total the Commission’s own form prints for that part; where they do not, the part is published with its printed total and the number of
          entries it declares, and no entry of it is shown. Most returns in this corpus could not be read at all: many are scans with no text.
        </Note>
        <Note tone="plain" testId="donations-no-address">
          No street address, contact detail, signature or bank detail is held anywhere in this store. Where the law withholds a donor’s identity —
          an anonymous donation, or one protected from disclosure — it stays withheld here too.
        </Note>
        <Note tone="plain" testId="donations-not-notices">
          The donations over $20,000 that the Commission publishes separately during an election year are not collected by this project at all.
          An annual return for an election year already includes them, so adding the two publications together would count the same money twice.
        </Note>
      </div>
      {datasetNotLoaded ? (
        // The nav item is part of the shell, so this page can be reached on a deployment that has not
        // had the disclosure products imported. That is an absence, not a fault: the same honest state
        // the electorate page's money card already shows, rather than a red alert with a PostgREST code.
        <NotLoadedBlock datasetName="evidence_public.donation_disclosures" />
      ) : (
        <>
      {linkOnly && !hasActiveFilters ? (
        // Offering a donor box on rows that publish no donor would invite a reader to search for a name
        // and read the empty result as "this person gave nothing".
        <div className="mb-4">
          <Note testId="donations-filters-unavailable">
            The donor, kind, identity and year filters read fields that are not released here, so they are not offered on this deployment: a search
            that can only ever return nothing would be read as an answer.
          </Note>
        </div>
      ) : (
      <FilterBar
        hasActive={hasActiveFilters}
        onClear={() => setSearch({ kind: undefined, identity: undefined, year: undefined, q: undefined, page: 1 })}
      >
        <TextFilter name="q" label="Donor name" value={search.q} onCommit={(v: string | undefined) => setSearch(filterPatch('q', v), { replace: true })} placeholder="Name as the return discloses it" />
        <SelectFilter name="kind" label="Kind" value={search.kind} onChange={(v) => setSearch(filterPatch('kind', v), { replace: true })} options={donationsSpec.filters.kind.values.map((v) => ({ value: v, label: humanise(v) }))} anyLabel="Any kind" />
        <SelectFilter
          name="identity"
          label="Donor identity"
          value={search.identity}
          onChange={(v) => setSearch(filterPatch('identity', v), { replace: true })}
          options={donationsSpec.filters.identity.values.map((v) => ({ value: v, label: humanise(v) }))}
          anyLabel="Any identity"
        />
        <SelectFilter name="year" label="Reporting year" value={search.year} onChange={(v) => setSearch(filterPatch('year', v), { replace: true })} options={donationsSpec.filters.year.values.map((v) => ({ value: v, label: v }))} anyLabel="Any year" />
      </FilterBar>
      )}
      <DataTable
        caption="Donations disclosed in filed returns"
        columns={linkOnly ? linkOnlyColumns : columns}
        query={query}
        spec={donationsSpec}
        search={search}
        onSearchChange={setSearch}
        getRowId={donationRowKey}
        {...(hasActiveFilters ? { emptyMessage: EMPTY_WITH_FILTERS } : {})}
      />
        </>
      )}
    </>
  )
}
