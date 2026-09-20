/**
 * What the first connected release actually covers, product by product. Stated in the explorer so that nobody
 * reads a populated page as a complete one. Held equal to catalogue/sources.json and the ingestion source
 * configuration by a test (tools/release_coverage.test.ts): adding a route means changing this list.
 *
 *   live     a live adapter retrieves it from the publisher
 *   export   imported once from a checksum-pinned, verified historical export
 *   none     no route into this store. Nothing is held, and nothing is implied about what the publisher has
 */
export type ProductRoute = 'live' | 'export' | 'none'

export interface ProductCoverage {
  product_id: string
  title: string
  publisher: string
  route: ProductRoute
  source_id?: string
  note?: string
}

export const RELEASE_COVERAGE: readonly ProductCoverage[] = [
  { product_id: 'P01', title: 'Beehive releases', publisher: 'New Zealand Government / Beehive', route: 'live', source_id: 'nz_government_releases_feed', note: 'The current feed window only: titles and links. The historical archive is not held.' },
  { product_id: 'P02', title: '54th Parliament bill publications', publisher: 'New Zealand Parliament', route: 'none' },
  { product_id: 'P03', title: 'Current bills index', publisher: 'New Zealand Parliament', route: 'live', source_id: 'nz_parliament_current_bills', note: 'Bill metadata and links. Never bill text.' },
  { product_id: 'P04', title: '2023 general election candidate roster', publisher: 'Electoral Commission', route: 'export', source_id: 'baseline_2023_candidacies_export', note: 'A verified historical export of 963 candidacies (495 electorate, 468 party list). A 2023 baseline, not the 2026 election.' },
  { product_id: 'P05', title: '54th Parliament committee business', publisher: 'New Zealand Parliament', route: 'none' },
  { product_id: 'P06', title: '54th Parliament select committee report bodies', publisher: 'New Zealand Parliament', route: 'none' },
  { product_id: 'P07', title: '54th Parliament select committee report index', publisher: 'New Zealand Parliament', route: 'none' },
  { product_id: 'P08', title: '2023 overall election results', publisher: 'Electoral Commission', route: 'none' },
  { product_id: 'P09', title: '2023 electorate election results', publisher: 'Electoral Commission', route: 'none' },
  { product_id: 'P10', title: 'Current members of Parliament', publisher: 'New Zealand Parliament', route: 'live', source_id: 'nz_parliament_mp_directory', note: 'Name, party and seat as listed, with the official profile link. A sitting member is not a candidate.' },
  { product_id: 'P11', title: 'Health New Zealand data catalogue sample', publisher: 'Health New Zealand', route: 'none' },
  { product_id: 'P12', title: 'MSD benefits and hardship statistics sample', publisher: 'Ministry of Social Development', route: 'none' },
  { product_id: 'P13', title: 'Registered-party policy page catalogue', publisher: 'Registered New Zealand political parties', route: 'none' },
  { product_id: 'P14', title: 'Recent party-vote polls sample', publisher: 'Multiple poll publishers', route: 'none' },
  { product_id: 'P15', title: '2023 candidate expense-return document index', publisher: 'Electoral Commission', route: 'none' },
  { product_id: 'P16', title: '2025 party finance aggregate index', publisher: 'Electoral Commission', route: 'none' },
  { product_id: 'P17', title: '2025 party finance return document index', publisher: 'Electoral Commission', route: 'none' },
  { product_id: 'P18', title: 'Reserve Bank statistics catalogue', publisher: 'Reserve Bank of New Zealand', route: 'none' },
  { product_id: 'P19', title: '2018 Census national highlights sample', publisher: 'Stats NZ', route: 'none' },
  { product_id: 'P20', title: 'Stats NZ CSV catalogue sample', publisher: 'Stats NZ', route: 'none' },
  { product_id: 'P21', title: '2023 Census selected products', publisher: 'Stats NZ', route: 'none' },
  { product_id: 'P22', title: 'Food price and population selected series', publisher: 'Stats NZ', route: 'none' },
  { product_id: 'P23', title: 'Rental bond selected measures', publisher: 'Tenancy Services', route: 'none' },
  { product_id: 'P24', title: 'Written parliamentary questions', publisher: 'New Zealand Parliament', route: 'none' },
]

export function coverageCounts(rows: readonly ProductCoverage[] = RELEASE_COVERAGE): { total: number; live: number; export: number; none: number } {
  const count = (route: ProductRoute) => rows.filter((row) => row.route === route).length
  return { total: rows.length, live: count('live'), export: count('export'), none: count('none') }
}
