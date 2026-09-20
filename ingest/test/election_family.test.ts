// Election family: mapping, contracts, history waves, replay, route de-duplication, live parsers.
// Runs on its own: node --test test/election_family.test.ts   (no database, no network).
//
// TEST FIXTURES ONLY. Every name, number, URL host and hash below is invented for the test and shaped like the
// upstream rows the mappers were written against. None of it is imported anywhere. The real, pinned exports are
// checked by the last test when EVIDENCE_EXPORT_ELECTION_DIR points at them, and skipped otherwise.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateSourcesFile } from "../../supabase/functions/_shared/registry.ts";
import { runSource } from "../../supabase/functions/_shared/runner.ts";
import type { BatchResult, IngestDb } from "../../supabase/functions/_shared/db.ts";
import type { IngestRecord, SourcesFile } from "../../supabase/functions/_shared/types.ts";
import { loadExport, preflightExport } from "../src/export_import.ts";
import { familyAdapter, loadProduct, parseProduct, preflight, toIngestRecord, waveDigest, waveRows } from "../src/families/election/adapter.ts";
import { mergedSourcesFile } from "../src/families/election/cli.ts";
import { contractProblem } from "../src/families/election/contracts.ts";
import { buildExport, foldVersions, joinBaselineCandidacies, latest, safeDigest, type VersionedExportRow } from "../src/families/election/exporter.ts";
import { pageFacts, parsePollIndex } from "../src/families/election/live.ts";
import {
  mapCandidateReturn, mapElectorateResult, mapOverallResult, mapPartyAggregate, mapPartyReturn, mapPolicyPage, mapPoll,
  letterHex, publishedAmount, type WarehouseRow,
} from "../src/families/election/mapping.ts";
import { ELECTION_EXPORT_SOURCES, ELECTION_PINS } from "../src/families/election/registry_fragment.ts";
import { assertReadOnlySelect } from "../src/families/election/warehouse.ts";

const H = (c: string) => c.repeat(64);

function upstream(sourceId: string, id: string, url: string, payload: unknown, at = "2026-09-19 09:00:00.000", hash = H("a")): WarehouseRow {
  return { source_id: sourceId, record_id: id, record_kind: "fact", source_url: url, observed_at: at, content_hash: hash, payload_json: JSON.stringify(payload) };
}

const PAGE = "https://electionresults.govt.nz/electionresults_2023/electorate-details-07.html";

function voteRow(id: string, name: string, type: "candidate" | "party", votes: number | null, hash = H("b")): WarehouseRow {
  return upstream("nz_electoral_commission_2023_electorate_results", id, PAGE, {
    election_year: 2023, electorate_id: 7, electorate_name: "Fixture North", entity_name: name, vote_type: type, votes,
    result_scope: "electorate_vote_result", source_display_order: 1, capture_mode: "genuine_browser", archive_complete: false, product_complete: true,
    product_denominator: 72, publisher: "Fixture", raw_path: "/srv/private/capture.html", source_sha256: H("c"),
  }, "2026-09-19 09:00:00.000", hash);
}

test("P08/P09: numbers kept only when present; capture locations and ranking restatements dropped", () => {
  const party = mapOverallResult(upstream("nz_electoral_commission_2023_overall_results", "2023:nationwide:party:x", "https://www.electionresults.govt.nz/electionresults_2023/", {
    election_year: 2023, result_scope: "nationwide_party_vote", party_name: "Fixture Party", party_votes: 0, vote_percent: 0, electorate_seats: null, list_seats: null,
    total_seats: null, raw_path: "/srv/private/x.html", original_bytes: 5, source_sha256: H("d"), publisher: "Fixture",
  }));
  assert.equal(party.payload.party_votes, 0, "a published zero stays zero");
  assert.ok(!("list_seats" in party.payload), "a blank seats cell stays absent, never zero");
  assert.equal(party.original_sha256, H("d"));
  assert.ok(party.omitted.some((o) => o.field === "raw_path"));
  assert.ok(!JSON.stringify(party).includes("/srv/"), "no capture location leaves the mapper");

  const unknown = mapElectorateResult(voteRow("v1", "FIXTURE, Alex", "candidate", null));
  assert.ok(!("votes" in unknown.payload), "a missing vote count is absent, never zero");
  const summary = mapElectorateResult(upstream("nz_electoral_commission_2023_electorate_results", "s1", PAGE, {
    election_year: 2023, electorate_id: 7, electorate_name: "Fixture North", result_scope: "electorate_summary", candidate_total: 10, candidate_informals: 1,
    party_total: 12, party_informals: 2, leading_candidate: "FIXTURE, Alex", leading_candidate_votes: 6, majority: 3, party_vote_leader: "Fixture Party",
  }));
  assert.ok(!("leading_candidate" in summary.payload) && !("majority" in summary.payload), "leader and margin restate the line items and are dropped");
  assert.throws(() => mapElectorateResult(upstream("x", "bad", "https://electionresults.govt.nz/electionresults_2023/electorate-details-08.html", {
    election_year: 2023, electorate_id: 7, electorate_name: "Fixture North", result_scope: "electorate_summary",
  })), /does not match the official page/);
});

