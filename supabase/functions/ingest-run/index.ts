// Edge Function: one bounded incremental ingestion run for one configured source.
//
// Caller: pg_cron -> evidence_private.dispatch_ingest() -> pg_net, carrying the Vault-held secret.
// Auth:   x-evidence-cron-secret header compared in constant time with the function secret
//         EVIDENCE_CRON_SECRET. JWT verification is off for this function (config.toml) because
//         the caller is the database scheduler, not a user; no anon or service key is involved.
// Scope:  connects with EVIDENCE_INGEST_DB_URL, a login that is only a member of evidence_ingest.
// Bounds: <= 140 s and <= 2000 records per call. Backfills run from the CLI, never here.

import postgres from "postgres";
import { LIVE_ADAPTERS } from "../_shared/adapters/index.ts";
import { authoriseCronRequest, parseIngestRequest } from "../_shared/auth.ts";
import { createPostgresDb } from "../_shared/db.ts";
import { validateSourcesFile } from "../_shared/registry.ts";
import { runSource } from "../_shared/runner.ts";
import type { SourcesFile } from "../_shared/types.ts";
import sourcesFile from "../_shared/sources.config.json" with { type: "json" };

const FUNCTION_VERSION = "ingest-run/1.0.0";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json(405, { error: "POST only" });
  const auth = authoriseCronRequest(request.headers.get("x-evidence-cron-secret"), Deno.env.get("EVIDENCE_CRON_SECRET"));
  if (!auth.ok) return json(auth.status, { error: auth.reason });

  let body;
  try {
    body = parseIngestRequest(await request.json());
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : "bad request" });
  }

  const file = sourcesFile as unknown as SourcesFile;
  const problems = validateSourcesFile(file);
  if (problems.length > 0) return json(500, { error: "source configuration is invalid", problems });
  const source = file.sources.find((s) => s.source_id === body.source_id);
  if (!source || source.adapter_kind !== "live_fetch" || !source.enabled) return json(404, { error: "no enabled live source with that id" });
  const adapter = LIVE_ADAPTERS[source.adapter_name];
  if (!adapter) return json(500, { error: "adapter not bundled" });

  const dbUrl = Deno.env.get("EVIDENCE_INGEST_DB_URL");
  if (!dbUrl) return json(503, { error: "ingest connection is not configured" });
  // prepare:false keeps the connection valid behind a transaction-mode pooler.
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10, connection: { application_name: FUNCTION_VERSION } });
  try {
    const db = createPostgresDb(sql);
    const report = await runSource({
      file, source, adapter, mode: "incremental", triggerKind: body.trigger_kind,
      maxRecords: body.max_records, maxRuntimeSeconds: body.max_runtime_seconds, dryRun: false, db,
    });
    // Counts and status only. Payloads and fetch bodies never leave through the response.
    return json(report.status === "failed" ? 502 : 200, {
      function_version: FUNCTION_VERSION, source_id: report.source_id, run_id: report.run_id, status: report.status,
      complete_snapshot: report.complete_snapshot, error_class: report.error_class, totals: report.totals,
      tombstoned: report.tombstoned, pages: report.pages, fetch_attempts: report.fetches.length,
    });
  } catch (error) {
    // Log the class and a redacted message only: never a connection string or a payload.
    const message = error instanceof Error ? error.message : String(error);
    console.error("ingest-run failed:", error instanceof Error ? error.name : "error",
      message.replace(/postgres(?:ql)?:\/\/\S+/g, "[redacted-url]").replace(/password\S*/gi, "[redacted]").slice(0, 300));
    return json(500, { error: "run failed before a ledger entry could be finished" });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
});
