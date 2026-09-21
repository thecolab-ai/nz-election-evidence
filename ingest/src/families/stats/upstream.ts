// Statistics family: the read-only export recipe.
//
// The upstream collection is private. Nothing about where it runs enters this repository: the operator names a
// read-only query command in EVIDENCE_WAREHOUSE_QUERY_ARGV (a JSON array of program and arguments). The command
// receives ONE statement on standard input and must answer with one JSON object per line. Every statement below
// is a plain SELECT over named columns; the recipe never reads a captured body, a stored original record or a
// contact field, and it never writes. `assertReadOnly` refuses anything else before a process is started.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ContractError } from "./contract.ts";

export const QUERY_ARGV_ENV = "EVIDENCE_WAREHOUSE_QUERY_ARGV";

const FORBIDDEN = /\b(insert|update|delete|alter|drop|truncate|create|attach|detach|optimize|rename|grant|revoke|system|kill|set|into\s+outfile|exchange|backup|restore)\b/i;
/** Columns of the upstream tables that are never read: captured bodies, stored originals, locations on a disk. */
const NEVER_READ = /\b(raw_record_json|archive_path|archive_relpath|source_metadata_json|body|html)\b/i;

export function assertReadOnly(sql: string): void {
  const statement = sql.trim().replace(/;+\s*$/, "");
  if (statement.includes(";")) throw new ContractError("recipe must be a single statement");
  if (!/^select\b/i.test(statement)) throw new ContractError("recipe statements are SELECT only");
  if (FORBIDDEN.test(statement.replace(/'[^']*'/g, "''"))) throw new ContractError("recipe statement contains a keyword that is not read-only");
  if (NEVER_READ.test(statement.replace(/'[^']*'/g, "''"))) throw new ContractError("recipe statement names a column that is never read");
  if (!/\bformat\s+jsoneachrow$/i.test(statement)) throw new ContractError("recipe statements answer with one JSON object per line");
}

function literal(text: string): string {
  if (!/^[A-Za-z0-9_.:\- ]{1,200}$/.test(text)) throw new ContractError("recipe parameter is not a plain identifier");
  return `'${text}'`;
}

// Recipes ---------------------------------------------------------------------------------------------------

export const RECIPES = {
  operationalFacts: (upstreamSource: string) => `
    SELECT record_id, source_url, toString(observed_at) AS observed_at, payload_json
    FROM operational_source_records_current
    WHERE source_id = ${literal(upstreamSource)} AND record_kind = 'fact'
    ORDER BY record_id
    FORMAT JSONEachRow`,
  /** Every stored version of the catalogue rows, oldest first, so collection history is kept. */
  operationalCatalogue: (upstreamSource: string) => `
    SELECT record_id, record_kind, source_url, toString(observed_at) AS observed_at, payload_json
    FROM operational_source_records_dedup
    WHERE source_id = ${literal(upstreamSource)} AND record_kind IN ('catalogue', 'catalogue_metadata')
    ORDER BY record_id, observed_at, content_hash
    FORMAT JSONEachRow`,
  operationalCounts: (upstreamSource: string) => `
    SELECT record_kind, count() AS stored_rows, uniqExact(record_id) AS record_ids, uniqExact(run_id) AS runs,
           toString(min(observed_at)) AS observed_from, toString(max(observed_at)) AS observed_to
    FROM operational_source_records_dedup
    WHERE source_id = ${literal(upstreamSource)}
    GROUP BY record_kind ORDER BY record_kind
    FORMAT JSONEachRow`,
  censusSources: () => `
    SELECT dataset_id, title, source_url, toString(retrieved_at) AS retrieved_at, sha256, bytes, release_vintage,
           boundary_edition, coverage, licence
    FROM stats_census_sources ORDER BY dataset_id, retrieved_at
    FORMAT JSONEachRow`,
  censusObservations: (datasetId: string) => `
    SELECT dataset_id, census_year, geography_level, geography_code, geography_name, subject, measure, category_code,
           category_label, category_dimension, value, value_status, source_symbol, unit, release_vintage,
           boundary_edition, source_url, source_sha256, source_file, source_row, toString(captured_at) AS captured_at
    FROM stats_census_observations
    WHERE dataset_id = ${literal(datasetId)}
    ORDER BY source_file, source_row, measure, category_code, census_year, geography_level, geography_code
    FORMAT JSONEachRow`,
  censusCounts: () => `
    SELECT dataset_id, count() AS stored_rows, uniqExact(snapshot_id) AS snapshots
    FROM stats_census_observations GROUP BY dataset_id ORDER BY dataset_id
    FORMAT JSONEachRow`,
  censusProducts: () => `
    SELECT dataset_id, product_id, title, product_url, platform, release_date, themes, subjects, variables,
           geographic_levels, statistical_unit, source_url, toString(captured_at) AS captured_at
    FROM stats_census_products ORDER BY product_id, captured_at
    FORMAT JSONEachRow`,
  seriesSources: () => `
    SELECT toString(snapshot_id) AS snapshot_id, dataset_id, family_id, title, source_url, catalogue_url, release_vintage,
           toString(retrieved_at) AS retrieved_at, http_status, source_bytes, source_sha256, source_format, member_count,
           observation_count, collection_status
    FROM stats_series_sources_final ORDER BY dataset_id, retrieved_at
    FORMAT JSONEachRow`,
  /** One capture per dataset: the latest. Earlier captures of the identical file are counted, not re-imported. */
  seriesObservations: (datasetId: string, snapshotId: string) => `
    SELECT dataset_id, family_id, source_sha256, source_file, source_row_number, observation_key, observation_kind,
           value_parse_status, suppression_flag, seasonal_adjustment, row_json
    FROM stats_series_observations_final
    WHERE dataset_id = ${literal(datasetId)} AND toString(snapshot_id) = ${literal(snapshotId)}
    ORDER BY source_file, source_row_number, observation_key
    FORMAT JSONEachRow`,
  seriesCounts: () => `
    SELECT dataset_id, toString(snapshot_id) AS snapshot_id, count() AS stored_rows,
           uniqExact(observation_key) AS observation_keys
    FROM stats_series_observations_final GROUP BY dataset_id, snapshot_id ORDER BY dataset_id, snapshot_id
    FORMAT JSONEachRow`,
} as const;

// Runner ----------------------------------------------------------------------------------------------------

export type QueryRunner = (sql: string) => AsyncIterable<{ [key: string]: unknown }>;

export function queryArgv(env: { [key: string]: string | undefined }): string[] {
  const raw = env[QUERY_ARGV_ENV];
  if (!raw) throw new ContractError(`set ${QUERY_ARGV_ENV} to the read-only query command (a JSON array; see the family README)`);
  let argv: unknown;
  try {
    argv = JSON.parse(raw);
  } catch {
    throw new ContractError(`${QUERY_ARGV_ENV} is not a JSON array`);
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string" && part.length > 0)) {
    throw new ContractError(`${QUERY_ARGV_ENV} must be a non-empty JSON array of strings`);
  }
  return argv as string[];
}

/** Streams the answer line by line, so an export of several hundred thousand rows never sits in memory as text. */
export function commandRunner(argv: string[]): QueryRunner {
  return async function* run(sql: string) {
    assertReadOnly(sql);
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 2000) stderr += chunk.toString("utf-8"); });
    const exited = new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
    child.stdin.end(sql.trim().replace(/;+\s*$/, "") + "\n");
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber++;
      if (!line) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        child.kill();
        throw new ContractError(`query answer line ${lineNumber} is not JSON`);
      }
      yield row as { [key: string]: unknown };
    }
    const code = await exited;
    // The command's own error text may name private hosts: only its length and exit code are reported.
    if (code !== 0) throw new ContractError(`read-only query command exited with code ${code} (${stderr.length} bytes of error text withheld)`);
  };
}
