// Bill publications live adapter. Every input is a hand-written fixture of the response or page SHAPE with obviously
// synthetic values. Nothing here is imported data; no test touches the network; no PDF or bill text is involved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { contentHash } from "../../supabase/functions/_shared/canonical.ts";
import { IngestError, type Json, type SafeFetchRequest, SourceUnavailableError } from "../../supabase/functions/_shared/types.ts";
import { PARLIAMENT_PROJECTION_VERSION } from "../src/families/parliament/payload.ts";
import {
  billPublicationRecords, billPublicationsAdapter, legislationBillPath, parseBillDetail, parseVersionsIndex, versionsIndexUrl,
} from "../../supabase/functions/_shared/adapters/parliament/live/bill_publications.ts";
import { cannedFetch, drain, fixtureContext, fixtureSource, payloadProblems } from "../../supabase/functions/_shared/adapters/parliament/live/test_support.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface FixtureBill {
  n: number;
  legislation?: string | null;
  initiation?: string | null;
  tokens?: string[];
  index?: "404" | "challenge" | "garbage";
}

function detailBody(bill: FixtureBill, extra: { [key: string]: Json } = {}): string {
  return JSON.stringify({
    Id: uuid(bill.n), DocumentType: "Bill", Title: `Example Bill ${bill.n}`, ParliamentNumber: 54, BillNumber: `${bill.n}-1`,
    BillStatusName: "Active", BillCurrentStageName: "First Reading",
    BillLegislationUrl: bill.legislation === undefined ? `https://www.legislation.govt.nz/bill/government/2026/${bill.n}/en/latest/` : bill.legislation,
    InitiationDate: bill.initiation === undefined ? "2026-02-03T00:00:00+13:00" : bill.initiation,
    Description: "EXAMPLE SUMMARY TEXT that must never be stored", ...extra,
  });
}

function indexPage(n: number, tokens: string[], nextPage?: number): string {
  const cards = tokens.map((token) => `<div class="card version-card" id="version-${token}"><a href="/bill/government/2026/${n}/en/latest/">Example Bill ${n}</a>
    <a role="button" download="Example Bill" href="/bill/government/2026/${n}/en/${token}.pdf">Download (PDF 10 KB)</a>
    <a href="/bill/government/2026/${n}/en/${token}.pdf">again</a></div>`).join("\n");
  const pager = nextPage ? `<nav aria-label="Versions pages"><a href="/bill/government/2026/${n}/en/${tokens[0]}/versions/?per_page=100&amp;sort=asc&amp;page=${nextPage}">Next</a></nav>` : "";
  return `<!DOCTYPE html><html lang="en"><body><ol class="breadcrumb"><li>Versions</li></ol>${cards}${pager}
    <a href="/bill/government/2020/999/en/2020-01-01.pdf">another bill, ignored</a><a href="/act/public/2020/1/en/latest.pdf">ignored</a></body></html>`;
}

function publisher(bills: FixtureBill[], tweak?: (request: SafeFetchRequest) => string | undefined) {
  return cannedFetch((request, body) => {
    const changed = tweak?.(request);
    if (changed !== undefined) return changed;
    const url = new URL(request.url);
    if (url.hostname === "bills.parliament.nz" && request.method === "POST") {
      const page = Number(body!.page);
      const rows = bills.slice((page - 1) * 50, page * 50).map((bill) => ({ id: uuid(bill.n), title: `Example Bill ${bill.n}`, parliamentNumber: 54 }));
      return JSON.stringify({ totalResults: bills.length, results: rows });
    }
    if (url.hostname === "bills.parliament.nz") {
      const bill = bills.find((b) => url.pathname.endsWith(uuid(b.n)))!;
      return detailBody(bill);
    }
    const bill = bills.find((b) => url.pathname.startsWith(`/bill/government/2026/${b.n}/`))!;
    if (bill.index === "404") throw new IngestError("http_error", "publisher answered HTTP 404");
    if (bill.index === "challenge") throw new SourceUnavailableError("challenge", "publisher answered with a challenge page instead of content");
    if (bill.index === "garbage") return "<!DOCTYPE html><html><body>Service notice</body></html>";
    const page = Number(url.searchParams.get("page"));
    const tokens = bill.tokens ?? ["2026-02-03"];
    return tokens.length > 2 ? indexPage(bill.n, page === 1 ? tokens.slice(0, 2) : tokens.slice(2), page === 1 ? 2 : undefined) : indexPage(bill.n, tokens);
  });
}

