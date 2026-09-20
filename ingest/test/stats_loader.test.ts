// Statistics family: exporter, artifact and loader. Offline: a scripted query runner stands in for the upstream
// collection and an in-memory port stands in for the database. Every row is a SYNTHETIC test input written by
// hand; none of it is imported data and none of it describes a real statistic.
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactRoot, openArtifact } from "../src/families/stats/artifact.ts";
import { ContractError } from "../src/families/stats/contract.ts";
import { exportSource } from "../src/families/stats/exporter.ts";
import { type DestinationCounts, loadSource, type ObservationBatchResult, type StatDb } from "../src/families/stats/loader.ts";
import type { StatsSourcePlan } from "../src/families/stats/routes.ts";
import type { QueryRunner } from "../src/families/stats/upstream.ts";

const SHA = "cd".repeat(32);
const PLAN: StatsSourcePlan = {
  source_id: "stats_fixture_series", products: [{ product_id: "P22", mapping_note: "fixture" }], title: "Fixture series", publisher: "Fixture Statistics Office",
  official_url: "https://fixture.example/listing/", rights_id: "RIGHTS-99", route: "operational", upstream: { operational_source: "stats_nz_series" }, historical: false,
  live_hosts: [], incremental: "none", incremental_note: "fixture",
};

function fact(n: number, overrides: { [key: string]: unknown } = {}): { [key: string]: unknown } {
  const month = String((n % 12) + 1).padStart(2, "0");
  return {
    record_id: `fixture:${String(n).padStart(4, "0")}`, source_url: "https://fixture.example/files/fixture.csv", observed_at: "2026-01-02 03:04:05.000",
    payload_json: JSON.stringify({
      adjustment: "not_stated", dataset: "fixture_dataset_csv", edition: "2026-06", frequency: "monthly", geography_code: "NZ", geography_label: "New Zealand", geography_level: "national",
      measure: "fixture_series", reference_period: `${2000 + Math.floor(n / 12)}-${month}`, series_group: "Fixture group", series_id: "FIX.S1", series_title_1: "Fixture item", series_title_2: "NA",
      series_title_3: "NA", source_page_url: "https://fixture.example/listing/", source_record_number: n, source_sha256: SHA, source_status: "FINAL", topic: "fixture", unit: "dollars",
      value_decimal: n % 7 === 0 ? null : `${n}.25`, value_raw: n % 7 === 0 ? ".." : `${n}.25`, value_status: n % 7 === 0 ? "not_available" : "reported", ...overrides,
    }),
  };
}

/** Answers the recipe's statements from fixed rows, the way the read-only command would. */
function scripted(facts: { [key: string]: unknown }[], storedRows = facts.length): QueryRunner {
  return async function* run(sql: string) {
    if (/count\(\) AS stored_rows/.test(sql)) {
      yield { record_kind: "fact", stored_rows: storedRows, record_ids: facts.length, runs: storedRows === facts.length ? 1 : 2, observed_from: "2026-01-01 00:00:00.000", observed_to: "2026-01-02 03:04:05.000" };
      return;
    }
    if (/record_kind = 'fact'/.test(sql)) {
      for (const row of facts) yield row;
      return;
    }
    throw new Error("unexpected statement in test");
  };
}