test("P13: page text never exported; upstream label kept as unreviewed; publisher date only when the page states one", () => {
  const row = mapPolicyPage(upstream("nz_registered_party_policy_pages_2026", "p:1", "https://fixture-party.example/", {
    party_name: "Fixture Party", policy_url: "https://fixture-party.example/policy", document_title: "Policy", document_text: "LONG COPIED PAGE TEXT",
    document_sha256: H("e"), policy_classification: "published_2026_manifesto", classification_source: "prior research artifact",
    classification_evidence_quote: "copied quote", capture_status: "captured", source_published_at: null, registered_party_denominator: 17,
  }));
  assert.ok(!JSON.stringify(row).includes("LONG COPIED PAGE TEXT") && !JSON.stringify(row).includes("copied quote"));
  assert.equal(row.payload.upstream_unreviewed_label, "published_2026_manifesto");
  assert.equal(row.payload.upstream_label_model_metadata, "not_recorded");
  assert.equal(row.source_published_at, undefined, "no publisher date is invented from the collection time");
  assert.equal(row.official_url, "https://fixture-party.example/policy");
  const dated = mapPolicyPage(upstream("nz_registered_party_policy_pages_2026", "p:1", "https://fixture-party.example/", {
    party_name: "Fixture Party", policy_url: "https://fixture-party.example/policy", source_published_at: "2026-09-16T03:59:07Z", source_published_basis: "JSON-LD datePublished",
  }));
  assert.equal(dated.source_published_at, "2026-09-16T03:59:07.000Z");
  assert.notEqual(dated.source_published_at, dated.collected_at);
});

test("P14: a blank cell is not reported, source order is kept, methodology text is dropped", () => {
  const poll = mapPoll(upstream("nz_party_vote_polls_90d_20260919", "poll:1", "https://index.example/nz.html", {
    pollster: "Fixture Research", commissioner: "Fixture News", fieldwork_start: "2026-08-14", fieldwork_end: "2026-08-21", sample_size: 1000,
    party_vote_percent: { ZED: "7.7", ALPHA: null, Other: "0" }, methodology: "COPIED METHODOLOGY PARAGRAPH", metadata_complete_public_poll: true,
    disclosure_url: "https://news.example/poll", index_url: "https://index.example/nz.html", publication_date: null,
  }));
  assert.deepEqual(poll.payload.results, [
    { party_label: "ZED", value_pct: 7.7, value_status: "reported" }, { party_label: "ALPHA", value_status: "not_reported" },
    { party_label: "Other", value_pct: 0, value_status: "reported" },
  ]);
  assert.equal(poll.payload.methodology_status, "verified");
  assert.equal(poll.official_url, "https://news.example/poll", "the poll's own publisher page is the official link");
  assert.ok(!JSON.stringify(poll).includes("COPIED METHODOLOGY"));
  assert.equal(poll.source_published_at, undefined);
  assert.throws(() => mapPoll(upstream("x", "poll:2", "https://index.example/nz.html", { pollster: "F", party_vote_percent: { A: "about 7" } })), /neither a number nor blank/);
});