const source = fixtureSource({ official_url: "https://bills.parliament.nz/", allowed_hosts: ["bills.parliament.nz", "www.legislation.govt.nz"] });

test("bill detail: identity is checked; the publisher's own date is kept as written", () => {
  const detail = parseBillDetail(detailBody({ n: 5 }), uuid(5));
  assert.deepEqual(detail, { id: uuid(5), billNumber: "5-1", title: "Example Bill 5", currentStage: "First Reading", status: "Active", parliamentNumber: 54,
    legislationUrl: "https://www.legislation.govt.nz/bill/government/2026/5/en/latest/", initiationDay: "2026-02-03" });
  assert.throws(() => parseBillDetail(detailBody({ n: 5 }), uuid(6)), /does not match/);
  assert.throws(() => parseBillDetail("<html>challenge</html>", uuid(5)), (e: IngestError) => e.errorClass === "parse_error");
});

test("legislation link: both address styles give one bill path; anything else gives none", () => {
  assert.equal(legislationBillPath("https://www.legislation.govt.nz/bill/government/2026/344/en/latest/"), "bill/government/2026/344/en");
  assert.equal(legislationBillPath("https://www.legislation.govt.nz/bill/member/2025/0126/latest/whole.html"), "bill/member/2025/126/en");
  assert.equal(legislationBillPath("https://legislation.example.invalid/bill/government/2026/344/en/latest/"), undefined);
  assert.equal(legislationBillPath("http://www.legislation.govt.nz/bill/government/2026/344/en/latest/"), undefined);
  assert.equal(legislationBillPath("https://www.legislation.govt.nz/act/public/2020/1/en/latest/"), undefined);
  assert.equal(versionsIndexUrl("bill/government/2026/344/en", "2026-09-10", 1), "https://www.legislation.govt.nz/bill/government/2026/344/en/2026-09-10/versions/?per_page=100&sort=asc&page=1");
});

test("versions index: this bill's PDF links only, once each; a page that is not an index is a fault", () => {
  const parsed = parseVersionsIndex(indexPage(12, ["2026-02-03", "2026-06-30"], 2), "bill/government/2026/12/en", 1);
  assert.deepEqual(parsed.revisions, [
    { revisionId: "bill/government/2026/12/en/2026-02-03.pdf", versionToken: "2026-02-03", pdfUrl: "https://www.legislation.govt.nz/bill/government/2026/12/en/2026-02-03.pdf" },
    { revisionId: "bill/government/2026/12/en/2026-06-30.pdf", versionToken: "2026-06-30", pdfUrl: "https://www.legislation.govt.nz/bill/government/2026/12/en/2026-06-30.pdf" },
  ]);
  assert.equal(parsed.hasNextPage, true);
  assert.equal(parseVersionsIndex(indexPage(12, ["2026-02-03"]), "bill/government/2026/12/en", 1).hasNextPage, false);
  assert.throws(() => parseVersionsIndex("<!DOCTYPE html><html><body>Service notice</body></html>", "bill/government/2026/12/en", 1), (e: IngestError) => e.errorClass === "parse_error");
  assert.throws(() => parseVersionsIndex("{}", "bill/government/2026/12/en", 1), IngestError);
});

