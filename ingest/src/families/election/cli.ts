#!/usr/bin/env node
// Election family CLI. The loader contract (plan, validate, dry-run, import, refresh, reconcile) is served for every
// family by the one CLI, ingest/src/cli.ts; this file remains for the family's own operator steps and runs the same
// functions (operations.ts), so there is one implementation of each step.
//
//   node src/families/election/cli.ts validate | plan <product|all> | registry-sync [--dry-run]
//   node src/families/election/cli.ts import <product|all> [--dry-run] [--receipt FILE]
//   node src/families/election/cli.ts fetch <source_id> [--dry-run] [--backfill] [--receipt FILE]
//   node src/families/election/cli.ts reconcile [--receipt FILE]
//
// Products: P08 P09 P13 P14 P15 P16 P17 C26A C26B. Private files are named only through EVIDENCE_EXPORT_ELECTION_DIR
// (or EVIDENCE_EXPORT_ELECTION_<PRODUCT>); the connection string only through EVIDENCE_INGEST_DB_URL. Neither is printed.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registryPayload, schedulePayload } from "../../../../supabase/functions/_shared/registry.ts";
import { runSource } from "../../../../supabase/functions/_shared/runner.ts";
import type { Json, SourcesFile } from "../../../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { REPOSITORY_ROOT } from "../../loaders/access.ts";
import { connectWorker } from "../../loaders/connect.ts";
import { mergeRegistry } from "../../loaders/registry.ts";
import { resolveHost } from "../../resolve_host.ts";
import { ELECTION_LIVE_ADAPTERS, ELECTION_LIVE_SOURCES } from "./live.ts";
import { importProducts, planProducts, productsFor, reconcileProducts, runSummary } from "./operations.ts";
import { ELECTION_EXPORT_SOURCES } from "./registry_fragment.ts";

/** The one merged registry (core sources and every family fragment). */
export function mergedSourcesFile(): SourcesFile {
  const { file, problems } = mergeRegistry(sourcesFile as unknown as SourcesFile);
  if (problems.length) throw new Error("source configuration is invalid: " + problems.join("; "));
  return file;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [command, target, ...rest] = argv;
  const args = [target ?? "", ...rest];
  const file = mergedSourcesFile();
  if (command === "validate") {
    console.log(`OK: ${file.sources.length} sources (${ELECTION_EXPORT_SOURCES.length} family exports, ${ELECTION_LIVE_SOURCES.length} family live), ${file.schedules.length} schedules (all sync as inactive)`);
    return 0;
  }
  const dryRun = argv.includes("--dry-run");
  const receiptFile = flag(args, "--receipt");
  const finish = async (out: unknown, code: number) => {
    if (receiptFile) await writeFile(resolve(process.cwd(), receiptFile), JSON.stringify(out, null, 2) + "\n");
    console.log(JSON.stringify(out, null, 2));
    return code;
  };

  if (command === "registry-sync") {
    const rights = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "catalogue/rights-register.json"), "utf-8")) as { [key: string]: Json }[];
    if (dryRun) return finish({ dry_run: true, rights: rights.length, sources: file.sources.length, schedules: file.schedules.length }, 0);
    const { db } = await connectWorker(process.env, "evidence-ingest-election-family");
    try {
      const synced = await db.syncRegistry(await registryPayload(file, rights));
      return finish({ synced, schedules_synced_inactive: await db.syncSchedules(await schedulePayload(file)) }, 0);
    } finally {
      await db.close();
    }
  }

  if (command === "plan" || command === "import") {
    const { manifest_present, planned } = await planProducts(productsFor(target), process.env);
    const plans = planned.map((p) => p.plan);
    if (command === "plan") return finish({ receipt_version: 1, command: "plan", export_manifest_present: manifest_present, plans }, 0);
    const connection = dryRun ? null : await connectWorker(process.env, "evidence-ingest-election-family");
    try {
      const { runs, failed } = await importProducts(planned, { file, dryRun, connection });
      const lines = runs.map((r) => r.report
        ? { product: r.product, wave: r.wave, waves: r.waves, ...runSummary(r.report) }
        : { product: r.product, wave: r.wave, waves: r.waves, status: "history_already_stored", rows_skipped: r.skipped_rows });
      return finish({ receipt_version: 1, command: "import", dry_run: dryRun, plans, runs: lines, all_runs_ok: !failed }, failed ? 2 : 0);
    } finally {
      await connection?.close();
    }
  }

  if (command === "fetch") {
    const source = ELECTION_LIVE_SOURCES.find((s) => s.source_id === target);
    if (!source) throw new Error(`unknown live source "${target ?? ""}". Known: ${ELECTION_LIVE_SOURCES.map((s) => s.source_id).join(", ")}`);
    const adapter = ELECTION_LIVE_ADAPTERS[source.adapter_name];
    const backfill = argv.includes("--backfill");
    const connection = dryRun ? null : await connectWorker(process.env, "evidence-ingest-election-family");
    try {
      const report = await runSource({
        file, source, adapter, mode: backfill ? "backfill" : "incremental", triggerKind: "cli", maxRecords: backfill ? 5000 : 500,
        maxRuntimeSeconds: backfill ? 1800 : 300, dryRun, db: connection?.db ?? null, resolveHost,
      });
      return finish({ receipt_version: 1, command: "fetch", ...runSummary(report) }, report.status === "failed" ? 2 : 0);
    } finally {
      await connection?.close();
    }
  }

  if (command === "reconcile") {
    const connection = await connectWorker(process.env, "evidence-ingest-election-family");
    try {
      const { lines, cross_route } = await reconcileProducts(connection.sql, process.env);
      const ok = lines.every((l) => l.ok);
      return finish({ receipt_version: 1, command: "reconcile", all_ok: ok, products: lines, cross_route }, ok ? 0 : 4);
    } finally {
      await connection.close();
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
