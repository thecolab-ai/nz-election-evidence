// The one loader contract: registry merge, rights per actual source, route coverage of the 24 products, target
// resolution, shared privacy and source-access rules, retries, statuses and exit codes. Offline: no database, no network.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CLI_ONLY_ADAPTERS, LIVE_ADAPTERS } from "../../supabase/functions/_shared/adapters/index.ts";
import { textViolation } from "../../supabase/functions/_shared/text_guard.ts";
import type { SourcesFile } from "../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { loaders, resolveTargets, runCommand } from "../src/cli.ts";
import { assertPrivateInput, insideAnyCheckout, insideRepository, receiptViolations, redactReceipt, refreshAccess, REPOSITORY_ROOT, sanitize } from "../src/loaders/access.ts";
import {
  check, ERROR_CODES, EXIT, exitCodeFor, LOADER_COMMANDS, LoaderError, type LoaderFamily, type LoaderStatus, type LoaderUnit, newReceipt, settle, type TargetReceipt,
} from "../src/loaders/contract.ts";
import { productCoverage, REFRESH_GAPS, SOURCE_ROUTES, STATS_REFRESH, UNPUBLISHED_2026 } from "../src/loaders/coverage.ts";
import { coreOf, type Fragment, fragments, mergeRegistry, RIGHTS_EXCEPTIONS, rightsProblems, type RightsRow } from "../src/loaders/registry.ts";
import { buildRegistry } from "../src/loaders/registry_build.ts";
import { isTransient, withRetry } from "../src/loaders/retry.ts";

const committed = sourcesFile as unknown as SourcesFile;
const register = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "catalogue/rights-register.json"), "utf-8")) as RightsRow[];
const catalogue = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "catalogue/sources.json"), "utf-8")) as { product_id: string; title: string; record_count: number }[];

// Shared ledger guard ---------------------------------------------------------------------------------------------------------

test("text guard: the TypeScript mirror gives the expected answer for every shared vector", async () => {
  const { vectors } = JSON.parse(await readFile(new URL("./fixtures/text_guard_vectors.json", import.meta.url), "utf-8")) as { vectors: { text: string; expect: string | null; why: string }[] };
  assert.ok(vectors.length >= 15);
  for (const vector of vectors) assert.equal(textViolation(vector.text), vector.expect, vector.why);
});

test("text guard: an identifier never hides a phone number, and both spellings of a digest pass", () => {
  const digest = "0212345678ab".repeat(5) + "cdef";
  assert.equal(digest.length, 64);
  assert.equal(textViolation(`Stephens ${digest}`), null, "plain hexadecimal digest beside 'ph'");
  assert.equal(textViolation(`Stephens ${digest.replace(/[0-9]/g, (d) => String.fromCharCode(103 + Number(d)))}`), null, "letter-encoded digest (election family)");
  assert.equal(textViolation(`Stephens ${digest} 021 234 5678`), "phone_like_value", "a number beside the digest is still refused");
  assert.equal(textViolation(`Stephens x${digest}`), "phone_like_value", "a digest glued to a letter is not a whole token, so it gets no exemption");
});

// Registry ----------------------------------------------------------------------------------------------------------------------

test("registry: the committed file is exactly the merge of the core sources and the three family fragments", async () => {
  const { text, committed: onDisk, problems } = await buildRegistry();
  assert.deepEqual(problems, []);
  assert.equal(text, onDisk, "run `node src/loaders/registry_build.ts --write`");
  const again = mergeRegistry(JSON.parse(text) as SourcesFile);
  assert.deepEqual(again.file, JSON.parse(text), "merging a merged file changes nothing");
});

