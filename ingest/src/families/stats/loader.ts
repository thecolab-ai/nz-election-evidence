// Statistics family: the loader. The only writer of statistics rows.
//
// Order of work: verify the artifact against its manifest (done by openArtifact) -> validate EVERY row before a run
// exists, so a bad artifact writes nothing -> lease and run ledger -> meta rows -> observations in checkpointed
// batches -> destination counts -> reconciliation -> finish. Every write is one call to a versioned
// evidence_private function. A replay of the same artifact inserts nothing and reports every row as unchanged.

import postgres from "postgres";
import { type OpenArtifact, readObservations } from "./artifact.ts";
import { ContractError, type MetaRow, type ReconciliationLine, sha256Text } from "./contract.ts";
import type { StatsSourcePlan } from "./routes.ts";

export const LOADER_VERSION = "1.0.0";
const OBSERVATION_BATCH = 5000;
const META_BATCH = 2000;

export interface ObservationBatchResult { seen: number; inserted: number; unchanged: number; conflicts: number }

/** Database port. The only statements issued are calls to evidence_private functions. */
export interface StatDb {
  syncRegistry(payload: unknown): Promise<unknown>;
  acquireLease(sourceId: string, holder: string, ttlSeconds: number): Promise<boolean>;
  releaseLease(sourceId: string, holder: string): Promise<void>;
  startRun(sourceId: string, holder: string, version: string, mode: string, manifestHash: string): Promise<{ run_id: string; resumed_from_run_id: string | null; resume_cursor: unknown }>;
  ingestMeta(runId: string, holder: string, meta: { [section: string]: unknown[] }): Promise<{ [key: string]: number }>;
  ingestObservations(runId: string, holder: string, rows: unknown[]): Promise<ObservationBatchResult>;
  saveCheckpoint(runId: string, holder: string, cursor: { file: string; offset: number }, recordsSoFar: number): Promise<void>;
  counts(sourceId: string): Promise<DestinationCounts>;
  finishRun(runId: string, holder: string, status: "succeeded" | "failed", watermark: string, errorClass: string | null, errorDetail: string | null): Promise<{ status: string }>;
  close(): Promise<void>;
}

export interface DestinationCounts {
  datasets: number; releases: number; series: number; geographies: number; catalogue_entry_versions: number; catalogue_entries_current: number;
  observations: number; observations_by_release: { [key: string]: number }; observations_by_status: { [key: string]: number };
  withheld_rows_carrying_a_number: number; content_digest: string;
}

export async function connectLoader(env: { [key: string]: string | undefined }): Promise<StatDb> {
  const url = env.EVIDENCE_INGEST_DB_URL;
  if (!url) throw new Error("EVIDENCE_INGEST_DB_URL is not set (see docs/database/runbook.md)");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined, connection: { application_name: "evidence-stats-loader" } });
  const [{ me, elevated }] = await sql`select current_user as me, (select rolsuper or rolbypassrls or rolcreaterole from pg_roles where rolname = current_user) as elevated`;
  if (elevated && env.EVIDENCE_ALLOW_ELEVATED_LOGIN !== "1") {
    await sql.end({ timeout: 5 });
    throw new Error(`refusing to load as "${me}": use a login that is only a member of evidence_ingest`);
  }
  const one = async <T>(query: Promise<{ r: unknown }[]>): Promise<T> => (await query)[0].r as T;
  return {
    syncRegistry: (payload) => one(sql`select evidence_private.sync_registry(${sql.json(payload as never)}) as r`),
    acquireLease: (sourceId, holder, ttl) => one(sql`select evidence_private.acquire_lease(${sourceId}, ${holder}::uuid, ${ttl}::integer) as r`),
    releaseLease: async (sourceId, holder) => { await sql`select evidence_private.release_lease(${sourceId}, ${holder}::uuid)`; },
    startRun: (sourceId, holder, version, mode, manifestHash) => one(sql`select evidence_private.start_run(${sourceId}, ${holder}::uuid, ${version}, ${mode}, 'cli', ${manifestHash}) as r`),
    ingestMeta: (runId, holder, meta) => one(sql`select evidence_private.ingest_stat_meta(${runId}::uuid, ${holder}::uuid, ${sql.json(meta as never)}) as r`),
    ingestObservations: (runId, holder, rows) => one(sql`select evidence_private.ingest_stat_observations(${runId}::uuid, ${holder}::uuid, ${sql.json(rows as never)}) as r`),
    saveCheckpoint: async (runId, holder, cursor, recordsSoFar) => { await sql`select evidence_private.save_checkpoint(${runId}::uuid, ${holder}::uuid, ${sql.json(cursor)}, ${recordsSoFar}::integer, 900)`; },
    counts: (sourceId) => one(sql`select evidence_private.stat_source_counts(${sourceId}) as r`),
    finishRun: (runId, holder, status, watermark, errorClass, errorDetail) =>
      one(sql`select evidence_private.finish_run(${runId}::uuid, ${holder}::uuid, ${status}, false, ${watermark}, ${errorClass}, ${errorDetail}) as r`),
    close: async () => { await sql.end({ timeout: 5 }); },
  };
}

