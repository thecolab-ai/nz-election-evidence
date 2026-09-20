// Election family import contracts: the second, independent allowlist.
//
// The exporter already drops everything outside its allowlist. The importer does not trust that: every
// export line is checked again against the closed contract of its record kind. A key the contract does not
// name, a value of the wrong shape, or a forbidden name anywhere refuses the WHOLE file before a run exists.

import type { VersionedExportRow } from "./exporter.ts";
import { isoDate, type SafeJson } from "./mapping.ts";

/** Keys every kind may carry: what makes a new version beyond the product's own fields (see withProvenanceKeys). */
const COMMON_FIELDS: { [key: string]: FieldType } = { original_document_digest: "sha256_letters", publisher_stated_date: "string" };

export type FieldType = "string" | "integer" | "number" | "boolean" | "https_url" | "sha256" | "sha256_letters" | "iso_date";

type Shape = { [key: string]: FieldType };

export interface KindContract {
  product: string;
  fields: Shape;
  required: string[];
  /** Arrays of objects, each with its own closed shape. */
  lists?: { [key: string]: { item: Shape; required: string[]; maxItems: number } };
  /** Arrays of plain values. */
  valueLists?: { [key: string]: { type: FieldType; maxItems: number } };
  /** Closed vocabularies. */
  enums?: { [key: string]: string[] };
  /** Closed vocabularies inside lists, and the list field that must not repeat. */
  listEnums?: { [list: string]: { [key: string]: string[] } };
  listUnique?: { [list: string]: string };
}

const CAPTURE = { capture_mode: "string", archive_complete: "boolean" } as const;

const FINANCE_DOCUMENT: Shape = {
  reporting_year: "integer", return_kind: "string", party_name_as_published: "string", amendment_labelled: "boolean",
  capture_status: "string", identity_status: "string", normalization_status: "string", text_layer_status: "string",
  is_image_only: "boolean", catalogue_page_url: "https_url", catalogue_page_sha256: "sha256", page_count: "integer",
};

const AMOUNT_STATUS = ["reported", "reported_nil", "not_reported"];

