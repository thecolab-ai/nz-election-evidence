// Parsers, hashing, config validation, manifests, export projection and function auth.
// All inputs are labelled synthetic fixtures (test/fixtures/README.md).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseBillsPage } from "../../supabase/functions/_shared/adapters/bills.ts";
import { parseMpDirectory } from "../../supabase/functions/_shared/adapters/mp_directory.ts";
import { parseReleasesFeed } from "../../supabase/functions/_shared/adapters/releases_rss.ts";
import { authoriseCronRequest, parseIngestRequest, timingSafeEqual } from "../../supabase/functions/_shared/auth.ts";
import { canonicalJson, contentHash } from "../../supabase/functions/_shared/canonical.ts";
import { buildManifest, validateSourcesFile } from "../../supabase/functions/_shared/registry.ts";
import { IngestError, type SourcesFile } from "../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { loadExport, projectExportRow } from "../src/export_import.ts";

const file = sourcesFile as unknown as SourcesFile;
const fixture = (name: string) => new URL("./fixtures/" + name, import.meta.url);

test("canonical JSON is key-order independent, so hashes are stable", async () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] }), '{"a":[2,{"c":"x","d":null}],"b":1}');
  assert.equal(await contentHash("k", 1, { a: 1, b: 2 }), await contentHash("k", 1, { b: 2, a: 1 }));
  assert.notEqual(await contentHash("k", 1, { a: 1 }), await contentHash("k", 2, { a: 1 }));
});

test("MP directory: slug identity, macrons and entities, list members carry no electorate", async () => {
  const rows = parseMpDirectory(await readFile(fixture("mp-directory.fixture.html"), "utf-8"));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { slug: "fixture-alex", name_sort: "Fixture, Alex", name_display: "Alex Fixture", party_label: "Fixture Party", representation: "list", electorate_label: null });
  assert.equal(rows[1].slug, "tāne-fixture-méndez");
  assert.equal(rows[1].name_display, "Tāne Fixture-Méndez");
  assert.equal(rows[2].electorate_label, "Te Tai Fixture");
  assert.ok(!JSON.stringify(rows).includes(".jpg"), "portrait URLs are not collected");
});

test("MP directory: a page without the listing parses to zero rows (the adapter then faults instead of tombstoning)", () => {
  assert.equal(parseMpDirectory("<html><body>Service unavailable</body></html>").length, 0);
});

test("bills: metadata only, stable ids, faults on a non-listing response", () => {
  const body = JSON.stringify({ totalResults: 2, results: [
    { id: "00000000-0000-4000-8000-000000000001", title: "TEST FIXTURE Bill One", billNumber: "1-1", itemType: "Government", billCurrentStageName: "First Reading", parliamentNumber: 54, lastStageDate: "2026-09-15T16:49:16.528Z", attachmentName: "should-not-be-kept.pdf" },
    { id: "00000000-0000-4000-8000-000000000002", title: "TEST FIXTURE Bill Two", memberName: "Fixture Member", partyName: "Fixture Party" },
  ] });
  const parsed = parseBillsPage(body, "https://bills.parliament.nz/v/6/");
  assert.equal(parsed.total, 2);
  assert.equal(parsed.items[0].payload.public_page_url, "https://bills.parliament.nz/v/6/00000000-0000-4000-8000-000000000001");
  assert.equal(parsed.items[1].payload.last_activity_at, null, "a missing publisher date stays missing");
  assert.ok(!JSON.stringify(parsed).includes("should-not-be-kept"));
  assert.throws(() => parseBillsPage("<html>challenge</html>", "x"), IngestError);
  assert.throws(() => parseBillsPage(JSON.stringify({ totalResults: 0, results: [] }), "x"), IngestError, "an empty listing is a fault, not zero bills");
});

test("releases feed: link and title only; publisher date kept apart and optional", async () => {
  const items = parseReleasesFeed(await readFile(fixture("releases.fixture.xml"), "utf-8"));
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "TEST FIXTURE release one & more");
  assert.equal(items[1].pubDateText, null);
  assert.ok(!JSON.stringify(items).includes("summary"), "description text is never read into a record");
  assert.throws(() => parseReleasesFeed("<html></html>"), IngestError);
});

