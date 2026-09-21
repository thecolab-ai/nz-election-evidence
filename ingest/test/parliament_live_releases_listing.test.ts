// Government releases listing (backfill route). The listing markup could not be observed live when this was written
// (the publisher's firewall challenged the request; see LIVE-NOTES.md), so the sample below is a HAND-WRITTEN PARSER
// FIXTURE of a generic listing structure with obviously synthetic values. It is not imported data and it is not a
// copy of the publisher's page. No test touches the network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { contentHash } from "../../supabase/functions/_shared/canonical.ts";
import { runSource } from "../../supabase/functions/_shared/runner.ts";
import { IngestError, type SourcesFile } from "../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { PARLIAMENT_PROJECTION_VERSION } from "../src/families/parliament/payload.ts";
import { parseReleasesListing, releaseListingRecord, releasesListingAdapter } from "../../supabase/functions/_shared/adapters/parliament/live/releases_listing.ts";
import { cannedFetch, drain, fixtureContext, fixtureSource, payloadProblems } from "../../supabase/functions/_shared/adapters/parliament/live/test_support.ts";

function row(slug: string, title: string, options: { node?: number; datetime?: string; absolute?: boolean } = {}): string {
  const href = (options.absolute ? "https://www.beehive.govt.nz" : "") + "/release/" + slug;
  return `<article${options.node ? ` data-history-node-id="${options.node}"` : ""} class="node node--type-release">
    <h2><a href="${href}" rel="bookmark"><span>${title}</span></a></h2>
    ${options.datetime ? `<time datetime="${options.datetime}">1 January 2026</time>` : "<span>1 January 2026</span>"}
    <div class="summary">EXAMPLE SUMMARY TEXT that must never be stored</div>
    <a href="${href}">Read more</a>
  </article>`;
}

function listingPage(rows: string[]): string {
  return `<!DOCTYPE html><html lang="en"><body><nav><a href="/releases">Releases</a><a href="/minister/example-minister">Example Minister</a></nav>
    <main>${rows.join("\n")}</main><a href="/releases?page=1">Next</a><a href="https://elsewhere.example.invalid/release/not-ours">elsewhere</a></body></html>`;
}

const source = fixtureSource({ official_url: "https://www.beehive.govt.nz/releases", allowed_hosts: ["www.beehive.govt.nz"], access_basis: "public_page", snapshot_semantics: "append_only_feed" });

test("PARSER FIXTURE: title, link, machine-readable date and node id from the row; nothing else", () => {
  const items = parseReleasesListing(listingPage([
    row("example-release-one", "Example release title one &amp; more", { node: 101, datetime: "2026-01-01T02:30:00+13:00" }),
    row("example-release-two", "Example release title two", { absolute: true }),
  ]));
  assert.deepEqual(items, [
    { url: "https://www.beehive.govt.nz/release/example-release-one", title: "Example release title one & more", publishedAt: "2025-12-31T13:30:00.000Z", nodeId: "101" },
    { url: "https://www.beehive.govt.nz/release/example-release-two", title: "Example release title two", publishedAt: undefined, nodeId: undefined },
  ]);
  assert.ok(!JSON.stringify(items).includes("EXAMPLE SUMMARY"), "summary text is never read into an item");
  assert.deepEqual(parseReleasesListing(listingPage([])), [], "a page without rows parses to nothing; the adapter decides what that means");
  assert.throws(() => parseReleasesListing('{"not":"a page"}'), (e: IngestError) => e.errorClass === "parse_error");
});

test("record: same kind and base keys as the feed route; the row's date only when machine-readable; hash ignores key order", async () => {
  const [one, two] = parseReleasesListing(listingPage([
    row("example-release-one", "Example release title one", { node: 101, datetime: "2026-01-01T02:30:00+13:00" }), row("example-release-two", "Example release title two"),
  ]));
  const a = await releaseListingRecord(one, "2026-09-20T00:00:00.000Z");
  assert.equal(a.record_kind, "release");
  assert.equal(a.external_record_id, "release-url-example-release-one");
  assert.equal(a.source_url, "https://www.beehive.govt.nz/release/example-release-one");
  assert.equal(a.source_published_at, "2025-12-31T13:30:00.000Z");
  assert.equal(a.safe_payload.title, "Example release title one");
  assert.equal(a.safe_payload.public_page_url, "https://www.beehive.govt.nz/release/example-release-one");
  assert.equal(a.safe_payload.publisher_item_id, "101");
  const b = await releaseListingRecord(two, "2026-09-20T00:00:00.000Z");
  assert.equal(b.source_published_at, undefined, "a displayed day alone is never turned into a timestamp");
  assert.ok(!("publisher_item_id" in b.safe_payload) && !("published_at" in b.safe_payload));
  for (const record of [a, b]) {
    assert.deepEqual(payloadProblems(record), []);
    assert.equal(await contentHash("release", PARLIAMENT_PROJECTION_VERSION, Object.fromEntries(Object.entries(record.safe_payload).reverse())), record.content_hash);
  }
  const later = await releaseListingRecord(one, "2026-09-25T00:00:00.000Z");
  assert.equal(later.content_hash, a.content_hash, "retrieval time is outside the hash");
});

