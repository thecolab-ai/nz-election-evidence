// 2023 candidacy export compatibility. The fixture is synthetic but has exactly the upstream shape:
// party_list / official_*_candidate enums, a non-nullable vote column with collector-default zeros on
// list rows, genuine source-reported zeros, and one number the captured passage does not evidence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateSourcesFile } from "../../supabase/functions/_shared/registry.ts";
import { type ExportContract, IngestError, type SourcesFile } from "../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { loadExport, preflightExport, projectExportRow } from "../src/export_import.ts";

const file = sourcesFile as unknown as SourcesFile;
const source = file.sources.find((s) => s.source_id === "baseline_2023_candidacies_export")!;
const real = source.export_contract!;
const fixturePath = new URL("./fixtures/baseline-candidacies.fixture.jsonl", import.meta.url).pathname;

async function fixtureContract(overrides: Partial<ExportContract> = {}, path = fixturePath): Promise<{ contract: ExportContract; env: { [k: string]: string } }> {
  const bytes = await readFile(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const rows = bytes.toString("utf-8").split("\n").filter((l) => l.trim()).length;
  const dir = await mkdtemp(join(tmpdir(), "fixture-manifest-"));
  const manifest = join(dir, "manifest.json");
  await writeFile(manifest, JSON.stringify({ counts: { candidacies: rows }, normalized_checksums: { candidacies: sha }, complete_for_available_sources: true }));
  return { contract: { ...real, expectedInput: { sha256: "sha256:" + sha, rows }, ...overrides }, env: { [real.fileEnv]: path, [real.manifestEnv!]: manifest } };
}

test("the real contract pins the validated product and only it may assert official nomination", () => {
  assert.deepEqual(validateSourcesFile(file), []);
  assert.match(real.expectedInput!.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(real.expectedInput!.rows, 963);
  assert.ok(real.manifestEnv);
  const unpinned = structuredClone(file);
  delete unpinned.sources.find((s) => s.source_id === source.source_id)!.export_contract!.expectedInput;
  assert.ok(validateSourcesFile(unpinned).some((p) => p.includes("officially_nominated") && p.includes("pinned")), "a contract that asserts official nomination must pin its input");
});

test("upstream enums are normalised; the upstream value is kept beside the normalised one", async () => {
  const { contract, env } = await fixtureContract();
  const loaded = await loadExport(contract, env);
  await preflightExport(source, contract, loaded, env);
  const records = await Promise.all(loaded.rows.map((row) => projectExportRow(source, contract, row, "2026-09-20T00:00:00.000Z")));
  const byId = new Map(records.map((r) => [r.external_record_id, r.safe_payload]));
  const list = byId.get("f1c0000000000000000000000000002")!;
  assert.deepEqual([list.candidacy_type, list.upstream_candidacy_type], ["list", "party_list"]);
  assert.deepEqual([list.nomination_status, list.upstream_nomination_status], ["officially_nominated", "official_party_list_candidate"]);
  const electorate = byId.get("f1c0000000000000000000000000001")!;
  assert.deepEqual([electorate.candidacy_type, electorate.nomination_status, electorate.upstream_nomination_status], ["electorate", "officially_nominated", "official_result_candidate"]);
});

test("zero versus missing: a source-reported zero stays zero; a collector default is dropped, never turned into a value", async () => {
  const { contract, env } = await fixtureContract();
  const loaded = await loadExport(contract, env);
  const findings = await preflightExport(source, contract, loaded, env);
  const records = await Promise.all(loaded.rows.map((row) => projectExportRow(source, contract, row, "x")));
  const get = (id: string) => records.find((r) => r.external_record_id.endsWith(id))!;

  assert.equal(get("1").safe_payload.candidate_votes, 1200);
  assert.equal(get("1").safe_payload.candidate_votes_evidence, "number_found_in_captured_source_passage");
  assert.equal(get("3").safe_payload.candidate_votes, 0, "a zero the source page shows is a reported zero");
  assert.equal(get("4").safe_payload.candidate_votes, 0);

  // List candidacy: upstream stores 0 in a column that cannot be null; the source publishes no vote figure.
  assert.ok(!("candidate_votes" in get("2").safe_payload));
  assert.equal(get("2").omitted_fields.find((o) => o.field === "candidate_votes")?.reason, real.evidencedNumbers!.find((e) => e.from === "candidate_votes")!.notApplicableReason);
  assert.equal(get("2").safe_payload.list_rank, 3);
  assert.ok(!("list_rank" in get("1").safe_payload), "electorate rows carry a collector-default rank of 0, which is dropped");

  // A number the captured passage does not show is not invented in either direction.
  assert.ok(!("candidate_votes" in get("5").safe_payload));
  assert.match(get("5").omitted_fields.find((o) => o.field === "candidate_votes")!.reason, /not evidenced/);
  assert.deepEqual(findings.unevidenced_numbers, [{ field: "candidate_votes", rows: 1 }]);
  // Ambiguity is reported, not resolved: every candidate in one contest shows zero.
  assert.deepEqual(findings.all_zero_groups, [{ field: "candidate_votes", group_field: "electorate_name", group: "Fixture Zero Contest", rows: 2 }]);
  assert.deepEqual(findings.rows_by_type, { electorate: 4, list: 1 });
});

test("unknown enums, a wrong election and duplicate ids fail closed before anything is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fixture-bad-"));
  const lines = (await readFile(fixturePath, "utf-8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { [k: string]: unknown });
  const cases: [string, (rows: { [k: string]: unknown }[]) => void, RegExp][] = [
    ["type", (rows) => { rows[0]!.candidacy_type = "write_in"; }, /candidacy_type/],
    ["status", (rows) => { rows[1]!.nomination_status = "rumoured_candidate"; }, /nomination_status/],
    ["already-normalised value is not an upstream value", (rows) => { rows[1]!.nomination_status = "officially_nominated"; }, /nomination_status/],
    ["election", (rows) => { rows[2]!.election_id = "NZGE2020"; }, /election_id/],
    ["selection", (rows) => { rows[0]!.party_selection_status = "inner_circle_pick"; }, /party_selection_status/],
    ["duplicate", (rows) => { rows[1]!.candidacy_id = rows[0]!.candidacy_id; }, /duplicate/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const rows = structuredClone(lines);
    mutate(rows);
    const path = join(dir, `${name.replace(/\W+/g, "-")}.jsonl`);
    await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const { contract, env } = await fixtureContract({}, path);
    const loaded = await loadExport(contract, env);
    await assert.rejects(preflightExport(source, contract, loaded, env), (e: IngestError) => e.errorClass === "input_not_accepted" && pattern.test(e.message), name);
  }
});

test("the input must be the pinned, manifest-verified product", async () => {
  const { contract, env } = await fixtureContract();
  const loaded = await loadExport(contract, env);
  await assert.rejects(preflightExport(source, { ...contract, expectedInput: { sha256: "sha256:" + "0".repeat(64), rows: 5 } }, loaded, env), /does not match the pinned checksum/);
  await assert.rejects(preflightExport(source, { ...contract, expectedInput: { ...contract.expectedInput!, rows: 963 } }, loaded, env), /row count/);
  await assert.rejects(preflightExport(source, contract, loaded, { [real.fileEnv]: fixturePath }), (e: IngestError) => e.errorClass === "missing_input");
  const dir = await mkdtemp(join(tmpdir(), "fixture-manifest-bad-"));
  const bad = join(dir, "manifest.json");
  await writeFile(bad, JSON.stringify({ counts: { candidacies: 5 }, normalized_checksums: { candidacies: "f".repeat(64) } }));
  await assert.rejects(preflightExport(source, contract, loaded, { ...env, [real.manifestEnv!]: bad }), /manifest/);
  // Neither location reaches an error message or a record.
  const err = await preflightExport(source, contract, loaded, { ...env, [real.manifestEnv!]: bad }).catch((e: Error) => e.message);
  assert.ok(!String(err).includes(dir) && !String(err).includes(fixturePath));
});

test("dropped upstream fields never reach a record; the content hash ignores capture time", async () => {
  const { contract, env } = await fixtureContract();
  const loaded = await loadExport(contract, env);
  const records = await Promise.all(loaded.rows.map((row) => projectExportRow(source, contract, row, "x")));
  const text = JSON.stringify(records);
  for (const leaked of ["must be dropped", "TEST FIXTURE value", "fixture alex", "FIXTURE, Alex Fixture Party 1,200", fixturePath]) assert.ok(!text.includes(leaked), leaked);
  const again = await projectExportRow(source, contract, { ...loaded.rows[0]!, captured_at: "2030-01-01 00:00:00.000", snapshot_id: "other" }, "x");
  assert.equal(again.content_hash, records[0]!.content_hash);
});
