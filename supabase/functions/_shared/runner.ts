// One bounded ingestion run: lease -> run ledger -> adapter pages -> idempotent batches ->
// checkpoints -> typed projection -> finish (tombstones, freshness, lease release).
// The same code serves the Edge Function (small incremental budget) and the CLI (backfills).

import type { BatchResult, IngestDb } from "./db.ts";
import { createSafeFetch } from "./http.ts";
import { buildManifest, type RunManifest } from "./registry.ts";
import {
  type Adapter, type AdapterPage, type FetchLogEntry, IngestError, type IngestRecord, type Json,
  type SourceConfig, type SourcesFile, SourceUnavailableError,
} from "./types.ts";

export interface RunOptions {
  file: SourcesFile;
  source: SourceConfig;
  adapter: Adapter;
  mode: RunManifest["mode"];
  triggerKind: "cron" | "function_readback" | "cli" | "test";
  maxRecords: number;
  maxRuntimeSeconds: number;
  dryRun: boolean;
  db: IngestDb | null;
  holder?: string;
  batchSize?: number;
  inputDigest?: RunManifest["input_digest"];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Tests only: override the per-host pacing interval. Production uses the source's min_interval_ms. */
  minIntervalMs?: number;
  /** Test hook: throw after this many stored batches to simulate a crash mid-run. */
  failAfterBatches?: number;
}

export interface RunReport {
  source_id: string;
  mode: string;
  dry_run: boolean;
  manifest: RunManifest;
  manifest_hash: string;
  run_id: string | null;
  resumed_from_run_id: string | null;
  status: "succeeded" | "partial" | "failed" | "blocked" | "skipped_lease_held" | "dry_run";
  complete_snapshot: boolean;
  error_class: string | null;
  error_detail: string | null;
  totals: BatchResult;
  tombstoned: number;
  pages: number;
  fetches: FetchLogEntry[];
  /** Dry run only: identifiers and hashes of what would be written. Payloads are not echoed. */
  planned_records?: { external_record_id: string; record_kind: string; content_hash: string }[];
  projection?: Json;
}

function sanitizeDetail(message: string): string {
  return message.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted]").replace(/(postgres(?:ql)?:\/\/)[^\s]+/g, "$1[redacted]").slice(0, 500);
}

