#!/usr/bin/env node
// The one ingestion CLI. Registry-driven: every source of every family is reached through the same six commands and the
// same receipt. Every write goes through the versioned evidence_private functions.
//
//   node src/cli.ts validate [TARGET...]            the merged registry, rights rows and route coverage; with a target,
//                                                   also the private inputs (re-hashed, checked row by row). No database.
//   node src/cli.ts plan TARGET...                  what would be read and written. No database, no network.
//   node src/cli.ts dry-run TARGET...               the whole import path short of a write. No database.
//   node src/cli.ts import TARGET...                backfill: private artifact -> store (replay-safe, resumable)
//   node src/cli.ts refresh TARGET... [--dry-run] [--backfill]   current-refresh route: fresh anonymous fetch -> store
//   node src/cli.ts reconcile TARGET...             read-only: the store against the private inputs
//   node src/cli.ts coverage                        routes of the 24 catalogue products, with their true state
//   node src/cli.ts registry-sync [--dry-run]       upsert sources, rights mirror, schedules (always inactive)
//
// TARGET: all | a family (core, election, parliament, statistics) | a catalogue product (P01..P24) | a unit or source id.
// Older spellings still work: `run SOURCE` is `refresh SOURCE`, and `import SOURCE --dry-run` is `dry-run SOURCE`.
// Flags: --receipt FILE  --receipt-dir DIR  --max-records N  --max-runtime-seconds N  --continue-on-error
//
// Private inputs are named by environment variables only (EVIDENCE_EXPORT_*), the store by EVIDENCE_INGEST_DB_URL: a login
// that is a member of evidence_ingest and nothing more (node src/operator.ts set-ingest-login). Neither is ever printed.
// Exit codes: 0 ok, 1 usage or configuration, 2 a run failed, 3 an input was refused, 4 not reconciled, 5 route blocked.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registryPayload, schedulePayload } from "../../supabase/functions/_shared/registry.ts";
import { IngestError, type Json, type SourcesFile } from "../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { ContractError } from "./families/stats/contract.ts";
import { redactReceipt, REPOSITORY_ROOT, sanitize } from "./loaders/access.ts";
import { connectWorker } from "./loaders/connect.ts";
import {
  type ErrorCode, EXIT, exitCodeFor, LOADER_COMMANDS, type LoaderCommand, type LoaderContext, LoaderError, type LoaderFamily, type LoaderUnit,
  newReceipt, type TargetReceipt,
} from "./loaders/contract.ts";
import { productCoverage, SOURCE_ROUTES, STATS_REFRESH, UNPUBLISHED_2026 } from "./loaders/coverage.ts";
import { coreFamily } from "./loaders/families/core.ts";
import { electionFamily } from "./loaders/families/election.ts";
import { parliamentFamily } from "./loaders/families/parliament.ts";
import { statsFamily } from "./loaders/families/stats.ts";
import { mergeRegistry, rightsProblems, type RightsRow } from "./loaders/registry.ts";
import { isTransient, withRetry } from "./loaders/retry.ts";

export interface Loaders { file: SourcesFile; problems: string[]; families: LoaderFamily[] }

export async function loaders(): Promise<Loaders> {
  const { file, problems } = mergeRegistry(sourcesFile as unknown as SourcesFile);
  const register = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "catalogue/rights-register.json"), "utf-8")) as RightsRow[];
  const committed = JSON.stringify(sourcesFile) === JSON.stringify(file) ? [] : ["the committed registry is out of date: run `node src/loaders/registry_build.ts --write`"];
  const families = [coreFamily(file), electionFamily(file), parliamentFamily(file), statsFamily()];
  const uncovered = file.sources.filter((s) => !SOURCE_ROUTES[s.source_id]).map((s) => `source ${s.source_id} has no stated route coverage`);
  return { file, problems: [...problems, ...rightsProblems(file, register), ...committed, ...uncovered], families };
}

/** all | family | product | unit | source id  ->  units, in registry order, each once. */
export function resolveTargets(families: LoaderFamily[], targets: string[]): { family: LoaderFamily; unit: LoaderUnit }[] {
  const all = families.flatMap((family) => family.units().map((unit) => ({ family, unit })));
  const picked = new Set<string>();
  for (const target of targets) {
    const matches = all.filter(({ family, unit }) =>
      target === "all" || family.family === target || unit.unit === target || unit.product_ids.includes(target)
      || unit.backfill_source_ids.includes(target) || unit.refresh_source_ids.includes(target) || (unit.alias_source_ids ?? []).includes(target));
    if (matches.length === 0) throw new LoaderError("target_unknown", `unknown target "${target}". Use all, a family (${families.map((f) => f.family).join(", ")}), a product id, or one of: ${all.map((u) => u.unit.unit).join(", ")}`);
    for (const match of matches) picked.add(match.family.family + "\n" + match.unit.unit);
  }
  return all.filter(({ family, unit }) => picked.has(family.family + "\n" + unit.unit));
}

