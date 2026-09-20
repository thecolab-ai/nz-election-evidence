// Select committee live adapters (reports index, business before committees). Every input is a hand-written fixture
// of the response SHAPE with obviously synthetic values. Nothing here is imported data; no test touches the network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { contentHash } from "../../supabase/functions/_shared/canonical.ts";
import { type Adapter, IngestError, type Json } from "../../supabase/functions/_shared/types.ts";
import { PARLIAMENT_PROJECTION_VERSION } from "../src/families/parliament/payload.ts";
import {
  committeeBusinessAdapter, committeeBusinessRecord, committeeBusinessRequestBody, parseCommitteeBusinessPage,
} from "../src/families/parliament/live/committee_business.ts";
import {
  committeeReportRecord, committeeReportsAdapter, committeeReportsRequestBody, parseCommitteeReportsPage,
} from "../src/families/parliament/live/committee_reports.ts";
import { cannedFetch, drain, fixtureContext, fixtureSource, payloadProblems } from "../src/families/parliament/live/test_support.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixtureReport(n: number, extra: { [key: string]: Json } = {}): { [key: string]: Json } {
  return {
    id: uuid(n), title: `Example Report Title ${n}`, subtitle: "Final Report", status: null, documentType: "SelectCommitteeReport", itemType: "Bill",
    selectCommittee: "Example Committee", parliamentNumber: 54, attachmentId: uuid(5000 + n), attachmentName: "example-file-name.pdf",
    publicationDate: "2026-07-31T00:00:00Z", lastModified: "2026-09-14T11:31:28.476Z", ...extra,
  };
}

function fixtureBusiness(n: number, extra: { [key: string]: Json } = {}): { [key: string]: Json } {
  return {
    id: uuid(n), title: `Example Business Item ${n}`, subtitle: "Government Bill", status: null, documentType: "Bill", itemType: null,
    selectCommittee: "Example Committee", parliamentNumber: 54, attachmentId: null, attachmentName: null,
    publicationDate: "2026-09-10T00:00:00Z", lastModified: "2026-09-19T16:15:14.188Z", ...extra,
  };
}

function publisher(rows: { [key: string]: Json }[], tweak?: (page: number) => { total?: number; rows?: { [key: string]: Json }[] } | undefined) {
  return cannedFetch((_request, body) => {
    const page = Number(body!.page);
    const size = Number(body!.pageSize);
    const changed = tweak?.(page);
    return JSON.stringify({ results: changed?.rows ?? rows.slice((page - 1) * size, page * size), pageSize: size, page, totalResults: changed?.total ?? rows.length });
  });
}

const source = (options: { [key: string]: Json } = {}) => fixtureSource({
  official_url: "https://selectcommittees.parliament.nz/", allowed_hosts: ["selectcommittees.parliament.nz"], snapshot_semantics: "complete_snapshot", adapter_options: options,
});

test("request bodies: reports index and business before committees; Parliament is a string", () => {
  assert.deepEqual(JSON.parse(committeeReportsRequestBody({ parliament: 54, page: 2, pageSize: 50 })),
    { keyword: "", documentPreset: 0, page: 2, pageSize: 50, column: 0, direction: 1, searchTab: "All", parliament: "54" });
  assert.deepEqual(JSON.parse(committeeBusinessRequestBody({ parliament: 54, page: 1, pageSize: 50 })),
    { keyword: "", documentPreset: 1, beforeCommittee: true, page: 1, pageSize: 50, column: 0, direction: 1, searchTab: "All", parliament: "54" });
});

test("committee report record: metadata and link only, absent values omitted, file name never kept", async () => {
  const record = await committeeReportRecord(fixtureReport(7), "2026-09-20T00:00:00.000Z");
  assert.equal(record.record_kind, "committee_report");
  assert.equal(record.external_record_id, uuid(7));
  assert.equal(record.source_url, "https://selectcommittees.parliament.nz/v/13/" + uuid(7));
  assert.equal(record.source_published_at, "2026-07-31T00:00:00.000Z");
  assert.deepEqual(Object.keys(record.safe_payload).sort(), ["attachment_ref", "document_type", "metadata_only", "parliament_number", "public_page_url",
    "publication_date", "report_type", "select_committee", "source_last_modified_at", "subtitle", "title"]);
  assert.ok(!("status_label" in record.safe_payload), "a null status is omitted, never null");
  assert.ok(!JSON.stringify(record).includes("example-file-name"));
  assert.deepEqual(payloadProblems(record), []);
});

test("committee business record: both source type labels kept when present; default public page", async () => {
  const record = await committeeBusinessRecord(fixtureBusiness(9, { itemType: "Government" }), "2026-09-20T00:00:00.000Z");
  assert.equal(record.record_kind, "committee_business_item");
  assert.equal(record.safe_payload.document_type, "Bill");
  assert.equal(record.safe_payload.item_type, "Government");
  assert.equal(record.safe_payload.public_page_url, "https://selectcommittees.parliament.nz/v/13/" + uuid(9));
  assert.ok(!("attachment_ref" in record.safe_payload));
  assert.deepEqual(payloadProblems(record), []);
});

test("a contact-like string in a title is masked; the hash ignores key order and retrieval time", async () => {
  const masked = await committeeReportRecord(fixtureReport(8, { title: "Example Report (contact clerk@example.invalid)" }), "2026-09-20T00:00:00.000Z");
  assert.equal(masked.safe_payload.title, "Example Report (contact [redacted])");
  assert.ok(masked.omitted_fields.some((o) => o.field === "title"));
  assert.deepEqual(payloadProblems(masked), []);

  const row = fixtureReport(10);
  const a = await committeeReportRecord(row, "2026-09-20T00:00:00.000Z");
  const b = await committeeReportRecord(Object.fromEntries(Object.entries(row).reverse()), "2026-09-22T00:00:00.000Z");
  assert.equal(a.content_hash, b.content_hash);
  assert.equal(await contentHash("committee_report", PARLIAMENT_PROJECTION_VERSION, Object.fromEntries(Object.entries(a.safe_payload).reverse())), a.content_hash);
});

