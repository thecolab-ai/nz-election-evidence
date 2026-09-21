// Election family registry fragment. The coordinator merges this into the shared source registry; nothing here
// edits a shared file. See README.md in this directory for the exact integration steps.
//
// Pins: each export source is pinned to the checksum, row count, record count and wave count of the export that
// was reconciled against the warehouse on 2026-09-20 (receipt: docs/database/receipts/election-family-*.json).
// Any other file fails closed. After a deliberate re-export, update the pins from the new manifest.

import type { ExportContract, SourceConfig, SourcesFile } from "../../../../supabase/functions/_shared/types.ts";
import type { ProductPin } from "./adapter.ts";
import type { AnyProductId } from "./exporter.ts";

export const ELECTION_PINS: { [product in AnyProductId]: ProductPin } = {
  P08: { sha256: "sha256:ff23c5d34f59b40c1a7fbaadef49c250e243401e817663fb224e355667c7f398", rows: 18, records: 18, waves: 1 },
  P09: { sha256: "sha256:d6019eb56f4178f106ed5343c277657cbde200df09aa234914bb060028ff0b3d", rows: 1791, records: 1791, waves: 1 },
  P13: { sha256: "sha256:0311a18df4849c5e9d57c732b6268500f57ba29ca31223287470bace02a6aac1", rows: 75, records: 17, waves: 7 },
  P14: { sha256: "sha256:cf8ceeab7c429e7a9c26546b5175dc9cf0c9df5184c6b05be2b3b8cdd4a4467c", rows: 30, records: 12, waves: 4 },
  P15: { sha256: "sha256:e65bf3088d51a7efba09d1f3586a225c2bb6f4a0f9a8ab01aa64d765cf762734", rows: 492, records: 492, waves: 1 },
  P16: { sha256: "sha256:48b0ff941fa495ef46e5cb754149cd49b30fca5831d6e8a4097b64a0502295e9", rows: 14, records: 14, waves: 1 },
  P17: { sha256: "sha256:40905746969aeefa2c22b9c88c9d5fa7f0fe6060f8a3a5aca3f5fef8d7a3d9db", rows: 23, records: 17, waves: 2 },
  // Cut from the export of 2026-09-21 (receipt: docs/database/receipts/2026-09-21-election-donations.export.json).
  // One row per record: a part of a return, or an itemised entry of a part that reconciled. No history yet, so one wave.
  P25: { sha256: "sha256:0937c821a00ede6fbf9ae863785af0d8bec59ad62684e234365548c27835b792", rows: 1340, records: 1340, waves: 1 },
  P26: { sha256: "sha256:5c8588b8a3fa632a1926669add92bab252188e7181640284fb524d9f6268c4af", rows: 286, records: 286, waves: 1 },
  C26A: { sha256: "sha256:6e505871f3516204924bfe329af4bed0e4fcbbbde8b0eb02552e1a3142adbe0b", rows: 2, records: 1, waves: 2 },
  C26B: { sha256: "sha256:7645d31bc90a38baa602151c6ba1a9b1a534a672eacec889f33eaebe85a254a5", rows: 3, records: 3, waves: 1 },
};

/**
 * The shared validator requires an export_contract on every export source. This one describes the file and
 * deliberately cannot be satisfied by the generic flat importer (no export line carries the marker below), so
 * only the family importer, with its per-kind contracts, can load these sources.
 */
function fileContract(product: AnyProductId, recordKind: string, note: string): ExportContract {
  return {
    fileEnv: `EVIDENCE_EXPORT_ELECTION_${product}`, recordKind, idField: "external_record_id", sourceUrlField: "official_url",
    observedAtField: "collected_at", originalHashField: "original_sha256", allowedFields: [], droppedFields: [],
    expectedRowsNote: note, expectedInput: { sha256: ELECTION_PINS[product].sha256, rows: ELECTION_PINS[product].rows },
    requiredValues: [{ field: "generic_importer_marker", equals: "never_present_use_the_election_family_importer" }],
  };
}