test("records: a set and its revisions, metadata only; unknown is not zero", async () => {
  const detail = parseBillDetail(detailBody({ n: 12 }), uuid(12));
  const url = versionsIndexUrl("bill/government/2026/12/en", "2026-02-03", 1);
  const revisions = parseVersionsIndex(indexPage(12, ["2026-02-03", "2026-06-30"]), "bill/government/2026/12/en", 1).revisions;
  const [set, first] = await billPublicationRecords(detail, { url, revisions }, "2026-09-20T00:00:00.000Z");
  assert.equal(set.record_kind, "bill_publication_set");
  assert.equal(set.external_record_id, uuid(12));
  assert.equal(set.safe_payload.publication_revision_count, 2);
  assert.equal(set.safe_payload.public_page_url, "https://www.legislation.govt.nz/bill/government/2026/12/en/latest/");
  assert.equal(first.record_kind, "bill_publication");
  assert.equal(first.external_record_id, "bill_government_2026_12_en_2026-02-03.pdf");
  assert.equal(first.safe_payload.revision_ref, "bill/government/2026/12/en/2026-02-03.pdf");
  assert.equal(first.safe_payload.version_date, "2026-02-03");
  assert.equal(first.safe_payload.bill_ref, uuid(12));
  assert.equal(first.safe_payload.version_index_url, url);
  assert.equal(first.safe_payload.public_page_url, first.safe_payload.official_pdf_url);
  assert.equal(first.source_published_at, "2026-02-03T00:00:00.000Z");
  for (const record of [set, first]) {
    assert.deepEqual(payloadProblems(record), []);
    assert.ok(!JSON.stringify(record).includes("EXAMPLE SUMMARY TEXT"));
    assert.equal(await contentHash(record.record_kind, PARLIAMENT_PROJECTION_VERSION, Object.fromEntries(Object.entries(record.safe_payload).reverse())), record.content_hash);
  }

  const [listedNone] = await billPublicationRecords(detail, { url, revisions: [] }, "x");
  assert.equal(listedNone.safe_payload.publication_revision_count, 0, "zero only when the index was read and listed none");
  const [unavailable] = await billPublicationRecords(detail, "unavailable", "x");
  assert.equal(unavailable.safe_payload.publication_index_status, "unavailable");
  assert.ok(!("publication_revision_count" in unavailable.safe_payload));
  const [noLink] = await billPublicationRecords(parseBillDetail(detailBody({ n: 12, legislation: null }), uuid(12)), "none", "x");
  assert.ok(!("legislation_url" in noLink.safe_payload) && !("publication_revision_count" in noLink.safe_payload) && !("publication_index_status" in noLink.safe_payload));
  assert.equal(noLink.safe_payload.public_page_url, "https://bills.parliament.nz/v/6/" + uuid(12));
});

test("a contact-like string in a bill title is masked in both record kinds", async () => {
  const detail = parseBillDetail(detailBody({ n: 13 }, { Title: "Example Bill (queries to office@example.invalid)" }), uuid(13));
  const revisions = parseVersionsIndex(indexPage(13, ["2026-02-03"]), "bill/government/2026/13/en", 1).revisions;
  const records = await billPublicationRecords(detail, { url: versionsIndexUrl("bill/government/2026/13/en", "2026-02-03", 1), revisions }, "x");
  for (const record of records) {
    assert.ok(!JSON.stringify(record).includes("example.invalid"));
    assert.deepEqual(payloadProblems(record), []);
  }
  assert.equal(records[0].safe_payload.title, "Example Bill (queries to [redacted])");
});

test("adapter: one page per bill in id order, index pagination followed, only metadata pages requested", async () => {
  const { fetch, calls } = publisher([{ n: 3, tokens: ["2026-02-03", "2026-05-01", "2026-08-01"] }, { n: 1 }, { n: 2, legislation: null }]);
  const result = await drain(billPublicationsAdapter, fixtureContext({ source, fetch }));
  assert.deepEqual(result.pages.map((p) => p.records.map((r) => r.record_kind === "bill_publication_set" ? "set" : "pub").join(",")), ["set,pub", "set", "set,pub,pub,pub"]);
  assert.deepEqual(result.pages.map((p) => (p.cursor as { after_bill_id: string }).after_bill_id), [uuid(1), uuid(2), uuid(3)]);
  assert.equal(result.last!.done, true);
  assert.ok(result.pages.every((p) => p.completeSnapshot === false), "never a snapshot: a bill leaving the list must not tombstone served revisions");
  assert.equal(result.pages[2].records[0].safe_payload.publication_revision_count, 3);
  for (const call of calls) {
    assert.ok(!/\.pdf(\?|$)/.test(call.request.url), "a PDF is never requested");
    assert.ok(/\/api\/data\/(search|Bill\/)|\/versions\/\?/.test(call.request.url), "only the list, the detail and the versions index: " + call.request.url);
    for (const header of Object.keys(call.request.headers ?? {})) assert.ok(!/origin|referer|cookie|authorization/i.test(header));
  }
});

