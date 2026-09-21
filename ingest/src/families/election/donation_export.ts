// P25: the donations a party or candidate DISCLOSED inside a filed Electoral Commission return.
//
// P15/P16/P17 already hold the Commission's index of filed returns and the totals it prints on its own pages.
// This product is the next layer down and the one a reader actually asks for: which part of the return the money
// was disclosed under, how much was disclosed under it, and - where the form's own arithmetic proves the reading
// is complete - who each disclosed donation came from, for how much, on the dates the return states.
//
// ONE UPSTREAM ROW BECOMES MANY EXPORT ROWS. A return document produces one `donation_return_part` record per part
// the form fills in, and one `donation_disclosure_entry` record per itemised entry of a part that reconciled. Each
// gets its own external record id derived from the document's, so each has its own version history.
//
// WHAT NEVER LEAVES THIS FILE. The upstream payload carries `full_text`: the extracted text of the return PDF,
// which includes donors' street addresses. That text is read here and is never written to an export row - not the
// text, not the address, not a hash of either. What is written is the typed result of `parseReturn`: parts,
// statuses, amounts, dates, and donor names that `donorName` proved are names.

import {
  DONATION_PARSER_VERSION, ELECTION_YEARS, type ParsedPart, parseReturn,
} from "./donations.ts";
import { type ExportRow, isoDate, MappingError, type ProductId, type SafeJson, utcIso, type WarehouseRow, withProvenanceKeys } from "./mapping.ts";

/**
 * One product per return family, because they are different publications: different years, different index pages
 * and different rights rows. P25 reads the 2023 candidate returns that P15 indexes; P26 reads the 2025 party
 * annual returns that P17 indexes.
 */
export interface DonationSourceSpec {
  product: ProductId;
  source_id: string;
  reporting_year: number;
  return_kind: "party_annual_return" | "candidate_election_return";
}

export const DONATION_SOURCES: DonationSourceSpec[] = [
  { product: "P25", source_id: "political_finance_2023_candidate_returns", reporting_year: 2023, return_kind: "candidate_election_return" },
  { product: "P26", source_id: "political_finance_2025_returns", reporting_year: 2025, return_kind: "party_annual_return" },
];

/** Counts of what one document gave, so a run can say how much of the corpus it could read. */
export interface DocumentOutcome {
  source_id: string;
  document_status: "read" | "form_title_not_found" | "no_part_summary_found";
  parts: number;
  entries: number;
  parts_reconciled: number;
  named_donors: number;
  donors_not_separable: number;
  donors_withheld_by_publisher: number;
}

export interface DonationExport {
  rows: ExportRow[];
  outcomes: DocumentOutcome[];
  /** Upstream row versions offered to the reader, after exact duplicates were dropped. */
  versions_offered: number;
  /** Distinct return documents behind those versions: a document can have more than one version upstream. */
  documents_offered: number;
  /**
   * How many (filer, year, part) keys more than one DOCUMENT publishes - an original return and an amendment of
   * it. Reported, never silently merged, and refused outright where both documents itemise (`overlappingDocuments`).
   */
  overlapping_document_parts: number;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : undefined;
}

function sha256(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https:\/\/[A-Za-z0-9.-]+(\/[^\s]*)?$/.test(value) && value.length <= 2000 ? value : undefined;
}

/**
 * What every row of this product carries about the return it came from: who filed it, for which year, under which
 * form, and the two official links (the document itself and the Commission index page that lists it).
 */
function returnContext(payload: { [key: string]: unknown }, spec: DonationSourceSpec): { [key: string]: SafeJson } {
  const year = typeof payload.reporting_year === "number" ? payload.reporting_year : undefined;
  if (year !== spec.reporting_year) throw new MappingError(`return document is not for ${spec.reporting_year}`);
  const party = text(payload.party_name_as_published, 200);
  const context: { [key: string]: SafeJson } = {
    reporting_year: year,
    return_kind: spec.return_kind,
    amounts_basis: "return_document_as_filed",
    disclosure_reader_version: DONATION_PARSER_VERSION,
    // Part A of an annual return for a general-election year also carries that year's separately published
    // $20,000 notices. Marked on every row so the two are never added together.
    overlaps_election_year_notices: ELECTION_YEARS.includes(year),
    amendment_labelled: payload.amendment_labelled === true,
  };
  if (party) context.party_name_as_published = party;
  const candidate = text(payload.candidate_name_as_published, 200);
  const electorate = text(payload.electorate_as_published, 120);
  if (spec.return_kind === "candidate_election_return") {
    if (!candidate || !electorate) throw new MappingError("candidate return without the published name and electorate");
    context.candidate_name_as_published = candidate;
    context.electorate_as_published = electorate;
  }
  const version = text(payload.document_version_type, 80);
  if (version) context.document_version_type = version;
  const indexPage = httpsUrl(payload.catalogue_source_url);
  if (indexPage) context.catalogue_page_url = indexPage;
  const indexHash = sha256(payload.catalogue_source_sha256);
  if (indexHash) context.catalogue_page_sha256 = indexHash;
  return context;
}

