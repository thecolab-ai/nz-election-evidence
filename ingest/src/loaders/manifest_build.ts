#!/usr/bin/env node
// Builds the committed source-to-destination reconciliation manifest from the PRIVATE receipts of a combined load.
//
//   node src/loaders/manifest_build.ts <private receipts dir> [--compare <other receipts dir>] --commit <sha> --out <manifest.json> --date YYYY-MM-DD
//
// The receipts directory is what `--receipt-dir` wrote (import/, replay/, reconcile/, optionally refresh/ and
// refresh-blocked/), plus table-content.json (content_digest.ts: row counts AND normalised content digests of every
// data table). --commit is the source commit the proof claims to have tested: every receipt must carry exactly that
// commit from a clean checkout, or the manifest is refused. Counters are aggregated PER POPULATION and never across
// populations. The manifest holds counts, digests, statuses and check names. It never
// holds a run id (they belong to a disposable database), a location on a disk, a connection value or a payload, and
// it is refused if the shared receipt checks find anything of the kind.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { receiptProblems } from "../../../tools/publish_receipts.ts";
import { receiptViolations } from "./access.ts";
import { addWritten, type CountCheck, POPULATIONS, type Population, type TargetReceipt, type WrittenCounts, writtenProblems, zeroWritten } from "./contract.ts";

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

/** Tables whose rows depend on HOW MANY runs were made and when, not on what was loaded. Listed, never compared. */
export const RUN_LEDGER = new Set(["import_runs", "run_checkpoints", "source_observations", "fetch_log", "ingest_errors", "source_leases", "source_freshness", "schedule_dispatch_log", "record_lifecycle_events", "publisher_access_checks"]);

/** What content_digest.ts wrote: per data table, its row count and the digest of its normalised content. */
export interface TableContent { rows: number; content_digest: string; columns_not_compared: { [column: string]: string } }
interface ContentFile { complete: boolean; normalisation: unknown; tables: { [table: string]: TableContent } }

async function tableContent(dir: string): Promise<ContentFile | null> {
  try {
    return JSON.parse(await readFile(join(dir, "table-content.json"), "utf-8")) as ContentFile;
  } catch {
    return null;
  }
}

/** Blocks of the same population added up; populations stay apart. */
export function byPopulation(list: TargetReceipt[]): { [population in Population]?: WrittenCounts } {
  const out: { [population in Population]?: WrittenCounts } = {};
  for (const r of list) for (const population of POPULATIONS) {
    const block = r.counts.written[population];
    if (block) addWritten((out[population] ??= zeroWritten()), block);
  }
  return out;
}

