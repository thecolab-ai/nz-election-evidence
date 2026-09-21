// Parliament family: payload builders, export contracts, exporter file checks, generation replay and the registry
// fragment. Offline. Every row below is a hand-written fixture of SHAPE with obviously synthetic values; none of it is
// imported data, and nothing here is ever loaded into a database.

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseBillsPage } from "../../supabase/functions/_shared/adapters/bills.ts";
import { canonicalJson } from "../../supabase/functions/_shared/canonical.ts";
import type { BatchResult, IngestDb } from "../../supabase/functions/_shared/db.ts";
import { validateSourcesFile } from "../../supabase/functions/_shared/registry.ts";
import type { IngestRecord, Json, SourcesFile } from "../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { type ExportRow, type FamilyExportContract, PARLIAMENT_EXPORT_CONTRACTS, contractFor } from "../src/families/parliament/contracts.ts";
import { type ExportManifest, assertReadOnlyStatement, inspectExportFile } from "../src/families/parliament/exporter.ts";
import { importFamilyExport, planImport } from "../src/families/parliament/import.ts";
import {
  buildBill, buildBillPublicationSet, buildCommitteeReportFile, buildMemberTerm, buildMinisterRole, buildRelease, buildWrittenQuestion,
  toIngestRecord, witnessText,
} from "../src/families/parliament/payload.ts";
import { PARLIAMENT_EXPORT_SOURCES, mergeIntoRegistry } from "../src/families/parliament/registry_fragment.ts";
import { coreOf } from "../src/loaders/registry.ts";

const QID = "11111111-2222-4333-8444-555555555555";
const OBSERVED = "2026-09-19T01:54:46.231Z";

function questionRow(overrides: ExportRow = {}): ExportRow {
  return {
    upstream_content_hash: "a".repeat(64), observed_at: OBSERVED, id: QID, title: "101 (2026). Example Member to the Minister for Examples",
    question_number: 101, question_year: 2026, parliament_number: 54, document_ref: "WQ_101_2026", question_released_date: "2026-02-03T00:00:00Z",
    last_modified: "2026-02-20T03:04:05.678Z", member_ref: "99999999-2222-4333-8444-555555555555", minister_name: "Hon Example Minister",
    ministerial_title: "Minister for Examples", portfolio_ref: "ABCDEF12-0000-4000-8000-000000000001_1", role_ref: null, status_ref: 2,
    attachment_ref: null, attachment_bytes: 0, question_text_sha256: "b".repeat(64), question_text_chars: 120, reply_text_sha256: null, reply_text_chars: null,
    ...overrides,
  };
}

// Payload builders -------------------------------------------------------------------------------------------------------

test("a written question keeps identifiers, people, official metadata and links, and never the texts", async () => {
  const built = buildWrittenQuestion({
    id: QID, title: "101 (2026). Example Member to the Minister for Examples", questionNumber: 101, questionYear: 2026, parliamentNumber: 54,
    documentRef: "WQ_101_2026", questionReleasedDate: "2026-02-03T00:00:00Z", lastModified: "2026-02-20T03:04:05.678Z", memberId: "m-1",
    ministerName: "Hon Example Minister", ministerialDisplayName: "Minister for Examples", statusId: 2, attachmentSize: 0,
    question: await witnessText("An example question?"), reply: await witnessText("   "),
  });
  const p = built.safe_payload;
  assert.equal(built.external_record_id, QID);
  assert.equal(built.source_url, "https://questions.parliament.nz/written-questions/detail/" + QID);
  assert.equal(p.asker_name_at_source, "Example Member");
  assert.equal(p.reply_present, false);
  assert.equal(p.question_text_chars, 20);
  assert.match(String(p.question_text_sha256), /^[0-9a-f]{64}$/);
  for (const key of Object.keys(p)) assert.doesNotMatch(key, /^(questionText|replyText|question_text|reply_text|body|html)$/);
  assert.ok(!JSON.stringify(p).includes("An example question"));
  // Absent is absent: no reply digest, no attachment size of zero, no role reference.
  for (const key of ["reply_text_sha256", "reply_text_chars", "attachment_bytes", "role_ref", "attachment_ref"]) assert.ok(!(key in p), key);
  assert.deepEqual(built.omitted_fields.map((o) => o.field), ["questionText", "replyText", "attachmentName"]);
});