test("source configuration is valid and carries no private hosts, paths or active schedules", () => {
  assert.deepEqual(validateSourcesFile(file), []);
  const text = JSON.stringify(file);
  assert.ok(!/\/(home|Users)\//.test(text) && !/\.ts\.net|tailscale|\.local\b|192\.168\.|10\.\d+\.\d+\.\d+/.test(text));
  for (const source of file.sources) {
    if (source.adapter_name === "availability_probe" || source.adapter_kind === "export_import") assert.equal(source.enabled, false, source.source_id);
  }
  const broken = structuredClone(file);
  broken.sources[0].allowed_hosts = ["internal.corp"];
  broken.sources[1].official_url = "http://bills.parliament.nz/";
  assert.ok(validateSourcesFile(broken).length >= 2);
});

test("manifests are deterministic: same inputs, same hash; any config change, new hash", async () => {
  const source = file.sources[0];
  const a = await buildManifest(file, source, "1.0.0", "incremental", 200);
  const b = await buildManifest(structuredClone(file), structuredClone(source), "1.0.0", "incremental", 200);
  assert.equal(a.manifestHash, b.manifestHash);
  assert.ok(!JSON.stringify(a.manifest).match(/\d{4}-\d{2}-\d{2}T/), "no timestamps inside a manifest");
  const changed = structuredClone(source);
  changed.allowed_hosts = [...changed.allowed_hosts, "www.parliament.nz"];
  assert.notEqual((await buildManifest(file, changed, "1.0.0", "incremental", 200)).manifestHash, a.manifestHash);
});

test("export import: allowlist projection, drops recorded by name, file location never recorded", async () => {
  const source = file.sources.find((s) => s.source_id === "baseline_2023_candidacies_export")!;
  const contract = source.export_contract!;
  await assert.rejects(loadExport(contract, {}), (e: IngestError) => e.errorClass === "missing_input");
  const location = fixture("baseline-candidacies.fixture.jsonl").pathname;
  const loaded = await loadExport(contract, { [contract.fileEnv]: location });
  assert.equal(loaded.digest.rows, 3);
  assert.match(loaded.digest.sha256, /^sha256:[0-9a-f]{64}$/);
  const records = await Promise.all(loaded.rows.map((row) => projectExportRow(source, contract, row, "2026-09-20T00:00:00.000Z")));
  const text = JSON.stringify(records);
  assert.ok(!text.includes("must be dropped") && !text.includes("TEST FIXTURE value"), "dropped values never reach a record");
  assert.ok(!text.includes(location), "the export location never reaches a record");
  assert.deepEqual(Object.keys(records[0].safe_payload).sort(), ["candidacy_type", "candidate_name", "candidate_votes", "electorate_name", "electorate_type_upstream_label", "list_rank", "nomination_status", "party_name"]);
  const omitted = records[2].omitted_fields.map((o) => o.field);
  assert.ok(omitted.includes("source_record_json") && omitted.includes("source_passage") && omitted.includes("candidate_name_key"));
  assert.equal(records[2].omitted_fields.find((o) => o.field === "unexpected_new_upstream_column")?.reason, "not on this source's field allowlist");
  const again = await projectExportRow(source, contract, { ...loaded.rows[0], captured_at: "2030-01-01T00:00:00Z", source_passage: "different" }, "x");
  assert.equal(again.content_hash, records[0].content_hash, "observation time and dropped fields do not change the content hash");
});

test("function auth: constant-time secret, fail closed, body can never carry a URL", () => {
  const secret = "s".repeat(40);
  assert.equal(timingSafeEqual(secret, secret), true);
  assert.equal(timingSafeEqual(secret, secret.slice(1)), false);
  assert.equal(authoriseCronRequest(secret, undefined).status, 503);
  assert.equal(authoriseCronRequest(secret, "short").status, 503);
  assert.equal(authoriseCronRequest(null, secret).status, 401);
  assert.equal(authoriseCronRequest("wrong".repeat(8), secret).status, 401);
  assert.equal(authoriseCronRequest(secret, secret).ok, true);
  assert.deepEqual(parseIngestRequest({ source_id: "nz_parliament_mp_directory" }), { source_id: "nz_parliament_mp_directory", schedule_key: undefined, trigger_kind: "cron", max_runtime_seconds: 60, max_records: 500 });
  for (const bad of [{ source_id: "x", url: "https://evil.example" }, { source_id: "../etc" }, { source_id: "abc", max_runtime_seconds: 9999 }, { source_id: "abc", max_records: 1e9 }, { source_id: "abc", trigger_kind: "cli" }, [], "text", null]) {
    assert.throws(() => parseIngestRequest(bad), Error, JSON.stringify(bad));
  }
});
