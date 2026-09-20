// Read-only access to the upstream evidence warehouse.
//
// The repository never names the warehouse, its host or its login. The operator supplies a command through
// EVIDENCE_WAREHOUSE_QUERY_ARGV (a JSON array): it receives ONE select statement on stdin and writes the
// result as JSON Lines on stdout (choosing that output format is the command's job, not this module's). The operator's command must itself open the warehouse read-only; this
// module adds a second guard by refusing anything that is not a single plain select.

import { spawn } from "node:child_process";

export type QueryRunner = (sql: string) => Promise<{ [column: string]: unknown }[]>;

const WRITE_WORDS = /\b(insert|update|delete|alter|drop|truncate|create|rename|grant|revoke|set|use|into|call|execute)\b/i;

export function assertReadOnlySelect(sql: string): string {
  const statement = sql.trim().replace(/;\s*$/, "");
  if (!/^select\b/i.test(statement)) throw new Error("only a select statement may be sent to the warehouse");
  if (statement.includes(";")) throw new Error("only one statement may be sent to the warehouse");
  // String literals are blanked first so a quoted word cannot trip, or hide from, the check.
  if (WRITE_WORDS.test(statement.replace(/'(?:[^'\\]|\\.)*'/g, "''"))) throw new Error("statement contains a word that is not allowed in a read-only select");
  return statement;
}

export function warehouseArgv(env: { [key: string]: string | undefined }): string[] {
  const raw = env.EVIDENCE_WAREHOUSE_QUERY_ARGV;
  if (!raw) throw new Error("set EVIDENCE_WAREHOUSE_QUERY_ARGV to the JSON argv of a read-only warehouse query command");
  let argv: unknown;
  try {
    argv = JSON.parse(raw);
  } catch {
    throw new Error("EVIDENCE_WAREHOUSE_QUERY_ARGV is not JSON");
  }
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== "string" || !part)) {
    throw new Error("EVIDENCE_WAREHOUSE_QUERY_ARGV must be a non-empty JSON array of strings");
  }
  return argv as string[];
}

/** Runs the operator's command without a shell. Its argv and stderr are never echoed: they may name private hosts. */
export function commandRunner(argv: string[]): QueryRunner {
  return (sql) => new Promise((resolvePromise, reject) => {
    const statement = assertReadOnlySelect(sql) + "\n";
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const chunks: Buffer[] = [];
    let errorBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { errorBytes += chunk.byteLength; });
    child.on("error", () => reject(new Error("warehouse query command could not be started")));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`warehouse query command failed (exit ${code}, ${errorBytes} bytes of diagnostics withheld)`));
      const rows: { [column: string]: unknown }[] = [];
      for (const line of Buffer.concat(chunks).toString("utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          return reject(new Error("warehouse query returned a line that is not JSON"));
        }
      }
      resolvePromise(rows);
    });
    child.stdin.end(statement);
  });
}