export const KIND_CONTRACTS: { [recordKind: string]: KindContract } = {
  election_nationwide_party_result: {
    product: "P08", required: ["election_year", "party_name", "result_scope"],
    fields: { ...CAPTURE, election_year: "integer", result_scope: "string", coverage_scope: "string", party_name: "string", party_votes: "integer", vote_percent: "number", electorate_seats: "integer", list_seats: "integer", total_seats: "integer" },
    enums: { result_scope: ["nationwide_party_vote"] },
  },
  election_nationwide_total: {
    product: "P08", required: ["election_year", "result_scope"],
    fields: { ...CAPTURE, election_year: "integer", result_scope: "string", coverage_scope: "string", party_votes: "integer", electorate_seats: "integer", list_seats: "integer", total_seats: "integer" },
    enums: { result_scope: ["nationwide_party_vote_total"] },
  },
  election_electorate_vote: {
    product: "P09", required: ["election_year", "electorate_number", "electorate_name", "vote_type", "name_at_source"],
    fields: {
      ...CAPTURE, product_complete: "boolean", election_year: "integer", electorate_number: "integer", electorate_name: "string", result_scope: "string",
      vote_type: "string", name_at_source: "string", source_display_order: "integer", votes: "integer", baseline_candidacy_ref: "string", baseline_candidacy_join: "string",
    },
    enums: { vote_type: ["candidate", "party"], result_scope: ["electorate_vote_result"], baseline_candidacy_join: ["official_page_and_published_name_and_votes"] },
  },
  election_electorate_summary: {
    product: "P09", required: ["election_year", "electorate_number", "electorate_name"],
    fields: {
      ...CAPTURE, product_complete: "boolean", election_year: "integer", electorate_number: "integer", electorate_name: "string", result_scope: "string",
      candidate_total: "integer", candidate_informals: "integer", candidate_result_count: "integer", party_total: "integer", party_informals: "integer",
      party_result_count: "integer", votes_counted: "integer", votes_counted_pct: "number",
    },
    enums: { result_scope: ["electorate_summary"] },
  },
  party_policy_page: {
    product: "P13", required: ["party_name", "upstream_label_model_metadata"],
    fields: {
      party_name: "string", document_title: "string", capture_status: "string", current_official_policy_source: "boolean",
      upstream_unreviewed_label: "string", upstream_label_origin: "string", upstream_label_algorithm: "string", upstream_label_baseline: "string",
      upstream_label_model_metadata: "string", source_published_basis: "string", linked_document_count: "integer",
    },
    enums: { upstream_label_model_metadata: ["not_recorded"] },
  },
  party_vote_poll: {
    product: "P14", required: ["pollster", "methodology_status", "results"],
    fields: {
      pollster: "string", commissioner: "string", sponsor: "string", disclosure_sponsor: "string", disclosure_provider: "string",
      fieldwork_start: "iso_date", fieldwork_end: "iso_date", sample_size: "integer", disclosure_sample_size: "integer", disclosure_margin_of_error: "string",
      disclosure_mode: "string", document_title: "string", capture_status: "string", index_url: "https_url", disclosure_url: "https_url",
      disclosure_source_url: "https_url", verification_status: "string", metadata_complete_public_poll: "boolean", metadata_completeness_reason: "string",
      methodology_status: "string",
    },
    lists: { results: { item: { party_label: "string", value_pct: "number", value_status: "string" }, required: ["party_label", "value_status"], maxItems: 40 } },
    enums: { methodology_status: ["verified", "unresolved"] },
    listEnums: { results: { value_status: ["reported", "not_reported"] } }, listUnique: { results: "party_label" },
  },
  finance_candidate_return: {
    product: "P15", required: ["reporting_year", "candidate_name_as_published", "electorate_as_published", "is_image_only", "amounts_basis"],
    fields: {
      ...FINANCE_DOCUMENT, candidate_name_as_published: "string", electorate_as_published: "string", amounts_basis: "string",
      expenses_as_published_status: "string", expenses_as_published_nzd: "number", donations_as_published_status: "string", donations_as_published_nzd: "number",
      loans_as_published_status: "string", loans_as_published_nzd: "number",
    },
    enums: { expenses_as_published_status: AMOUNT_STATUS, donations_as_published_status: AMOUNT_STATUS, loans_as_published_status: AMOUNT_STATUS, amounts_basis: ["commission_index_page_as_published"] },
  },
  finance_party_aggregate: {
    product: "P16", required: ["reporting_year", "party_name_as_published", "aggregates", "amounts_basis"],
    fields: { reporting_year: "integer", party_name_as_published: "string", capture_mode: "string", period_start: "iso_date", period_end: "iso_date", amounts_basis: "string" },
    lists: {
      aggregates: {
        item: { metric: "string", value_status: "string", amount_nzd: "number", filing_date_mapping: "string", audit_report_as_published: "string", filing_dates: "string" },
        required: ["metric", "value_status"], maxItems: 4,
      },
    },
    valueLists: { return_urls: { type: "https_url", maxItems: 10 } },
    enums: { amounts_basis: ["commission_published_summary_not_recomputed"] },
    listEnums: { aggregates: { value_status: AMOUNT_STATUS, metric: ["party_donations_sum", "party_loans_sum"] } }, listUnique: { aggregates: "metric" },
  },
  finance_party_return: {
    product: "P17", required: ["reporting_year", "party_name_as_published", "is_image_only"],
    fields: { ...FINANCE_DOCUMENT, document_version_type: "string", page_count_from_document: "integer", pages_visually_reviewed: "integer", transcription_scope: "string" },
  },
  election_2026_official_page_status: {
    product: "C26A", required: ["upstream_election_ref", "official_page_status", "candidate_details_available"],
    fields: { upstream_election_ref: "string", election_name: "string", official_page_status: "string", candidate_details_available: "string", election_date: "iso_date" },
    enums: { candidate_details_available: ["unknown"], official_page_status: ["official_map_identified", "official_page_unavailable"] },
  },
  election_2026_boundary_map_link: {
    product: "C26B", required: ["boundary_edition", "link_kind"],
    fields: { upstream_election_ref: "string", boundary_edition: "string", boundary_type_at_source: "string", boundary_scope: "string", link_kind: "string" },
    enums: { link_kind: ["official_summary_map_document"] },
  },
};

/** Names that may never appear as a key at any depth, whatever a contract says. Mirrors the database guard. */
export const FORBIDDEN_KEY = /^(e[-_]?mail|phone|mobile|fax|address|street|postcode|donor.*|contributor.*|body|html|raw.*|full_text|content_html|file_path|archive_path|local_path|storage_url|signed_url|source_record_json|payload_json|source_passage|password|secret|token|api_key|credential.*|document_text|.*ocr.*)$/i;

