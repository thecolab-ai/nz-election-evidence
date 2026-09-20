// Written questions live adapter. Every input here is a hand-written fixture of the response SHAPE with obviously
// synthetic values. Nothing in this file is imported data, and no test touches the network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, contentHash } from "../../supabase/functions/_shared/canonical.ts";
import { IngestError, type Json } from "../../supabase/functions/_shared/types.ts";
import { PARLIAMENT_PROJECTION_VERSION } from "../src/families/parliament/payload.ts";
import { cannedFetch, drain, fixtureContext, fixtureSource, payloadProblems } from "../src/families/parliament/live/test_support.ts";
import {
  followingMonth, monthPartitions, parseQuestionsPage, partitionBounds, questionRecord, questionsRequestBody, writtenQuestionsAdapter,
} from "../src/families/parliament/live/written_questions.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixtureQuestion(n: number, month: string, extra: { [key: string]: Json } = {}): { [key: string]: Json } {
  return {
    id: uuid(n), writtenQuestionsDocumentId: `WQ_${n}_2026`, parliamentNumber: 54, documentType: "WrittenQuestion",
    title: `${n} (2026). Example Member to the Minister for Examples`, statusId: 1, questionNumber: n, questionYear: 2026,
    questionText: `EXAMPLE QUESTION TEXT ${n} that must never be stored`, questionReleasedDate: `${month}-05T00:00:00Z`,
    memberId: uuid(900000 + n), roleId: null, portfolioId_PortfolioMinister: "0000AAAA-0000-4000-8000-00000000000A_1",
    replyText: `EXAMPLE REPLY TEXT ${n} that must never be stored`, ministerName: "Hon Example Minister",
    ministerialDisplayName: "Minister for Examples", attachmentId: null, attachmentName: "example-file-name.pdf", attachmentSize: 0,
    lastModified: "2026-09-06T01:02:03.004Z", ...extra,
  };
}

/** A fake publisher: `corpus[month]` is that month's questions in ascending order. */
function publisher(corpus: { [month: string]: { [key: string]: Json }[] }, tweak?: (month: string, page: number, call: number) => { total?: number; rows?: { [key: string]: Json }[] } | undefined) {
  return cannedFetch((_request, body, call) => {
    const month = String(body!.dateFrom).slice(0, 7);
    const page = Number(body!.page);
    const size = Number(body!.pageSize);
    const all = corpus[month] ?? [];
    const changed = tweak?.(month, page, call);
    const rows = changed?.rows ?? all.slice((page - 1) * size, page * size);
    return JSON.stringify({ pageSize: rows.length ? size : 0, page, "@odata.count": changed?.total ?? all.length, value: rows });
  });
}

const source = (options: { [key: string]: Json }) => fixtureSource({
  official_url: "https://questions.parliament.nz/", allowed_hosts: ["questions.parliament.nz"], snapshot_semantics: "append_only_feed", adapter_options: options,
});
const range = (from: number, count: number, month: string) => Array.from({ length: count }, (_, i) => fixtureQuestion(from + i, month));

test("request body: month bounds are inclusive, Parliament is a string, order is ascending", () => {
  assert.deepEqual(partitionBounds("2024-02"), { from: "2024-02-01", to: "2024-02-29" });
  assert.deepEqual(JSON.parse(questionsRequestBody({ parliament: 54, partition: "2026-09", page: 3, pageSize: 100 })),
    { page: 3, pageSize: 100, parliament: "54", dateFrom: "2026-09-01", dateTo: "2026-09-30", column: 0, direction: 0 });
  assert.throws(() => partitionBounds("2026-13"), IngestError);
  assert.equal(followingMonth("2025-12"), "2026-01");
});

test("partitions: oldest first, through the month current in New Zealand", () => {
  assert.deepEqual(monthPartitions("2023-11-01", new Date("2024-02-10T00:00:00Z")), ["2023-11", "2023-12", "2024-01", "2024-02"]);
  // 31 August 13:00 UTC is already 1 September in New Zealand.
  assert.equal(monthPartitions("2026-08-01", new Date("2026-08-31T13:00:00Z")).at(-1), "2026-09");
});

