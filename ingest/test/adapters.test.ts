// Parsers, hashing, config validation, manifests, export projection and function auth.
// All inputs are labelled synthetic fixtures (test/fixtures/README.md).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { billsAdapter, parseBillsPage } from "../../supabase/functions/_shared/adapters/bills.ts";
import { parseMpDirectory } from "../../supabase/functions/_shared/adapters/mp_directory.ts";
import { parseReleasesFeed } from "../../supabase/functions/_shared/adapters/releases_rss.ts";
import { authoriseCronRequest, parseIngestRequest, timingSafeEqual } from "../../supabase/functions/_shared/auth.ts";
import { canonicalJson, contentHash } from "../../supabase/functions/_shared/canonical.ts";
import { buildManifest, validateSourcesFile } from "../../supabase/functions/_shared/registry.ts";
import { IngestError, type SourcesFile } from "../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { loadExport, projectExportRow, safeFieldName } from "../src/export_import.ts";

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

test("export import: a missing input is reported by variable name, never by location", async () => {
  const source = file.sources.find((s) => s.source_id === "baseline_2023_candidacies_export")!;
  await assert.rejects(loadExport(source.export_contract!, {}), (e: IngestError) => e.errorClass === "missing_input" && e.message.includes("EVIDENCE_EXPORT_"));
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

test("adversarial export rows: hostile column names, identifiers and links never reach a record or an error", async () => {
  const source = file.sources.find((s) => s.source_id === "baseline_2023_candidacies_export")!;
  const contract = source.export_contract!;
  const good = { candidacy_id: "fixture-c-900", source_url: "https://electionresults.govt.nz/electionresults_2023/", captured_at: "2026-09-01T00:00:00Z", candidate_name: "Fixture Person", election_id: "NZGE2023", candidacy_type: "party_list", nomination_status: "official_party_list_candidate", party_selection_status: "party_list_rank_published", electorate_type: "", candidate_votes: 0, list_rank: 4, source_passage: "Fixture Party 4 Fixture Person" };

  const hostileColumns = { ...good, 'x"; drop table y; --': "v", "<img src=x onerror=alert(1)>": "v", "donor_email": "fixture-donor@example.invalid", "api_token": "fixture-not-a-secret", "home path": "/ho" + "me/operator/x" };
  assert.ok(!JSON.stringify(await projectExportRow(source, contract, hostileColumns, "x")).includes("Fixture Party 4 Fixture Person"), "the captured passage is read for evidence and never stored");
  const record = await projectExportRow(source, contract, hostileColumns, "2026-09-20T00:00:00.000Z");
  const text = JSON.stringify(record);
  for (const leaked of ["drop table", "<img", "onerror", "example.invalid", "fixture-not-a-secret", "operator", "donor_email", "api_token"]) assert.ok(!text.includes(leaked), leaked);
  for (const entry of record.omitted_fields) assert.match(entry.field, /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/);
  assert.equal(record.omitted_fields.filter((o) => o.field.startsWith("unlisted_field_")).length, 5);
  assert.equal(safeFieldName("source_passage"), "source_passage");
  assert.equal(safeFieldName("a".repeat(200)).startsWith("unlisted_field_"), true);

  for (const badId of ["person@example.invalid", "/ho" + "me/operator/file", "has space", "https://elsewhere.example/x", "<b>x</b>"]) {
    await assert.rejects(projectExportRow(source, contract, { ...good, candidacy_id: badId }, "x"), (e: IngestError) => e.errorClass === "parse_error" && !e.message.includes(badId), badId);
  }
  for (const badUrl of ["https://user:pw@electionresults.govt.nz/", "https://electionresults.govt.nz/?token=abc", "http://electionresults.govt.nz/", "file:///x"]) {
    await assert.rejects(projectExportRow(source, contract, { ...good, source_url: badUrl }, "x"), (e: IngestError) => e.errorClass === "parse_error" && !e.message.includes("pw") && !e.message.includes("abc"), badUrl);
  }
});

test("review 8/9: a live source without a rights row or an access basis is a configuration error, not a default", () => {
  for (const source of file.sources) {
    if (source.adapter_kind !== "live_fetch") continue;
    assert.match(source.rights_id ?? "", /^RIGHTS-\d{2,}$/, source.source_id + " names its rights row");
    assert.ok(source.access_basis, source.source_id + " states its access basis");
    assert.ok((source.min_interval_ms ?? 0) >= 1000, source.source_id + " paces its requests");
  }
  const noRights = structuredClone(file);
  delete noRights.sources.find((s) => s.source_id === "ec_2026_nominations")!.rights_id;
  assert.match(validateSourcesFile(noRights).join("\n"), /ec_2026_nominations.*needs a rights_id/);
  const emptyRights = structuredClone(file);
  emptyRights.sources.find((s) => s.source_id === "ec_register_of_political_parties")!.rights_id = "";
  assert.match(validateSourcesFile(emptyRights).join("\n"), /ec_register_of_political_parties.*needs a rights_id/);
  const noBasis = structuredClone(file);
  delete noBasis.sources.find((s) => s.source_id === "nz_government_releases_feed")!.access_basis;
  assert.match(validateSourcesFile(noBasis).join("\n"), /must state its access_basis/);
  const tooFast = structuredClone(file);
  tooFast.sources.find((s) => s.source_id === "nz_government_releases_feed")!.min_interval_ms = 50;
  assert.match(validateSourcesFile(tooFast).join("\n"), /min_interval_ms/);
});

test("review 8: every rights id a source names exists in the public rights register, and every such row is still pending", async () => {
  const register = JSON.parse(await readFile(new URL("../../catalogue/rights-register.json", import.meta.url), "utf-8")) as { rights_id: string; review_status: string; reviewed_on: string }[];
  const byId = new Map(register.map((r) => [r.rights_id, r]));
  for (const source of file.sources) {
    if (!source.rights_id) continue;
    const row = byId.get(source.rights_id);
    assert.ok(row, source.source_id + " -> " + source.rights_id + " is in the register");
    assert.deepEqual([row.review_status, row.reviewed_on], ["pending", ""], "no review is invented: " + source.rights_id + " stays pending and undated");
  }
});

test("policy: a PUBLIC undocumented endpoint is eligible (reported, not vetoed); a sign-in or paywalled source never is; the bills adapter stays anonymous", async () => {
  const bills = file.sources.find((s) => s.source_id === "nz_parliament_current_bills")!;
  assert.deepEqual([bills.access_basis, bills.enabled], ["public_undocumented_endpoint", true]);
  assert.match(bills.access_note ?? "", /undocumented/i, "the undocumented status is still written down for a person to weigh");
  assert.match(bills.access_note ?? "", /No permission from the publisher is claimed/);
  assert.ok(file.schedules.some((s) => s.source_id === bills.source_id), "it may be scheduled (every schedule still syncs inactive)");
  const mps = file.sources.find((s) => s.source_id === "nz_parliament_mp_directory")!;
  assert.deepEqual([mps.access_basis, mps.enabled], ["public_page", true]);
  assert.match(mps.access_note ?? "", /robots\.txt.*Disallow/, "the robots.txt signal is recorded on the source, not hidden");

  for (const basis of ["authenticated", "paywalled"] as const) {
    const gated = structuredClone(file);
    Object.assign(gated.sources.find((s) => s.source_id === bills.source_id)!, { access_basis: basis, enabled: true });
    assert.match(validateSourcesFile(gated).join("\n"), /behind a sign-in or a paywall is never enabled/, basis);
  }
  for (const option of ["api_key", "authToken", "session_cookie", "password"]) {
    const withCredential = structuredClone(file);
    withCredential.sources.find((s) => s.source_id === bills.source_id)!.adapter_options = { [option]: "TEST FIXTURE" };
    assert.match(validateSourcesFile(withCredential).join("\n"), /looks like a credential; only anonymous public requests/, option);
  }

  const sent: { [key: string]: string }[] = [];
  const pages = billsAdapter.pages({
    source: bills, resumeCursor: null, maxRecords: 10, deadline: Date.now() + 5000,
    fetch: async (request: { headers?: { [key: string]: string } }) => { sent.push(request.headers ?? {}); return { text: JSON.stringify({ totalResults: 0, results: [] }) }; },
  } as never);
  try { await pages.next(); } catch { /* an empty listing faults by design; only the request matters here */ }
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).map((k) => k.toLowerCase()).filter((k) => k === "origin" || k === "referer"), []);
});