export interface LoadReceipt {
  receipt_version: 1;
  source_id: string;
  products: string[];
  dry_run: boolean;
  status: "succeeded" | "failed" | "dry_run" | "skipped_lease_held";
  error_class: string | null;
  error_detail: string | null;
  run_id: string | null;
  resumed_from_run_id: string | null;
  loader_version: string;
  artifact: { digest: string; producer: OpenArtifact["manifest"]["producer"]; collected_from: string | null; collected_to: string | null; files: number; counts: OpenArtifact["manifest"]["counts"] };
  /** Upstream -> artifact, as the exporter reconciled it. */
  source_to_artifact: ReconciliationLine[];
  /** Artifact -> store, measured after the load. */
  artifact_to_destination: ReconciliationLine[];
  totals: { meta: { [key: string]: number }; observations: ObservationBatchResult; batches: number };
  /** True when this run wrote nothing because the store already held every row of the artifact. */
  replay_wrote_nothing: boolean;
  destination: DestinationCounts | null;
  findings: string[];
}

function sections(meta: MetaRow[]): { first: { [section: string]: unknown[] }; series: unknown[]; geographies: unknown[]; entries: unknown[] } {
  const strip = (row: MetaRow) => {
    const { kind: _kind, ...rest } = row as MetaRow & { kind: string };
    void _kind;
    return rest;
  };
  const of = (kind: MetaRow["kind"]) => meta.filter((row) => row.kind === kind).map(strip);
  return { first: { routes: of("route"), datasets: of("dataset"), releases: of("release") }, series: of("series"), geographies: of("geography"), entries: of("catalogue_entry") };
}

function sanitize(message: string): string {
  return message.replace(/(postgres(?:ql)?:\/\/)[^\s]+/g, "$1[redacted]").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted]").slice(0, 500);
}

export interface LoadOptions { dryRun: boolean; log?: (message: string) => void; holder?: string; /** Test hook: stop after this many observation batches, leaving the run for a resume. */ failAfterBatches?: number }

