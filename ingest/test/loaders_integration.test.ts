// The loader contract against a REAL database (the disposable local stack), signed in as the scoped worker login.
// Run with EVIDENCE_TEST_LOCAL_STACK=1; with EVIDENCE_REQUIRE_INTEGRATION=1 a skip is a failure. TEST FIXTURES ONLY:
// every source id below starts with `itest_`, every publisher and URL is a fixture, and no real source is written to.
//
//   - the ledger guard: the SQL function and the one TypeScript mirror agree on every shared vector
//   - statistics keeps its typed bulk writer: a stopped load resumes from its checkpoint without skipping or doubling
//     a row, a replay writes nothing, a cell with no number never holds one, and the typed tally and the recorded
//     summary agree with the artifact
//   - the worker login can run the typed tally and cannot widen anything

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import postgres from "postgres";
import { textViolation } from "../../supabase/functions/_shared/text_guard.ts";
import { openArtifact } from "../src/families/stats/artifact.ts";
import { exportSource } from "../src/families/stats/exporter.ts";
import { connectLoader, loadSource } from "../src/families/stats/loader.ts";
import type { StatsSourcePlan } from "../src/families/stats/routes.ts";
import type { QueryRunner } from "../src/families/stats/upstream.ts";
import { typedDestinationCounts } from "../src/loaders/typed.ts";
import { localStackChoice } from "./local-stack.ts";

const choice = localStackChoice();
const url = choice.url;
const skip: string | false = url ? false : (choice.problem ?? "local stack not selected (set EVIDENCE_TEST_LOCAL_STACK=1)");

test("loader integration tests are not silently skipped where they are required", () => {
  if (choice.required) assert.ok(url, "EVIDENCE_REQUIRE_INTEGRATION=1 but there is no usable local stack: " + (choice.problem ?? "EVIDENCE_TEST_LOCAL_STACK is not 1"));
});

