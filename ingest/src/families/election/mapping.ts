// Election family: typed, allowlisted mapping from one upstream warehouse row to one private export row.
//
// Every product names the upstream fields it keeps. Anything else is dropped and the drop is recorded by
// field name and reason; a dropped value is never copied. Three rules hold for every product:
//   - collected_at is when the upstream collector retrieved the page. It is never used as a publisher date.
//     source_published_at exists only where the upstream row carries a date the publisher itself stated.
//   - a null upstream number stays absent (value_status "not_reported"); zero is kept only when the source shows zero.
//   - document text, extracted PDF text, OCR pages, file locations and donor-level detail are never exported.

import { letterHex, publisherDate } from "../../../../supabase/functions/_shared/adapters/election/encoding.ts";

export { letterHex, publisherDate };

export type ProductId = "P08" | "P09" | "P13" | "P14" | "P15" | "P16" | "P17" | "P25" | "P26";

export type SafeJson = null | boolean | number | string | SafeJson[] | { [key: string]: SafeJson };

/** One upstream row as the read-only select returns it. */
export interface WarehouseRow {
  source_id: string;
  record_id: string;
  record_kind: string;
  source_url: string;
  observed_at: string;
  content_hash: string;
  payload_json: string;
}

export interface ExportRow {
  product_id: ProductId;
  source_id: string;
  external_record_id: string;
  record_kind: string;
  /** The publisher's own URL for this record. */
  official_url: string;
  /** When the upstream collector retrieved it (UTC, ISO 8601). Not a publisher date. */
  collected_at: string;
  /** Only when the publisher stated one. */
  source_published_at?: string;
  source_date_text?: string;
  /** Hash of the publisher's original bytes (page or document), as recorded upstream. */
  original_sha256?: string;
  /** Hash the upstream store holds for its full row: ties this export row to exactly one upstream version. */
  upstream_content_hash: string;
  payload: { [key: string]: SafeJson };
  omitted: { field: string; reason: string }[];
}

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingError";
  }
}

type Obj = { [key: string]: unknown };

const REASONS = {
  body: "copied document or page text; this project keeps the official link and a hash, never the text",
  location: "location of a private capture file",
  transport: "upstream capture or transport detail, not a fact about the source",
  derivable: "restates other rows of this product; kept once so nothing is counted twice",
  denominator: "upstream research denominator repeated on every row; reported once in the export manifest",
  unreviewed_quote: "quotation copied from the publisher page",
  ocr: "machine transcription of an image-only document; not reviewed and may carry donor-level detail",
  unlisted: "not on this product's field allowlist",
} as const;

const DROPS: { [field: string]: string } = {
  document_text: REASONS.body, full_text: REASONS.body, full_verbatim_ocr_pages: REASONS.ocr, methodology: REASONS.body,
  classification_evidence_quote: REASONS.unreviewed_quote,
  raw_path: REASONS.location, raw_pdf_path: REASONS.location, text_path: REASONS.location,
  original_raw_pdf_path: REASONS.location, original_embedded_text_path: REASONS.location,
  raw_bytes: REASONS.transport, raw_pdf_bytes: REASONS.transport, original_bytes: REASONS.transport, text_bytes: REASONS.transport,
  text_chars: REASONS.transport, http_status: REASONS.transport, response_headers_selected: REASONS.transport,
  text_extractor: REASONS.transport, pdf_magic_verified: REASONS.transport, capture_error: REASONS.transport,
  leading_candidate: REASONS.derivable, leading_candidate_votes: REASONS.derivable, second_candidate: REASONS.derivable,
  second_candidate_votes: REASONS.derivable, party_vote_leader: REASONS.derivable, party_vote_leader_pct: REASONS.derivable,
  second_party: REASONS.derivable, second_party_pct: REASONS.derivable, majority: REASONS.derivable,
  result_set_scope: REASONS.denominator, registered_party_denominator: REASONS.denominator, product_denominator: REASONS.denominator,
  privacy_note: REASONS.transport, text_sha256: REASONS.transport, original_embedded_text_sha256: REASONS.transport,
};

const PLAIN_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;

function parsePayload(row: WarehouseRow): Obj {
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json);
  } catch {
    throw new MappingError("upstream payload is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new MappingError("upstream payload is not an object");
  return value as Obj;
}

/** The warehouse prints UTC date-times without a zone. */
export function utcIso(value: string): string {
  const text = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : value.replace(" ", "T") + "Z";
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new MappingError("upstream timestamp could not be read");
  return new Date(ms).toISOString();
}

function httpsUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https:\/\/[A-Za-z0-9.-]+(\/[^\s]*)?$/.test(value) && value.length <= 2000 ? value : undefined;
}