export async function loadSource(plan: StatsSourcePlan, artifact: OpenArtifact, db: StatDb | null, options: LoadOptions): Promise<LoadReceipt> {
  const log = options.log ?? (() => undefined);
  const manifest = artifact.manifest;
  const receipt: LoadReceipt = {
    receipt_version: 1, source_id: plan.source_id, products: plan.products.map((p) => p.product_id), dry_run: options.dryRun, status: options.dryRun ? "dry_run" : "failed",
    error_class: null, error_detail: null, run_id: null, resumed_from_run_id: null, loader_version: LOADER_VERSION,
    artifact: { digest: artifact.digest, producer: manifest.producer, collected_from: manifest.collected_from, collected_to: manifest.collected_to, files: manifest.files.length, counts: manifest.counts },
    source_to_artifact: manifest.reconciliation, artifact_to_destination: [],
    totals: { meta: {}, observations: { seen: 0, inserted: 0, unchanged: 0, conflicts: 0 }, batches: 0 }, replay_wrote_nothing: false, destination: null, findings: [...manifest.findings],
  };
  if (manifest.source_id !== plan.source_id) throw new ContractError("artifact belongs to another source");
  if (manifest.reconciliation.some((line) => line.explanation.startsWith("UNEXPLAINED"))) throw new ContractError("artifact carries an unexplained source difference; it is not loadable");

  // Preflight: every row is validated (readObservations validates) and counted per release before a run exists.
  const perRelease = new Map<string, number>();
  let preflightRows = 0;
  for (const file of artifact.observationFiles) {
    for await (const row of readObservations(artifact, file)) {
      preflightRows++;
      const key = `${row.dataset_key} @ ${row.release_key}`;
      perRelease.set(key, (perRelease.get(key) ?? 0) + 1);
    }
  }
  if (preflightRows !== manifest.counts.observations) throw new ContractError("artifact observation rows differ from its manifest count");
  const known = new Set(artifact.meta.filter((row) => row.kind === "release").map((row) => `${row.dataset_key} @ ${row.release_key}`));
  for (const key of perRelease.keys()) if (!known.has(key)) throw new ContractError("artifact holds observations of a release its meta file does not describe");
  log(`${plan.source_id}: preflight passed (${preflightRows} observations, ${artifact.meta.length} meta rows)`);
  if (options.dryRun || !db) return receipt;

  const holder = options.holder ?? crypto.randomUUID();
  if (!(await db.acquireLease(plan.source_id, holder, 900))) {
    receipt.status = "skipped_lease_held";
    receipt.error_class = "lease_held";
    return receipt;
  }
  const mode = manifest.producer.route === "fresh_fetch" ? "incremental" : "export_import";
  const manifestHash = "sha256:" + sha256Text(LOADER_VERSION + "\n" + artifact.digest);
  let runId: string | null = null;
  try {
    const started = await db.startRun(plan.source_id, holder, LOADER_VERSION, mode, manifestHash);
    runId = started.run_id;
    receipt.run_id = runId;
    receipt.resumed_from_run_id = started.resumed_from_run_id;
    const resume = started.resume_cursor as { file?: string; offset?: number } | null;

    // Meta is small and idempotent, so it is always sent in full, resumed run or not.
    const parts = sections(artifact.meta);
    const add = (result: { [key: string]: number }) => { for (const [k, v] of Object.entries(result)) receipt.totals.meta[k] = (receipt.totals.meta[k] ?? 0) + v; };
    add(await db.ingestMeta(runId, holder, parts.first));
    for (let i = 0; i < parts.series.length; i += META_BATCH) add(await db.ingestMeta(runId, holder, { series: parts.series.slice(i, i + META_BATCH) }));
    for (let i = 0; i < parts.geographies.length; i += META_BATCH) add(await db.ingestMeta(runId, holder, { geographies: parts.geographies.slice(i, i + META_BATCH) }));
    for (let i = 0; i < parts.entries.length; i += 500) add(await db.ingestMeta(runId, holder, { catalogue_entries: parts.entries.slice(i, i + 500) }));

    let sent = 0;
    let skipping = Boolean(resume?.file);
    for (const file of artifact.observationFiles) {
      if (skipping && resume && file.name !== resume.file) { sent += file.rows; continue; }
      let offset = 0;
      let batch: unknown[] = [];
      const flush = async () => {
        if (batch.length === 0) return;
        const result = await db.ingestObservations(runId!, holder, batch);
        for (const key of ["seen", "inserted", "unchanged", "conflicts"] as const) receipt.totals.observations[key] += result[key];
        receipt.totals.batches++;
        sent += batch.length;
        batch = [];
        // Checkpoint only after the batch is stored, so a resume never skips a row.
        await db.saveCheckpoint(runId!, holder, { file: file.name, offset }, sent);
        if (options.failAfterBatches && receipt.totals.batches >= options.failAfterBatches) throw new ContractError("test hook: stopped after a stored batch");
      };
      for await (const row of readObservations(artifact, file)) {
        offset++;
        if (skipping && resume && offset <= (resume.offset ?? 0)) { sent++; continue; }
        const { kind: _kind, ...rest } = row;
        void _kind;
        batch.push(rest);
        if (batch.length >= OBSERVATION_BATCH) await flush();
      }
      await flush();
      skipping = false;
      log(`${plan.source_id}: ${file.name} stored (${sent}/${manifest.counts.observations})`);
    }

    const destination = await db.counts(plan.source_id);
    receipt.destination = destination;
    const lines: ReconciliationLine[] = [];
    for (const [key, rows] of [...perRelease].sort()) {
      const stored = destination.observations_by_release[key] ?? 0;
      lines.push({ what: `observations of ${key}: artifact -> store`, upstream_rows: rows, artifact_rows: stored, difference: stored - rows, explanation: stored === rows ? "every artifact row is stored exactly once" : "UNEXPLAINED" });
    }
    const entryVersions = manifest.counts.catalogue_entries;
    if (entryVersions > 0 || destination.catalogue_entry_versions > 0) {
      const ok = manifest.producer.route === "fresh_fetch" ? destination.catalogue_entry_versions >= entryVersions : destination.catalogue_entry_versions === entryVersions;
      lines.push({
        what: "catalogue entry versions: artifact -> store", upstream_rows: entryVersions, artifact_rows: destination.catalogue_entry_versions, difference: destination.catalogue_entry_versions - entryVersions,
        explanation: ok ? (destination.catalogue_entry_versions === entryVersions ? "every artifact version is stored exactly once" : "the store also holds versions from earlier loads of this source; none of this artifact's versions is missing") : "UNEXPLAINED",
      });
    }
    lines.push({
      what: "withheld, confidential, missing or not-applicable rows that carry a number", upstream_rows: 0, artifact_rows: destination.withheld_rows_carrying_a_number,
      difference: destination.withheld_rows_carrying_a_number, explanation: destination.withheld_rows_carrying_a_number === 0 ? "none: a value the publisher did not print is stored as null with its status, never as zero" : "UNEXPLAINED",
    });
    receipt.artifact_to_destination = lines;

    const conflicts = receipt.totals.observations.conflicts;
    const unexplained = lines.some((line) => line.explanation === "UNEXPLAINED");
    const failed = conflicts > 0 || unexplained;
    const errorClass = conflicts > 0 ? "stat_identity_conflict" : unexplained ? "reconciliation_failed" : null;
    const detail = conflicts > 0 ? `${conflicts} observation(s) exist with different content under the same identity; kept as stored` : unexplained ? "store counts differ from the artifact" : null;
    const finished = await db.finishRun(runId, holder, failed ? "failed" : "succeeded", artifact.digest, errorClass, detail);
    receipt.status = finished.status === "succeeded" ? "succeeded" : "failed";
    receipt.error_class = errorClass;
    receipt.error_detail = detail;
    receipt.replay_wrote_nothing = receipt.totals.observations.inserted === 0 && (receipt.totals.meta.catalogue_entries_written ?? 0) === 0
      && (receipt.totals.meta.series_inserted ?? 0) === 0 && (receipt.totals.meta.geographies_inserted ?? 0) === 0;
    return receipt;
  } catch (error) {
    receipt.status = "failed";
    receipt.error_class = error instanceof ContractError ? "contract_error" : "load_error";
    receipt.error_detail = sanitize(error instanceof Error ? error.message : String(error));
    if (runId && !(error instanceof ContractError && receipt.error_detail.startsWith("test hook"))) {
      try {
        await db.finishRun(runId, holder, "failed", artifact.digest, receipt.error_class, receipt.error_detail);
      } catch (finishError) {
        receipt.error_detail += " | finish failed: " + sanitize(finishError instanceof Error ? finishError.message : String(finishError));
      }
    } else if (!runId) {
      await db.releaseLease(plan.source_id, holder);
    }
    return receipt;
  }
}