test("hostile input: not JSON, an empty listing, a row outside the filter, a missing id", async () => {
  assert.throws(() => parseCommitteeReportsPage("<html>challenge</html>", 54, 50), (e: IngestError) => e.errorClass === "parse_error");
  assert.throws(() => parseCommitteeReportsPage(JSON.stringify({ totalResults: 0, results: [] }), 54, 50), IngestError, "an empty listing is a fault, not zero reports");
  assert.throws(() => parseCommitteeReportsPage(JSON.stringify({ totalResults: 1, results: [fixtureReport(1, { parliamentNumber: 53 })] }), 54, 50), /requested Parliament/);
  assert.throws(() => parseCommitteeReportsPage(JSON.stringify({ totalResults: 1, results: [fixtureBusiness(1)] }), 54, 50), /unexpected document type/);
  assert.throws(() => parseCommitteeBusinessPage(JSON.stringify({ totalResults: 3, results: [fixtureBusiness(1), fixtureBusiness(2), fixtureBusiness(3)] }), 54, 2), /page size/);
  await assert.rejects(committeeReportRecord(fixtureReport(1, { id: undefined as unknown as Json }), "x"), (e: IngestError) => e.errorClass === "parse_error");
  await assert.rejects(committeeBusinessRecord(fixtureBusiness(1, { id: "not-a-publisher-id" }), "x"), (e: IngestError) => e.errorClass === "parse_error");
});

const cases: { label: string; adapter: Adapter; rows: (count: number) => { [key: string]: Json }[] }[] = [
  { label: "reports", adapter: committeeReportsAdapter, rows: (count) => Array.from({ length: count }, (_, i) => fixtureReport(i + 1)) },
  { label: "business", adapter: committeeBusinessAdapter, rows: (count) => Array.from({ length: count }, (_, i) => fixtureBusiness(i + 1)) },
];

for (const { label, adapter, rows } of cases) {
  test(`${label}: a full walk is a complete snapshot; anonymous POST to the search endpoint only`, async () => {
    const { fetch, calls } = publisher(rows(5));
    const result = await drain(adapter, fixtureContext({ source: source({ page_size: 2 }), fetch }));
    assert.equal(result.records.length, 5);
    assert.deepEqual(result.pages.map((p) => [p.done, p.completeSnapshot]), [[false, false], [false, false], [true, true]]);
    assert.deepEqual(result.pages[0].cursor, { next_page: 2, total: 5, page_size: 2 });
    assert.ok(calls.every((c) => c.request.method === "POST" && c.request.url === "https://selectcommittees.parliament.nz/api/data/search"));
    for (const call of calls) for (const header of Object.keys(call.request.headers ?? {})) assert.ok(!/origin|referer|cookie|authorization/i.test(header));
  });

  test(`${label}: a budget stop leaves done=false; the next run resumes from the cursor and is not a complete snapshot`, async () => {
    const first = publisher(rows(7));
    const partial = await drain(adapter, fixtureContext({ source: source({ page_size: 2 }), fetch: first.fetch, maxRecords: 5 }));
    assert.equal(partial.records.length, 4, "no page is fetched unless all of it can be stored");
    assert.equal(partial.last!.done, false);
    const second = publisher(rows(7));
    const rest = await drain(adapter, fixtureContext({ source: source({ page_size: 2 }), fetch: second.fetch, resumeCursor: partial.last!.cursor }));
    assert.equal(second.calls[0].body!.page, 3);
    assert.equal(rest.last!.done, true);
    assert.equal(rest.last!.completeSnapshot, false, "a resumed walk never claims to be the whole list");
    assert.equal(new Set([...partial.records, ...rest.records].map((r) => r.external_record_id)).size, 7);
  });

  test(`${label}: a total that changes between pages, or an id seen twice, fails the run`, async () => {
    const drifting = publisher(rows(6), (page) => (page === 2 ? { total: 7 } : undefined));
    await assert.rejects(drain(adapter, fixtureContext({ source: source({ page_size: 2 }), fetch: drifting.fetch })), (e: IngestError) => e.errorClass === "source_changed_during_pagination");
    const all = rows(4);
    const repeating = publisher(all, (page) => (page === 2 ? { rows: [all[0], all[3]] } : undefined));
    await assert.rejects(drain(adapter, fixtureContext({ source: source({ page_size: 2 }), fetch: repeating.fetch })), /duplicate/);
    const stale = publisher(rows(6));
    await assert.rejects(drain(adapter, fixtureContext({ source: source({ page_size: 2 }), fetch: stale.fetch, resumeCursor: { next_page: 2, total: 9, page_size: 2 } })),
      (e: IngestError) => e.errorClass === "source_changed_during_pagination");
  });

  test(`${label}: a list that ends short of the publisher's total is done but never a complete snapshot`, async () => {
    const short = publisher(rows(3), (page) => (page === 2 ? { total: 3, rows: [] } : { total: 3 }));
    const result = await drain(adapter, fixtureContext({ source: source({ page_size: 2 }), fetch: short.fetch }));
    assert.equal(result.last!.done, true);
    assert.equal(result.last!.completeSnapshot, false);
  });
}