test("registry: every id is unique, every family source is owned once, and nothing core was redefined", () => {
  const { file, problems } = mergeRegistry(committed);
  assert.deepEqual(problems, []);
  assert.equal(new Set(file.sources.map((s) => s.source_id)).size, file.sources.length);
  assert.equal(new Set(file.schedules.map((s) => s.schedule_key)).size, file.schedules.length);
  assert.equal(new Set(file.registry_products.map((p) => p.registry_key)).size, file.registry_products.length);
  const core = coreOf(committed);
  assert.deepEqual(core.sources.map((s) => s.source_id).sort(), [
    "baseline_2023_candidacies_export", "ec_2023_official_results", "ec_2026_nominations", "ec_party_finance_returns", "ec_register_of_political_parties",
    "nz_government_releases_feed", "nz_parliament_current_bills", "nz_parliament_mp_directory", "nz_parliament_written_questions",
  ]);
  assert.equal(fragments().reduce((sum, f) => sum + f.sources.length, 0) + core.sources.length, file.sources.length);
});

test("registry: a clash is refused, not resolved", () => {
  const parts = fragments();
  const stats = parts.find((f) => f.family === "statistics")!;
  const election = parts.find((f) => f.family === "election")!;
  // Two families claim one source id.
  const twoOwners: Fragment[] = [...parts, { family: "parliament", sources: [{ ...stats.sources[0] }], products: [], schedules: [] }];
  assert.ok(mergeRegistry(committed, twoOwners).problems.some((p) => /is defined by both statistics and parliament/.test(p)));
  // A core file cannot smuggle in a family-owned id: the fragment's definition is the only one that survives.
  const smuggled: SourcesFile = { ...committed, sources: [...committed.sources, { ...committed.sources[0], source_id: "stats_msd_benefits", title: "not the real one" }] };
  assert.deepEqual(mergeRegistry(smuggled).file.sources.filter((s) => s.source_id === "stats_msd_benefits").map((s) => s.title), [stats.sources.find((s) => s.source_id === "stats_msd_benefits")!.title]);
  // One schedule key, two owners.
  const twoSchedules: Fragment[] = [...parts, { family: "statistics", sources: [], products: [], schedules: [{ ...election.schedules[0] }] }];
  assert.ok(mergeRegistry(committed, twoSchedules).problems.some((p) => /schedule .* is defined by both/.test(p)));
  // One registry product, two different definitions.
  const twoProducts: Fragment[] = [...parts, { family: "parliament", sources: [], products: [{ registry_key: "statistics", title: "Something else", domain: "Statistics" }], schedules: [] }];
  assert.ok(mergeRegistry(committed, twoProducts).problems.some((p) => /statistics is defined twice with different facts/.test(p)));
  // A schedule on a source whose adapter never runs inside the function.
  const cliOnly = stats.sources.find((s) => s.adapter_name === "stats_family_fetch")!;
  const scheduled: Fragment[] = [...parts, { family: "statistics", sources: [], products: [], schedules: [{ schedule_key: "stats-bad", source_id: cliOnly.source_id, cron_expr: "1 * * * *", function_slug: "ingest-run", max_runtime_seconds: 60, max_records: 10 }] }];
  assert.ok(mergeRegistry(committed, scheduled).problems.some((p) => /never runs inside the Edge Function/.test(p)));
});

test("registry: every live source has a real adapter; statistics fetch sources are CLI-only and can never be scheduled", () => {
  const { file } = mergeRegistry(committed);
  for (const source of file.sources.filter((s) => s.adapter_kind === "live_fetch")) {
    assert.ok(LIVE_ADAPTERS[source.adapter_name] || CLI_ONLY_ADAPTERS.has(source.adapter_name), source.source_id);
  }
  for (const schedule of file.schedules) {
    const source = file.sources.find((s) => s.source_id === schedule.source_id)!;
    assert.ok(LIVE_ADAPTERS[source.adapter_name], `${schedule.schedule_key}: a scheduled source needs its adapter inside the function bundle`);
  }
});

