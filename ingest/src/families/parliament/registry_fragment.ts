// Parliament family: registry fragment. The coordinator merges this into the shared source registry
// (see INTEGRATION.md); nothing here edits the shared registry, runner or CLI.
//
// Every catalogue product the family owns has
//   - an EXPORT route: the pinned export of the earlier upstream collection (the backfill that carries real history), and
//   - where the publisher serves an anonymous public endpoint, a LIVE route with a backfill and an incremental source.
// A live source and an export source for the same product are different routes to the same publisher items. They keep
// separate records and histories and are never added together: evidence_private.record_route_keys counts an item once.

import type { Adapter, ExportContract, ScheduleConfig, SourceConfig, SourcesFile, ViewScope } from "../../../../supabase/functions/_shared/types.ts";
import { type FamilyExportContract, PARLIAMENT_EXPORT_CONTRACTS } from "./contracts.ts";
import { FAMILY_EXPORT_ADAPTER } from "./import.ts";
import { PARLIAMENT_LIVE_ADAPTERS, PARLIAMENT_LIVE_SOURCES, PARLIAMENT_LIVE_SCHEDULES } from "./live_sources.ts";

interface ExportSourceFacts {
  publisher: string;
  official_url: string;
  rights_id: string;
  view_scope: ViewScope;
  registry_key: string;
  mapping_notes: { [productId: string]: string };
}

const PARLIAMENT = "New Zealand Parliament";

const EXPORT_FACTS: { [sourceId: string]: ExportSourceFacts } = {
  parliament_export_releases_history: {
    publisher: "New Zealand Government / Beehive", official_url: "https://www.beehive.govt.nz/releases", rights_id: "RIGHTS-08", view_scope: "general",
    registry_key: "government_releases",
    mapping_notes: { P01: "The 4,735-release product: 4,745 collected observations of 4,735 releases dated from 29 November 2023. Titles, publisher dates, links, page digests; no release text. The releases feed is another route to the newest of the same items and is reconciled by link, not added." },
  },
  parliament_export_release_attributions: {
    publisher: "New Zealand Government / Beehive", official_url: "https://www.beehive.govt.nz/releases", rights_id: "RIGHTS-08", view_scope: "general",
    registry_key: "government_releases",
    mapping_notes: { P01: "Ministers and portfolios the publisher names on 530 items collected 12 September 2026 (536 observations). Not a count of releases: 525 of the items are also in the 4,735-release product." },
  },
  parliament_export_bill_publications: {
    publisher: "New Zealand Parliament / New Zealand Legislation", official_url: "https://www.legislation.govt.nz/", rights_id: "RIGHTS-09", view_scope: "current_parliament",
    registry_key: "parliament_bill_publications",
    mapping_notes: { P02: "The 201-record product: 115 published revisions and 86 per-bill revision sets, for bills current in the 54th Parliament on 19 September 2026. Links, publisher dates, sizes and digests; no bill text. The catalogue notes four known retrieval gaps upstream; they are not filled here." },
  },
  parliament_export_current_bills_history: {
    publisher: PARLIAMENT, official_url: "https://bills.parliament.nz/", rights_id: "RIGHTS-09", view_scope: "current_parliament",
    registry_key: "parliament_bills",
    mapping_notes: { P03: "Earlier observations of the current bills index, 15 to 19 September 2026: 582 observations of 101 bills. Same record shape as the live current-bills source, which stays the current route; this source adds the history before it and never writes to it." },
  },
  parliament_export_bill_register: {
    publisher: PARLIAMENT, official_url: "https://bills.parliament.nz/", rights_id: "RIGHTS-09", view_scope: "current_parliament",
    registry_key: "parliament_bills",
    mapping_notes: { P03: "Coverage beyond the current index: 3,533 bills of the 43rd to 54th Parliaments as collected 12 September 2026, with the publisher's dated stages. The bills in the current index are among them and are reconciled by publisher bill id, not added." },
  },
  parliament_export_committee_business: {
    publisher: PARLIAMENT, official_url: "https://selectcommittees.parliament.nz/", rights_id: "RIGHTS-11", view_scope: "current_parliament",
    registry_key: "parliament_committee_business",
    mapping_notes: { P05: "The 123-item product: 124 observations of 123 items of business before committees, collected 19 September 2026." },
  },
  parliament_export_committee_report_files: {
    publisher: PARLIAMENT, official_url: "https://selectcommittees.parliament.nz/", rights_id: "RIGHTS-12", view_scope: "current_parliament",
    registry_key: "parliament_committee_reports",
    mapping_notes: { P06: "The 1,285 report files: official download link, size, digest, publisher date, and the report each belongs to. Report text is not imported. A file is not a second report: P06 and P07 are never added." },
  },
  parliament_export_committee_reports: {
    publisher: PARLIAMENT, official_url: "https://selectcommittees.parliament.nz/", rights_id: "RIGHTS-12", view_scope: "current_parliament",
    registry_key: "parliament_committee_reports",
    mapping_notes: { P07: "The 1,286-report index of the 54th Parliament: 1,536 observations of 1,286 reports, collected 19 September 2026." },
  },
  parliament_export_member_terms: {
    publisher: PARLIAMENT, official_url: "https://catalogue.data.govt.nz/dataset/f0f878d5-e2da-477d-85a0-4d2006f8b558", rights_id: "RIGHTS-13", view_scope: "current_parliament",
    registry_key: "parliament_members",
    mapping_notes: { P10: "Coverage beyond the directory: 122 members' current terms. 115 carry the start date Parliament's open-data member-terms file states; 7 came from a file that states none and stay undated. No date is inferred. The live directory stays the current route and is not written to." },
  },
  parliament_export_minister_roles: {
    publisher: "New Zealand Government / Beehive", official_url: "https://www.beehive.govt.nz/ministers", rights_id: "RIGHTS-08", view_scope: "current_parliament",
    registry_key: "parliament_members",
    mapping_notes: { P10: "111 ministerial roles as listed on official minister pages read 12 September 2026. The pages state no appointment dates, so none are stored." },
  },
  parliament_export_written_questions: {
    publisher: PARLIAMENT, official_url: "https://questions.parliament.nz/", rights_id: "RIGHTS-10", view_scope: "current_parliament",
    registry_key: "parliament_written_questions",
    mapping_notes: { P24: "The 187,956-question product: 225,322 collected observations of 187,956 written questions of the 54th Parliament, collected 19 September 2026. Identifiers, people, portfolios, publisher dates, links, and a digest and length of each text; no question or reply text. The source states no answer date and no lodgement date, so neither is stored." },
  },
};

