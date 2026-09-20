// Election family incremental routes: anonymous, read-only requests to public pages, through the shared
// guarded fetch (host allowlist, pacing, robots.txt recorded as an advisory, one attempt at a challenge,
// no sign-in, no paywall, nothing worked around).
//
// Route de-duplication: a live route never creates a second document or poll row for something the
// reconciled export already holds. Live records are change signals with their own record kinds
// (policy_page_check, poll_index_row); the family projection ignores those kinds on purpose. Turning a
// newly seen poll into a poll row needs its methodology disclosure checked first, which the export route does.

import { contentHash, sha256Hex } from "../../canonical.ts";
import { letterHex, publisherDate } from "./encoding.ts";
import { availabilityProbeAdapter } from "../../adapters/availability_probe.ts";
import {
  type Adapter, type AdapterContext, type AdapterPage, IngestError, type IngestRecord, type Json, type ScheduleConfig,
  type SourceConfig, SourceUnavailableError,
} from "../../types.ts";

const PROJECTION_VERSION = 1;

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// Polls index -----------------------------------------------------------------------------------------------

export interface PollIndexRow {
  fieldwork_start?: string;
  fieldwork_end?: string;
  fieldwork_text: string;
  pollster: string;
  commissioner?: string;
  sample_size?: number;
  results: { party_label: string; value_pct?: number; value_status: "reported" | "not_reported" }[];
}

const FIXED_COLUMNS = ["Fieldwork Period", "Polling Firm", "Commissioner(s)", "Sample Size"];

/** Parses the public index table. A dash or an empty cell is "not reported"; anything unreadable stops the parse. */
export function parsePollIndex(html: string): PollIndexRow[] {
  const head = /<thead[\s\S]*?<\/thead>/i.exec(html)?.[0];
  const body = /<tbody[\s\S]*?<\/tbody>/i.exec(html)?.[0];
  if (!head || !body) throw new IngestError("parse_error", "poll index: table head or body not found");
  const columns = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => cellText(m[1]));
  if (FIXED_COLUMNS.some((name, index) => columns[index] !== name) || columns.length < 6) {
    throw new IngestError("parse_error", "poll index: column layout differs from the one this parser was written for");
  }
  const parties = columns.slice(FIXED_COLUMNS.length);
  const rows: PollIndexRow[] = [];
  for (const match of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]));
    if (cells.length !== columns.length) throw new IngestError("parse_error", "poll index: a row does not have one cell per column");
    const dates = [...cells[0].matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]);
    if (!cells[1]) throw new IngestError("parse_error", "poll index: a row has no polling firm");
    const sample = /^\d{2,6}$/.test(cells[3].replace(/[,\s]/g, "")) ? Number(cells[3].replace(/[,\s]/g, "")) : undefined;
    const results = parties.map((party, index) => {
      const cell = cells[FIXED_COLUMNS.length + index];
      if (cell === "" || /^[—–-]$/.test(cell)) return { party_label: party, value_status: "not_reported" as const };
      const value = /^(\d{1,3}(?:\.\d+)?)\s*%?$/.exec(cell);
      if (!value || Number(value[1]) > 100) throw new IngestError("parse_error", "poll index: a value cell is neither a percentage nor a dash");
      return { party_label: party, value_pct: Number(value[1]), value_status: "reported" as const };
    });
    rows.push({
      fieldwork_start: dates[0], fieldwork_end: dates[1] ?? dates[0], fieldwork_text: cells[0].slice(0, 60), pollster: cells[1].slice(0, 160),
      commissioner: cells[2] && !/^[—–-]$/.test(cells[2]) ? cells[2].slice(0, 160) : undefined, sample_size: sample, results,
    });
  }
  if (rows.length === 0) throw new IngestError("parse_error", "poll index: no rows; treated as a fault, not as an empty source");
  return rows;
}

