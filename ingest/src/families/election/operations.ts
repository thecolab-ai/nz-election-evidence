// Election family operations: plan, import (history replayed in waves) and reconcile, as functions. The unified loader
// CLI and the family CLI both call these, so there is one implementation of each step.

import { readFile } from "node:fs/promises";
import type postgres from "postgres";
import type { IngestDb } from "../../../../supabase/functions/_shared/db.ts";
import { type RunReport, runSource } from "../../../../supabase/functions/_shared/runner.ts";
import type { SourcesFile } from "../../../../supabase/functions/_shared/types.ts";
import { exportLocation, familyAdapter, type LoadedProduct, loadProduct, preflight, type PreflightFindings, toIngestRecord, waveDigest, waveRows } from "./adapter.ts";
import type { AnyProductId, ExportManifest } from "./exporter.ts";
import { currentVersionMismatches, destinationCounts, type Expected, expectedDestination, storedVersions } from "./reconcile.ts";
import { ELECTION_EXPORT_SOURCES, ELECTION_PINS } from "./registry_fragment.ts";

export type Env = { [key: string]: string | undefined };

export const ELECTION_PRODUCTS: AnyProductId[] = ELECTION_EXPORT_SOURCES.map((e) => e.product);

export function productsFor(argument: string | undefined): AnyProductId[] {
  if (!argument || argument === "all") return ELECTION_PRODUCTS;
  if (!ELECTION_PRODUCTS.includes(argument as AnyProductId)) throw new Error(`unknown product "${argument}". Known: ${ELECTION_PRODUCTS.join(", ")}, all`);
  return [argument as AnyProductId];
}

export function exportSourceOf(product: AnyProductId) {
  return ELECTION_EXPORT_SOURCES.find((e) => e.product === product)!.source;
}

export async function readExportManifest(env: Env): Promise<ExportManifest | null> {
  try {
    return JSON.parse(await readFile(exportLocation("P08", env, "manifest.json"), "utf-8")) as ExportManifest;
  } catch {
    return null;
  }
}

export interface ProductPlan { product: AnyProductId; findings: PreflightFindings; waves: { wave: number; rows: number }[] }
export interface PlannedProduct { loaded: LoadedProduct; findings: PreflightFindings; plan: ProductPlan }

/** Loads and preflights every requested product. Everything is validated before the first write, across all of them. */
export async function planProducts(products: AnyProductId[], env: Env): Promise<{ manifest_present: boolean; planned: PlannedProduct[] }> {
  const manifest = await readExportManifest(env);
  const planned: PlannedProduct[] = [];
  for (const product of products) {
    const loaded = await loadProduct(product, env);
    const findings = preflight(loaded, ELECTION_PINS[product], manifest);
    const plan: ProductPlan = { product, findings, waves: Array.from({ length: findings.waves }, (_, i) => ({ wave: i + 1, rows: waveRows(loaded.rows, i + 1, findings.waves).length })) };
    planned.push({ loaded, findings, plan });
  }
  return { manifest_present: Boolean(manifest), planned };
}

export function runSummary(report: RunReport): { [key: string]: unknown } {
  return {
    source_id: report.source_id, mode: report.mode, dry_run: report.dry_run, status: report.status, complete_snapshot: report.complete_snapshot,
    error_class: report.error_class, error_detail: report.error_detail, manifest_hash: report.manifest_hash, input_digest: report.manifest.input_digest ?? null,
    run_id: report.run_id, resumed_from_run_id: report.resumed_from_run_id, totals: report.totals, tombstoned: report.tombstoned, pages: report.pages, projection: report.projection ?? null,
    planned_record_count: report.planned_records?.length ?? null,
    fetches: report.fetches.map((f) => ({ url: f.url, outcome: f.outcome, http_status: f.http_status ?? null, bytes: f.bytes ?? null, body_sha256: f.body_sha256 ?? null, retrieved_at: f.retrieved_at })),
  };
}

export interface WaveRun { product: AnyProductId; wave: number; waves: number; skipped_rows?: number; report?: RunReport }

export interface ImportOptions {
  file: SourcesFile;
  dryRun: boolean;
  connection: { db: IngestDb; sql: postgres.Sql } | null;
  /** Test hook, passed to the runner: stop after this many stored batches, leaving a checkpoint. */
  failAfterBatches?: number;
}

/**
 * History already in the store is not replayed: re-sending an old version would point the record back at it until the
 * last wave ran. Only versions the store lacks are sent, then always the final wave.
 */
export async function importProducts(planned: PlannedProduct[], options: ImportOptions): Promise<{ runs: WaveRun[]; failed: boolean }> {
  const runs: WaveRun[] = [];
  let failed = false;
  for (const { loaded, findings } of planned) {
    const source = exportSourceOf(loaded.product);
    const stored = options.connection ? await storedVersions(options.connection.sql, source.source_id) : new Set<string>();
    for (let wave = 1; wave <= findings.waves && !failed; wave++) {
      let rows = waveRows(loaded.rows, wave, findings.waves);
      if (wave < findings.waves) {
        const missing = [];
        for (const row of rows) if (!stored.has(row.external_record_id + "\n" + (await toIngestRecord(row)).content_hash)) missing.push(row);
        if (missing.length < rows.length) runs.push({ product: loaded.product, wave, waves: findings.waves, skipped_rows: rows.length - missing.length });
        rows = missing;
      }
      if (rows.length === 0) continue;
      const report = await runSource({
        file: options.file, source, adapter: familyAdapter(rows, wave === findings.waves, loaded.digest.sha256), mode: "export_import", triggerKind: "cli",
        maxRecords: 200000, maxRuntimeSeconds: 3300, dryRun: options.dryRun, db: options.connection?.db ?? null, inputDigest: waveDigest(loaded, wave, findings.waves, rows.length),
        failAfterBatches: options.failAfterBatches,
      });
      runs.push({ product: loaded.product, wave, waves: findings.waves, report });
      if (report.status !== "succeeded" && report.status !== "dry_run") failed = true;
      if (report.totals.rejected > 0) failed = true;
    }
  }
  return { runs, failed };
}

export interface ReconcileLine { product: AnyProductId; source_id: string; checks: { name: string; expected: number; actual: number | null; ok: boolean }[]; ok: boolean }

/** Read-only. Counts alone would pass on a half-replayed store, so every record's current version is checked too. */
export async function reconcileProducts(sql: postgres.Sql, env: Env, products: AnyProductId[] = ELECTION_PRODUCTS): Promise<{ lines: ReconcileLine[]; cross_route: unknown }> {
  const expected: Expected[] = [];
  const loadedProducts: LoadedProduct[] = [];
  for (const product of products) {
    const loaded = await loadProduct(product, env);
    loadedProducts.push(loaded);
    expected.push(await expectedDestination(loaded));
  }
  const actual = await destinationCounts(sql);
  for (const loaded of loadedProducts) {
    const e = expected.find((x) => x.product === loaded.product)!;
    e.expect.records_not_at_their_latest_version = 0;
    (actual[e.source_id] ??= {}).records_not_at_their_latest_version = await currentVersionMismatches(sql, e.source_id, loaded);
  }
  const lines = expected.map((e) => {
    const got = actual[e.source_id] ?? {};
    const checks = Object.entries(e.expect).map(([name, want]) => ({ name, expected: want, actual: got[name] ?? null, ok: got[name] === want }));
    return { product: e.product, source_id: e.source_id, checks, ok: checks.every((c) => c.ok) };
  });
  return { lines, cross_route: actual.__cross_route__ ?? null };
}
