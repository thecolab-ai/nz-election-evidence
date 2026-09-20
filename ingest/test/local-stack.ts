// Connection to the DISPOSABLE LOCAL Supabase stack for integration tests, assembled here so that no
// workflow or shell command ever carries a connection string. The scoped worker login and its random,
// per-bootstrap value come from the explicit bootstrap (`node src/local_bootstrap.ts`), which writes a
// git-ignored owner-only file. Nothing here can reach a hosted project: the host is pinned to loopback.
import { existsSync, readFileSync } from "node:fs";
import { LOCAL_CREDENTIAL_FILE, LOCAL_WORKER_LOGIN, localDbPort } from "../src/local_bootstrap.ts";

export { LOCAL_WORKER_LOGIN, localDbPort };
const LOOPBACK = "127.0.0.1";

export interface LocalStackChoice {
  url: string | null;
  /** True when skipping is not allowed (CI): a missing database is then a failure, not a skip. */
  required: boolean;
  /** Why there is no URL, when the local stack was asked for but is not usable. */
  problem?: string;
}

/** EVIDENCE_TEST_LOCAL_STACK=1 selects the local stack; EVIDENCE_REQUIRE_INTEGRATION=1 forbids skipping. */
export function localStackChoice(env: { [key: string]: string | undefined } = process.env, credentialFile = LOCAL_CREDENTIAL_FILE): LocalStackChoice {
  const required = env.EVIDENCE_REQUIRE_INTEGRATION === "1";
  if (env.EVIDENCE_TEST_LOCAL_STACK !== "1") return { url: null, required };
  if (!existsSync(credentialFile)) return { url: null, required, problem: "the local worker login has not been bootstrapped (node src/local_bootstrap.ts)" };
  const stored = JSON.parse(readFileSync(credentialFile, "utf-8")) as { login: string; value: string };
  if (stored.login !== LOCAL_WORKER_LOGIN) return { url: null, required, problem: "unexpected login in the local credential file" };
  const url = new URL(`postgresql://${LOOPBACK}/postgres`);
  url.username = LOCAL_WORKER_LOGIN;
  url.password = stored.value;
  url.port = String(localDbPort());
  return { url: url.toString(), required };
}
