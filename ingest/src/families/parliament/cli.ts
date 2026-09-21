#!/usr/bin/env node
// Parliament family CLI. Runs the family's routes without touching the shared CLI; once the coordinator has merged the
// registry fragment (INTEGRATION.md) the shared CLI serves the live sources and this file remains the export importer.
//
//   node src/families/parliament/cli.ts validate
//   node src/families/parliament/cli.ts registry-sync [--dry-run]           shared registry + this family's fragment
//   node src/families/parliament/cli.ts import <source_id>|all [--dry-run] [--receipt-dir DIR]
//   node src/families/parliament/cli.ts run <source_id> [--dry-run] [--backfill] [--max-records N] [--max-runtime-seconds N]
//
// The database comes from EVIDENCE_INGEST_DB_URL only (a login that is a member of evidence_ingest and nothing more) and
// is never printed. Export files are named by the EVIDENCE_EXPORT_PARLIAMENT_* variables; or set EVIDENCE_EXPORT_DIR to
// the directory the exporter wrote and the file names are derived. Receipts hold counts, digests and statuses only.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createPostgresDb, type IngestDb } from "../../../../supabase/functions/_shared/db.ts";
import { registryPayload, schedulePayload, validateSourcesFile } from "../../../../supabase/functions/_shared/registry.ts";
import { runSource } from "../../../../supabase/functions/_shared/runner.ts";
import type { Json, SourcesFile } from "../../../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { resolveHost } from "../../resolve_host.ts";
import { PARLIAMENT_EXPORT_CONTRACTS, contractFor } from "./contracts.ts";
import { exportLocations } from "./exporter.ts";
import { type FamilyImportReceipt, importFamilyExport } from "./import.ts";
import { PARLIAMENT_ADAPTERS, mergeIntoRegistry } from "./registry_fragment.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

// deno-lint-ignore no-explicit-any
type Sql = any;

async function connect(): Promise<{ db: IngestDb; sql: Sql }> {
  const url = process.env.EVIDENCE_INGEST_DB_URL;
  if (!url) throw new Error("EVIDENCE_INGEST_DB_URL is not set (see docs/database/runbook.md)");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined, connection: { application_name: "evidence-ingest-parliament" } });
  const [{ me, elevated }] = await sql`select current_user as me, (select rolsuper or rolbypassrls or rolcreaterole from pg_roles where rolname = current_user) as elevated`;
  if (elevated && process.env.EVIDENCE_ALLOW_ELEVATED_LOGIN !== "1") {
    await sql.end({ timeout: 5 });
    throw new Error(`refusing to ingest as "${me}": use a login that is only a member of evidence_ingest`);
  }
  return { db: createPostgresDb(sql), sql };
}

/** With EVIDENCE_EXPORT_DIR set, the per-source variables default to the names the exporter writes. */
function exportEnv(): { [key: string]: string | undefined } {
  const env = { ...process.env };
  const dir = env.EVIDENCE_EXPORT_DIR;
  if (dir) {
    for (const contract of PARLIAMENT_EXPORT_CONTRACTS) {
      const { file, manifest } = exportLocations(contract, resolve(dir));
      env[contract.fileEnv] ??= file;
      env[contract.manifestEnv] ??= manifest;
    }
  }
  return env;
}