test("rights: every source sits under a rights row of the register that lists its product, or a written exception", () => {
  const { file } = mergeRegistry(committed);
  assert.deepEqual(rightsProblems(file, register), []);
  for (const exception of RIGHTS_EXCEPTIONS) assert.ok(exception.reason.length > 60, "an exception states its reason");
  // A wrong row is caught.
  const wrong = structuredClone(file);
  wrong.sources.find((s) => s.source_id === "stats_msd_benefits")!.rights_id = "RIGHTS-05";
  assert.ok(rightsProblems(wrong, register).some((p) => /stats_msd_benefits: claims P12/.test(p)));
  const missing = structuredClone(file);
  missing.sources.find((s) => s.source_id === "stats_msd_benefits")!.rights_id = "RIGHTS-99";
  assert.ok(rightsProblems(missing, register).some((p) => /RIGHTS-99 is not in the register/.test(p)));
  // Loading data changes nothing about rights: every row is still pending and link-only.
  for (const row of register) assert.deepEqual([row.review_status, row.default_release], ["pending", "link-only"], row.rights_id);
  const approved = structuredClone(file);
  approved.sources[0].access_note = "rights approved by the publisher";
  assert.ok(rightsProblems(approved, register).some((p) => /presents a pending rights question as answered/.test(p)));
});

test("rights: the 2013 Census history has its own pending row, not the 2018 Census row", () => {
  const { file } = mergeRegistry(committed);
  const history = file.sources.find((s) => s.source_id === "stats_nz_census_2013_meshblock")!;
  assert.equal(history.rights_id, "RIGHTS-22");
  assert.deepEqual(history.catalogue_products, [], "it answers no product of the 24-product catalogue");
  assert.equal(register.find((r) => r.rights_id === "RIGHTS-22")!.review_status, "pending");
});

// Route coverage ------------------------------------------------------------------------------------------------------------------

test("coverage: all 24 catalogue products have an explicit backfill route and a truthful refresh state", () => {
  const { file } = mergeRegistry(committed);
  assert.equal(catalogue.length, 24);
  const coverage = productCoverage(file, catalogue);
  assert.deepEqual(coverage.map((c) => c.product_id), catalogue.map((c) => c.product_id));
  for (const product of coverage) {
    assert.ok(product.backfill.length >= 1, `${product.product_id}: a backfill route`);
    assert.ok(product.has_working_refresh || product.refresh_gap, `${product.product_id}: a working refresh route or the stated reason there is none`);
    if (product.has_working_refresh) assert.equal(REFRESH_GAPS[product.product_id], undefined, `${product.product_id}: a gap is not claimed beside a working route`);
    for (const route of [...product.backfill, ...product.refresh, ...product.probes]) assert.ok(route.evidence.length > 20, `${route.source_id}: evidence`);
  }
  assert.deepEqual(coverage.filter((c) => !c.has_working_refresh).map((c) => c.product_id), Object.keys(REFRESH_GAPS).sort());
});

test("coverage: every registry source states its route, no state is claimed for a source that does not exist", () => {
  const { file } = mergeRegistry(committed);
  assert.deepEqual(Object.keys(SOURCE_ROUTES).sort(), file.sources.map((s) => s.source_id).sort());
  for (const source of file.sources) {
    const route = SOURCE_ROUTES[source.source_id];
    if (source.adapter_kind === "export_import") assert.equal(route.kind, "backfill", source.source_id);
    if (source.adapter_name === "availability_probe") assert.equal(route.kind, "probe", source.source_id);
    // A blocked or pending route is never schedule-enabled, and a working scheduled route is never marked blocked.
    if (route.state === "blocked_publisher_challenge" || route.state === "disabled_pending_person" || route.state === "blocked_off_allowlist") assert.equal(source.enabled, false, source.source_id);
    if (source.enabled) assert.ok(["working", "exercised_not_run_in_full"].includes(route.state), source.source_id);
  }
  for (const sourceId of Object.keys(STATS_REFRESH)) assert.equal(file.sources.find((s) => s.source_id === sourceId)?.adapter_name, "stats_family_fetch");
});

test("coverage: what 2026 does not publish stays unknown, never zero and never a loaded product", () => {
  const { file } = mergeRegistry(committed);
  assert.ok(UNPUBLISHED_2026.some((line) => /nominations/.test(line) && /unknown/.test(line)));
  const nominations = file.sources.find((s) => s.source_id === "ec_2026_nominations")!;
  assert.equal(nominations.enabled, false);
  assert.equal(SOURCE_ROUTES.ec_2026_nominations.kind, "probe");
  assert.deepEqual(nominations.catalogue_products ?? [], []);
  const status = file.sources.find((s) => s.source_id === "election_2026_official_page_status_export")!;
  assert.match(status.export_contract!.expectedRowsNote, /not a nominations list/);
});

