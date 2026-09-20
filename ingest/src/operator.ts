#!/usr/bin/env node
// Operator tool for the two steps that handle a secret. Replaces passing secrets to psql with -v.
//
//   node src/operator.ts set-ingest-login [--login evidence_ingest_login] [--accept-logged-verifier]
//   node src/operator.ts set-cron-secrets --functions-base-url https://<project-ref>.supabase.co/functions/v1
//
// How a secret gets in: a hidden terminal prompt, or the first line of piped standard input. Never an argument.
// How the administrator connects: the standard PGHOST / PGPORT / PGDATABASE / PGUSER variables; the administrator
// password comes from PGPASSWORD or, on a terminal, a hidden prompt. TLS is required for any non-loopback host.
//
// What reaches the server, and what a log could capture:
//   set-ingest-login   only a SCRAM-SHA-256 verifier computed here (src/scram.ts). The password itself is never sent.
//                      If statement or audit logging would record the ALTER ROLE text and cannot be switched off for
//                      the transaction, the tool stops unless --accept-logged-verifier is given, and then insists on
//                      a 32+ character secret so that the logged hash is of no practical use.
//   set-cron-secrets   Vault encrypts server-side, so the value must be sent. It goes ONLY as a bind parameter of a
//                      fixed statement, never in statement text, and only after the tool has confirmed that no
//                      setting in force would log bind parameters. If one would, the tool REFUSES and sends nothing.
// Output is role names, secret names and timestamps. No value is ever printed.
import postgres from "postgres";
import { scramSha256Verifier, secretShapeProblem, VERIFIER_SHAPE } from "./scram.ts";
import { processIo, readSecret, RefusedError, refuseSecretArguments, type SecretIo } from "./secret_input.ts";

export { RefusedError };

/** One administrator transaction. */
export interface AdminTx {
  query(text: string, params?: (string | number | null)[]): Promise<{ [key: string]: unknown }[]>;
  /** SET LOCAL inside a savepoint; false when the server refuses (not permitted, or unknown parameter). */
  trySetLocal(name: string, value: string): Promise<boolean>;
}
export type AdminConnection = <T>(work: (tx: AdminTx) => Promise<T>) => Promise<T>;

export interface LoggingSettings {
  log_statement: string | null;
  log_min_duration_statement: string | null;
  log_min_duration_sample: string | null;
  log_parameter_max_length: string | null;
  log_parameter_max_length_on_error: string | null;
  pgaudit_log: string | null;
  pgaudit_log_parameter: string | null;
  /** Object auditing: with a role set here pgaudit logs statements touching that role's grants even when pgaudit.log is none. */
  pgaudit_role: string | null;
  pgss_track_utility: string | null;
  /** Decided at BEGIN, before any SET LOCAL can run: a sampled transaction logs every statement with its parameters. */
  log_transaction_sample_rate: string | null;
  auto_explain_log_min_duration: string | null;
  auto_explain_log_parameter_max_length: string | null;
  log_min_error_statement: string | null;
}

const SETTING_NAMES: { [K in keyof LoggingSettings]: string } = {
  log_statement: "log_statement", log_min_duration_statement: "log_min_duration_statement",
  log_min_duration_sample: "log_min_duration_sample", log_parameter_max_length: "log_parameter_max_length",
  log_parameter_max_length_on_error: "log_parameter_max_length_on_error", pgaudit_log: "pgaudit.log",
  pgaudit_log_parameter: "pgaudit.log_parameter", pgaudit_role: "pgaudit.role", pgss_track_utility: "pg_stat_statements.track_utility",
  log_transaction_sample_rate: "log_transaction_sample_rate", auto_explain_log_min_duration: "auto_explain.log_min_duration",
  auto_explain_log_parameter_max_length: "auto_explain.log_parameter_max_length", log_min_error_statement: "log_min_error_statement",
};

const durationOn = (value: string | null) => value !== null && value !== "-1";
const auditOn = (value: string | null) => value !== null && value.trim() !== "" && value.trim().toLowerCase() !== "none";

/** Settings under which a BIND PARAMETER would be written to a server log. Empty means none would. */
export function parameterLoggingRisks(s: LoggingSettings): string[] {
  const risks: string[] = [];
  const parametersLogged = s.log_parameter_max_length !== "0";
  if (parametersLogged && s.log_statement === "all") risks.push("log_statement = all records bind parameters");
  if (parametersLogged && (durationOn(s.log_min_duration_statement) || durationOn(s.log_min_duration_sample))) {
    risks.push("duration logging records bind parameters of slow statements");
  }
  if (s.log_parameter_max_length_on_error !== "0") risks.push("log_parameter_max_length_on_error records bind parameters when a statement fails");
  const auditing = auditOn(s.pgaudit_log) || (s.pgaudit_role !== null && s.pgaudit_role.trim() !== "");
  if (auditing && s.pgaudit_log_parameter === "on") risks.push("pgaudit.log_parameter = on records bind parameters");
  if (parametersLogged && s.log_transaction_sample_rate !== null && Number(s.log_transaction_sample_rate) > 0) {
    risks.push("log_transaction_sample_rate samples whole transactions, parameters included, and was decided before this session could change it");
  }
  if (durationOn(s.auto_explain_log_min_duration) && s.auto_explain_log_parameter_max_length !== "0") {
    risks.push("auto_explain records bind parameters of the statements it logs");
  }
  return risks;
}