function text(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : undefined;
}

function wholeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function decimal(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}

function sha256(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

/** A real calendar date: 2026-02-30 is refused rather than rolled over. */
export function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(value + "T00:00:00Z");
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : undefined;
}

/** Collects what a mapper kept, so everything it did not keep is recorded as omitted. */
class Picker {
  readonly payload: { [key: string]: SafeJson } = {};
  private readonly used = new Set<string>();
  private readonly source: Obj;
  constructor(source: Obj) {
    this.source = source;
  }
  use(...fields: string[]): void {
    for (const field of fields) this.used.add(field);
  }
  put(to: string, from: string, read: (value: unknown) => SafeJson | undefined): void {
    this.used.add(from);
    const value = read(this.source[from]);
    if (value !== undefined) this.payload[to] = value;
  }
  set(to: string, value: SafeJson | undefined): void {
    if (value !== undefined) this.payload[to] = value;
  }
  omitted(): { field: string; reason: string }[] {
    return Object.keys(this.source).filter((key) => !this.used.has(key)).sort().map((key) => ({
      field: PLAIN_FIELD.test(key) ? key : "unlisted_field",
      reason: DROPS[key] ?? REASONS.unlisted,
    }));
  }
}

/**
 * The store decides "new version" from the payload alone. Whatever must make a new version therefore has to be in
 * the payload: the hash of the publisher's original bytes and a publisher-stated date.
 */
export function withProvenanceKeys(row: ExportRow): ExportRow {
  if (row.original_sha256) row.payload.original_document_digest = letterHex(row.original_sha256);
  if (row.source_published_at) row.payload.publisher_stated_date = row.source_published_at;
  return row;
}

function base(product: ProductId, row: WarehouseRow, kind: string, picker: Picker, extra: Partial<ExportRow> = {}): ExportRow {
  const official = httpsUrl(extra.official_url ?? row.source_url);
  if (!official) throw new MappingError("row has no plain https official URL");
  if (!/^[0-9a-f]{64}$/.test(row.content_hash)) throw new MappingError("row has no upstream content hash");
  const collected = utcIso(row.observed_at);
  if (extra.source_published_at && extra.source_published_at > collected) throw new MappingError("publisher date is later than the collection time");
  return withProvenanceKeys({
    product_id: product, source_id: row.source_id, external_record_id: row.record_id, record_kind: kind,
    collected_at: collected, upstream_content_hash: row.content_hash,
    ...extra, official_url: official,
    payload: picker.payload, omitted: picker.omitted(),
  });
}

// P08 -------------------------------------------------------------------------------------------------

export function mapOverallResult(row: WarehouseRow): ExportRow {
  const p = parsePayload(row);
  const pick = new Picker(p);
  const total = p.result_scope === "nationwide_party_vote_total";
  if (!total && p.result_scope !== "nationwide_party_vote") throw new MappingError("unexpected result_scope for the nationwide table");
  if (p.election_year !== 2023) throw new MappingError("nationwide table row is not for 2023");
  pick.put("election_year", "election_year", wholeNumber);
  pick.put("result_scope", "result_scope", (v) => text(v, 60));
  pick.put("coverage_scope", "coverage_scope", (v) => text(v, 80));
  pick.put("capture_mode", "capture_mode", (v) => text(v, 40));
  pick.put("archive_complete", "archive_complete", (v) => (typeof v === "boolean" ? v : undefined));
  pick.use("publisher", "source_sha256");
  if (!total) {
    pick.put("party_name", "party_name", (v) => text(v, 200));
    if (!pick.payload.party_name) throw new MappingError("party row without a party name");
    pick.put("vote_percent", "vote_percent", decimal);
  }
  // Seats are blank for parties the table gives no seats line for: absent here, never zero.
  pick.put("party_votes", "party_votes", wholeNumber);
  pick.put("electorate_seats", "electorate_seats", wholeNumber);
  pick.put("list_seats", "list_seats", wholeNumber);
  pick.put("total_seats", "total_seats", wholeNumber);
  return base("P08", row, total ? "election_nationwide_total" : "election_nationwide_party_result", pick, { original_sha256: sha256(p.source_sha256) });
}

// P09 -------------------------------------------------------------------------------------------------

