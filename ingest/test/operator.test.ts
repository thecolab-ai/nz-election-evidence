// Operator secret handling and the local bootstrap's refusal of remote targets. No database, no network:
// the administrator transaction is a recording stub, so the tests can prove what was and was NOT sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLocalDockerEndpoint, assertLocalDockerOnly, bootstrapSql, namesLoopbackOnly, pickLocalContainer, RemoteTargetRefused } from "../src/local_bootstrap.ts";
import { type AdminConnection, type AdminTx, main, parameterLoggingRisks, RefusedError, setCronSecrets, setIngestLogin, statementTextLoggingRisks, type LoggingSettings } from "../src/operator.ts";
import { scramSha256Verifier, secretShapeProblem, VERIFIER_SHAPE } from "../src/scram.ts";
import { readSecret, refuseSecretArguments, type SecretIo } from "../src/secret_input.ts";

const SECRET = "Zq7-TESTFIXTURE-not-a-real-secret-9fK2mXw4"; // TEST FIXTURE value, 42 characters
const quiet: LoggingSettings = { log_statement: "none", log_min_duration_statement: "-1", log_min_duration_sample: "-1", log_parameter_max_length: "0",
  log_parameter_max_length_on_error: "0", pgaudit_log: null, pgaudit_log_parameter: null, pgaudit_role: null, pgss_track_utility: "off",
  log_transaction_sample_rate: "0", auto_explain_log_min_duration: null, auto_explain_log_parameter_max_length: null, log_min_error_statement: "panic" };

/** A server whose logging the session may or may not change. Records every statement and parameter it is sent. */
function server(settings: LoggingSettings, canChange: boolean) {
  const current: { [name: string]: string | null } = {
    log_statement: settings.log_statement, log_min_duration_statement: settings.log_min_duration_statement, log_min_duration_sample: settings.log_min_duration_sample,
    log_parameter_max_length: settings.log_parameter_max_length, log_parameter_max_length_on_error: settings.log_parameter_max_length_on_error,
    "pgaudit.log": settings.pgaudit_log, "pgaudit.log_parameter": settings.pgaudit_log_parameter, "pgaudit.role": settings.pgaudit_role,
    "pg_stat_statements.track_utility": settings.pgss_track_utility, log_transaction_sample_rate: settings.log_transaction_sample_rate,
    "auto_explain.log_min_duration": settings.auto_explain_log_min_duration, "auto_explain.log_parameter_max_length": settings.auto_explain_log_parameter_max_length,
    log_min_error_statement: settings.log_min_error_statement,
  };
  const sent: string[] = [];
  const tx: AdminTx = {
    async query(text, params = []) {
      sent.push(text, ...params.map(String));
      if (text.startsWith("select current_setting")) return [{ v: current[String(params[0])] ?? null }];
      if (text.includes("functions_base_url_ok")) return [{ ok: true }];
      if (text.includes("from pg_roles r where")) return [{ rolname: params[0], rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolconnlimit: 6, member_of: "evidence_ingest" }];
      if (text.includes("from vault.secrets where name like")) return [{ name: "evidence_cron_secret", updated_at: "2026-09-20" }];
      return [];
    },
    async trySetLocal(name, value) {
      // log_parameter_max_length_on_error is user-settable on a real server; everything else needs privilege.
      if (!canChange && name !== "log_parameter_max_length_on_error") return false;
      if (current[name] === null && name.includes(".")) return false;
      current[name] = value;
      return true;
    },
  };
  const connect: AdminConnection = (work) => work(tx);
  return { connect, sent };
}

test("review 3/4: a secret can never arrive as a command-line argument", async () => {
  for (const argv of [["set-ingest-login", "--password", SECRET], ["set-cron-secrets", "--cron-secret=" + SECRET], ["set-ingest-login", "--login_password", "x"],
    ["set-ingest-login", "postgresql://admin:" + SECRET + "@db.example.org/postgres"]]) {
    assert.throws(() => refuseSecretArguments(argv), /never accepted on the command line/);
    await assert.rejects(main(argv, {}, { isTTY: false, readHidden: async () => "", readPiped: async () => "" }, () => {}), /never accepted on the command line/);
  }
  refuseSecretArguments(["set-cron-secrets", "--functions-base-url", "https://abcdefghijklmnopqrst.supabase.co/functions/v1"]);
});

test("review 3/4: input is hidden-and-confirmed on a terminal, first line on a pipe; a mismatch changes nothing", async () => {
  const prompts: string[] = [];
  const tty = (answers: string[]): SecretIo => ({ isTTY: true, readHidden: async (p) => { prompts.push(p); return answers.shift()!; }, readPiped: async () => { throw new Error("not a pipe"); } });
  assert.equal(await readSecret("cron secret", tty([SECRET, SECRET])), SECRET);
  assert.ok(prompts.every((p) => p.includes("cron secret") && !p.includes(SECRET)));
  await assert.rejects(readSecret("cron secret", tty([SECRET, SECRET + "x"])), /did not match/);
  assert.equal(await readSecret("x", { isTTY: false, readHidden: async () => { throw new Error("no tty"); }, readPiped: async () => SECRET + "\r" }), SECRET);
});