export async function buildManifest(dir: string, date: string, compareDir?: string, commit?: string): Promise<{ [key: string]: unknown }> {
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
  const every = [...imports, ...replays, ...reconciles, ...refreshes, ...blocked, ...afterRefresh];
  const others = compareDir ? (await Promise.all(["import", "replay", "reconcile"].map((stage) => receipts(compareDir, stage)))).flat() : [];

  // The code under test: one clean commit on every receipt of both orders, equal to the one the proof names.
  const revisions = new Set([...every, ...others].map((r) => `${r.provenance.source_revision?.commit ?? "unknown"}${r.provenance.source_revision?.dirty === false ? "" : " (not a clean checkout)"}`));
  if (commit && (revisions.size !== 1 || !revisions.has(commit))) throw new Error(`receipts were not all produced by a clean checkout of ${commit}: ${[...revisions].join(", ")}`);

  // Count invariants, per unit and per population, first pass and replay alike.
  const violations = [...imports.map((r) => ["import", r] as const), ...replays.map((r) => ["replay", r] as const), ...refreshes.map((r) => ["refresh", r] as const)]
    .filter(([, r]) => ["succeeded", "not_reconciled"].includes(r.status))
    .flatMap(([stage, r]) => Object.entries(r.counts.written).flatMap(([population, w]) => writtenProblems(`${stage} ${key(r)} ${population}`, w)));
  const replayInserted = replays.flatMap((r) => Object.entries(r.counts.written).filter(([, w]) => w.inserted > 0).map(([population]) => `${key(r)} ${population}`));

  const mine = await tableContent(dir);
  let orderIndependence: { [key: string]: unknown } | null = null;
  if (compareDir) {
    const other = await tableContent(compareDir);
    const otherReconcile = new Map(others.filter((r) => r.command === "reconcile").map((r) => [key(r), r]));
    const differingUnits = reconciles.filter((r) => JSON.stringify(otherReconcile.get(key(r))?.counts.destination ?? null) !== JSON.stringify(r.counts.destination)
      || JSON.stringify(otherReconcile.get(key(r))?.counts.checks ?? null) !== JSON.stringify(r.counts.checks)).map(key);
    const tables = mine && other ? [...new Set([...Object.keys(mine.tables), ...Object.keys(other.tables)])].sort() : [];
    const data = tables.filter((t) => !RUN_LEDGER.has(t));
    const differingRows = data.filter((t) => (mine!.tables[t]?.rows ?? 0) !== (other!.tables[t]?.rows ?? 0)).map((t) => ({ table: t, this_order: mine!.tables[t]?.rows ?? 0, other_order: other!.tables[t]?.rows ?? 0 }));
    const differingContent = data.filter((t) => (mine!.tables[t]?.content_digest ?? null) !== (other!.tables[t]?.content_digest ?? null)).map((t) => ({ table: t, this_order: mine!.tables[t]?.content_digest ?? null, other_order: other!.tables[t]?.content_digest ?? null }));
    orderIndependence = {
      compared: "the same artifacts loaded into a second fresh database in the opposite family order",
      how: "per data table: the row count, and a digest of every row's content after the stated normalisation (content_digest.ts). Equal digests mean equal content, not only equal counts.",
      content_was_compared: Boolean(mine && other),
      both_digests_complete: Boolean(mine?.complete && other?.complete),
      normalisation: mine?.normalisation ?? null,
      units_compared: reconciles.length, units_with_a_different_reconciliation: differingUnits,
      data_tables_compared: data.length, data_tables_with_rows: data.filter((t) => (mine?.tables[t]?.rows ?? 0) > 0).length,
      data_tables_with_a_different_row_count: differingRows, data_tables_with_different_content: differingContent,
      columns_not_compared: mine ? Object.fromEntries(data.filter((t) => Object.keys(mine.tables[t]?.columns_not_compared ?? {}).length > 0).map((t) => [t, mine.tables[t].columns_not_compared])) : null,
      run_ledger_tables_not_compared: [...RUN_LEDGER].sort(),
      identical: Boolean(mine?.complete && other?.complete) && differingUnits.length === 0 && differingRows.length === 0 && differingContent.length === 0,
    };
  }
  const manifest = {
    manifest_version: 2,
    date,
    what_this_is: "Source-to-destination reconciliation of every import unit, from a combined load of the real private artifacts into an isolated, disposable local database built from the full migration union. Counts, digests and statuses only. Not a hosted load: nothing here was written to a hosted project.",
    rights_note: "Loading changes nothing about rights: every rights row is pending and link-only. A loaded row is not a published row.",
    tested_source: { commit: commit ?? null, every_receipt_from_a_clean_checkout_of_it: Boolean(commit), note: "The receipts pin the commit of the checkout that produced them. This manifest is evidence about that commit only; a later commit that changes source code is not covered by it." },
    totals: {
      units: units.length, units_succeeded: imports.filter((r) => r.status === "succeeded").length,
      units_not_succeeded: imports.filter((r) => r.status !== "succeeded").map((r) => ({ unit: key(r), status: r.status, error_code: r.error_code })),
      populations_note: "Counters are per population (ledger records, statistical observations, catalogue entry versions). They are never added across populations.",
      input_by_population: Object.fromEntries(POPULATIONS.map((population) => [population, sum(imports, (r) => r.counts.input.by_population?.[population] ?? 0)])),
      first_pass: byPopulation(imports),
      replay: { units: replays.length, units_that_inserted_anything: replayInserted, ...byPopulation(replays) },
      count_invariants: { rule: "per unit and population: inserted <= seen, and inserted + unchanged + rejected + conflicts = seen", violations },
      reconcile: { units: reconciles.length, reconciled: reconciles.filter((r) => r.status === "reconciled").length, checks: sum(reconciles, (r) => r.counts.checks.length), checks_failed: sum(reconciles, (r) => failed(r.counts.checks).length) },
      resumed_after_a_hard_stop: imports.filter((r) => r.provenance.resumed_from_run_ids.length > 0).map(key),
    },
    data_tables: mine ? Object.fromEntries(Object.entries(mine.tables).filter(([table, t]) => !RUN_LEDGER.has(table) && t.rows > 0).map(([table, t]) => [table, { rows: t.rows, content_digest: t.content_digest }])) : null,
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
    console.error("usage: manifest_build.ts <private receipts dir> [--compare <other receipts dir>] --commit <sha> --out <manifest.json> --date YYYY-MM-DD");
    process.exit(1);
  }
  const manifest = await buildManifest(resolve(args[0]), date, flag(args, "--compare") ? resolve(flag(args, "--compare")!) : undefined, flag(args, "--commit"));
  await writeFile(resolve(out), JSON.stringify(manifest, null, 2) + "\n");
  console.log("manifest written: " + (manifest.totals as { units: number }).units + " units");
}