export function mapElectorateResult(row: WarehouseRow): ExportRow {
  const p = parsePayload(row);
  const pick = new Picker(p);
  if (p.election_year !== 2023) throw new MappingError("electorate result row is not for 2023");
  const number = wholeNumber(p.electorate_id);
  if (number === undefined || number < 1 || number > 72) throw new MappingError("electorate number outside 1-72");
  if (!new RegExp(`/electorate-details-${String(number).padStart(2, "0")}\\.html$`).test(row.source_url)) {
    throw new MappingError("electorate number does not match the official page the row cites");
  }
  pick.put("election_year", "election_year", wholeNumber);
  pick.put("electorate_number", "electorate_id", wholeNumber);
  pick.put("electorate_name", "electorate_name", (v) => text(v, 120));
  pick.put("result_scope", "result_scope", (v) => text(v, 60));
  pick.put("capture_mode", "capture_mode", (v) => text(v, 40));
  pick.put("archive_complete", "archive_complete", (v) => (typeof v === "boolean" ? v : undefined));
  pick.put("product_complete", "product_complete", (v) => (typeof v === "boolean" ? v : undefined));
  pick.use("publisher", "source_sha256");
  let kind: string;
  if (p.result_scope === "electorate_vote_result") {
    if (p.vote_type !== "candidate" && p.vote_type !== "party") throw new MappingError("vote_type outside the documented vocabulary");
    kind = "election_electorate_vote";
    pick.put("vote_type", "vote_type", (v) => text(v, 20));
    pick.put("name_at_source", "entity_name", (v) => text(v, 200));
    pick.put("source_display_order", "source_display_order", wholeNumber);
    pick.put("votes", "votes", wholeNumber);
    if (!pick.payload.name_at_source) throw new MappingError("vote row without a name");
  } else if (p.result_scope === "electorate_summary") {
    kind = "election_electorate_summary";
    for (const field of ["candidate_total", "candidate_informals", "candidate_result_count", "party_total", "party_informals", "party_result_count", "votes_counted"]) {
      pick.put(field, field, wholeNumber);
    }
    pick.put("votes_counted_pct", "votes_counted_pct", decimal);
  } else {
    throw new MappingError("unexpected result_scope for an electorate page");
  }
  return base("P09", row, kind, pick, { original_sha256: sha256(p.source_sha256) });
}

// P13 -------------------------------------------------------------------------------------------------

export function mapPolicyPage(row: WarehouseRow): ExportRow {
  const p = parsePayload(row);
  const pick = new Picker(p);
  const url = httpsUrl(p.policy_url);
  if (!url) throw new MappingError("policy row without an official https policy URL");
  pick.use("policy_url");
  pick.put("party_name", "party_name", (v) => text(v, 200));
  if (!pick.payload.party_name) throw new MappingError("policy row without a party name");
  pick.put("document_title", "document_title", (v) => text(v, 300));
  pick.put("capture_status", "capture_status", (v) => text(v, 60));
  pick.put("current_official_policy_source", "current_official_policy_source", (v) => (typeof v === "boolean" ? v : undefined));
  // The upstream label is carried as what it is: an unreviewed upstream label. It never becomes this
  // project's policy class; that needs a recorded model run or a person's review.
  pick.put("upstream_unreviewed_label", "policy_classification", (v) => text(v, 80));
  pick.put("upstream_label_origin", "classification_source", (v) => text(v, 160));
  pick.put("upstream_label_algorithm", "classification_algorithm", (v) => text(v, 120));
  pick.put("upstream_label_baseline", "classification_baseline", (v) => text(v, 80));
  pick.use("classification_label", "classification_refresh_reason");
  pick.set("upstream_label_model_metadata", "not_recorded");
  pick.put("source_published_basis", "source_published_basis", (v) => text(v, 160));
  pick.use("source_published_at", "document_sha256");
  const documents = Array.isArray(p.current_documents) ? p.current_documents : [];
  pick.use("current_documents", "independent_review_capture");
  pick.set("linked_document_count", documents.length);
  const published = publisherDate(p.source_published_at);
  if (published && !pick.payload.source_published_basis) throw new MappingError("a publisher date is kept only with the basis it was read from");
  const out = base("P13", row, "party_policy_page", pick, { official_url: url, original_sha256: sha256(p.document_sha256), source_published_at: published });
  out.omitted.push(
    { field: "classification_label", reason: "upstream free-text rationale; only the short upstream label is kept, marked unreviewed" },
    { field: "current_documents", reason: "linked document list is counted, not copied" },
    { field: "independent_review_capture", reason: REASONS.transport },
  );
  out.omitted.sort((a, b) => a.field.localeCompare(b.field));
  return out;
}

