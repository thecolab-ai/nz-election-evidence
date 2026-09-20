// End-to-end runner tests against a real disposable Postgres with the migrations applied.
// Run with EVIDENCE_TEST_LOCAL_STACK=1 against the disposable local stack, signed in as the scoped worker login
// (test/local-stack.ts). With EVIDENCE_REQUIRE_INTEGRATION=1 (CI) a skip is a failure. Uses a scripted publisher
// (no network) and a `fixture_it_*` source so nothing here can be mistaken for live data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import postgres from "postgres";
import { billsAdapter } from "../../supabase/functions/_shared/adapters/bills.ts";
import { createPostgresDb } from "../../supabase/functions/_shared/db.ts";
import { runSource } from "../../supabase/functions/_shared/runner.ts";
import { LOCAL_WORKER_LOGIN, localStackChoice } from "./local-stack.ts";
import type { SourceConfig, SourcesFile } from "../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { exportAdapter, loadExport, preflightExport } from "../src/export_import.ts";
import { bootstrapSql } from "../src/local_bootstrap.ts";
import { adminConnectionFromEnv, quietLogging } from "../src/operator.ts";
import { scramSha256Verifier } from "../src/scram.ts";

const choice = localStackChoice();
const url = choice.url;
const skip: string | false = url ? false : (choice.problem ?? "local stack not selected (set EVIDENCE_TEST_LOCAL_STACK=1)");

test("integration tests are not silently skipped where they are required", () => {
  if (choice.required) assert.ok(url, "EVIDENCE_REQUIRE_INTEGRATION=1 but there is no usable local stack: " + (choice.problem ?? "EVIDENCE_TEST_LOCAL_STACK is not 1"));
});