test("P15-P17: totals exactly as published; NIL is a reported nil; no text, OCR or location survives", () => {
  assert.deepEqual(publishedAmount("$42,099.86"), { status: "reported", nzd: 42099.86, nil: false });
  assert.deepEqual(publishedAmount("NIL"), { status: "reported", nzd: 0, nil: true });
  assert.deepEqual(publishedAmount(""), { status: "not_reported" });
  assert.deepEqual(publishedAmount("see return"), { status: "not_reported" });
  const doc = mapCandidateReturn(upstream("political_finance_2023_candidate_returns", "cr:1", "https://elections.nz/assets/candidate-returns/2023/x.pdf", {
    reporting_year: 2023, candidate_name_as_published: "FIXTURE, Alex", electorate_as_published: "Fixture North", party_name_as_published: "Fixture Party",
    expenses_as_published: "$1,000.50", donations_as_published: "NIL", loans_as_published: "", full_text: "EXTRACTED RETURN TEXT WITH ENTRIES",
    raw_pdf_path: "/srv/private/x.pdf", raw_pdf_sha256: H("f"), text_extraction_status: "no_usable_text_layer", return_kind: "candidate_return",
  }));
  assert.equal(doc.payload.expenses_as_published_nzd, 1000.5);
  assert.equal(doc.payload.donations_as_published_status, "reported_nil");
  assert.equal(doc.payload.loans_as_published_status, "not_reported");
  assert.ok(!("loans_as_published_nzd" in doc.payload), "an unreported amount has no number");
  assert.equal(doc.payload.is_image_only, true);
  assert.ok(!JSON.stringify(doc).includes("EXTRACTED RETURN TEXT") && !JSON.stringify(doc).includes("/srv/"));

  const aggregate = mapPartyAggregate(upstream("political_finance_2025_aggregates", "agg:1", "https://elections.nz/x", {
    reporting_year: 2025, party_name_as_published: "Fixture Party", source_sha256: H("1"), capture_mode: "genuine_browser_dom",
    facts: [
      { metric: "total_party_donations", amount_nzd: "270.00", value_status: "reported", evidence_text: " $270.00", basis: "commission_published_summary_not_recomputed_from_donors", filing_dates: ["2026-04-29"], return_urls: ["https://elections.nz/assets/r.pdf"], period_start: "2025-01-01", period_end: "2025-12-31" },
      { metric: "total_party_loans", amount_nzd: "0.00", value_status: "reported", evidence_text: " NIL ", basis: "commission_published_summary_not_recomputed_from_donors", filing_dates: [], return_urls: [] },
    ],
  }));
  assert.deepEqual((aggregate.payload.aggregates as { value_status: string }[]).map((a) => a.value_status), ["reported", "reported_nil"]);
  assert.throws(() => mapPartyAggregate(upstream("x", "agg:2", "https://elections.nz/x", { reporting_year: 2025, party_name_as_published: "F", facts: [{ metric: "largest_single_entry", basis: "commission_published_summary_not_recomputed_from_donors" }] })), /outside the documented vocabulary/);

  const ret = mapPartyReturn(upstream("political_finance_2025_returns", "pr:1", "https://elections.nz/assets/Annual-Returns/2025/x.pdf", {
    reporting_year: 2025, party_name_as_published: "Fixture Party", text_extraction_status: "vision_derived_key_fields_full_page_review",
    full_verbatim_ocr_pages: ["PAGE ONE TRANSCRIPTION"], full_text: "KEY FIELD TRANSCRIPTION", raw_pdf_sha256: H("2"), pages_visually_reviewed: [1, 2, 3],
  }));
  assert.equal(ret.payload.pages_visually_reviewed, 3);
  assert.ok(!JSON.stringify(ret).includes("TRANSCRIPTION"));
  for (const row of [doc, aggregate, ret]) assert.equal(contractProblem({ ...row, version_ordinal: 1, version_count: 1, upstream_versions_folded: 0, safe_digest: "" } as VersionedExportRow), null);
});

test("history: versions fold only when the allowlisted content is equal; waves replay each record in order, once", () => {
  const rows = [
    mapElectorateResult(voteRow("r1", "Fixture Party", "party", 10, H("1"))),
    { ...mapElectorateResult(voteRow("r1", "Fixture Party", "party", 10, H("2"))), collected_at: "2026-09-19T10:00:00.000Z" },
    { ...mapElectorateResult(voteRow("r1", "Fixture Party", "party", 11, H("3"))), collected_at: "2026-09-19T11:00:00.000Z" },
    mapElectorateResult(voteRow("r2", "Other Party", "party", 5, H("4"))),
  ];
  const folded = foldVersions(rows);
  assert.deepEqual(folded.map((r) => [r.external_record_id, r.version_ordinal, r.version_count, r.upstream_versions_folded]), [["r1", 1, 2, 1], ["r1", 2, 2, 0], ["r2", 1, 1, 0]]);
  assert.equal(folded.length + folded.reduce((s, r) => s + r.upstream_versions_folded, 0), rows.length, "every upstream version is exported or folded, none lost");
  const waves = [1, 2].map((w) => waveRows(folded, w, 2).map((r) => `${r.external_record_id}v${r.version_ordinal}`));
  assert.deepEqual(waves, [["r1v1"], ["r1v2", "r2v1"]], "the last wave holds the latest version of every record");
  assert.deepEqual(latest(folded).map((r) => r.external_record_id), ["r1", "r2"]);
});