function exportSource(
  product: AnyProductId, sourceId: string, registryKey: string, title: string, publisher: string, officialUrl: string, rightsId: string,
  viewScope: SourceConfig["view_scope"], semantics: SourceConfig["snapshot_semantics"], recordKind: string, note: string,
  catalogue: { product_id: string; mapping_note: string }[],
): SourceConfig {
  return {
    source_id: sourceId, registry_key: registryKey, title, publisher, official_url: officialUrl, adapter_kind: "export_import",
    adapter_name: "election_family_export", allowed_hosts: [], rights_id: rightsId, view_scope: viewScope, snapshot_semantics: semantics,
    enabled: false, catalogue_products: catalogue, export_contract: fileContract(product, recordKind, note),
  };
}

const EC = "Electoral Commission";

export const ELECTION_EXPORT_SOURCES: { product: AnyProductId; source: SourceConfig }[] = [
  { product: "P08", source: exportSource("P08", "election_2023_nationwide_results_export", "election_2023_results",
    "2023 General Election nationwide party-vote table (reconciled upstream export)", EC, "https://www.electionresults.govt.nz/electionresults_2023/",
    "RIGHTS-01", "baseline_2023", "complete_snapshot", "election_nationwide_party_result",
    "18 rows: 17 party lines and the published total line. The 17 lines sum to the published 2,851,211.",
    [{ product_id: "P08", mapping_note: "Whole product: 17 party lines + 1 published total line = 18." }]) },
  { product: "P09", source: exportSource("P09", "election_2023_electorate_results_export", "election_2023_results",
    "2023 General Election results by electorate (reconciled upstream export)", EC, "https://electionresults.govt.nz/electionresults_2023/",
    "RIGHTS-01", "baseline_2023", "complete_snapshot", "election_electorate_vote",
    "1,791 rows: 1,224 party-vote lines, 495 candidate-vote lines, 72 electorate summaries.",
    [{ product_id: "P09", mapping_note: "Whole product. The 495 candidate lines are the same facts as the P04 candidacy votes and are tied to them by identifier; party lines add up to the P08 total. Reconciled, never added." }]) },
  { product: "P13", source: exportSource("P13", "party_policy_pages_2026_export", "party_policy_pages",
    "Registered-party policy pages, 2026 (links, hashes and history; reconciled upstream export)", "Registered New Zealand political parties",
    "https://elections.nz/democracy-in-nz/political-parties-in-new-zealand/register-of-political-parties/",
    "RIGHTS-14", "primary_2026", "complete_snapshot", "party_policy_page",
    "75 rows: 17 policy pages with their full observed history (up to 7 versions each).",
    [{ product_id: "P13", mapping_note: "17 pages, 75 observed versions. Page text is not imported. Upstream labels are kept as unreviewed upstream labels; no policy class is assigned." }]) },
  { product: "P14", source: exportSource("P14", "party_vote_polls_2026_export", "party_vote_polls",
    "Party-vote polls, 90 days to 19 September 2026 (reconciled upstream export)", "Multiple poll publishers",
    "https://en.wikipedia.org/wiki/Opinion_polling_for_the_2026_New_Zealand_general_election",
    "RIGHTS-07", "primary_2026", "rolling_window", "party_vote_poll",
    "30 rows: 12 polls with their observed history. 9 with verified methodology disclosure, 3 unresolved.",
    [{ product_id: "P14", mapping_note: "12 polls, 30 observed versions. Blank cells stay not reported. Source order kept; no ranking or average is derived." }]) },
  { product: "P15", source: exportSource("P15", "finance_2023_candidate_returns_export", "candidate_finance_returns",
    "2023 candidate expense and donation returns: document index (reconciled upstream export)", EC,
    "https://elections.nz/democracy-in-nz/candidates/candidate-expenses-and-donations/",
    "RIGHTS-02", "baseline_2023", "complete_snapshot", "finance_candidate_return",
    "492 document records: 268 with a text layer, 224 image-only. Official link, document hash and the totals the Commission's index page prints.",
    [{ product_id: "P15", mapping_note: "Whole product. No document text, no PDF, nothing read from inside a return." }]) },
  { product: "P16", source: exportSource("P16", "finance_2025_party_aggregates_export", "party_finance_returns",
    "2025 party donations and loans: Commission-published totals (reconciled upstream export)", EC,
    "https://elections.nz/democracy-in-nz/political-parties-in-new-zealand/party-donations-and-loans-by-year/",
    "RIGHTS-04", "finance_2025", "complete_snapshot", "finance_party_aggregate",
    "14 party rows, 28 published totals (donations and loans). Published summaries only, never recomputed.",
    [{ product_id: "P16", mapping_note: "Whole product. Totals as published by the Commission; no donor-level data exists in this route." }]) },
  { product: "P17", source: exportSource("P17", "finance_2025_party_returns_export", "party_finance_returns",
    "2025 party annual returns: document index (reconciled upstream export)", EC,
    "https://elections.nz/democracy-in-nz/political-parties-in-new-zealand/party-donations-and-loans-by-year/",
    "RIGHTS-04", "finance_2025", "complete_snapshot", "finance_party_return",
    "23 rows: 17 documents, 6 of them with a second version recording a bounded visual review of an image-only original.",
    [{ product_id: "P17", mapping_note: "17 documents, 23 versions. Official link, hash and status only; transcriptions are not imported." }]) },
  // The disclosures INSIDE the returns that P15 and P17 index. Each is a separate publication of the same
  // publisher, under the same rights row as the index it belongs to, and is compared with - never added to - the
  // totals the Commission prints on its own pages.
  { product: "P25", source: exportSource("P25", "finance_2023_candidate_return_disclosures_export", "candidate_return_disclosures",
    "2023 candidate returns: the donations, loans and expenses disclosed inside them (reconciled upstream export)", EC,
    "https://elections.nz/democracy-in-nz/candidates/candidate-expenses-and-donations/",
    "RIGHTS-02", "baseline_2023", "complete_snapshot", "donation_return_part",
    "One row per part of each return the Commission's form fills in, plus one row per itemised entry of a part whose entries sum exactly to the form's own printed total. Donor names as the return discloses them; no street address, no document text.",
    [{ product_id: "P25", mapping_note: "Whole product. Read from the return documents P15 indexes; a part that does not reconcile keeps its printed total and publishes no entry." }]) },
  { product: "P26", source: exportSource("P26", "finance_2025_party_return_disclosures_export", "party_return_disclosures",
    "2025 party annual returns: the donations and loans disclosed inside them (reconciled upstream export)", EC,
    "https://elections.nz/democracy-in-nz/political-parties-in-new-zealand/party-donations-and-loans-by-year/",
    "RIGHTS-04", "finance_2025", "complete_snapshot", "donation_return_part",
    "One row per part of each return the Commission's form fills in, plus one row per itemised entry of a part whose entries sum exactly to the form's own printed total. Donor names as the return discloses them; no street address, no document text.",
    [{ product_id: "P26", mapping_note: "Whole product. Read from the return documents P17 indexes; a part that does not reconcile keeps its printed total and publishes no entry." }]) },
  { product: "C26A", source: exportSource("C26A", "election_2026_official_page_status_export", "election_2026_nominations",
    "2026 General Election: availability of the official electorate finder, as observed upstream", EC, "https://vote.nz/maps/find-your-electorate-2026",
    "RIGHTS-21", "primary_2026", "complete_snapshot", "election_2026_official_page_status",
    "1 record, 2 observed versions (identified, then unavailable). Candidate details: unknown. This is an availability record, not a nominations list.",
    []) },
  { product: "C26B", source: exportSource("C26B", "election_2026_boundary_map_links_export", "election_2026_boundaries",
    "2025 boundary review: official summary map links for the 2026 General Election", EC, "https://vote.nz/maps/find-your-electorate-2026",
    "RIGHTS-21", "primary_2026", "complete_snapshot", "election_2026_boundary_map_link",
    "3 official map documents (links and hashes). Not an electorate list: 2026 electorate names are not in the warehouse.",
    []) },
];

/** Registry products this family adds. The other keys it uses already exist in the shared registry. */
export const ELECTION_REGISTRY_PRODUCTS: SourcesFile["registry_products"] = [
  { registry_key: "party_policy_pages", title: "Registered-party policy pages", domain: "Elections" },
  { registry_key: "party_vote_polls", title: "Party-vote polls", domain: "Elections" },
  { registry_key: "candidate_finance_returns", title: "Candidate expense and donation returns", domain: "Political finance" },
  { registry_key: "election_2026_boundaries", title: "2026 General Election boundaries", domain: "Elections" },
  // The disclosures inside the filed returns are their own registry products, so an owner decision about a donor
  // fact names exactly these and can never reach the document indexes they were read from.
  { registry_key: "candidate_return_disclosures", title: "Disclosures inside candidate returns", domain: "Political finance" },
  { registry_key: "party_return_disclosures", title: "Disclosures inside party annual returns", domain: "Political finance" },
];