test("hostile input: a contact-like string in a title is masked; a link off the publisher's host is never a record", async () => {
  const [item] = parseReleasesListing(listingPage([row("example-release-three", "Example title (media: press@example.invalid)")]));
  const record = await releaseListingRecord(item, "x");
  assert.equal(record.safe_payload.title, "Example title (media: [redacted])");
  assert.ok(record.omitted_fields.some((o) => o.field === "title"));
  assert.deepEqual(payloadProblems(record), []);
  await assert.rejects(releaseListingRecord({ url: "https://elsewhere.example.invalid/release/x", title: "Example" }, "x"), (e: IngestError) => e.errorClass === "parse_error");
  const long = await releaseListingRecord({ url: "https://www.beehive.govt.nz/release/" + "a".repeat(400), title: "Example" }, "x");
  assert.ok(long.external_record_id.length <= 172 && /^[A-Za-z0-9_-]+$/.test(long.external_record_id));
});

function publisher(pages: string[][]) {
  return cannedFetch((request) => {
    const page = Number(new URL(request.url).searchParams.get("page"));
    return listingPage(pages[page] ?? []);
  });
}
const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => row(`example-release-${from + i}`, `Example release title ${from + i}`, { node: from + i }));

test("adapter: walks ?page=N from the first page, a release repeated on a later page is emitted once, an empty page ends the walk", async () => {
  const { fetch, calls } = publisher([rows(1, 3), [...rows(3, 1), ...rows(4, 2)], rows(6, 1)]);
  const result = await drain(releasesListingAdapter, fixtureContext({ source, fetch }));
  assert.deepEqual(calls.map((c) => c.request.url), [0, 1, 2, 3].map((n) => `https://www.beehive.govt.nz/releases?page=${n}`));
  assert.ok(calls.every((c) => (c.request.method ?? "GET") === "GET" && !c.request.url.includes("/release/")), "a release page itself is never requested");
  assert.equal(result.records.length, 6);
  assert.equal(new Set(result.records.map((r) => r.external_record_id)).size, 6);
  assert.equal(result.last!.done, true);
  assert.ok(result.pages.every((p) => p.completeSnapshot === false));
});

test("adapter: a budget stop leaves done=false; the next run resumes from the cursor", async () => {
  const pages = [rows(1, 40), rows(41, 40), rows(81, 40)];
  const first = publisher(pages);
  const partial = await drain(releasesListingAdapter, fixtureContext({ source, fetch: first.fetch, maxRecords: 90 }));
  assert.equal(partial.records.length, 40, "another full page might not fit, so it is not requested");
  assert.equal(partial.last!.done, false);
  assert.deepEqual(partial.last!.cursor, { next_page: 1 });
  const second = publisher(pages);
  const rest = await drain(releasesListingAdapter, fixtureContext({ source, fetch: second.fetch, resumeCursor: partial.last!.cursor }));
  assert.equal(second.calls[0].request.url, "https://www.beehive.govt.nz/releases?page=1");
  assert.equal(rest.last!.done, true);
  assert.equal(new Set([...partial.records, ...rest.records].map((r) => r.external_record_id)).size, 120);
  const tiny = publisher(pages);
  await assert.rejects(drain(releasesListingAdapter, fixtureContext({ source, fetch: tiny.fetch, maxRecords: 10 })), (e: IngestError) => e.errorClass === "budget_too_small");
});

test("adapter: no rows on the first page is a fault, not zero releases; a repeated panel cannot keep the walk alive", async () => {
  const empty = publisher([[]]);
  await assert.rejects(drain(releasesListingAdapter, fixtureContext({ source, fetch: empty.fetch })), (e: IngestError) => e.errorClass === "parse_error");
  const panel = rows(1, 2);
  const looping = cannedFetch((request) => listingPage(Number(new URL(request.url).searchParams.get("page")) === 0 ? [...panel, ...rows(10, 2)] : panel));
  const result = await drain(releasesListingAdapter, fixtureContext({ source, fetch: looping.fetch }));
  assert.equal(looping.calls.length, 4);
  assert.equal(result.records.length, 4);
  assert.equal(result.last!.done, true);
});

test("through the real fetch guard: a firewall challenge is one attempt and ends the run as blocked, never as zero releases", async () => {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
    return new Response('<html><head><script src="/_Incapsula_Resource?fixture=1"></script></head><body></body></html>', { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const report = await runSource({
    file: sourcesFile as unknown as SourcesFile, source: { ...source, adapter_name: releasesListingAdapter.name }, adapter: releasesListingAdapter, mode: "backfill",
    triggerKind: "test", maxRecords: 500, maxRuntimeSeconds: 120, dryRun: true, db: null, fetchImpl, sleep: async () => undefined, minIntervalMs: 0,
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.error_class, "publisher_challenge");
  assert.equal(report.totals.seen, 0);
  assert.deepEqual(requested.filter((url) => !url.endsWith("/robots.txt")), ["https://www.beehive.govt.nz/releases?page=0"]);
});
