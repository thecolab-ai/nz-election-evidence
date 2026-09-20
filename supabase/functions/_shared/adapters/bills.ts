// New Zealand Parliament: current bills catalogue (metadata only, never bill text).
// The endpoint is the search API the publisher's own PUBLIC bills website calls, with no sign-in. It is undocumented
// (access_basis public_undocumented_endpoint): under the owner's collection policy of 2026-09-20 that is reported, not
// a veto. Requests are anonymous: no Origin, Referer, cookie or token is sent, and none would survive the fetch guard.
// Paginated JSON search endpoint; resumable by page; total must stay stable across pages.

import { contentHash } from "../canonical.ts";
import { type Adapter, type AdapterContext, type AdapterPage, IngestError, type IngestRecord, type Json } from "../types.ts";

const PROJECTION_VERSION = 1;
const PAGE_SIZE = 50;
const MAX_PAGES = 40;

export function billsRequestBody(page: number): string {
  return JSON.stringify({
    id: null, documentPreset: 1, keyword: null, selectCommittee: null, status: [], documentTypes: [],
    documentSubtypes: [], beforeCommittee: null, billStages: [], billTab: "Current", billId: null,
    includeBillStages: true, subject: null, person: null, parliament: null, dateFrom: null, dateTo: null,
    datePeriod: null, restrictedFrom: null, restrictedTo: null, terminatedReason: null,
    prettyTerminatedReason: null, terminatedReasons: [], column: 17, direction: 1, pageSize: PAGE_SIZE, page,
  });
}

function text(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

export interface ParsedBillsPage {
  total: number;
  items: { id: string; payload: { [key: string]: Json }; lastActivity: string | null }[];
}

export function parseBillsPage(body: string, publicBase: string): ParsedBillsPage {
  let data: { results?: unknown; totalResults?: unknown };
  try {
    data = JSON.parse(body);
  } catch {
    throw new IngestError("parse_error", "bills endpoint did not return JSON");
  }
  if (!Array.isArray(data.results) || typeof data.totalResults !== "number" || data.totalResults <= 0) {
    throw new IngestError("parse_error", "bills response lacks results or a positive totalResults");
  }
  const items = data.results.map((raw) => {
    const item = raw as { [key: string]: unknown };
    const id = text(item.id, 80);
    const title = text(item.title, 600);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id) || !title) throw new IngestError("parse_error", "bill result lacks id or title");
    const lastActivity = text(item.lastStageDate, 40) ?? text(item.lastModified, 40);
    const parliament = Number(item.parliamentNumber);
    return {
      id,
      lastActivity,
      payload: {
        title,
        bill_number: text(item.billNumber, 40),
        bill_type: text(item.itemType, 80),
        current_stage: text(item.billCurrentStageName, 120) ?? text(item.status, 120),
        select_committee: text(item.selectCommittee, 200),
        parliament_number: Number.isInteger(parliament) && parliament > 0 ? parliament : null,
        last_activity_at: lastActivity,
        member_name: text(item.memberName, 200),
        party_label: text(item.partyName, 200),
        public_page_url: publicBase + id,
        metadata_only: true,
      },
    };
  });
  return { total: data.totalResults, items };
}

export const billsAdapter: Adapter = {
  name: "nz_parliament_current_bills",
  version: "1.0.0",
  async *pages(ctx: AdapterContext): AsyncGenerator<AdapterPage> {
    const origin = new URL(ctx.source.official_url).origin;
    const publicBase = origin + "/v/6/";
    const resume = ctx.resumeCursor as { next_page?: number; total?: number } | null;
    let page = resume?.next_page && resume.next_page > 1 ? resume.next_page : 1;
    let total: number | null = resume?.total ?? null;
    const resumed = page > 1;
    let emitted = 0;
    const seen = new Set<string>();

    for (; page <= MAX_PAGES; page++) {
      const response = await ctx.fetch({
        url: origin + "/api/data/search",
        method: "POST",
        body: billsRequestBody(page),
        accept: "application/json",
        // No Origin or Referer: this client never presents itself as the publisher's own front end.
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
      const parsed = parseBillsPage(response.text, publicBase);
      if (total !== null && parsed.total !== total) {
        throw new IngestError("source_changed_during_pagination", "bill total changed between pages; restart for a consistent snapshot");
      }
      total = parsed.total;
      const records: IngestRecord[] = [];
      for (const item of parsed.items) {
        if (seen.has(item.id)) throw new IngestError("parse_error", "duplicate bill id across pages");
        seen.add(item.id);
        records.push({
          external_record_id: item.id,
          record_kind: "bill",
          content_hash: await contentHash("bill", PROJECTION_VERSION, item.payload),
          source_url: publicBase + item.id,
          source_published_at: item.lastActivity && !Number.isNaN(Date.parse(item.lastActivity)) ? new Date(item.lastActivity).toISOString() : undefined,
          source_date_text: item.lastActivity ?? undefined,
          retrieved_at: response.retrievedAt,
          projection_version: PROJECTION_VERSION,
          safe_payload: item.payload,
          omitted_fields: [{ field: "bill_text_and_attachments", reason: "metadata and link only (R6)" }],
        });
      }
      emitted += records.length;
      const lastPage = page * PAGE_SIZE >= total || parsed.items.length === 0;
      const budgetSpent = emitted >= ctx.maxRecords || ctx.now().getTime() > ctx.deadline - 15000;
      yield {
        records,
        cursor: { next_page: page + 1, total },
        // done means the publisher's list is exhausted. Stopping early for budget leaves done=false,
        // so the runner records a partial run and the next one resumes from this cursor.
        done: lastPage,
        // Complete only when this run itself walked every page from the first.
        completeSnapshot: lastPage && !resumed,
        watermark: `total=${total}`,
      };
      if (lastPage || budgetSpent) return;
    }
    throw new IngestError("pagination_bound", `more than ${MAX_PAGES} pages; raise the bound deliberately`);
  },
};
