#!/usr/bin/env node
// What a store HOLDS, as something two stores can be compared by: per table of evidence_private, its row count and a
// digest of the CONTENT of every row. Two loads of the same inputs (another family order, a replay, a hosted project
// beside a local one) hold the same data exactly when these digests are equal. Row counts alone cannot show that.
//
//   EVIDENCE_DIGEST_DB_URL=... node src/loaders/content_digest.ts --out <table-content.json>
//
// Reads only (one repeatable-read snapshot; it writes nothing but its own temporary tables). The login must be able to
// read every table of evidence_private and to bypass row-level security, or the answer says it is INCOMPLETE and is not
// evidence: an administrator, never the ingestion worker. The connection value is read from the environment and never
// printed. The output holds table and column names, counts and digests: no row content.
//
// The problem this solves: almost every row carries surrogate keys (random uuids) that differ between two honest loads,
// and most of the columns that point at another row are NOT declared foreign keys in this schema (54 of 192 uuid columns
// are undeclared), so a digest over raw columns would report every table as different and prove nothing. Comparing rows
// therefore means comparing what they REFER TO, not the ids they refer with:
//
//   1. A surrogate key (a single-column uuid or identity primary key) is left out of the digest.
//   2. A column that points at another row is replaced by the CONTENT of the row it points at. A declared foreign key
//      names its table; an undeclared uuid column is resolved by MEASUREMENT, never by its name: every non-null value
//      must be an id of the candidate table, checked against the whole column, and the first table that holds them all
//      wins (two tables cannot both hold a random uuid). A column that is entirely null refers to nothing.
//   3. Because references run in cycles (a record names its current version; a version names its record), content is
//      not computed in one pass but by refinement: every row starts with a digest of its own scalar columns, and each
//      round replaces each reference with the referred row's digest from the round before. Rounds continue until no
//      table's digests change (a fixpoint) or a bound is reached; the number of rounds used is in the output.
//   4. A column the database clock fills (a default of now()) records WHEN a load ran, not what was loaded: left out.
//   5. A reference to the run ledger (import_runs and friends) names a run, and how many runs there were depends on how
//      the load was driven (retries, resumes, family order): left out. Those tables are counted, never compared.
//   6. A text or json column that CARRIES a surrogate id inside it (a decision that cites the identity it compared) is
//      left out, with the table whose id was found in it named. This is measured too: an id is extracted from the
//      values and looked up.
//
// Nothing is left out silently: every column of every compared table is either inside the digest, or named in
// columns_not_compared with the reason, or named in references_compared_by_content with the table it was resolved to.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { sanitize } from "./access.ts";
import { RUN_LEDGER } from "./manifest_build.ts";

const SCHEMA = "evidence_private";
/** Refinement rounds are bounded; the output says how many were used and whether a fixpoint was reached. */
const MAX_ROUNDS = 8;
/** How many distinct values are sampled to choose a candidate table before the whole column is verified against it. */
const SAMPLE = 50;

interface Column { table: string; column: string; type: string; default: string | null; identity: boolean }

export interface TableDigest {
  rows: number;
  /** md5 over the sorted row digests of the final round. Equal digests mean equal content. */
  content_digest: string;
  columns_not_compared: { [column: string]: string };
  /** Column -> the table whose row content replaced it, and how that table was established. */
  references_compared_by_content: { [column: string]: string };
  /** Per compared column, an order-independent checksum: when two stores differ, this names the column. Diagnostic. */
  column_checksums: { [column: string]: string };
}

const ident = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const lit = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/** A reference: the column, the table it points at, and how that was established. */
interface Reference { column: string; parent: string; how: string }