test("review 3: the role password never leaves the process - the server is sent a SCRAM verifier only", async () => {
  const { connect, sent } = server(quiet, true);
  const out: string[] = [];
  await setIngestLogin(connect, SECRET, { login: "evidence_ingest_login", acceptLoggedVerifier: false }, (l) => out.push(l));
  const ddl = sent.find((s) => /^(create|alter) role .* password /.test(s))!;
  assert.match(ddl, /password 'SCRAM-SHA-256\$4096:/);
  assert.ok(!sent.join("\n").includes(SECRET), "password is not in any statement or parameter");
  assert.ok(!out.join("\n").includes(SECRET) && !out.join("\n").includes("SCRAM-SHA-256"), "neither the password nor the verifier is printed");
  assert.match(out.join("\n"), /member_of=evidence_ingest superuser=false bypassrls=false/);
});

test("review 3: where DDL logging cannot be switched off, the tool stops unless the operator accepts a logged verifier", async () => {
  const hosted = { ...quiet, log_statement: "ddl", pgss_track_utility: "on" };
  assert.deepEqual(statementTextLoggingRisks(quiet), []);
  assert.equal(statementTextLoggingRisks(hosted).length, 2);
  assert.match(statementTextLoggingRisks({ ...quiet, log_min_error_statement: "error" }).join(), /failing role statement/);
  const refused = server(hosted, false);
  await assert.rejects(setIngestLogin(refused.connect, SECRET, { login: "evidence_ingest_login", acceptLoggedVerifier: false }, () => {}), (e: Error) => e instanceof RefusedError && /--accept-logged-verifier/.test(e.message) && !e.message.includes(SECRET));
  assert.ok(!refused.sent.some((s) => /role/.test(s) && /password/.test(s)), "no role statement was sent");
  const accepted = server(hosted, false);
  await assert.rejects(setIngestLogin(accepted.connect, "Short-but-24-chars-long!x", { login: "evidence_ingest_login", acceptLoggedVerifier: true }, () => {}), /at least 32/);
  await setIngestLogin(accepted.connect, SECRET, { login: "evidence_ingest_login", acceptLoggedVerifier: true }, () => {});
  assert.ok(!accepted.sent.join("\n").includes(SECRET));
  await assert.rejects(setIngestLogin(server(quiet, true).connect, SECRET, { login: "postgres", acceptLoggedVerifier: false }, () => {}), /login name/);
});

test("review 4: the Vault secret goes only as a bind parameter, and only once no setting would log parameters", async () => {
  const { connect, sent } = server(quiet, true);
  const out: string[] = [];
  await setCronSecrets(connect, SECRET, "https://abcdefghijklmnopqrst.supabase.co/functions/v1", (l) => out.push(l));
  const carrying = sent.filter((s) => s.includes(SECRET));
  assert.deepEqual(carrying, [SECRET], "the value appears exactly once, as a parameter, never inside statement text");
  assert.ok(sent.includes("select vault.create_secret($1, $2, $3)"));
  assert.ok(!out.join("\n").includes(SECRET));
});

test("review 4: a server that would log bind parameters is REFUSED and the secret is never sent", async () => {
  assert.deepEqual(parameterLoggingRisks(quiet), []);
  for (const settings of [
    { ...quiet, log_statement: "all", log_parameter_max_length: "-1" },
    { ...quiet, log_min_duration_statement: "0", log_parameter_max_length: "-1" },
    { ...quiet, pgaudit_log: "all", pgaudit_log_parameter: "on" },
    // second review: three further ways a bind parameter reaches a log
    { ...quiet, pgaudit_log: "none", pgaudit_role: "auditor", pgaudit_log_parameter: "on" },
    { ...quiet, log_transaction_sample_rate: "0.01", log_parameter_max_length: "-1" },
    { ...quiet, auto_explain_log_min_duration: "0", auto_explain_log_parameter_max_length: "-1" },
  ]) {
    assert.ok(parameterLoggingRisks(settings).length > 0);
    const { connect, sent } = server(settings, false);
    const out: string[] = [];
    await assert.rejects(setCronSecrets(connect, SECRET, "https://abcdefghijklmnopqrst.supabase.co/functions/v1", (l) => out.push(l)),
      (e: Error) => e instanceof RefusedError && /refusing to send the secret/.test(e.message) && !e.message.includes(SECRET));
    assert.ok(!sent.join("\n").includes(SECRET), "nothing carrying the secret reached the server");
    assert.ok(!sent.some((s) => s.includes("vault.create_secret") || s.includes("vault.update_secret")));
  }
  // The same settings are fine when the session is allowed to quieten them for its own transaction.
  const allowed = server({ ...quiet, log_statement: "all", log_parameter_max_length: "-1" }, true);
  await setCronSecrets(allowed.connect, SECRET, "https://abcdefghijklmnopqrst.supabase.co/functions/v1", () => {});
  // on-error parameter logging that cannot be zeroed is a risk too
  assert.ok(parameterLoggingRisks({ ...quiet, log_parameter_max_length_on_error: "-1" }).length > 0);
});

test("review 3/4: weak or awkward secrets are refused without being echoed", () => {
  assert.match(secretShapeProblem("short", 24)!, /at least 24/);
  assert.match(secretShapeProblem("has a space in it and is long enough!!", 24)!, /printable ASCII/);
  assert.match(secretShapeProblem("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 24)!, /variety/);
  assert.match(secretShapeProblem("it's-long-enough-but-has-a-quote-0123", 24)!, /quotes/);
  assert.equal(secretShapeProblem(SECRET, 32), null);
});

test("SCRAM verifier: deterministic for a salt, salted differently each time, and well-formed", () => {
  const salt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
  assert.equal(scramSha256Verifier("pencil", salt), scramSha256Verifier("pencil", salt));
  assert.notEqual(scramSha256Verifier("pencil"), scramSha256Verifier("pencil"));
  assert.match(scramSha256Verifier("pencil", salt), VERIFIER_SHAPE);
  assert.ok(scramSha256Verifier("pencil", salt).startsWith("SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$"));
});

test("review 2: the local bootstrap refuses every remote target", () => {
  assertLocalDockerOnly([], {});
  assertLocalDockerOnly([], { DOCKER_HOST: "unix:///var/run/docker.sock", PGHOST: "127.0.0.1", EVIDENCE_INGEST_DB_URL: "postgresql://evidence_ingest_local:x@127.0.0.1:55322/postgres" });
  for (const [argv, env] of [
    [["--db-url", "postgresql://db.abcdefghijklmnopqrst.supabase.co:5432/postgres"], {}],
    [["--linked"], {}],
    [[], { DOCKER_HOST: "tcp://build-host.example.org:2376" }],
    [[], { DOCKER_HOST: "ssh://operator@remote.example.org" }],
    [[], { DOCKER_CONTEXT: "production" }],
    [[], { SUPABASE_DB_URL: "postgresql://postgres@db.abcdefghijklmnopqrst.supabase.co:5432/postgres" }],
    [[], { PGHOST: "aws-0-ap-southeast-2.pooler.supabase.com" }],
    [[], { DATABASE_URL: "postgres://u@10.1.2.3/postgres" }],
  ] as [string[], { [k: string]: string }][]) {
    assert.throws(() => assertLocalDockerOnly(argv, env), RemoteTargetRefused, JSON.stringify([argv, Object.keys(env)]));
  }
  // second review: hostnames are parsed, never pattern-matched
  for (const remote of ["postgresql://localhost:pw@db.remote.example.co:5432/postgres", "postgres://u:p@remote.example/db?x=@localhost/", "postgres://u@remote.example/127.0.0.1",
    "localhost.attacker.example", "127.0.0.1.nip.io", "remote.example,localhost", "postgresql://db.abcdefghijklmnopqrst.supabase.co/postgres"]) {
    assert.equal(namesLoopbackOnly(remote), false, remote);
    assert.throws(() => assertLocalDockerOnly([], { DATABASE_URL: remote }), RemoteTargetRefused, remote);
  }
  for (const local of ["127.0.0.1", "localhost", "postgresql://u:p@127.0.0.1:55322/postgres", "postgres://u@localhost/db", "postgresql://u@[::1]:5432/db"]) assert.equal(namesLoopbackOnly(local), true, local);

  // second review: a remote context chosen with `docker context use` sets no variable, so the CLI's own answer is checked
  assertLocalDockerEndpoint("unix:///var/run/docker.sock\n");
  for (const endpoint of ["tcp://build-host.example.org:2376", "ssh://operator@remote.example.org", "", "<no value>"]) assert.throws(() => assertLocalDockerEndpoint(endpoint), RemoteTargetRefused, endpoint);

  assert.equal(pickLocalContainer(["supabase_kong_x", "supabase_db_nz-election-evidence-local"], "nz-election-evidence-local"), "supabase_db_nz-election-evidence-local");
  assert.throws(() => pickLocalContainer(["supabase_db_other-project"], "nz-election-evidence-local"), /not this repository's local stack/);
  assert.throws(() => pickLocalContainer([], "nz-election-evidence-local"), /not running/);
});

test("review 2: the bootstrap SQL is ONE block whose first statement is the server-side socket guard; it carries a verifier, never a password", () => {
  const sql = bootstrapSql(scramSha256Verifier(SECRET));
  assert.equal((sql.match(/\bdo \$/g) ?? []).length, 1, "one block: the role statements cannot be reached without passing the guard");
  assert.match(sql, /^do \$bootstrap\$\nbegin\n {2}if inet_server_addr\(\) is not null then\n {4}raise exception/);
  for (const statement of ["alter role", "create role", "valid until"]) assert.ok(sql.indexOf("inet_server_addr() is not null") < sql.indexOf(statement), statement);
  assert.ok(sql.trimEnd().endsWith("$bootstrap$;"), "nothing runs after the guarded block");
  assert.ok(!sql.includes(SECRET));
  assert.throws(() => bootstrapSql("plain-text-password"), /verifier shape/);
});
