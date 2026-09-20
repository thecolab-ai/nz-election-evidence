// Parliament family, live routes: the adapters, the source configurations they need and the schedules proposed for them.
// The family's registry fragment merges these; nothing here edits the shared registry.
//
// What is enabled here is what was exercised end to end against the publisher on 2026-09-20 (LIVE-NOTES.md). A backfill
// source is never schedule-enabled: it is run deliberately from the CLI, which does not require `enabled`, and resumed
// across runs from its checkpoint. Eligibility to COLLECT says nothing about rights to PUBLISH.

import type { Adapter, ScheduleConfig, SourceConfig } from "../../../types.ts";
import { billPublicationsAdapter } from "./bill_publications.ts";
import { committeeBusinessAdapter } from "./committee_business.ts";
import { committeeReportsAdapter } from "./committee_reports.ts";
import { releasesListingAdapter } from "./releases_listing.ts";
import { writtenQuestionsAdapter } from "./written_questions.ts";

export const PARLIAMENT_LIVE_ADAPTERS: { [name: string]: Adapter } = {
  [writtenQuestionsAdapter.name]: writtenQuestionsAdapter,
  [committeeReportsAdapter.name]: committeeReportsAdapter,
  [committeeBusinessAdapter.name]: committeeBusinessAdapter,
  [billPublicationsAdapter.name]: billPublicationsAdapter,
  [releasesListingAdapter.name]: releasesListingAdapter,
};

const PARLIAMENT = "New Zealand Parliament";
const UNDOCUMENTED_NOTE = "The search endpoint the publisher's own public website calls, without any sign-in. It is undocumented and has no published "
  + "terms of use of its own. Under the owner's collection policy of 2026-09-20 that is a reported signal, not a veto. Requests are anonymous and carry "
  + "no Origin, Referer, cookie or token. No permission from the publisher is claimed.";
const QUESTIONS_NOTE = " Question and reply text is read in memory only to take a digest and a length, and is never stored.";

const questionsBase = {
  registry_key: "parliament_written_questions", publisher: PARLIAMENT, official_url: "https://questions.parliament.nz/",
  adapter_kind: "live_fetch", adapter_name: writtenQuestionsAdapter.name, allowed_hosts: ["questions.parliament.nz"], rights_id: "RIGHTS-10",
  view_scope: "current_parliament", snapshot_semantics: "append_only_feed", access_basis: "public_undocumented_endpoint", min_interval_ms: 3000,
  access_note: UNDOCUMENTED_NOTE + QUESTIONS_NOTE,
} as const;

