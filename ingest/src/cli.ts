#!/usr/bin/env node
// Ingestion CLI. Every write goes through the versioned evidence_private functions.
//
//   node src/cli.ts validate
//   node src/cli.ts plan <source_id>                      deterministic manifest, no network, no writes
//   node src/cli.ts run <source_id> --dry-run             real fetch and parse, no writes
//   node src/cli.ts run <source_id> [--backfill]          bounded live run (needs EVIDENCE_INGEST_DB_URL)
//   node src/cli.ts import <source_id> [--dry-run]        reviewed export import (file named by env var)
//   node src/cli.ts registry-sync                         upsert sources, rights mirror, inactive schedules
//
// Flags: --max-records N  --max-runtime-seconds N  --receipt FILE
// Connect with a login that is only a member of evidence_ingest (node src/operator.ts set-ingest-login).
// The connection string comes from the environment only and is never printed.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { LIVE_ADAPTERS } from "../../supabase/functions/_shared/adapters/index.ts";
import { createPostgresDb, type IngestDb } from "../../supabase/functions/_shared/db.ts";
import { buildManifest, registryPayload, schedulePayload, validateSourcesFile } from "../../supabase/functions/_shared/registry.ts";
import { type RunReport, runSource } from "../../supabase/functions/_shared/runner.ts";
import type { Json, SourcesFile } from "../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { exportAdapter, type ImportFindings, loadExport, preflightExport } from "./export_import.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const file = sourcesFile as unknown as SourcesFile;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function connect(): Promise<IngestDb> {
  const url = process.env.EVIDENCE_INGEST_DB_URL;
  if (!url) throw new Error("EVIDENCE_INGEST_DB_URL is not set (see docs/database/runbook.md)");
  // prepare:false and no session state: safe behind a transaction-mode pooler.
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined, connection: { application_name: "evidence-ingest-cli" } });
  const [{ me, elevated }] = await sql`select current_user as me, (select rolsuper or rolbypassrls or rolcreaterole from pg_roles where rolname = current_user) as elevated`;
  if (elevated && process.env.EVIDENCE_ALLOW_ELEVATED_LOGIN !== "1") {
    await sql.end({ timeout: 5 });
    throw new Error(`refusing to ingest as "${me}": use a login that is only a member of evidence_ingest`);
  }
  return createPostgresDb(sql);
}

/** Receipt: counts, hashes, statuses and publisher URLs. No payloads, bodies, hosts of ours, or credentials. */
function receipt(report: RunReport, findings?: ImportFindings): { [key: string]: unknown } {
  return {
    input_findings: findings ?? null,
    receipt_version: 1,
    source_id: report.source_id, mode: report.mode, dry_run: report.dry_run, status: report.status,
    complete_snapshot: report.complete_snapshot, error_class: report.error_class, error_detail: report.error_detail,
    manifest_hash: report.manifest_hash, manifest: report.manifest, run_id: report.run_id,
    resumed_from_run_id: report.resumed_from_run_id, totals: report.totals, tombstoned: report.tombstoned, pages: report.pages,
    projection: report.projection ?? null,
    fetches: report.fetches.map((f) => ({
      method: f.method, url: f.url, attempt: f.attempt, outcome: f.outcome, http_status: f.http_status ?? null,
      bytes: f.bytes ?? null, body_sha256: f.body_sha256 ?? null, retrieved_at: f.retrieved_at, duration_ms: f.duration_ms,
    })),
    planned_record_count: report.planned_records?.length ?? null,
    planned_records_digest_sample: report.planned_records?.slice(0, 5) ?? null,
  };
}

