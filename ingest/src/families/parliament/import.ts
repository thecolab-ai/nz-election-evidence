// Parliament family importer: a pinned export file -> the versioned ingestion functions, with history kept in order.
//
// An export row is one upstream OBSERVATION, so one publisher item can appear several times. The ledger accepts one
// content per record per run, therefore history is replayed in GENERATIONS: generation 1 carries every item's earliest
// distinct content, generation 2 the next distinct content of the items that changed, and so on, each as its own run.
// Rows whose allowlisted projection equals the item's previous one (upstream saw a change only in fields this project
// does not keep, such as paging bookkeeping) collapse into that version and are counted, never silently lost.
//
// Replaying the same file changes nothing: every generation reports versions_inserted = 0. Generations must always be
// replayed in order and to the end, because the last one leaves each record pointing at its latest content.
//
// The whole file is validated BEFORE any run starts: pinned checksum, row count, distinct-record count, manifest
// agreement, column allowlist, and every row accepted by its payload builder. A file that fails writes nothing.

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { IngestDb } from "../../../../supabase/functions/_shared/db.ts";
import { type RunReport, runSource } from "../../../../supabase/functions/_shared/runner.ts";
import {
  type Adapter, type AdapterContext, type AdapterPage, IngestError, type IngestRecord, type Json, type SourceConfig, type SourcesFile,
} from "../../../../supabase/functions/_shared/types.ts";
import type { ExportPin, ExportRow, FamilyExportContract } from "./contracts.ts";
import { type ExportManifest, inspectExportFile } from "./exporter.ts";
import { toIngestRecord } from "./payload.ts";

const PAGE_ROWS = 400;
export const FAMILY_EXPORT_ADAPTER = "parliament_family_export";
export const FAMILY_EXPORT_ADAPTER_VERSION = "1.0.0";

function refuse(message: string): never {
  throw new IngestError("input_not_accepted", message);
}

async function* exportRows(location: string): AsyncGenerator<{ line: number; row: ExportRow }> {
  let line = 0;
  for await (const text of createInterface({ input: createReadStream(location), crlfDelay: Infinity })) {
    if (!text.trim()) continue;
    yield { line: line++, row: JSON.parse(text) as ExportRow };
  }
}

export interface ImportPlan {
  rows: number;
  distinct_records: number;
  /** Distinct (record, content) pairs: the number of versions the ledger must hold afterwards. */
  distinct_versions: number;
  generations: number;
  /** Rows replayed in each generation, first generation first. Their sum plus collapsed_rows equals rows. */
  rows_per_generation: number[];
  /** Rows whose allowlisted projection equals the same item's previous row. */
  collapsed_rows: number;
  /** Rows where an item returned to a content it had held before: replayed as a further sighting of that version. */
  returning_rows: number;
  records_by_kind: { [kind: string]: number };
  rows_with_publisher_date: number;
  observed_min: string | null;
  observed_max: string | null;
  /** Generation of every data line; 0 marks a collapsed row. Not part of any receipt. */
  lineGeneration: Uint8Array;
}

/** One pass over the file. Every row must build; the first that does not refuses the file. */
export async function planImport(contract: FamilyExportContract, location: string, rows: number): Promise<ImportPlan> {
  const lineGeneration = new Uint8Array(rows);
  const state = new Map<string, { last: string; seen: Set<string>; generation: number }>();
  const kinds: { [kind: string]: number } = {};
  let collapsed = 0;
  let returning = 0;
  let dated = 0;
  let min: string | null = null;
  let max: string | null = null;
  let count = 0;
  for await (const { line, row } of exportRows(location)) {
    if (line >= rows) refuse("the file holds more rows than its verified count");
    count++;
    const observed = row.observed_at;
    if (typeof observed !== "string" || Number.isNaN(Date.parse(observed))) refuse(`row ${line + 1}: no usable collection time`);
    if (min === null || observed < min) min = observed;
    if (max === null || observed > max) max = observed;
    let record: IngestRecord;
    try {
      record = await toIngestRecord(contract.toRecord(row), new Date(observed).toISOString());
    } catch (error) {
      refuse(`row ${line + 1}: ${error instanceof Error ? error.message : "could not be built"}`);
    }
    if (!contract.record_kinds.includes(record.record_kind)) refuse(`row ${line + 1}: a record kind this contract does not declare`);
    const entry = state.get(record.external_record_id);
    if (!entry) {
      state.set(record.external_record_id, { last: record.content_hash, seen: new Set([record.content_hash]), generation: 1 });
      lineGeneration[line] = 1;
      kinds[record.record_kind] = (kinds[record.record_kind] ?? 0) + 1;
      if (record.source_published_at) dated++;
      continue;
    }
    if (entry.last === record.content_hash) {
      collapsed++;
      continue;
    }
    if (entry.seen.has(record.content_hash)) returning++;
    entry.seen.add(record.content_hash);
    entry.last = record.content_hash;
    entry.generation++;
    if (entry.generation > 250) refuse("an item changes more often than a generation counter can hold");
    lineGeneration[line] = entry.generation;
  }
  if (count !== rows) refuse("the file holds fewer rows than its verified count");
  const perGeneration: number[] = [];
  for (const g of lineGeneration) if (g > 0) perGeneration[g - 1] = (perGeneration[g - 1] ?? 0) + 1;
  let versions = 0;
  for (const entry of state.values()) versions += entry.seen.size;
  return {
    rows, distinct_records: state.size, distinct_versions: versions, generations: perGeneration.length,
    rows_per_generation: perGeneration.map((n) => n ?? 0), collapsed_rows: collapsed, returning_rows: returning, records_by_kind: kinds,
    rows_with_publisher_date: dated, observed_min: min, observed_max: max, lineGeneration,
  };
}