const INPUT_CLASSES: { [errorClass: string]: ErrorCode } = {
  missing_input: "input_missing", input_not_accepted: "input_contract_violation", parse_error: "input_contract_violation", config_error: "config_invalid",
};

/** A thrown error becomes a receipt with a code from the closed list; nothing escapes as free text with a location in it. */
function refusal(family: LoaderFamily, unit: LoaderUnit, command: LoaderCommand, error: unknown): TargetReceipt {
  const receipt = newReceipt(family, unit, command, "unknown", "unknown");
  const message = sanitize(error instanceof Error ? error.message : String(error));
  if (error instanceof LoaderError) {
    receipt.error_code = error.code;
    receipt.status = error.code.startsWith("input_") ? "refused_input" : error.code.startsWith("route_") ? "blocked" : "failed";
  } else if (error instanceof ContractError) {
    receipt.error_code = /manifest|does not match|no readable artifact/.test(message) ? (/no readable/.test(message) ? "input_missing" : "input_pin_mismatch") : "input_contract_violation";
    receipt.status = "refused_input";
  } else if (error instanceof IngestError && INPUT_CLASSES[error.errorClass]) {
    receipt.error_code = /checksum|pinned|pin\b|manifest/i.test(message) && error.errorClass === "input_not_accepted" ? "input_pin_mismatch" : INPUT_CLASSES[error.errorClass];
    receipt.status = receipt.error_code === "config_invalid" ? "failed" : "refused_input";
  } else {
    receipt.error_code = "unexpected";
    receipt.status = "failed";
  }
  receipt.error_detail = message;
  return receipt;
}

export async function runCommand(command: LoaderCommand, family: LoaderFamily, unit: LoaderUnit, ctx: LoaderContext, dryRun: boolean): Promise<TargetReceipt> {
  try {
    switch (command) {
      case "plan": return await family.plan(unit, ctx);
      case "validate": return await family.validate(unit, ctx);
      case "dry-run": return await family.import(unit, ctx, true);
      // Only the backfill is repeated automatically: it reads a private file and every write is idempotent and
      // checkpointed. A refresh contacts publishers, so it runs ONCE per call: a run that stopped at its budget answers
      // "partial" and the operator's next call resumes it. The budget given on the command line is never multiplied.
      case "import": return await withRetry(() => family.import(unit, ctx, false));
      case "refresh": return await family.refresh(unit, ctx, dryRun);
      case "reconcile": return await family.reconcile(unit, ctx);
    }
  } catch (error) {
    const receipt = refusal(family, unit, command, error);
    if (isTransient(error)) {
      receipt.error_code = "transient_database";
      receipt.status = "failed";
    }
    return receipt;
  }
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const VALUE_FLAGS = new Set(["--receipt", "--receipt-dir", "--max-records", "--max-runtime-seconds"]);

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) i++;
    else if (!args[i].startsWith("--")) out.push(args[i]);
  }
  return out;
}

async function emit(out: unknown, receiptFile: string | undefined): Promise<void> {
  // By now any write is committed, so a string that may not leave the process is withheld from the receipt, not thrown.
  const { value, redacted } = redactReceipt(out);
  if (redacted) console.error(`note: ${redacted} value(s) were withheld from this receipt by the ledger guard`);
  const text = JSON.stringify(value, null, 2) + "\n";
  if (receiptFile) await writeFile(resolve(process.cwd(), receiptFile), text, { mode: 0o600 });
  process.stdout.write(text);
}