// P14 -------------------------------------------------------------------------------------------------

export function mapPoll(row: WarehouseRow): ExportRow {
  const p = parsePayload(row);
  const pick = new Picker(p);
  pick.put("pollster", "pollster", (v) => text(v, 160));
  if (!pick.payload.pollster) throw new MappingError("poll row without a pollster");
  pick.put("commissioner", "commissioner", (v) => text(v, 160));
  pick.put("sponsor", "funder_sponsor", (v) => text(v, 160));
  pick.put("disclosure_sponsor", "disclosure_sponsor", (v) => text(v, 160));
  pick.put("disclosure_provider", "disclosure_provider", (v) => text(v, 160));
  pick.put("fieldwork_start", "fieldwork_start", isoDate);
  pick.put("fieldwork_end", "fieldwork_end", isoDate);
  pick.put("sample_size", "sample_size", (v) => { const n = wholeNumber(v); return n && n > 0 ? n : undefined; });
  pick.put("disclosure_sample_size", "disclosure_sample_size", (v) => { const n = wholeNumber(v); return n && n > 0 ? n : undefined; });
  pick.put("disclosure_margin_of_error", "disclosure_margin_of_error", (v) => text(typeof v === "number" ? String(v) : v, 40));
  pick.put("disclosure_mode", "disclosure_mode", (v) => text(v, 120));
  pick.put("document_title", "document_title", (v) => text(v, 300));
  pick.put("capture_status", "capture_status", (v) => text(v, 60));
  pick.put("index_url", "index_url", httpsUrl);
  pick.put("disclosure_url", "disclosure_url", httpsUrl);
  pick.put("disclosure_source_url", "disclosure_source_url", httpsUrl);
  pick.put("verification_status", "verification_status", (v) => text(v, 80));
  pick.put("metadata_complete_public_poll", "metadata_complete_public_poll", (v) => (typeof v === "boolean" ? v : undefined));
  pick.put("metadata_completeness_reason", "metadata_completeness_reason", (v) => text(v, 200));
  pick.use("public_verification_checks", "missing_values_mean", "publication_date", "party_vote_percent");
  pick.set("methodology_status", p.metadata_complete_public_poll === true ? "verified" : "unresolved");

  // Source order is kept. A blank cell is "not reported"; it is never read as zero.
  const cells = p.party_vote_percent;
  if (typeof cells !== "object" || cells === null || Array.isArray(cells)) throw new MappingError("poll row without a party table");
  const results: SafeJson[] = [];
  for (const [label, cell] of Object.entries(cells as Obj)) {
    const party = text(label, 80);
    if (!party) throw new MappingError("poll table has an empty party label");
    const value = decimal(cell);
    if (cell !== null && cell !== "" && value === undefined) throw new MappingError("poll cell is neither a number nor blank");
    if (value !== undefined && (value < 0 || value > 100)) throw new MappingError("poll value outside 0-100");
    if (results.some((r) => (r as { party_label: string }).party_label === party)) throw new MappingError("poll table repeats a party label");
    results.push(value === undefined ? { party_label: party, value_status: "not_reported" } : { party_label: party, value_pct: value, value_status: "reported" });
  }
  if (results.length === 0) throw new MappingError("poll row with an empty party table");
  pick.set("results", results);
  const published = isoDate(p.publication_date);
  // The poll's own publisher page is the official link when one was found; the aggregator index is kept beside it.
  const out = base("P14", row, "party_vote_poll", pick, { official_url: httpsUrl(p.disclosure_url) ?? httpsUrl(p.disclosure_source_url), source_published_at: published ? published + "T00:00:00.000Z" : undefined, source_date_text: published });
  out.omitted.push({ field: "public_verification_checks", reason: REASONS.transport }, { field: "missing_values_mean", reason: "upstream note; the rule it states is applied (blank is not reported)" });
  out.omitted.sort((a, b) => a.field.localeCompare(b.field));
  return out;
}

// P15 / P16 / P17 -------------------------------------------------------------------------------------

export type PublishedAmount = { status: "reported"; nzd: number; nil: boolean } | { status: "not_reported" };