export interface VerifiedInput {
  location: string;
  pin: ExportPin;
  plan: ImportPlan;
}

/** Pin, manifest and plan. Nothing is written anywhere until this has returned. */
export async function verifyInput(contract: FamilyExportContract, env: { [key: string]: string | undefined }): Promise<VerifiedInput> {
  const location = env[contract.fileEnv];
  if (!location) throw new IngestError("missing_input", `set ${contract.fileEnv} to the reviewed export file`);
  const manifestLocation = env[contract.manifestEnv];
  if (!manifestLocation) throw new IngestError("missing_input", `set ${contract.manifestEnv} to the manifest written beside the export`);
  if (!contract.pin) refuse("this contract is not pinned to a verified export; run the exporter and review the pin first");
  let facts;
  try {
    facts = await inspectExportFile(contract, location);
  } catch (error) {
    refuse(error instanceof Error ? error.message : "the export could not be read");
  }
  for (const key of ["sha256", "bytes", "rows", "distinct_records"] as const) {
    if (facts.pin[key] !== contract.pin[key]) refuse(`input ${key} does not match the pinned export`);
  }
  if (facts.unusable_rows > 0) refuse(`${facts.unusable_rows} rows cannot be built into records; the file is refused whole`);
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(await readFile(manifestLocation, "utf-8")) as ExportManifest;
  } catch {
    refuse("the export manifest could not be read as JSON");
  }
  if (manifest.source_id !== contract.source_id) refuse("the manifest belongs to another source");
  if (manifest.export?.sha256 !== facts.pin.sha256 || manifest.export?.rows !== facts.pin.rows) refuse("the manifest does not describe this file");
  if (!manifest.agreement?.rows || !manifest.agreement?.distinct_records) refuse("the manifest records a disagreement with the upstream counts");
  return { location, pin: facts.pin, plan: await planImport(contract, location, facts.pin.rows) };
}

export function generationAdapter(contract: FamilyExportContract, input: VerifiedInput, generation: number): Adapter {
  return {
    name: FAMILY_EXPORT_ADAPTER,
    // The generation is part of the version, so it is part of the run manifest: a checkpoint is only ever resumed by
    // the same generation of the same file.
    version: `${FAMILY_EXPORT_ADAPTER_VERSION}+generation.${generation}`,
    async *pages(ctx: AdapterContext): AsyncGenerator<AdapterPage> {
      const resume = ctx.resumeCursor as { generation?: number; next_line?: number } | null;
      const start = resume?.generation === generation && Number.isInteger(resume.next_line) ? (resume.next_line as number) : 0;
      let records: IngestRecord[] = [];
      let emitted = 0;
      let lastLine = -1;
      for await (const { line, row } of exportRows(input.location)) {
        lastLine = line;
        if (line < start || input.plan.lineGeneration[line] !== generation) continue;
        const hash = typeof row.upstream_content_hash === "string" && /^[A-Za-z0-9:_-]{8,200}$/.test(row.upstream_content_hash) ? row.upstream_content_hash : undefined;
        // retrieved_at is the upstream COLLECTION time. The publisher's own date travels separately, from the builder.
        records.push(await toIngestRecord(contract.toRecord(row), new Date(String(row.observed_at)).toISOString(), hash));
        if (records.length >= PAGE_ROWS) {
          emitted += records.length;
          yield { records, cursor: { generation, next_line: line + 1 } as Json, done: false, completeSnapshot: false, watermark: input.pin.sha256 };
          records = [];
          if (emitted >= ctx.maxRecords || ctx.now().getTime() > ctx.deadline - 15000) return;
        }
      }
      // An export is a statement about what was collected then, never about what the publisher lists now:
      // completeSnapshot stays false, so an import can never tombstone anything.
      yield { records, cursor: { generation, next_line: lastLine + 1 } as Json, done: true, completeSnapshot: false, watermark: input.pin.sha256 };
    },
  };
}

export interface GenerationReceipt {
  generation: number;
  planned_rows: number;
  attempts: { run_id: string | null; resumed_from_run_id: string | null; status: string; error_class: string | null; error_detail: string | null; totals: RunReport["totals"]; pages: number; manifest_hash: string }[];
  totals: RunReport["totals"];
  projection: Json | null;
}

