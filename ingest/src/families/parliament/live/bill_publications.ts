// New Zealand Parliament current bills: the published revisions of each bill on the official legislation website.
// METADATA ONLY: revision id, version date token and the official PDF address. No PDF and no bill text is ever
// requested: the only legislation-site page read is a bill's "Versions" index, which lists revisions and no clauses.
//
// Route per run:
//   1. the current-bills search (same anonymous request as the current-bills adapter) gives the bill ids;
//   2. per bill, GET <bills origin>/api/data/Bill/<id> gives the bill number, title, stage, status and the
//      publisher's own link to the legislation website;
//   3. per bill, GET <legislation link base>/<version date>/versions/?per_page=100&sort=asc&page=N lists the revisions.
//      The index address needs a real version date. The bill detail's initiation date is the introduction version's
//      date, so that is used. When the index cannot be found this way (HTTP 404, or no usable date), the set record
//      says publication_index_status "unavailable" and gives NO count: unknown is not zero.
// A sign-in, a refusal or an automated-access challenge on either host ends the run as unavailable (fail closed).
//
// One adapter page per bill: [bill_publication_set, ...bill_publication]. Bills are processed in id order and the
// cursor is { after_bill_id, total }, so a resumed run continues after the last stored bill even if the list moved.

import { billsRequestBody, parseBillsPage } from "../../../../../supabase/functions/_shared/adapters/bills.ts";
import {
  type Adapter, type AdapterContext, type AdapterPage, IngestError, type IngestRecord, SourceUnavailableError,
} from "../../../../../supabase/functions/_shared/types.ts";
import { BILL_PUBLIC_BASE, buildBillPublication, buildBillPublicationSet, isoDay, isUuid } from "../payload.ts";
import { builtRecord, DEADLINE_MARGIN_MS, parseJsonObject } from "./common.ts";

const BILLS_PAGE_SIZE = 50; // fixed by billsRequestBody
const MAX_LIST_PAGES = 40;
const MAX_INDEX_PAGES = 5;
const INDEX_PER_PAGE = 100;
const LEGISLATION_ORIGIN = "https://www.legislation.govt.nz";

export interface BillDetail {
  id: string;
  billNumber?: string;
  title?: string;
  currentStage?: string;
  status?: string;
  parliamentNumber?: number;
  legislationUrl?: string;
  initiationDay?: string;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

export function parseBillDetail(body: string, expectedId: string): BillDetail {
  const data = parseJsonObject(body, "bill detail endpoint");
  if (!isUuid(data.Id) || data.Id.toLowerCase() !== expectedId.toLowerCase()) throw new IngestError("parse_error", "bill detail does not match the requested bill");
  return {
    id: data.Id.toLowerCase(),
    billNumber: str(data.BillNumber),
    title: str(data.Title),
    currentStage: str(data.BillCurrentStageName),
    status: str(data.BillStatusName),
    parliamentNumber: typeof data.ParliamentNumber === "number" ? data.ParliamentNumber : undefined,
    legislationUrl: str(data.BillLegislationUrl),
    // The date exactly as the publisher wrote it (its own local date); no time-zone shifting.
    initiationDay: isoDay(data.InitiationDate),
  };
}

/** "bill/government/2026/344/en" from either address style the publisher uses; leading zeros of the number are dropped. */
export function legislationBillPath(legislationUrl: string | undefined): string | undefined {
  if (!legislationUrl) return undefined;
  let url: URL;
  try {
    url = new URL(legislationUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !["www.legislation.govt.nz", "legislation.govt.nz"].includes(url.hostname.toLowerCase())) return undefined;
  const match = /^\/bill\/(government|member|local|private)\/(\d{4})\/0*(\d{1,5})\/(?:([a-z]{2})\/)?/.exec(url.pathname);
  if (!match) return undefined;
  return `bill/${match[1]}/${match[2]}/${match[3]}/${match[4] ?? "en"}`;
}

export function versionsIndexUrl(billPath: string, versionDay: string, page: number): string {
  return `${LEGISLATION_ORIGIN}/${billPath}/${versionDay}/versions/?per_page=${INDEX_PER_PAGE}&sort=asc&page=${page}`;
}

export interface VersionsIndexPage {
  revisions: { revisionId: string; versionToken: string; pdfUrl: string }[];
  hasNextPage: boolean;
}

/** Reads the revision links of one bill from its versions index. Links to any other bill or file type are ignored. */
export function parseVersionsIndex(html: string, billPath: string, page: number): VersionsIndexPage {
  if (!/<html[\s>]/i.test(html) || !/id="version-|>\s*Versions\s*</.test(html)) {
    throw new IngestError("parse_error", "legislation page is not a versions index; the publisher's markup may have changed");
  }
  const revisions: VersionsIndexPage["revisions"] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/href="([^"]+\.pdf)"/g)) {
    const path = match[1].replace(/&amp;/g, "&").replace(/^https:\/\/(www\.)?legislation\.govt\.nz/i, "");
    if (!path.startsWith(`/${billPath}/`)) continue;
    const token = path.slice(billPath.length + 2, -4);
    if (!/^[0-9A-Za-z._-]+$/.test(token)) continue;
    const revisionId = path.slice(1);
    if (seen.has(revisionId)) continue;
    seen.add(revisionId);
    revisions.push({ revisionId, versionToken: token, pdfUrl: LEGISLATION_ORIGIN + path });
  }
  const nextPage = new RegExp(`href="[^"]*/versions/\\?[^"]*\\bpage=${page + 1}\\b`);
  return { revisions, hasNextPage: nextPage.test(html) };
}

