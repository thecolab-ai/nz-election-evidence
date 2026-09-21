// New Zealand Government (Beehive) releases: BACKFILL route through the public paginated listing.
// Title, link and the listing's own date only. A release page is never requested and no release text is stored.
// The feed adapter (releases feed, rolling window) stays the incremental route; this one walks the archive pages.
//
// STATUS 2026-09-20: from the host this was written on, the listing answered the project's honest automated client
// with an automated-access challenge, so the live markup could NOT be observed. The parser below is written against
// the generic structure of a content-management listing (an <article> or list row holding a link to /release/<slug>,
// an optional <time datetime>, an optional node id) and is tested only on a hand-written structural sample. It reads
// nothing when that structure is absent, and the adapter then faults instead of reporting "no releases".
// A challenge is final: one attempt, no other headers, no other route (the fetch guard raises SourceUnavailableError).

import { cleanText } from "../../../canonical.ts";
import {
  type Adapter, type AdapterContext, type AdapterPage, IngestError, type IngestRecord,
} from "../../../types.ts";
import { buildRelease, isoInstant } from "../payload.ts";
import { builtRecord, DEADLINE_MARGIN_MS, optionInt } from "./common.ts";

const HOST = "www.beehive.govt.nz";
/** No listing page is expected to carry more than this many releases; used only to decide whether one more page fits. */
const MAX_ITEMS_PER_PAGE = 60;

export interface ListingItem {
  url: string;
  title: string;
  publishedAt?: string;
  nodeId?: string;
}

export function parseReleasesListing(html: string): ListingItem[] {
  if (!/<html[\s>]/i.test(html)) throw new IngestError("parse_error", "releases listing is not an HTML document");
  const anchors: { start: number; path: string; title: string }[] = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref="((?:https:\/\/www\.beehive\.govt\.nz)?\/release\/[^"?#\s]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const path = match[1].replace(/^https:\/\/www\.beehive\.govt\.nz/i, "");
    const title = cleanText(match[2]);
    if (title) anchors.push({ start: match.index ?? 0, path, title });
  }
  // One item per release address; when a row links the same release twice (headline and "read more"), the longer
  // text is the headline.
  const byPath = new Map<string, { start: number; path: string; title: string }>();
  for (const anchor of anchors) {
    const known = byPath.get(anchor.path);
    if (!known) byPath.set(anchor.path, anchor);
    else if (anchor.title.length > known.title.length) known.title = anchor.title;
  }
  const rows = [...byPath.values()].sort((a, b) => a.start - b.start);
  const items: ListingItem[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    // The row's own markup: from the container that opens before its link to the start of the next row.
    const previousEnd = index === 0 ? 0 : rows[index - 1].start;
    const opener = Math.max(html.lastIndexOf("<article", row.start), html.lastIndexOf("<li", row.start), html.lastIndexOf("views-row", row.start));
    const blockStart = opener > previousEnd ? opener : row.start;
    const nextStart = index + 1 < rows.length ? rows[index + 1].start : html.length;
    const nextOpener = index + 1 < rows.length ? Math.max(html.lastIndexOf("<article", nextStart), html.lastIndexOf("<li", nextStart), html.lastIndexOf("views-row", nextStart)) : -1;
    const block = html.slice(blockStart, nextOpener > row.start ? nextOpener : nextStart);
    const time = /<time\b[^>]*\bdatetime="([^"]+)"/i.exec(block);
    const node = /\bdata-history-node-id="(\d{1,12})"/.exec(block) ?? /\babout="\/node\/(\d{1,12})"/.exec(block);
    items.push({
      url: `https://${HOST}${row.path}`,
      title: row.title,
      // Only a machine-readable instant is kept as the publisher's date; a displayed day alone is not turned into one.
      publishedAt: time ? isoInstant(time[1]) : undefined,
      nodeId: node ? node[1] : undefined,
    });
  }
  return items;
}

export async function releaseListingRecord(item: ListingItem, retrievedAt: string): Promise<IngestRecord> {
  return await builtRecord(() => buildRelease({ url: item.url, title: item.title, publishedAt: item.publishedAt, publisherItemId: item.nodeId }), retrievedAt);
}

export const releasesListingAdapter: Adapter = {
  name: "nz_government_releases_listing",
  version: "1.0.0",
  async *pages(ctx: AdapterContext): AsyncGenerator<AdapterPage> {
    const options = ctx.source.adapter_options;
    const firstPage = optionInt(options, "first_page", 0, 0, 100000);
    const maxPages = optionInt(options, "max_pages", 3000, 1, 100000);
    const listing = new URL(ctx.source.official_url);
    if (listing.hostname.toLowerCase() !== HOST) throw new IngestError("invalid_adapter_options", "the releases listing lives on the publisher's own host only");
    const resume = ctx.resumeCursor as { next_page?: number } | null;
    const resumePage = typeof resume?.next_page === "number" && Number.isInteger(resume.next_page) && resume.next_page > firstPage ? resume.next_page : null;
    let page = resumePage ?? firstPage;
    let emitted = 0;
    // The listing moves down as new releases are published, so the same release can legitimately reappear on a
    // later page. It is emitted once per run.
    const seen = new Set<string>();
    // A block of links repeated on every page (a "latest" panel) would keep a page past the end from looking empty,
    // so three pages in a row with nothing new also mean the archive has run out.
    let pagesWithNothingNew = 0;

    for (let walked = 0; walked < maxPages; walked++, page++) {
      // The runner stores at most maxRecords and would drop the rest of a page behind an advanced cursor, so a further
      // page is requested only when a full one still fits.
      if ((emitted > 0 && emitted + MAX_ITEMS_PER_PAGE > ctx.maxRecords) || ctx.now().getTime() > ctx.deadline - DEADLINE_MARGIN_MS) return;
      listing.search = `?page=${page}`;
      const response = await ctx.fetch({ url: listing.toString(), accept: "text/html" });
      const items = parseReleasesListing(response.text);
      if (items.length > MAX_ITEMS_PER_PAGE) throw new IngestError("parse_error", "listing page holds more releases than a listing page should; the markup may have changed");
      if (items.length === 0 && page === firstPage) {
        throw new IngestError("parse_error", "listing parsed but held no releases; treated as a fault, not as no releases");
      }
      const records: IngestRecord[] = [];
      for (const item of items) {
        const record = await releaseListingRecord(item, response.retrievedAt);
        if (seen.has(record.external_record_id)) continue;
        seen.add(record.external_record_id);
        records.push(record);
      }
      if (emitted + records.length > ctx.maxRecords) throw new IngestError("budget_too_small", "max_records is smaller than one listing page");
      emitted += records.length;
      pagesWithNothingNew = records.length === 0 ? pagesWithNothingNew + 1 : 0;
      const end = items.length === 0 || pagesWithNothingNew >= 3;
      yield {
        records,
        cursor: { next_page: page + 1 },
        // done means the archive ran out of pages. Stopping early for budget leaves done=false.
        done: end,
        // An archive walk of a list that only grows: nothing is ever tombstoned.
        completeSnapshot: false,
        watermark: `page=${page}`,
      };
      if (end) return;
    }
    // max_pages reached: the last yielded page said done=false, so the run is recorded as partial and resumes.
  },
};
