// Source-to-destination reconciliation: what the export says must exist, against what the store holds.
// Read-only. Counts and sums only; no row content leaves the database.

import type postgres from "postgres";
import { contentHash } from "../../../../supabase/functions/_shared/canonical.ts";
import type { Json } from "../../../../supabase/functions/_shared/types.ts";
import type { LoadedProduct } from "./adapter.ts";
import { toIngestRecord } from "./adapter.ts";
import { type AnyProductId, latest, type VersionedExportRow } from "./exporter.ts";
import { ELECTION_EXPORT_SOURCES } from "./registry_fragment.ts";

export interface Expected { product: AnyProductId; source_id: string; expect: { [name: string]: number } }

type Item = { [key: string]: unknown };

function count<T>(rows: T[], test: (row: T) => boolean): number {
  return rows.filter(test).length;
}

function total(rows: VersionedExportRow[], key: string): number {
  return rows.reduce((sum, row) => sum + (typeof row.payload[key] === "number" ? (row.payload[key] as number) : 0), 0);
}

/**
 * Every counter the two return-disclosure products reconcile on. Named once so the expected side and the
 * destination side cannot name different things, and so a source that wrote nothing still reports zeros.
 */
const DONATION_COUNTERS = [
  "donation_return_parts", "donation_return_parts_reconciled", "donation_return_parts_with_a_printed_total",
  "donation_return_parts_total_cents", "donation_disclosures", "donation_disclosures_named",
  "donation_disclosures_withheld_by_publisher", "donation_disclosures_not_separable",
  "donation_disclosures_amount_cents", "donation_disclosures_duplicated_entries",
] as const;

/** Money as whole cents, so a source-to-destination comparison never turns on a float. */
function cents(rows: VersionedExportRow[], key: string): number {
  return rows.reduce((sum, row) => sum + (typeof row.payload[key] === "number" ? Math.round((row.payload[key] as number) * 100) : 0), 0);
}

