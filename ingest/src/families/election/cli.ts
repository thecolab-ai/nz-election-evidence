#!/usr/bin/env node
// Election family CLI. Shared registry and runner files are used, never edited.
//
//   node src/families/election/cli.ts validate                       fragment + shared registry validate together
//   node src/families/election/cli.ts plan <product|all>              preflight and wave plan; no database, no network
//   node src/families/election/cli.ts registry-sync [--dry-run]       upsert shared + family sources (schedules inactive)
//   node src/families/election/cli.ts import <product|all> [--dry-run] [--receipt FILE]
//   node src/families/election/cli.ts fetch <source_id> [--dry-run] [--backfill] [--receipt FILE]
//   node src/families/election/cli.ts reconcile [--receipt FILE]      destination counts against the export (read-only)
//
// Products: P08 P09 P13 P14 P15 P16 P17 C26A C26B. Private files are named only through EVIDENCE_EXPORT_ELECTION_DIR
// (or EVIDENCE_EXPORT_ELECTION_<PRODUCT>); the connection string only through EVIDENCE_INGEST_DB_URL. Neither is printed.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createPostgresDb, type IngestDb } from "../../../../supabase/functions/_shared/db.ts";
import { registryPayload, schedulePayload, validateSourcesFile } from "../../../../supabase/functions/_shared/registry.ts";
import { type RunReport, runSource } from "../../../../supabase/functions/_shared/runner.ts";
import type { Json, SourcesFile } from "../../../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { resolveHost } from "../../resolve_host.ts";
import { exportLocation, familyAdapter, loadProduct, preflight, type PreflightFindings, toIngestRecord, waveDigest, waveRows } from "./adapter.ts";
import type { AnyProductId, ExportManifest } from "./exporter.ts";
import { ELECTION_LIVE_ADAPTERS, ELECTION_LIVE_SOURCES, ELECTION_SCHEDULES } from "./live.ts";
import { currentVersionMismatches, destinationCounts, type Expected, expectedDestination, storedVersions } from "./reconcile.ts";
import { ELECTION_EXPORT_SOURCES, ELECTION_PINS, ELECTION_REGISTRY_PRODUCTS } from "./registry_fragment.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The shared registry with this family's fragment applied in memory. */
export function mergedSourcesFile(): SourcesFile {
  const shared = sourcesFile as unknown as SourcesFile;
  const familyIds = new Set([...ELECTION_EXPORT_SOURCES.map((e) => e.source.source_id), ...ELECTION_LIVE_SOURCES.map((s) => s.source_id)]);
  const keys = new Set(shared.registry_products.map((p) => p.registry_key));
  return {
    config_version: shared.config_version,
    registry_products: [...shared.registry_products, ...ELECTION_REGISTRY_PRODUCTS.filter((p) => !keys.has(p.registry_key))],
    sources: [...shared.sources.filter((s) => !familyIds.has(s.source_id)), ...ELECTION_EXPORT_SOURCES.map((e) => e.source), ...ELECTION_LIVE_SOURCES],
    schedules: [...shared.schedules.filter((s) => !ELECTION_SCHEDULES.some((mine) => mine.schedule_key === s.schedule_key)), ...ELECTION_SCHEDULES],
  };
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function connect(): Promise<{ db: IngestDb; sql: postgres.Sql }> {
  const url = process.env.EVIDENCE_INGEST_DB_URL;
  if (!url) throw new Error("EVIDENCE_INGEST_DB_URL is not set (see docs/database/runbook.md)");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined, connection: { application_name: "evidence-ingest-election-family" } });
  const [{ me, elevated }] = await sql`select current_user as me, (select rolsuper or rolbypassrls or rolcreaterole from pg_roles where rolname = current_user) as elevated`;
  if (elevated && process.env.EVIDENCE_ALLOW_ELEVATED_LOGIN !== "1") {
    await sql.end({ timeout: 5 });
    throw new Error(`refusing to ingest as "${me}": use a login that is only a member of evidence_ingest`);
  }
  const shared = createPostgresDb(sql);
  // Until the coordinator adds the family projection to the shared project_run, it is called here, under the same lease.
  const db: IngestDb = {
    ...shared,
    projectRun: async (runId, holder) => {
      const base = await shared.projectRun(runId, holder);
      if (base && typeof base === "object" && !Array.isArray(base) && Object.hasOwn(base, "election_family")) return base;
      const [{ r }] = await sql`select evidence_private.project_election_family(${runId}::uuid, ${holder}::uuid) as r`;
      return { shared: base, election_family: r as Json };
    },
  };
  return { db, sql };
}

