#!/usr/bin/env node
// What a store HOLDS, as something two stores can be compared by: per table of evidence_private, its row count and a
// digest of the content of every row. Two loads of the same inputs (another family order, a replay, a hosted project
// against a local one) hold the same data exactly when these digests are equal. Row counts alone cannot show that.
//
//   EVIDENCE_DIGEST_DB_URL=... node src/loaders/content_digest.ts --out <table-content.json>
//
// Reads only (one repeatable-read transaction; it writes nothing but its own temporary tables). The login must read every table of
// evidence_private: an administrator or the inspector reader, never the ingestion worker. The connection value is read
// from the environment and never printed. The output holds table and column names, counts and digests: no row content.
//
// Normalisation, stated in the output as well, because two honest loads differ in exactly these ways and no others:
//   1. a surrogate key (a uuid or identity primary key) is random or sequential: it is left out, and a foreign key to
//      such a row is compared by the CONTENT of the row it points to (its digest), recursively;
//   2. a column the database clock fills (a default of now()) records WHEN a load ran, not what was loaded: left out;
//   3. a foreign key to the run ledger names a run, and how many runs there were depends on how the load was driven
//      (retries, resumes, order): left out. The run-ledger tables themselves are counted, never compared;
//   4. anything else that had to be left out is listed per table under columns_not_compared with its reason: by name in
//      ALSO_NOT_COMPARED below (each with the reason it cannot be equal), or because a foreign key is part of a cycle.
// Nothing is left out silently: a column is either inside the digest or named in the output.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { sanitize } from "./access.ts";
import { RUN_LEDGER } from "./manifest_build.ts";

const SCHEMA = "evidence_private";

/** Columns that cannot be equal between two honest loads for a reason the three general rules do not see. */
export const ALSO_NOT_COMPARED: { [table: string]: { [column: string]: string } } = {};

interface Column { table: string; column: string; type: string; default: string | null; identity: boolean }
interface ForeignKey { table: string; column: string; references: string }

export interface TableDigest {
  rows: number; content_digest: string; columns_not_compared: { [column: string]: string }; foreign_keys_compared_by_content: { [column: string]: string };
  /** Per compared column, an order-independent checksum of its values: when two stores differ, this names the column. Diagnostic only. */
  column_checksums: { [column: string]: string };
}

const ident = (name: string) => '"' + name.replaceAll('"', '""') + '"';

