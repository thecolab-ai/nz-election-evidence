// Statistics family behind the loader contract. The destination stays typed and the writer stays the family's own bulk
// writer (ingest_stat_meta / ingest_stat_observations, 5,000 rows a call): nothing here turns an observation into a
// generic ledger record. What is shared is the orchestration: private-input rules, leases, checkpoints, retries, statuses,
// error codes and the count receipt.

import { join } from "node:path";
import type { Json } from "../../../../supabase/functions/_shared/types.ts";
import { artifactRoot, type OpenArtifact, openArtifact, readObservations } from "../../families/stats/artifact.ts";
import { FRESH_ROOT_SUFFIX } from "../../families/stats/live.ts";
import { connectLoader, type DestinationCounts, LOADER_VERSION, type LoadReceipt, loadSource } from "../../families/stats/loader.ts";
import { STATS_SOURCES, planFor } from "../../families/stats/routes.ts";
import { assertPrivateInput } from "../access.ts";
import { connectWorker } from "../connect.ts";
import { check, type CountReceipt, type LoaderContext, type LoaderFamily, type LoaderUnit, newReceipt, settle, type TargetReceipt } from "../contract.ts";
import { addTypedTally } from "../typed.ts";

const ADAPTER = "stats_family_artifact";
const WITHHELD = new Set(["suppressed", "confidential", "missing", "not_applicable", "flag_marker"]);

/**
 * The written blocks of a statistics load, from what the STORE reported for each population. A block exists only for a
 * population the unit holds: a source of catalogue metadata only has no observation block. A catalogue version whose
 * observation span merely widened is an unchanged version (nothing new was stored about the publisher's catalogue).
 */
export function statWritten(manifestCounts: { observations: number; catalogue_entries: number }, totals: LoadReceipt["totals"]): CountReceipt["written"] {
  const written: CountReceipt["written"] = {};
  const o = totals.observations;
  const meta = totals.meta;
  if (manifestCounts.observations > 0 || o.seen > 0) {
    written.stat_observations = { seen: o.seen, inserted: o.inserted, unchanged: o.unchanged, rejected: 0, conflicts: o.conflicts, tombstoned: 0 };
  }
  if (manifestCounts.catalogue_entries > 0 || (meta.catalogue_entries_seen ?? 0) > 0) {
    written.stat_catalogue_entries = { seen: meta.catalogue_entries_seen ?? 0, inserted: meta.catalogue_entries_inserted ?? 0, unchanged: meta.catalogue_entries_unchanged ?? 0, rejected: 0, conflicts: 0, tombstoned: 0 };
  }
  return written;
}

