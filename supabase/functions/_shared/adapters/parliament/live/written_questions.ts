// New Zealand Parliament: written questions (metadata, identifiers and links only; never question or reply text).
//
// The endpoint is the search API the publisher's own PUBLIC written-questions website calls, with no sign-in
// (access_basis public_undocumented_endpoint). Requests are anonymous: no Origin, Referer, cookie or token.
//
// The corpus is large and it moves: questions are released on sitting days and replies are added to existing
// questions later. Deep pagination over the whole corpus drifts, so the walk is cut into calendar-month partitions
// of the publisher's release date, each read in ASCENDING order (release date, then question number). In that order
// a newly released question lands after the position already read, so growth does not disturb earlier pages.
//
//   mode "backfill"     every month from adapter_options.backfill_from (default 2023-11-01) to the current month
//   mode "incremental"  only the newest adapter_options.incremental_months months (default 2), because replies and
//                       corrections arrive on questions that already exist
//
// Cursor: { mode, partition: "YYYY-MM", next_page, page_size, partition_total }. A partition whose total SHRINKS while
// it is being read, or that repeats an id, is read again from its first page (bounded); that is never a whole-run
// failure. Text is read in memory once, to take its digest and length, and is never placed in a record.

import {
  type Adapter, type AdapterContext, type AdapterPage, IngestError, type IngestRecord,
} from "../../../types.ts";
import { buildWrittenQuestion, witnessText } from "../payload.ts";
import { asRow, builtRecord, convertPage, optionDay, optionInt, parseJsonObject, positiveInt, roomFor } from "./common.ts";

const DEFAULT_PAGE_SIZE = 100;
/** Observed working on 2026-09-20; larger sizes were not tried. */
const MAX_PAGE_SIZE = 250;
const MAX_PAGES_PER_PARTITION = 5000;
const MAX_PARTITION_RESTARTS = 2;
const MAX_PARTITIONS = 120;

export interface QuestionsQuery {
  parliament: number;
  /** "YYYY-MM" */
  partition: string;
  page: number;
  pageSize: number;
}

export function partitionBounds(partition: string): { from: string; to: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(partition);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) throw new IngestError("invalid_cursor", "partition is not a YYYY-MM month");
  const lastDay = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
  return { from: `${partition}-01`, to: `${partition}-${String(lastDay).padStart(2, "0")}` };
}

/** dateFrom and dateTo are both inclusive (observed). column 0 / direction 0 sorts ascending by release date, then number. */
export function questionsRequestBody(query: QuestionsQuery): string {
  const { from, to } = partitionBounds(query.partition);
  return JSON.stringify({
    page: query.page, pageSize: query.pageSize, parliament: String(query.parliament), dateFrom: from, dateTo: to, column: 0, direction: 0,
  });
}

/** Months from the month of fromDay to the month current in New Zealand at `now`, oldest first. */
export function monthPartitions(fromDay: string, now: Date): string[] {
  // New Zealand is 12 to 13 hours ahead of UTC; 14 hours of slack means the newest local month is never missed.
  const end = new Date(now.getTime() + 14 * 3600_000);
  let year = Number(fromDay.slice(0, 4));
  let month = Number(fromDay.slice(5, 7));
  const out: string[] = [];
  while (year < end.getUTCFullYear() || (year === end.getUTCFullYear() && month <= end.getUTCMonth() + 1)) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
    if (out.length > MAX_PARTITIONS) throw new IngestError("pagination_bound", `more than ${MAX_PARTITIONS} month partitions; raise the bound deliberately`);
  }
  return out;
}

export interface ParsedQuestionsPage {
  total: number;
  items: { [key: string]: unknown }[];
}

export function parseQuestionsPage(body: string, query: QuestionsQuery): ParsedQuestionsPage {
  const data = parseJsonObject(body, "written questions endpoint");
  const total = data["@odata.count"];
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0 || !Array.isArray(data.value)) {
    throw new IngestError("parse_error", "written questions response lacks value or a whole-number @odata.count");
  }
  if (data.value.length > query.pageSize) throw new IngestError("parse_error", "publisher returned more rows than the requested page size");
  if (total === 0 && data.value.length > 0) throw new IngestError("parse_error", "publisher reported zero questions but returned rows");
  const items = data.value.map((raw) => {
    const item = asRow(raw, "written question");
    // An unrecognised filter is silently ignored by this family of endpoints, so every row is checked against the
    // request: a row from another Parliament or another month means the filter stopped working. Fail closed.
    if (item.parliamentNumber !== query.parliament) throw new IngestError("parse_error", "row is outside the requested Parliament; the filter may have stopped working");
    if (typeof item.questionReleasedDate !== "string" || item.questionReleasedDate.slice(0, 7) !== query.partition) {
      throw new IngestError("parse_error", "row is outside the requested month; the date filter may have stopped working");
    }
    return item;
  });
  return { total, items };
}

export async function questionRecord(item: { [key: string]: unknown }, retrievedAt: string): Promise<IngestRecord> {
  const question = await witnessText(item.questionText);
  const reply = await witnessText(item.replyText);
  return await builtRecord(() => buildWrittenQuestion({
    id: item.id, title: item.title, questionNumber: item.questionNumber, questionYear: item.questionYear,
    parliamentNumber: item.parliamentNumber, documentRef: item.writtenQuestionsDocumentId,
    questionReleasedDate: item.questionReleasedDate, lastModified: item.lastModified, memberId: item.memberId,
    ministerName: item.ministerName, ministerialDisplayName: item.ministerialDisplayName,
    portfolioRef: item.portfolioId_PortfolioMinister, roleRef: item.roleId, statusId: item.statusId,
    attachmentId: item.attachmentId, attachmentSize: item.attachmentSize, question, reply,
  }), retrievedAt);
}

