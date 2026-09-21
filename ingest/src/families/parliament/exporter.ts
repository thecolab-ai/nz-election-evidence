#!/usr/bin/env node
// Parliament family exporter: the reproducible recipe that turns the private upstream store into reviewed export files.
//
//   node src/families/parliament/exporter.ts list
//   node src/families/parliament/exporter.ts export <source_id>|all [--write-pins]
//   node src/families/parliament/exporter.ts verify <source_id>|all      re-check existing files against manifest and pin
//
// Environment (values never enter git and are never printed):
//   EVIDENCE_UPSTREAM_QUERY_COMMAND   a command that reads ONE query on stdin and writes the result to stdout, through a
//                                     session the upstream store itself holds read-only. The exporter checks that setting
//                                     before it runs any recipe and stops if the session could write.
//   EVIDENCE_EXPORT_DIR               a directory OUTSIDE this repository. Created 0700; every file is written 0600.
//
// The recipes are the SELECT statements in contracts.ts and nothing else: allowlisted expressions only. Text the project
// does not keep is reduced to a digest and a length inside the upstream store, so it never reaches this machine.
// Nothing here writes upstream: no INSERT, no DDL, no temporary table.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { type ExportPin, type ExportRow, type FamilyExportContract, PARLIAMENT_EXPORT_CONTRACTS, contractFor } from "./contracts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");

export interface ExportManifest {
  manifest_version: 1;
  source_id: string;
  product_ids: string[];
  record_kinds: string[];
  /** Digest of the exact SELECT that produced the file: the recipe is committed, so the export can be re-made and compared. */
  recipe_sha256: string;
  export: ExportPin;
  observed_min: string | null;
  observed_max: string | null;
  /** What the upstream store reported for the product, counted by a separate query. */
  upstream: { rows: number; distinct_records: number; distinct_upstream_records: number; observed_min: string | null; observed_max: string | null };
  /** Rows the payload builders could not use (no publisher id or link). They stay in the file and are reported, never dropped silently. */
  unusable_rows: number;
  agreement: { rows: boolean; distinct_records: boolean };
  exported_at: string;
}

export interface FileFacts {
  pin: ExportPin;
  observed_min: string | null;
  observed_max: string | null;
  unusable_rows: number;
}

