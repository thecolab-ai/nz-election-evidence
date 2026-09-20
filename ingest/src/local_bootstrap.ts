#!/usr/bin/env node
// EXPLICIT bootstrap of the scoped worker login on the DISPOSABLE LOCAL stack (developer machine or CI job).
//
//   node src/local_bootstrap.ts
//
// Nothing runs this automatically: it is not a seed, not a migration and not part of `supabase db reset`, so no
// Supabase CLI command pointed at a hosted project can ever apply it. There is no fixed password anywhere: each
// run generates a random one, sends only its SCRAM verifier, and writes the value to a git-ignored, owner-only
// file that the integration tests read.
//
// It cannot be aimed at a remote database, and that is enforced rather than promised:
//   1. there is no host, URL or connection option. The only route is `docker exec` into the local CLI container;
//   2. a Docker daemon that is not a local socket is refused: DOCKER_HOST=tcp://... or ssh://..., a DOCKER_CONTEXT, and -
//      asked of the Docker CLI itself - the endpoint of whatever context is active (so `docker context use remote` counts);
//   3. the container must be exactly the one the CLI derives from this repository's project_id, from the daemon's own list;
//   4. the SQL itself refuses unless it arrived over the server's local unix socket (inet_server_addr() is null),
//      which no network client - however it was pointed - can satisfy.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scramSha256Verifier, VERIFIER_SHAPE } from "./scram.ts";

export const LOCAL_WORKER_LOGIN = "evidence_ingest_local";
export const LOCAL_CREDENTIAL_FILE = fileURLToPath(new URL("../.local-stack.json", import.meta.url));

export function localProjectId(): string {
  const config = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf-8");
  const match = /^project_id\s*=\s*"([a-z0-9-]+)"/m.exec(config);
  if (!match) throw new Error("could not read project_id from supabase/config.toml");
  return match[1];
}

export function localDbPort(): number {
  const config = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf-8");
  const match = /\[db\][^[]*?\nport\s*=\s*(\d+)/.exec(config);
  if (!match) throw new Error("could not read [db] port from supabase/config.toml");
  return Number(match[1]);
}

export class RemoteTargetRefused extends Error {}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True only when the value names a loopback database: a bare host, or a URL whose parsed HOSTNAME is loopback. */
export function namesLoopbackOnly(value: string): boolean {
  if (LOOPBACK_HOSTS.has(value.toLowerCase())) return true;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  try {
    // Parsed, never pattern-matched: "postgresql://localhost:pw@db.remote.example/x" has the hostname db.remote.example.
    return LOOPBACK_HOSTS.has(new URL(value.replace(/^[a-z][a-z0-9+.-]*:/i, "http:")).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Refuses every way this tool could be steered at something other than the local Docker daemon. */
export function assertLocalDockerOnly(argv: string[], env: { [key: string]: string | undefined }): void {
  if (argv.length > 0) throw new RemoteTargetRefused("this tool takes no arguments: it has no target option by design");
  const dockerHost = env.DOCKER_HOST;
  if (dockerHost && !dockerHost.startsWith("unix://")) throw new RemoteTargetRefused("DOCKER_HOST points at a remote Docker daemon; the bootstrap only runs against the local one");
  if (env.DOCKER_CONTEXT && env.DOCKER_CONTEXT !== "default") throw new RemoteTargetRefused("a non-default DOCKER_CONTEXT is set; the bootstrap only runs against the local Docker daemon");
  for (const name of ["SUPABASE_DB_URL", "DATABASE_URL", "EVIDENCE_INGEST_DB_URL", "PGHOST"]) {
    const value = env[name];
    if (value && !namesLoopbackOnly(value)) {
      throw new RemoteTargetRefused(`${name} names a non-local database in this shell; refusing to bootstrap a local login next to it`);
    }
  }
}

/**
 * The endpoint the Docker CLI will ACTUALLY use, as reported by the CLI itself. This catches what the environment
 * cannot show: a remote context selected earlier with `docker context use`, or one supplied through DOCKER_CONFIG.
 */
export function assertLocalDockerEndpoint(endpoint: string): void {
  const value = endpoint.trim();
  if (!/^(unix|npipe):\/\//.test(value)) throw new RemoteTargetRefused("the active Docker context is not a local socket; the bootstrap only runs against the local Docker daemon");
}

/** Exactly this repository's local CLI database container, taken from the daemon's own list. */
export function pickLocalContainer(runningNames: string[], projectId: string): string {
  const expected = `supabase_db_${projectId}`;
  if (!runningNames.includes(expected)) {
    const others = runningNames.filter((name) => name.startsWith("supabase_db_")).length;
    throw new RemoteTargetRefused(others > 0 ? "a Supabase database container is running, but it is not this repository's local stack" : "the local stack is not running (supabase start)");
  }
  return expected;
}

/**
 * The statement the bootstrap runs. The guard comes first and is part of the same script, so the role
 * statement cannot run without it. Exported so a test can send it over TCP and watch it refuse.
 */
export function bootstrapSql(verifier: string): string {
  if (!VERIFIER_SHAPE.test(verifier)) throw new Error("verifier shape");
  const expires = new Date(Date.now() + 14 * 86400_000).toISOString();
  // ONE block. The socket check is the first statement of the same block that touches the role, so there is no way to
  // run the role statements without it - whatever client sends this, with or without stop-on-error.
  return `do $bootstrap$
begin
  if inet_server_addr() is not null then
    raise exception 'local bootstrap refused: this session is a network connection, not the local server socket';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'evidence_ingest') then
    raise exception 'local bootstrap refused: migrations have not been applied';
  end if;
  if exists (select 1 from pg_roles where rolname = '${LOCAL_WORKER_LOGIN}') then
    alter role ${LOCAL_WORKER_LOGIN} with login password '${verifier}';
  else
    create role ${LOCAL_WORKER_LOGIN} login password '${verifier}'
      nosuperuser nocreatedb nocreaterole noreplication nobypassrls in role evidence_ingest;
  end if;
  alter role ${LOCAL_WORKER_LOGIN} valid until '${expires}';
end
$bootstrap$;
`;
}

export function main(argv: string[], env: { [key: string]: string | undefined } = process.env): number {
  assertLocalDockerOnly(argv, env);
  assertLocalDockerEndpoint(execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf-8" }));
  const running = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf-8" }).split("\n").map((name) => name.trim()).filter(Boolean);
  const container = pickLocalContainer(running, localProjectId());

  const password = randomBytes(30).toString("base64url");
  // No -h: psql inside the container uses the server's unix socket, which is what the SQL guard checks for.
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"],
    { input: bootstrapSql(scramSha256Verifier(password)), stdio: ["pipe", "ignore", "pipe"] });
  writeFileSync(LOCAL_CREDENTIAL_FILE, JSON.stringify({ login: LOCAL_WORKER_LOGIN, value: password, port: localDbPort(), created_at: new Date().toISOString() }) + "\n", { mode: 0o600 });
  chmodSync(LOCAL_CREDENTIAL_FILE, 0o600);
  console.log(`local worker login ${LOCAL_WORKER_LOGIN} is ready (valid 14 days); its random value is in ingest/.local-stack.json (git-ignored, owner-only)`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.exit(main(process.argv.slice(2))); } catch (error) {
    console.error((error instanceof RemoteTargetRefused ? "refused: " : "failed: ") + (error as Error).message.split("\n")[0]);
    process.exit(1);
  }
}