test("the publisher's date and the collection time never stand in for each other", async () => {
  const record = await toIngestRecord(contractFor("parliament_export_written_questions").toRecord(questionRow()), OBSERVED);
  assert.equal(record.source_published_at, "2026-02-03T00:00:00.000Z");
  assert.equal(record.retrieved_at, OBSERVED);
  assert.equal(record.safe_payload.question_released_on, "2026-02-03");
  assert.ok(!canonicalJson(record.safe_payload as Json).includes("2026-09-19"), "the collection time is not part of the hashed content");
  // A source that states no date gets none: the collection time is not borrowed.
  const undated = await toIngestRecord(contractFor("parliament_export_written_questions").toRecord(questionRow({ question_released_date: null })), OBSERVED);
  assert.equal(undated.source_published_at, undefined);
  assert.ok(!("question_released_on" in undated.safe_payload));
});

test("the asker's name comes only from the publisher's own title pattern, and a contact-like value is masked", () => {
  const odd = buildWrittenQuestion({ id: QID, title: "A title in another shape, write to someone@example.org", question: {}, reply: {} });
  assert.ok(!("asker_name_at_source" in odd.safe_payload));
  assert.equal(odd.safe_payload.title, "A title in another shape, write to [redacted]");
  assert.ok(odd.omitted_fields.some((o) => o.field === "title" && /masked/.test(o.reason)));
});

test("the same bill content gives the same payload on the export route and on the existing live route", () => {
  const id = "180aa081-4729-440b-9f28-08decb3ad1ff";
  const live = parseBillsPage(JSON.stringify({
    totalResults: 1, results: [{ id, title: "Example Amendment Bill", billNumber: "1-1", itemType: "Government", billCurrentStageName: "Select Committee",
      selectCommittee: "Example Committee", parliamentNumber: 54, lastStageDate: "2026-06-30T14:00:00Z", memberName: null, partyName: null }],
  }), "https://bills.parliament.nz/v/6/").items[0];
  const exported = buildBill({ id, title: "Example Amendment Bill", billNumber: "1-1", billType: "Government", currentStage: "Select Committee",
    selectCommittee: "Example Committee", parliamentNumber: 54, lastActivity: "2026-06-30T14:00:00Z", memberName: null, partyLabel: null });
  assert.equal(canonicalJson(exported.safe_payload as Json), canonicalJson(live.payload as Json));
});

test("unknown is not zero: an unread index, an unstated start date and an undated role stay absent", () => {
  const unread = buildBillPublicationSet({ billId: QID, title: "Example Bill", indexUnavailable: true, revisionCount: 0 });
  assert.equal(unread.safe_payload.publication_index_status, "unavailable");
  assert.ok(!("publication_revision_count" in unread.safe_payload));
  assert.equal(buildBillPublicationSet({ billId: QID, revisionCount: 0 }).safe_payload.publication_revision_count, 0);

  const url = "https://catalogue.data.govt.nz/dataset/example/resource/example/download/example.csv";
  const undated = buildMemberTerm({ mandateId: "parliamentary-service:1:tāmaki", personRef: "parliamentary-service:1", personName: "Member, Example",
    representationType: "electorate", electorateName: "Tāmaki", validFrom: "", validTo: "", sourceUrl: url });
  assert.ok(!("valid_from" in undated.safe_payload) && !("valid_to" in undated.safe_payload));
  assert.equal(undated.safe_payload.date_basis, "not_stated_by_source");
  const dated = buildMemberTerm({ mandateId: "parliamentary-service:2:list", personRef: "parliamentary-service:2", representationType: "list",
    electorateName: "ignored for a list member", validFrom: "2023-10-14", sourceUrl: url });
  assert.equal(dated.safe_payload.valid_from, "2023-10-14");
  assert.ok(!("electorate_label" in dated.safe_payload));
  const role = buildMinisterRole({ roleId: "parliamentary-service:2:portfolio:x", roleName: "Minister", portfolioName: "Examples", validFrom: "",
    sourceUrl: "https://www.beehive.govt.nz/minister/hon-example" });
  assert.equal(role.safe_payload.date_basis, "not_stated_by_source");
});