async function readManifest(): Promise<ExportManifest | null> {
  try {
    return JSON.parse(await readFile(exportLocation("P08", process.env, "manifest.json"), "utf-8")) as ExportManifest;
  } catch {
    return null;
  }
}

function runSummary(report: RunReport): { [key: string]: unknown } {
  return {
    source_id: report.source_id, mode: report.mode, dry_run: report.dry_run, status: report.status, complete_snapshot: report.complete_snapshot,
    error_class: report.error_class, error_detail: report.error_detail, manifest_hash: report.manifest_hash, input_digest: report.manifest.input_digest ?? null,
    run_id: report.run_id, totals: report.totals, tombstoned: report.tombstoned, pages: report.pages, projection: report.projection ?? null,
    planned_record_count: report.planned_records?.length ?? null,
    fetches: report.fetches.map((f) => ({ url: f.url, outcome: f.outcome, http_status: f.http_status ?? null, bytes: f.bytes ?? null, body_sha256: f.body_sha256 ?? null, retrieved_at: f.retrieved_at })),
  };
}

function productsFor(argument: string | undefined): AnyProductId[] {
  const all = ELECTION_EXPORT_SOURCES.map((e) => e.product);
  if (!argument || argument === "all") return all;
  if (!all.includes(argument as AnyProductId)) throw new Error(`unknown product "${argument}". Known: ${all.join(", ")}, all`);
  return [argument as AnyProductId];
}