export const pollIndexAdapter: Adapter = {
  name: "election_poll_index",
  version: "1.0.0",
  async *pages(ctx: AdapterContext): AsyncGenerator<AdapterPage> {
    const response = await ctx.fetch({ url: ctx.source.official_url, accept: "text/html" });
    const rows = parsePollIndex(response.text);
    const windowDays = Number(ctx.source.adapter_options?.incremental_window_days ?? 0);
    const backfill = ctx.maxRecords > 500;
    const cutoff = windowDays > 0 && !backfill ? new Date(ctx.now().getTime() - windowDays * 86400000).toISOString().slice(0, 10) : null;
    const records: IngestRecord[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (cutoff && row.fieldwork_end && row.fieldwork_end < cutoff) continue;
      const id = "poll-index:" + (await sha256Hex([row.fieldwork_text, row.pollster, row.commissioner ?? ""].join("|"))).slice(0, 32);
      if (seen.has(id)) throw new IngestError("parse_error", "poll index: two rows share firm, commissioner and fieldwork period");
      seen.add(id);
      const payload: { [key: string]: Json } = {
        pollster: row.pollster, fieldwork_period_as_published: row.fieldwork_text, results: row.results as unknown as Json,
        methodology_status: "unresolved", index_kind: "third_party_aggregator_index",
      };
      if (row.fieldwork_start) payload.fieldwork_start = row.fieldwork_start;
      if (row.fieldwork_end) payload.fieldwork_end = row.fieldwork_end;
      if (row.commissioner) payload.commissioner = row.commissioner;
      if (row.sample_size) payload.sample_size = row.sample_size;
      records.push({
        external_record_id: id, record_kind: "poll_index_row", content_hash: await contentHash("poll_index_row", PROJECTION_VERSION, payload),
        original_content_hash: "sha256:" + response.bodySha256, source_url: response.finalUrl, retrieved_at: response.retrievedAt,
        projection_version: PROJECTION_VERSION, safe_payload: payload,
        omitted_fields: [{ field: "publisher_date", reason: "the index prints no publication date, so none is recorded" }],
      });
    }
    // The index is a rolling list: a row leaving it says nothing about the poll, so this is never a complete snapshot.
    yield { records, cursor: { rows: records.length }, done: true, completeSnapshot: false, watermark: response.bodySha256 };
  },
};

// Policy pages ------------------------------------------------------------------------------------------------

export function pageFacts(html: string): { title?: string; published?: string; publishedBasis?: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let published: string | undefined;
  for (const block of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const found = /"datePublished"\s*:\s*"([^"]{8,40})"/.exec(block[1])?.[1];
    published = publisherDate(found);
    if (published) break;
  }
  return { title: title ? cellText(title).slice(0, 300) || undefined : undefined, published, publishedBasis: published ? "JSON-LD datePublished on the page" : undefined };
}