test("a link must be the publisher's own; a stored-copy location can never become one", () => {
  assert.throws(() => buildRelease({ url: "https://mirror.example.org/release/x", title: "Example" }), /official link/);
  assert.throws(() => buildRelease({ url: "https://user:pw@www.beehive.govt.nz/release/x" }), /official link/);
  const file = buildCommitteeReportFile({ attachmentId: QID, downloadUrl: "https://elsewhere.example.org/copy.pdf", text: {} });
  assert.equal(file.source_url, "https://selectcommittees.parliament.nz/download/SelectCommitteeReport/" + QID);
  assert.ok(file.omitted_fields.some((o) => o.field === "final_url"));
});

// Contracts and exporter ---------------------------------------------------------------------------------------------------

test("every recipe is one read-only SELECT, and a withheld text reaches it only as a digest or a length", () => {
  const texts = ["questionText", "replyText", "extracted_text", "text_content", "body_text", "exact_text", "description", "parliament_email", "raw_record_json", "raw_path"];
  for (const contract of PARLIAMENT_EXPORT_CONTRACTS) {
    for (const sql of [contract.recipe.exportSql, contract.recipe.reconcileSql]) assert.doesNotThrow(() => assertReadOnlyStatement(sql), contract.source_id);
    const bare = contract.recipe.exportSql
      .replace(/lower\(hex\(SHA256\(JSONExtractString\(payload_json, '[A-Za-z_]+'\)\)\)\)/g, "DIGEST")
      .replace(/lengthUTF8\(JSONExtractString\(payload_json, '[A-Za-z_]+'\)\)/g, "LENGTH")
      .replace(/match\(JSONExtractString\(payload_json, '[A-Za-z_]+'\), '[^']+'\)/g, "PRESENT");
    for (const name of texts) assert.ok(!new RegExp(`\\b${name}\\b`).test(bare), `${contract.source_id} selects ${name}`);
    assert.match(contract.recipe.exportSql, /ORDER BY .+ FORMAT JSONEachRow$/);
  }
  assert.throws(() => assertReadOnlyStatement("SELECT 1; DROP TABLE x"));
  assert.throws(() => assertReadOnlyStatement("INSERT INTO x SELECT 1"));
  assert.throws(() => assertReadOnlyStatement("SELECT 1 INTO OUTFILE 'x'"));
});

test("every contract is pinned to a verified export and names its files only through the environment", () => {
  const owned = new Set<string>();
  for (const contract of PARLIAMENT_EXPORT_CONTRACTS) {
    assert.ok(contract.pin, contract.source_id + " is not pinned");
    assert.match(contract.pin.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.ok(contract.pin.rows >= contract.pin.distinct_records && contract.pin.distinct_records > 0);
    assert.match(contract.fileEnv, /^EVIDENCE_EXPORT_PARLIAMENT_[A-Z_]+$/);
    for (const column of contract.columns) assert.doesNotMatch(column.name, /mail|phone|address|donor|body|html|raw|passage|path/);
    for (const id of contract.product_ids) owned.add(id);
  }
  assert.deepEqual([...owned].sort(), ["P01", "P02", "P03", "P05", "P06", "P07", "P10", "P24"]);
  // The counts the catalogue publishes for these products are the counts of distinct publisher items in the exports.
  const items = (id: string) => contractFor(id).pin!.distinct_records;
  assert.equal(items("parliament_export_releases_history"), 4735);
  assert.equal(items("parliament_export_bill_publications"), 201);
  assert.equal(items("parliament_export_current_bills_history"), 101);
  assert.equal(items("parliament_export_committee_business"), 123);
  assert.equal(items("parliament_export_committee_report_files"), 1285);
  assert.equal(items("parliament_export_committee_reports"), 1286);
  assert.equal(items("parliament_export_written_questions"), 187956);
});

async function fixtureFile(rows: ExportRow[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "parliament-family-"));
  const file = join(dir, "export.jsonl");
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  return file;
}

test("an export carrying a column outside the allowlist is refused whole, without echoing the column", async () => {
  const contract = contractFor("parliament_export_written_questions");
  const file = await fixtureFile([questionRow(), questionRow({ id: QID.replace("1111", "2222"), replyText: "a reply that must never travel" })]);
  await assert.rejects(inspectExportFile(contract, file), (error: Error) => /allowlist/.test(error.message) && !/replyText/.test(error.message));
});

// Generation replay -------------------------------------------------------------------------------------------------------------

/** In-memory stand-in for the ledger functions, keeping the two rules that matter here: one content per record per run, and (record, content) unique. */
function memoryDb() {
  const versions = new Map<string, Set<string>>();
  const current = new Map<string, string>();
  const runs: { id: string; adapterVersion: string; records: Map<string, string> }[] = [];
  const checkpoints: Json[] = [];
  const db: IngestDb = {
    syncRegistry: async () => null, syncSchedules: async () => 0, acquireLease: async () => true, releaseLease: async () => undefined,
    startRun: async (_s, _h, adapterVersion) => {
      runs.push({ id: `run-${runs.length + 1}`, adapterVersion, records: new Map() });
      return { run_id: runs.at(-1)!.id, resumed_from_run_id: null, resume_cursor: null };
    },
    ingestBatch: async (runId, _h, records: IngestRecord[]) => {
      const run = runs.find((r) => r.id === runId)!;
      const result: BatchResult = { seen: 0, versions_inserted: 0, observations_inserted: 0, unchanged: 0, rejected: 0 };
      for (const record of records) {
        result.seen++;
        const already = run.records.get(record.external_record_id);
        if (already && already !== record.content_hash) { result.rejected++; continue; }
        run.records.set(record.external_record_id, record.content_hash);
        const known = versions.get(record.external_record_id) ?? new Set<string>();
        if (known.has(record.content_hash)) result.unchanged++;
        else { known.add(record.content_hash); result.versions_inserted++; }
        versions.set(record.external_record_id, known);
        current.set(record.external_record_id, record.content_hash);
        result.observations_inserted++;
      }
      return result;
    },
    saveCheckpoint: async (_r, _h, cursor) => checkpoints.push(cursor),
    logFetch: async () => undefined, projectRun: async () => ({}),
    finishRun: async (_r, _h, status) => ({ status, tombstoned: 0, error_class: null }), close: async () => undefined,
  };
  const destination = async () => ({
    records: versions.size, versions: [...versions.values()].reduce((n, s) => n + s.size, 0), records_without_current_version: 0, records_tombstoned: 0,
  });
  return { db, runs, current, destination };
}

async function pinnedFixture(rows: ExportRow[]): Promise<{ contract: FamilyExportContract; env: { [k: string]: string } }> {
  const base = contractFor("parliament_export_written_questions");
  const file = await fixtureFile(rows);
  const facts = await inspectExportFile(base, file);
  const contract = { ...base, pin: facts.pin };
  const manifest: ExportManifest = {
    manifest_version: 1, source_id: base.source_id, product_ids: base.product_ids, record_kinds: base.record_kinds, recipe_sha256: "sha256:" + "0".repeat(64),
    export: facts.pin, observed_min: null, observed_max: null,
    upstream: { rows: facts.pin.rows, distinct_records: facts.pin.distinct_records, distinct_upstream_records: facts.pin.distinct_records, observed_min: null, observed_max: null },
    unusable_rows: 0, agreement: { rows: true, distinct_records: true }, exported_at: "2026-09-20T00:00:00.000Z",
  };
  const manifestFile = file.replace(/export\.jsonl$/, "manifest.json");
  await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  return { contract, env: { [base.fileEnv]: file, [base.manifestEnv]: manifestFile } };
}

const SECOND = QID.replace("1111", "2222");
const HISTORY: ExportRow[] = [
  questionRow(),                                                                                          // item 1, first content
  questionRow({ observed_at: "2026-09-19T05:00:00.000Z", upstream_content_hash: "c".repeat(64) }),        // same projection: upstream bookkeeping changed
  questionRow({ observed_at: "2026-09-19T09:00:00.000Z", reply_text_sha256: "d".repeat(64), reply_text_chars: 40, last_modified: "2026-03-01T00:00:00.000Z" }),
  questionRow({ id: SECOND, question_number: 102, document_ref: "WQ_102_2026", title: "102 (2026). Example Member to the Minister for Examples" }),
];

// The committed registry is now the merged one, so the family fragment is merged into its core part (what no family owns).
const merged = mergeIntoRegistry(coreOf(sourcesFile as unknown as SourcesFile));
const questionsSource = merged.file.sources.find((s) => s.source_id === "parliament_export_written_questions")!;

test("history is planned into ordered generations, and rows that differ only in unkept fields collapse and are counted", async () => {
  const { contract, env } = await pinnedFixture(HISTORY);
  const plan = await planImport(contract, env[contract.fileEnv], 4);
  assert.equal(plan.distinct_records, 2);
  assert.equal(plan.distinct_versions, 3);
  assert.deepEqual(plan.rows_per_generation, [2, 1]);
  assert.equal(plan.collapsed_rows, 1);
  assert.equal(plan.rows_per_generation.reduce((a, b) => a + b, 0) + plan.collapsed_rows, plan.rows);
  assert.deepEqual([...plan.lineGeneration], [1, 0, 2, 1]);
});

test("an import reconciles source to destination, and a replay inserts nothing and leaves the latest content current", async () => {
  const { contract, env } = await pinnedFixture(HISTORY);
  const memory = memoryDb();
  const options = { file: merged.file, source: questionsSource, contract, env, db: memory.db, dryRun: false, readDestination: memory.destination };
  const first = await importFamilyExport(options);
  assert.equal(first.status, "succeeded");
  assert.equal(first.reconciled, true);
  assert.deepEqual(first.generations.map((g) => [g.totals.seen, g.totals.versions_inserted, g.totals.rejected]), [[2, 2, 0], [1, 1, 0]]);
  assert.deepEqual(memory.runs.map((r) => r.adapterVersion), ["1.0.0+generation.1", "1.0.0+generation.2"]);
  const latest = memory.current.get(QID);

  const replay = await importFamilyExport(options);
  assert.equal(replay.reconciled, true);
  assert.deepEqual(replay.generations.map((g) => [g.totals.versions_inserted, g.totals.unchanged]), [[0, 2], [0, 1]]);
  assert.equal(memory.current.get(QID), latest, "the newest content is current again after a replay");
  // A receipt carries counts and digests only.
  assert.ok(!JSON.stringify(first).includes("Example Member") && !JSON.stringify(first).includes(env[contract.fileEnv]));
});

test("a file that is not the pinned export, or whose manifest disagrees, writes nothing", async () => {
  const { contract, env } = await pinnedFixture(HISTORY);
  const memory = memoryDb();
  const wrongPin = { ...contract, pin: { ...contract.pin!, sha256: "sha256:" + "f".repeat(64) } };
  await assert.rejects(importFamilyExport({ file: merged.file, source: questionsSource, contract: wrongPin, env, db: memory.db, dryRun: false }), /does not match the pinned export/);
  await assert.rejects(importFamilyExport({ file: merged.file, source: questionsSource, contract: { ...contract, pin: null }, env, db: memory.db, dryRun: false }), /not pinned/);
  const unusable = await pinnedFixture([questionRow({ id: "not-a-publisher-id" })]);
  await assert.rejects(importFamilyExport({ file: merged.file, source: questionsSource, contract: unusable.contract, env: unusable.env, db: memory.db, dryRun: false }), /refused whole/);
  assert.equal(memory.runs.length, 0);
});

// Registry fragment --------------------------------------------------------------------------------------------------------------

test("the fragment merges into the shared registry without a clash and passes its validation", () => {
  assert.deepEqual(merged.clashes, []);
  assert.deepEqual(validateSourcesFile(merged.file), []);
  for (const source of PARLIAMENT_EXPORT_SOURCES) {
    assert.equal(source.enabled, false);
    assert.deepEqual(source.allowed_hosts, []);
    // Never a complete snapshot: an export of an earlier collection must not be able to tombstone anything.
    assert.equal(source.snapshot_semantics, "rolling_window");
    assert.match(source.rights_id ?? "", /^RIGHTS-\d{2}$/);
    assert.ok(source.catalogue_products?.every((p) => p.mapping_note.length > 20));
    assert.ok(source.export_contract?.expectedInput, "the shared-shape contract carries the pin");
  }
  // The family writes to none of the sources other lanes already run.
  const existing = new Set((sourcesFile as unknown as SourcesFile).sources.map((s) => s.source_id));
  for (const source of merged.file.sources.slice(existing.size)) assert.ok(!existing.has(source.source_id));
});
