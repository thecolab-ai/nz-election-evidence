#!/usr/bin/env node
// Builds the committed source-to-destination reconciliation manifest from the PRIVATE receipts of a combined load.
//
//   node src/loaders/manifest_build.ts <private receipts dir> [--compare <other receipts dir>] --out <manifest.json> --date YYYY-MM-DD
//
// The receipts directory is what `--receipt-dir` wrote (import/, replay/, reconcile/, optionally refresh/ and
// refresh-blocked/, plus table-counts.json). The manifest holds counts, digests, statuses and check names. It never
// holds a run id (they belong to a disposable database), a location on a disk, a connection value or a payload, and
// it is refused if the shared receipt checks find anything of the kind.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { receiptProblems } from "../../../tools/publish_receipts.ts";
import { receiptViolations } from "./access.ts";
import type { CountCheck, TargetReceipt } from "./contract.ts";

async function receipts(dir: string, stage: string): Promise<TargetReceipt[]> {
  let names: string[] = [];
  try {
    names = (await readdir(join(dir, stage))).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: TargetReceipt[] = [];
  for (const name of names) out.push(JSON.parse(await readFile(join(dir, stage, name), "utf-8")) as TargetReceipt);
  return out;
}

const key = (r: TargetReceipt) => `${r.family}/${r.unit}`;
const failed = (checks: CountCheck[]) => checks.filter((c) => !c.ok).map((c) => c.name);

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function tableCounts(dir: string): Promise<{ [table: string]: number } | null> {
  try {
    return JSON.parse(await readFile(join(dir, "table-counts.json"), "utf-8")) as { [table: string]: number };
  } catch {
    return null;
  }
}

/** Tables whose row count depends on HOW MANY runs were made, not on what was loaded. Compared apart. */
const RUN_LEDGER = new Set(["import_runs", "run_checkpoints", "source_observations", "fetch_log", "ingest_errors", "source_leases", "source_freshness", "schedule_dispatch_log", "record_lifecycle_events", "publisher_access_checks"]);

export async function buildManifest(dir: string, date: string, compareDir?: string): Promise<{ [key: string]: unknown }> {
  const [imports, replays, reconciles, refreshes, blocked, afterRefresh] = await Promise.all(
    ["import", "replay", "reconcile", "refresh", "refresh-blocked", "reconcile-after-refresh"].map((stage) => receipts(dir, stage)));
  const replayOf = new Map(replays.map((r) => [key(r), r]));
  const reconcileOf = new Map(reconciles.map((r) => [key(r), r]));
  const units = imports.map((r) => {
    const replay = replayOf.get(key(r));
    const reconcile = reconcileOf.get(key(r));
    return {
      family: r.family, unit: r.unit, writer: r.writer, source_ids: r.source_ids, product_ids: r.product_ids,
      input: { ...r.counts.input, digest: r.provenance.input_digest?.sha256 ?? null, bytes: r.provenance.input_digest?.bytes ?? null, collected_from: r.provenance.collected_from, collected_to: r.provenance.collected_to },
      import: { status: r.status, error_code: r.error_code, attempts: r.attempts, runs: r.provenance.run_ids.length, resumed_runs: r.provenance.resumed_from_run_ids.length, written: r.counts.written, checks_passed: r.counts.checks.filter((c) => c.ok).length, checks_failed: failed(r.counts.checks) },
      replay: replay ? { status: replay.status, written: replay.counts.written, checks_failed: failed(replay.counts.checks) } : null,
      reconcile: reconcile ? { status: reconcile.status, checks: reconcile.counts.checks, typed_destination_rows: reconcile.counts.destination } : null,
    };
  });
  const sum = (list: TargetReceipt[], pick: (r: TargetReceipt) => number) => list.reduce((total, r) => total + pick(r), 0);
  const mine = await tableCounts(dir);
  let orderIndependence: { [key: string]: unknown } | null = null;
  if (compareDir) {
    const other = await tableCounts(compareDir);
    const otherReconcile = new Map((await receipts(compareDir, "reconcile")).map((r) => [key(r), r]));
    const differingUnits = reconciles.filter((r) => JSON.stringify(otherReconcile.get(key(r))?.counts.destination ?? null) !== JSON.stringify(r.counts.destination)
      || JSON.stringify(otherReconcile.get(key(r))?.counts.checks ?? null) !== JSON.stringify(r.counts.checks)).map(key);
    const tables = mine && other ? [...new Set([...Object.keys(mine), ...Object.keys(other)])].sort() : [];
    const differingTables = tables.filter((t) => !RUN_LEDGER.has(t) && (mine![t] ?? 0) !== (other![t] ?? 0)).map((t) => ({ table: t, this_order: mine![t] ?? 0, other_order: other![t] ?? 0 }));
    orderIndependence = {
      compared: "the same artifacts loaded into a fresh database in the opposite family order (statistics, parliament, election, then the 2023 candidacy product last)",
      units_compared: reconciles.length, units_with_a_different_reconciliation: differingUnits,
      data_tables_compared: tables.filter((t) => !RUN_LEDGER.has(t)).length, data_tables_with_a_different_row_count: differingTables,
      run_ledger_tables_not_compared: [...RUN_LEDGER].sort(),
      identical: differingUnits.length === 0 && differingTables.length === 0,
    };
  }
  const manifest = {
    manifest_version: 1,
    date,
    what_this_is: "Source-to-destination reconciliation of every import unit, from a combined load of the real private artifacts into an isolated, disposable local database built from the full migration union. Counts, digests and statuses only. Not a hosted load: nothing here was written to a hosted project.",
    rights_note: "Loading changes nothing about rights: every rights row is pending and link-only. A loaded row is not a published row.",
    totals: {
      units: units.length, units_succeeded: imports.filter((r) => r.status === "succeeded").length,
      input_rows: sum(imports, (r) => r.counts.input.rows ?? 0),
      first_pass: { seen: sum(imports, (r) => r.counts.written.seen), inserted: sum(imports, (r) => r.counts.written.inserted), rejected: sum(imports, (r) => r.counts.written.rejected), conflicts: sum(imports, (r) => r.counts.written.conflicts), tombstoned: sum(imports, (r) => r.counts.written.tombstoned) },
      replay: { units: replays.length, inserted: sum(replays, (r) => r.counts.written.inserted), unchanged: sum(replays, (r) => r.counts.written.unchanged), rejected: sum(replays, (r) => r.counts.written.rejected), conflicts: sum(replays, (r) => r.counts.written.conflicts), tombstoned: sum(replays, (r) => r.counts.written.tombstoned) },
      reconcile: { units: reconciles.length, reconciled: reconciles.filter((r) => r.status === "reconciled").length, checks: sum(reconciles, (r) => r.counts.checks.length), checks_failed: sum(reconciles, (r) => failed(r.counts.checks).length) },
      resumed_after_a_hard_stop: imports.filter((r) => r.provenance.resumed_from_run_ids.length > 0).map(key),
    },
    data_table_rows: mine ? Object.fromEntries(Object.entries(mine).filter(([table, rows]) => !RUN_LEDGER.has(table) && rows > 0)) : null,
    order_independence: orderIndependence,
    units,
    refresh_runs: refreshes.map((r) => ({ family: r.family, unit: r.unit, source_ids: r.source_ids, status: r.status, error_code: r.error_code, written: r.counts.written, checks_failed: failed(r.counts.checks) })),
    refresh_routes_not_contacted: blocked.map((r) => ({ family: r.family, unit: r.unit, source_ids: r.source_ids, status: r.status, error_code: r.error_code, runs_started: r.provenance.run_ids.length })),
    reconcile_after_refresh: afterRefresh.length ? { units: afterRefresh.length, reconciled: afterRefresh.filter((r) => r.status === "reconciled").length, not_reconciled: afterRefresh.filter((r) => r.status !== "reconciled").map(key) } : null,
  };
  const text = JSON.stringify(manifest);
  const problems = [...receiptProblems(text), ...receiptViolations(manifest)];
  if (/"run_id"|"run_ids"|"resumed_from_run_id/.test(text)) problems.push("a run id");
  if (problems.length) throw new Error("the manifest holds something that may not be published: " + [...new Set(problems)].slice(0, 5).join("; "));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const out = flag(args, "--out");
  const date = flag(args, "--date");
  if (!args[0] || !out || !date) {
    console.error("usage: manifest_build.ts <private receipts dir> [--compare <other receipts dir>] --out <manifest.json> --date YYYY-MM-DD");
    process.exit(1);
  }
  const manifest = await buildManifest(resolve(args[0]), date, flag(args, "--compare") ? resolve(flag(args, "--compare")!) : undefined);
  await writeFile(resolve(out), JSON.stringify(manifest, null, 2) + "\n");
  console.log("manifest written: " + (manifest.totals as { units: number }).units + " units");
}