export async function runSource(options: RunOptions): Promise<RunReport> {
  const now = options.now ?? (() => new Date());
  const holder = options.holder ?? crypto.randomUUID();
  const batchSize = Math.min(options.batchSize ?? 200, 500);
  const deadline = now().getTime() + options.maxRuntimeSeconds * 1000;
  const fetches: FetchLogEntry[] = [];
  const { manifest, manifestHash } = await buildManifest(
    options.file, options.source, options.adapter.version, options.mode, options.maxRecords, options.inputDigest);

  const report: RunReport = {
    source_id: options.source.source_id, mode: options.mode, dry_run: options.dryRun, manifest, manifest_hash: manifestHash,
    run_id: null, resumed_from_run_id: null, status: options.dryRun ? "dry_run" : "failed", complete_snapshot: false,
    error_class: null, error_detail: null,
    totals: { seen: 0, versions_inserted: 0, observations_inserted: 0, unchanged: 0, rejected: 0 },
    tombstoned: 0, pages: 0, fetches,
  };

  const safeFetch = createSafeFetch({
    allowedHosts: options.source.allowed_hosts, log: fetches, deadline, minIntervalMs: options.minIntervalMs ?? options.source.min_interval_ms,
    fetchImpl: options.fetchImpl, sleep: options.sleep, now,
  });

  const db = options.dryRun ? null : options.db;
  if (!options.dryRun && !db) throw new Error("a database port is required unless dryRun is set");
  let resumeCursor: Json | null = null;

  if (db) {
    const ttl = Math.min(Math.max(options.maxRuntimeSeconds + 30, 30), 3600);
    if (!(await db.acquireLease(options.source.source_id, holder, ttl))) {
      report.status = "skipped_lease_held";
      report.error_class = "lease_held";
      return report;
    }
    try {
      const started = await db.startRun(options.source.source_id, holder, options.adapter.version, options.mode, options.triggerKind, manifestHash);
      report.run_id = started.run_id;
      report.resumed_from_run_id = started.resumed_from_run_id;
      resumeCursor = started.resume_cursor;
    } catch (error) {
      await db.releaseLease(options.source.source_id, holder);
      throw error;
    }
  }

  let lastPage: AdapterPage | null = null;
  let flushedFetches = 0;
  let storedBatches = 0;
  const flushFetchLog = async () => {
    if (db && fetches.length > flushedFetches) {
      await db.logFetch(report.run_id, options.source.source_id, fetches.slice(flushedFetches));
      flushedFetches = fetches.length;
    }
  };

  try {
    // Fail closed before any network request: an endpoint with no established basis for automated access.
    if (options.source.access_basis === "undocumented_endpoint") {
      throw new SourceUnavailableError("blocked", "no documented or permitted route to this data exists; the endpoint was not contacted", "access_basis_not_established");
    }
    const planned: NonNullable<RunReport["planned_records"]> = [];
    for await (const page of options.adapter.pages({
      source: options.source, fetch: safeFetch, resumeCursor, maxRecords: options.maxRecords, deadline, now,
    })) {
      report.pages++;
      lastPage = page;
      const records: IngestRecord[] = page.records.slice(0, Math.max(0, options.maxRecords - report.totals.seen));
      if (db && report.run_id) {
        for (let i = 0; i < records.length; i += batchSize) {
          const result = await db.ingestBatch(report.run_id, holder, records.slice(i, i + batchSize));
          for (const key of Object.keys(report.totals) as (keyof BatchResult)[]) report.totals[key] += result[key];
          storedBatches++;
          if (options.failAfterBatches && storedBatches >= options.failAfterBatches) {
            await db.saveCheckpoint(report.run_id, holder, page.cursor, report.totals.seen, 30);
            throw new IngestError("simulated_crash", "test hook: simulated crash after a stored batch");
          }
        }
        await flushFetchLog();
        // Checkpoint only after the page is durably stored, so a resume never skips records.
        await db.saveCheckpoint(report.run_id, holder, page.cursor, report.totals.seen, Math.ceil((deadline - now().getTime()) / 1000) + 30);
      } else {
        report.totals.seen += records.length;
        for (const record of records) planned.push({ external_record_id: record.external_record_id, record_kind: record.record_kind, content_hash: record.content_hash });
      }
      if (page.done || report.totals.seen >= options.maxRecords) break;
    }
    if (options.dryRun) {
      report.planned_records = planned;
      report.complete_snapshot = Boolean(lastPage?.completeSnapshot);
      return report;
    }

    // Anything short of the adapter reporting the end of the publisher's list is a partial run.
    const truncated = !lastPage?.done;
    const complete = Boolean(lastPage?.completeSnapshot) && !report.resumed_from_run_id && report.totals.rejected === 0;
    report.projection = await db!.projectRun(report.run_id!, holder);
    const status = truncated ? "partial" : "succeeded";
    const finished = await db!.finishRun(report.run_id!, holder, status, complete && status === "succeeded",
      lastPage?.watermark ?? null, truncated ? "budget_exhausted" : null, truncated ? "stopped at the record or time budget; next run resumes from the checkpoint" : null);
    report.status = finished.status as RunReport["status"];
    report.error_class = finished.error_class;
    report.tombstoned = finished.tombstoned;
    report.complete_snapshot = complete && finished.status === "succeeded";
    return report;
  } catch (error) {
    const unavailable = error instanceof SourceUnavailableError;
    report.status = options.dryRun ? "dry_run" : unavailable ? "blocked" : "failed";
    report.error_class = error instanceof IngestError ? error.errorClass : "unexpected_error";
    report.error_detail = sanitizeDetail(error instanceof Error ? error.message : String(error));
    if (options.dryRun) {
      report.status = unavailable ? "blocked" : "failed";
      return report;
    }
    if (db && report.run_id) {
      try {
        await flushFetchLog();
        if (report.error_class !== "simulated_crash") {
          await db.finishRun(report.run_id, holder, unavailable ? "blocked" : "failed", false, null, report.error_class, report.error_detail);
        }
      } catch (finishError) {
        report.error_detail += " | finish failed: " + sanitizeDetail(finishError instanceof Error ? finishError.message : String(finishError));
      }
    }
    return report;
  }
}
