// Typed destination tally, shared by every family's reconcile: rows of each domain table that the store can PROVE came
// from one source (the same lineage register that governs the public projections). Counts only.

import type postgres from "postgres";
import { sanitize } from "./access.ts";
import { check, type TargetReceipt } from "./contract.ts";

export async function typedDestinationCounts(sql: postgres.Sql, sourceId: string): Promise<{ counts: { [table: string]: number }; notReadable: string[] }> {
  const [{ r }] = await sql`select evidence_private.typed_destination_counts(${sourceId}) as r`;
  const counts: { [table: string]: number } = {};
  let notReadable: string[] = [];
  for (const [table, value] of Object.entries((r ?? {}) as { [key: string]: unknown })) {
    if (table === "__not_readable_by_caller__") notReadable = value as string[];
    else if (typeof value === "number" && value > 0) counts[table] = value;
  }
  return { counts, notReadable };
}

/** The data tables the worker has no reason to read; a source's rows can only be there through a reviewer's decision. */
const NOT_WRITTEN_BY_THE_WORKER = new Set(["party_registrations", "release_items", "staged_unmatched_results", "version_bill_links", "version_electorate_links", "version_party_links", "version_person_links"]);

/**
 * Puts the tally into the receipt. A tally that cannot be read is a failed check, never an exception: by the time it
 * runs the import is already committed, and hiding that behind an error would misreport what happened.
 */
export async function addTypedTally(receipt: TargetReceipt, sql: postgres.Sql, sourceId: string): Promise<{ [table: string]: number }> {
  try {
    const { counts, notReadable } = await typedDestinationCounts(sql, sourceId);
    receipt.counts.destination = { ...receipt.counts.destination, ...counts };
    const unexpected = notReadable.filter((table) => !NOT_WRITTEN_BY_THE_WORKER.has(table));
    check(receipt, "typed tables the tally could not read", 0, unexpected.length);
    return counts;
  } catch (error) {
    check(receipt, "typed destination tally could be read", "yes", "no: " + sanitize(error instanceof Error ? error.message : String(error)).slice(0, 160));
    return {};
  }
}