/** In-memory stand-in for the two ingestion functions, with the same idempotency and conflict rules. */
class MemoryDb implements StatDb {
  observations = new Map<string, string>();
  runs: { id: string; status: string; manifest: string; cursor: { file: string; offset: number } | null; resumedFrom: string | null }[] = [];
  metaCalls = 0;
  async syncRegistry(): Promise<unknown> { return {}; }
  async acquireLease(): Promise<boolean> { return true; }
  async releaseLease(): Promise<void> { /* nothing held */ }
  async startRun(_s: string, _h: string, _v: string, _m: string, manifestHash: string) {
    const previous = [...this.runs].reverse().find((r) => r.manifest === manifestHash && r.status !== "succeeded" && r.cursor && !this.runs.some((x) => x.resumedFrom === r.id));
    const run = { id: `run-${this.runs.length + 1}`, status: "running", manifest: manifestHash, cursor: null, resumedFrom: previous?.id ?? null };
    for (const r of this.runs) if (r.status === "running") r.status = "abandoned";
    this.runs.push(run);
    return { run_id: run.id, resumed_from_run_id: run.resumedFrom, resume_cursor: previous?.cursor ?? null };
  }
  async ingestMeta(): Promise<{ [key: string]: number }> { this.metaCalls++; return { routes: 1 }; }
  async ingestObservations(_r: string, _h: string, rows: unknown[]): Promise<ObservationBatchResult> {
    const result = { seen: rows.length, inserted: 0, unchanged: 0, conflicts: 0 };
    for (const row of rows as { dataset_key: string; release_key: string; series_key: string; period_label: string; content_hash: string; kind?: string }[]) {
      assert.equal(row.kind, undefined, "the kind discriminator is not sent to the database");
      const id = [row.dataset_key, row.release_key, row.series_key, row.period_label].join("|");
      const stored = this.observations.get(id);
      if (stored === undefined) { this.observations.set(id, row.content_hash); result.inserted++; } else if (stored === row.content_hash) result.unchanged++; else result.conflicts++;
    }
    return result;
  }
  async saveCheckpoint(runId: string, _h: string, cursor: { file: string; offset: number }): Promise<void> { this.runs.find((r) => r.id === runId)!.cursor = cursor; }
  async counts(): Promise<DestinationCounts> {
    const byRelease: { [key: string]: number } = {};
    for (const id of this.observations.keys()) { const [d, r] = id.split("|"); byRelease[`${d} @ ${r}`] = (byRelease[`${d} @ ${r}`] ?? 0) + 1; }
    return { datasets: 1, releases: 1, series: 1, geographies: 1, catalogue_entry_versions: 0, catalogue_entries_current: 0, observations: this.observations.size, observations_by_release: byRelease,
      observations_by_status: {}, withheld_rows_carrying_a_number: 0, content_digest: "x" };
  }
  summaries: string[] = [];
  async recordSummary(runId: string) { this.summaries.push(runId); }
  async finishRun(runId: string, _h: string, status: "succeeded" | "failed") { this.runs.find((r) => r.id === runId)!.status = status; return { status }; }
  async close(): Promise<void> { /* nothing open */ }
}

async function withRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "stats-artifact-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the artifact root is refused inside the repository and created owner-only outside it", async () => {
  await assert.rejects(artifactRoot({}), /EVIDENCE_EXPORT_STATS_DIR/);
  await assert.rejects(artifactRoot({ EVIDENCE_EXPORT_STATS_DIR: new URL("./fixtures", import.meta.url).pathname }), /must not be inside/);
  await withRoot(async (root) => {
    const made = await artifactRoot({ EVIDENCE_EXPORT_STATS_DIR: join(root, "private") });
    assert.equal((await stat(made)).mode & 0o777, 0o700);
  });
});

test("export: upstream rows reconcile exactly, earlier collection runs are explained, files are owner-only, and a re-export is byte-identical", async () => {
  await withRoot(async (root) => {
    const facts = Array.from({ length: 30 }, (_, n) => fact(n + 1));
    const manifest = await exportSource(PLAN, scripted(facts, 60), root);
    assert.equal(manifest.counts.observations, 30);
    assert.deepEqual(manifest.counts.observations_by_status, { missing: 4, reported: 26 });
    assert.equal(manifest.reconciliation[0].difference, 0);
    assert.match(manifest.reconciliation[1].explanation, /30 stored rows are earlier collection runs/);
    assert.equal(manifest.counts.routes, 1);
    for (const file of ["manifest.json", "meta.jsonl", "observations-00001.jsonl"]) assert.equal((await stat(join(root, PLAN.source_id, file))).mode & 0o777, 0o600, file);
    const again = await exportSource(PLAN, scripted(facts, 60), root);
    assert.deepEqual(again.files, manifest.files);
    // No stored original, location or command text reaches the artifact.
    const text = await readFile(join(root, PLAN.source_id, "observations-00001.jsonl"), "utf-8");
    assert.ok(!/payload_json|record_id|observed_at/.test(text));
  });
});