/** "$42,099.86" is a reported amount; "NIL" is a reported nil; anything else is not reported. Never guessed. */
export function publishedAmount(value: unknown): PublishedAmount {
  if (typeof value !== "string") return { status: "not_reported" };
  const clean = value.trim();
  if (/^nil$/i.test(clean)) return { status: "reported", nzd: 0, nil: true };
  const match = /^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(\.\d{1,2})?$/.exec(clean);
  if (!match) return { status: "not_reported" };
  return { status: "reported", nzd: Number(match[1].replace(/,/g, "") + (match[2] ?? "")), nil: false };
}

function putAmount(pick: Picker, to: string, from: string, source: Obj): void {
  pick.use(from);
  const amount = publishedAmount(source[from]);
  pick.set(to + "_status", amount.status === "reported" ? (amount.nil ? "reported_nil" : "reported") : "not_reported");
  if (amount.status === "reported") pick.set(to + "_nzd", amount.nzd);
}

const TEXT_LAYER: { [status: string]: boolean } = {
  text_layer_retained: false, no_usable_text_layer: true, vision_derived_key_fields_full_page_review: true,
};

function documentFields(pick: Picker, p: Obj): void {
  pick.put("reporting_year", "reporting_year", wholeNumber);
  pick.put("return_kind", "return_kind", (v) => text(v, 120));
  pick.put("party_name_as_published", "party_name_as_published", (v) => text(v, 200));
  pick.put("amendment_labelled", "amendment_labelled", (v) => (typeof v === "boolean" ? v : undefined));
  pick.put("capture_status", "capture_status", (v) => text(v, 80));
  pick.put("identity_status", "identity_status", (v) => text(v, 80));
  pick.put("normalization_status", "normalization_status", (v) => text(v, 120));
  pick.put("text_layer_status", "text_extraction_status", (v) => text(v, 80));
  const status = typeof p.text_extraction_status === "string" ? p.text_extraction_status : "";
  if (!Object.hasOwn(TEXT_LAYER, status)) throw new MappingError("text_extraction_status outside the documented vocabulary");
  pick.set("is_image_only", TEXT_LAYER[status]);
  pick.put("catalogue_page_url", "catalogue_source_url", httpsUrl);
  pick.put("catalogue_page_sha256", "catalogue_source_sha256", sha256);
  pick.put("page_count", "page_count_from_text_breaks", wholeNumber);
  pick.use("document_id", "catalogue_id", "raw_pdf_sha256");
}

export function mapCandidateReturn(row: WarehouseRow): ExportRow {
  const p = parsePayload(row);
  const pick = new Picker(p);
  if (p.reporting_year !== 2023) throw new MappingError("candidate return is not for 2023");
  documentFields(pick, p);
  pick.put("candidate_name_as_published", "candidate_name_as_published", (v) => text(v, 200));
  pick.use("candidate_first_name_as_published", "candidate_last_name_as_published");
  pick.put("electorate_as_published", "electorate_as_published", (v) => text(v, 120));
  if (!pick.payload.candidate_name_as_published || !pick.payload.electorate_as_published) throw new MappingError("candidate return without the published name and electorate");
  // Totals exactly as the Commission's index page prints them. Nothing is read from inside a return.
  putAmount(pick, "expenses_as_published", "expenses_as_published", p);
  putAmount(pick, "donations_as_published", "donations_as_published", p);
  putAmount(pick, "loans_as_published", "loans_as_published", p);
  pick.set("amounts_basis", "commission_index_page_as_published");
  const out = base("P15", row, "finance_candidate_return", pick, { original_sha256: sha256(p.raw_pdf_sha256) });
  out.omitted.push({ field: "candidate_first_name_as_published", reason: "restates candidate_name_as_published" }, { field: "candidate_last_name_as_published", reason: "restates candidate_name_as_published" });
  out.omitted.sort((a, b) => a.field.localeCompare(b.field));
  return out;
}

const AGGREGATE_METRICS = new Set(["total_party_donations", "total_party_loans"]);

