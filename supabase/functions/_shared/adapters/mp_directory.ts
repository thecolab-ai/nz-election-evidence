// New Zealand Parliament: current Members of Parliament listing.
// One complete page. Identity key is the publisher's profile slug, never a name or an email.
// A sighting here is a sitting member. It says nothing about candidacy.

import { cleanText, contentHash } from "../canonical.ts";
import { type Adapter, type AdapterContext, type AdapterPage, IngestError, type IngestRecord } from "../types.ts";

const PROJECTION_VERSION = 1;
const PROFILE_PREFIX = "/en/mps-and-electorates/members-of-parliament/";

export interface MpRow {
  slug: string;
  name_sort: string;
  name_display: string;
  party_label: string;
  representation: "list" | "electorate";
  electorate_label: string | null;
}

function displayName(sortName: string): string {
  const comma = sortName.indexOf(",");
  if (comma < 0) return sortName;
  return (sortName.slice(comma + 1).trim() + " " + sortName.slice(0, comma).trim()).trim();
}

export function parseMpDirectory(html: string): MpRow[] {
  const rows: MpRow[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]);
    if (cells.length < 4) continue;
    const link = cells[1].match(/href="([^"]+)"/);
    if (!link || !link[1].startsWith(PROFILE_PREFIX)) continue;
    // Slugs carry macrons and accents (and arrive entity-encoded), so they are decoded and matched as Unicode.
    const slug = cleanText(link[1].slice(PROFILE_PREFIX.length)).replace(/\/+$/, "").normalize("NFC");
    if (!/^[\p{Ll}\p{N}-]{2,120}$/u.test(slug)) throw new IngestError("parse_error", "unexpected profile slug shape");
    if (seen.has(slug)) throw new IngestError("parse_error", "duplicate profile slug in listing");
    seen.add(slug);
    const nameSort = cleanText(cells[1]);
    const party = cleanText(cells[2]);
    const seat = cleanText(cells[3]);
    if (!nameSort || !party || !seat) throw new IngestError("parse_error", "listing row is missing name, party or seat");
    const isList = seat.toLowerCase() === "list";
    rows.push({
      slug,
      name_sort: nameSort,
      name_display: displayName(nameSort),
      party_label: party,
      representation: isList ? "list" : "electorate",
      electorate_label: isList ? null : seat,
    });
  }
  return rows;
}

export const mpDirectoryAdapter: Adapter = {
  name: "nz_parliament_mp_directory",
  version: "1.0.0",
  async *pages(ctx: AdapterContext): AsyncGenerator<AdapterPage> {
    const response = await ctx.fetch({ url: ctx.source.official_url, accept: "text/html" });
    const rows = parseMpDirectory(response.text);
    const min = Number(ctx.source.adapter_options?.min_rows ?? 100);
    const max = Number(ctx.source.adapter_options?.max_rows ?? 130);
    // Authentic-content check: a short or empty table is a broken page, not an empty Parliament.
    if (rows.length < min || rows.length > max) {
      throw new IngestError("parse_error", `listing produced ${rows.length} rows; expected ${min}-${max}`);
    }
    const origin = new URL(ctx.source.official_url).origin;
    const records: IngestRecord[] = [];
    for (const row of rows) {
      const payload = {
        name_display: row.name_display,
        name_sort: row.name_sort,
        party_label: row.party_label,
        representation: row.representation,
        electorate_label: row.electorate_label,
        public_page_url: new URL(PROFILE_PREFIX + row.slug + "/", origin).toString(),
      };
      records.push({
        external_record_id: row.slug,
        record_kind: "mp_directory_entry",
        content_hash: await contentHash("mp_directory_entry", PROJECTION_VERSION, payload),
        source_url: payload.public_page_url,
        retrieved_at: response.retrievedAt,
        projection_version: PROJECTION_VERSION,
        safe_payload: payload,
        omitted_fields: [
          { field: "portrait_image", reason: "not needed; third-party image rights" },
          { field: "contact_details", reason: "contact data is never collected (R7)" },
        ],
      });
    }
    // The listing carries no publisher date, so none is recorded.
    yield { records, cursor: { complete: true }, done: true, completeSnapshot: true, watermark: response.bodySha256 };
  },
};
