// End-to-end runner tests against a real disposable Postgres with the migrations applied.
// Skipped unless EVIDENCE_TEST_DB_URL points at the LOCAL stack. Uses a scripted publisher
// (no network) and a `fixture_it_*` source so nothing here can be mistaken for live data.
import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { billsAdapter } from "../../supabase/functions/_shared/adapters/bills.ts";
import { createPostgresDb } from "../../supabase/functions/_shared/db.ts";
import { runSource } from "../../supabase/functions/_shared/runner.ts";
import type { SourceConfig, SourcesFile } from "../../supabase/functions/_shared/types.ts";

const url = process.env.EVIDENCE_TEST_DB_URL;
const local = url ? /@(127\.0\.0\.1|localhost):\d+\//.test(url) : false;
const suffix = Date.now().toString(36);

const source: SourceConfig = {
  source_id: "fixture_it_bills_" + suffix, title: "TEST FIXTURE paginated source", publisher: "Fixture Publisher",
  official_url: "https://bills.fixture.example/", adapter_kind: "live_fetch", adapter_name: billsAdapter.name,
  allowed_hosts: ["bills.fixture.example"], view_scope: "general", snapshot_semantics: "complete_snapshot", enabled: false,
  blocked_reason: "test fixture",
};
const file: SourcesFile = { config_version: 1, registry_products: [], sources: [source], schedules: [] };

function bill(n: number, title?: string) {
  return { id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title: title ?? `TEST FIXTURE Bill ${n}`, billNumber: `${n}-1`, parliamentNumber: 54 };
}

/** Scripted publisher: 120 bills over three pages of 50. */
function publisher(options: { total?: number; amend?: number; failPage?: number; status?: number } = {}) {
  const total = options.total ?? 120;
  const requests: number[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const page = JSON.parse(String(init?.body)).page as number;
    requests.push(page);
    if (options.status) return new Response("<iframe src='/_Incapsula_Resource'></iframe>", { status: options.status });
    if (options.failPage === page) return new Response("upstream fault", { status: 500 });
    const results = [];
    for (let n = (page - 1) * 50 + 1; n <= Math.min(page * 50, total); n++) results.push(bill(n, n === options.amend ? `TEST FIXTURE Bill ${n} (amended)` : undefined));
    return new Response(JSON.stringify({ totalResults: total, results }), { status: 200 });
  }) as typeof fetch;
  return { impl, requests };
}

test("runner against a real database", { skip: !url ? "EVIDENCE_TEST_DB_URL not set" : !local ? "refusing: not a local database URL" : false }, async (t) => {
  const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => undefined });
  const db = await createPostgresDb(sql, "evidence_ingest");
  const holder = crypto.randomUUID();
  const base = { file, source, adapter: billsAdapter, mode: "incremental" as const, triggerKind: "test" as const, maxRecords: 1000, maxRuntimeSeconds: 120, dryRun: false, db, sleep: async () => {} };
  await db.syncRegistry({ sources: [{ ...source, registry_key: "", rights_id: "", expected_cadence_seconds: "", config_hash: "fixture", catalogue_products: [] }] } as never);
  t.after(async () => { await db.close(); });

  await t.test("dry run writes nothing and is deterministic", async () => {
    const a = await runSource({ ...base, dryRun: true, db: null, fetchImpl: publisher().impl });
    const b = await runSource({ ...base, dryRun: true, db: null, fetchImpl: publisher().impl });
    assert.equal(a.status, "dry_run");
    assert.equal(a.planned_records?.length, 120);
    assert.equal(a.manifest_hash, b.manifest_hash);
    assert.deepEqual(a.planned_records, b.planned_records);
    assert.equal(a.run_id, null);
  });

  await t.test("crash mid-run, then resume from the checkpoint without refetching stored pages", async () => {
    const first = publisher();
    const crashed = await runSource({ ...base, holder, fetchImpl: first.impl, failAfterBatches: 1 });
    assert.equal(crashed.error_class, "simulated_crash");
    assert.equal(crashed.totals.versions_inserted, 50);

    const second = publisher();
    const resumed = await runSource({ ...base, holder, fetchImpl: second.impl });
    assert.equal(resumed.resumed_from_run_id, crashed.run_id);
    assert.deepEqual(second.requests, [2, 3], "page one was not fetched again");
    assert.equal(resumed.totals.versions_inserted, 70);
    assert.equal(resumed.status, "succeeded");
    assert.equal(resumed.complete_snapshot, false, "a resumed run never claims a complete snapshot");
    assert.equal(resumed.tombstoned, 0);
  });

  await t.test("idempotent replay: full re-run inserts no versions", async () => {
    const replay = await runSource({ ...base, holder, fetchImpl: publisher().impl });
    assert.equal(replay.status, "succeeded");
    assert.equal(replay.complete_snapshot, true);
    assert.deepEqual([replay.totals.seen, replay.totals.versions_inserted, replay.totals.unchanged], [120, 0, 120]);
  });

  await t.test("overlap prevention: a second worker is refused while a lease is live", async () => {
    assert.equal(await db.acquireLease(source.source_id, holder, 60), true);
    const other = await runSource({ ...base, holder: crypto.randomUUID(), fetchImpl: publisher().impl });
    assert.equal(other.status, "skipped_lease_held");
    await db.releaseLease(source.source_id, holder);
  });

  await t.test("publisher refusal is recorded as blocked and removes nothing", async () => {
    const blocked = await runSource({ ...base, holder, fetchImpl: publisher({ status: 403 }).impl });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.error_class, "publisher_challenge");
    assert.equal(blocked.tombstoned, 0);
  });

  await t.test("a failing page mid-pagination fails the run and removes nothing", async () => {
    const failed = await runSource({ ...base, holder, fetchImpl: publisher({ failPage: 2 }).impl });
    assert.equal(failed.status, "failed");
    assert.equal(failed.fetches.filter((f) => f.outcome === "http_error").length, 3, "retried to the bound");
    assert.equal(failed.tombstoned, 0);
  });

  await t.test("amended record appends one version; withdrawn record is tombstoned, history kept", async () => {
    // The failed run above left a checkpoint that says total=120. The publisher now reports 119, so the
    // resumed attempt is refused as inconsistent - and the run after that must start clean, not wedge.
    const stale = await runSource({ ...base, holder, fetchImpl: publisher({ total: 119, amend: 7 }).impl });
    assert.equal(stale.resumed_from_run_id !== null, true, "first attempt resumes the failed run");
    assert.equal(stale.error_class, "source_changed_during_pagination");
    assert.equal(stale.tombstoned, 0);
    const full = await runSource({ ...base, holder, fetchImpl: publisher({ total: 119, amend: 7 }).impl });
    assert.equal(full.resumed_from_run_id, null, "a checkpoint is resumed at most once");
    assert.equal(full.status, "succeeded");
    assert.equal(full.complete_snapshot, true);
    assert.equal(full.totals.versions_inserted, 1);
    assert.equal(full.tombstoned, 1);
  });
});