async function main(argv: string[]): Promise<number> {
  const [command, target, ...rest] = argv;
  const args = [target ?? "", ...rest];
  const file = mergedSourcesFile();
  const problems = validateSourcesFile(file);
  if (command === "validate") {
    for (const p of problems) console.error("- " + p);
    if (!problems.length) console.log(`OK: ${file.sources.length} sources (${ELECTION_EXPORT_SOURCES.length} family exports, ${ELECTION_LIVE_SOURCES.length} family live), ${file.schedules.length} schedules (all sync as inactive)`);
    return problems.length ? 1 : 0;
  }
  if (problems.length) throw new Error("source configuration is invalid: " + problems.join("; "));
  const dryRun = argv.includes("--dry-run");
  const receiptFile = flag(args, "--receipt");
  const finish = async (out: unknown, code: number) => {
    if (receiptFile) await writeFile(resolve(process.cwd(), receiptFile), JSON.stringify(out, null, 2) + "\n");
    console.log(JSON.stringify(out, null, 2));
    return code;
  };

  if (command === "registry-sync") {
    const rights = JSON.parse(await readFile(resolve(ROOT, "catalogue/rights-register.json"), "utf-8")) as { [key: string]: Json }[];
    if (dryRun) return finish({ dry_run: true, rights: rights.length, sources: file.sources.length, schedules: file.schedules.length }, 0);
    const { db } = await connect();
    try {
      const synced = await db.syncRegistry(await registryPayload(file, rights));
      return finish({ synced, schedules_synced_inactive: await db.syncSchedules(await schedulePayload(file)) }, 0);
    } finally {
      await db.close();
    }
  }

  if (command === "plan" || command === "import") {
    const manifest = await readManifest();
    const plans: { product: AnyProductId; findings: PreflightFindings; waves: { wave: number; rows: number }[] }[] = [];
    const loadedAll = [];
    // Everything is validated before the first write, across all requested products.
    for (const product of productsFor(target)) {
      const loaded = await loadProduct(product, process.env);
      const findings = preflight(loaded, ELECTION_PINS[product], manifest);
      plans.push({ product, findings, waves: Array.from({ length: findings.waves }, (_, i) => ({ wave: i + 1, rows: waveRows(loaded.rows, i + 1, findings.waves).length })) });
      loadedAll.push({ loaded, findings });
    }
    if (command === "plan") return finish({ receipt_version: 1, command: "plan", export_manifest_present: Boolean(manifest), plans }, 0);

    const connection = dryRun ? null : await connect();
    const runs: { [key: string]: unknown }[] = [];
    let failed = false;
    try {
      for (const { loaded, findings } of loadedAll) {
        const source = ELECTION_EXPORT_SOURCES.find((e) => e.product === loaded.product)!.source;
        // History already in the store is not replayed: re-sending an old version would point the record back at it
        // until the last wave ran. Only versions the store lacks are sent, then always the final wave.
        const stored = connection ? await storedVersions(connection.sql, source.source_id) : new Set<string>();
        for (let wave = 1; wave <= findings.waves && !failed; wave++) {
          let rows = waveRows(loaded.rows, wave, findings.waves);
          if (wave < findings.waves) {
            const missing = [];
            for (const row of rows) if (!stored.has(row.external_record_id + "\n" + (await toIngestRecord(row)).content_hash)) missing.push(row);
            if (missing.length < rows.length) runs.push({ product: loaded.product, wave, waves: findings.waves, status: "history_already_stored", rows_skipped: rows.length - missing.length });
            rows = missing;
          }
          if (rows.length === 0) continue;
          const report = await runSource({
            file, source, adapter: familyAdapter(rows, wave === findings.waves, loaded.digest.sha256), mode: "export_import", triggerKind: "cli",
            maxRecords: 200000, maxRuntimeSeconds: 3300, dryRun, db: connection?.db ?? null, inputDigest: waveDigest(loaded, wave, findings.waves, rows.length),
          });
          runs.push({ product: loaded.product, wave, waves: findings.waves, ...runSummary(report) });
          if (report.status !== "succeeded" && report.status !== "dry_run") failed = true;
          if (report.totals.rejected > 0) failed = true;
        }
      }
    } finally {
      await connection?.db.close();
    }
    return finish({ receipt_version: 1, command: "import", dry_run: dryRun, plans, runs, all_runs_ok: !failed }, failed ? 2 : 0);
  }

  if (command === "fetch") {
    const source = ELECTION_LIVE_SOURCES.find((s) => s.source_id === target);
    if (!source) throw new Error(`unknown live source "${target ?? ""}". Known: ${ELECTION_LIVE_SOURCES.map((s) => s.source_id).join(", ")}`);
    const adapter = ELECTION_LIVE_ADAPTERS[source.adapter_name];
    const backfill = argv.includes("--backfill");
    const connection = dryRun ? null : await connect();
    try {
      const report = await runSource({
        file, source, adapter, mode: backfill ? "backfill" : "incremental", triggerKind: "cli", maxRecords: backfill ? 5000 : 500,
        maxRuntimeSeconds: backfill ? 1800 : 300, dryRun, db: connection?.db ?? null, resolveHost,
      });
      return finish({ receipt_version: 1, command: "fetch", ...runSummary(report) }, report.status === "failed" ? 2 : 0);
    } finally {
      await connection?.db.close();
    }
  }

  if (command === "reconcile") {
    const expected: Expected[] = [];
    const loadedProducts = [];
    for (const product of productsFor("all")) {
      const loaded = await loadProduct(product, process.env);
      loadedProducts.push(loaded);
      expected.push(await expectedDestination(loaded));
    }
    const { db, sql } = await connect();
    try {
      const actual = await destinationCounts(sql);
      // Counts alone would pass on a half-replayed store, so every record's current version is checked too.
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
      const ok = lines.every((l) => l.ok);
      return finish({ receipt_version: 1, command: "reconcile", all_ok: ok, products: lines, cross_route: actual.__cross_route__ ?? null }, ok ? 0 : 4);
    } finally {
      await db.close();
    }
  }
  throw new Error("commands: validate | plan | registry-sync | import | fetch | reconcile");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error("error: " + String(error instanceof Error ? error.message : error).replace(/postgres(?:ql)?:\/\/\S+/g, "postgres://[redacted]"));
    process.exit(1);
  });
}
