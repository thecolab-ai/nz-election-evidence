// Database port for the runner. The only statements issued are calls to the versioned
// evidence_private ingestion functions; there is no free-form SQL path.

import type { FetchLogEntry, IngestRecord, Json } from "./types.ts";

export interface StartedRun {
  run_id: string;
  resumed_from_run_id: string | null;
  resume_cursor: Json | null;
}

export interface BatchResult {
  seen: number;
  versions_inserted: number;
  observations_inserted: number;
  unchanged: number;
  rejected: number;
}

export interface IngestDb {
  syncRegistry(payload: Json): Promise<Json>;
  syncSchedules(payload: Json): Promise<number>;
  acquireLease(sourceId: string, holder: string, ttlSeconds: number): Promise<boolean>;
  releaseLease(sourceId: string, holder: string): Promise<void>;
  startRun(sourceId: string, holder: string, adapterVersion: string, mode: string, triggerKind: string, manifestHash: string): Promise<StartedRun>;
  ingestBatch(runId: string, holder: string, records: IngestRecord[]): Promise<BatchResult>;
  saveCheckpoint(runId: string, holder: string, cursor: Json, recordsSoFar: number, extendSeconds: number): Promise<number>;
  logFetch(runId: string | null, sourceId: string, entries: FetchLogEntry[]): Promise<void>;
  projectRun(runId: string, holder: string): Promise<Json>;
  finishRun(runId: string, holder: string, status: string, completeSnapshot: boolean, watermark: string | null, errorClass: string | null, errorDetail: string | null): Promise<{ status: string; tombstoned: number; error_class: string | null }>;
  close(): Promise<void>;
}

// Minimal structural type for the postgres.js client so this file needs no import of it.
// deno-lint-ignore no-explicit-any
type Sql = any;

/**
 * Pooler-safe by construction: every call is one autocommit statement, nothing relies on session
 * state (no SET ROLE, no session advisory locks, no prepared statements, no temp tables), so the
 * connection may go through a transaction-mode pooler. Privileges come from the login itself, which
 * must be a member of evidence_ingest and nothing more.
 */
export function createPostgresDb(sql: Sql): IngestDb {
  const one = async (query: Promise<{ [key: string]: unknown }[]>) => (await query)[0].r;
  return {
    syncRegistry: (payload) => one(sql`select evidence_private.sync_registry(${sql.json(payload)}) as r`) as Promise<Json>,
    syncSchedules: (payload) => one(sql`select evidence_private.sync_schedules(${sql.json(payload)}) as r`) as Promise<number>,
    acquireLease: (sourceId, holder, ttl) => one(sql`select evidence_private.acquire_lease(${sourceId}, ${holder}::uuid, ${ttl}::integer) as r`) as Promise<boolean>,
    releaseLease: async (sourceId, holder) => { await sql`select evidence_private.release_lease(${sourceId}, ${holder}::uuid)`; },
    startRun: (sourceId, holder, adapterVersion, mode, triggerKind, manifestHash) =>
      one(sql`select evidence_private.start_run(${sourceId}, ${holder}::uuid, ${adapterVersion}, ${mode}, ${triggerKind}, ${manifestHash}) as r`) as Promise<StartedRun>,
    ingestBatch: (runId, holder, records) =>
      one(sql`select evidence_private.ingest_batch(${runId}::uuid, ${holder}::uuid, ${sql.json(records)}) as r`) as Promise<BatchResult>,
    saveCheckpoint: (runId, holder, cursor, recordsSoFar, extendSeconds) =>
      one(sql`select evidence_private.save_checkpoint(${runId}::uuid, ${holder}::uuid, ${sql.json(cursor)}, ${recordsSoFar}::integer, ${extendSeconds}::integer) as r`) as Promise<number>,
    logFetch: async (runId, sourceId, entries) => {
      if (entries.length === 0) return;
      await sql`select evidence_private.log_fetch(${runId}::uuid, ${sourceId}, ${sql.json(entries)})`;
    },
    projectRun: (runId, holder) => one(sql`select evidence_private.project_run(${runId}::uuid, ${holder}::uuid) as r`) as Promise<Json>,
    finishRun: (runId, holder, status, completeSnapshot, watermark, errorClass, errorDetail) =>
      one(sql`select evidence_private.finish_run(${runId}::uuid, ${holder}::uuid, ${status}, ${completeSnapshot}, ${watermark}, ${errorClass}, ${errorDetail}) as r`) as Promise<{ status: string; tombstoned: number; error_class: string | null }>,
    close: async () => { await sql.end({ timeout: 5 }); },
  };
}