export async function digestStore(url: string, log: (message: string) => void = () => undefined): Promise<{ [key: string]: unknown }> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined, connection: { application_name: "evidence-content-digest" } });
  try {
    return await sql.begin(async (tx) => {
      // One consistent snapshot of the whole store. The transaction cannot be declared READ ONLY because this tool
      // materialises its per-row digests in TEMPORARY tables and Postgres counts creating one as a write; every
      // statement it issues is a SELECT or a CREATE TEMP TABLE, and it sends no DML to any evidence table (the
      // integration test asserts that a digest run leaves the store exactly as it found it).
      await tx`set transaction isolation level repeatable read`;
      const columns = await tx<Column[]>`
        select c.relname as table, a.attname as column, format_type(a.atttypid, a.atttypmod) as type, pg_get_expr(d.adbin, d.adrelid) as default, a.attidentity <> '' as identity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
        where n.nspname = ${SCHEMA} and c.relkind = 'r' order by c.relname, a.attnum`;
      const keys = await tx<{ table: string; columns: string[] }[]>`
        select c.relname as table, array_agg(a.attname::text order by k.ord) as columns
        from pg_constraint p join pg_class c on c.oid = p.conrelid join pg_namespace n on n.oid = c.relnamespace
        cross join lateral unnest(p.conkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
        where n.nspname = ${SCHEMA} and p.contype = 'p' group by c.relname`;
      const foreign = await tx<ForeignKey[]>`
        select c.relname as table, a.attname as column, r.relname as references
        from pg_constraint p join pg_class c on c.oid = p.conrelid join pg_namespace n on n.oid = c.relnamespace
        join pg_class r on r.oid = p.confrelid join pg_namespace rn on rn.oid = r.relnamespace and rn.nspname = ${SCHEMA}
        join pg_attribute a on a.attrelid = c.oid and a.attnum = p.conkey[1]
        where n.nspname = ${SCHEMA} and p.contype = 'f' and cardinality(p.conkey) = 1`;

      // A digest is only evidence if the login saw EVERY row. Row-level security hides rows without an error, so a login
      // that does not bypass it, or that may not read a table at all, produces an INCOMPLETE digest, and says so.
      const [{ bypasses }] = await tx<{ bypasses: boolean }[]>`select rolsuper or rolbypassrls as bypasses from pg_roles where rolname = current_user`;
      const readable = await tx<{ table: string; ok: boolean }[]>`
        select c.relname as table, has_table_privilege(c.oid, 'SELECT') as ok from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${SCHEMA} and c.relkind = 'r'`;
      const unreadable = new Set(readable.filter((r) => !r.ok).map((r) => r.table));
      const tables = [...new Set(columns.map((c) => c.table))].filter((t) => !unreadable.has(t));
      const columnsOf = (table: string) => columns.filter((c) => c.table === table);
      // A surrogate key: a single-column primary key that is a uuid or an identity column.
      const surrogate = new Map<string, string>();
      for (const key of keys) {
        if (key.columns.length !== 1) continue;
        const column = columnsOf(key.table).find((c) => c.column === key.columns[0])!;
        if (column.type === "uuid" || column.identity) surrogate.set(key.table, column.column);
      }

      // Tables in dependency order: a table after every table whose rows it points to by surrogate key. A foreign key
      // that closes a cycle (or points at its own table) cannot be compared by content and is named as such.
      const compared = tables.filter((t) => !RUN_LEDGER.has(t));
      const dependsOn = (table: string) => foreign.filter((f) => f.table === table && f.references !== table && surrogate.has(f.references) && !RUN_LEDGER.has(f.references) && !unreadable.has(f.references)).map((f) => f.references);
      const order: string[] = [];
      const cyclic = new Set<string>();   // "table.column"
      const remaining = new Set(compared);
      while (remaining.size > 0) {
        const ready = [...remaining].filter((t) => dependsOn(t).every((d) => !remaining.has(d) || cyclic.has(`${t}>${d}`))).sort();
        if (ready.length === 0) {
          // Break one cycle edge, deterministically: the first table by name gives up its first unresolved reference.
          const table = [...remaining].sort()[0];
          const blocked = dependsOn(table).filter((d) => remaining.has(d)).sort()[0];
          cyclic.add(`${table}>${blocked}`);
          continue;
        }
        for (const table of ready) { order.push(table); remaining.delete(table); }
      }

      const out: { [table: string]: TableDigest } = {};
      const ledger: { [table: string]: { rows: number } } = {};
      for (const table of tables.filter((t) => RUN_LEDGER.has(t)).sort()) {
        const [{ rows }] = await tx.unsafe<{ rows: number }[]>(`select count(*)::int as rows from ${SCHEMA}.${ident(table)}`);
        ledger[table] = { rows };
      }
      for (const table of order) {
        const skipped: { [column: string]: string } = {};
        const byContent: { [column: string]: string } = {};
        const joins: string[] = [];
        const parts: string[] = [];
        for (const column of columnsOf(table)) {
          const fk = foreign.find((f) => f.table === table && f.column === column.column);
          const named = ALSO_NOT_COMPARED[table]?.[column.column];
          if (surrogate.get(table) === column.column) skipped[column.column] = "surrogate key (random uuid or sequence)";
          else if (fk && RUN_LEDGER.has(fk.references)) skipped[column.column] = `names a row of the run ledger (${fk.references}); how many runs there were depends on how the load was driven`;
          else if (fk && unreadable.has(fk.references)) skipped[column.column] = `foreign key to a table this login may not read (${fk.references})`;
          else if (fk && surrogate.has(fk.references) && (fk.references === table || cyclic.has(`${table}>${fk.references}`))) skipped[column.column] = `foreign key inside a reference cycle (${fk.references}); cannot be compared by content`;
          else if (fk && surrogate.has(fk.references)) {
            const alias = `m${joins.length}`;
            joins.push(`left join ${ident("_nat_" + fk.references)} ${alias} on ${alias}.id::text = t.${ident(column.column)}::text`);
            parts.push(`coalesce(${alias}.nat, case when t.${ident(column.column)} is null then '-' else '?' end)`);
            byContent[column.column] = fk.references;
          } else if (named) skipped[column.column] = named;
          else if (column.default && /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp)\(\)|CURRENT_TIMESTAMP/i.test(column.default)) skipped[column.column] = "filled by the database clock at write time";
        }
        const dropped = Object.keys({ ...skipped, ...byContent });
        const sumOf = (expression: string) => `coalesce(sum(('x' || substr(md5(coalesce(${expression}, '-')), 1, 15))::bit(60)::bigint), 0)::text`;
        const checks = columnsOf(table).filter((c) => !(c.column in skipped)).map((c, n) => {
          const at = Object.keys(byContent).indexOf(c.column);
          return { column: c.column, sql: `${sumOf(at >= 0 ? `m${at}.nat` : `t.${ident(c.column)}::text`)} as c${n}` };
        });
        const body = `(to_jsonb(t)${dropped.map((c) => ` - '${c.replaceAll("'", "''")}'`).join("")})::text`;
        const nat = `md5(${[body, ...parts].join(` || '|' || `)})`;
        const key = surrogate.get(table);
        await tx.unsafe(`create temp table ${ident("_nat_" + table)} on commit drop as select ${key ? `t.${ident(key)}` : "null::text"} as id, ${nat} as nat from ${SCHEMA}.${ident(table)} t ${joins.join(" ")}`);
        const [{ rows, digest }] = await tx.unsafe<{ rows: number; digest: string }[]>(`select count(*)::int as rows, md5(coalesce(string_agg(nat, '' order by nat), '')) as digest from ${ident("_nat_" + table)}`);
        const sums = checks.length ? (await tx.unsafe<{ [key: string]: string }[]>(`select ${checks.map((c) => c.sql).join(", ")} from ${SCHEMA}.${ident(table)} t ${joins.join(" ")}`))[0] : {};
        out[table] = { rows, content_digest: digest, columns_not_compared: skipped, foreign_keys_compared_by_content: byContent, column_checksums: Object.fromEntries(checks.map((c, n) => [c.column, sums[`c${n}`]])) };
        log(`${table}: ${rows} rows`);
      }
      return {
        digest_version: 1, schema: SCHEMA,
        complete: bypasses && unreadable.size === 0,
        incomplete_because: [...(bypasses ? [] : ["the login does not bypass row-level security, which can hide rows without an error"]), ...[...unreadable].sort().map((t) => `the login may not read ${t}`)],
        normalisation: {
          surrogate_keys: "left out; a foreign key to a surrogate key is compared by the content digest of the row it points to, recursively",
          database_clock_columns: "left out (a default of now()): they record when a load ran",
          run_ledger: "foreign keys to run-ledger tables are left out, and those tables are counted but never compared",
          named_exceptions: ALSO_NOT_COMPARED,
          everything_else: "every other column of every row is inside the digest (its JSON text), so equal digests mean equal content",
        },
        tables: out, run_ledger_tables: ledger,
      };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const out = args.indexOf("--out") >= 0 ? args[args.indexOf("--out") + 1] : undefined;
  const url = process.env.EVIDENCE_DIGEST_DB_URL;
  if (!out || !url) {
    console.error("usage: EVIDENCE_DIGEST_DB_URL=<a login that can read evidence_private> content_digest.ts --out <table-content.json>");
    process.exit(1);
  }
  try {
    const result = await digestStore(url, (message) => console.error(message));
    await writeFile(resolve(out), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    console.log(`content digest written: ${Object.keys(result.tables as object).length} tables compared by content`);
  } catch (error) {
    console.error("error: " + sanitize(String(error instanceof Error ? error.message : error)));
    process.exit(2);
  }
}