async function main(argv: string[]): Promise<number> {
  let [command, ...args] = argv;
  if (command === "run") command = "refresh";
  let dryRun = args.includes("--dry-run");
  if (command === "import" && dryRun) command = "dry-run";
  const { file, problems, families } = await loaders();
  const targets = positional(args);

  if (command === "validate" && targets.length === 0) {
    for (const p of problems) console.error("- " + p);
    if (problems.length) return EXIT.usage_or_config;
    console.log(`OK: ${file.sources.length} sources in ${families.length} families, ${file.schedules.length} schedules (all schedules sync as inactive), config version ${file.config_version}`);
    return EXIT.ok;
  }
  if (problems.length) throw new LoaderError("config_invalid", "source configuration is invalid: " + problems.join("; "));

  if (command === "coverage") {
    const catalogue = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "catalogue/sources.json"), "utf-8")) as { product_id: string; title: string; record_count: number }[];
    await emit({ contract: "route coverage of the 24 catalogue products", products: productCoverage(file, catalogue), statistics_refresh_routes: STATS_REFRESH, not_published_for_2026: UNPUBLISHED_2026 }, flag(args, "--receipt"));
    return EXIT.ok;
  }

  if (command === "registry-sync") {
    const rights = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "catalogue/rights-register.json"), "utf-8")) as { [key: string]: Json }[];
    if (dryRun) {
      await emit({ dry_run: true, rights: rights.length, sources: file.sources.length, schedules: file.schedules.length, config_version: file.config_version }, undefined);
      return EXIT.ok;
    }
    const connection = await connectWorker(process.env);
    try {
      const synced = await connection.db.syncRegistry(await registryPayload(file, rights));
      await emit({ synced, schedules_synced_inactive: await connection.db.syncSchedules(await schedulePayload(file)) }, flag(args, "--receipt"));
    } finally {
      await connection.close();
    }
    return EXIT.ok;
  }

  if (!(LOADER_COMMANDS as readonly string[]).includes(command ?? "")) throw new LoaderError("usage", `commands: ${LOADER_COMMANDS.join(" | ")} | coverage | registry-sync`);
  if (targets.length === 0) throw new LoaderError("usage", `${command} needs a target: all, a family, a product id, or a unit`);
  if (command !== "refresh") dryRun = command === "dry-run";

  const number = (name: string): number | undefined => {
    const raw = flag(args, name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new LoaderError("usage", `${name} must be a positive integer`);
    return value;
  };
  const ctx: LoaderContext = {
    env: process.env, log: (message) => console.error(message), backfill: args.includes("--backfill"),
    maxRecords: number("--max-records"), maxRuntimeSeconds: number("--max-runtime-seconds"),
  };
  if (ctx.maxRuntimeSeconds !== undefined && (ctx.maxRuntimeSeconds < 10 || ctx.maxRuntimeSeconds > 3500)) throw new LoaderError("usage", "--max-runtime-seconds must be 10-3500");

  const receiptDir = flag(args, "--receipt-dir");
  if (receiptDir) await mkdir(resolve(process.cwd(), receiptDir), { recursive: true, mode: 0o700 });
  const receipts: TargetReceipt[] = [];
  let worst: number = EXIT.ok;
  for (const { family, unit } of resolveTargets(families, targets)) {
    // For a refresh, a unit without any refresh source is only reported when it was asked for by name.
    if (command === "refresh" && unit.refresh_source_ids.length === 0 && !targets.includes(unit.unit)) continue;
    if (command !== "refresh" && command !== "reconcile" && unit.backfill_source_ids.length === 0 && !targets.includes(unit.unit)) continue;
    ctx.log(`${command} ${family.family}/${unit.unit} ...`);
    const receipt = await runCommand(command as LoaderCommand, family, unit, ctx, dryRun);
    receipts.push(receipt);
    ctx.log(`${command} ${family.family}/${unit.unit}: ${receipt.status}${receipt.error_code ? " (" + receipt.error_code + ")" : ""}`);
    if (receiptDir) await writeFile(resolve(process.cwd(), receiptDir, `${command}-${family.family}-${unit.unit}.json`), JSON.stringify(redactReceipt(receipt).value, null, 2) + "\n", { mode: 0o600 });
    const code = exitCodeFor(receipt.status);
    // A blocked route is an availability fact, not a failure of the run: it decides the exit code only when nothing ran.
    if (code !== EXIT.blocked) worst = Math.max(worst, code);
    if (code !== EXIT.ok && code !== EXIT.blocked && !args.includes("--continue-on-error")) break;
  }
  if (receipts.length === 0) throw new LoaderError("usage", `nothing to ${command} for ${targets.join(", ")}: no unit of that target has such a route (see \`coverage\`)`);
  const summary = receipts.map((r) => ({
    family: r.family, unit: r.unit, status: r.status, error_code: r.error_code, input: r.counts.input, written: r.counts.written,
    checks_passed: r.counts.checks.filter((c) => c.ok).length, checks_failed: r.counts.checks.filter((c) => !c.ok).length,
  }));
  // With a receipt directory the per-unit files hold the detail; the printed output stays a summary.
  await emit(receiptDir ? { receipt_version: 2, command, summary } : { receipt_version: 2, command, summary, receipts }, flag(args, "--receipt"));
  return worst === EXIT.ok && receipts.length > 0 && receipts.every((r) => r.status === "blocked") ? EXIT.blocked : worst;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      // Never echo connection strings, locations on a disk or stack traces that could carry them.
      console.error("error: " + sanitize(String(error instanceof Error ? error.message : error)));
      process.exit(error instanceof LoaderError && error.code !== "usage" && error.code !== "config_invalid" && error.code !== "target_unknown" ? EXIT.run_failed : EXIT.usage_or_config);
    },
  );
}