/** The part's own row: its printed total and how completely the part could be read. */
function partRow(part: ParsedPart, context: { [key: string]: SafeJson }, row: WarehouseRow, official: string, digest: string | undefined, product: ProductId): ExportRow {
  const payload: { [key: string]: SafeJson } = {
    ...context,
    disclosure_part: part.part,
    part_label_as_published: part.label_as_published,
    disclosure_kind: part.disclosure_kind,
    donor_identity_kind: part.donor_identity_kind,
    disclosed_total_status: part.total_status,
    entries_disclosed: part.entries_seen,
    itemisation_status: part.itemisation_status,
    itemisation_note: part.itemisation_note,
  };
  if (part.total_nzd !== null) payload.disclosed_total_nzd = part.total_nzd;
  return exportRow(row, `${row.record_id}#part-${part.part}`, "donation_return_part", payload, official, digest, product);
}

/** One disclosed donation, loan or contribution, as the return itemises it. */
function entryRows(part: ParsedPart, context: { [key: string]: SafeJson }, row: WarehouseRow, official: string, digest: string | undefined, product: ProductId): ExportRow[] {
  return part.entries.map((entry) => {
    const payload: { [key: string]: SafeJson } = {
      ...context,
      disclosure_part: part.part,
      part_label_as_published: part.label_as_published,
      disclosure_kind: part.disclosure_kind,
      donor_identity_kind: entry.donor_identity_kind,
      entry_index: entry.entry_index,
      donor_name_status: entry.donor_name_status,
      disclosed_amount_nzd: entry.amount_nzd,
      donation_dates: entry.donation_dates.filter((d) => isoDate(d) !== undefined),
      date_disclosure: entry.date_disclosure,
    };
    if (entry.donor_name_as_published !== null) payload.donor_name_as_published = entry.donor_name_as_published;
    const ordinal = String(entry.entry_index).padStart(4, "0");
    return exportRow(row, `${row.record_id}#part-${part.part}-entry-${ordinal}`, "donation_disclosure_entry", payload, official, digest, product);
  });
}

function exportRow(row: WarehouseRow, id: string, kind: string, payload: { [key: string]: SafeJson }, official: string, digest: string | undefined, product: ProductId): ExportRow {
  return withProvenanceKeys({
    product_id: product,
    source_id: row.source_id,
    external_record_id: id,
    record_kind: kind,
    official_url: official,
    collected_at: utcIso(row.observed_at),
    upstream_content_hash: row.content_hash,
    original_sha256: digest,
    payload,
    omitted: OMITTED,
  });
}

/**
 * Stated once for every row of this product: the upstream payload's whole document text is read to produce these
 * fields and is never carried. The street address printed beside a donor's name in the return is part of that
 * text: it is separated off and dropped before a name is ever produced.
 */
const OMITTED: { field: string; reason: string }[] = [
  { field: "full_text", reason: "the extracted text of the return document; this project keeps the official link, the typed disclosures and a hash, never the text" },
  { field: "unlisted_field", reason: "the street address printed beside a donor's name is separated off and never kept" },
  { field: "raw_pdf_bytes", reason: "location and bytes of a private capture file" },
];

