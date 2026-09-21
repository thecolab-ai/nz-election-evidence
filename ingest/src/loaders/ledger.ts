// Shared by the ledger families (core, election, parliament): the refresh route. One implementation of "run the live
// sources of a unit through the guarded runner, or say exactly why a source was not contacted".

import { LIVE_ADAPTERS } from "../../../supabase/functions/_shared/adapters/index.ts";
import { type RunReport, runSource } from "../../../supabase/functions/_shared/runner.ts";
import type { Json, SourcesFile } from "../../../supabase/functions/_shared/types.ts";
import { resolveHost } from "../resolve_host.ts";
import { refreshAccess, sanitize } from "./access.ts";
import { connectWorker, type WorkerConnection } from "./connect.ts";
import { typedDestinationCounts } from "./typed.ts";
import { addWritten, type LoaderContext, type LoaderFamily, type LoaderUnit, newReceipt, settle, type TargetReceipt, writtenOf } from "./contract.ts";

/** Counts, hashes, statuses and publisher links of one ledger run. Payloads are never echoed. */
export function reportDetail(report: RunReport): { [key: string]: Json } {
  return {
    source_id: report.source_id, mode: report.mode, dry_run: report.dry_run, status: report.status, complete_snapshot: report.complete_snapshot,
    error_class: report.error_class, error_detail: report.error_detail ? sanitize(report.error_detail) : null, manifest_hash: report.manifest_hash,
    run_id: report.run_id, resumed_from_run_id: report.resumed_from_run_id, totals: report.totals as unknown as Json, tombstoned: report.tombstoned, pages: report.pages,
    projection: report.projection ?? null, planned_record_count: report.planned_records?.length ?? null,
    fetches: report.fetches.map((f) => ({ url: f.url, outcome: f.outcome, http_status: f.http_status ?? null, bytes: f.bytes ?? null, body_sha256: f.body_sha256 ?? null, retrieved_at: f.retrieved_at })),
  };
}

export function addReport(receipt: TargetReceipt, report: RunReport): void {
  receipt.provenance.manifest_hashes.push(report.manifest_hash);
  if (report.run_id) receipt.provenance.run_ids.push(report.run_id);
  if (report.resumed_from_run_id) receipt.provenance.resumed_from_run_ids.push(report.resumed_from_run_id);
  // A dry run offers nothing to the store, so it has no written block: what it read is a planned count.
  if (report.dry_run) {
    receipt.counts.destination.planned_ledger_records = (receipt.counts.destination.planned_ledger_records ?? 0) + report.totals.seen;
    return;
  }
  addWritten(writtenOf(receipt, "ledger_records"), {
    seen: report.totals.seen, inserted: report.totals.versions_inserted, unchanged: report.totals.unchanged, rejected: report.totals.rejected, conflicts: 0, tombstoned: report.tombstoned,
  });
}

export async function refreshLedgerUnit(family: LoaderFamily, unit: LoaderUnit, file: SourcesFile, ctx: LoaderContext, dryRun: boolean): Promise<TargetReceipt> {
  const receipt = newReceipt(family, unit, "refresh", "live_fetch", "per source");
  if (unit.refresh_source_ids.length === 0) {
    receipt.status = "blocked";
    receipt.error_code = "route_none";
    receipt.error_detail = "this unit has no refresh route; see the route coverage for the reason";
    return receipt;
  }
  const detail: { [key: string]: Json }[] = [];
  const runnable = [];
  for (const sourceId of unit.refresh_source_ids) {
    const source = file.sources.find((s) => s.source_id === sourceId);
    if (!source) throw new Error(`refresh source ${sourceId} is not in the registry`);
    const access = refreshAccess(source);
    if (access.allowed) runnable.push(source);
    else detail.push({ source_id: sourceId, status: "blocked", error_code: access.code, reason: access.reason, contacted: false });
  }
  if (runnable.length === 0) {
    receipt.status = "blocked";
    receipt.error_code = detail.some((d) => d.error_code === "route_pending_decision") && !detail.some((d) => d.error_code === "route_blocked") ? "route_pending_decision" : "route_blocked";
    receipt.error_detail = "no refresh source of this unit may be contacted; nothing was requested and nothing was written";
    receipt.family_detail = detail;
    return receipt;
  }
  let connection: WorkerConnection | null = null;
  const statuses: string[] = [];
  try {
    connection = dryRun ? null : await connectWorker(ctx.env, `evidence-ingest-${family.family}`);
    for (const source of runnable) {
      const adapter = LIVE_ADAPTERS[source.adapter_name];
      if (!adapter) throw new Error(`adapter ${source.adapter_name} not found`);
      // The mode follows the SOURCE that runs, not a flag: a whole-history walk is a backfill however it was asked for.
      const backfill = (unit.alias_source_ids ?? []).includes(source.source_id);
      const report = await runSource({
        file, source, adapter, mode: backfill ? "backfill" : "incremental", triggerKind: "cli", maxRecords: ctx.maxRecords ?? (backfill ? 400000 : 2000),
        maxRuntimeSeconds: ctx.maxRuntimeSeconds ?? (backfill ? 3300 : 300), dryRun, db: connection?.db ?? null, resolveHost, failAfterBatches: ctx.failAfterBatches,
      });
      addReport(receipt, report);
      statuses.push(report.status);
      const entry = reportDetail(report);
      // What this live source now holds in the typed tables, so a refresh is reconciled like a backfill.
      if (connection && (report.status === "succeeded" || report.status === "partial")) {
        const typed = await typedDestinationCounts(connection.sql, source.source_id).catch(() => null);
        entry.typed_destination_rows = typed ? typed.counts : null;
        if (typed) for (const [table, rows] of Object.entries(typed.counts)) receipt.counts.destination[`${source.source_id}:${table}`] = rows;
      }
      detail.push(entry);
    }
  } finally {
    await connection?.close();
  }
  receipt.family_detail = detail;
  if (statuses.some((s) => s === "failed")) {
    receipt.status = "failed";
    receipt.error_code = "run_failed";
  } else if (statuses.some((s) => s === "blocked")) {
    // The publisher refused or challenged: an availability fact, recorded, never worked around and never "no records".
    receipt.status = "blocked";
    receipt.error_code = "route_blocked";
  } else if (statuses.some((s) => s === "skipped_lease_held")) {
    receipt.status = "skipped_lease_held";
    receipt.error_code = "lease_held";
  } else if (statuses.some((s) => s === "partial")) {
    receipt.status = "partial";
    receipt.error_code = "budget_exhausted";
  } else settle(receipt, dryRun ? "dry_run" : "succeeded");
  return receipt;
}