async function main(argv: string[]): Promise<number> {
  const [command, sourceId, ...rest] = argv;
  const args = [sourceId ?? "", ...rest];
  const problems = validateSourcesFile(file);
  if (command === "validate") {
    if (problems.length) {
      for (const p of problems) console.error("- " + p);
      return 1;
    }
    console.log(`OK: ${file.sources.length} sources, ${file.schedules.length} schedules (all schedules sync as inactive)`);
    return 0;
  }
  if (problems.length) throw new Error("source configuration is invalid: " + problems.join("; "));

  if (command === "registry-sync") {
    const rights = JSON.parse(await readFile(resolve(ROOT, "catalogue/rights-register.json"), "utf-8")) as { [key: string]: Json }[];
    const payload = await registryPayload(file, rights);
    if (argv.includes("--dry-run")) {
      console.log(JSON.stringify({ dry_run: true, rights: rights.length, sources: file.sources.length, schedules: file.schedules.length }, null, 2));
      return 0;
    }
    const db = await connect();
    try {
      const synced = await db.syncRegistry(payload);
      const schedules = await db.syncSchedules(await schedulePayload(file));
      console.log(JSON.stringify({ synced, schedules_synced_inactive: schedules }, null, 2));
    } finally {
      await db.close();
    }
    return 0;
  }

  const source = file.sources.find((s) => s.source_id === sourceId);
  if (!source) throw new Error(`unknown source "${sourceId ?? ""}". Known: ${file.sources.map((s) => s.source_id).join(", ")}`);
  const dryRun = args.includes("--dry-run");
  const backfill = args.includes("--backfill");
  const maxRecords = Number(flag(args, "--max-records") ?? (backfill ? 200000 : 2000));
  const maxRuntimeSeconds = Number(flag(args, "--max-runtime-seconds") ?? (backfill ? 3300 : 300));
  if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new Error("--max-records must be a positive integer");
  if (!Number.isInteger(maxRuntimeSeconds) || maxRuntimeSeconds < 10 || maxRuntimeSeconds > 3500) throw new Error("--max-runtime-seconds must be 10-3500");

  if (command === "plan") {
    const adapter = source.adapter_kind === "live_fetch" ? LIVE_ADAPTERS[source.adapter_name] : { version: "1.0.0" };
    if (!adapter) throw new Error("adapter not found");
    const mode = source.adapter_kind === "export_import" ? "export_import" : backfill ? "backfill" : "incremental";
    console.log(JSON.stringify(await buildManifest(file, source, adapter.version, mode, maxRecords), null, 2));
    return 0;
  }

  let report: RunReport;
  let findings: ImportFindings | undefined;
  if (command === "run") {
    if (source.adapter_kind !== "live_fetch") throw new Error("use `import` for export sources");
    const adapter = LIVE_ADAPTERS[source.adapter_name];
    if (!adapter) throw new Error(`adapter ${source.adapter_name} not found`);
    const db = dryRun ? null : await connect();
    try {
      report = await runSource({ file, source, adapter, mode: backfill ? "backfill" : "incremental", triggerKind: "cli", maxRecords, maxRuntimeSeconds, dryRun, db });
    } finally {
      await db?.close();
    }
  } else if (command === "import") {
    if (source.adapter_kind !== "export_import" || !source.export_contract) throw new Error("use `run` for live sources");
    const loaded = await loadExport(source.export_contract, process.env);
    // The whole file is validated before a run exists: a rejected input writes nothing and skips nothing.
    findings = await preflightExport(source, source.export_contract, loaded, process.env);
    const db = dryRun ? null : await connect();
    try {
      report = await runSource({
        file, source, adapter: exportAdapter(loaded), mode: "export_import", triggerKind: "cli", maxRecords, maxRuntimeSeconds,
        dryRun, db, inputDigest: loaded.digest,
      });
    } finally {
      await db?.close();
    }
  } else {
    throw new Error("commands: validate | plan | run | import | registry-sync");
  }

  const out = receipt(report, findings);
  const receiptFile = flag(args, "--receipt");
  if (receiptFile) await writeFile(resolve(process.cwd(), receiptFile), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  return report.status === "failed" ? 2 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    // Never echo connection strings or stack traces that could carry them.
    console.error("error: " + String(error instanceof Error ? error.message : error).replace(/postgres(?:ql)?:\/\/\S+/g, "postgres://[redacted]"));
    process.exit(1);
  },
);