test("record: identifiers, people and metadata only; question and reply text never stored", async () => {
  const record = await questionRecord(fixtureQuestion(41, "2026-09", { attachmentId: uuid(77), attachmentSize: 2048 }), "2026-09-20T00:00:00.000Z");
  assert.equal(record.record_kind, "written_question");
  assert.equal(record.external_record_id, uuid(41));
  assert.equal(record.source_url, "https://questions.parliament.nz/written-questions/detail/" + uuid(41));
  assert.equal(record.source_published_at, "2026-09-05T00:00:00.000Z");
  assert.equal(record.source_date_text, "2026-09-05T00:00:00Z");
  const p = record.safe_payload;
  assert.equal(p.asker_name_at_source, "Example Member");
  assert.equal(p.question_released_on, "2026-09-05");
  assert.equal(p.reply_present, true);
  assert.equal(p.attachment_present, true);
  assert.equal(p.attachment_bytes, 2048);
  assert.equal(p.metadata_only, true);
  assert.match(String(p.question_text_sha256), /^[0-9a-f]{64}$/);
  assert.equal(p.question_text_chars, [..."EXAMPLE QUESTION TEXT 41 that must never be stored"].length);
  assert.ok(!("role_ref" in p), "an absent source value is omitted, never null");
  const text = JSON.stringify(record);
  for (const leaked of ["EXAMPLE QUESTION TEXT", "EXAMPLE REPLY TEXT", "questionText\":", "replyText\":", "example-file-name"]) assert.ok(!text.includes(leaked), leaked);
  assert.deepEqual(record.omitted_fields.map((o) => o.field).sort(), ["attachmentName", "questionText", "replyText"]);
  assert.deepEqual(payloadProblems(record), []);
});

test("record: characters are counted as code points; an empty reply is absent, not zero", async () => {
  const record = await questionRecord(fixtureQuestion(42, "2026-09", { questionText: "Tēnā 👍", replyText: "   " }), "2026-09-20T00:00:00.000Z");
  assert.equal(record.safe_payload.question_text_chars, 6);
  assert.equal(record.safe_payload.reply_present, false);
  assert.ok(!("reply_text_sha256" in record.safe_payload) && !("reply_text_chars" in record.safe_payload));
});

test("record: a contact-like string in a title is masked before hashing and the masking is recorded", async () => {
  const record = await questionRecord(fixtureQuestion(43, "2026-09", { title: "43 (2026). Example Member to the Minister for Examples (write to someone@example.invalid)" }), "2026-09-20T00:00:00.000Z");
  assert.ok(String(record.safe_payload.title).includes("[redacted]"));
  assert.ok(!JSON.stringify(record).includes("example.invalid"));
  assert.ok(record.omitted_fields.some((o) => o.field === "title"));
  assert.deepEqual(payloadProblems(record), []);
});

test("record: the content hash does not depend on key order, in the source row or in the payload", async () => {
  const row = fixtureQuestion(44, "2026-09");
  const reversed = Object.fromEntries(Object.entries(row).reverse());
  const a = await questionRecord(row, "2026-09-20T00:00:00.000Z");
  const b = await questionRecord(reversed, "2026-09-21T09:09:09.000Z");
  assert.equal(a.content_hash, b.content_hash, "retrieval time and key order are outside the hash");
  const shuffled = Object.fromEntries(Object.entries(a.safe_payload).reverse());
  assert.equal(await contentHash("written_question", PARLIAMENT_PROJECTION_VERSION, shuffled), a.content_hash);
  assert.equal(canonicalJson(shuffled), canonicalJson(a.safe_payload));
  const replied = await questionRecord({ ...row, replyText: "EXAMPLE REPLY TEXT changed later" }, "2026-09-20T00:00:00.000Z");
  assert.notEqual(replied.content_hash, a.content_hash, "a changed reply is visible through its digest");
});

test("hostile input: not JSON, missing id, a row outside the filter, too many rows", async () => {
  const query = { parliament: 54, partition: "2026-09", page: 1, pageSize: 2 };
  assert.throws(() => parseQuestionsPage("<html>challenge</html>", query), (e: IngestError) => e.errorClass === "parse_error");
  assert.throws(() => parseQuestionsPage(JSON.stringify({ value: [] }), query), IngestError);
  assert.throws(() => parseQuestionsPage(JSON.stringify({ "@odata.count": 1, value: [fixtureQuestion(1, "2026-08")] }), query), /requested month/);
  assert.throws(() => parseQuestionsPage(JSON.stringify({ "@odata.count": 1, value: [fixtureQuestion(1, "2026-09", { parliamentNumber: 53 })] }), query), /requested Parliament/);
  assert.throws(() => parseQuestionsPage(JSON.stringify({ "@odata.count": 9, value: range(1, 3, "2026-09") }), query), /page size/);
  await assert.rejects(questionRecord(fixtureQuestion(1, "2026-09", { id: null }), "x"), (e: IngestError) => e.errorClass === "parse_error");
  await assert.rejects(questionRecord(fixtureQuestion(1, "2026-09", { id: "../../etc" }), "x"), (e: IngestError) => e.errorClass === "parse_error");
});