export const policyPageMonitorAdapter: Adapter = {
  name: "election_policy_page_monitor",
  version: "1.0.0",
  async *pages(ctx: AdapterContext): AsyncGenerator<AdapterPage> {
    const pages = (ctx.source.adapter_options?.pages ?? []) as { party_name: string; url: string }[];
    if (pages.length === 0) throw new IngestError("config_error", "policy page monitor has no pages configured");
    const resume = ctx.resumeCursor as { next_page?: number } | null;
    const start = resume?.next_page && resume.next_page > 0 ? resume.next_page : 0;
    for (let index = start; index < pages.length; index++) {
      const page = pages[index];
      const payload: { [key: string]: Json } = { party_name: page.party_name, check_kind: "page_hash_and_title" };
      let original: string | undefined;
      let published: string | undefined;
      let retrievedAt = ctx.now().toISOString();
      try {
        const response = await ctx.fetch({ url: page.url, accept: "text/html" });
        const facts = pageFacts(response.text);
        payload.page_status = "retrieved";
        payload.page_digest = letterHex(response.bodySha256);
        if (facts.title) payload.document_title = facts.title;
        if (facts.publishedBasis) payload.source_published_basis = facts.publishedBasis;
        original = "sha256:" + response.bodySha256;
        // A page that states a date later than its own retrieval is not believed.
        published = facts.published && facts.published <= response.retrievedAt ? facts.published : undefined;
        if (!published) delete payload.source_published_basis;
        retrievedAt = response.retrievedAt;
      } catch (error) {
        // One party site that refuses, has moved or is down must not hide the other sixteen: that outcome is the
        // record. Only the run's own deadline, or a fault that is not about this page, stops the run.
        const pageFault = error instanceof SourceUnavailableError
          || (error instanceof IngestError && ["http_error", "network_error", "host_denied", "too_large", "timeout"].includes(error.errorClass) && ctx.now().getTime() < ctx.deadline);
        if (!pageFault) throw error;
        payload.page_status = "unavailable";
        payload.unavailable_outcome = error instanceof SourceUnavailableError ? error.outcome : (error as IngestError).errorClass;
      }
      const record: IngestRecord = {
        external_record_id: "policy-page:" + (await sha256Hex(page.url)).slice(0, 32), record_kind: "policy_page_check",
        // The page hash sits in the payload, so a changed page is a new version and the hash can be recomputed from what is stored.
        content_hash: await contentHash("policy_page_check", PROJECTION_VERSION, payload),
        original_content_hash: original, source_url: page.url, source_published_at: published, retrieved_at: retrievedAt,
        projection_version: PROJECTION_VERSION, safe_payload: payload,
        omitted_fields: [{ field: "page_text", reason: "page text is never stored; the official link and a hash are" }],
      };
      const done = index + 1 >= pages.length;
      yield { records: [record], cursor: { next_page: index + 1 }, done, completeSnapshot: done && start === 0 };
    }
  },
};

export const ELECTION_LIVE_ADAPTERS: { [name: string]: Adapter } = {
  [pollIndexAdapter.name]: pollIndexAdapter,
  [policyPageMonitorAdapter.name]: policyPageMonitorAdapter,
  [availabilityProbeAdapter.name]: availabilityProbeAdapter,
};

// Sources -----------------------------------------------------------------------------------------------------------

const POLICY_PAGES: { party_name: string; url: string }[] = [
  { party_name: "ACT New Zealand", url: "https://www.act.org.nz/policies" },
  { party_name: "Alliance Party of Aotearoa New Zealand", url: "https://allianceparty.nz/what-we-stand-for/" },
  { party_name: "Animal Justice Party Aotearoa New Zealand", url: "https://animaljustice.org.nz/election-2026/election-manifesto/" },
  { party_name: "Aotearoa Legalise Cannabis Party", url: "https://www.alcp.org.nz/policy" },
  { party_name: "Conservative Party NZ", url: "https://www.conservatives.nz/policy" },
  { party_name: "Free Palestine", url: "https://palfree.nz/" },
  { party_name: "Green Party of Aotearoa New Zealand", url: "https://www.greens.org.nz/manifesto_2026" },
  { party_name: "New Zealand First Party", url: "https://www.nzfirst.nz/policy" },
  { party_name: "New Zealand Labour Party", url: "https://www.labour.org.nz/our-policies/" },
  { party_name: "New Zealand Loyal", url: "https://nzloyal.com/policy/" },
  { party_name: "New Zealand National Party", url: "https://www.national.org.nz/policies" },
  { party_name: "NZ Outdoors & Freedom Party", url: "https://nzofp.co.nz/policies" },
  { party_name: "Opportunity Party", url: "https://www.opportunity.org.nz/policy" },
  { party_name: "Te Pāti Māori", url: "https://www.maoriparty.org.nz/policy" },
  { party_name: "Te Tai Tokerau Party", url: "https://tetaitokerauparty.org.nz/our-policies/" },
  { party_name: "Vision New Zealand", url: "https://www.vision.org.nz/visionpolicies" },
  { party_name: "Women’s Rights Party", url: "https://womensrightsparty.nz/our-priorities/" },
];