test("adapter: an index that is not found is recorded as unavailable; a challenge ends the run; an unreadable page fails it", async () => {
  const missing = publisher([{ n: 1, index: "404" }, { n: 2, initiation: null }]);
  const result = await drain(billPublicationsAdapter, fixtureContext({ source, fetch: missing.fetch }));
  assert.deepEqual(result.records.map((r) => r.safe_payload.publication_index_status), ["unavailable", "unavailable"]);
  assert.ok(result.records.every((r) => !("publication_revision_count" in r.safe_payload)));
  assert.equal(missing.calls.filter((c) => c.request.url.includes("legislation.govt.nz")).length, 1, "no usable date: the index is not guessed at");

  const challenged = publisher([{ n: 1, index: "challenge" }, { n: 2 }]);
  await assert.rejects(drain(billPublicationsAdapter, fixtureContext({ source, fetch: challenged.fetch })), (e: unknown) => e instanceof SourceUnavailableError && e.outcome === "challenge");
  assert.equal(challenged.calls.filter((c) => c.request.url.includes("legislation.govt.nz")).length, 1, "one attempt, then stop");

  const garbage = publisher([{ n: 1, index: "garbage" }]);
  await assert.rejects(drain(billPublicationsAdapter, fixtureContext({ source, fetch: garbage.fetch })), (e: IngestError) => e.errorClass === "parse_error");
  const serverFault = publisher([{ n: 1 }], (request) => {
    if (request.url.includes("/versions/")) throw new IngestError("http_error", "publisher answered HTTP 503");
    return undefined;
  });
  await assert.rejects(drain(billPublicationsAdapter, fixtureContext({ source, fetch: serverFault.fetch })), (e: IngestError) => e.errorClass === "http_error");
});

test("adapter: a budget stop leaves done=false and never splits a bill; the next run resumes after the last stored bill", async () => {
  const bills = [{ n: 1, tokens: ["2026-02-03", "2026-05-01"] }, { n: 2, tokens: ["2026-02-03", "2026-05-01"] }, { n: 3 }];
  const first = publisher(bills);
  const partial = await drain(billPublicationsAdapter, fixtureContext({ source, fetch: first.fetch, maxRecords: 4 }));
  assert.equal(partial.records.length, 3, "the second bill's three records do not fit, so none of them is emitted");
  assert.equal(partial.last!.done, false);
  assert.deepEqual(partial.last!.cursor, { after_bill_id: uuid(1), total: 3 });

  const second = publisher(bills);
  const rest = await drain(billPublicationsAdapter, fixtureContext({ source, fetch: second.fetch, resumeCursor: partial.last!.cursor }));
  assert.ok(!second.calls.some((c) => c.request.url.endsWith(uuid(1))), "the stored bill is not asked about again");
  assert.equal(rest.last!.done, true);
  assert.equal(new Set([...partial.records, ...rest.records].map((r) => r.external_record_id)).size, 8);

  const tiny = publisher([{ n: 1, tokens: ["2026-02-03", "2026-05-01"] }]);
  await assert.rejects(drain(billPublicationsAdapter, fixtureContext({ source, fetch: tiny.fetch, maxRecords: 2 })), (e: IngestError) => e.errorClass === "budget_too_small");

  const finished = publisher(bills);
  const nothing = await drain(billPublicationsAdapter, fixtureContext({ source, fetch: finished.fetch, resumeCursor: { after_bill_id: uuid(3), total: 3 } }));
  assert.equal(nothing.records.length, 0);
  assert.equal(nothing.last!.done, true);
});

test("adapter: a bill list whose total changes between pages, repeats an id or ends short fails the run", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ n: i + 1 }));
  let listCalls = 0;
  const drifting = publisher(many, (request) => {
    if (request.method !== "POST") return undefined;
    listCalls++;
    return listCalls === 2 ? JSON.stringify({ totalResults: 61, results: [{ id: uuid(999), title: "Example Bill", parliamentNumber: 54 }] }) : undefined;
  });
  await assert.rejects(drain(billPublicationsAdapter, fixtureContext({ source, fetch: drifting.fetch })), (e: IngestError) => e.errorClass === "source_changed_during_pagination");

  let again = 0;
  const repeating = publisher(many, (request) => {
    if (request.method !== "POST") return undefined;
    again++;
    return again === 2 ? JSON.stringify({ totalResults: 60, results: [{ id: uuid(1), title: "Example Bill", parliamentNumber: 54 }] }) : undefined;
  });
  await assert.rejects(drain(billPublicationsAdapter, fixtureContext({ source, fetch: repeating.fetch })), /duplicate/);

  const short = publisher([{ n: 1 }], (request) => (request.method === "POST" ? JSON.stringify({ totalResults: 2, results: [{ id: uuid(1), title: "Example Bill", parliamentNumber: 54 }] }) : undefined));
  await assert.rejects(drain(billPublicationsAdapter, fixtureContext({ source, fetch: short.fetch })), /stated total/);
});