test("incremental: only the newest months, paginated, done at the end, never a complete snapshot", async () => {
  const { fetch, calls } = publisher({ "2026-07": range(1, 9, "2026-07"), "2026-08": range(100, 5, "2026-08"), "2026-09": range(200, 3, "2026-09") });
  const result = await drain(writtenQuestionsAdapter, fixtureContext({ source: source({ page_size: 2 }), fetch }));
  assert.deepEqual([...new Set(calls.map((c) => String(c.body!.dateFrom)))], ["2026-08-01", "2026-09-01"]);
  assert.equal(result.records.length, 8);
  assert.equal(result.last!.done, true);
  assert.ok(result.pages.every((page) => page.completeSnapshot === false));
  assert.deepEqual(result.pages[0].cursor, { mode: "incremental", partition: "2026-08", next_page: 2, page_size: 2, partition_total: 5 });
  assert.deepEqual(result.pages[2].cursor, { mode: "incremental", partition: "2026-09", next_page: 1, page_size: 2, partition_total: null });
  assert.equal(calls.every((c) => c.request.method === "POST" && c.request.url === "https://questions.parliament.nz/api/data/search"), true);
  for (const call of calls) for (const header of Object.keys(call.request.headers ?? {})) assert.ok(!/origin|referer|cookie|authorization/i.test(header));
});

test("backfill: walks every month from backfill_from, empty months included, and resumes from the cursor", async () => {
  const corpus = { "2026-07": range(1, 5, "2026-07"), "2026-09": range(200, 3, "2026-09") };
  const first = publisher(corpus);
  const options = { mode: "backfill", backfill_from: "2026-06-01", page_size: 2 };
  // Budget for two pages only: the run stops early and says so.
  const partial = await drain(writtenQuestionsAdapter, fixtureContext({ source: source(options), fetch: first.fetch, maxRecords: 5 }));
  assert.equal(partial.last!.done, false, "a budget stop leaves done=false so the runner records a partial run");
  assert.equal(partial.records.length, 4, "no page is fetched unless all of it can be stored");
  assert.deepEqual(partial.last!.cursor, { mode: "backfill", partition: "2026-07", next_page: 3, page_size: 2, partition_total: 5 });

  const second = publisher(corpus);
  const rest = await drain(writtenQuestionsAdapter, fixtureContext({ source: source(options), fetch: second.fetch, resumeCursor: partial.last!.cursor }));
  assert.deepEqual(second.calls[0].body, { page: 3, pageSize: 2, parliament: "54", dateFrom: "2026-07-01", dateTo: "2026-07-31", column: 0, direction: 0 });
  assert.equal(rest.last!.done, true);
  const ids = [...partial.records, ...rest.records].map((r) => r.external_record_id);
  assert.equal(new Set(ids).size, 8);
  assert.equal(ids.length, 8, "resume neither skips nor repeats");
  assert.ok(second.calls.some((c) => c.body!.dateFrom === "2026-08-01"), "an empty month is asked about, then passed over");
});

test("a run past its deadline margin stops before another request", async () => {
  const { fetch, calls } = publisher({ "2026-09": range(1, 6, "2026-09") });
  let clock = Date.parse("2026-09-20T00:00:00Z");
  const ctx = fixtureContext({ source: source({ incremental_months: 1, page_size: 2 }), fetch, now: () => new Date(clock), deadline: clock + 60_000 });
  const pages = [];
  for await (const page of writtenQuestionsAdapter.pages(ctx)) {
    pages.push(page);
    clock += 50_000;
  }
  assert.equal(calls.length, 1);
  assert.equal(pages[0].done, false);
});