test("P04 join: identifier join needs the official page, the published name AND the votes; a name alone joins nothing", () => {
  const votes = foldVersions([
    mapElectorateResult(voteRow("v-a", "FIXTURE, Alex", "candidate", 100, H("1"))),
    mapElectorateResult(voteRow("v-b", "SAMPLE, Sam", "candidate", 50, H("2"))),
    mapElectorateResult(voteRow("v-c", "TWIN, Pat", "candidate", 7, H("3"))),
    mapElectorateResult(voteRow("v-d", "ELSEWHERE, Eve", "candidate", 9, H("4"))),
  ]);
  const outcome = joinBaselineCandidacies(votes, [
    { candidacy_id: "000000000000000000000000000f4243", candidate_name: "FIXTURE, Alex", candidacy_type: "electorate", candidate_votes: 100, source_url: PAGE },
    { candidacy_id: "000000000000000000000000001e8486", candidate_name: "SAMPLE, Sam", candidacy_type: "electorate", candidate_votes: 51, source_url: PAGE },
    { candidacy_id: "000000000000000000000000002dc6c9", candidate_name: "TWIN, Pat", candidacy_type: "electorate", candidate_votes: 7, source_url: PAGE },
    { candidacy_id: "000000000000000000000000003d090c", candidate_name: "TWIN, Pat", candidacy_type: "electorate", candidate_votes: 7, source_url: PAGE },
    { candidacy_id: "000000000000000000000000004c4b4f", candidate_name: "ELSEWHERE, Eve", candidacy_type: "electorate", candidate_votes: 9, source_url: PAGE.replace("-07", "-08") },
    { candidacy_id: "000000000000000000000000005b8d92", candidate_name: "FIXTURE, Alex", candidacy_type: "party_list", candidate_votes: 0, source_url: PAGE },
  ]);
  assert.deepEqual(outcome, { joined: 1, unmatched: 1, ambiguous: 1, votes_disagree: 1 });
  assert.equal(votes[0].payload.baseline_candidacy_ref, letterHex("000000000000000000000000000f4243"));
  assert.ok(votes.slice(1).every((r) => !("baseline_candidacy_ref" in r.payload)), "same name on another page, a vote mismatch and a twin all stay unjoined");
});

