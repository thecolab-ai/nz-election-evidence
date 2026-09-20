// The one loader contract: registry merge, rights per actual source, route coverage of the 24 products, target
// resolution, shared privacy and source-access rules, retries, statuses and exit codes. Offline: no database, no network.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CLI_ONLY_ADAPTERS, LIVE_ADAPTERS } from "../../supabase/functions/_shared/adapters/index.ts";
import { textViolation } from "../../supabase/functions/_shared/text_guard.ts";
import type { SourcesFile } from "../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { loaders, resolveTargets, runCommand, selectUnits, sourceRevision } from "../src/cli.ts";
import { assertPrivateInput, insideAnyCheckout, insideRepository, receiptViolations, redactReceipt, refreshAccess, REPOSITORY_ROOT, sanitize } from "../src/loaders/access.ts";
import {
  check, emptyProvenance, ERROR_CODES, EXIT, exitCodeFor, LOADER_COMMANDS, LoaderError, type LoaderFamily, type LoaderStatus, type LoaderUnit, newReceipt, settle, type TargetReceipt, writtenProblems,
} from "../src/loaders/contract.ts";
import { grantedState, type ManifestEvidence, MANIFEST_PATH, productCoverage, REFRESH_GAPS, SOURCE_ROUTES, STATS_REFRESH, UNPUBLISHED_2026 } from "../src/loaders/coverage.ts";
import { coreOf, type Fragment, fragments, mergeRegistry, RIGHTS_EXCEPTIONS, rightsProblems, type RightsRow } from "../src/loaders/registry.ts";
import { buildRegistry } from "../src/loaders/registry_build.ts";
import { statWritten } from "../src/loaders/families/stats.ts";
import { buildManifest } from "../src/loaders/manifest_build.ts";
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