const TEXT_GUARDS: { name: string; test: RegExp }[] = [
  { name: "an e-mail-like value", test: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "a file location", test: /(^|["\s=:(,])(file:\/\/|~\/|[A-Za-z]:\\|\/(home|Users|root|var|mnt|srv|etc|tmp|opt|data)\/)/ },
  { name: "control characters", test: /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/ },
];

function typeOk(type: FieldType, value: SafeJson): boolean {
  switch (type) {
    case "string": return typeof value === "string" && value.length > 0 && value.length <= 400;
    case "integer": return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    case "number": return typeof value === "number" && Number.isFinite(value) && value >= 0;
    case "boolean": return typeof value === "boolean";
    case "https_url": return typeof value === "string" && /^https:\/\/[A-Za-z0-9.-]+(\/[^\s]*)?$/.test(value) && value.length <= 2000;
    case "sha256": return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
    case "sha256_letters": return typeof value === "string" && /^[a-p]{64}$/.test(value);
    case "iso_date": return isoDate(value) !== undefined;
  }
}

/** Returns the first problem found, without echoing any value. */
export function contractProblem(row: VersionedExportRow): string | null {
  const contract = KIND_CONTRACTS[row.record_kind];
  if (!contract) return "record kind has no import contract";
  if (contract.product !== row.product_id) return "record kind does not belong to this product";
  if (typeof row.payload !== "object" || row.payload === null || Array.isArray(row.payload)) return "payload is not an object";
  for (const key of contract.required) if (!Object.hasOwn(row.payload, key)) return `required field ${key} is missing`;
  for (const [key, value] of Object.entries(row.payload)) {
    if (FORBIDDEN_KEY.test(key)) return "payload carries a forbidden field name";
    const list = contract.lists?.[key];
    const values = contract.valueLists?.[key];
    if (list) {
      if (!Array.isArray(value) || value.length > list.maxItems) return `list ${key} is not an array within its size limit`;
      const unique = contract.listUnique?.[key];
      if (unique && new Set(value.map((item) => (item as { [k: string]: SafeJson })?.[unique])).size !== value.length) return `list ${key} repeats a ${unique}`;
      for (const item of value) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return `list ${key} holds a non-object`;
        for (const need of list.required) if (!Object.hasOwn(item, need)) return `list ${key} item lacks ${need}`;
        for (const [itemKey, itemValue] of Object.entries(item)) {
          if (FORBIDDEN_KEY.test(itemKey)) return "payload carries a forbidden field name";
          const type = list.item[itemKey];
          if (!type) return `list ${key} item carries a field outside the contract`;
          if (itemKey === "filing_dates") {
            if (!Array.isArray(itemValue) || itemValue.some((d) => !typeOk("iso_date", d))) return "filing_dates is not a list of dates";
          } else if (!typeOk(type, itemValue)) return `list ${key} field ${itemKey} has the wrong shape`;
          const allowedInList = contract.listEnums?.[key]?.[itemKey];
          if (allowedInList && !allowedInList.includes(String(itemValue))) return `list ${key} field ${itemKey} holds a value outside the documented vocabulary`;
          if (itemKey === "value_pct" && (itemValue as number) > 100) return "a percentage above 100";
        }
        const entry = item as { [k: string]: SafeJson };
        if ("value_pct" in entry !== (entry.value_status === "reported") && key === "results") return "a poll value and its status disagree";
        if (key === "aggregates") {
          if (("amount_nzd" in entry) !== (entry.value_status !== "not_reported")) return "an aggregate amount and its status disagree";
          if (entry.value_status === "reported_nil" && entry.amount_nzd !== 0) return "a reported nil with a non-zero amount";
        }
      }
    } else if (values) {
      if (!Array.isArray(value) || value.length > values.maxItems || value.some((v) => !typeOk(values.type, v))) return `list ${key} has the wrong shape`;
    } else {
      const type = contract.fields[key] ?? COMMON_FIELDS[key];
      if (!type) return "payload carries a field outside the contract";
      if ((key === "sample_size" || key === "disclosure_sample_size") && value === 0) return `field ${key} is zero`;
      if (!typeOk(type, value)) return `field ${key} has the wrong shape`;
      const allowed = contract.enums?.[key];
      if (allowed && !allowed.includes(String(value))) return `field ${key} holds a value outside the documented vocabulary`;
    }
  }
  const textOfRow = JSON.stringify(row.payload);
  if (Buffer.byteLength(textOfRow) > 8000) return "payload is larger than the store accepts";
  for (const guard of TEXT_GUARDS) if (guard.test.test(textOfRow)) return `payload holds ${guard.name}`;
  // Mirror of the store's phone-number heuristic, so a row it would reject refuses the whole file here, before any write.
  if (/(^|[^0-9])(\+?64|0)[ -]?[2-9][0-9]?[ -]?[0-9]{3}[ -]?[0-9]{3,4}([^0-9]|$)/.test(textOfRow) && /(ph|phone|mob|tel|call)/i.test(textOfRow)) {
    return "payload holds a digit run the store would read as a phone number";
  }
  return null;
}