/** Settings under which the TEXT of an ALTER ROLE statement (carrying a verifier, never a password) would be recorded. */
export function statementTextLoggingRisks(s: LoggingSettings): string[] {
  const risks: string[] = [];
  if (s.log_statement !== null && s.log_statement !== "none") risks.push(`log_statement = ${s.log_statement} records role DDL`);
  if (durationOn(s.log_min_duration_statement) || durationOn(s.log_min_duration_sample)) risks.push("duration logging may record the statement");
  if (auditOn(s.pgaudit_log)) risks.push("pgaudit records role statements");
  if (s.log_transaction_sample_rate !== null && Number(s.log_transaction_sample_rate) > 0) risks.push("log_transaction_sample_rate may record the statement");
  if (durationOn(s.auto_explain_log_min_duration)) risks.push("auto_explain may record the statement");
  // A statement that FAILS is logged with its text at the default log_min_error_statement = error.
  if (s.log_min_error_statement !== null && !["panic", "fatal", "log"].includes(s.log_min_error_statement)) risks.push("a failing role statement would be recorded with its text (log_min_error_statement)");
  if (s.pgss_track_utility === "on") risks.push("pg_stat_statements.track_utility keeps utility statement text");
  return risks;
}

/** Quietens what the session is allowed to quieten, then reports what is actually in force. */
export async function quietLogging(tx: AdminTx): Promise<LoggingSettings> {
  await tx.trySetLocal("log_parameter_max_length_on_error", "0");
  await tx.trySetLocal("log_statement", "none");
  await tx.trySetLocal("log_min_duration_statement", "-1");
  await tx.trySetLocal("log_min_duration_sample", "-1");
  await tx.trySetLocal("log_parameter_max_length", "0");
  await tx.trySetLocal("pgaudit.log", "none");
  await tx.trySetLocal("pg_stat_statements.track_utility", "off");
  await tx.trySetLocal("auto_explain.log_min_duration", "-1");
  await tx.trySetLocal("log_min_error_statement", "panic");
  const out = {} as LoggingSettings;
  for (const [key, name] of Object.entries(SETTING_NAMES) as [keyof LoggingSettings, string][]) {
    const [row] = await tx.query("select current_setting($1, true) as v", [name]);
    out[key] = (row?.v as string | null) ?? null;
  }
  return out;
}

export interface IngestLoginOptions { login: string; acceptLoggedVerifier: boolean; }

export async function setIngestLogin(connect: AdminConnection, password: string, options: IngestLoginOptions, say: (line: string) => void): Promise<void> {
  if (!/^evidence_ingest_[a-z0-9_]{2,40}$/.test(options.login)) throw new RefusedError("the login name must look like evidence_ingest_<suffix>");
  const weak = secretShapeProblem(password, 24);
  if (weak) throw new RefusedError("the password " + weak);
  await connect(async (tx) => {
    const settings = await quietLogging(tx);
    const risks = statementTextLoggingRisks(settings);
    if (risks.length > 0) {
      if (!options.acceptLoggedVerifier) {
        throw new RefusedError("this server would record the ALTER ROLE statement (" + risks.join("; ") + "). It carries a salted SCRAM verifier, never the password. Re-run with --accept-logged-verifier to proceed; nothing was changed.");
      }
      const stronger = secretShapeProblem(password, 32);
      if (stronger) throw new RefusedError("with a logged verifier the password " + stronger);
      say("note: the server will record the statement text; it contains a SCRAM verifier only (" + risks.length + " logging setting(s) in force)");
    }
    const verifier = scramSha256Verifier(password);
    if (!VERIFIER_SHAPE.test(verifier)) throw new Error("internal: verifier shape");
    const [existing] = await tx.query("select 1 as present from pg_roles where rolname = $1", [options.login]);
    // Role DDL cannot take bind parameters. The login is pattern-checked above and the verifier is base64 plus
    // "$:" only (VERIFIER_SHAPE), so neither can break out of its quoting.
    if (existing) await tx.query(`alter role "${options.login}" with login password '${verifier}'`);
    else await tx.query(`create role "${options.login}" with login password '${verifier}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 6 in role evidence_ingest`);
    await tx.query(`grant evidence_ingest to "${options.login}"`);
    await tx.query(`alter role "${options.login}" set statement_timeout = '150s'`);
    await tx.query(`alter role "${options.login}" set idle_in_transaction_session_timeout = '60s'`);
    const [row] = await tx.query(
      `select r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolconnlimit,
              (select string_agg(g.rolname, ',' order by g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid) as member_of
       from pg_roles r where r.rolname = $1`, [options.login]);
    if (!row || row.rolsuper || row.rolbypassrls || row.rolcreaterole || row.member_of !== "evidence_ingest") {
      throw new Error("readback: the login is not scoped to evidence_ingest alone; transaction rolled back");
    }
    say(`${existing ? "rotated" : "created"} login ${row.rolname}: member_of=${row.member_of} superuser=${row.rolsuper} bypassrls=${row.rolbypassrls} createrole=${row.rolcreaterole}`);
  });
}

