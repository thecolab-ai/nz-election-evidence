// Statistics family: which upstream route is authoritative for each source, decided before any import.
//
// Upstream holds statistics twice: in dedicated census/series tables and as "operational" records of the general
// refresh. Where both hold the same publisher file, ONE route is imported and the other is only counted. The
// counts are reported side by side in stat_route_reconciliation; they are never added together.

import type { Route } from "./contract.ts";

export interface StatsSourcePlan {
  source_id: string;
  /** Catalogue products this source answers, with how the catalogue's count relates to what is imported. */
  products: { product_id: string; mapping_note: string }[];
  title: string;
  publisher: string;
  official_url: string;
  rights_id: string;
  route: Route | "catalogue_only";
  /** Upstream identifiers, used only by the exporter. They are names of tables rows, not locations. */
  upstream: {
    operational_source?: string;
    census_datasets?: string[];
    census_products?: boolean;
    series_all_datasets?: boolean;
    /** A route that holds the same publisher file and is therefore NOT imported, only counted. */
    overlap?: { route: Route; operational_source: string; note: string };
  };
  historical: boolean;
  /** Hosts a fresh anonymous fetch may contact. Empty when no incremental route exists. */
  live_hosts: string[];
  incremental: "fresh_fetch" | "catalogue_fresh_fetch_only" | "none";
  incremental_note: string;
}