interface QuestionsCursor {
  mode?: string;
  partition?: string;
  next_page?: number;
  page_size?: number;
  partition_total?: number | null;
}

export const writtenQuestionsAdapter: Adapter = {
  name: "nz_parliament_written_questions",
  version: "1.0.0",
  async *pages(ctx: AdapterContext): AsyncGenerator<AdapterPage> {
    const options = ctx.source.adapter_options;
    const mode = options?.mode === "backfill" ? "backfill" : "incremental";
    if (options?.mode !== undefined && options.mode !== "backfill" && options.mode !== "incremental") {
      throw new IngestError("invalid_adapter_options", "adapter option mode must be backfill or incremental");
    }
    const parliament = optionInt(options, "parliament", 54, 1, 200);
    const pageSize = Math.max(1, Math.min(optionInt(options, "page_size", DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE), ctx.maxRecords));
    const all = monthPartitions(optionDay(options, "backfill_from", "2023-11-01"), ctx.now());
    const partitions = mode === "backfill" ? all : all.slice(-optionInt(options, "incremental_months", 2, 1, 24));
    const url = new URL(ctx.source.official_url).origin + "/api/data/search";

    const resume = ctx.resumeCursor as QuestionsCursor | null;
    let startIndex = 0;
    let startPage = 1;
    let startTotal: number | null = null;
    let resumed = false;
    if (resume && resume.mode === mode && typeof resume.partition === "string" && /^\d{4}-\d{2}$/.test(resume.partition)) {
      if (resume.partition > partitions[partitions.length - 1]) {
        // The earlier attempt had already read every partition; only its final bookkeeping was lost.
        yield { records: [], cursor: { ...resume }, done: true, completeSnapshot: false, watermark: `partition=${resume.partition} finished` };
        return;
      }
      const index = partitions.indexOf(resume.partition);
      if (index >= 0) {
        startIndex = index;
        const nextPage = positiveInt(resume.next_page) ?? 1;
        startPage = convertPage(nextPage, positiveInt(resume.page_size) ?? pageSize, pageSize);
        startTotal = startPage > 1 && typeof resume.partition_total === "number" ? resume.partition_total : null;
        resumed = index > 0 || startPage > 1;
      }
    }

    let emitted = 0;
    for (let index = startIndex; index < partitions.length; index++) {
      const partition = partitions[index];
      const lastPartition = index === partitions.length - 1;
      let page = index === startIndex ? startPage : 1;
      let total: number | null = index === startIndex ? startTotal : null;
      let restarts = 0;
      // Identifiers of one month only: the corpus is never held in memory.
      const seen = new Set<string>();

      for (;;) {
        if (!roomFor(ctx, emitted, pageSize)) return;
        if (page > MAX_PAGES_PER_PARTITION) throw new IngestError("pagination_bound", `more than ${MAX_PAGES_PER_PARTITION} pages in one month; raise the bound deliberately`);
        const query: QuestionsQuery = { parliament, partition, page, pageSize };
        const response = await ctx.fetch({
          url, method: "POST", body: questionsRequestBody(query), accept: "application/json",
          // No Origin or Referer: this client never presents itself as the publisher's own front end.
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
        const parsed = parseQuestionsPage(response.text, query);
        const ids = parsed.items.map((item) => (typeof item.id === "string" ? item.id.toLowerCase() : ""));
        const shrank = total !== null && parsed.total < total;
        const repeated = ids.some((id, position) => id !== "" && (seen.has(id) || ids.indexOf(id) !== position));
        if (shrank || repeated) {
          // The month moved under the walk (a withdrawal shifts every later row). Read this month again from its start.
          if (++restarts > MAX_PARTITION_RESTARTS) {
            throw new IngestError("source_changed_during_pagination", `month ${partition} kept changing while it was read; try again later`);
          }
          page = 1;
          total = null;
          seen.clear();
          continue;
        }
        total = parsed.total;
        const records: IngestRecord[] = [];
        for (let position = 0; position < parsed.items.length; position++) {
          records.push(await questionRecord(parsed.items[position], response.retrievedAt));
          seen.add(ids[position]);
        }
        emitted += records.length;
        // A page past the end is answered with a server error, so the end is worked out from the total, never probed.
        const lastPage = page * pageSize >= total || parsed.items.length === 0;
        const done = lastPage && lastPartition;
        if (done && emitted === 0 && !resumed) {
          // Every month asked about was empty. That is normal in a recess or after a dissolution, and it is also what a
          // broken filter looks like. One unfiltered count for the Parliament tells the two apart.
          const check = await ctx.fetch({
            url, method: "POST", accept: "application/json", headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ page: 1, pageSize: 1, parliament: String(parliament), column: 0, direction: 0 }),
          });
          const count = parseJsonObject(check.text, "written questions endpoint")["@odata.count"];
          if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
            throw new IngestError("parse_error", "no written question in any month and none for the Parliament; treated as a fault, not as no questions");
          }
        }
        const next = lastPage
          ? { mode, partition: followingMonth(partition), next_page: 1, page_size: pageSize, partition_total: null }
          : { mode, partition, next_page: page + 1, page_size: pageSize, partition_total: total };
        yield {
          records,
          cursor: next,
          // done means every partition of this mode was read. Stopping early for budget leaves done=false, so the
          // runner records a partial run and the next one resumes from this cursor.
          done,
          // A moving, append-mostly corpus read in slices is never a complete snapshot: nothing is ever tombstoned.
          completeSnapshot: false,
          watermark: `partition=${partition} total=${total}`,
        };
        if (lastPage) break;
        page++;
      }
    }
  },
};

export function followingMonth(partition: string): string {
  const year = Number(partition.slice(0, 4));
  const month = Number(partition.slice(5, 7));
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}