/** Reads one return document into its part rows and entry rows. A document that is not a form gives nothing. */
export function mapReturnDocument(row: WarehouseRow, spec: DonationSourceSpec): { rows: ExportRow[]; outcome: DocumentOutcome } {
  let payload: { [key: string]: unknown };
  try {
    const value: unknown = JSON.parse(row.payload_json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    payload = value as { [key: string]: unknown };
  } catch {
    throw new MappingError("upstream payload is not JSON");
  }
  const official = httpsUrl(row.source_url);
  if (!official) throw new MappingError("row has no plain https official URL");
  if (!/^[0-9a-f]{64}$/.test(row.content_hash)) throw new MappingError("row has no upstream content hash");
  const digest = sha256(payload.raw_pdf_sha256) ?? sha256(payload.original_raw_pdf_sha256);

  const parsed = parseReturn(typeof payload.full_text === "string" ? payload.full_text : "");
  const outcome: DocumentOutcome = {
    source_id: row.source_id, document_status: parsed.document_status, parts: 0, entries: 0, parts_reconciled: 0,
    named_donors: 0, donors_not_separable: 0, donors_withheld_by_publisher: 0,
  };
  if (parsed.document_status !== "read") return { rows: [], outcome };

  // A document that says it is one form while the index says it is the other is a contradiction, not a reading.
  if (parsed.form !== spec.return_kind) throw new MappingError("the return document is not the form this source files");
  const context = returnContext(payload, spec);
  const rows: ExportRow[] = [];
  for (const part of parsed.parts) {
    rows.push(partRow(part, context, row, official, digest, spec.product));
    outcome.parts += 1;
    if (part.itemisation_status === "reconciled") outcome.parts_reconciled += 1;
    const entries = entryRows(part, context, row, official, digest, spec.product);
    rows.push(...entries);
    outcome.entries += entries.length;
    for (const entry of part.entries) {
      if (entry.donor_name_status === "published") outcome.named_donors += 1;
      else if (entry.donor_name_status === "not_separable") outcome.donors_not_separable += 1;
      else outcome.donors_withheld_by_publisher += 1;
    }
  }
  return { rows, outcome };
}

/**
 * A filer may file a return and then file an AMENDED one, and the Commission publishes the amendment as its own
 * document. Both are filings and both are kept: this project records what each document says, and deciding that
 * one replaces the other is the publisher's statement, not this reader's inference. What must never happen is the
 * same itemised donation reaching a reader twice, once from each document, as if it were two donations.
 *
 * So the overlap is counted rather than assumed away, and the one case that would double a figure - two documents
 * of the same filer, year and part BOTH publishing itemised entries - is refused outright. A part that publishes
 * only its printed total may overlap: two documents stating a total is two statements, and no view adds them.
 */
function overlappingDocuments(rows: ExportRow[]): { keys: number; refuse: string | null } {
  const filer = (payload: { [key: string]: SafeJson }) => [
    payload.return_kind, payload.reporting_year, payload.party_name_as_published ?? "",
    payload.candidate_name_as_published ?? "", payload.electorate_as_published ?? "", payload.disclosure_part,
  ].join("\u0000");
  const documents = new Map<string, Set<string>>();
  const itemising = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = filer(row.payload);
    if (row.record_kind === "donation_return_part") (documents.get(key) ?? documents.set(key, new Set()).get(key)!).add(row.official_url);
    else (itemising.get(key) ?? itemising.set(key, new Set()).get(key)!).add(row.official_url);
  }
  let keys = 0;
  for (const [key, urls] of documents) {
    if (urls.size < 2) continue;
    keys += 1;
    if ((itemising.get(key)?.size ?? 0) > 1) {
      return { keys, refuse: `two documents of the same filer, year and part ${key.split("\u0000").pop()} both publish itemised entries; a reader would be shown one donation twice` };
    }
  }
  return { keys, refuse: null };
}

/** Every return document of one donation source, in a stable order. */
export function mapDonationRows(rows: WarehouseRow[], spec: DonationSourceSpec): DonationExport {
  const out: ExportRow[] = [];
  const outcomes: DocumentOutcome[] = [];
  const seen = new Set<string>();
  for (const row of rows.sort((a, b) => a.record_id.localeCompare(b.record_id) || a.observed_at.localeCompare(b.observed_at) || a.content_hash.localeCompare(b.content_hash))) {
    const key = row.record_id + "\n" + row.content_hash + "\n" + row.observed_at;
    if (seen.has(key)) continue;
    seen.add(key);
    const { rows: mapped, outcome } = mapReturnDocument(row, spec);
    out.push(...mapped);
    outcomes.push(outcome);
  }
  const overlap = overlappingDocuments(out);
  if (overlap.refuse) throw new MappingError(overlap.refuse);
  return {
    rows: out, outcomes, versions_offered: outcomes.length,
    documents_offered: new Set(rows.map((row) => row.record_id)).size,
    overlapping_document_parts: overlap.keys,
  };
}

/** What a run of this product can say about its own coverage, in counts only. */
export function donationCoverage(outcomes: DocumentOutcome[]): { [name: string]: number } {
  const total = (pick: (o: DocumentOutcome) => number) => outcomes.reduce((a, o) => a + pick(o), 0);
  return {
    documents_offered: outcomes.length,
    documents_read: outcomes.filter((o) => o.document_status === "read").length,
    documents_without_a_recognised_form: outcomes.filter((o) => o.document_status === "form_title_not_found").length,
    documents_without_a_part_summary: outcomes.filter((o) => o.document_status === "no_part_summary_found").length,
    part_disclosures: total((o) => o.parts),
    parts_reconciled: total((o) => o.parts_reconciled),
    itemised_entries: total((o) => o.entries),
    donors_named: total((o) => o.named_donors),
    donors_not_separable: total((o) => o.donors_not_separable),
    donors_withheld_by_publisher: total((o) => o.donors_withheld_by_publisher),
  };
}
