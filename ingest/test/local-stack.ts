// Connection to the DISPOSABLE LOCAL Supabase stack for integration tests, assembled here so that no
// workflow or shell command ever carries a connection string. The login and its fixed local value are
// created by supabase/seed.sql on the throwaway local database only (a test below keeps the two in step).
// Nothing here can reach a hosted project: the host is pinned to the loopback address.
import { readFileSync } from "node:fs";

export const LOCAL_WORKER_LOGIN = "evidence_ingest_local";
const LOCAL_WORKER_VALUE = "local-only-not-a-secret";
const LOOPBACK = "127.0.0.1";

export function localDbPort(): number {
  const config = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf-8");
  const match = /\[db\][^[]*?\nport\s*=\s*(\d+)/.exec(config);
  if (!match) throw new Error("could not read [db] port from supabase/config.toml");
  return Number(match[1]);
}

export interface LocalStackChoice {
  url: string | null;
  /** True when skipping is not allowed (CI): a missing database is then a failure, not a skip. */
  required: boolean;
}

/** EVIDENCE_TEST_LOCAL_STACK=1 selects the local stack; EVIDENCE_REQUIRE_INTEGRATION=1 forbids skipping. */
export function localStackChoice(env: { [key: string]: string | undefined } = process.env): LocalStackChoice {
  const required = env.EVIDENCE_REQUIRE_INTEGRATION === "1";
  if (env.EVIDENCE_TEST_LOCAL_STACK !== "1") return { url: null, required };
  const url = new URL(`postgresql://${LOOPBACK}/postgres`);
  url.username = LOCAL_WORKER_LOGIN;
  url.password = LOCAL_WORKER_VALUE;
  url.port = String(localDbPort());
  return { url: url.toString(), required };
}

export function seedDeclaresSameLogin(): boolean {
  const seed = readFileSync(new URL("../../supabase/seed.sql", import.meta.url), "utf-8");
  return seed.includes(`create role ${LOCAL_WORKER_LOGIN} login password '${LOCAL_WORKER_VALUE}'`) && seed.includes("in role evidence_ingest");
}