export async function expectedDestination(loaded: LoadedProduct): Promise<Expected> {
  const source = ELECTION_EXPORT_SOURCES.find((e) => e.product === loaded.product)!.source;
  const now = latest(loaded.rows);
  const versions = new Set<string>();
  for (const row of loaded.rows) versions.add(row.external_record_id + "\n" + (await contentHash(row.record_kind, 1, row.payload as { [key: string]: Json })));
  const expect: { [name: string]: number } = { source_records: now.length, record_versions: versions.size, tombstoned_records: 0, rejected_records: 0 };
  const kind = (name: string) => now.filter((row) => row.record_kind === name);
  switch (loaded.product) {
    case "P08": {
      const parties = kind("election_nationwide_party_result");
      Object.assign(expect, {
        election_party_totals: parties.length, election_party_totals_votes_sum: total(parties, "party_votes"),
        election_party_totals_with_seats: count(parties, (r) => typeof r.payload.list_seats === "number" || typeof r.payload.electorate_seats === "number"),
        election_result_totals: kind("election_nationwide_total").length, election_result_totals_votes: total(kind("election_nationwide_total"), "party_votes"),
      });
      break;
    }
    case "P09": {
      const votes = kind("election_electorate_vote");
      const party = votes.filter((r) => r.payload.vote_type === "party");
      const candidate = votes.filter((r) => r.payload.vote_type === "candidate");
      Object.assign(expect, {
        party_results: party.length, party_results_votes_sum: total(party, "votes"),
        electorate_result_summaries: kind("election_electorate_summary").length,
        candidate_route_checks: candidate.length, candidate_route_checks_votes_sum: total(candidate, "votes"),
        candidate_results_written_by_this_source: 0,
      });
      break;
    }
    case "P13":
      Object.assign(expect, { documents: now.length, policy_sources: now.length, policy_sources_unknown_class_no_basis: now.length, policy_sources_with_a_class: 0 });
      break;
    case "P14": {
      const cells = now.flatMap((r) => r.payload.results as Item[]);
      Object.assign(expect, {
        documents: now.length, polls: now.length, polls_methodology_verified: count(now, (r) => r.payload.methodology_status === "verified"),
        polls_methodology_unresolved: count(now, (r) => r.payload.methodology_status === "unresolved"), poll_results: cells.length,
        poll_results_reported: count(cells, (c) => c.value_status === "reported"), poll_results_not_reported: count(cells, (c) => c.value_status === "not_reported"),
      });
      break;
    }
    case "P15": {
      const status = (metric: string, value: string) => count(now, (r) => r.payload[`${metric}_as_published_status`] === value);
      Object.assign(expect, {
        documents: now.length, finance_return_references: now.length, finance_return_references_image_only: count(now, (r) => r.payload.is_image_only === true),
        finance_return_references_linked_to_a_candidacy: 0, published_aggregates: now.length * 3,
        published_aggregates_reported: status("expenses", "reported") + status("donations", "reported") + status("loans", "reported"),
        published_aggregates_reported_nil: status("expenses", "reported_nil") + status("donations", "reported_nil") + status("loans", "reported_nil"),
        published_aggregates_not_reported: status("expenses", "not_reported") + status("donations", "not_reported") + status("loans", "not_reported"),
      });
      break;
    }
    case "P16": {
      const items = now.flatMap((r) => r.payload.aggregates as Item[]);
      Object.assign(expect, {
        published_aggregates: items.length, published_aggregates_reported: count(items, (i) => i.value_status === "reported"),
        published_aggregates_reported_nil: count(items, (i) => i.value_status === "reported_nil"),
        published_aggregates_not_reported: count(items, (i) => i.value_status === "not_reported"), documents: 0,
      });
      break;
    }
    case "P17":
      Object.assign(expect, { documents: now.length, finance_return_references: now.length, finance_return_references_image_only: count(now, (r) => r.payload.is_image_only === true) });
      break;
    // P25 and P26 are the same two record kinds, so they reconcile the same way. Without these the two products
    // would be checked only by their source-record count, and a projection that wrote no typed row at all - or
    // wrote a different amount than the export carries - would still reconcile. The money is compared in whole
    // cents, because that is how the part's own arithmetic gate compares it.
    case "P25":
    case "P26": {
      const parts = kind("donation_return_part");
      const entries = kind("donation_disclosure_entry");
      const status = (value: string) => count(entries, (r) => r.payload.donor_name_status === value);
      Object.assign(expect, {
        donation_return_parts: parts.length,
        donation_return_parts_reconciled: count(parts, (r) => r.payload.itemisation_status === "reconciled"),
        donation_return_parts_with_a_printed_total: count(parts, (r) => typeof r.payload.disclosed_total_nzd === "number"),
        donation_return_parts_total_cents: cents(parts, "disclosed_total_nzd"),
        donation_disclosures: entries.length,
        donation_disclosures_named: status("published"),
        donation_disclosures_withheld_by_publisher: status("withheld_by_publisher"),
        donation_disclosures_not_separable: status("not_separable"),
        donation_disclosures_amount_cents: cents(entries, "disclosed_amount_nzd"),
        // Two documents of one source may describe the same part of the same filer's return for the same year -
        // an original and its amendment. Both are held, because both were filed. What must never happen is the
        // SAME itemised entry arriving twice: that would show a reader one donation as two.
        donation_disclosures_duplicated_entries: 0,
      });
      break;
    }
    case "C26A":
      Object.assign(expect, { election_official_page_status: now.length, official_page_unavailable: count(now, (r) => r.payload.official_page_status === "official_page_unavailable") });
      break;
    case "C26B":
      Object.assign(expect, { documents: now.length, boundary_map_links: now.length });
      break;
  }
  return { product: loaded.product, source_id: source.source_id, expect };
}