export const STATS_SOURCES: StatsSourcePlan[] = [
  {
    source_id: "stats_healthnz_data",
    products: [{ product_id: "P11", mapping_note: "All 93 catalogue records: 44 facts (one workbook, one quarter) as observations, 26 links and 23 file listings as catalogue entries." }],
    title: "Health New Zealand data: primary care enrolment facts and data catalogue",
    publisher: "Health New Zealand | Te Whatu Ora",
    official_url: "https://www.tewhatuora.govt.nz/for-health-professionals/data-and-statistics/",
    rights_id: "RIGHTS-05",
    route: "operational",
    upstream: { operational_source: "healthnz_data" },
    historical: false,
    live_hosts: ["www.healthnz.govt.nz"],
    incremental: "catalogue_fresh_fetch_only",
    incremental_note: "The listing page is fetched fresh. Facts come from a workbook whose cell mapping was reviewed by hand for one quarter; a new quarter needs that review again, so no fact is parsed unattended.",
  },
  {
    source_id: "stats_msd_benefits",
    products: [{ product_id: "P12", mapping_note: "903 facts (43 reviewed national series of one quarterly workbook) as observations; 26 catalogue records as catalogue entries (27 stored versions)." }],
    title: "MSD quarterly national benefit tables and statistics catalogue",
    publisher: "Ministry of Social Development",
    official_url: "https://www.msd.govt.nz/about-msd-and-our-work/publications-resources/statistics/",
    rights_id: "RIGHTS-06",
    route: "operational",
    upstream: { operational_source: "msd_benefits" },
    historical: false,
    live_hosts: ["www.msd.govt.nz"],
    incremental: "catalogue_fresh_fetch_only",
    incremental_note: "The statistics index is fetched fresh. Facts come from a quarterly workbook normalised against reviewed cells; the next quarter's workbook needs that review, so no fact is parsed unattended.",
  },
  {
    source_id: "stats_rbnz_catalogue",
    products: [{ product_id: "P18", mapping_note: "18 catalogue records. Catalogue only: no time-series observation is imported or implied." }],
    title: "Reserve Bank of New Zealand datasets listed on the government data catalogue",
    publisher: "Reserve Bank of New Zealand",
    official_url: "https://www.rbnz.govt.nz/statistics",
    rights_id: "RIGHTS-15",
    route: "catalogue_only",
    upstream: { operational_source: "rbnz_statistics" },
    historical: false,
    live_hosts: ["catalogue.data.govt.nz"],
    incremental: "fresh_fetch",
    incremental_note: "The public catalogue API result set is fetched fresh and replaces nothing: entries are versioned by content.",
  },
  {
    source_id: "stats_nz_census_2018_highlights",
    products: [{ product_id: "P19", mapping_note: "The catalogue counts 877 operational records (6 of the file's CSV members). The dedicated census route holds all 4,966 observations of the SAME file (same SHA-256) and contains those 877 exactly; it is the one imported. 877 is a subset of 4,966, not an addition to it." }],
    title: "2018 Census totals by topic: national highlights",
    publisher: "Stats NZ",
    official_url: "https://www.stats.govt.nz/2018-census/",
    rights_id: "RIGHTS-16",
    route: "dedicated_census",
    upstream: {
      census_datasets: ["statsnz.census.2018.national_highlights"],
      overlap: { route: "operational", operational_source: "stats_nz_census_2018_national_highlights", note: "Same publisher file by SHA-256; every operational row is present in the dedicated route with the same member, row, measure and value." },
    },
    historical: true,
    live_hosts: [],
    incremental: "none",
    incremental_note: "A closed historical release published as a ZIP archive. The shared fetch client returns text only, so the archive cannot be re-read here; the file is static and is re-verified by its recorded SHA-256 upstream.",
  },
  {
    source_id: "stats_nz_census_2013_meshblock",
    products: [],
    title: "2013 Census meshblock dataset: selected totals for 2001, 2006 and 2013 on 2013 boundaries",
    publisher: "Stats NZ",
    official_url: "https://www3.stats.govt.nz/meshblock/2013/csv/2013_mb_dataset_Total_New_Zealand_CSV.zip",
    rights_id: "RIGHTS-16",
    route: "dedicated_census",
    upstream: { census_datasets: ["statsnz.census.2013.meshblock.selected_totals"] },
    historical: true,
    live_hosts: [],
    incremental: "none",
    incremental_note: "A closed historical release published as a ZIP archive; see the 2018 note. It answers no product of the 24-product catalogue and is loaded as history, labelled as such.",
  },
  {
    source_id: "stats_nz_csv_catalogue",
    products: [{ product_id: "P20", mapping_note: "128 file listings as catalogue entries (374 stored versions across 6 collection runs). Listing metadata only: no fact is asserted from a listing." }],
    title: "Stats NZ CSV files for download: file listing",
    publisher: "Stats NZ",
    official_url: "https://www.stats.govt.nz/large-datasets/csv-files-for-download/",
    rights_id: "RIGHTS-18",
    route: "catalogue_only",
    upstream: { operational_source: "stats_nz_csv_catalogue" },
    historical: false,
    live_hosts: ["www.stats.govt.nz"],
    incremental: "fresh_fetch",
    incremental_note: "The listing page is fetched fresh and every CSV/ZIP link on it becomes a catalogue entry version.",
  },
  {
    source_id: "stats_nz_census_2023",
    products: [{ product_id: "P21", mapping_note: "All 37,689 operational facts (two workbooks) as observations. The 757-row product finder is loaded beside them as catalogue entries; it is an index of products, not observations, and is not part of the 37,689." }],
    title: "2023 Census selected products: population, dwelling and electoral population counts",
    publisher: "Stats NZ",
    official_url: "https://www.stats.govt.nz/2023-census/",
    rights_id: "RIGHTS-17",
    route: "operational",
    upstream: { operational_source: "stats_nz_2023_census", census_products: true },
    historical: false,
    live_hosts: [],
    incremental: "none",
    incremental_note: "Both inputs are workbooks (a binary format the shared text-only fetch client cannot read) whose table layouts were mapped by hand. The publisher's observation API answers 401 without a subscription key and is not used.",
  },
  {
    source_id: "stats_nz_selected_series",
    products: [{ product_id: "P22", mapping_note: "All 55,428 operational facts: selected price indexes (55,284) and national population by broad age group (144)." }],
    title: "Stats NZ selected price indexes and national population estimates",
    publisher: "Stats NZ",
    official_url: "https://www.stats.govt.nz/large-datasets/csv-files-for-download/",
    rights_id: "RIGHTS-18",
    route: "operational",
    upstream: { operational_source: "stats_nz_series" },
    historical: false,
    live_hosts: ["www.stats.govt.nz"],
    incremental: "fresh_fetch",
    incremental_note: "The newest 'Selected price indexes' CSV linked from the listing page is fetched fresh and loaded as its own release vintage.",
  },
  {
    source_id: "stats_nz_release_series",
    products: [{ product_id: "P22", mapping_note: "Nine further release files held only by the dedicated series route (234,325 observations). Different files and vintages from the 55,428 above: loaded as separate datasets and releases, never summed with them." }],
    title: "Stats NZ release CSV files: prices, GDP, government finance, employment, migration, population, income and housing costs",
    publisher: "Stats NZ",
    official_url: "https://www.stats.govt.nz/large-datasets/csv-files-for-download/",
    rights_id: "RIGHTS-18",
    route: "dedicated_series",
    upstream: { series_all_datasets: true },
    historical: false,
    live_hosts: [],
    incremental: "none",
    incremental_note: "Each file is one named release; a later release is a different file. New releases are found by the listing source and need a column mapping check before load.",
  },
  {
    source_id: "stats_tenancy_rental_bonds",
    products: [{ product_id: "P23", mapping_note: "All 57,892 records: 57,888 facts (one regional monthly file, 1993-02 to 2026-07) as observations and 4 links as catalogue entries." }],
    title: "Tenancy Services rental bond data: detailed monthly regional measures",
    publisher: "Ministry of Business, Innovation and Employment / Tenancy Services",
    official_url: "https://www.tenancy.govt.nz/rent-bond-and-bills/market-rent/",
    rights_id: "RIGHTS-19",
    route: "operational",
    upstream: { operational_source: "tenancy_rental_bonds" },
    historical: false,
    live_hosts: ["www.tenancy.govt.nz"],
    incremental: "fresh_fetch",
    incremental_note: "The regional monthly CSV linked from the rental bond data page is fetched fresh and loaded as its own release vintage.",
  },
];

export function planFor(sourceId: string): StatsSourcePlan {
  const plan = STATS_SOURCES.find((s) => s.source_id === sourceId);
  if (!plan) throw new Error(`unknown statistics source "${sourceId}". Known: ${STATS_SOURCES.map((s) => s.source_id).join(", ")}`);
  return plan;
}