// Targets and the contract ---------------------------------------------------------------------------------------------------------

test("targets: all, a family, a product, a unit and a source id resolve to units, each once, in registry order", async () => {
  const { families, problems } = await loaders();
  assert.deepEqual(problems, []);
  const all = resolveTargets(families, ["all"]);
  assert.equal(all.length, 9 + 9 + 11 + 10);
  assert.deepEqual([...new Set(all.map((u) => u.family.family))], ["core", "election", "parliament", "statistics"]);
  assert.deepEqual(resolveTargets(families, ["statistics"]).length, 10);
  assert.deepEqual(resolveTargets(families, ["P10"]).map((u) => u.unit.unit), ["nz_parliament_mp_directory", "parliament_export_member_terms", "parliament_export_minister_roles"]);
  assert.deepEqual(resolveTargets(families, ["P22"]).map((u) => u.unit.unit), ["stats_nz_selected_series", "stats_nz_release_series"]);
  assert.deepEqual(resolveTargets(families, ["P09", "P09", "election"]).length, 10, "a unit named twice runs once (the nine election units and the core probe that claims P09)");
  assert.deepEqual(resolveTargets(families, ["nz_parliament_written_questions_recent"]).map((u) => u.unit.unit), ["parliament_export_written_questions"]);
  // The deliberate whole-Parliament walk names its unit too, but is never part of a plain refresh.
  const [questions] = resolveTargets(families, ["nz_parliament_written_questions_backfill"]);
  assert.equal(questions.unit.unit, "parliament_export_written_questions");
  assert.ok(!questions.unit.refresh_source_ids.includes("nz_parliament_written_questions_backfill"));
  assert.throws(() => resolveTargets(families, ["P99"]), (e: unknown) => e instanceof LoaderError && e.code === "target_unknown");
  // Every one of the 24 products is reachable by its id.
  for (const product of catalogue) assert.ok(resolveTargets(families, [product.product_id]).length >= 1, product.product_id);
});