test("drift: a month that grows is carried on; a month that shrinks is read again from its first page", async () => {
  const month = range(1, 6, "2026-09");
  const grown = publisher({ "2026-09": month }, (_m, page) => (page >= 2 ? { total: 7 } : undefined));
  const a = await drain(writtenQuestionsAdapter, fixtureContext({ source: source({ incremental_months: 1, page_size: 2 }), fetch: grown.fetch }));
  assert.equal(grown.calls.length, 4, "ascending order: additions land after the position already read");
  assert.equal(new Set(a.records.map((r) => r.external_record_id)).size, 6);

  let shrunkOnce = false;
  const shrunk = publisher({ "2026-09": month }, (_m, page) => {
    if (page === 2 && !shrunkOnce) {
      shrunkOnce = true;
      return { total: 5 };
    }
    return undefined;
  });
  const b = await drain(writtenQuestionsAdapter, fixtureContext({ source: source({ incremental_months: 1, page_size: 2 }), fetch: shrunk.fetch }));
  assert.deepEqual(shrunk.calls.map((c) => c.body!.page), [1, 2, 1, 2, 3], "only that month restarts; the run does not fail");
  assert.equal(b.last!.done, true);
  assert.equal(new Set(b.records.map((r) => r.external_record_id)).size, 6);
});

test("hostile input: an id repeated across pages restarts the month, then fails the run instead of looping", async () => {
  const month = range(1, 4, "2026-09");
  const { fetch, calls } = publisher({ "2026-09": month }, (_m, page) => (page === 2 ? { rows: [month[0], month[3]] } : undefined));
  await assert.rejects(drain(writtenQuestionsAdapter, fixtureContext({ source: source({ incremental_months: 1, page_size: 2 }), fetch })),
    (e: IngestError) => e.errorClass === "source_changed_during_pagination");
  assert.equal(calls.length, 6, "two bounded restarts, then a fault");
});

test("every month empty: a fault when the Parliament has no questions at all, a quiet window when it has", async () => {
  const empty = publisher({});
  await assert.rejects(drain(writtenQuestionsAdapter, fixtureContext({ source: source({}), fetch: empty.fetch })), (e: IngestError) => e.errorClass === "parse_error");
  assert.equal(empty.calls.at(-1)!.body!.dateFrom, undefined, "the confirming count carries no date filter");

  // A recess: nothing released in the window, but the Parliament's corpus is there.
  const recess = cannedFetch((_request, body) => JSON.stringify(body!.dateFrom === undefined
    ? { pageSize: 1, page: 1, "@odata.count": 1234, value: [fixtureQuestion(1, "2026-03")] }
    : { pageSize: 0, page: 1, "@odata.count": 0, value: [] }));
  const quiet = await drain(writtenQuestionsAdapter, fixtureContext({ source: source({}), fetch: recess.fetch }));
  assert.equal(quiet.records.length, 0);
  assert.equal(quiet.last!.done, true);
  assert.equal(recess.calls.length, 3);
});

test("bad options fail before any request", async () => {
  const never = publisher({});
  await assert.rejects(drain(writtenQuestionsAdapter, fixtureContext({ source: source({ mode: "everything" }), fetch: never.fetch })), (e: IngestError) => e.errorClass === "invalid_adapter_options");
  await assert.rejects(drain(writtenQuestionsAdapter, fixtureContext({ source: source({ page_size: 100000 }), fetch: never.fetch })), (e: IngestError) => e.errorClass === "invalid_adapter_options");
  await assert.rejects(drain(writtenQuestionsAdapter, fixtureContext({ source: source({ backfill_from: "last year" }), fetch: never.fetch })), (e: IngestError) => e.errorClass === "invalid_adapter_options");
  assert.equal(never.calls.length, 0);
});

test("a cursor past the last month means the earlier attempt had finished: nothing is fetched again", async () => {
  const { fetch, calls } = publisher({ "2026-09": range(1, 2, "2026-09") });
  const result = await drain(writtenQuestionsAdapter, fixtureContext({ source: source({}), fetch, resumeCursor: { mode: "incremental", partition: "2026-10", next_page: 1, page_size: 100, partition_total: null } }));
  assert.equal(calls.length, 0);
  assert.equal(result.last!.done, true);
});

test("a changed page size converts the cursor so nothing before the old position is skipped", async () => {
  const { fetch, calls } = publisher({ "2026-09": range(1, 10, "2026-09") });
  // Old cursor: page 3 of size 2 (4 rows read). New size 3 resumes at page 2 (rows 4 to 6): one row is read twice, none skipped.
  await drain(writtenQuestionsAdapter, fixtureContext({ source: source({ incremental_months: 1, page_size: 3 }), fetch, resumeCursor: { mode: "incremental", partition: "2026-09", next_page: 3, page_size: 2, partition_total: 10 } }));
  assert.equal(calls[0].body!.page, 2);
});
