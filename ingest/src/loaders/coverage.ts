// Route coverage of the 26 catalogue products, stated per source and checked by tests against the registry and the
// catalogue. Each state is a claim about something that was DONE (or could not be), with where the evidence is.
// A product is never "covered" by a row that was not loaded, and a blocked route is never an empty result.

import type { SourcesFile } from "../../../supabase/functions/_shared/types.ts";

export type RouteKind = "backfill" | "refresh" | "probe";

export type RouteState =
  | "loaded_and_reconciled"          // backfill: GRANTED ONLY BY EVIDENCE (grantedState): the committed manifest shows this unit loaded, replayed without an insert, and reconciled
  | "built_not_proven"               // backfill: the route is built and tested, but no committed manifest shows a reconciled load of it
  | "working"                        // refresh: run against the publisher end to end, records stored or re-observed
  | "working_cli_only"               // refresh: works from the CLI; the input is larger than the scheduled function's budget
  | "exercised_not_run_in_full"      // refresh: proven on a bounded run; the full walk has not been made
  | "disabled_pending_person"        // refresh: works technically; waits on a recorded decision by a person
  | "blocked_publisher_challenge"    // the publisher answers this host with a challenge or a refusal; never worked around
  | "blocked_off_allowlist"          // the publisher now redirects to a host that is not on the allowlist; not widened
  | "probe_only";                    // records availability only; never a count

export interface SourceRoute { kind: RouteKind; state: RouteState; evidence: string }

/** The committed evidence of a combined load. It names the source commit it tested; it is absent until such a proof is committed. */
export const MANIFEST_PATH = "docs/database/receipts/unified/reconciliation-manifest.json";
const COMBINED = `a combined load on an isolated stack, recorded in ${MANIFEST_PATH}. The state is granted only while that manifest shows this unit loaded, replayed without an insert, and reconciled`;
const CHALLENGE = "publisher challenged or refused this host on 2026-09-20 (one attempt, not worked around)";

export const SOURCE_ROUTES: { [sourceId: string]: SourceRoute } = {
  // core
  nz_parliament_mp_directory: { kind: "refresh", state: "working", evidence: "fresh run stored 122 members, 2026-09-20 (docs/database/source-reconciliation.md)" },
  nz_parliament_current_bills: { kind: "refresh", state: "working", evidence: "fresh run stored 93 bills, 2026-09-20" },
  nz_government_releases_feed: { kind: "refresh", state: "working", evidence: "fresh run stored 10 releases, 2026-09-20; a feed does not reach back" },
  nz_parliament_written_questions: { kind: "probe", state: "blocked_off_allowlist", evidence: "superseded by the two written-question sources below; the old address redirects off the allowlist" },
  ec_register_of_political_parties: { kind: "probe", state: "blocked_publisher_challenge", evidence: CHALLENGE },
  ec_2026_nominations: { kind: "probe", state: "blocked_publisher_challenge", evidence: CHALLENGE + "; no nominations are published or loaded" },
  ec_2023_official_results: { kind: "probe", state: "blocked_publisher_challenge", evidence: CHALLENGE },
  ec_party_finance_returns: { kind: "probe", state: "blocked_publisher_challenge", evidence: CHALLENGE },
  baseline_2023_candidacies_export: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  // election
  election_2023_nationwide_results_export: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  election_2023_electorate_results_export: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  party_policy_pages_2026_export: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  party_vote_polls_2026_export: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  finance_2023_candidate_returns_export: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  finance_2025_party_aggregates_export: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  finance_2025_party_returns_export: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  finance_2023_candidate_return_disclosures_export: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  finance_2025_party_return_disclosures_export: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  election_2026_official_page_status_export: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  election_2026_boundary_map_links_export: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  party_vote_polls_index: { kind: "refresh", state: "working", evidence: "real run stored 50 index rows; an incremental run re-observed 18 (docs/database/receipts/2026-09-20-party_vote_polls_index.*.json)" },
  party_policy_pages_2026_monitor: { kind: "refresh", state: "working", evidence: "real run: 16 of 17 pages retrieved, 1 challenged and recorded as unavailable (docs/database/receipts/2026-09-20-party_policy_pages_2026_monitor.run1.json)" },
  ec_2023_candidate_returns_index: { kind: "probe", state: "blocked_publisher_challenge", evidence: CHALLENGE },
  ec_2026_electorate_finder: { kind: "probe", state: "blocked_publisher_challenge", evidence: CHALLENGE },
  // parliament
  parliament_export_releases_history: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  parliament_export_release_attributions: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  parliament_export_bill_publications: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  parliament_export_current_bills_history: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  parliament_export_bill_register: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  parliament_export_committee_business: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  parliament_export_committee_report_files: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  parliament_export_committee_reports: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  parliament_export_member_terms: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  parliament_export_minister_roles: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  parliament_export_written_questions: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  nz_parliament_written_questions_recent: { kind: "refresh", state: "working", evidence: "stored run through this CLI against the publisher, 2026-09-20: 21 paced requests, 2,000 records, stopped at its record budget with a checkpoint and resumed by the next call (a pass over two months is a chain of such calls). Not yet run on a schedule" },
  nz_parliament_written_questions_backfill: { kind: "refresh", state: "exercised_not_run_in_full", evidence: "about 1,900 paced requests; never run end to end. History rests on the export route" },
  nz_parliament_committee_reports: { kind: "refresh", state: "working", evidence: "complete walk against the publisher, 2026-09-20 (LIVE-NOTES.md)" },
  nz_parliament_committee_business: { kind: "refresh", state: "working", evidence: "dry run against the publisher, 2026-09-20: 123 items, 123 content hashes identical to the export route" },
  nz_parliament_bill_publications: { kind: "refresh", state: "disabled_pending_person", evidence: "robots.txt disallows the versions-index path (advisory) and the index rule was checked on three bills only" },
  nz_government_releases_listing: { kind: "refresh", state: "blocked_publisher_challenge", evidence: CHALLENGE + "; the listing markup has never been observed, so its parser is unverified" },
  // statistics
  stats_healthnz_data: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  stats_msd_benefits: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  stats_rbnz_catalogue: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  stats_nz_census_2018_highlights: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  stats_nz_census_2013_meshblock: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  stats_nz_csv_catalogue: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  stats_nz_census_2023: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  stats_nz_selected_series: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  stats_nz_release_series: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
  stats_tenancy_rental_bonds: { kind: "backfill", state: "loaded_and_reconciled", evidence: COMBINED },
};