test("contract: statistics keeps its typed bulk writer; the ledger families keep theirs", async () => {
  const { families } = await loaders();
  assert.deepEqual(families.map((f) => [f.family, f.writer]), [
    ["core", "ledger_records_with_projection"], ["election", "ledger_records_with_projection"],
    ["parliament", "ledger_records_with_projection"], ["statistics", "typed_statistics_bulk_writer"],
  ]);
  const stats = await readFile(new URL("../src/loaders/families/stats.ts", import.meta.url), "utf-8");
  assert.ok(!/runner\.ts|ingestBatch|IngestRecord|safe_payload/.test(stats), "the statistics adapter never goes through the generic record path");
  assert.match(stats, /loadSource\(/, "and delegates to the family's own typed loader");
  for (const name of ["election", "parliament", "core"]) {
    const text = await readFile(new URL(`../src/loaders/families/${name}.ts`, import.meta.url), "utf-8");
    assert.ok(/importProducts|importFamilyExport|exportAdapter/.test(text), `${name}: wraps the family's real importer`);
  }
});

test("contract: statuses, error codes and exit codes are closed and consistent", () => {
  assert.deepEqual([...LOADER_COMMANDS], ["plan", "validate", "dry-run", "import", "refresh", "reconcile"]);
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  const expected: [LoaderStatus, number][] = [
    ["planned", EXIT.ok], ["valid", EXIT.ok], ["dry_run", EXIT.ok], ["succeeded", EXIT.ok], ["reconciled", EXIT.ok], ["refused_input", EXIT.input_refused],
    ["not_reconciled", EXIT.not_reconciled], ["blocked", EXIT.blocked], ["failed", EXIT.run_failed], ["partial", EXIT.run_failed], ["skipped_lease_held", EXIT.run_failed],
  ];
  for (const [status, code] of expected) assert.equal(exitCodeFor(status), code, status);
});

const fakeFamily = { family: "core", writer: "ledger_records_with_projection" } as LoaderFamily;
const fakeUnit: LoaderUnit = { unit: "u", family: "core", product_ids: [], backfill_source_ids: ["u"], refresh_source_ids: [] };

test("contract: a run succeeds only when every count check passes and nothing was rejected or in conflict", () => {
  const fresh = () => newReceipt(fakeFamily, fakeUnit, "import", "a", "1");
  const ok = fresh();
  check(ok, "rows", 3, 3);
  assert.equal(settle(ok, "succeeded").status, "succeeded");
  const short = fresh();
  check(short, "rows", 3, 2);
  assert.deepEqual([settle(short, "succeeded").status, short.error_code], ["not_reconciled", "not_reconciled"]);
  const unknown = fresh();
  check(unknown, "rows", 3, null);
  assert.equal(settle(unknown, "succeeded").status, "not_reconciled", "a count that could not be read is not a pass");
  const rejected = fresh();
  rejected.counts.written.rejected = 1;
  assert.deepEqual([settle(rejected, "succeeded").status, rejected.error_code], ["not_reconciled", "ledger_rejected_rows"]);
  const conflict = fresh();
  conflict.counts.written.conflicts = 2;
  assert.deepEqual([settle(conflict, "succeeded").status, conflict.error_code], ["not_reconciled", "value_conflict"]);
});

test("contract: a thrown error becomes a receipt with a closed code, and never carries a location or a connection string", async () => {
  const broken = {
    ...fakeFamily,
    plan: async () => { throw new LoaderError("input_location_not_private", "x"); },
    validate: async () => { throw new Error("cannot open /srv/someone/private/file.jsonl via postgres://u:p@h/db"); },
  } as unknown as LoaderFamily;
  const ctx = { env: {}, log: () => undefined };
  const refused = await runCommand("plan", broken, fakeUnit, ctx, false);
  assert.deepEqual([refused.status, refused.error_code], ["refused_input", "input_location_not_private"]);
  const unexpected = await runCommand("validate", broken, fakeUnit, ctx, false);
  assert.deepEqual([unexpected.status, unexpected.error_code], ["failed", "unexpected"]);
  assert.ok(!/someone|u:p@/.test(unexpected.error_detail ?? ""), unexpected.error_detail ?? "");
  assert.deepEqual(receiptViolations(unexpected), []);
});

// Privacy and source access ---------------------------------------------------------------------------------------------------------

test("privacy: a private input inside the repository, or readable by others, is refused before it is read", async () => {
  assert.equal(insideRepository(join(REPOSITORY_ROOT, "ingest/test/fixtures/x.jsonl")), true);
  assert.equal(insideRepository(resolve(REPOSITORY_ROOT, "..", "elsewhere")), false);
  await assert.rejects(assertPrivateInput(join(REPOSITORY_ROOT, "ingest/package.json"), "fixture"), (e: unknown) => e instanceof LoaderError && e.code === "input_location_not_private");
  const dir = await mkdtemp(join(tmpdir(), "loader-privacy-"));
  try {
    const open = join(dir, "open");
    await mkdir(open, { mode: 0o755 });
    await chmod(open, 0o755);
    await writeFile(join(open, "rows.jsonl"), "{}\n", { mode: 0o644 });
    await chmod(join(open, "rows.jsonl"), 0o644);
    await assert.rejects(assertPrivateInput(join(open, "rows.jsonl"), "fixture"), (e: unknown) => e instanceof LoaderError && e.code === "input_location_not_private" && !e.message.includes(dir));
    assert.equal((await assertPrivateInput(join(open, "rows.jsonl"), "fixture", "advise")).length, 2, "advise mode records both findings instead");
    const closed = join(dir, "closed");
    await mkdir(closed, { mode: 0o700 });
    await chmod(closed, 0o700);
    await writeFile(join(closed, "rows.jsonl"), "{}\n", { mode: 0o600 });
    await chmod(join(closed, "rows.jsonl"), 0o600);
    assert.deepEqual(await assertPrivateInput(join(closed, "rows.jsonl"), "fixture"), []);
    assert.deepEqual(await assertPrivateInput(closed, "fixture"), []);
    await assert.rejects(assertPrivateInput(join(closed, "absent.jsonl"), "fixture"), (e: unknown) => e instanceof LoaderError && e.code === "input_missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("source access: a probe, a challenged route and a pending decision are never contacted; a CLI-only route is", () => {
  const { file } = mergeRegistry(committed);
  const access = (id: string) => refreshAccess(file.sources.find((s) => s.source_id === id)!);
  assert.deepEqual([access("ec_2026_nominations").allowed, access("ec_2026_nominations").code], [false, "route_blocked"]);
  assert.deepEqual([access("nz_government_releases_listing").allowed, access("nz_government_releases_listing").code], [false, "route_blocked"]);
  assert.deepEqual([access("nz_parliament_bill_publications").allowed, access("nz_parliament_bill_publications").code], [false, "route_pending_decision"]);
  assert.equal(access("nz_parliament_written_questions_backfill").allowed, true, "disabled for scheduling only: it runs deliberately from the CLI");
  assert.equal(access("nz_parliament_committee_reports").allowed, true);
  const reports = file.sources.find((s) => s.source_id === "nz_parliament_committee_reports")!;
  assert.equal(refreshAccess({ ...reports, access_basis: "authenticated" }).allowed, false);
  assert.equal(refreshAccess({ ...reports, access_basis: undefined }).allowed, false, "no stated access basis is not public");
  // The decision comes from a closed value, never from the wording of a note: a blocked source whose note happens to
  // mention the CLI stays blocked, and a disabled source that does not say why is never contacted.
  assert.equal(refreshAccess({ ...reports, enabled: false, disabled_because: "publisher_blocked", blocked_reason: "Challenged. Do not run from the CLI; runs from the CLI only after a person says so." }).allowed, false);
  assert.equal(refreshAccess({ ...reports, enabled: false, disabled_because: undefined, blocked_reason: "Runs from the CLI only." }).allowed, false);
  assert.equal(refreshAccess({ ...reports, enabled: false, disabled_because: "cli_only", blocked_reason: "anything" }).allowed, true);
  // Every disabled live source of the registry states its reason as a closed value (probes record availability and need none).
  for (const source of file.sources.filter((s) => s.adapter_kind === "live_fetch" && !s.enabled && s.adapter_name !== "availability_probe")) assert.ok(source.disabled_because, source.source_id);
  const undeclared = structuredClone(file);
  delete undeclared.sources.find((s) => s.source_id === "nz_government_releases_listing")!.disabled_because;
  assert.ok(mergeRegistry(undeclared, []).problems.some((p) => /must state disabled_because/.test(p)));
});

test("source access: a blocked refresh writes nothing and says blocked, never 'no records'", async () => {
  const { families } = await loaders();
  const [{ family, unit }] = resolveTargets(families, ["ec_2026_nominations"]);
  const receipt = await runCommand("refresh", family, unit, { env: {}, log: () => undefined }, false);
  assert.deepEqual([receipt.status, receipt.error_code, receipt.counts.written.seen, receipt.provenance.run_ids.length], ["blocked", "route_blocked", 0, 0]);
  assert.match(JSON.stringify(receipt.family_detail), /"contacted":false/);
  const [p19] = resolveTargets(families, ["stats_nz_census_2018_highlights"]);
  const none = await runCommand("refresh", p19.family, p19.unit, { env: {}, log: () => undefined }, false);
  assert.deepEqual([none.status, none.error_code], ["blocked", "route_none"]);
  const [feed] = resolveTargets(families, ["nz_government_releases_feed"]);
  const noBackfill = await runCommand("dry-run", feed.family, feed.unit, { env: {}, log: () => undefined }, true);
  assert.deepEqual([noBackfill.status, noBackfill.error_code], ["blocked", "route_none"]);
});

test("outputs: a value that may not leave the process is withheld from a receipt, and the receipt is kept", () => {
  const { value, redacted } = redactReceipt({ unit: "u", counts: { seen: 3 }, fetches: [{ url: "https://publisher.example/list?token=abc123" }, { url: "https://publisher.example/list" }], note: "written by person@example.org" });
  assert.equal(redacted, 2);
  assert.deepEqual(value.counts, { seen: 3 }, "everything else survives");
  assert.match(value.fetches[0].url, /^\[withheld from this receipt: credential_like_value\]$/);
  assert.equal(value.fetches[1].url, "https://publisher.example/list");
  assert.deepEqual(receiptViolations(value), []);
});

test("privacy: a private input inside ANY git checkout is refused, not only inside this worktree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loader-checkout-"));
  try {
    await mkdir(join(dir, "other-checkout", ".git"), { recursive: true });
    await mkdir(join(dir, "other-checkout", "data"), { mode: 0o700 });
    await writeFile(join(dir, "other-checkout", "data", "rows.jsonl"), "{}\n", { mode: 0o600 });
    assert.equal(insideAnyCheckout(join(dir, "other-checkout", "data", "rows.jsonl")), true);
    assert.equal(insideAnyCheckout(dir), false);
    await assert.rejects(assertPrivateInput(join(dir, "other-checkout", "data", "rows.jsonl"), "fixture"), (e: unknown) => e instanceof LoaderError && e.code === "input_location_not_private");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("outputs: a receipt that would carry an email, a disk location or a credential is caught", () => {
  assert.deepEqual(receiptViolations({ a: ["fine", { b: "https://www.parliament.nz/en/pb/" }] }), []);
  assert.equal(receiptViolations({ a: { b: "/srv/someone/export.jsonl" } }).length, 1);
  assert.equal(receiptViolations({ a: "person@example.org" }).length, 1);
  assert.equal(sanitize("failed at postgres://worker:pw@db.internal/x while reading /srv/someone/a.jsonl").includes("pw@"), false);
});

// Retries ----------------------------------------------------------------------------------------------------------------------------

test("retries: a refresh contacts publishers, so it runs once per call and its budget is never multiplied", async () => {
  let refreshes = 0;
  let imports = 0;
  const counting = {
    ...fakeFamily,
    refresh: async () => { refreshes++; return { ...newReceipt(fakeFamily, fakeUnit, "refresh", "a", "1"), status: "partial" as LoaderStatus }; },
    import: async () => { imports++; return { ...newReceipt(fakeFamily, fakeUnit, "import", "a", "1"), status: imports < 2 ? "partial" as LoaderStatus : "succeeded" as LoaderStatus }; },
  } as unknown as LoaderFamily;
  const ctx = { env: {}, log: () => undefined };
  const refreshed = await runCommand("refresh", counting, fakeUnit, ctx, false);
  assert.deepEqual([refreshed.status, refreshes], ["partial", 1], "a partial refresh is returned; the operator's next call resumes it");
});

test("retries: a transient database failure and a budget stop are repeated; a refusal never is", async () => {
  const done = (status: LoaderStatus): TargetReceipt => ({ ...newReceipt(fakeFamily, fakeUnit, "import", "a", "1"), status });
  const sleeps: number[] = [];
  const policy = { maxAttempts: 4, baseDelayMs: 10, sleep: async (ms: number) => { sleeps.push(ms); } };
  let calls = 0;
  const resumed = await withRetry(async () => (++calls < 3 ? done("partial") : done("succeeded")), policy);
  assert.deepEqual([resumed.status, resumed.attempts, sleeps], ["succeeded", 3, [10, 20]]);
  calls = 0;
  const transient = await withRetry(async () => { if (++calls === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); return done("succeeded"); }, policy);
  assert.deepEqual([transient.status, transient.attempts], ["succeeded", 2]);
  calls = 0;
  const refused = await withRetry(async () => { calls++; return done("refused_input"); }, policy);
  assert.deepEqual([refused.status, calls], ["refused_input", 1]);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error("a bug"); }, policy), /a bug/);
  assert.equal(calls, 1, "an error that is not transient is not repeated");
  assert.equal(isTransient({ code: "57P01" }), true);
  assert.equal(isTransient({ code: "23505" }), false);
  calls = 0;
  const gaveUp = await withRetry(async () => { calls++; return done("partial"); }, policy);
  assert.deepEqual([gaveUp.status, calls], ["partial", 4], "a run that keeps stopping at its budget is reported as partial, not as done");
});