export async function billPublicationRecords(detail: BillDetail, index: { url: string; revisions: VersionsIndexPage["revisions"] } | "unavailable" | "none", retrievedAt: string): Promise<IngestRecord[]> {
  const listed = typeof index === "object" ? index : null;
  const records: IngestRecord[] = [await builtRecord(() => buildBillPublicationSet({
    billId: detail.id, billNumber: detail.billNumber, title: detail.title, currentStage: detail.currentStage, status: detail.status,
    parliamentNumber: detail.parliamentNumber, legislationUrl: detail.legislationUrl,
    revisionCount: listed ? listed.revisions.length : undefined, indexUnavailable: index === "unavailable",
  }), retrievedAt)];
  for (const revision of listed?.revisions ?? []) {
    records.push(await builtRecord(() => buildBillPublication({
      revisionId: revision.revisionId, billId: detail.id, billNumber: detail.billNumber, billTitle: detail.title,
      parliamentNumber: detail.parliamentNumber, versionToken: revision.versionToken, pdfUrl: revision.pdfUrl,
      versionIndexUrl: listed?.url, text: {},
    }), retrievedAt));
  }
  return records;
}

async function currentBillIds(ctx: AdapterContext, origin: string): Promise<string[]> {
  const ids = new Set<string>();
  let total: number | null = null;
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const response = await ctx.fetch({
      url: origin + "/api/data/search", method: "POST", body: billsRequestBody(page), accept: "application/json",
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    const parsed = parseBillsPage(response.text, BILL_PUBLIC_BASE);
    if (total !== null && parsed.total !== total) throw new IngestError("source_changed_during_pagination", "bill total changed between pages; restart for a consistent list");
    total = parsed.total;
    for (const item of parsed.items) {
      const id = item.id.toLowerCase();
      if (ids.has(id)) throw new IngestError("parse_error", "duplicate bill id across pages");
      ids.add(id);
    }
    if (page * BILLS_PAGE_SIZE >= total || parsed.items.length === 0) {
      if (ids.size !== total) throw new IngestError("parse_error", "bill list ended before the publisher's stated total");
      return [...ids].sort();
    }
  }
  throw new IngestError("pagination_bound", `more than ${MAX_LIST_PAGES} bill list pages; raise the bound deliberately`);
}

export const billPublicationsAdapter: Adapter = {
  name: "nz_parliament_bill_publications",
  version: "1.0.0",
  async *pages(ctx: AdapterContext): AsyncGenerator<AdapterPage> {
    const origin = new URL(ctx.source.official_url).origin;
    const resume = ctx.resumeCursor as { after_bill_id?: string } | null;
    const after = isUuid(resume?.after_bill_id) ? resume.after_bill_id.toLowerCase() : null;
    const ids = await currentBillIds(ctx, origin);
    const total = ids.length;
    const pending = after ? ids.filter((id) => id > after) : ids;
    if (pending.length === 0) {
      yield { records: [], cursor: { after_bill_id: after, total }, done: true, completeSnapshot: false, watermark: `bills=${total}` };
      return;
    }
    let emitted = 0;

    for (let position = 0; position < pending.length; position++) {
      const id = pending[position];
      if (ctx.now().getTime() > ctx.deadline - DEADLINE_MARGIN_MS || emitted >= ctx.maxRecords) return;
      const detailResponse = await ctx.fetch({ url: `${origin}/api/data/Bill/${id}`, accept: "application/json" });
      const detail = parseBillDetail(detailResponse.text, id);
      let retrievedAt = detailResponse.retrievedAt;

      let index: { url: string; revisions: VersionsIndexPage["revisions"] } | "unavailable" | "none" = "none";
      const billPath = legislationBillPath(detail.legislationUrl);
      if (detail.legislationUrl) {
        index = "unavailable";
        if (billPath && detail.initiationDay) {
          try {
            const revisions: VersionsIndexPage["revisions"] = [];
            for (let page = 1; ; page++) {
              if (page > MAX_INDEX_PAGES) throw new IngestError("pagination_bound", `more than ${MAX_INDEX_PAGES} version index pages for one bill`);
              const response = await ctx.fetch({ url: versionsIndexUrl(billPath, detail.initiationDay, page), accept: "text/html" });
              const parsed = parseVersionsIndex(response.text, billPath, page);
              for (const revision of parsed.revisions) if (!revisions.some((r) => r.revisionId === revision.revisionId)) revisions.push(revision);
              retrievedAt = response.retrievedAt;
              if (!parsed.hasNextPage) break;
            }
            index = { url: versionsIndexUrl(billPath, detail.initiationDay, 1), revisions };
          } catch (error) {
            // Only "no such page" is an unavailable index. A refusal, sign-in or challenge ends the run (fail closed);
            // a server fault or an unreadable page fails it, so nothing is recorded on a guess.
            if (error instanceof SourceUnavailableError || !(error instanceof IngestError) || error.errorClass !== "http_error" || !/HTTP 404\b/.test(error.message)) throw error;
          }
        }
      }

      const records = await billPublicationRecords(detail, index, retrievedAt);
      if (emitted > 0 && emitted + records.length > ctx.maxRecords) return; // does not fit; the next run starts at this bill
      if (records.length > ctx.maxRecords) throw new IngestError("budget_too_small", "max_records is smaller than one bill's publication set");
      emitted += records.length;
      const last = position === pending.length - 1;
      yield {
        records,
        cursor: { after_bill_id: id, total },
        done: last,
        // Never a complete snapshot: a bill that leaves the current list, or an index that could not be read this
        // time, must not tombstone revisions the publisher still serves.
        completeSnapshot: false,
        watermark: `bills=${total}`,
      };
    }
  },
};