/** Statistics sources are one registry entry with two routes: the artifact backfill and, for six of them, a fresh fetch. */
export const STATS_REFRESH: { [sourceId: string]: SourceRoute } = {
  stats_healthnz_data: { kind: "refresh", state: "working_cli_only", evidence: "listing page only, 26 links, 2026-09-20. Facts need a person's cell-mapping review per workbook: no unattended fact refresh" },
  stats_msd_benefits: { kind: "refresh", state: "working_cli_only", evidence: "statistics index only, 26 links, 2026-09-20. Facts need a person's review per quarterly workbook" },
  stats_rbnz_catalogue: { kind: "refresh", state: "working_cli_only", evidence: "public catalogue API, 18 entries, 2026-09-20 (robots.txt disallow recorded as an advisory)" },
  stats_nz_csv_catalogue: { kind: "refresh", state: "working_cli_only", evidence: "listing page, 120 file entries, 2026-09-20" },
  stats_nz_selected_series: { kind: "refresh", state: "working_cli_only", evidence: "newest selected price indexes CSV: 59,983 observations as their own release vintage, 2026-09-20" },
  stats_tenancy_rental_bonds: { kind: "refresh", state: "working_cli_only", evidence: "regional monthly CSV: 57,888 observations, byte-identical to the backfill, all unchanged, 2026-09-20" },
};

/** Why a product has no working refresh route, where that is the case. Null means at least one refresh route works. */
export const REFRESH_GAPS: { [productId: string]: string } = {
  P02: "The live route works from the CLI but is disabled pending a person's decision (robots.txt advisory on the versions path; index rule checked on three bills).",
  P04: "Final 2023 results do not change, and the Electoral Commission's sites challenge this host. Backfill only.",
  P06: "Report files have no listing of their own; they are reached through the reports index (P07), which has a working refresh route. No file is ever downloaded.",
  P08: "Final 2023 results do not change, and the Electoral Commission's sites challenge this host. Backfill only.",
  P09: "Final 2023 results do not change, and the Electoral Commission's sites challenge this host. Backfill only.",
  P15: "The Electoral Commission's index page challenges this host. Backfill only.",
  P16: "The Electoral Commission's page challenges this host. Backfill only.",
  P17: "The Electoral Commission's page challenges this host. Backfill only.",
  P25: "The Electoral Commission's index page challenges this host, and a return once filed does not change. Backfill only. The donations-over-$20,000 notices published separately during an election year are on a page that is challenged too, and are not collected.",
  P26: "The Electoral Commission's page challenges this host, and a return once filed does not change; an amended return is published as its own document. Backfill only. The donations-over-$20,000 notices published separately during an election year are on a page that is challenged too, and are not collected.",
  P19: "A closed historical release published as a ZIP archive; the text-only fetch client cannot read it. Nothing to refresh.",
  P21: "Workbooks mapped by hand; the publisher's observation API needs a subscription key and is not used.",
};