export async function setCronSecrets(connect: AdminConnection, cronSecret: string, functionsBaseUrl: string, say: (line: string) => void): Promise<void> {
  const weak = secretShapeProblem(cronSecret, 32);
  if (weak) throw new RefusedError("the cron secret " + weak);
  await connect(async (tx) => {
    const [ok] = await tx.query("select evidence_private.functions_base_url_ok($1) as ok", [functionsBaseUrl]);
    if (!ok?.ok) throw new RefusedError("the functions base URL is not an allowed functions endpoint");
    // Decide BEFORE the value goes anywhere. A refusal here means the secret never left this process.
    const risks = parameterLoggingRisks(await quietLogging(tx));
    if (risks.length > 0) {
      throw new RefusedError("refusing to send the secret: this server would write it to a log (" + risks.join("; ") + "). Nothing was sent or changed. Set the two Vault entries in the Supabase dashboard (Vault) instead, or have logging of parameters switched off for this role.");
    }
    for (const [name, value, description] of [
      ["evidence_functions_base_url", functionsBaseUrl, "Edge Functions base URL for the ingest dispatcher"],
      ["evidence_cron_secret", cronSecret, "Shared secret between pg_cron dispatcher and the ingest-run function"],
    ] as const) {
      const [found] = await tx.query("select id::text as id from vault.secrets where name = $1", [name]);
      if (found) await tx.query("select vault.update_secret($1::uuid, $2)", [found.id as string, value]);
      else await tx.query("select vault.create_secret($1, $2, $3)", [value, name, description]);
    }
    const rows = await tx.query("select name, updated_at::text as updated_at from vault.secrets where name like 'evidence\\_%' order by name");
    for (const row of rows) say(`vault entry ${row.name} updated_at=${row.updated_at}`);
  });
}

/** Administrator connection from PG* variables. Non-loopback hosts must use verified TLS. */
export function adminConnectionFromEnv(env: NodeJS.ProcessEnv, password: string | undefined): { connect: AdminConnection; end: () => Promise<void> } {
  const host = env.PGHOST ?? "";
  if (!host || !env.PGUSER) throw new RefusedError("set PGHOST, PGUSER (and PGPORT, PGDATABASE) for the administrator connection");
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const sql = postgres({
    host, port: Number(env.PGPORT ?? 5432), database: env.PGDATABASE ?? "postgres", username: env.PGUSER, password,
    ssl: loopback ? false : "verify-full", max: 1, prepare: false, onnotice: () => undefined,
    connection: { application_name: "evidence-operator" },
  });
  const connect: AdminConnection = (work) => sql.begin(async (tx) => work({
    query: async (text, params = []) => [...(await tx.unsafe(text, params as never[]))] as { [key: string]: unknown }[],
    trySetLocal: async (name, value) => {
      if (!/^[a-z_.]+$/.test(name) || !/^[a-z0-9-]+$/.test(value)) throw new Error("internal: setting shape");
      try { await tx.savepoint((sp) => sp.unsafe(`set local ${name} = '${value}'`)); return true; } catch { return false; }
    },
  })) as Promise<never>;
  return { connect, end: () => sql.end({ timeout: 5 }) };
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: SecretIo = processIo, say: (line: string) => void = console.log): Promise<number> {
  refuseSecretArguments(argv);
  const [command, ...args] = argv;
  if (command !== "set-ingest-login" && command !== "set-cron-secrets") {
    say("usage: operator.ts set-ingest-login [--login NAME] [--accept-logged-verifier] | set-cron-secrets --functions-base-url URL");
    return 2;
  }
  let adminPassword = env.PGPASSWORD;
  if (!adminPassword && io.isTTY) adminPassword = await io.readHidden("administrator database password (input hidden): ");
  const admin = adminConnectionFromEnv(env, adminPassword);
  try {
    if (command === "set-ingest-login") {
      const password = await readSecret("new password for the ingest login", io);
      await setIngestLogin(admin.connect, password, { login: flagValue(args, "--login") ?? "evidence_ingest_login", acceptLoggedVerifier: args.includes("--accept-logged-verifier") }, say);
    } else {
      const url = flagValue(args, "--functions-base-url");
      if (!url) throw new RefusedError("--functions-base-url is required (it is not a secret)");
      await setCronSecrets(admin.connect, await readSecret("cron secret", io), url, say);
    }
    return 0;
  } finally {
    await admin.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: Error) => {
    // The message of our own errors never contains a value; anything else is reduced to its class name.
    console.error(error instanceof RefusedError ? "refused: " + error.message : "failed: " + (error.name || "error") + (("code" in error) ? " " + String(error.code) : ""));
    process.exit(1);
  });
}