export interface FamilyImportReceipt {
  receipt_version: 1;
  source_id: string;
  product_ids: string[];
  dry_run: boolean;
  status: "succeeded" | "failed" | "dry_run";
  input: ExportPin;
  plan: Omit<ImportPlan, "lineGeneration">;
  generations: GenerationReceipt[];
  /** Read back from the destination after the last generation. Null on a dry run. */
  destination: { [key: string]: Json } | null;
  reconciliation: { check: string; expected: number; actual: number | null; ok: boolean | null }[];
  reconciled: boolean | null;
}

export interface FamilyImportOptions {
  file: SourcesFile;
  source: SourceConfig;
  contract: FamilyExportContract;
  env: { [key: string]: string | undefined };
  db: IngestDb | null;
  dryRun: boolean;
  /** Counts held by the destination for the source (evidence_private.source_reconciliation). */
  readDestination?: (sourceId: string) => Promise<{ [key: string]: Json }>;
  maxRuntimeSeconds?: number;
  maxAttemptsPerGeneration?: number;
  now?: () => Date;
}

const ZERO = { seen: 0, versions_inserted: 0, observations_inserted: 0, unchanged: 0, rejected: 0 };

export async function importFamilyExport(options: FamilyImportOptions): Promise<FamilyImportReceipt> {
  const { contract, source } = options;
  if (source.source_id !== contract.source_id || source.adapter_kind !== "export_import") throw new IngestError("config_error", "source and contract do not belong together");
  const input = await verifyInput(contract, options.env);
  const { lineGeneration: _omit, ...plan } = input.plan;
  void _omit;
  const receipt: FamilyImportReceipt = {
    receipt_version: 1, source_id: source.source_id, product_ids: contract.product_ids, dry_run: options.dryRun,
    status: options.dryRun ? "dry_run" : "failed", input: input.pin, plan, generations: [], destination: null, reconciliation: [], reconciled: null,
  };

  for (let generation = 1; generation <= input.plan.generations; generation++) {
    const planned = input.plan.rows_per_generation[generation - 1];
    const entry: GenerationReceipt = { generation, planned_rows: planned, attempts: [], totals: { ...ZERO }, projection: null };
    receipt.generations.push(entry);
    let finished = false;
    for (let attempt = 1; attempt <= (options.maxAttemptsPerGeneration ?? 6) && !finished; attempt++) {
      const report = await runSource({
        file: options.file, source, adapter: generationAdapter(contract, input, generation), mode: "export_import", triggerKind: "cli",
        maxRecords: 100_000_000, maxRuntimeSeconds: options.maxRuntimeSeconds ?? 3300, dryRun: options.dryRun, db: options.db,
        inputDigest: { sha256: input.pin.sha256, bytes: input.pin.bytes, rows: input.pin.rows }, now: options.now,
      });
      entry.attempts.push({
        run_id: report.run_id, resumed_from_run_id: report.resumed_from_run_id, status: report.status, error_class: report.error_class,
        error_detail: report.error_detail, totals: report.totals, pages: report.pages, manifest_hash: report.manifest_hash,
      });
      for (const key of Object.keys(entry.totals) as (keyof typeof ZERO)[]) entry.totals[key] += report.totals[key];
      if (report.projection !== undefined) entry.projection = report.projection;
      // A partial run stopped at its time budget and left a checkpoint: the next attempt resumes it.
      if (report.status === "succeeded" || report.status === "dry_run") finished = true;
      else if (report.status !== "partial") return receipt;
    }
    if (!finished) return receipt;
    if (entry.totals.seen !== planned && !options.dryRun && entry.attempts.every((a) => a.resumed_from_run_id === null)) return receipt;
  }

  if (options.dryRun) {
    const seen = receipt.generations.reduce((sum, g) => sum + g.totals.seen, 0);
    receipt.reconciliation.push({ check: "rows replayed + rows collapsed = rows in the export", expected: plan.rows, actual: seen + plan.collapsed_rows, ok: seen + plan.collapsed_rows === plan.rows });
    receipt.reconciled = receipt.reconciliation.every((c) => c.ok);
    return receipt;
  }

  const rejected = receipt.generations.reduce((sum, g) => sum + g.totals.rejected, 0);
  const destination = options.readDestination ? await options.readDestination(source.source_id) : null;
  receipt.destination = destination;
  const actual = (key: string): number | null => (destination && typeof destination[key] === "number" ? (destination[key] as number) : null);
  const check = (name: string, expected: number, value: number | null) => receipt.reconciliation.push({ check: name, expected, actual: value, ok: value === null ? null : value === expected });
  check("records rejected by the ledger guard", 0, rejected);
  check("destination records = distinct publisher items in the export", plan.distinct_records, actual("records"));
  check("destination versions = distinct contents in the export", plan.distinct_versions, actual("versions"));
  check("destination records without a current version", 0, actual("records_without_current_version"));
  check("destination tombstones written by an import", 0, actual("records_tombstoned"));
  receipt.reconciled = receipt.reconciliation.every((c) => c.ok === true);
  receipt.status = receipt.reconciled ? "succeeded" : "failed";
  return receipt;
}
