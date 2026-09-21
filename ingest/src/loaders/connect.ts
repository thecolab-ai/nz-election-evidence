// One way to reach the store: a login that is a member of evidence_ingest and nothing more. The connection value
// comes from the environment only and is never printed. Pooler-safe: one connection, no prepared statements.

import postgres from "postgres";
import { createPostgresDb, type IngestDb } from "../../../supabase/functions/_shared/db.ts";
import { LoaderError } from "./contract.ts";

export interface WorkerConnection { db: IngestDb; sql: postgres.Sql; close(): Promise<void> }

export async function connectWorker(env: { [key: string]: string | undefined }, applicationName = "evidence-ingest-cli"): Promise<WorkerConnection> {
  const url = env.EVIDENCE_INGEST_DB_URL;
  if (!url) throw new LoaderError("db_url_missing", "EVIDENCE_INGEST_DB_URL is not set (see docs/database/runbook.md)");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined, connection: { application_name: applicationName } });
  const [{ me, elevated }] = await sql`select current_user as me, (select rolsuper or rolbypassrls or rolcreaterole from pg_roles where rolname = current_user) as elevated`;
  if (elevated && env.EVIDENCE_ALLOW_ELEVATED_LOGIN !== "1") {
    await sql.end({ timeout: 5 });
    throw new LoaderError("elevated_login_refused", `refusing to ingest as "${me}": use a login that is only a member of evidence_ingest`);
  }
  const db = createPostgresDb(sql);
  return { db, sql, close: () => db.close() };
}
