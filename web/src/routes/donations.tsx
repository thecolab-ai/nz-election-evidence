import { createColumnHelper } from '@tanstack/react-table'
import { getRouteApi } from '@tanstack/react-router'
import { Pill } from '@/components/badges'
import { DataTable, type CoreFeatures } from '@/components/data-table'
import { FilterBar, SelectFilter, TextFilter } from '@/components/filters'
import { ExternalLink, Note, PageHeader } from '@/components/page'
import { formatDate, formatMoney, humanise } from '@/lib/format'
import { useListQuery } from '@/lib/queries'
import { donationsSpec } from '@/lib/specs'
import type { DonationDisclosureRow } from '@/lib/types'
import { filterPatch, useSetSearch } from '@/lib/use-set-search'

const route = getRouteApi('/_released/donations')
const helper = createColumnHelper<CoreFeatures, DonationDisclosureRow>()

/** What the return says about the donor. An identity the law withholds is shown as withheld, never as missing. */
function Donor({ row }: { row: DonationDisclosureRow }) {
  if (row.donor_name_status === 'published') return <>{row.donor_name_as_published}</>
  if (row.donor_name_status === 'withheld_by_publisher') {
    return <Pill tone="muted">{row.donor_identity_kind === 'anonymous' ? 'Anonymous — no name is disclosed' : 'Protected from disclosure by law'}</Pill>
  }
  return <Pill tone="caution">Named in the return; the name could not be separated from the address printed with it</Pill>
}

/** The dates the return itself states. An empty list is never shown as a date. */
function Dates({ row }: { row: DonationDisclosureRow }) {
  if (row.donation_dates && row.donation_dates.length > 0) {
    return <span className="text-xs">{row.donation_dates.map((d) => formatDate(d)).join(', ')}</span>
  }
  return <span className="text-xs text-muted-foreground">{row.date_disclosure === 'described_not_dated' ? 'described in words, not as dates' : 'no date printed'}</span>
}

const columns = helper.columns([
  helper.accessor('reporting_year', { header: 'Year', cell: ({ getValue }) => <span className="num">{getValue()}</span> }),
  helper.accessor('donor_name_as_published', { header: 'Donor as disclosed', cell: ({ row }) => <Donor row={row.original} /> }),
  helper.accessor('disclosed_amount_nzd', { header: 'Amount disclosed', cell: ({ row }) => <span className="num">{formatMoney(row.original.disclosed_amount_nzd, 'reported')}</span> }),
  helper.accessor('party_name_as_published', {
    header: 'Received by',
    cell: ({ row }) => (
      <>
        {row.original.candidate_name_as_published ?? row.original.party_name_as_published}
        {row.original.candidate_name_as_published ? (
          <span className="block text-xs text-muted-foreground">
            {row.original.party_name_as_published ?? 'no party stated'} · {row.original.electorate_as_published}
          </span>
        ) : null}
      </>
    ),
  }),
  helper.accessor('donation_dates', { header: 'Dates the return states', cell: ({ row }) => <Dates row={row.original} /> }),
  helper.accessor('part_label_as_published', {
    header: 'Disclosed under',
    cell: ({ row }) => (
      <>
        Part {row.original.disclosure_part}: {row.original.part_label_as_published}
        <span className="block text-xs text-muted-foreground">{humanise(row.original.disclosure_kind)}</span>
      </>
    ),
  }),
  helper.accessor('amendment_labelled', { header: 'Document', cell: ({ getValue }) => (getValue() ? <Pill tone="caution">Amended return</Pill> : 'As first filed') }),
  helper.accessor('official_url', { header: 'Official return', cell: ({ getValue }) => <ExternalLink href={getValue()}>Open at publisher</ExternalLink> }),
])

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
      <FilterBar
        hasActive={!!(search.kind || search.identity || search.year || search.q)}
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
      <DataTable caption="Donations disclosed in filed returns" columns={columns} query={query} spec={donationsSpec} search={search} onSearchChange={setSearch} getRowId={(row) => `${row.official_url}#${row.disclosure_part}-${row.entry_index}`} />
    </>
  )
}