/** What the 2026 election routes do NOT hold. Unknown and unpublished, never zero and never "none". */
export const UNPUBLISHED_2026 = [
  "2026 nominations and party lists: not published to this project by any route; the last upstream observation is official_page_unavailable with candidate details unknown.",
  "2026 register of political parties: not loaded; the upstream store holds only parties registered at the 2023 election, unverified for 2026.",
  "2026 electorates: number and names unknown here; only three official boundary summary map links are loaded, as links.",
];

export interface ProductCoverage {
  product_id: string;
  title: string;
  catalogue_record_count: number;
  backfill: { source_id: string; state: RouteState; evidence: string }[];
  refresh: { source_id: string; state: RouteState; evidence: string }[];
  probes: { source_id: string; state: RouteState; evidence: string }[];
  has_loaded_backfill: boolean;
  has_working_refresh: boolean;
  refresh_gap: string | null;
}

const WORKING: ReadonlySet<RouteState> = new Set(["working", "working_cli_only"]);

/** The part of the committed manifest a coverage state may rest on. */
export interface ManifestEvidence {
  tested_source?: { commit: string | null };
  units: { source_ids: string[]; import: { status: string }; replay: { status: string; written: { [population: string]: { inserted: number } } } | null; reconcile: { status: string } | null }[];
}

/**
 * A claim that something was DONE is never hand-written: "loaded_and_reconciled" is granted to a backfill source only by
 * the committed manifest, and only when it shows the unit imported, replayed without a single insert, and reconciled.
 * Without that (no manifest, or a unit it does not show) the state is "built_not_proven".
 */
export function grantedState(sourceId: string, route: SourceRoute, evidence: ManifestEvidence | null): SourceRoute {
  if (route.state !== "loaded_and_reconciled") return route;
  const unit = evidence?.units.find((u) => u.source_ids.includes(sourceId));
  const proven = unit !== undefined && unit.import.status === "succeeded" && unit.reconcile?.status === "reconciled"
    && unit.replay?.status === "succeeded" && Object.values(unit.replay.written).every((w) => w.inserted === 0);
  if (proven) return { ...route, evidence: `${route.evidence} (tested source commit ${evidence?.tested_source?.commit ?? "not stated"})` };
  return { kind: route.kind, state: "built_not_proven", evidence: evidence ? `${MANIFEST_PATH} does not show this unit loaded, replayed without an insert, and reconciled` : `no reconciliation manifest is committed (${MANIFEST_PATH}); nothing is claimed about a load` };
}

export function productCoverage(file: SourcesFile, catalogue: { product_id: string; title: string; record_count: number }[], evidence: ManifestEvidence | null = null): ProductCoverage[] {
  return catalogue.map((product) => {
    const sources = file.sources.filter((s) => (s.catalogue_products ?? []).some((p) => p.product_id === product.product_id));
    const routes = sources.flatMap((s) => {
      const out = [{ source_id: s.source_id, ...grantedState(s.source_id, SOURCE_ROUTES[s.source_id], evidence) }];
      if (STATS_REFRESH[s.source_id]) out.push({ source_id: s.source_id, ...STATS_REFRESH[s.source_id] });
      return out;
    });
    const pick = (kind: RouteKind) => routes.filter((r) => r.kind === kind).map(({ source_id, state, evidence }) => ({ source_id, state, evidence }));
    const refresh = pick("refresh");
    const working = refresh.some((r) => WORKING.has(r.state));
    return {
      product_id: product.product_id, title: product.title, catalogue_record_count: product.record_count,
      backfill: pick("backfill"), refresh, probes: pick("probe"),
      has_loaded_backfill: pick("backfill").some((r) => r.state === "loaded_and_reconciled"), has_working_refresh: working,
      refresh_gap: working ? null : REFRESH_GAPS[product.product_id] ?? null,
    };
  });
}
