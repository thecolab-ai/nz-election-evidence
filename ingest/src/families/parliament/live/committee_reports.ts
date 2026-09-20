// New Zealand Parliament: select committee reports index for one Parliament (metadata and link only; never report
// text, never an attachment download). Request shape and totals: see LIVE-NOTES.md.

import type { IngestRecord } from "../../../../../supabase/functions/_shared/types.ts";
import { buildCommitteeReport } from "../payload.ts";
import { builtRecord } from "./common.ts";
import { committeeSearchAdapter, parseCommitteeSearchPage, type ParsedSearchPage } from "./committee_search.ts";

/** documentPreset 0 is the publisher's reports index. `parliament` must be a string or the filter is ignored. */
export function committeeReportsRequestBody(query: { parliament: number; page: number; pageSize: number }): string {
  return JSON.stringify({
    keyword: "", documentPreset: 0, page: query.page, pageSize: query.pageSize, column: 0, direction: 1, searchTab: "All",
    parliament: String(query.parliament),
  });
}

export function parseCommitteeReportsPage(body: string, parliament: number, pageSize: number): ParsedSearchPage {
  return parseCommitteeSearchPage(body, "committee report", { parliament, pageSize, documentTypes: ["SelectCommitteeReport"] });
}

export async function committeeReportRecord(item: { [key: string]: unknown }, retrievedAt: string): Promise<IngestRecord> {
  return await builtRecord(() => buildCommitteeReport({
    id: item.id, title: item.title, subtitle: item.subtitle, itemType: item.itemType, documentType: item.documentType,
    selectCommittee: item.selectCommittee, parliamentNumber: item.parliamentNumber, publicationDate: item.publicationDate,
    lastModified: item.lastModified, attachmentId: item.attachmentId, status: item.status,
  }), retrievedAt);
}

export const committeeReportsAdapter = committeeSearchAdapter({
  name: "nz_parliament_committee_reports",
  version: "1.0.0",
  what: "committee report",
  documentTypes: ["SelectCommitteeReport"],
  requestBody: committeeReportsRequestBody,
  record: committeeReportRecord,
});