test("export fails closed: a count that does not reconcile, an empty source, or a duplicate identity writes no usable artifact", async () => {
  await withRoot(async (root) => {
    const facts = Array.from({ length: 5 }, (_, n) => fact(n + 1));
    const short: QueryRunner = async function* (sql) { for await (const row of scripted(facts)(sql)) { if (row.record_kind === "fact") yield { ...row, record_ids: 6 }; else yield row; } };
    await assert.rejects(exportSource(PLAN, short, root), /read 5 facts but upstream holds 6/);
    await assert.rejects(exportSource(PLAN, scripted([fact(1), fact(1)]), root), /share one observation identity/);
    const nothing: QueryRunner = async function* () { /* upstream answers with no rows */ };
    await assert.rejects(exportSource(PLAN, nothing, root), /treated as a fault, not as an empty source/);
    await assert.rejects(openArtifact(root, PLAN.source_id), ContractError);
  });
});

test("a tampered artifact is refused before any run exists", async () => {
  await withRoot(async (root) => {
    await exportSource(PLAN, scripted(Array.from({ length: 5 }, (_, n) => fact(n + 1))), root);
    await appendFile(join(root, PLAN.source_id, "observations-00001.jsonl"), "{}\n");
    await assert.rejects(openArtifact(root, PLAN.source_id), /does not match its manifest entry/);
  });
});

test("load, replay and resume: a replay writes nothing; a stopped run resumes after its checkpoint without skipping or doubling", async () => {
  await withRoot(async (root) => {
    const facts = Array.from({ length: 12000 }, (_, n) => fact(n + 1, { series_id: `FIX.S${n % 50}`, reference_period: `p${Math.floor(n / 50)}`, frequency: "irregular" }));
    await exportSource(PLAN, scripted(facts), root);
    const artifact = await openArtifact(root, PLAN.source_id);
    const db = new MemoryDb();

    const dry = await loadSource(PLAN, artifact, null, { dryRun: true });
    assert.equal(dry.status, "dry_run");
    assert.equal(db.observations.size, 0);

    const stopped = await loadSource(PLAN, artifact, db, { dryRun: false, failAfterBatches: 1 });
    assert.equal(stopped.status, "failed");
    assert.equal(db.observations.size, 5000);

    const resumed = await loadSource(PLAN, artifact, db, { dryRun: false });
    assert.equal(resumed.status, "succeeded");
    assert.equal(resumed.resumed_from_run_id, "run-1");
    assert.deepEqual(resumed.totals.observations, { seen: 7000, inserted: 7000, unchanged: 0, conflicts: 0 });
    assert.equal(db.observations.size, 12000);
    assert.equal(resumed.artifact_to_destination[0].difference, 0);

    const replay = await loadSource(PLAN, artifact, db, { dryRun: false });
    assert.equal(replay.status, "succeeded");
    assert.deepEqual(replay.totals.observations, { seen: 12000, inserted: 0, unchanged: 12000, conflicts: 0 });
    assert.equal(replay.replay_wrote_nothing, true);
    assert.equal(db.observations.size, 12000);
  });
});

test("a changed number under a stored identity fails the run; the stored value is kept", async () => {
  await withRoot(async (root) => {
    const facts = Array.from({ length: 10 }, (_, n) => fact(n + 1));
    await exportSource(PLAN, scripted(facts), root);
    const db = new MemoryDb();
    assert.equal((await loadSource(PLAN, await openArtifact(root, PLAN.source_id), db, { dryRun: false })).status, "succeeded");
    const before = new Map(db.observations);
    const revised = facts.map((f, i) => (i === 2 ? fact(3, { value_decimal: "999", value_raw: "999" }) : f));
    await exportSource(PLAN, scripted(revised), root);
    const receipt = await loadSource(PLAN, await openArtifact(root, PLAN.source_id), db, { dryRun: false });
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.error_class, "stat_identity_conflict");
    assert.equal(receipt.totals.observations.conflicts, 1);
    assert.deepEqual(db.observations, before);
  });
});

test("the receipt carries counts, hashes and publisher links only", async () => {
  await withRoot(async (root) => {
    await exportSource(PLAN, scripted(Array.from({ length: 3 }, (_, n) => fact(n + 1))), root);
    const receipt = await loadSource(PLAN, await openArtifact(root, PLAN.source_id), new MemoryDb(), { dryRun: false });
    const text = JSON.stringify(receipt);
    assert.ok(!text.includes(root), "no location on a disk");
    assert.ok(!/postgres(ql)?:\/\//.test(text));
    assert.deepEqual(receipt.products, ["P22"]);
    assert.match(receipt.artifact.digest, /^sha256:[0-9a-f]{64}$/);
  });
});