export async function digestStore(url: string, log: (message: string) => void = () => undefined): Promise<{ [key: string]: unknown }> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined, connection: { application_name: "evidence-content-digest" } });
  try {
    return await sql.begin(async (tx) => {
      // One consistent snapshot. The transaction is not declared READ ONLY because the refinement materialises its row
      // digests in TEMPORARY tables and Postgres counts creating one as a write; every statement issued here is a
      // SELECT or a CREATE TEMP TABLE, and no DML is ever sent to an evidence table (asserted by the integration test).
      await tx`set transaction isolation level repeatable read`;

      const columns = await tx<Column[]>`
        select c.relname as table, a.attname as column, format_type(a.atttypid, a.atttypmod) as type,
               pg_get_expr(d.adbin, d.adrelid) as default, a.attidentity <> '' as identity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
        where n.nspname = ${SCHEMA} and c.relkind = 'r' order by c.relname, a.attnum`;
      const keys = await tx<{ table: string; columns: string[] }[]>`
        select c.relname as table, array_agg(a.attname::text order by k.ord) as columns
        from pg_constraint p join pg_class c on c.oid = p.conrelid join pg_namespace n on n.oid = c.relnamespace
        cross join lateral unnest(p.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
        where n.nspname = ${SCHEMA} and p.contype = 'p' group by c.relname`;
      const declared = await tx<{ table: string; column: string; references: string }[]>`
        select c.relname as table, a.attname as column, r.relname as references
        from pg_constraint p join pg_class c on c.oid = p.conrelid join pg_namespace n on n.oid = c.relnamespace
        join pg_class r on r.oid = p.confrelid join pg_namespace rn on rn.oid = r.relnamespace and rn.nspname = ${SCHEMA}
        join pg_attribute a on a.attrelid = c.oid and a.attnum = p.conkey[1]
        where n.nspname = ${SCHEMA} and p.contype = 'f' and cardinality(p.conkey) = 1`;

      // A digest is only evidence if the login saw every row: row-level security hides rows without an error.
      const [{ bypasses }] = await tx<{ bypasses: boolean }[]>`
        select rolsuper or rolbypassrls as bypasses from pg_roles where rolname = current_user`;
      const readable = await tx<{ table: string; ok: boolean }[]>`
        select c.relname as table, has_table_privilege(c.oid, 'SELECT') as ok
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${SCHEMA} and c.relkind = 'r'`;
      const unreadable = new Set(readable.filter((r) => !r.ok).map((r) => r.table));
      const all = [...new Set(columns.map((c) => c.table))].filter((t) => !unreadable.has(t));
      const compared = all.filter((t) => !RUN_LEDGER.has(t)).sort();
      const columnsOf = (table: string) => columns.filter((c) => c.table === table);

      // Tables that can be pointed AT: a single-column uuid primary key. (An identity/bigint key is a surrogate too,
      // but nothing in this schema refers to one, so such a table is never a parent.)
      const uuidKey = new Map<string, string>();
      const surrogate = new Map<string, string>();
      for (const key of keys) {
        if (key.columns.length !== 1) continue;
        const column = columnsOf(key.table).find((c) => c.column === key.columns[0]);
        if (!column) continue;
        if (column.type === "uuid" || column.identity) surrogate.set(key.table, column.column);
        if (column.type === "uuid" && !RUN_LEDGER.has(key.table) && !unreadable.has(key.table)) uuidKey.set(key.table, column.column);
      }
      const rows = new Map<string, number>();
      for (const table of all) {
        const [{ n }] = await tx.unsafe<{ n: number }[]>(`select count(*)::int as n from ${SCHEMA}.${ident(table)}`);
        rows.set(table, n);
      }

      // Resolve every reference. Declared foreign keys are read from the catalogue; the rest are measured.
      const references = new Map<string, Reference[]>();
      const skipped = new Map<string, { [column: string]: string }>();
      const parents = [...uuidKey.keys()].filter((t) => (rows.get(t) ?? 0) > 0);
      const contains = async (child: string, column: string, parent: string, limit: number | null): Promise<boolean> => {
        const source = limit === null
          ? `select distinct ${ident(column)} as v from ${SCHEMA}.${ident(child)} where ${ident(column)} is not null`
          : `select distinct ${ident(column)} as v from ${SCHEMA}.${ident(child)} where ${ident(column)} is not null limit ${limit}`;
        const [{ missing }] = await tx.unsafe<{ missing: number }[]>(
          `select count(*)::int as missing from (${source}) c
            where not exists (select 1 from ${SCHEMA}.${ident(parent)} p where p.${ident(uuidKey.get(parent)!)} = c.v)`);
        return missing === 0;
      };
      for (const table of compared) {
        const refs: Reference[] = [];
        const out: { [column: string]: string } = {};
        for (const column of columnsOf(table)) {
          const name = column.column;
          if (surrogate.get(table) === name) { out[name] = "surrogate key (a random uuid or a sequence)"; continue; }
          const fk = declared.find((f) => f.table === table && f.column === name);
          if (fk && RUN_LEDGER.has(fk.references)) {
            out[name] = `names a row of the run ledger (${fk.references}); how many runs there were depends on how the load was driven`;
            continue;
          }
          if (column.default && /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp)\(\)|CURRENT_TIMESTAMP/i.test(column.default)) {
            out[name] = "filled by the database clock at write time";
            continue;
          }
          if (fk && uuidKey.has(fk.references)) { refs.push({ column: name, parent: fk.references, how: "declared foreign key" }); continue; }
          if (column.type === "uuid") {
            const [{ n }] = await tx.unsafe<{ n: number }[]>(`select count(${ident(name)})::int as n from ${SCHEMA}.${ident(table)}`);
            if (n === 0) { out[name] = "every value is null: it refers to nothing"; continue; }
            // Measured, not guessed: a candidate must hold EVERY value of the column. Name affinity only orders the
            // candidates so the common case costs one test; the answer is decided by the data.
            const stem = name.replace(/_id$/, "");
            const affinity = (t: string) => (t === stem || t === stem + "s" ? 0 : t.includes(stem) || stem.includes(t.replace(/s$/, "")) ? 1 : 2);
            let found: string | null = null;
            for (const candidate of [...parents].sort((a, b) => affinity(a) - affinity(b) || a.localeCompare(b))) {
              if (!(await contains(table, name, candidate, SAMPLE))) continue;
              if (!(await contains(table, name, candidate, null))) continue;
              found = candidate;
              break;
            }
            if (found) refs.push({ column: name, parent: found, how: fk ? "declared foreign key" : "no declared foreign key: every value verified to be an id of this table" });
            else out[name] = "a uuid that is not an id of any table of this schema; nothing to resolve it to";
            continue;
          }
          if (column.type === "jsonb" || column.type.startsWith("text") || column.type.startsWith("character")) {
            // Does the value CARRY a surrogate id? Measured: pull ids out of a sample and look them up.
            const [{ found }] = await tx.unsafe<{ found: string | null }[]>(
              `select (select string_agg(distinct m[1], ' ') from (
                 select regexp_matches(${ident(name)}::text, ${lit("(" + UUID + ")")}, 'g') as m
                 from ${SCHEMA}.${ident(table)} where ${ident(name)} is not null limit ${SAMPLE}) x) as found`);
            if (found) {
              const embedded: string[] = [];
              for (const parent of parents) {
                const [{ hit }] = await tx.unsafe<{ hit: number }[]>(
                  `select count(*)::int as hit from ${SCHEMA}.${ident(parent)} p
                    where p.${ident(uuidKey.get(parent)!)} = any (${lit("{" + found.split(" ").join(",") + "}")}::uuid[])`);
                if (hit > 0) embedded.push(parent);
              }
              if (embedded.length > 0) {
                out[name] = `carries the surrogate id of a row of ${embedded.sort().join(", ")} inside its value`;
                continue;
              }
            }
          }
        }
        references.set(table, refs);
        skipped.set(table, out);
      }

      // The digest of a row's OWN columns: everything that is not left out and is not a reference.
      const baseExpression = (table: string): string => {
        const dropped = [...Object.keys(skipped.get(table) ?? {}), ...(references.get(table) ?? []).map((r) => r.column)];
        return `md5((to_jsonb(b)${dropped.map((c) => ` - ${lit(c)}`).join("")})::text)`;
      };
      for (const table of compared) {
        const key = uuidKey.get(table);
        if (!key) continue;
        await tx.unsafe(`create temp table ${ident("base_" + table)} on commit drop as
          select b.${ident(key)} as id, ${baseExpression(table)} as d from ${SCHEMA}.${ident(table)} b`);
        await tx.unsafe(`create index on ${ident("base_" + table)} (id)`);
        await tx.unsafe(`create temp table ${ident("r0_" + table)} on commit drop as select id, d from ${ident("base_" + table)}`);
        await tx.unsafe(`create index on ${ident("r0_" + table)} (id)`);
      }

      // Refinement only ever splits rows apart, so it has finished when no table tells more rows apart than it did in
      // the round before. (The digest VALUES keep changing every round by construction - each one is built from the
      // previous round's - so equal values would be the wrong test and would never be reached.)
      const distinctDigests = async (relation: string): Promise<number> => {
        const [{ n }] = await tx.unsafe<{ n: number }[]>(`select count(distinct d)::int as n from ${ident(relation)}`);
        return n;
      };
      let previous = "r0_";
      let rounds = 0;
      let fixpoint = false;
      let before = new Map<string, number>();
      for (const table of compared) if (uuidKey.has(table)) before.set(table, await distinctDigests("r0_" + table));
      for (let round = 1; round <= MAX_ROUNDS && !fixpoint; round++) {
        const current = `r${round}_`;
        for (const table of compared) {
          const key = uuidKey.get(table);
          if (!key) continue;
          const refs = references.get(table) ?? [];
          const joins = refs.map((r, i) => `left join ${ident(previous + r.parent)} m${i} on m${i}.id = b.${ident(r.column)}`).join(" ");
          const parts = refs.map((r, i) => `coalesce(m${i}.d, case when b.${ident(r.column)} is null then '-' else '?' end)`);
          await tx.unsafe(`create temp table ${ident(current + table)} on commit drop as
            select b.${ident(key)} as id, md5(${["base.d", ...parts].join(" || '|' || ")}) as d
            from ${SCHEMA}.${ident(table)} b
            join ${ident("base_" + table)} base on base.id = b.${ident(key)} ${joins}`);
          await tx.unsafe(`create index on ${ident(current + table)} (id)`);
        }
        const after = new Map<string, number>();
        for (const table of compared) if (uuidKey.has(table)) after.set(table, await distinctDigests(current + table));
        const split = [...after].filter(([table, n]) => (before.get(table) ?? 0) !== n).map(([table]) => table);
        fixpoint = split.length === 0;
        before = after;
        previous = current;
        rounds = round;
        log(`round ${round}: ${fixpoint ? "no table told more rows apart: refinement complete" : `still refining (${split.length} table(s) split further)`}`);
      }

      // Final digests, for every compared table (including those with no uuid key of their own), and the per-column
      // checksums that name the column when two stores differ.
      const out: { [table: string]: TableDigest } = {};
      for (const table of compared) {
        const refs = references.get(table) ?? [];
        const joins = refs.map((r, i) => `left join ${ident(previous + r.parent)} m${i} on m${i}.id = b.${ident(r.column)}`).join(" ");
        const value = (r: Reference, i: number) => `coalesce(m${i}.d, case when b.${ident(r.column)} is null then '-' else '?' end)`;
        const key = uuidKey.get(table);
        const rowDigest = key
          ? `(select d from ${ident(previous + table)} f where f.id = b.${ident(key)})`
          : `md5(${[baseExpression(table), ...refs.map(value)].join(" || '|' || ")})`;
        const [{ digest }] = await tx.unsafe<{ digest: string }[]>(
          `select md5(coalesce(string_agg(x.d, '' order by x.d), '')) as digest
             from (select ${rowDigest} as d from ${SCHEMA}.${ident(table)} b ${joins}) x`);
        const sum = (expression: string) => `coalesce(sum(('x' || substr(md5(coalesce(${expression}, '-')), 1, 15))::bit(60)::bigint), 0)::text`;
        const plain = columnsOf(table).filter((c) => !(c.column in (skipped.get(table) ?? {})) && !refs.some((r) => r.column === c.column));
        const checks = [
          ...plain.map((c, i) => ({ column: c.column, sql: `${sum(`b.${ident(c.column)}::text`)} as k${i}` })),
          ...refs.map((r, i) => ({ column: r.column, sql: `${sum(value(r, i))} as j${i}` })),
        ];
        const sums = checks.length
          ? (await tx.unsafe<{ [key: string]: string }[]>(`select ${checks.map((c) => c.sql).join(", ")} from ${SCHEMA}.${ident(table)} b ${joins}`))[0]
          : {};
        out[table] = {
          rows: rows.get(table) ?? 0,
          content_digest: digest,
          columns_not_compared: skipped.get(table) ?? {},
          references_compared_by_content: Object.fromEntries(refs.map((r) => [r.column, `${r.parent} (${r.how})`])),
          column_checksums: Object.fromEntries(checks.map((c, i) => [c.column, Object.values(sums)[i]])),
        };
        log(`${table}: ${rows.get(table)} rows`);
      }

      const discovered = compared.flatMap((t) => (references.get(t) ?? []).filter((r) => r.how.startsWith("no declared")).map((r) => `${t}.${r.column} -> ${r.parent}`));
      const unresolved = compared.flatMap((t) => Object.entries(skipped.get(t) ?? {}).filter(([, why]) => why.startsWith("a uuid that is not")).map(([c]) => `${t}.${c}`));
      return {
        digest_version: 2,
        schema: SCHEMA,
        complete: bypasses && unreadable.size === 0,
        incomplete_because: [
          ...(bypasses ? [] : ["the login does not bypass row-level security, which can hide rows without an error"]),
          ...[...unreadable].sort().map((t) => `the login may not read ${t}`),
        ],
        normalisation: {
          method: "row digests refined in rounds: each round replaces every reference with the digest the referred row had in the round before, so cycles converge and no surrogate id is ever compared",
          rounds_used: rounds,
          refinement_complete: fixpoint,
          refinement_note: "complete means the last round told no more rows apart than the one before, so no further round could change what is compared",
          surrogate_keys: "left out",
          references: "replaced by the content of the row referred to; a declared foreign key names its table, an undeclared uuid column is resolved only by verifying that every one of its values is an id of that table",
          references_discovered_by_measurement: discovered.sort(),
          uuid_columns_left_unresolved: unresolved.sort(),
          database_clock_columns: "left out (a default of now()): they record when a load ran, not what was loaded",
          run_ledger: "references to run-ledger tables are left out, and those tables are counted but never compared",
          everything_else: "every other column of every row is inside the digest (its JSON text), so equal digests mean equal content",
        },
        tables: out,
        run_ledger_tables: Object.fromEntries(all.filter((t) => RUN_LEDGER.has(t)).sort().map((t) => [t, { rows: rows.get(t) ?? 0 }])),
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
    console.error("usage: EVIDENCE_DIGEST_DB_URL=<a login that reads all of evidence_private> content_digest.ts --out <table-content.json>");
    process.exit(1);
  }
  try {
    const result = await digestStore(url, (message) => console.error(message));
    await writeFile(resolve(out), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    const normalisation = result.normalisation as { rounds_used: number; refinement_complete: boolean };
    console.log(`content digest written: ${Object.keys(result.tables as object).length} tables, ${normalisation.rounds_used} refinement rounds`
      + `${normalisation.refinement_complete ? " (refinement complete)" : " (BOUND REACHED while still refining)"}`);
  } catch (error) {
    console.error("error: " + sanitize(String(error instanceof Error ? error.message : error)));
    process.exit(2);
  }
}