test("review 2: no automatic seed path creates a login, and no fixed password exists anywhere", async () => {
  const config = await readFile(new URL("../../supabase/config.toml", import.meta.url), "utf-8");
  const seedSection = /\[db\.seed\]([^[]*)/.exec(config)?.[1] ?? "";
  assert.match(seedSection, /\benabled\s*=\s*false\b/, "seeding stays off: nothing but migrations runs on a reset, local or linked");
  await assert.rejects(readFile(new URL("../../supabase/seed.sql", import.meta.url)), "the automatic seed file is gone");
  for (const name of await readdir(new URL("../../supabase/migrations/", import.meta.url))) {
    const sql = await readFile(new URL("../../supabase/migrations/" + name, import.meta.url), "utf-8");
    assert.doesNotMatch(sql, /\b(create|alter)\s+role\b[^;]*\bpassword\b/i, name + " must not set any role password");
  }
});

/** The tests must run as exactly the scoped worker: not a superuser, not the migration role, nothing more than evidence_ingest. */
async function assertScopedLogin(sql: postgres.Sql): Promise<void> {
  const [me] = await sql`
    select current_user as login, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
           (select array_agg(g.rolname order by g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid) as member_of,
           inet_server_addr()::text as server
    from pg_roles r where r.rolname = current_user`;
  assert.equal(me.login, LOCAL_WORKER_LOGIN);
  assert.deepEqual([me.rolsuper, me.rolbypassrls, me.rolcreaterole, me.rolcreatedb], [false, false, false, false]);
  assert.deepEqual(me.member_of, ["evidence_ingest"]);
}

const suffix = Date.now().toString(36);

const source: SourceConfig = {
  source_id: "fixture_it_bills_" + suffix, title: "TEST FIXTURE paginated source", publisher: "Fixture Publisher",
  official_url: "https://bills.fixture.example/", adapter_kind: "live_fetch", adapter_name: billsAdapter.name,
  allowed_hosts: ["bills.fixture.example"], view_scope: "general", snapshot_semantics: "complete_snapshot", enabled: false,
  blocked_reason: "test fixture", rights_id: "RIGHTS-770", access_basis: "documented_api",
};
const fixtureRights = { rights_id: source.rights_id!, publisher: "Fixture Publisher", source_url: "https://bills.fixture.example/", review_status: "pending",
  default_release: "link-only", licence_or_terms_url: "", verified_permissions: "TEST FIXTURE", excluded_assets: "TEST FIXTURE", attribution: "TEST FIXTURE",
  reviewed_on: "", approved_fields: [], register_hash: "fixture" };
const file: SourcesFile = { config_version: 1, registry_products: [], sources: [source], schedules: [] };

function bill(n: number, title?: string) {
  return { id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title: title ?? `TEST FIXTURE Bill ${n}`, billNumber: `${n}-1`, parliamentNumber: 54 };
}

/** Scripted publisher: 120 bills over three pages of 50. */
function publisher(options: { total?: number; amend?: number; failPage?: number; status?: number } = {}) {
  const total = options.total ?? 120;
  const requests: number[] = [];
  const impl = (async (requested: string | URL | Request, init?: RequestInit) => {
    if (String(requested).endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
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

test("review 2/3: the bootstrapped login works, its SQL refuses a network session, and the logging probe runs on a real server", { skip }, async () => {
  // Signing in at all proves the client-side SCRAM verifier is correct: the server was only ever given the verifier.
  const stored = new URL(url!);
  const env = { PGHOST: stored.hostname, PGPORT: stored.port, PGDATABASE: "postgres", PGUSER: LOCAL_WORKER_LOGIN };
  const admin = adminConnectionFromEnv(env, decodeURIComponent(stored.password));
  try {
    await admin.connect(async (tx) => {
      const [me] = await tx.query("select current_user as login, inet_server_addr() is not null as over_network");
      assert.deepEqual(me, { login: LOCAL_WORKER_LOGIN, over_network: true });
      // the worker may zero on-error parameter logging (user-settable) but not server logging (privileged)
      assert.equal(await tx.trySetLocal("log_parameter_max_length_on_error", "0"), true);
      assert.equal(await tx.trySetLocal("log_statement", "none"), false);
      const settings = await quietLogging(tx);
      assert.equal(settings.log_parameter_max_length_on_error, "0");
      assert.ok(settings.log_statement !== null, "real settings are read back after a failed savepoint");
    });
    // The bootstrap script, sent over TCP instead of the server's own socket: its first statement refuses.
    await assert.rejects(admin.connect((tx) => tx.query(bootstrapSql(scramSha256Verifier("TEST-FIXTURE-value-never-used-0123456789")))),
      /local bootstrap refused: this session is a network connection/);
  } finally {
    await admin.end();
  }
});

test("runner against a real database", { skip }, async (t) => {
  const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => undefined });
  await assertScopedLogin(sql);
  const db = createPostgresDb(sql);
  const holder = crypto.randomUUID();
  const base = { file, source, adapter: billsAdapter, mode: "incremental" as const, triggerKind: "test" as const, maxRecords: 1000, maxRuntimeSeconds: 120, dryRun: false, db, sleep: async () => {}, minIntervalMs: 0 };
  await db.syncRegistry({ rights: [fixtureRights], sources: [{ ...source, registry_key: "", expected_cadence_seconds: "", config_hash: "fixture", catalogue_products: [] }] } as never);
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

  await t.test("record budget: partial runs resume page by page under the same manifest, then finish", async () => {
    // A schedule always uses the same bound, so the manifest (which includes it) matches and resume applies.
    const small = { ...base, holder, maxRecords: 50 };
    const a = publisher({ total: 130 });
    const first = await runSource({ ...small, fetchImpl: a.impl });
    assert.deepEqual([first.status, first.error_class, first.complete_snapshot, first.tombstoned], ["partial", "budget_exhausted", false, 0]);
    const b = publisher({ total: 130 });
    const second = await runSource({ ...small, fetchImpl: b.impl });
    assert.equal(second.resumed_from_run_id, first.run_id);
    assert.deepEqual(b.requests, [2], "resumed at page two");
    assert.equal(second.status, "partial");
    const c = publisher({ total: 130 });
    const third = await runSource({ ...small, fetchImpl: c.impl });
    assert.equal(third.resumed_from_run_id, second.run_id);
    assert.deepEqual(c.requests, [3]);
    assert.equal(third.status, "succeeded");
    assert.equal(third.totals.versions_inserted, 10, "only the ten records added upstream are new");
    assert.deepEqual([third.complete_snapshot, third.tombstoned], [false, 0], "a run assembled from resumes never marks anything absent");
    // Bring the fixture publisher back to 120 for the cases below; the ten extras are then absent.
    const back = await runSource({ ...base, holder, fetchImpl: publisher().impl });
    assert.deepEqual([back.complete_snapshot, back.tombstoned], [true, 10]);
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

  await t.test("review 7: a robots.txt disallow ends the run as blocked, is stored in fetch_log, and removes nothing", async () => {
    const pages: string[] = [];
    const impl = (async (requested: string | URL | Request) => {
      pages.push(String(requested));
      return new Response("User-agent: *\nDisallow: /\n", { status: 200 });
    }) as typeof fetch;
    const blocked = await runSource({ ...base, holder, fetchImpl: impl });
    assert.deepEqual([blocked.status, blocked.error_class, blocked.tombstoned], ["blocked", "publisher_robots_disallowed", 0]);
    assert.deepEqual(pages, ["https://bills.fixture.example/robots.txt"], "only robots.txt was requested; the disallowed endpoint never was");
    const logged = await sql`select outcome from evidence_private.fetch_log where run_id = ${blocked.run_id} order by id`;
    assert.deepEqual(logged.map((r) => r.outcome), ["ok", "robots_disallowed"], "the database accepts and keeps the robots outcome");
  });

  await t.test("review 6: an undocumented endpoint is never contacted - the run is blocked before any request", async () => {
    let calls = 0;
    const impl = (async () => { calls++; return new Response("{}", { status: 200 }); }) as typeof fetch;
    const undocumented = { ...source, access_basis: "undocumented_endpoint" as const };
    const blocked = await runSource({ ...base, source: undocumented, holder, fetchImpl: impl });
    assert.deepEqual([blocked.status, blocked.error_class, blocked.tombstoned, calls], ["blocked", "access_basis_not_established", 0, 0]);
    const dry = await runSource({ ...base, source: undocumented, dryRun: true, db: null, fetchImpl: impl });
    assert.deepEqual([dry.status, dry.error_class, calls], ["blocked", "access_basis_not_established", 0], "a dry run does not contact it either");
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

test("export import against a real database", { skip }, async (t) => {
  // The real 2023 contract (enum maps, evidenced numbers, preflight) under a fixture-named source id and a
  // fixture-pinned checksum, so the rows can never be mistaken for the 2023 baseline.
  const real = (sourcesFile as unknown as SourcesFile).sources.find((s) => s.source_id === "baseline_2023_candidacies_export")!;
  const location = new URL("./fixtures/baseline-candidacies.fixture.jsonl", import.meta.url).pathname;
  const bytes = await readFile(location);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const manifestDir = await mkdtemp(join(tmpdir(), "fixture-manifest-"));
  await writeFile(join(manifestDir, "manifest.json"), JSON.stringify({ counts: { candidacies: 5 }, normalized_checksums: { candidacies: sha } }));
  const contract = { ...real.export_contract!, expectedInput: { sha256: "sha256:" + sha, rows: 5 } };
  const env = { [contract.fileEnv]: location, [contract.manifestEnv!]: join(manifestDir, "manifest.json") };
  const fixtureSource: SourceConfig = { ...real, source_id: "fixture_it_export_" + suffix, title: "TEST FIXTURE export import", catalogue_products: [], export_contract: contract };
  const fixtureFile: SourcesFile = { config_version: 1, registry_products: [], sources: [fixtureSource], schedules: [] };
  const sql = postgres(url!, { max: 1, prepare: false, onnotice: () => undefined });
  await assertScopedLogin(sql);
  const db = createPostgresDb(sql);
  t.after(async () => { await db.close(); });
  await db.syncRegistry({ sources: [{ ...fixtureSource, registry_key: "", rights_id: "", expected_cadence_seconds: "", config_hash: "fixture", catalogue_products: [], export_contract: null }] } as never);

  const loaded = await loadExport(contract, env);
  const findings = await preflightExport(fixtureSource, contract, loaded, env);
  assert.deepEqual(findings.rows_by_type, { electorate: 4, list: 1 });
  const base = { file: fixtureFile, source: fixtureSource, adapter: exportAdapter(loaded), mode: "export_import" as const, triggerKind: "test" as const,
    maxRecords: 1000, maxRuntimeSeconds: 120, dryRun: false, db, inputDigest: loaded.digest };

  const first = await runSource(base);
  assert.equal(first.status, "succeeded");
  assert.deepEqual([first.totals.seen, first.totals.versions_inserted, first.totals.rejected], [5, 5, 0], "every row stored, none skipped, none rejected by the database guard");
  assert.equal((first.projection as { baseline_candidacies: number }).baseline_candidacies, 5);
  assert.ok(!JSON.stringify(first).includes(location) && !JSON.stringify(first).includes(manifestDir), "no input location in the report");

  const replay = await runSource(base);
  assert.deepEqual([replay.totals.versions_inserted, replay.totals.unchanged, replay.totals.rejected], [0, 5, 0], "re-importing the same export changes nothing");
  assert.equal(replay.manifest_hash, first.manifest_hash);

  const rows = await sql`
    select i.external_id, c.candidacy_type, c.current_status, i.link_status, i.person_id, r.value_status, r.votes, e.list_rank,
           (select count(*)::int from evidence_private.candidacy_status_events s where s.candidacy_id = c.id
              and s.status = 'officially_nominated' and s.source_class = 'official_electoral_commission') as nomination_events
    from evidence_private.candidacies c
    join evidence_private.person_source_identities i on i.id = c.person_identity_id
    left join evidence_private.candidate_results r on r.candidacy_id = c.id
    left join evidence_private.party_list_entries e on e.candidacy_id = c.id
    where i.source_id = ${fixtureSource.source_id} order by i.external_id`;
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.candidacy_type), ["electorate", "list", "electorate", "electorate", "electorate"]);
  assert.ok(rows.every((r) => r.current_status === "officially_nominated" && r.nomination_events === 1 && r.link_status === "unresolved" && r.person_id === null),
    "official nomination arrived through one status event each; same-named rows stay unlinked");
  assert.deepEqual([rows[0]!.value_status, Number(rows[0]!.votes)], ["reported", 1200]);
  assert.deepEqual([rows[1]!.value_status, rows[1]!.votes, rows[1]!.list_rank], [null, null, 3], "a list candidacy has a rank and no vote row at all");
  assert.deepEqual([rows[2]!.value_status, Number(rows[2]!.votes)], ["reported", 0], "a source-reported zero is stored as zero");
  assert.deepEqual([rows[4]!.value_status, rows[4]!.votes], ["not_reported", null], "a figure the source passage does not evidence is not reported, and is not zero");
});