export function statsFamily(): LoaderFamily {
  const family: LoaderFamily = {
    family: "statistics",
    writer: "typed_statistics_bulk_writer",
    units: () => STATS_SOURCES.map((plan) => ({
      unit: plan.source_id, family: "statistics" as const, product_ids: plan.products.map((p) => p.product_id),
      backfill_source_ids: [plan.source_id], refresh_source_ids: plan.incremental === "none" ? [] : [plan.source_id],
    })),

    async plan(unit, ctx) {
      const receipt = newReceipt(family, unit, "plan", ADAPTER, LOADER_VERSION);
      const artifact = await open(ctx, unit.unit, false);
      describe(receipt, artifact);
      const route = planFor(unit.unit);
      receipt.family_detail = { route: route.route, historical: route.historical, incremental: route.incremental, overlap_counted_not_imported: route.upstream.overlap ?? null, observations_by_dataset: artifact.manifest.counts.observations_by_dataset, files: artifact.manifest.files.length } as unknown as Json;
      receipt.status = "planned";
      return receipt;
    },

    async validate(unit, ctx) {
      const receipt = newReceipt(family, unit, "validate", ADAPTER, LOADER_VERSION);
      const artifact = await open(ctx, unit.unit, false);   // re-hashes every file against the manifest
      describe(receipt, artifact);
      let rows = 0;
      let withheldWithNumber = 0;
      const byStatus: { [status: string]: number } = {};
      for (const file of artifact.observationFiles) {
        for await (const row of readObservations(artifact, file)) {   // validates every row against the closed contract
          rows++;
          byStatus[row.value_status] = (byStatus[row.value_status] ?? 0) + 1;
          if (WITHHELD.has(row.value_status) && (row.value !== null || row.value_double !== null)) withheldWithNumber++;
        }
      }
      check(receipt, "observation rows read = manifest count", artifact.manifest.counts.observations, rows);
      check(receipt, "rows under a withheld status that carry a number", 0, withheldWithNumber);
      check(receipt, "source differences left unexplained by the exporter", 0, artifact.manifest.reconciliation.filter((l) => l.explanation.startsWith("UNEXPLAINED")).length);
      receipt.family_detail = { observations_by_status: byStatus, source_to_artifact: artifact.manifest.reconciliation } as unknown as Json;
      return settle(receipt, "valid");
    },

    import: (unit, ctx, dryRun) => load(unit, ctx, dryRun, false),

    async refresh(unit, ctx, dryRun) {
      const plan = planFor(unit.unit);
      if (plan.incremental === "none") {
        const receipt = newReceipt(family, unit, "refresh", "stats_family_fetch", LOADER_VERSION);
        receipt.status = "blocked";
        receipt.error_code = "route_none";
        receipt.error_detail = plan.incremental_note;
        return receipt;
      }
      const root = await artifactRoot(ctx.env);
      await assertPrivateInput(root, "statistics artifact root");
      const { fetchSource } = await import("../../families/stats/live.ts");
      const fetched = await fetchSource(plan, root, { log: ctx.log });
      if (fetched.status !== "ok") {
        const receipt = newReceipt(family, unit, "refresh", "stats_family_fetch", LOADER_VERSION);
        receipt.status = fetched.status === "blocked" || fetched.status === "no_incremental_route" ? "blocked" : "failed";
        receipt.error_code = fetched.status === "blocked" ? "route_blocked" : fetched.status === "no_incremental_route" ? "route_none" : "run_failed";
        receipt.error_detail = fetched.reason ?? fetched.error_detail ?? null;
        receipt.family_detail = fetched as unknown as Json;
        return receipt;
      }
      const receipt = await load(unit, ctx, dryRun, true);
      receipt.family_detail = { fetch: fetched, load: receipt.family_detail } as unknown as Json;
      return receipt;
    },

    async reconcile(unit, ctx) {
      const receipt = newReceipt(family, unit, "reconcile", ADAPTER, LOADER_VERSION);
      const artifact = await open(ctx, unit.unit, false);
      describe(receipt, artifact);
      const db = await connectLoader(ctx.env);
      let destination: DestinationCounts;
      try {
        destination = await db.counts(unit.unit);
      } finally {
        await db.close();
      }
      const connection = await connectWorker(ctx.env, "evidence-ingest-statistics");
      try {
        await addTypedTally(receipt, connection.sql, unit.unit);
      } finally {
        await connection.close();
      }
      // The store may also hold later vintages from a refresh, so the backfill artifact is checked release by release.
      const perRelease = new Map<string, number>();
      for (const file of artifact.observationFiles) for await (const row of readObservations(artifact, file)) perRelease.set(`${row.dataset_key} @ ${row.release_key}`, (perRelease.get(`${row.dataset_key} @ ${row.release_key}`) ?? 0) + 1);
      for (const [key, rows] of [...perRelease].sort()) check(receipt, `observations of ${key}`, rows, destination.observations_by_release[key] ?? 0);
      check(receipt, "catalogue entry versions in the store >= versions in the artifact", "true", String(destination.catalogue_entry_versions >= artifact.manifest.counts.catalogue_entries));
      check(receipt, "rows under a withheld status that carry a number", 0, destination.withheld_rows_carrying_a_number);
      receipt.family_detail = { destination } as unknown as Json;
      return settle(receipt, "reconciled");
    },
  };

  async function open(ctx: LoaderContext, sourceId: string, fresh: boolean): Promise<OpenArtifact> {
    const root = await artifactRoot(ctx.env);
    await assertPrivateInput(root, "statistics artifact root");
    const from = fresh ? join(root, FRESH_ROOT_SUFFIX) : root;
    await assertPrivateInput(join(from, sourceId), `statistics artifact ${sourceId}`);
    return openArtifact(from, sourceId);
  }

  function describe(receipt: TargetReceipt, artifact: OpenArtifact): void {
    const m = artifact.manifest;
    receipt.provenance.input_digest = { sha256: artifact.digest, bytes: m.files.reduce((sum, f) => sum + f.bytes, 0), rows: m.files.reduce((sum, f) => sum + f.rows, 0) };
    receipt.provenance.collected_from = m.collected_from;
    receipt.provenance.collected_to = m.collected_to;
    // Two populations, stated apart. `rows` is the number of artifact lines of both kinds; records and versions are not
    // used by this family (an observation is not a ledger record, a catalogue entry version is not a record version).
    const by: { stat_observations?: number; stat_catalogue_entries?: number } = {};
    if (m.counts.observations > 0) by.stat_observations = m.counts.observations;
    if (m.counts.catalogue_entries > 0) by.stat_catalogue_entries = m.counts.catalogue_entries;
    receipt.counts.input = { rows: m.counts.observations + m.counts.catalogue_entries, records: null, versions: null, by_population: by };
  }

  async function load(unit: LoaderUnit, ctx: LoaderContext, dryRun: boolean, fresh: boolean): Promise<TargetReceipt> {
    const receipt = newReceipt(family, unit, fresh ? "refresh" : dryRun ? "dry-run" : "import", fresh ? "stats_family_fetch" : ADAPTER, LOADER_VERSION);
    const artifact = await open(ctx, unit.unit, fresh);
    describe(receipt, artifact);
    const db = dryRun ? null : await connectLoader(ctx.env);
    let result: LoadReceipt;
    try {
      result = await loadSource(planFor(unit.unit), artifact, db, { dryRun, log: ctx.log, failAfterBatches: ctx.failAfterBatches });
    } finally {
      await db?.close();
    }
    receipt.family_detail = result as unknown as Json;
    if (result.run_id) receipt.provenance.run_ids.push(result.run_id);
    if (result.resumed_from_run_id) receipt.provenance.resumed_from_run_ids.push(result.resumed_from_run_id);
    // Observations and catalogue entry versions are different populations (statWritten): never added together.
    if (!dryRun) {
      receipt.counts.written = statWritten(artifact.manifest.counts, result.totals);
      // A finished load offered every artifact row of each population to the store exactly once. (A resumed run offers
      // only the observations after its checkpoint; the earlier run of the chain offered the rest. Meta is always sent whole.)
      if (result.status === "succeeded") {
        if (result.resumed_from_run_id === null) check(receipt, "observations offered to the store = observations in the artifact", artifact.manifest.counts.observations, result.totals.observations.seen);
        check(receipt, "catalogue entry versions offered to the store = versions in the artifact", artifact.manifest.counts.catalogue_entries, result.totals.meta.catalogue_entries_seen ?? 0);
      }
    }
    if (result.destination) {
      const d = result.destination;
      receipt.counts.destination = { stat_datasets: d.datasets, stat_releases: d.releases, stat_series: d.series, geography_versions: d.geographies, stat_catalogue_entry_versions: d.catalogue_entry_versions, stat_observations: d.observations };
    }
    // The family loader decides whether a difference is explained (after a refresh the store rightly holds the versions
    // of earlier loads as well); the receipt carries its verdict rather than re-deciding it as a strict equality.
    for (const line of result.artifact_to_destination) receipt.counts.checks.push({ name: line.what, expected: line.upstream_rows, actual: line.artifact_rows, ok: !line.explanation.startsWith("UNEXPLAINED") });
    if (result.status === "skipped_lease_held") {
      receipt.status = "skipped_lease_held";
      receipt.error_code = "lease_held";
      return receipt;
    }
    if (result.status === "failed") {
      // A stopped run (its checkpoint is kept) is resumable; anything else is final.
      const stopped = result.error_class === "contract_error" && (result.error_detail ?? "").startsWith("test hook");
      receipt.status = stopped ? "partial" : result.error_class === "stat_identity_conflict" || result.error_class === "reconciliation_failed" ? "not_reconciled" : "failed";
      receipt.error_code = stopped ? "budget_exhausted" : result.error_class === "stat_identity_conflict" ? "value_conflict" : result.error_class === "reconciliation_failed" ? "not_reconciled" : result.error_class === "contract_error" ? "input_contract_violation" : "run_failed";
      receipt.error_detail = result.error_detail;
      return receipt;
    }
    return settle(receipt, dryRun ? "dry_run" : "succeeded");
  }

  return family;
}