async function main(argv: string[]): Promise<number> {
  const [command, target, ...rest] = argv;
  const args = [target ?? "", ...rest];
  const { file, clashes } = mergeIntoRegistry(sourcesFile as unknown as SourcesFile);
  const problems = [...validateSourcesFile(file), ...clashes.map((c) => `fragment clashes with the shared registry: ${c}`)];
  if (command === "validate") {
    for (const p of problems) console.error("- " + p);
    if (!problems.length) console.log(`OK: ${file.sources.length} sources with the parliament fragment merged, ${file.schedules.length} schedules (all sync as inactive)`);
    return problems.length ? 1 : 0;
  }
  if (problems.length) throw new Error("source configuration is invalid: " + problems.join("; "));
  const dryRun = argv.includes("--dry-run");

  if (command === "registry-sync") {
    const rights = JSON.parse(await readFile(resolve(ROOT, "catalogue/rights-register.json"), "utf-8")) as { [key: string]: Json }[];
    if (dryRun) {
      console.log(JSON.stringify({ dry_run: true, rights: rights.length, sources: file.sources.length, schedules: file.schedules.length }, null, 2));
      return 0;
    }
    const { db } = await connect();
    try {
      console.log(JSON.stringify({ synced: await db.syncRegistry(await registryPayload(file, rights)), schedules_synced_inactive: await db.syncSchedules(await schedulePayload(file)) }, null, 2));
    } finally {
      await db.close();
    }
    return 0;
  }

  if (command === "import") {
    const contracts = target === "all" ? PARLIAMENT_EXPORT_CONTRACTS : [contractFor(target ?? "")];
    const receiptDir = flag(args, "--receipt-dir");
    const connection = dryRun ? null : await connect();
    let failed = 0;
    try {
      for (const contract of contracts) {
        const source = file.sources.find((s) => s.source_id === contract.source_id)!;
        const receipt: FamilyImportReceipt = await importFamilyExport({
          file, source, contract, env: exportEnv(), db: connection?.db ?? null, dryRun,
          readDestination: connection
            ? async (sourceId) => (await connection.sql`select evidence_private.source_reconciliation(${sourceId}) as r`)[0].r as { [key: string]: Json }
            : undefined,
        });
        if (receipt.status === "failed" || receipt.reconciled === false) failed++;
        if (receiptDir) {
          await mkdir(resolve(process.cwd(), receiptDir), { recursive: true });
          await writeFile(resolve(process.cwd(), receiptDir, contract.source_id + ".receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
        }
        console.log(JSON.stringify({
          source_id: receipt.source_id, status: receipt.status, reconciled: receipt.reconciled, rows: receipt.plan.rows,
          distinct_records: receipt.plan.distinct_records, distinct_versions: receipt.plan.distinct_versions, generations: receipt.plan.generations,
          collapsed_rows: receipt.plan.collapsed_rows,
          totals: receipt.generations.map((g) => ({ generation: g.generation, ...g.totals })), reconciliation: receipt.reconciliation,
        }));
      }
    } finally {
      await connection?.db.close();
    }
    return failed ? 2 : 0;
  }

  if (command === "run") {
    const source = file.sources.find((s) => s.source_id === target);
    const adapter = source ? PARLIAMENT_ADAPTERS[source.adapter_name] : undefined;
    if (!source || !adapter) throw new Error(`not a live source of this family: "${target ?? ""}". Known: ${Object.keys(PARLIAMENT_ADAPTERS).join(", ")}`);
    const backfill = args.includes("--backfill");
    const maxRecords = Number(flag(args, "--max-records") ?? (backfill ? 400000 : 2000));
    const maxRuntimeSeconds = Number(flag(args, "--max-runtime-seconds") ?? (backfill ? 3300 : 300));
    const connection = dryRun ? null : await connect();
    try {
      const report = await runSource({ file, source, adapter, mode: backfill ? "backfill" : "incremental", triggerKind: "cli", maxRecords, maxRuntimeSeconds, dryRun, db: connection?.db ?? null, resolveHost });
      const { planned_records, ...rest } = report;
      console.log(JSON.stringify({ ...rest, planned_record_count: planned_records?.length ?? null }, null, 2));
      return report.status === "failed" ? 2 : 0;
    } finally {
      await connection?.db.close();
    }
  }
  throw new Error("commands: validate | registry-sync | import <source_id>|all | run <source_id>");
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error("error: " + String(error instanceof Error ? error.message : error).replace(/postgres(?:ql)?:\/\/\S+/g, "postgres://[redacted]"));
    process.exit(1);
  },
);
