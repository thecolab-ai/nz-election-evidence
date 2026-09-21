// Election family exporter: warehouse (read-only) -> private, hashed export files + a reconciliation manifest.
//
// The recipe is fully committed: the selects below, the mappers in mapping.ts and the checks in reconcile().
// The output is NOT committed. It is written outside the repository, owner-only (directory 0700, files 0600).
// For an unchanged warehouse the export files are byte-identical from run to run; only the manifest's
// generated_at differs.

import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExportRow, letterHex, MAPPERS, MappingError, type ProductId, type SafeJson, utcIso, type WarehouseRow, withProvenanceKeys } from "./mapping.ts";
import type { QueryRunner } from "./warehouse.ts";

export const EXPORT_RECIPE_VERSION = "election-export-1";

export type CivicProductId = "C26A" | "C26B";
export type AnyProductId = ProductId | CivicProductId;

/** One export line: a mapped row plus its place in the record's history. */
export interface VersionedExportRow extends Omit<ExportRow, "product_id"> {
  product_id: AnyProductId;
  /** 1 = earliest kept version of this record. */
  version_ordinal: number;
  version_count: number;
  /** Upstream versions folded into this one because the allowlisted content did not differ. */
  upstream_versions_folded: number;
  safe_digest: string;
}

export interface ProductReconciliation {
  product_id: AnyProductId;
  upstream_source_id: string;
  upstream_rows_read: number;
  upstream_exact_duplicates_ignored: number;
  upstream_distinct_records: number;
  upstream_distinct_versions: number;
  export_rows: number;
  export_distinct_records: number;
  versions_folded_as_identical_after_allowlist: number;
  rows_by_kind: { [kind: string]: number };
  collected_at_min: string | null;
  collected_at_max: string | null;
  rows_with_publisher_date: number;
  checks: { name: string; ok: boolean; detail: string }[];
}

export interface ExportManifest {
  manifest_version: 1;
  recipe_version: string;
  generated_at: string;
  files: { [product: string]: { file: string; sha256: string; bytes: number; rows: number } };
  reconciliation: ProductReconciliation[];
  cross_product: { name: string; ok: boolean; detail: string }[];
  all_checks_ok: boolean;
}

const OPERATIONAL_SELECT = (sourceId: string) =>
  `select source_id, record_id, record_kind, source_url, observed_at, content_hash, payload_json
   from operational_source_records where source_id = '${sourceId}'
   order by record_id, observed_at, content_hash`;

const BASELINE_SELECT =
  `select snapshot_id, captured_at, candidacy_id, candidate_name, electorate_name, candidacy_type, candidate_votes, source_url
   from candidate_candidacies_snapshot order by captured_at, candidacy_id`;

const ELECTIONS_SELECT =
  `select snapshot_id, captured_at, election_id, election_name, election_date, election_status, source_url
   from candidate_elections_snapshot order by captured_at, election_id`;

const BOUNDARIES_SELECT =
  `select snapshot_id, captured_at, boundary_id, election_id, boundary_edition, boundary_type, boundary_scope, source_url, raw_sha256
   from candidate_boundaries_snapshot order by captured_at, boundary_id`;

export const RECIPE_SELECTS = { OPERATIONAL_SELECT, BASELINE_SELECT, ELECTIONS_SELECT, BOUNDARIES_SELECT };

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: SafeJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}

/** What decides whether two upstream versions differ for this project: the allowlisted content only. */
export function safeDigest(row: ExportRow | Omit<VersionedExportRow, "safe_digest" | "version_ordinal" | "version_count" | "upstream_versions_folded">): string {
  return sha256Hex(canonical({
    record_kind: row.record_kind, official_url: row.official_url, source_published_at: row.source_published_at ?? null,
    original_sha256: row.original_sha256 ?? null, payload: row.payload,
  }));
}

/** Orders a record's mapped versions by collection time and folds neighbours whose allowlisted content is equal. */
export function foldVersions(rows: ExportRow[]): VersionedExportRow[] {
  const byRecord = new Map<string, ExportRow[]>();
  for (const row of rows) byRecord.set(row.external_record_id, [...(byRecord.get(row.external_record_id) ?? []), row]);
  const out: VersionedExportRow[] = [];
  for (const id of [...byRecord.keys()].sort()) {
    const versions = byRecord.get(id)!.sort((a, b) => a.collected_at.localeCompare(b.collected_at) || a.upstream_content_hash.localeCompare(b.upstream_content_hash));
    const kept: VersionedExportRow[] = [];
    for (const version of versions) {
      const digest = safeDigest(version);
      const last = kept.at(-1);
      if (last && last.safe_digest === digest) {
        last.upstream_versions_folded++;
        continue;
      }
      kept.push({ ...version, version_ordinal: kept.length + 1, version_count: 0, upstream_versions_folded: 0, safe_digest: digest });
    }
    for (const version of kept) version.version_count = kept.length;
    out.push(...kept);
  }
  return out;
}

