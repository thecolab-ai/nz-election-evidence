// New Zealand Government (Beehive) releases feed. Link and title only: the publisher's summary
// text is deliberately not stored. A feed is a rolling window, so nothing is ever tombstoned.

import { cleanText, contentHash } from "../canonical.ts";
import { type Adapter, type AdapterContext, type AdapterPage, IngestError, type IngestRecord } from "../types.ts";

const PROJECTION_VERSION = 1;

export interface FeedItem {
  guid: string;
  title: string;
  link: string;
  pubDateText: string | null;
}

function tag(block: string, name: string): string | null {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!match) return null;
  return cleanText(match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, ""));
}

export function parseReleasesFeed(xml: string): FeedItem[] {
  if (!/<rss[\s>]/.test(xml) || !/<channel[\s>]/.test(xml)) throw new IngestError("parse_error", "not an RSS document");
  const items: FeedItem[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const guid = tag(match[1], "guid");
    const title = tag(match[1], "title");
    const link = tag(match[1], "link");
    if (!guid || !title || !link) throw new IngestError("parse_error", "feed item lacks guid, title or link");
    items.push({ guid, title, link, pubDateText: tag(match[1], "pubDate") });
  }
  return items;
}

export const releasesRssAdapter: Adapter = {
  name: "nz_government_releases_feed",
  version: "1.0.0",
  async *pages(ctx: AdapterContext): AsyncGenerator<AdapterPage> {
    const response = await ctx.fetch({ url: ctx.source.official_url, accept: "application/rss+xml,application/xml" });
    const items = parseReleasesFeed(response.text);
    if (items.length === 0) throw new IngestError("parse_error", "feed parsed but held no items; treated as a fault, not as no releases");
    const allowed = ctx.source.allowed_hosts.map((h) => h.toLowerCase());
    const records: IngestRecord[] = [];
    for (const item of items.slice(0, ctx.maxRecords)) {
      const link = new URL(item.link);
      if (link.protocol !== "https:" || !allowed.includes(link.hostname.toLowerCase())) {
        throw new IngestError("parse_error", "feed item links outside the publisher's allowlisted hosts");
      }
      const payload = { title: item.title, public_page_url: link.toString(), publisher_item_id: item.guid };
      const published = item.pubDateText && !Number.isNaN(Date.parse(item.pubDateText)) ? new Date(item.pubDateText).toISOString() : undefined;
      records.push({
        external_record_id: "release-" + item.guid.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120),
        record_kind: "release",
        content_hash: await contentHash("release", PROJECTION_VERSION, payload),
        source_url: link.toString(),
        source_published_at: published,
        source_date_text: item.pubDateText ?? undefined,
        retrieved_at: response.retrievedAt,
        projection_version: PROJECTION_VERSION,
        safe_payload: payload,
        omitted_fields: [
          { field: "description", reason: "publisher summary text not stored; link-only rights posture (R6)" },
          { field: "release_text", reason: "never fetched" },
        ],
      });
    }
    yield { records, cursor: { newest_guid: items[0].guid }, done: true, completeSnapshot: false, watermark: items[0].guid };
  },
};