/** One grouped read per destination. Every count is scoped to a source through foreign keys. */
export async function destinationCounts(sql: postgres.Sql): Promise<{ [sourceId: string]: { [name: string]: number } }> {
  const ids = ELECTION_EXPORT_SOURCES.map((e) => e.source.source_id);
  const out: { [sourceId: string]: { [name: string]: number } } = {};
  const put = (rows: Item[]) => {
    for (const row of rows) {
      const target = (out[String(row.source_id)] ??= {});
      for (const [key, value] of Object.entries(row)) if (key !== "source_id") target[key] = Number(value ?? 0);
    }
  };
  for (const id of ids) out[id] = {};
  put(await sql`select r.source_id, count(*) as source_records, count(*) filter (where r.tombstoned_at is not null) as tombstoned_records
    from evidence_private.source_records r where r.source_id = any(${ids}) group by 1`);
  put(await sql`select r.source_id, count(*) as record_versions from evidence_private.source_record_versions v
    join evidence_private.source_records r on r.id = v.record_id where r.source_id = any(${ids}) group by 1`);
  put(await sql`select i.source_id, coalesce(sum(i.rejected), 0) as rejected_records from evidence_private.import_runs i where i.source_id = any(${ids}) group by 1`);
  put(await sql`select r.source_id, count(*) as documents from evidence_private.documents d
    join evidence_private.source_records r on r.id = d.source_record_id where r.source_id = any(${ids}) group by 1`);
  // Sources that hold no document still report an explicit zero.
  for (const id of ids) out[id].documents ??= 0;
  const bySet = (table: string) => sql`select sr.source_id, t.* from evidence_private.${sql(table)} t
    join evidence_private.result_sets rs on rs.id = t.result_set_id
    join evidence_private.source_record_versions sv on sv.id = rs.source_version_id
    join evidence_private.source_records sr on sr.id = sv.record_id where sr.source_id = any(${ids})`;
  const group = (rows: Item[], build: (rows: Item[]) => { [name: string]: number }) => {
    const bySource = new Map<string, Item[]>();
    for (const row of rows) bySource.set(String(row.source_id), [...(bySource.get(String(row.source_id)) ?? []), row]);
    for (const [source, list] of bySource) Object.assign((out[source] ??= {}), build(list));
  };
  const sumOf = (rows: Item[], key: string) => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);
  group(await bySet("election_party_totals"), (rows) => ({
    election_party_totals: rows.length, election_party_totals_votes_sum: sumOf(rows, "party_votes"),
    election_party_totals_with_seats: count(rows, (r) => r.list_seats !== null || r.electorate_seats !== null),
  }));
  group(await bySet("election_result_totals"), (rows) => ({ election_result_totals: rows.length, election_result_totals_votes: sumOf(rows, "party_votes") }));
  group(await bySet("party_results"), (rows) => ({ party_results: rows.length, party_results_votes_sum: sumOf(rows, "votes") }));
  group(await bySet("electorate_result_summaries"), (rows) => ({ electorate_result_summaries: rows.length }));
  const written = await bySet("candidate_results");
  for (const id of ids) if (id.includes("electorate_results")) out[id].candidate_results_written_by_this_source = written.filter((r) => r.source_id === id).length;

  const checks = await sql`select r.source_id, c.check_kind, c.outcome, c.this_route_votes, c.other_route_votes from evidence_private.result_route_checks c
    join evidence_private.source_record_versions v on v.id = c.evidence_version_id join evidence_private.source_records r on r.id = v.record_id
    where r.source_id = any(${ids})`;
  group(checks.filter((c) => c.check_kind === "candidate_votes_same_fact"), (rows) => ({ candidate_route_checks: rows.length, candidate_route_checks_votes_sum: sumOf(rows, "this_route_votes") }));
  const outcomes: { [key: string]: number } = {};
  for (const c of checks) outcomes[`${c.check_kind}:${c.outcome}`] = (outcomes[`${c.check_kind}:${c.outcome}`] ?? 0) + 1;
  out.__cross_route__ = outcomes;

  const viaDocument = (table: string, key: string) => sql`select r.source_id, t.* from evidence_private.${sql(table)} t
    join evidence_private.documents d on d.id = t.${sql(key)} join evidence_private.source_records r on r.id = d.source_record_id where r.source_id = any(${ids})`;
  group(await viaDocument("policy_sources", "document_id"), (rows) => ({
    policy_sources: rows.length, policy_sources_unknown_class_no_basis: count(rows, (r) => r.policy_class === "unknown" && r.classification_basis === "none" && r.model_run_id === null),
    policy_sources_with_a_class: count(rows, (r) => r.policy_class !== "unknown"),
  }));
  group(await viaDocument("polls", "document_id"), (rows) => ({
    polls: rows.length, polls_methodology_verified: count(rows, (r) => r.methodology_status === "verified"), polls_methodology_unresolved: count(rows, (r) => r.methodology_status === "unresolved"),
  }));
  group(await viaDocument("poll_results", "poll_document_id"), (rows) => ({
    poll_results: rows.length, poll_results_reported: count(rows, (r) => r.value_status === "reported" && r.value_pct !== null),
    poll_results_not_reported: count(rows, (r) => r.value_status === "not_reported" && r.value_pct === null),
  }));
  group(await viaDocument("finance_return_references", "document_id"), (rows) => ({
    finance_return_references: rows.length, finance_return_references_image_only: count(rows, (r) => r.is_image_only === true),
    finance_return_references_linked_to_a_candidacy: count(rows, (r) => r.candidacy_id !== null),
  }));
  group(await viaDocument("boundary_map_links", "document_id"), (rows) => ({ boundary_map_links: rows.length }));
  group(await sql`select r.source_id, a.value_status, a.amount_nzd from evidence_private.finance_published_aggregates a
    join evidence_private.source_records r on r.id = a.source_record_id where r.source_id = any(${ids})`, (rows) => ({
    published_aggregates: rows.length, published_aggregates_reported: count(rows, (r) => r.value_status === "reported" && r.amount_nzd !== null),
    published_aggregates_reported_nil: count(rows, (r) => r.value_status === "reported_nil" && Number(r.amount_nzd) === 0),
    published_aggregates_not_reported: count(rows, (r) => r.value_status === "not_reported" && r.amount_nzd === null),
  }));
  // The two return-disclosure products. Every count is scoped to a source through the source record the row
  // hangs off, exactly as the others are, and the money is read as whole cents.
  group(await sql`select r.source_id, p.itemisation_status, p.disclosed_total_nzd from evidence_private.donation_return_parts p
    join evidence_private.source_records r on r.id = p.source_record_id where r.source_id = any(${ids})`, (rows) => ({
    donation_return_parts: rows.length,
    donation_return_parts_reconciled: count(rows, (r) => r.itemisation_status === "reconciled"),
    donation_return_parts_with_a_printed_total: count(rows, (r) => r.disclosed_total_nzd !== null),
    donation_return_parts_total_cents: rows.reduce((s, r) => s + Math.round(Number(r.disclosed_total_nzd ?? 0) * 100), 0),
  }));
  group(await sql`select r.source_id, d.donor_name_status, d.disclosed_amount_nzd from evidence_private.donation_disclosures d
    join evidence_private.source_records r on r.id = d.source_record_id where r.source_id = any(${ids})`, (rows) => ({
    donation_disclosures: rows.length,
    donation_disclosures_named: count(rows, (r) => r.donor_name_status === "published"),
    donation_disclosures_withheld_by_publisher: count(rows, (r) => r.donor_name_status === "withheld_by_publisher"),
    donation_disclosures_not_separable: count(rows, (r) => r.donor_name_status === "not_separable"),
    donation_disclosures_amount_cents: rows.reduce((s, r) => s + Math.round(Number(r.disclosed_amount_nzd ?? 0) * 100), 0),
  }));
  // An original return and its amendment are two documents, and both are held. The same ENTRY arriving from both
  // would show a reader one donation as two, so it is counted here and expected to be zero. Grouped on what
  // identifies the disclosure rather than on the document it came from: the filer, the year, the part and the
  // entry's own printed position.
  group(await sql`select r.source_id, count(*) as donation_disclosures_duplicated_entries from (
      select r2.source_id, d.return_kind, d.reporting_year,
             coalesce(d.party_name_as_published, ''), coalesce(d.candidate_name_as_published, ''),
             coalesce(d.electorate_as_published, ''), d.disclosure_part, d.entry_index
        from evidence_private.donation_disclosures d
        join evidence_private.source_records r2 on r2.id = d.source_record_id
       where r2.source_id = any(${ids})
       group by 1, 2, 3, 4, 5, 6, 7, 8
      having count(distinct d.official_url) > 1
    ) r group by 1`, (rows) => ({ donation_disclosures_duplicated_entries: Number(rows[0]?.donation_disclosures_duplicated_entries ?? 0) }));
  // A destination count that is absent is not the same as zero, and a missing key fails its check rather than
  // passing quietly. A disclosure source that wrote no entry at all still reports an explicit zero for each.
  for (const entry of ELECTION_EXPORT_SOURCES) {
    if (entry.product !== "P25" && entry.product !== "P26") continue;
    const target = (out[entry.source.source_id] ??= {});
    for (const name of DONATION_COUNTERS) target[name] ??= 0;
  }

  group(await sql`select r.source_id, s.page_status from evidence_private.election_official_page_status s
    join evidence_private.source_record_versions v on v.id = s.evidence_version_id join evidence_private.source_records r on r.id = v.record_id
    where r.source_id = any(${ids})`, (rows) => ({ election_official_page_status: rows.length, official_page_unavailable: count(rows, (r) => r.page_status === "official_page_unavailable") }));
  return out;
}

/** (record, content hash) pairs the store already holds for a source. */
export async function storedVersions(sql: postgres.Sql, sourceId: string): Promise<Set<string>> {
  const rows = await sql`select r.external_record_id, v.content_hash from evidence_private.source_record_versions v
    join evidence_private.source_records r on r.id = v.record_id where r.source_id = ${sourceId}`;
  return new Set(rows.map((row) => row.external_record_id + "\n" + row.content_hash));
}

/** Records whose current version in the store is not the export's latest version (or that are missing). */
export async function currentVersionMismatches(sql: postgres.Sql, sourceId: string, loaded: LoadedProduct): Promise<number> {
  const rows = await sql`select r.external_record_id, v.content_hash from evidence_private.source_records r
    join evidence_private.source_record_versions v on v.id = r.current_version_id where r.source_id = ${sourceId}`;
  const current = new Map(rows.map((row) => [String(row.external_record_id), String(row.content_hash)]));
  let mismatches = 0;
  for (const row of latest(loaded.rows)) if (current.get(row.external_record_id) !== (await toIngestRecord(row)).content_hash) mismatches++;
  return mismatches;
}