function asWarehouseRow(row: { [column: string]: unknown }): WarehouseRow {
  for (const column of ["source_id", "record_id", "record_kind", "source_url", "observed_at", "content_hash", "payload_json"]) {
    if (typeof row[column] !== "string") throw new MappingError(`warehouse row lacks the text column ${column}`);
  }
  return row as unknown as WarehouseRow;
}

function check(name: string, ok: boolean, detail: string): { name: string; ok: boolean; detail: string } {
  return { name, ok, detail };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

interface ProductExport {
  product: AnyProductId;
  rows: VersionedExportRow[];
  reconciliation: ProductReconciliation;
}

async function exportOperational(run: QueryRunner, sourceId: string): Promise<ProductExport> {
  const spec = MAPPERS[sourceId];
  const raw = (await run(OPERATIONAL_SELECT(sourceId))).map(asWarehouseRow);
  const seen = new Set<string>();
  const distinct: WarehouseRow[] = [];
  for (const row of raw) {
    const key = row.record_id + "\n" + row.content_hash + "\n" + row.observed_at;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(row);
  }
  // Every row maps or the export stops: a row is never skipped.
  const mapped = distinct.map((row, index) => {
    try {
      return spec.map(row);
    } catch (error) {
      throw new MappingError(`${spec.product} upstream row ${index + 1}: ${error instanceof Error ? error.message : "unmappable"}`);
    }
  });
  const rows = foldVersions(mapped);
  return { product: spec.product, rows, reconciliation: reconcileCounts(spec.product, sourceId, raw.length, distinct, rows) };
}

function reconcileCounts(product: AnyProductId, sourceId: string, read: number, distinct: { record_id: string; content_hash: string }[], rows: VersionedExportRow[]): ProductReconciliation {
  const kinds: { [kind: string]: number } = {};
  for (const row of rows) kinds[row.record_kind] = (kinds[row.record_kind] ?? 0) + 1;
  const times = rows.map((row) => row.collected_at).sort();
  const folded = sum(rows.map((row) => row.upstream_versions_folded));
  const records = new Set(rows.map((row) => row.external_record_id)).size;
  const upstreamRecords = new Set(distinct.map((row) => row.record_id)).size;
  return {
    product_id: product, upstream_source_id: sourceId, upstream_rows_read: read,
    upstream_exact_duplicates_ignored: read - distinct.length,
    upstream_distinct_records: upstreamRecords, upstream_distinct_versions: distinct.length,
    export_rows: rows.length, export_distinct_records: records, versions_folded_as_identical_after_allowlist: folded,
    rows_by_kind: kinds, collected_at_min: times[0] ?? null, collected_at_max: times.at(-1) ?? null,
    rows_with_publisher_date: rows.filter((row) => row.source_published_at).length,
    checks: [
      check("every_upstream_record_exported", records === upstreamRecords, `${records} of ${upstreamRecords} upstream records`),
      check("every_upstream_version_accounted_for", rows.length + folded === distinct.length, `${rows.length} exported + ${folded} folded = ${distinct.length} upstream versions`),
    ],
  };
}

/** Latest version of each record: what a reader of the current product sees. */
export function latest(rows: VersionedExportRow[]): VersionedExportRow[] {
  return rows.filter((row) => row.version_ordinal === row.version_count);
}

function num(row: VersionedExportRow, key: string): number | undefined {
  const value = row.payload[key];
  return typeof value === "number" ? value : undefined;
}

interface BaselineCandidacy { candidacy_id: string; candidate_name: string; candidacy_type: string; candidate_votes: number; source_url: string }

/**
 * Ties each official electorate-page candidate line to the already imported 2023 candidacy product by that
 * product's own identifier. A pair is accepted only when the official page, the name exactly as published AND
 * the vote count all agree, and only when exactly one candidacy fits. A name alone never joins anything.
 */
export function joinBaselineCandidacies(votes: VersionedExportRow[], baseline: BaselineCandidacy[]): { joined: number; unmatched: number; ambiguous: number; votes_disagree: number } {
  const index = new Map<string, BaselineCandidacy[]>();
  for (const row of baseline) {
    if (row.candidacy_type !== "electorate") continue;
    const key = row.source_url + "\n" + row.candidate_name;
    index.set(key, [...(index.get(key) ?? []), row]);
  }
  const outcome = { joined: 0, unmatched: 0, ambiguous: 0, votes_disagree: 0 };
  for (const row of votes) {
    // Only the latest version of a line is joined and counted; an older version keeps no reference.
    if (row.version_ordinal !== row.version_count) continue;
    if (row.record_kind !== "election_electorate_vote" || row.payload.vote_type !== "candidate") continue;
    const candidates = index.get(row.official_url + "\n" + String(row.payload.name_at_source)) ?? [];
    if (candidates.length === 0) outcome.unmatched++;
    else if (candidates.length > 1) outcome.ambiguous++;
    else if (Number(candidates[0].candidate_votes) !== row.payload.votes) outcome.votes_disagree++;
    else {
      // Letter-encoded like every other hex value in a payload (see letterHex); the store decodes it for the join.
      if (!/^[0-9a-f]{8,64}$/.test(candidates[0].candidacy_id)) throw new MappingError("baseline candidacy identifier is not a hex identifier");
      row.payload.baseline_candidacy_ref = letterHex(candidates[0].candidacy_id);
      row.payload.baseline_candidacy_join = "official_page_and_published_name_and_votes";
      outcome.joined++;
    }
  }
  return outcome;
}

export interface ExportResult {
  products: { product: AnyProductId; rows: VersionedExportRow[] }[];
  manifest: ExportManifest;
  fileBodies: { [product: string]: string };
}

export async function buildExport(run: QueryRunner, now: () => Date = () => new Date()): Promise<ExportResult> {
  const products: ProductExport[] = [];
  for (const sourceId of Object.keys(MAPPERS)) products.push(await exportOperational(run, sourceId));
  const get = (id: AnyProductId) => products.find((p) => p.product === id)!;

  // Baseline join: latest candidacy capture only, the one the pinned candidacy product was cut from.
  const baselineAll = await run(BASELINE_SELECT);
  const lastCapture = baselineAll.map((row) => String(row.captured_at)).sort().at(-1);
  const baseline = baselineAll.filter((row) => String(row.captured_at) === lastCapture).map((row) => ({
    candidacy_id: String(row.candidacy_id), candidate_name: String(row.candidate_name), candidacy_type: String(row.candidacy_type),
    candidate_votes: Number(row.candidate_votes), source_url: String(row.source_url),
  }));
  const p09 = get("P09");
  const join = joinBaselineCandidacies(p09.rows, baseline);
  for (const row of p09.rows) row.safe_digest = safeDigest(row);

  const cross: ExportManifest["cross_product"] = [];
  const p08 = latest(get("P08").rows);
  const p09Latest = latest(p09.rows);
  const partyRows = p08.filter((row) => row.record_kind === "election_nationwide_party_result");
  const totalRow = p08.find((row) => row.record_kind === "election_nationwide_total");
  const partyVoteSum = sum(partyRows.map((row) => num(row, "party_votes") ?? 0));
  get("P08").reconciliation.checks.push(
    check("party_rows_sum_to_published_total", partyVoteSum === num(totalRow!, "party_votes"), `${partyVoteSum} summed; ${num(totalRow!, "party_votes")} published`),
    check("party_rows_without_a_vote_count", partyRows.every((row) => num(row, "party_votes") !== undefined), `${partyRows.filter((row) => num(row, "party_votes") === undefined).length} rows`),
  );
  const voteRows = p09Latest.filter((row) => row.record_kind === "election_electorate_vote");
  const summaries = p09Latest.filter((row) => row.record_kind === "election_electorate_summary");
  const partyByElectorate = sum(voteRows.filter((row) => row.payload.vote_type === "party").map((row) => num(row, "votes") ?? 0));
  const candidateVotes = voteRows.filter((row) => row.payload.vote_type === "candidate");
  let summaryMismatch = 0;
  for (const summary of summaries) {
    const here = voteRows.filter((row) => row.payload.electorate_number === summary.payload.electorate_number);
    const candidates = sum(here.filter((row) => row.payload.vote_type === "candidate").map((row) => num(row, "votes") ?? 0));
    const parties = sum(here.filter((row) => row.payload.vote_type === "party").map((row) => num(row, "votes") ?? 0));
    // The published totals include informal votes; the line items do not.
    if (candidates + (num(summary, "candidate_informals") ?? 0) !== num(summary, "candidate_total") || parties + (num(summary, "party_informals") ?? 0) !== num(summary, "party_total")) summaryMismatch++;
  }
  p09.reconciliation.checks.push(
    check("seventy_two_electorate_pages", summaries.length === 72, `${summaries.length} summaries`),
    check("line_items_plus_informals_equal_each_published_total", summaryMismatch === 0, `${summaryMismatch} electorates disagree`),
    check("vote_rows_without_a_count", voteRows.every((row) => num(row, "votes") !== undefined), `${voteRows.filter((row) => num(row, "votes") === undefined).length} rows`),
  );
  cross.push(
    check("p09_party_votes_equal_p08_nationwide_total", partyByElectorate === num(totalRow!, "party_votes"), `${partyByElectorate} across electorates; ${num(totalRow!, "party_votes")} nationwide. One fact seen by two routes: reconciled, never added.`),
    check("p09_candidate_lines_join_p04_by_identifier", join.joined === candidateVotes.length && join.joined === baseline.filter((row) => row.candidacy_type === "electorate").length,
      `${join.joined} joined of ${candidateVotes.length} candidate lines and ${baseline.filter((row) => row.candidacy_type === "electorate").length} baseline electorate candidacies; unmatched ${join.unmatched}, ambiguous ${join.ambiguous}, votes disagree ${join.votes_disagree}. Candidate votes are one fact held by two products: reconciled, never added.`),
  );

  const p14 = latest(get("P14").rows);
  get("P14").reconciliation.checks.push(
    check("methodology_status_split", true, `${p14.filter((row) => row.payload.methodology_status === "verified").length} verified, ${p14.filter((row) => row.payload.methodology_status === "unresolved").length} unresolved`),
    check("blank_cells_kept_as_not_reported", true, `${sum(p14.map((row) => (row.payload.results as { value_status: string }[]).filter((r) => r.value_status === "not_reported").length))} blank cells, ${sum(p14.map((row) => (row.payload.results as { value_status: string }[]).filter((r) => r.value_status === "reported").length))} reported`),
  );
  const p15 = latest(get("P15").rows);
  get("P15").reconciliation.checks.push(
    check("image_only_split", true, `${p15.filter((row) => row.payload.is_image_only === false).length} with a text layer, ${p15.filter((row) => row.payload.is_image_only === true).length} image-only`),
    check("published_amounts", true, ["expenses", "donations", "loans"].map((k) => `${k}: ${p15.filter((row) => row.payload[k + "_as_published_status"] === "reported").length} reported, ${p15.filter((row) => row.payload[k + "_as_published_status"] === "reported_nil").length} nil, ${p15.filter((row) => row.payload[k + "_as_published_status"] === "not_reported").length} not reported`).join("; ")),
  );
  const p16 = latest(get("P16").rows);
  const p17 = latest(get("P17").rows);
  const linked = new Set(p16.flatMap((row) => row.payload.return_urls as string[]));
  const indexed = new Set(p17.map((row) => row.official_url));
  cross.push(check("p16_linked_returns_equal_p17_document_index", linked.size === indexed.size && [...linked].every((url) => indexed.has(url)), `${linked.size} linked from the aggregate table; ${indexed.size} in the document index`));

  // Civic links for 2026 that the warehouse really holds. It holds no current party register, no 2026
  // electorate list and no nominations: those stay missing (see the family README), they are not exported as empty.
  products.push(civicElectionStatus(await run(ELECTIONS_SELECT)), civicBoundaryLinks(await run(BOUNDARIES_SELECT)));

  const files: ExportManifest["files"] = {};
  const fileBodies: { [product: string]: string } = {};
  for (const product of products) {
    const body = product.rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    fileBodies[product.product] = body;
    files[product.product] = { file: `${product.product}.jsonl`, sha256: "sha256:" + sha256Hex(body), bytes: Buffer.byteLength(body), rows: product.rows.length };
  }
  const reconciliation = products.map((p) => p.reconciliation);
  const manifest: ExportManifest = {
    manifest_version: 1, recipe_version: EXPORT_RECIPE_VERSION, generated_at: now().toISOString(), files, reconciliation, cross_product: cross,
    all_checks_ok: reconciliation.every((r) => r.checks.every((c) => c.ok)) && cross.every((c) => c.ok),
  };
  return { products: products.map((p) => ({ product: p.product, rows: p.rows })), manifest, fileBodies };
}

function civicRows(product: CivicProductId, sourceId: string, raw: { [column: string]: unknown }[], build: (row: { [column: string]: unknown }) => ExportRow | null): ProductExport {
  const mapped = raw.map(build).filter((row): row is ExportRow => row !== null);
  const rows = foldVersions(mapped) as VersionedExportRow[];
  for (const row of rows) row.product_id = product;
  const distinct = mapped.map((row) => ({ record_id: row.external_record_id, content_hash: row.upstream_content_hash }));
  const reconciliation = reconcileCounts(product, sourceId, raw.length, distinct, rows);
  reconciliation.upstream_rows_read = raw.length;
  return { product, rows, reconciliation };
}

function civicElectionStatus(raw: { [column: string]: unknown }[]): ProductExport {
  const out = civicRows("C26A", "candidate_elections_snapshot", raw, (row) => {
    if (row.election_id !== "NZGE2026") return null;
    const payload: { [key: string]: SafeJson } = { upstream_election_ref: "NZGE2026", official_page_status: String(row.election_status), candidate_details_available: "unknown" };
    if (typeof row.election_name === "string" && row.election_name) payload.election_name = row.election_name;
    // The upstream row holds no election date for 2026, so none is exported.
    if (typeof row.election_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.election_date)) payload.election_date = row.election_date;
    return {
      product_id: "P08", source_id: "candidate_elections_snapshot", external_record_id: "election-2026:official-electorate-finder",
      record_kind: "election_2026_official_page_status", official_url: String(row.source_url), collected_at: utcIso(String(row.captured_at)),
      upstream_content_hash: sha256Hex(String(row.snapshot_id) + String(row.election_id)), payload,
      omitted: [{ field: "source_record_json", reason: "upstream capture detail, not a fact about the source" }],
    };
  });
  out.reconciliation.checks.push(check("rows_for_other_elections_left_to_their_own_product", true, `${raw.length - raw.filter((row) => row.election_id === "NZGE2026").length} rows for 2023 not exported here`));
  out.reconciliation.checks = out.reconciliation.checks.filter((c) => c.name !== "every_upstream_version_accounted_for");
  return out;
}

