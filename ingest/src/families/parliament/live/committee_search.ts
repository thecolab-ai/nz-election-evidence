// Shared walker for the select-committees search endpoint (reports index, business before committees).
//
// The endpoint is the search API the publisher's own PUBLIC select-committees website calls, with no sign-in
// (access_basis public_undocumented_endpoint). Requests are anonymous: no Origin, Referer, cookie or token.
// Same discipline as the current-bills adapter: resumable by page, the total must stay stable across pages, a
// repeated id is a fault, and stopping early for budget leaves done=false.

import {
  type Adapter, type AdapterContext, type AdapterPage, IngestError, type IngestRecord,
} from "../../../../../supabase/functions/_shared/types.ts";
import { asRow, convertPage, optionInt, parseJsonObject, positiveInt, roomFor } from "./common.ts";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGES = 400;

export interface ParsedSearchPage {
  total: number;
  items: { [key: string]: unknown }[];
}

/**
 * An unrecognised filter is silently ignored by this endpoint, so each row is checked against what was asked for:
 * the right Parliament and an accepted document type. Anything else fails the run instead of being counted.
 */
export function parseCommitteeSearchPage(body: string, what: string, expect: { parliament: number; pageSize: number; documentTypes?: readonly string[] }): ParsedSearchPage {
  const data = parseJsonObject(body, `${what} endpoint`);
  if (!Array.isArray(data.results) || typeof data.totalResults !== "number" || !Number.isInteger(data.totalResults) || data.totalResults <= 0) {
    throw new IngestError("parse_error", `${what} response lacks results or a positive totalResults`);
  }
  if (data.results.length > expect.pageSize) throw new IngestError("parse_error", "publisher returned more rows than the requested page size");
  const items = data.results.map((raw) => {
    const item = asRow(raw, what);
    if (item.parliamentNumber !== expect.parliament) throw new IngestError("parse_error", `${what} row is outside the requested Parliament; the filter may have stopped working`);
    if (expect.documentTypes && !(typeof item.documentType === "string" && expect.documentTypes.includes(item.documentType))) {
      throw new IngestError("parse_error", `${what} row has an unexpected document type; the filter may have stopped working`);
    }
    return item;
  });
  return { total: data.totalResults, items };
}

export interface CommitteeSearchSpec {
  name: string;
  version: string;
  what: string;
  documentTypes?: readonly string[];
  requestBody(query: { parliament: number; page: number; pageSize: number }): string;
  record(item: { [key: string]: unknown }, retrievedAt: string): Promise<IngestRecord>;
}

export function committeeSearchAdapter(spec: CommitteeSearchSpec): Adapter {
  return {
    name: spec.name,
    version: spec.version,
    async *pages(ctx: AdapterContext): AsyncGenerator<AdapterPage> {
      const options = ctx.source.adapter_options;
      const parliament = optionInt(options, "parliament", 54, 1, 200);
      const pageSize = Math.max(1, Math.min(optionInt(options, "page_size", DEFAULT_PAGE_SIZE, 1, 100), ctx.maxRecords));
      const url = new URL(ctx.source.official_url).origin + "/api/data/search";
      const resume = ctx.resumeCursor as { next_page?: number; total?: number; page_size?: number } | null;
      let page = convertPage(positiveInt(resume?.next_page) ?? 1, positiveInt(resume?.page_size) ?? pageSize, pageSize);
      let total: number | null = page > 1 ? positiveInt(resume?.total) : null;
      const resumed = page > 1;
      let emitted = 0;
      const seen = new Set<string>();

      for (; page <= MAX_PAGES; page++) {
        if (!roomFor(ctx, emitted, pageSize)) return;
        const response = await ctx.fetch({
          url, method: "POST", body: spec.requestBody({ parliament, page, pageSize }), accept: "application/json",
          // No Origin or Referer: this client never presents itself as the publisher's own front end.
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
        const parsed = parseCommitteeSearchPage(response.text, spec.what, { parliament, pageSize, documentTypes: spec.documentTypes });
        if (total !== null && parsed.total !== total) {
          throw new IngestError("source_changed_during_pagination", `${spec.what} total changed between pages; restart for a consistent snapshot`);
        }
        total = parsed.total;
        const records: IngestRecord[] = [];
        for (const item of parsed.items) {
          const record = await spec.record(item, response.retrievedAt);
          if (seen.has(record.external_record_id)) throw new IngestError("parse_error", `duplicate ${spec.what} id across pages`);
          seen.add(record.external_record_id);
          records.push(record);
        }
        emitted += records.length;
        const lastPage = page * pageSize >= total || parsed.items.length === 0;
        yield {
          records,
          cursor: { next_page: page + 1, total, page_size: pageSize },
          // done means the publisher's list is exhausted. Stopping early for budget leaves done=false.
          done: lastPage,
          // Complete only when this run itself walked every page from the first AND saw as many ids as the publisher counts.
          completeSnapshot: lastPage && !resumed && seen.size === total,
          watermark: `total=${total}`,
        };
        if (lastPage) return;
      }
      throw new IngestError("pagination_bound", `more than ${MAX_PAGES} pages; raise the bound deliberately`);
    },
  };
}