test("coverage: 'loaded and reconciled' is granted by the committed manifest only, never asserted by the code", async () => {
  const { file } = mergeRegistry(committed);
  const backfillIds = file.sources.filter((s) => SOURCE_ROUTES[s.source_id].kind === "backfill").map((s) => s.source_id);
  // Without a manifest nothing is claimed about any load.
  const bare = productCoverage(file, catalogue, null);
  assert.ok(bare.every((p) => !p.has_loaded_backfill && p.backfill.every((r) => r.state === "built_not_proven")));
  // A manifest grants the state to exactly the units it shows imported, replayed without an insert, and reconciled.
  const w = (inserted: number) => ({ ledger_records: { inserted } });
  const unit = (id: string, importStatus: string, replayInserted: number | null, reconcile: string | null) => ({ source_ids: [id], import: { status: importStatus }, replay: replayInserted === null ? null : { status: "succeeded", written: w(replayInserted) }, reconcile: reconcile ? { status: reconcile } : null });
  const [good, replayWrote, notReconciled, noReplay, failed] = backfillIds;
  const evidence: ManifestEvidence = { tested_source: { commit: "c".repeat(40) }, units: [unit(good, "succeeded", 0, "reconciled"), unit(replayWrote, "succeeded", 2, "reconciled"), unit(notReconciled, "succeeded", 0, "not_reconciled"), unit(noReplay, "succeeded", null, "reconciled"), unit(failed, "failed", 0, "reconciled")] };
  assert.equal(grantedState(good, SOURCE_ROUTES[good], evidence).state, "loaded_and_reconciled");
  assert.match(grantedState(good, SOURCE_ROUTES[good], evidence).evidence, /tested source commit c{40}/);
  for (const id of [replayWrote, notReconciled, noReplay, failed, backfillIds[5]]) assert.equal(grantedState(id, SOURCE_ROUTES[id], evidence).state, "built_not_proven", id);
  // The committed manifest, when there is one, must be about THIS source: no file of the loaders, the functions or the
  // migrations may have changed since the commit it tested. (Skipped where there is no manifest or no git history.)
  const manifestText = await readFile(resolve(REPOSITORY_ROOT, MANIFEST_PATH), "utf-8").catch(() => null);
  if (manifestText) {
    const manifest = JSON.parse(manifestText) as ManifestEvidence;
    const tested = manifest.tested_source?.commit ?? "";
    assert.match(tested, /^[0-9a-f]{40}$/, "the manifest names the commit it tested");
    const changed = await new Promise<string | null>((done) => execFile("git", ["-C", REPOSITORY_ROOT, "diff", "--name-only", tested, "HEAD", "--", "ingest/src", "supabase/migrations", "supabase/functions", "ingest/package.json", "ingest/package-lock.json"], (error, stdout) => done(error ? null : stdout)));
    if (changed !== null) assert.deepEqual(changed.split("\n").filter(Boolean), [], "source changed after the commit the manifest tested: the proof must be re-run, not carried over");
  }
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

test("targets: a named source id is an exact identity: never widened, never exchanged for another source", async () => {
  const { families } = await loaders();
  const RECENT = "nz_parliament_written_questions_recent";
  const WALK = "nz_parliament_written_questions_backfill";
  const UNIT = "parliament_export_written_questions";
  const sources = (targets: string[], backfill = false) => selectUnits(families, targets, "refresh", { backfill }).map((u) => [u.unit.unit, u.unit.refresh_source_ids]);
  const usage = (run: () => unknown, pattern: RegExp) => assert.throws(run, (e: unknown) => e instanceof LoaderError && e.code === "usage" && pattern.test(e.message));

  // The defect: the walk's own id used to resolve to its unit and then run the RECENT source. It now runs the walk.
  assert.deepEqual(sources([WALK]), [[UNIT, [WALK]]]);
  assert.deepEqual(sources([WALK], true), [[UNIT, [WALK]]], "with the flag as well: same identity");
  assert.deepEqual(sources([RECENT]), [[UNIT, [RECENT]]]);
  assert.deepEqual(sources([UNIT]), [[UNIT, [RECENT]]], "a unit name is a plain refresh");
  assert.deepEqual(sources([UNIT], true), [[UNIT, [WALK]]], "a unit name with --backfill is the walk");
  assert.deepEqual(sources([RECENT, WALK]), [[UNIT, [RECENT, WALK]]], "both named: both run, nothing else");
  usage(() => sources([RECENT], true), /contradicts the source that was named/);
  usage(() => sources(["parliament_export_committee_reports"], true), /no whole-history walk/);
  usage(() => sources(["statistics"], true), /no unit of statistics has a whole-history walk/);
  assert.deepEqual(sources(["parliament"], true), [[UNIT, [WALK]]], "through a family the flag selects only the units that have a walk");
  assert.deepEqual(sources(["P24"]).find(([unit]) => unit === UNIT), [UNIT, [RECENT]], "a product is a plain refresh of its units");

  // One source of a unit with several refresh sources stays one source.
  const multi = families.flatMap((f) => f.units()).find((u) => u.refresh_source_ids.length > 1);
  if (multi) assert.deepEqual(sources([multi.refresh_source_ids[1]]), [[multi.unit, [multi.refresh_source_ids[1]]]]);

  // A refresh-only id is not a backfill input: the other commands refuse it instead of importing the unit's export.
  for (const command of ["import", "reconcile", "plan", "validate", "dry-run"] as const) {
    usage(() => selectUnits(families, [WALK], command, { backfill: false }), /is a refresh source/);
    usage(() => selectUnits(families, [RECENT], command, { backfill: false }), /is a refresh source/);
    assert.deepEqual(selectUnits(families, [UNIT], command, { backfill: false }).map((u) => u.unit.unit), [UNIT]);
  }
  assert.deepEqual(selectUnits(families, ["baseline_2023_candidacies_export"], "import", { backfill: true }).map((u) => u.unit.unit), ["baseline_2023_candidacies_export"], "the runbook's older spelling still works");
  usage(() => selectUnits(families, [UNIT], "reconcile", { backfill: true }), /--backfill belongs to refresh/);

  // The receipt names what ran, and the run mode follows the source, not the flag.
  // (No command is run here: a refresh, dry or not, contacts the publisher. The receipt is built the way the CLI builds it.)
  const [{ family, unit }] = selectUnits(families, [WALK], "refresh", { backfill: false });
  assert.deepEqual(newReceipt(family, unit, "refresh", "live_fetch", "per source").source_ids, [WALK]);
  const ledger = await readFile(new URL("../src/loaders/ledger.ts", import.meta.url), "utf-8");
  assert.ok(!/ctx\.backfill/.test(ledger), "the shared refresh never re-decides the source or the mode from a flag");
  const parliament = await readFile(new URL("../src/loaders/families/parliament.ts", import.meta.url), "utf-8");
  assert.ok(!/ctx\.backfill/.test(parliament));
});

test("counts: one block per population, never added across; inserted never exceeds seen", async () => {
  const receipt = (family: string, unit: string, written: TargetReceipt["counts"]["written"], by: TargetReceipt["counts"]["input"]["by_population"]): TargetReceipt => {
    const r = newReceipt(fakeFamily, { unit, family: "core", product_ids: [], backfill_source_ids: [unit], refresh_source_ids: [] }, "import", "a", "1");
    return { ...r, family: family as TargetReceipt["family"], status: "succeeded", counts: { ...r.counts, written, input: { rows: null, records: null, versions: null, by_population: by } } };
  };
  const w = (seen: number, inserted: number, unchanged: number, conflicts = 0) => ({ seen, inserted, unchanged, rejected: 0, conflicts, tombstoned: 0 });
  assert.deepEqual(writtenProblems("p", w(44, 44, 0)), []);
  assert.match(writtenProblems("p", w(44, 93, 0)).join("|"), /inserted \(93\) > seen \(44\)/, "the old mixed receipt is now a named fault");
  assert.match(writtenProblems("p", w(10, 4, 4)).join("|"), /<> seen/);
  assert.match(writtenProblems("p", { ...w(1, 1, 0), tombstoned: -1 }).join("|"), /tombstoned/);

  const broken = receipt("statistics", "u", { stat_observations: w(44, 93, 0) }, {});
  assert.deepEqual([settle(broken, "succeeded").status, broken.error_code], ["not_reconciled", "not_reconciled"]);
  assert.match(broken.error_detail ?? "", /count invariants/);

  // Union aggregation: a statistics unit with both populations, one of catalogue metadata only, and a ledger unit.
  const dir = await mkdtemp(join(tmpdir(), "manifest-"));
  await mkdir(join(dir, "import"));
  await mkdir(join(dir, "replay"));
  const first = [
    receipt("statistics", "both", { stat_observations: w(44, 44, 0), stat_catalogue_entries: w(49, 49, 0) }, { stat_observations: 44, stat_catalogue_entries: 49 }),
    receipt("statistics", "metadata_only", { stat_catalogue_entries: w(128, 128, 0) }, { stat_catalogue_entries: 128 }),
    receipt("parliament", "ledger", { ledger_records: w(10, 7, 3) }, { ledger_records: 9 }),
  ];
  const again = [
    receipt("statistics", "both", { stat_observations: w(44, 0, 44), stat_catalogue_entries: w(49, 0, 49) }, {}),
    receipt("statistics", "metadata_only", { stat_catalogue_entries: w(128, 0, 128) }, {}),
    receipt("parliament", "ledger", { ledger_records: w(10, 0, 10) }, {}),
  ];
  for (const r of first) await writeFile(join(dir, "import", `import-${r.family}-${r.unit}.json`), JSON.stringify(r));
  for (const r of again) await writeFile(join(dir, "replay", `import-${r.family}-${r.unit}.json`), JSON.stringify(r));
  const manifest = await buildManifest(dir, "2026-01-01") as { totals: { first_pass: { [p: string]: { seen: number; inserted: number } }; replay: { [p: string]: { inserted: number; unchanged: number } } & { units_that_inserted_anything: string[] }; input_by_population: { [p: string]: number }; count_invariants: { violations: string[] } }; units: { unit: string; import: { written: { [p: string]: unknown } } }[] };
  assert.deepEqual(manifest.totals.first_pass, { ledger_records: w(10, 7, 3), stat_observations: w(44, 44, 0), stat_catalogue_entries: w(177, 177, 0) });
  assert.deepEqual(manifest.totals.input_by_population, { ledger_records: 9, stat_observations: 44, stat_catalogue_entries: 177 });
  assert.deepEqual([manifest.totals.replay.stat_observations.inserted, manifest.totals.replay.stat_observations.unchanged, manifest.totals.replay.stat_catalogue_entries.unchanged, manifest.totals.replay.units_that_inserted_anything], [0, 44, 177, []]);
  assert.deepEqual(manifest.totals.count_invariants.violations, []);
  assert.ok(!("seen" in manifest.totals.first_pass), "there is no total across populations");
  assert.deepEqual(Object.keys(manifest.units.find((u) => u.unit === "metadata_only")!.import.written), ["stat_catalogue_entries"], "a metadata-only unit has no observation block");
  for (const [population, block] of Object.entries(manifest.totals.first_pass)) assert.ok(block.inserted <= block.seen, population);

  // A receipt that breaks the rule is named by the manifest, and a receipt of another commit refuses it.
  await writeFile(join(dir, "import", "import-statistics-bad.json"), JSON.stringify({ ...receipt("statistics", "bad", { stat_observations: w(44, 93, 0) }, {}), status: "not_reconciled" }));
  const flagged = await buildManifest(dir, "2026-01-01") as { totals: { count_invariants: { violations: string[] } } };
  assert.equal(flagged.totals.count_invariants.violations.length, 2);
  await assert.rejects(buildManifest(dir, "2026-01-01", undefined, "a".repeat(40)), /not all produced by a clean checkout/);
});

test("counts: statistics first load, replay, refresh and metadata-only units each obey the invariants per population", () => {
  const totals = (o: [number, number, number, number], meta: { [key: string]: number }) => ({ observations: { seen: o[0], inserted: o[1], unchanged: o[2], conflicts: o[3] }, meta, batches: 1 });
  const holds = (written: ReturnType<typeof statWritten>) => Object.entries(written).flatMap(([population, w]) => writtenProblems(population, w));

  // First load of a source with both populations (the shape that used to print seen=44, inserted=93).
  const first = statWritten({ observations: 44, catalogue_entries: 49 }, totals([44, 44, 0, 0], { series_inserted: 44, geographies_inserted: 20, catalogue_entries_seen: 49, catalogue_entries_inserted: 49, catalogue_entries_unchanged: 0, catalogue_entries_span_widened: 0 }));
  assert.deepEqual(first, { stat_observations: { seen: 44, inserted: 44, unchanged: 0, rejected: 0, conflicts: 0, tombstoned: 0 }, stat_catalogue_entries: { seen: 49, inserted: 49, unchanged: 0, rejected: 0, conflicts: 0, tombstoned: 0 } });
  assert.deepEqual(holds(first), []);
  // Series and geographies are definitions, not rows of either population: they never leak into a block.
  assert.ok(Object.values(first).every((w) => w.inserted <= w.seen));

  // Replay: everything unchanged, in both populations.
  const replay = statWritten({ observations: 44, catalogue_entries: 49 }, totals([44, 0, 44, 0], { catalogue_entries_seen: 49, catalogue_entries_inserted: 0, catalogue_entries_unchanged: 49, catalogue_entries_span_widened: 0 }));
  assert.deepEqual([replay.stat_observations!.inserted, replay.stat_observations!.unchanged, replay.stat_catalogue_entries!.inserted, replay.stat_catalogue_entries!.unchanged], [0, 44, 0, 49]);
  assert.deepEqual(holds(replay), []);

  // A refresh that sees known versions again: their span widens, which is NOT an insert.
  const refresh = statWritten({ observations: 0, catalogue_entries: 128 }, totals([0, 0, 0, 0], { catalogue_entries_seen: 128, catalogue_entries_inserted: 3, catalogue_entries_unchanged: 125, catalogue_entries_span_widened: 125 }));
  assert.deepEqual(refresh, { stat_catalogue_entries: { seen: 128, inserted: 3, unchanged: 125, rejected: 0, conflicts: 0, tombstoned: 0 } }, "metadata only: no observation block at all");
  assert.deepEqual(holds(refresh), []);

  // Observations only, with a conflict: the conflict is part of the sum and fails the run.
  const conflict = statWritten({ observations: 10, catalogue_entries: 0 }, totals([10, 7, 2, 1], {}));
  assert.deepEqual(Object.keys(conflict), ["stat_observations"]);
  assert.deepEqual(holds(conflict), []);
});

test("provenance: every receipt pins the commit of the checkout that produced it", async () => {
  const revision = await sourceRevision();
  // In a git checkout: the full commit and whether tracked files differ from it. In a plain copy of the files: unknown,
  // stated as null. Either way nothing is invented, and the manifest builder refuses a receipt whose commit is unknown.
  if (revision.commit === null) assert.equal(revision.dirty, null, "no commit, so no claim about cleanliness either");
  else {
    assert.match(revision.commit, /^[0-9a-f]{40}$/);
    assert.equal(typeof revision.dirty, "boolean");
  }
  assert.deepEqual(emptyProvenance("a", "1").source_revision, { commit: null, dirty: null }, "unknown until the CLI pins it; never guessed");
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
  rejected.counts.written.ledger_records = { seen: 1, inserted: 0, unchanged: 0, rejected: 1, conflicts: 0, tombstoned: 0 };
  assert.deepEqual([settle(rejected, "succeeded").status, rejected.error_code], ["not_reconciled", "ledger_rejected_rows"]);
  const conflict = fresh();
  conflict.counts.written.stat_observations = { seen: 2, inserted: 0, unchanged: 0, rejected: 0, conflicts: 2, tombstoned: 0 };
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
  assert.deepEqual([receipt.status, receipt.error_code, receipt.counts.written, receipt.provenance.run_ids.length], ["blocked", "route_blocked", {}, 0]);
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