function exportFile(rows: VersionedExportRow[]): Buffer {
  return Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("import contract: pinned file only; any field outside the closed contract refuses the whole file", () => {
  const good = foldVersions([mapElectorateResult(voteRow("r1", "Fixture Party", "party", 10))]);
  const loaded = parseProduct("P09", exportFile(good));
  assert.equal(preflight(loaded, undefined, null).rows, 1);
  assert.throws(() => preflight(loaded, { sha256: "sha256:" + H("0"), rows: 1, records: 1, waves: 1 }, null), /pinned checksum/);

  const tamper = (change: (row: VersionedExportRow) => void) => {
    const copy = structuredClone(good);
    change(copy[0]);
    copy[0].safe_digest = safeDigest(copy[0]);
    return parseProduct("P09", exportFile(copy));
  };
  assert.throws(() => preflight(tamper((r) => { r.payload.candidate_home_town = "Fixtureville"; }), undefined, null), /outside the contract/);
  assert.throws(() => preflight(tamper((r) => { r.payload.full_text = "x"; }), undefined, null), /forbidden field name/);
  assert.throws(() => preflight(tamper((r) => { r.payload.votes = -1; }), undefined, null), /wrong shape/);
  assert.throws(() => preflight(tamper((r) => { r.payload.vote_type = "preference"; }), undefined, null), /outside the documented vocabulary/);
  assert.throws(() => preflight(tamper((r) => { r.source_published_at = r.collected_at; }), undefined, null), /publisher date equals the collection time/);
  assert.throws(() => preflight(tamper((r) => { r.official_url = "http://plain.example/"; }), undefined, null), /https official URL/);
  const stale = structuredClone(good);
  stale[0].payload.votes = 11;
  assert.throws(() => preflight(parseProduct("P09", exportFile(stale)), undefined, null), /recorded digest/);
  assert.throws(() => preflight(parseProduct("P09", Buffer.from("")), undefined, null), /held no rows/);
});

test("review fixes: version-making facts live in the payload; nested vocabularies, calendar dates and future publisher dates are refused", async () => {
  const dated = (published: string, hash: string) => mapPolicyPage(upstream("nz_registered_party_policy_pages_2026", "p:1", "https://fixture-party.example/", {
    party_name: "Fixture Party", policy_url: "https://fixture-party.example/policy", document_sha256: hash, source_published_at: published, source_published_basis: "JSON-LD datePublished",
  }));
  const a = dated("2026-09-16T03:59:07Z", H("e"));
  assert.equal(a.payload.original_document_digest, "e".repeat(64));
  assert.equal(a.payload.publisher_stated_date, "2026-09-16T03:59:07.000Z");
  const hashes = await Promise.all([a, dated("2026-09-16T03:59:07Z", H("f")), dated("2026-09-17T00:00:00Z", H("e"))].map(async (r) => (await toIngestRecord(foldVersions([r])[0])).content_hash));
  assert.equal(new Set(hashes).size, 3, "a changed page hash or a changed publisher date is a new version in the store too");
  assert.equal(dated("2026-09-16 03:59:07", H("e")).source_published_at, "2026-09-16T03:59:07.000Z", "a zone-less publisher date is read as UTC on every machine");
  assert.throws(() => dated("2026-09-20T00:00:00Z", H("e")), /later than the collection time/);
  assert.throws(() => mapPolicyPage(upstream("x", "p:2", "https://fixture-party.example/", { party_name: "F", policy_url: "https://fixture-party.example/p", source_published_at: "2026-09-16T00:00:00Z" })), /basis/);

  const poll = foldVersions([mapPoll(upstream("nz_party_vote_polls_90d_20260919", "poll:1", "https://index.example/nz.html", { pollster: "Fixture Research", party_vote_percent: { ZED: "7.7", ALPHA: null }, fieldwork_end: "2026-08-21" }))]);
  const broken = (change: (row: VersionedExportRow) => void) => { const copy = structuredClone(poll); change(copy[0]); copy[0].safe_digest = safeDigest(copy[0]); return parseProduct("P14", exportFile(copy)); };
  type Cell = { party_label: string; value_pct?: number; value_status: string };
  assert.throws(() => preflight(broken((r) => { (r.payload.results as Cell[])[0].value_status = "estimated"; }), undefined, null), /outside the documented vocabulary/);
  assert.throws(() => preflight(broken((r) => { (r.payload.results as Cell[])[0].value_pct = 140; }), undefined, null), /above 100/);
  assert.throws(() => preflight(broken((r) => { (r.payload.results as Cell[])[1].party_label = "ZED"; }), undefined, null), /repeats a party_label/);
  assert.throws(() => preflight(broken((r) => { (r.payload.results as Cell[])[1].value_pct = 0; }), undefined, null), /value and its status disagree/);
  assert.throws(() => preflight(broken((r) => { r.payload.fieldwork_end = "2026-02-30"; }), undefined, null), /wrong shape/);
  assert.throws(() => preflight(broken((r) => { r.payload.sample_size = 0; }), undefined, null), /is zero/);
  assert.throws(() => preflight(broken((r) => { r.original_sha256 = H("9"); }), undefined, null), /not carried in the payload/);
  assert.throws(() => mapPoll(upstream("x", "poll:3", "https://index.example/nz.html", { pollster: "F", party_vote_percent: { "A ": "1", A: "2" } })), /repeats a party label/);
  assert.throws(() => mapPartyAggregate(upstream("x", "agg:9", "https://elections.nz/x", { reporting_year: 2025, party_name_as_published: "F", facts: [{ metric: "total_party_loans", amount_nzd: "12.00", value_status: "reported", evidence_text: " NIL ", basis: "commission_published_summary_not_recomputed_from_donors" }] })), /NIL beside a non-zero/);
  assert.throws(() => mapPartyAggregate(upstream("x", "agg:9", "https://elections.nz/x", { reporting_year: 2025, party_name_as_published: "F", facts: [{ metric: "total_party_loans", amount_nzd: "n/a", value_status: "reported", basis: "commission_published_summary_not_recomputed_from_donors" }] })), /cannot be read/);

  assert.equal(letterHex("0123456789abcdef"), "ghijklmnopabcdef", "the same bits with no digit run");
  const phoneLike = foldVersions([mapElectorateResult(voteRow("r9", "STEPHENS, Pat 021 555 1234", "candidate", 5))]);
  assert.throws(() => preflight(parseProduct("P09", exportFile(phoneLike)), undefined, null), /read as a phone number/);

  const twice = foldVersions([mapElectorateResult(voteRow("r1", "Fixture Party", "party", 10, H("1"))), { ...mapElectorateResult(voteRow("r1", "Fixture Party", "party", 11, H("2"))), collected_at: "2026-09-19T11:00:00.000Z" }]);
  twice[1].payload = structuredClone(twice[0].payload);
  twice[1].official_url = twice[0].official_url + "?v=2";
  twice[1].safe_digest = safeDigest(twice[1]);
  assert.throws(() => preflight(parseProduct("P09", exportFile(twice)), undefined, null), /neighbouring versions of a record have the same payload/);
});

test("policy page monitor: a missing or broken page is recorded as unavailable and the other pages are still checked", async () => {
  const { policyPageMonitorAdapter } = await import("../src/families/election/live.ts");
  const { IngestError, SourceUnavailableError } = await import("../../supabase/functions/_shared/types.ts");
  const pages = [{ party_name: "A", url: "https://a.example/p" }, { party_name: "B", url: "https://b.example/p" }, { party_name: "C", url: "https://c.example/p" }, { party_name: "D", url: "https://d.example/p" }];
  const fetch = async ({ url }: { url: string }) => {
    if (url.includes("a.example")) throw new IngestError("http_error", "publisher answered HTTP 404");
    if (url.includes("b.example")) throw new SourceUnavailableError("challenge", "challenge");
    return { status: 200, text: url.includes("c.example") ? `<title>C</title><script type="application/ld+json">{"datePublished":"2099-01-01T00:00:00Z"}</script>` : "<title>D</title>", bodySha256: H("a"), retrievedAt: "2026-09-20T01:00:00.000Z", finalUrl: url };
  };
  const out = [];
  const ctx = { source: { adapter_options: { pages } }, fetch, resumeCursor: null, maxRecords: 100, deadline: Date.parse("2026-09-20T02:00:00Z"), now: () => new Date("2026-09-20T01:00:00Z") };
  for await (const page of policyPageMonitorAdapter.pages(ctx as never)) out.push(page);
  assert.deepEqual(out.map((p) => [p.records[0].safe_payload.page_status, p.records[0].safe_payload.unavailable_outcome ?? null]), [["unavailable", "http_error"], ["unavailable", "challenge"], ["retrieved", null], ["retrieved", null]]);
  assert.equal(out[2].records[0].source_published_at, undefined, "a page date later than its own retrieval is not believed");
  assert.equal(out[3].records[0].safe_payload.page_digest, H("a"), "the page hash is stored, so the version hash can be recomputed");
  assert.equal(out.at(-1)!.completeSnapshot, true);
  const late = { ...ctx, now: () => new Date("2026-09-20T03:00:00Z"), fetch: async () => { throw new IngestError("timeout", "run deadline reached before request"); } };
  await assert.rejects(async () => { for await (const _ of policyPageMonitorAdapter.pages(late as never)) void _; }, /deadline/);
});

test("ingest record: collection time goes to retrieved_at only; publisher date only when stated", async () => {
  const [row] = foldVersions([mapElectorateResult(voteRow("r1", "Fixture Party", "party", 10))]);
  const record = await toIngestRecord(row);
  assert.equal(record.retrieved_at, "2026-09-19T09:00:00.000Z");
  assert.equal(record.source_published_at, undefined);
  assert.equal(record.original_content_hash, "sha256:" + H("c"));
  assert.match(record.content_hash, /^sha256:[0-9a-f]{64}$/);
});

/** In-memory stand-in for the store's version rules: same record + same content = unchanged. */
function memoryDb() {
  const versions = new Map<string, Set<string>>();
  const current = new Map<string, string>();
  const runs: { complete: boolean; inserted: number; conflicts: number }[] = [];
  let inRun = new Map<string, string>();
  const db: IngestDb = {
    syncRegistry: async () => null, syncSchedules: async () => 0, acquireLease: async () => true, releaseLease: async () => undefined,
    startRun: async () => { inRun = new Map(); runs.push({ complete: false, inserted: 0, conflicts: 0 }); return { run_id: `run-${runs.length}`, resumed_from_run_id: null, resume_cursor: null }; },
    ingestBatch: async (_run: string, _holder: string, records: IngestRecord[]): Promise<BatchResult> => {
      const result = { seen: 0, versions_inserted: 0, observations_inserted: 0, unchanged: 0, rejected: 0 };
      for (const record of records) {
        result.seen++;
        if (inRun.has(record.external_record_id) && inRun.get(record.external_record_id) !== record.content_hash) { result.rejected++; runs.at(-1)!.conflicts++; continue; }
        inRun.set(record.external_record_id, record.content_hash);
        const known = versions.get(record.external_record_id) ?? new Set<string>();
        if (known.has(record.content_hash)) result.unchanged++; else { known.add(record.content_hash); result.versions_inserted++; runs.at(-1)!.inserted++; }
        versions.set(record.external_record_id, known);
        current.set(record.external_record_id, record.content_hash);
        result.observations_inserted++;
      }
      return result;
    },
    saveCheckpoint: async () => 0, logFetch: async () => undefined, projectRun: async () => ({}),
    finishRun: async (_r, _h, status, complete) => { runs.at(-1)!.complete = complete; return { status, tombstoned: 0, error_class: null }; },
    close: async () => undefined,
  };
  return { db, versions, current, runs };
}

test("replay: waves never put two contents of one record in a run; a second load adds nothing", async () => {
  const folded = foldVersions([
    mapElectorateResult(voteRow("r1", "Fixture Party", "party", 10, H("1"))),
    { ...mapElectorateResult(voteRow("r1", "Fixture Party", "party", 11, H("2"))), collected_at: "2026-09-19T11:00:00.000Z" },
    { ...mapElectorateResult(voteRow("r1", "Fixture Party", "party", 12, H("3"))), collected_at: "2026-09-19T12:00:00.000Z" },
    mapElectorateResult(voteRow("r2", "Other Party", "party", 5, H("4"))),
  ]);
  const loaded = parseProduct("P09", exportFile(folded));
  const file = mergedSourcesFile();
  const source = ELECTION_EXPORT_SOURCES.find((e) => e.product === "P09")!.source;
  const store = memoryDb();
  const load = async () => {
    for (let wave = 1; wave <= 3; wave++) {
      const rows = waveRows(loaded.rows, wave, 3);
      const report = await runSource({ file, source, adapter: familyAdapter(rows, wave === 3, loaded.digest.sha256), mode: "export_import", triggerKind: "test", maxRecords: 1000, maxRuntimeSeconds: 60, dryRun: false, db: store.db, inputDigest: waveDigest(loaded, wave, 3, rows.length) });
      assert.equal(report.status, "succeeded");
      assert.equal(report.totals.rejected, 0);
    }
  };
  await load();
  assert.deepEqual(store.runs.map((r) => [r.complete, r.inserted, r.conflicts]), [[false, 1, 0], [false, 1, 0], [true, 2, 0]], "only the last wave is a complete snapshot");
  assert.equal(store.versions.get("r1")!.size, 3);
  const latestHash = store.current.get("r1");
  await load();
  assert.equal(store.runs.slice(3).reduce((s, r) => s + r.inserted, 0), 0, "replay inserts no version");
  assert.equal(store.current.get("r1"), latestHash, "replay ends on the same current version");
});

test("registry fragment: validates with the shared registry, is never schedulable, and the generic importer cannot load it", async () => {
  const file: SourcesFile = mergedSourcesFile();
  assert.deepEqual(validateSourcesFile(file), []);
  for (const { product, source } of ELECTION_EXPORT_SOURCES) {
    assert.equal(source.enabled, false);
    assert.deepEqual(source.allowed_hosts, []);
    assert.match(source.rights_id ?? "", /^RIGHTS-\d{2}$/);
    assert.equal(source.export_contract?.expectedInput?.sha256, ELECTION_PINS[product].sha256);
  }
  assert.equal(new Set(file.sources.map((s) => s.source_id)).size, file.sources.length);
  const p09 = ELECTION_EXPORT_SOURCES.find((e) => e.product === "P09")!.source;
  const rows = foldVersions([mapElectorateResult(voteRow("r1", "Fixture Party", "party", 10))]);
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()}/election-family-test-`);
  try {
    await writeFile(`${dir}/P09.jsonl`, exportFile(rows));
    const contract = { ...p09.export_contract!, expectedInput: undefined };
    const loaded = await loadExport(contract, { [contract.fileEnv]: `${dir}/P09.jsonl` });
    await assert.rejects(() => preflightExport(p09, contract, loaded, {}), /not the value this contract was written for/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("warehouse access: one plain select only", () => {
  assert.equal(assertReadOnlySelect("select a from t where b = 'drop table x';"), "select a from t where b = 'drop table x'");
  for (const sql of ["insert into t values (1)", "select 1; drop table t", "select 1 into outfile 'x'", "alter table t delete where 1", "with x as (select 1) select * from x", "select * from t; select 2", "select 1 into x"]) {
    assert.throws(() => assertReadOnlySelect(sql));
  }
});

test("exporter: reconciliation fails loudly when two routes disagree, instead of adding them up", async () => {
  const totalRow = upstream("nz_electoral_commission_2023_overall_results", "2023:nationwide:total", "https://www.electionresults.govt.nz/electionresults_2023/", { election_year: 2023, result_scope: "nationwide_party_vote_total", party_votes: 30 });
  const partyRow = upstream("nz_electoral_commission_2023_overall_results", "2023:nationwide:party:1", "https://www.electionresults.govt.nz/electionresults_2023/", { election_year: 2023, result_scope: "nationwide_party_vote", party_name: "Fixture Party", party_votes: 30 });
  const bySource: { [id: string]: WarehouseRow[] } = {
    nz_electoral_commission_2023_overall_results: [totalRow, partyRow],
    nz_electoral_commission_2023_electorate_results: [voteRow("v1", "Fixture Party", "party", 29), voteRow("v2", "FIXTURE, Alex", "candidate", 4, H("9"))],
  };
  const run = async (sql: string) => {
    const match = /source_id = '([a-z0-9_]+)'/.exec(sql);
    if (match) return (bySource[match[1]] ?? []) as unknown as { [c: string]: unknown }[];
    if (sql.includes("candidate_candidacies_snapshot")) return [{ captured_at: "2026-09-12 04:21:04.475", candidacy_id: "000000000000000000000000000f4243", candidate_name: "FIXTURE, Alex", candidacy_type: "electorate", candidate_votes: 4, source_url: PAGE }];
    return [];
  };
  const result = await buildExport(run, () => new Date("2026-09-20T00:00:00Z"));
  assert.equal(result.manifest.all_checks_ok, false);
  const cross = Object.fromEntries(result.manifest.cross_product.map((c) => [c.name, c.ok]));
  assert.equal(cross.p09_party_votes_equal_p08_nationwide_total, false, "29 across electorates against 30 nationwide is reported, not summed");
  assert.equal(cross.p09_candidate_lines_join_p04_by_identifier, true);
  assert.ok(!JSON.stringify(result.manifest).includes("/srv/"));
  const again = await buildExport(run, () => new Date("2026-09-21T00:00:00Z"));
  assert.deepEqual(again.manifest.files, result.manifest.files, "same upstream rows give byte-identical export files");
});

test("live routes: poll index dashes are not reported; page facts read a stated publication date only", () => {
  const html = `<table><thead><tr><th>Fieldwork Period</th><th>Polling Firm</th><th>Commissioner(s)</th><th>Sample Size</th><th>AAA</th><th>NZ&amp;B</th></tr></thead>
    <tbody><tr><td>2026-09-04 – 2026-09-11</td><td>Fixture Research</td><td>—</td><td>1,011</td><td>28%</td><td>—</td></tr>
    <tr><td>2026-08-01 – 2026-08-05</td><td>Other Polling</td><td>Fixture News</td><td>n/a</td><td>0.5</td><td>3%</td></tr></tbody></table>`;
  const rows = parsePollIndex(html);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].results, [{ party_label: "AAA", value_pct: 28, value_status: "reported" }, { party_label: "NZ&B", value_status: "not_reported" }]);
  assert.equal(rows[0].sample_size, 1011);
  assert.equal(rows[0].commissioner, undefined);
  assert.equal(rows[1].sample_size, undefined, "an unreadable sample size is absent, not zero");
  assert.throws(() => parsePollIndex(html.replace("28%", "about a quarter")), /neither a percentage nor a dash/);
  assert.throws(() => parsePollIndex(html.replace("Polling Firm", "Firm")), /column layout differs/);
  assert.throws(() => parsePollIndex("<table><thead><tr><th>Fieldwork Period</th><th>Polling Firm</th><th>Commissioner(s)</th><th>Sample Size</th><th>A</th><th>B</th></tr></thead><tbody></tbody></table>"), /no rows/);
  assert.deepEqual(pageFacts(`<title> Our  Policies </title><script type="application/ld+json">{"datePublished":"2026-09-16T03:59:07Z"}</script>`),
    { title: "Our Policies", published: "2026-09-16T03:59:07.000Z", publishedBasis: "JSON-LD datePublished on the page" });
  assert.equal(pageFacts("<title>x</title>").published, undefined);
});

test("migration: candidate lines never become a second candidate_results row; no class is assigned to a policy page", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/20260921010100_election_family.sql", import.meta.url), "utf-8");
  assert.ok(!/insert into evidence_private\.candidate_results/i.test(sql));
  assert.ok(!/insert into evidence_private\.(candidacies|person_source_identities|people)\b/i.test(sql), "the family creates no candidate and no person");
  assert.match(sql, /values \(v_doc, v_party, v_election, 'unknown', 'none'\)/);
  assert.ok(!/name_at_source\s*=|candidate_name\s*=/i.test(sql), "no join on a name");
});

test("real exports (only when EVIDENCE_EXPORT_ELECTION_DIR is set): pins, contracts and catalogue counts hold", { skip: !process.env.EVIDENCE_EXPORT_ELECTION_DIR }, async () => {
  const catalogue = JSON.parse(await readFile(new URL("../../catalogue/sources.json", import.meta.url), "utf-8")) as { product_id: string; record_count: number }[];
  for (const { product } of ELECTION_EXPORT_SOURCES) {
    const loaded = await loadProduct(product, process.env);
    const findings = preflight(loaded, ELECTION_PINS[product], null);
    const published = catalogue.find((c) => c.product_id === product);
    if (published) assert.equal(findings.records, published.record_count, `${product}: records equal the catalogue count`);
  }
});