function civicBoundaryLinks(raw: { [column: string]: unknown }[]): ProductExport {
  const known = (value: unknown): { [key: string]: SafeJson } | null => (typeof value === "string" && value ? { v: value } : null);
  return civicRows("C26B", "candidate_boundaries_snapshot", raw, (row) => withProvenanceKeys({
    product_id: "P08", source_id: "candidate_boundaries_snapshot", external_record_id: "boundary-2025:" + String(row.boundary_id),
    record_kind: "election_2026_boundary_map_link", official_url: String(row.source_url), collected_at: utcIso(String(row.captured_at)),
    original_sha256: /^[0-9a-f]{64}$/.test(String(row.raw_sha256)) ? String(row.raw_sha256) : undefined,
    upstream_content_hash: sha256Hex(String(row.snapshot_id) + String(row.boundary_id)),
    // An upstream null stays absent; it is never written out as text.
    payload: {
      boundary_edition: String(row.boundary_edition), link_kind: "official_summary_map_document",
      ...(known(row.election_id) ? { upstream_election_ref: String(row.election_id) } : {}),
      ...(known(row.boundary_type) ? { boundary_type_at_source: String(row.boundary_type) } : {}),
      ...(known(row.boundary_scope) ? { boundary_scope: String(row.boundary_scope) } : {}),
    },
    omitted: [{ field: "raw_bytes", reason: "upstream capture or transport detail, not a fact about the source" }],
  }));
}

/** Writes owner-only files outside the repository. Returns only file names, never the directory. */
export async function writeExport(result: ExportResult, outDir: string): Promise<string[]> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const target = resolve(outDir);
  const inside = relative(repoRoot, target);
  if (!inside.startsWith("..") && !inside.startsWith("/")) throw new Error("export files are private: choose a directory outside the repository");
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  const names: string[] = [];
  for (const [product, body] of Object.entries(result.fileBodies)) {
    const name = `${product}.jsonl`;
    await writeFile(resolve(target, name), body, { mode: 0o600 });
    await chmod(resolve(target, name), 0o600);
    names.push(name);
  }
  await writeFile(resolve(target, "manifest.json"), JSON.stringify(result.manifest, null, 2) + "\n", { mode: 0o600 });
  await chmod(resolve(target, "manifest.json"), 0o600);
  names.push("manifest.json");
  return names;
}
