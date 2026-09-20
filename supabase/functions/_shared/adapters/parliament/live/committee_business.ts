// New Zealand Parliament: the current index of business before select committees (metadata and link only).
// The publisher's list shrinks as items are reported back, so a complete walk is a true snapshot of what is before
// committees now. Request shape and totals: see LIVE-NOTES.md.

import type { IngestRecord } from "../../../types.ts";
import { buildCommitteeBusinessItem } from "../payload.ts";
import { builtRecord } from "./common.ts";
import { committeeSearchAdapter, parseCommitteeSearchPage, type ParsedSearchPage } from "./committee_search.ts";

/** documentPreset 1 is the publisher's business index; beforeCommittee true narrows it to business not yet reported back. */
export function committeeBusinessRequestBody(query: { parliament: number; page: number; pageSize: number }): string {
  return JSON.stringify({
    keyword: "", documentPreset: 1, beforeCommittee: true, page: query.page, pageSize: query.pageSize, column: 0, direction: 1,
    searchTab: "All", parliament: String(query.parliament),
  });
}

export function parseCommitteeBusinessPage(body: string, parliament: number, pageSize: number): ParsedSearchPage {
  return parseCommitteeSearchPage(body, "committee business item", { parliament, pageSize });
}

export async function committeeBusinessRecord(item: { [key: string]: unknown }, retrievedAt: string): Promise<IngestRecord> {
  // The search result carries no page address. The family default (/v/13/<id>) is used; see LIVE-NOTES.md.
  return await builtRecord(() => buildCommitteeBusinessItem({
    id: item.id, title: item.title, subtitle: item.subtitle, documentType: item.documentType, itemType: item.itemType,
    selectCommittee: item.selectCommittee, parliamentNumber: item.parliamentNumber, publicationDate: item.publicationDate,
    lastModified: item.lastModified, attachmentId: item.attachmentId,
  }), retrievedAt);
}

export const committeeBusinessAdapter = committeeSearchAdapter({
  name: "nz_parliament_committee_business",
  version: "1.0.0",
  what: "committee business item",
  requestBody: committeeBusinessRequestBody,
  record: committeeBusinessRecord,
});