export function mapPartyAggregate(row: WarehouseRow): ExportRow {
  const p = parsePayload(row);
  const pick = new Picker(p);
  if (p.reporting_year !== 2025) throw new MappingError("party aggregate is not for 2025");
  pick.put("reporting_year", "reporting_year", wholeNumber);
  pick.put("party_name_as_published", "party_name_as_published", (v) => text(v, 200));
  pick.put("capture_mode", "capture_mode", (v) => text(v, 40));
  pick.use("facts", "source_sha256");
  if (!Array.isArray(p.facts) || p.facts.length === 0) throw new MappingError("aggregate row without facts");
  const aggregates: SafeJson[] = [];
  const returnUrls = new Set<string>();
  let period: { start?: string; end?: string } = {};
  for (const item of p.facts as Obj[]) {
    const metric = typeof item.metric === "string" ? item.metric : "";
    if (!AGGREGATE_METRICS.has(metric)) throw new MappingError("aggregate metric outside the documented vocabulary");
    if (item.basis !== "commission_published_summary_not_recomputed_from_donors") throw new MappingError("aggregate is not the Commission's own published summary");
    const entry: { [key: string]: SafeJson } = { metric: metric === "total_party_donations" ? "party_donations_sum" : "party_loans_sum" };
    const amount = decimal(item.amount_nzd);
    if (item.value_status === "reported") {
      if (amount === undefined || amount < 0) throw new MappingError("aggregate is marked reported but its amount cannot be read");
      const nil = /^\s*nil\s*$/i.test(String(item.evidence_text ?? ""));
      if (nil && amount !== 0) throw new MappingError("aggregate prints NIL beside a non-zero amount");
      entry.value_status = nil ? "reported_nil" : "reported";
      entry.amount_nzd = amount;
    } else {
      entry.value_status = "not_reported";
    }
    if (aggregates.some((a) => (a as { metric: string }).metric === entry.metric)) throw new MappingError("aggregate row repeats a metric");
    const filed = Array.isArray(item.filing_dates) ? item.filing_dates.map(isoDate).filter((d): d is string => Boolean(d)) : [];
    entry.filing_dates = filed;
    entry.filing_date_mapping = text(item.filing_date_document_mapping, 40) ?? "unresolved";
    const audit = text(item.audit_report_raw, 80);
    if (audit) entry.audit_report_as_published = audit;
    aggregates.push(entry);
    for (const url of Array.isArray(item.return_urls) ? item.return_urls : []) {
      const clean = httpsUrl(url);
      if (clean) returnUrls.add(clean);
    }
    period = { start: isoDate(item.period_start) ?? period.start, end: isoDate(item.period_end) ?? period.end };
  }
  pick.set("aggregates", aggregates);
  pick.set("return_urls", [...returnUrls].sort());
  pick.set("period_start", period.start);
  pick.set("period_end", period.end);
  pick.set("amounts_basis", "commission_published_summary_not_recomputed");
  return base("P16", row, "finance_party_aggregate", pick, { original_sha256: sha256(p.source_sha256) });
}

export function mapPartyReturn(row: WarehouseRow): ExportRow {
  const p = parsePayload(row);
  const pick = new Picker(p);
  if (p.reporting_year !== 2025) throw new MappingError("party return is not for 2025");
  documentFields(pick, p);
  pick.put("document_version_type", "document_version_type", (v) => text(v, 80));
  pick.put("page_count_from_document", "page_count_from_pdf", wholeNumber);
  pick.put("pages_visually_reviewed", "pages_visually_reviewed", (v) => (Array.isArray(v) ? v.length : wholeNumber(v)));
  pick.put("transcription_scope", "transcription_scope", (v) => text(v, 120));
  pick.use("party_entity_id", "derived_from_record_content_hash", "original_raw_pdf_sha256",
    "original_embedded_text_extraction_status", "ocr_or_vision_generated_at", "pages_with_key_fields_transcribed", "transcription_confidence");
  const out = base("P17", row, "finance_party_return", pick, { original_sha256: sha256(p.raw_pdf_sha256) ?? sha256(p.original_raw_pdf_sha256) });
  out.omitted.push(
    { field: "pages_with_key_fields_transcribed", reason: REASONS.ocr },
    { field: "transcription_confidence", reason: "upstream self-assessment of an unreviewed transcription" },
    { field: "party_entity_id", reason: "upstream label-derived identifier; the published party name is kept instead" },
  );
  out.omitted.sort((a, b) => a.field.localeCompare(b.field));
  return out;
}

export const MAPPERS: { [sourceId: string]: { product: ProductId; map: (row: WarehouseRow) => ExportRow } } = {
  nz_electoral_commission_2023_overall_results: { product: "P08", map: mapOverallResult },
  nz_electoral_commission_2023_electorate_results: { product: "P09", map: mapElectorateResult },
  nz_registered_party_policy_pages_2026: { product: "P13", map: mapPolicyPage },
  nz_party_vote_polls_90d_20260919: { product: "P14", map: mapPoll },
  political_finance_2023_candidate_returns: { product: "P15", map: mapCandidateReturn },
  political_finance_2025_aggregates: { product: "P16", map: mapPartyAggregate },
  political_finance_2025_returns: { product: "P17", map: mapPartyReturn },
};