test("ledger guard: the database function and the TypeScript mirror agree on every shared vector", { skip }, async () => {
  const { vectors } = JSON.parse(await readFile(new URL("./fixtures/text_guard_vectors.json", import.meta.url), "utf-8")) as { vectors: { text: string; expect: string | null; why: string }[] };
  const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    for (const vector of vectors) {
      const [{ r }] = await sql`select evidence_private.text_violation(${vector.text}) as r`;
      assert.equal(r, vector.expect, `SQL: ${vector.why}`);
      assert.equal(textViolation(vector.text), r, `TypeScript equals SQL: ${vector.why}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
});

const suffix = Date.now().toString(36);
const SOURCE_ID = `itest_stats_${suffix}`;
const SHA = "ef".repeat(32);
const ROWS = 12_000;   // more than two writer batches of 5,000, so a stop after one batch leaves real work for the resume
const PLAN: StatsSourcePlan = {
  source_id: SOURCE_ID, products: [], title: "TEST FIXTURE statistics series", publisher: "Fixture Statistics Office (TEST FIXTURE)",
  official_url: "https://fixture.example/listing/", rights_id: "RIGHTS-96", route: "operational", upstream: { operational_source: "stats_nz_series" }, historical: false,
  live_hosts: [], incremental: "none", incremental_note: "fixture",
};

function fact(n: number): { [key: string]: unknown } {
  const withheld = n % 7 === 0;
  return {
    record_id: `fixture:${String(n).padStart(6, "0")}`, source_url: "https://fixture.example/files/fixture.csv", observed_at: "2026-01-02 03:04:05.000",
    payload_json: JSON.stringify({
      adjustment: "not_stated", dataset: "fixture_dataset_csv", edition: "2026-06", frequency: "monthly", geography_code: "NZ", geography_label: "New Zealand", geography_level: "national",
      measure: "fixture_series", reference_period: `${1000 + Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`, series_group: "Fixture group", series_id: `FIX.S${n % 5}`,
      series_title_1: "Fixture item", series_title_2: "NA", series_title_3: "NA", source_page_url: "https://fixture.example/listing/", source_record_number: n, source_sha256: SHA,
      source_status: "FINAL", topic: "fixture", unit: "dollars", value_decimal: withheld ? null : `${n}.25`, value_raw: withheld ? ".." : `${n}.25`, value_status: withheld ? "not_available" : "reported",
    }),
  };
}

function scripted(facts: { [key: string]: unknown }[]): QueryRunner {
  return async function* run(sql: string) {
    if (/count\(\) AS stored_rows/.test(sql)) {
      yield { record_kind: "fact", stored_rows: facts.length, record_ids: facts.length, runs: 1, observed_from: "2026-01-01 00:00:00.000", observed_to: "2026-01-02 03:04:05.000" };
      return;
    }
    if (/record_kind = 'fact'/.test(sql)) {
      for (const row of facts) yield row;
      return;
    }
    throw new Error("unexpected statement in test");
  };
}

test("statistics: a stopped load resumes after its checkpoint, a replay writes nothing, and no cell without a number holds one", { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), "itest-stats-"));
  const env = { EVIDENCE_INGEST_DB_URL: url! };
  const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    const facts = Array.from({ length: ROWS }, (_, n) => fact(n + 1));
    const withheld = facts.filter((_, n) => (n + 1) % 7 === 0).length;
    await exportSource(PLAN, scripted(facts), root, () => undefined);
    const artifact = await openArtifact(root, SOURCE_ID);
    assert.equal(artifact.manifest.counts.observations, ROWS);

    const db = await connectLoader(env);
    try {
      await db.syncRegistry({
        rights: [{ rights_id: "RIGHTS-96", publisher: "Fixture Statistics Office (TEST FIXTURE)", source_url: "https://fixture.example/", review_status: "pending", default_release: "link-only", register_hash: "itest" }],
        registry_products: [{ registry_key: "statistics", title: "Official statistics and statistical catalogues", domain: "Statistics" }],
        sources: [{
          source_id: SOURCE_ID, registry_key: "statistics", title: PLAN.title, publisher: PLAN.publisher, official_url: PLAN.official_url, adapter_kind: "export_import",
          adapter_name: "stats_family_artifact", allowed_hosts: [], rights_id: "RIGHTS-96", view_scope: "statistics", snapshot_semantics: "append_only_feed", enabled: false, config_hash: "itest",
        }],
      });

      // 1. The process stops after ONE stored batch of 5,000 rows. Its checkpoint and its lease stay behind.
      const stopped = await loadSource(PLAN, artifact, db, { dryRun: false, failAfterBatches: 1, holder: "aaaaaaaa-0000-4000-8000-00000000000a" });
      assert.equal(stopped.status, "failed");
      assert.deepEqual([stopped.totals.batches, stopped.totals.observations.inserted], [1, 5000]);
      const [{ stored_after_stop }] = await sql`select (evidence_private.stat_source_counts(${SOURCE_ID}) ->> 'observations')::int as stored_after_stop`;
      assert.equal(stored_after_stop, 5000, "exactly the rows of the stored batch are in the store");

      // 2. The next call resumes the same run from its checkpoint: no row skipped, none sent twice.
      const resumed = await loadSource(PLAN, artifact, db, { dryRun: false, holder: "aaaaaaaa-0000-4000-8000-00000000000a" });
      assert.equal(resumed.status, "succeeded", resumed.error_detail ?? "");
      assert.equal(resumed.resumed_from_run_id, stopped.run_id, "the resume continues the stopped run");
      assert.deepEqual([resumed.totals.observations.inserted, resumed.totals.observations.unchanged, resumed.totals.observations.conflicts], [ROWS - 5000, 0, 0], "only the rows after the checkpoint were sent");
      assert.equal(resumed.destination!.observations, ROWS);
      assert.equal(resumed.destination!.withheld_rows_carrying_a_number, 0);
      assert.ok(resumed.artifact_to_destination.every((line) => line.explanation !== "UNEXPLAINED"));

      // 3. A replay of the whole artifact writes nothing.
      const replay = await loadSource(PLAN, artifact, db, { dryRun: false });
      assert.equal(replay.status, "succeeded");
      assert.deepEqual([replay.totals.observations.inserted, replay.totals.observations.unchanged, replay.totals.observations.conflicts], [0, ROWS, 0]);
      assert.equal(replay.replay_wrote_nothing, true);
    } finally {
      await db.close();
    }

    // 4. Typed rows, straight from the store: every withheld cell is null with a status, never 0; published values are exact.
    const [cells] = await sql`
      select count(*)::int as observations,
             count(*) filter (where o.value_status not in ('reported', 'provisional'))::int as without_a_number,
             count(*) filter (where o.value_status not in ('reported', 'provisional') and (o.value is not null or o.value_double is not null))::int as withheld_holding_a_number,
             count(*) filter (where o.value_status in ('reported', 'provisional') and o.value is null and o.value_double is null)::int as reported_without_a_number,
             sum(o.value)::text as total
      from evidence_private.stat_observations o
      join evidence_private.lineage_stat_series l on l.series_id = o.series_id where l.source_id = ${SOURCE_ID}`;
    assert.deepEqual([cells.observations, cells.without_a_number, cells.withheld_holding_a_number, cells.reported_without_a_number], [ROWS, withheld, 0, 0]);
    const expectedTotal = facts.reduce((sum, _f, n) => ((n + 1) % 7 === 0 ? sum : sum + (n + 1) * 100 + 25), 0);
    assert.equal(Math.round(Number(cells.total) * 100), expectedTotal, "the exact decimal sum of the published values");

    // 5. The shared typed tally (run as the worker) and the summary recorded for the sources view agree with the artifact.
    const tally = await typedDestinationCounts(sql, SOURCE_ID);
    assert.equal(tally.counts.stat_observations, ROWS);
    assert.equal(tally.counts.stat_series, 5);
    assert.ok(!Object.keys(tally.counts).some((table) => !table.startsWith("stat_") && table !== "geography_versions"), "a statistics source is credited with statistics tables only");
    const [summary] = await sql`select observations::int, observations_without_a_number::int, series from evidence_private.stat_source_summary where source_id = ${SOURCE_ID}`;
    assert.deepEqual([summary.observations, summary.observations_without_a_number, summary.series], [ROWS, withheld, 5]);

    // 6. The SAME login that just loaded the source, with plain DML after the run has finished: the tables refuse it.
    //    (The worker must hold table privileges because its functions run with the caller's rights, so the rules live in the tables.)
    const [who] = await sql`select current_user as login, r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb as elevated,
        (select array_agg(m.rolname::text order by 1) from pg_auth_members a join pg_roles m on m.oid = a.roleid where a.member = r.oid) as member_of
      from pg_roles r where r.rolname = current_user`;
    assert.deepEqual([who.elevated, who.member_of], [false, ["evidence_ingest"]], "the login is a member of evidence_ingest and nothing more");
    const refused = async (query: Promise<unknown>, pattern: RegExp, what: string) => { await assert.rejects(query, pattern, what); };
    await refused(sql`update evidence_private.stat_observations set value = 1`, /permission denied/, "update of stored observations");
    await refused(sql`delete from evidence_private.stat_observations`, /permission denied/, "delete of stored observations");
    await refused(sql`update evidence_private.stat_series set unit = 'defaced'`, /permission denied/, "update of a series definition");
    await refused(sql`update evidence_private.stat_datasets set title = 'defaced' where source_id = ${SOURCE_ID}`, /only inside a running run/, "edit of a dataset of a finished source");
    await refused(sql`insert into evidence_private.stat_datasets (source_id, dataset_key, title, publisher) values (${SOURCE_ID}, 'hostile', 'x', 'x')`, /only inside a running run/, "a dataset outside a run");
    await refused(sql`
      insert into evidence_private.stat_observations (series_id, release_id, period_label, value, raw_value, value_status, parse_status, content_hash, canonical_route, import_run_id)
      select o.series_id, o.release_id, 'hostile period', 1, '1', 'reported', 'parsed', ${"sha256:" + "f".repeat(64)}, o.canonical_route, o.import_run_id
      from evidence_private.stat_observations o join evidence_private.lineage_stat_series l on l.series_id = o.series_id where l.source_id = ${SOURCE_ID} limit 1`,
      /only inside a running run/, "an observation that borrows the id of a finished run");
    await refused(sql`update evidence_private.stat_source_summary set observations = observations + 1 where source_id = ${SOURCE_ID}`, /only inside a running run|does not equal/, "a false summary");
    const [{ still }] = await sql`select (evidence_private.stat_source_counts(${SOURCE_ID}) ->> 'observations')::int as still`;
    assert.equal(still, ROWS, "nothing hostile was stored");

    // 7. The worker cannot do anything the tally did not need: no write to the lineage register, no new projector.
    await assert.rejects(sql`insert into evidence_private.public_lineage (object_schema, object_name, lineage_kind, note) values ('evidence_private', 'itest', 'not_source_data', 'should be refused for the worker login')`, /permission denied|row-level security/);
    await assert.rejects(sql`insert into evidence_private.run_projectors (projector_key, function_name) values ('itest_projector', 'text_violation')`, /permission denied|row-level security/);
  } finally {
    await sql.end({ timeout: 5 });
    await rm(root, { recursive: true, force: true });
  }
});

test("content digest: deterministic, holds no row content, and a login that cannot see every row says its digest is incomplete", { skip }, async () => {
  const { digestStore } = await import("../src/loaders/content_digest.ts");
  const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => undefined });
  const [{ storeDigestBefore }] = await sql`select (evidence_private.stat_source_counts(${SOURCE_ID}) ->> 'content_digest') as "storeDigestBefore"`;
  const first = await digestStore(url!) as { complete: boolean; incomplete_because: string[]; tables: { [table: string]: { rows: number; content_digest: string; columns_not_compared: { [column: string]: string } } } };
  const second = await digestStore(url!) as typeof first;
  assert.deepEqual(first.tables, second.tables, "the same store gives the same digests");
  // The worker login does not bypass row-level security, so its digest may never be used as evidence of a whole store.
  assert.equal(first.complete, false);
  assert.match(first.incomplete_because.join("; "), /row-level security/);
  assert.match(first.tables.stat_observations.content_digest, /^[0-9a-f]{32}$/);
  assert.ok("id" in first.tables.stat_observations.columns_not_compared && "import_run_id" in first.tables.stat_observations.columns_not_compared, "what is left out is named, with its reason");
  assert.ok(!/fixture_dataset|Fixture Statistics/.test(JSON.stringify(first)), "table and column names, counts and digests only");
  // It writes nothing but its own temporary tables: the store is exactly as it was before the two runs above.
  const [after] = await sql`select (evidence_private.stat_source_counts(${SOURCE_ID}) ->> 'observations')::int as observations, (evidence_private.stat_source_counts(${SOURCE_ID}) ->> 'content_digest') as digest`;
  assert.deepEqual([after.observations, after.digest], [ROWS, storeDigestBefore], "a digest run leaves the store exactly as it found it");
  await sql.end({ timeout: 5 });
});