function ecProbe(sourceId: string, registryKey: string, title: string, url: string, rightsId: string, viewScope: SourceConfig["view_scope"], reason: string, catalogue: SourceConfig["catalogue_products"]): SourceConfig {
  return {
    source_id: sourceId, registry_key: registryKey, title, publisher: "Electoral Commission", official_url: url, adapter_kind: "live_fetch",
    adapter_name: "availability_probe", allowed_hosts: [new URL(url).hostname], rights_id: rightsId, view_scope: viewScope,
    expected_cadence_seconds: 86400, snapshot_semantics: "complete_snapshot", enabled: false, blocked_reason: reason,
    catalogue_products: catalogue, access_basis: "public_page", min_interval_ms: 5000,
  };
}

const CHALLENGED = "The publisher answered this build host with a bot challenge on 2026-09-20 (one attempt, not worked around). ";

export const ELECTION_LIVE_SOURCES: SourceConfig[] = [
  {
    source_id: "party_vote_polls_index", registry_key: "party_vote_polls", title: "Party-vote polls: public index table (change signal)",
    publisher: "Multiple poll publishers", official_url: "https://storage.googleapis.com/asapop-website-oceania-20230809/_widgets/tables/nz.html",
    adapter_kind: "live_fetch", adapter_name: "election_poll_index", allowed_hosts: ["storage.googleapis.com"], rights_id: "RIGHTS-07",
    view_scope: "primary_2026", expected_cadence_seconds: 86400, snapshot_semantics: "rolling_window", enabled: true,
    catalogue_products: [{ product_id: "P14", mapping_note: "Fresh index rows as a change signal. An aggregator index, not a primary publisher: rows carry methodology status unresolved and create no poll row." }],
    adapter_options: { incremental_window_days: 120 }, access_basis: "public_page", min_interval_ms: 5000,
    access_note: "A public, unauthenticated page. It is a third-party index of polls; each poll's own publisher page remains the official link.",
  },
  {
    source_id: "party_policy_pages_2026_monitor", registry_key: "party_policy_pages", title: "Registered-party policy pages, 2026: page hash and title checks",
    publisher: "Registered New Zealand political parties", official_url: "https://www.act.org.nz/policies", adapter_kind: "live_fetch",
    adapter_name: "election_policy_page_monitor", allowed_hosts: [...new Set(POLICY_PAGES.map((p) => new URL(p.url).hostname))].sort(),
    rights_id: "RIGHTS-14", view_scope: "primary_2026", expected_cadence_seconds: 86400, snapshot_semantics: "complete_snapshot", enabled: true,
    catalogue_products: [{ product_id: "P13", mapping_note: "Fresh hash and title of the same 17 official pages. Detects change; stores no page text and assigns no class." }],
    adapter_options: { pages: POLICY_PAGES as unknown as Json }, access_basis: "public_page", min_interval_ms: 5000,
    access_note: "Seventeen public party pages, one request each per run. The list is the reconciled 19 September 2026 denominator; it is not re-derived from the party register, which is unavailable to this host.",
  },
  ecProbe("ec_2023_candidate_returns_index", "candidate_finance_returns", "2023 candidate returns index (availability probe)",
    "https://elections.nz/democracy-in-nz/historical-events/2023-general-election/candidate-expenses-donations-and-loans", "RIGHTS-02", "baseline_2023",
    CHALLENGED + "The 492 document records arrive through the reconciled export instead. Nothing here implies a count.",
    [{ product_id: "P15", mapping_note: "Probe only." }]),
  ecProbe("ec_2026_electorate_finder", "election_2026_boundaries", "2026 electorate finder (availability probe)",
    "https://vote.nz/maps/find-your-electorate-2026", "RIGHTS-21", "primary_2026",
    CHALLENGED + "No 2026 electorate list has been loaded from any route: the number and names of 2026 electorates are unknown here, not zero.", []),
];

export const ELECTION_SCHEDULES: ScheduleConfig[] = [
  { schedule_key: "party_vote_polls_index_daily", source_id: "party_vote_polls_index", cron_expr: "17 19 * * *", function_slug: "ingest-run", max_runtime_seconds: 120, max_records: 500 },
  { schedule_key: "party_policy_pages_2026_monitor_daily", source_id: "party_policy_pages_2026_monitor", cron_expr: "43 18 * * *", function_slug: "ingest-run", max_runtime_seconds: 140, max_records: 100 },
];