export const PARLIAMENT_LIVE_SOURCES: SourceConfig[] = [
  {
    ...questionsBase, allowed_hosts: [...questionsBase.allowed_hosts],
    source_id: "nz_parliament_written_questions_recent", title: "Written questions, newest two months (metadata only)",
    expected_cadence_seconds: 86400, enabled: true, adapter_options: { mode: "incremental", incremental_months: 2, parliament: 54 },
    catalogue_products: [{ product_id: "P24", mapping_note: "Live incremental route: re-reads the newest two months of release dates, because replies are added to existing questions later. Identifiers, people, official metadata, text digests and links; no question or reply text. A different route to the same publisher items as the export source; never added to it." }],
  },
  {
    ...questionsBase, allowed_hosts: [...questionsBase.allowed_hosts],
    source_id: "nz_parliament_written_questions_backfill", title: "Written questions, 54th Parliament from its start (metadata only)",
    enabled: false, blocked_reason: "Backfill route: about 1,900 paced requests. Run deliberately from the CLI and resumed from its checkpoint; never scheduled.",
    adapter_options: { mode: "backfill", backfill_from: "2023-11-01", parliament: 54 },
    catalogue_products: [{ product_id: "P24", mapping_note: "Live backfill route: every month of release dates from November 2023 to now, month by month. The publisher counted 187,956 questions for the 54th Parliament on 2026-09-20. No question or reply text." }],
  },
  {
    source_id: "nz_parliament_committee_reports", registry_key: "parliament_committee_reports", title: "Select committee reports index, 54th Parliament (metadata only)",
    publisher: PARLIAMENT, official_url: "https://selectcommittees.parliament.nz/", adapter_kind: "live_fetch", adapter_name: committeeReportsAdapter.name,
    allowed_hosts: ["selectcommittees.parliament.nz"], rights_id: "RIGHTS-12", view_scope: "current_parliament", expected_cadence_seconds: 86400,
    snapshot_semantics: "complete_snapshot", enabled: true, adapter_options: { parliament: 54 }, access_basis: "public_undocumented_endpoint", min_interval_ms: 3000,
    access_note: UNDOCUMENTED_NOTE + " No report text and no attachment is requested.",
    catalogue_products: [{ product_id: "P07", mapping_note: "Live route to the reports index: backfill and refresh are the same complete walk (1,286 reports counted by the publisher on 2026-09-20). Titles, committee, dates, identifiers and links only." }],
  },
  {
    source_id: "nz_parliament_committee_business", registry_key: "parliament_committee_business", title: "Business currently before select committees (metadata only)",
    publisher: PARLIAMENT, official_url: "https://selectcommittees.parliament.nz/", adapter_kind: "live_fetch", adapter_name: committeeBusinessAdapter.name,
    allowed_hosts: ["selectcommittees.parliament.nz"], rights_id: "RIGHTS-11", view_scope: "current_parliament", expected_cadence_seconds: 21600,
    snapshot_semantics: "complete_snapshot", enabled: true, adapter_options: { parliament: 54 }, access_basis: "public_undocumented_endpoint", min_interval_ms: 3000,
    access_note: UNDOCUMENTED_NOTE + " The public page address per item type has not been checked by a person; see LIVE-NOTES.md.",
    catalogue_products: [{ product_id: "P05", mapping_note: "Live route to the current index of business before committees (123 items counted by the publisher on 2026-09-20). A complete walk is a true snapshot: an item that is reported back leaves the list." }],
  },
  {
    source_id: "nz_parliament_bill_publications", registry_key: "parliament_bill_publications", title: "Published revisions of current bills (metadata only)",
    publisher: "New Zealand Parliament / New Zealand Legislation", official_url: "https://bills.parliament.nz/", adapter_kind: "live_fetch",
    adapter_name: billPublicationsAdapter.name, allowed_hosts: ["bills.parliament.nz", "www.legislation.govt.nz"], rights_id: "RIGHTS-09",
    view_scope: "current_parliament", expected_cadence_seconds: 86400, snapshot_semantics: "rolling_window", enabled: false,
    blocked_reason: "Works from the CLI, but waits on a person's decision: the legislation website's robots.txt disallows the versions index path (recorded as an advisory), and the way the index address is derived was checked on three bills only. See LIVE-NOTES.md.",
    access_basis: "public_undocumented_endpoint", min_interval_ms: 3000,
    access_note: UNDOCUMENTED_NOTE + " On the legislation website only a bill's public versions index page is read; no PDF and no bill text is ever requested.",
    catalogue_products: [{ product_id: "P02", mapping_note: "Live route: per current bill, the revisions its versions index lists (revision id, version date, official PDF link) and one set record per bill. When an index cannot be read the set says so and gives no count." }],
  },
  {
    source_id: "nz_government_releases_listing", registry_key: "government_releases", title: "Government releases archive listing (link and title only)",
    publisher: "New Zealand Government / Beehive", official_url: "https://www.beehive.govt.nz/releases", adapter_kind: "live_fetch",
    adapter_name: releasesListingAdapter.name, allowed_hosts: ["www.beehive.govt.nz"], rights_id: "RIGHTS-08", view_scope: "general",
    snapshot_semantics: "append_only_feed", enabled: false,
    blocked_reason: "On 2026-09-20 the listing answered this project's automated client with a firewall challenge (one attempt, not retried, not worked around). The listing markup has therefore never been observed and the parser is unverified. The releases feed stays the live route.",
    access_basis: "public_page", min_interval_ms: 5000,
    access_note: "Public listing pages only; a release page is never requested and no release text is stored. A challenge is final.",
    catalogue_products: [{ product_id: "P01", mapping_note: "Backfill route through the public paginated listing. Blocked at the time of writing; nothing has been collected through it." }],
  },
];

export const PARLIAMENT_LIVE_SCHEDULES: ScheduleConfig[] = [
  // The function accepts at most 2,000 records per call: 20 pages of 100. A pass over two months is a chain of partial
  // runs, each resumed from the last checkpoint; a month of 19,000 questions takes about ten calls.
  { schedule_key: "written-questions-recent-20-minutely", source_id: "nz_parliament_written_questions_recent", cron_expr: "10,30,50 * * * *", function_slug: "ingest-run", max_runtime_seconds: 130, max_records: 2000 },
  // 26 pages of 50: usually one call; otherwise the next call resumes and no snapshot is claimed.
  { schedule_key: "committee-reports-daily", source_id: "nz_parliament_committee_reports", cron_expr: "25 16 * * *", function_slug: "ingest-run", max_runtime_seconds: 140, max_records: 2000 },
  { schedule_key: "committee-business-6-hourly", source_id: "nz_parliament_committee_business", cron_expr: "5 */6 * * *", function_slug: "ingest-run", max_runtime_seconds: 60, max_records: 500 },
];