/** Reads an export file once: checksum, row count, column allowlist, distinct publisher records. Refuses an unknown column. */
export async function inspectExportFile(contract: FamilyExportContract, location: string): Promise<FileFacts> {
  const allowed = new Set(contract.columns.map((c) => c.name));
  const hash = createHash("sha256");
  const ids = new Set<string>();
  let bytes = 0;
  let rows = 0;
  let unusable = 0;
  let min: string | null = null;
  let max: string | null = null;
  const input = createReadStream(location);
  input.on("data", (chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  let lineNumber = 0;
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    lineNumber++;
    if (!line.trim()) continue;
    let row: ExportRow;
    try {
      row = JSON.parse(line) as ExportRow;
    } catch {
      throw new Error(`export line ${lineNumber} is not JSON`);
    }
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error(`export line ${lineNumber} is not an object`);
    for (const key of Object.keys(row)) {
      // The column name is not echoed: it is untrusted, and an unexpected column may itself be the leak.
      if (!allowed.has(key)) throw new Error(`export line ${lineNumber} carries a column outside this contract's allowlist; the file is refused whole`);
    }
    rows++;
    const observed = row.observed_at;
    if (typeof observed === "string" && !Number.isNaN(Date.parse(observed))) {
      if (min === null || observed < min) min = observed;
      if (max === null || observed > max) max = observed;
    }
    try {
      ids.add(contract.toRecord(row).external_record_id);
    } catch {
      unusable++;
    }
  }
  return { pin: { sha256: "sha256:" + hash.digest("hex"), bytes, rows, distinct_records: ids.size }, observed_min: min, observed_max: max, unusable_rows: unusable };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see ingest/src/families/parliament/INTEGRATION.md)`);
  return value;
}

export function exportDirectory(): string {
  const dir = resolve(requireEnv("EVIDENCE_EXPORT_DIR"));
  const rel = relative(REPO_ROOT, dir);
  if (!rel.startsWith("..")) throw new Error("EVIDENCE_EXPORT_DIR must be outside the repository: export files are private");
  return dir;
}

export function exportLocations(contract: FamilyExportContract, dir: string): { file: string; manifest: string } {
  return { file: resolve(dir, contract.source_id + ".jsonl"), manifest: resolve(dir, contract.source_id + ".manifest.json") };
}

/** Only this exporter's own recipes are ever sent: one statement, a SELECT, nothing that could change the upstream store. */
export function assertReadOnlyStatement(sql: string): void {
  const flat = sql.trim();
  if (!/^SELECT\s/i.test(flat) || flat.includes(";")) throw new Error("only a single SELECT statement is ever sent upstream");
  if (/\b(INSERT|ALTER|DROP|TRUNCATE|CREATE|ATTACH|DETACH|OPTIMIZE|RENAME|GRANT|REVOKE|KILL|SYSTEM|DELETE|UPDATE|EXCHANGE|INTO\s+OUTFILE)\b/i.test(flat.replace(/'(?:[^'\\]|\\.)*'/g, "''"))) {
    throw new Error("statement contains a keyword that could change the upstream store; refused");
  }
}

function runQuery(sql: string, sink: Writable | ((chunk: Buffer) => void)): Promise<void> {
  assertReadOnlyStatement(sql);
  const command = requireEnv("EVIDENCE_UPSTREAM_QUERY_COMMAND");
  return new Promise((resolvePromise, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let stderrBytes = 0;
    // A file sink is piped, so a large product is never held in memory.
    if (typeof sink === "function") child.stdout.on("data", sink);
    else child.stdout.pipe(sink, { end: false });
    // Upstream error text can carry row content or host names: only its size is reported.
    child.stderr.on("data", (chunk: Buffer) => (stderrBytes += chunk.length));
    child.on("error", () => reject(new Error("the upstream query command could not be started")));
    child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`the upstream query command failed (exit ${code}, ${stderrBytes} bytes of error output withheld)`))));
    child.stdin.end(sql + "\n");
  });
}

async function queryText(sql: string): Promise<string> {
  const chunks: Buffer[] = [];
  await runQuery(sql, (chunk) => chunks.push(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

async function assertReadOnlySession(): Promise<void> {
  const out = (await queryText("SELECT toString(getSetting('readonly')) AS readonly FORMAT JSONEachRow")).trim();
  const value = Number((JSON.parse(out) as { readonly: string }).readonly);
  if (!(value >= 1)) throw new Error("the upstream session is not read-only; nothing was exported. Open the session with the store's read-only setting");
}

export async function exportOne(contract: FamilyExportContract, dir: string, now: () => Date = () => new Date()): Promise<ExportManifest> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const { file, manifest: manifestFile } = exportLocations(contract, dir);
  const partial = file + ".partial";
  const out = createWriteStream(partial, { mode: 0o600 });
  await runQuery(contract.recipe.exportSql, out);
  await new Promise<void>((done, fail) => out.end((error?: Error | null) => (error ? fail(error) : done())));
  await chmod(partial, 0o600);

  const facts = await inspectExportFile(contract, partial);
  const upstreamRow = JSON.parse((await queryText(contract.recipe.reconcileSql)).trim()) as { [key: string]: unknown };
  const upstream = {
    rows: Number(upstreamRow.rows), distinct_records: Number(upstreamRow.distinct_records), distinct_upstream_records: Number(upstreamRow.distinct_upstream_records),
    observed_min: typeof upstreamRow.observed_min === "string" ? upstreamRow.observed_min : null,
    observed_max: typeof upstreamRow.observed_max === "string" ? upstreamRow.observed_max : null,
  };
  const manifest: ExportManifest = {
    manifest_version: 1, source_id: contract.source_id, product_ids: contract.product_ids, record_kinds: contract.record_kinds,
    recipe_sha256: "sha256:" + createHash("sha256").update(contract.recipe.exportSql).digest("hex"),
    export: facts.pin, observed_min: facts.observed_min, observed_max: facts.observed_max, upstream, unusable_rows: facts.unusable_rows,
    agreement: { rows: facts.pin.rows === upstream.rows, distinct_records: facts.pin.distinct_records === upstream.distinct_records },
    exported_at: now().toISOString(),
  };
  if (!manifest.agreement.rows) throw new Error(`${contract.source_id}: exported ${facts.pin.rows} rows but the upstream store counts ${upstream.rows}; the partial file was kept for inspection, nothing was pinned`);
  await rename(partial, file);
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  await chmod(manifestFile, 0o600);
  return manifest;
}

export async function verifyOne(contract: FamilyExportContract, dir: string): Promise<{ source_id: string; ok: boolean; problems: string[]; pin: ExportPin }> {
  const { file, manifest: manifestFile } = exportLocations(contract, dir);
  const problems: string[] = [];
  const mode = (await stat(file)).mode & 0o777;
  if (mode & 0o077) problems.push("export file is readable by other accounts; expected 0600");
  const facts = await inspectExportFile(contract, file);
  const manifest = JSON.parse(await readFile(manifestFile, "utf-8")) as ExportManifest;
  for (const key of ["sha256", "bytes", "rows", "distinct_records"] as const) {
    if (manifest.export[key] !== facts.pin[key]) problems.push(`manifest ${key} does not match the file`);
    if (!contract.pin) problems.push("contract is not pinned");
    else if (contract.pin[key] !== facts.pin[key]) problems.push(`pinned ${key} does not match the file`);
  }
  return { source_id: contract.source_id, ok: problems.length === 0, problems: [...new Set(problems)], pin: facts.pin };
}

async function main(argv: string[]): Promise<number> {
  const [command, target] = argv;
  if (command === "list") {
    for (const c of PARLIAMENT_EXPORT_CONTRACTS) console.log(`${c.source_id}\t${c.product_ids.join(",")}\t${c.pin ? c.pin.rows + " rows pinned" : "not pinned"}\t${c.fileEnv}`);
    return 0;
  }
  if ((command !== "export" && command !== "verify") || !target) throw new Error("commands: list | export <source_id>|all [--write-pins] | verify <source_id>|all");
  const contracts = target === "all" ? PARLIAMENT_EXPORT_CONTRACTS : [contractFor(target)];
  const dir = exportDirectory();
  if (command === "verify") {
    let bad = 0;
    for (const contract of contracts) {
      const result = await verifyOne(contract, dir);
      if (!result.ok) bad++;
      console.log(JSON.stringify(result));
    }
    return bad ? 2 : 0;
  }
  await assertReadOnlySession();
  const pinsFile = resolve(HERE, "pins.json");
  const pins = JSON.parse(await readFile(pinsFile, "utf-8")) as { [sourceId: string]: ExportPin };
  for (const contract of contracts) {
    const manifest = await exportOne(contract, dir);
    pins[contract.source_id] = manifest.export;
    // Counts, digests and times only: never a location, a row or a host.
    console.log(JSON.stringify({
      source_id: manifest.source_id, export: manifest.export, upstream: manifest.upstream, unusable_rows: manifest.unusable_rows,
      agreement: manifest.agreement, recipe_sha256: manifest.recipe_sha256,
    }));
  }
  if (argv.includes("--write-pins")) {
    const ordered = Object.fromEntries(Object.keys(pins).sort().map((key) => [key, pins[key]]));
    await writeFile(pinsFile, JSON.stringify(ordered, null, 2) + "\n");
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error("error: " + String(error instanceof Error ? error.message : error));
    process.exit(1);
  });
}