function sharedContract(contract: FamilyExportContract): ExportContract {
  return {
    fileEnv: contract.fileEnv,
    manifestEnv: contract.manifestEnv,
    manifestChecksumPath: ["export", "sha256"],
    manifestRowsPath: ["export", "rows"],
    recordKind: contract.record_kinds[0],
    idField: "see_family_contract",
    sourceUrlField: "see_family_contract",
    observedAtField: "observed_at",
    originalHashField: "upstream_content_hash",
    // Scalar columns only: this shared shape cannot describe a list. The family contract (contracts.ts) is the authority
    // and the family importer enforces it; the generic JSONL importer must not be used for these sources.
    allowedFields: contract.columns.filter((c) => c.type === "string" || c.type === "integer" || c.type === "boolean")
      .filter((c) => c.name !== "observed_at" && c.name !== "upstream_content_hash")
      .map((c) => ({ from: c.name, to: c.name, type: c.type === "integer" ? "integer" as const : c.type === "boolean" ? "boolean" as const : "string" as const })),
    droppedFields: contract.withheld_upstream,
    expectedRowsNote: contract.pin
      ? `${contract.pin.rows} observations of ${contract.pin.distinct_records} publisher items; pinned by checksum`
      : "not pinned: no verified export exists yet, so this source cannot be imported",
    ...(contract.pin ? { expectedInput: { sha256: contract.pin.sha256, rows: contract.pin.rows } } : {}),
  };
}

export const PARLIAMENT_EXPORT_SOURCES: SourceConfig[] = PARLIAMENT_EXPORT_CONTRACTS.map((contract) => {
  const facts = EXPORT_FACTS[contract.source_id];
  if (!facts) throw new Error(`no registry facts for ${contract.source_id}`);
  return {
    source_id: contract.source_id, registry_key: facts.registry_key, title: contract.title, publisher: facts.publisher,
    official_url: facts.official_url, adapter_kind: "export_import", adapter_name: FAMILY_EXPORT_ADAPTER, allowed_hosts: [],
    rights_id: facts.rights_id, view_scope: facts.view_scope,
    // An export says what was collected then, not what the publisher lists now: nothing is ever tombstoned from it.
    snapshot_semantics: "rolling_window", enabled: false,
    catalogue_products: contract.product_ids.map((product_id) => ({ product_id, mapping_note: facts.mapping_notes[product_id] ?? "" })),
    export_contract: sharedContract(contract),
  };
});

export const PARLIAMENT_REGISTRY_PRODUCTS: SourcesFile["registry_products"] = [
  { registry_key: "parliament_bill_publications", title: "Bill publications (published revisions)", domain: "Parliament and law" },
  { registry_key: "parliament_committee_business", title: "Business before select committees", domain: "Parliament and law" },
  { registry_key: "parliament_committee_reports", title: "Select committee reports", domain: "Parliament and law" },
];

export const PARLIAMENT_SOURCES: SourceConfig[] = [...PARLIAMENT_EXPORT_SOURCES, ...PARLIAMENT_LIVE_SOURCES];
export const PARLIAMENT_SCHEDULES: ScheduleConfig[] = PARLIAMENT_LIVE_SCHEDULES;
export const PARLIAMENT_ADAPTERS: { [name: string]: Adapter } = PARLIAMENT_LIVE_ADAPTERS;

/**
 * The shared registry with this family merged in. Existing entries win on a clash of identifiers, so the fragment can
 * never redefine a source another lane owns; a clash is reported so the coordinator sees it.
 */
export function mergeIntoRegistry(base: SourcesFile): { file: SourcesFile; clashes: string[] } {
  const clashes: string[] = [];
  const sources = [...base.sources];
  for (const source of PARLIAMENT_SOURCES) {
    if (sources.some((s) => s.source_id === source.source_id)) clashes.push(`source ${source.source_id}`);
    else sources.push(source);
  }
  const products = [...base.registry_products];
  for (const product of PARLIAMENT_REGISTRY_PRODUCTS) if (!products.some((p) => p.registry_key === product.registry_key)) products.push(product);
  const schedules = [...base.schedules];
  for (const schedule of PARLIAMENT_SCHEDULES) {
    if (schedules.some((s) => s.schedule_key === schedule.schedule_key)) clashes.push(`schedule ${schedule.schedule_key}`);
    else schedules.push(schedule);
  }
  return { file: { ...base, registry_products: products, sources, schedules }, clashes };
}
