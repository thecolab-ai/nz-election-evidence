// Parliament family: the ONE place a record's allowlisted projection is built.
//
// Two routes reach the same publisher item: a fresh anonymous fetch (live/*.ts) and a reviewed export of an earlier
// collection (contracts.ts). Both hand their values to the builders below, so the same publisher content always gives
// the same safe_payload and therefore the same content hash, whichever route saw it.
//
// Rules every builder keeps:
//   - a value the source did not give is OMITTED. It is never null, never "", never 0 (unknown is not zero);
//   - question, reply, report, bill and release TEXT never enters a payload. A SHA-256 and a character count of the
//     text may, so a later change of the text is visible without the text being held;
//   - no contact detail, no file name, no storage location;
//   - the publisher's own date is kept apart from the time this project retrieved the item.
// Erasable TypeScript only: runs unchanged in Node 24 and in Deno.

import { contentHash } from "../../../../supabase/functions/_shared/canonical.ts";
import type { IngestRecord, Json, OmittedField } from "../../../../supabase/functions/_shared/types.ts";

export const PARLIAMENT_PROJECTION_VERSION = 1;

export type Payload = { [key: string]: Json };

const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const QUESTION_PUBLIC_BASE = "https://questions.parliament.nz/written-questions/detail/";
export const COMMITTEE_PUBLIC_BASE = "https://selectcommittees.parliament.nz/v/13/";
export const COMMITTEE_DOWNLOAD_BASE = "https://selectcommittees.parliament.nz/download/SelectCommitteeReport/";
export const BILL_PUBLIC_BASE = "https://bills.parliament.nz/v/6/";

/** Collects a payload and the record of what was left out or altered on the way. */
export class PayloadDraft {
  payload: Payload = {};
  omitted: OmittedField[] = [];

  /** Publisher free text (a title, a label). A contact-like substring is masked and the masking is recorded. */
  text(key: string, value: unknown, max = 600): this {
    if (typeof value !== "string") return this;
    let cleaned = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return this;
    if (EMAIL_LIKE.test(cleaned)) {
      cleaned = cleaned.replace(EMAIL_LIKE, "[redacted]");
      this.omitted.push({ field: key, reason: "a contact-like value inside the publisher text was masked; contact details are never stored" });
    }
    EMAIL_LIKE.lastIndex = 0;
    this.payload[key] = cleaned.slice(0, max);
    return this;
  }

  /** An opaque publisher identifier: kept only when it is a plain token. */
  ref(key: string, value: unknown, max = 120): this {
    if (typeof value !== "string" && typeof value !== "number") return this;
    const token = String(value).trim();
    if (token && token.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(token) && !token.includes("://")) this.payload[key] = token;
    return this;
  }

  integer(key: string, value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): this {
    if (value === null || value === undefined || value === "") return this;
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isSafeInteger(n) && n >= min && n <= max) this.payload[key] = n;
    return this;
  }

  bool(key: string, value: unknown): this {
    if (typeof value === "boolean") this.payload[key] = value;
    return this;
  }

  /** A publisher timestamp, kept exactly as an ISO instant. Anything unparseable is left out, never guessed. */
  instant(key: string, value: unknown): this {
    const iso = isoInstant(value);
    if (iso) this.payload[key] = iso;
    return this;
  }

  /** A publisher calendar date. Only the date the publisher wrote: no time-zone shifting. */
  day(key: string, value: unknown): this {
    const day = isoDay(value);
    if (day) this.payload[key] = day;
    return this;
  }

  url(key: string, value: unknown, hosts: readonly string[]): this {
    const url = officialUrl(value, hosts);
    if (url) this.payload[key] = url;
    return this;
  }

  digest(key: string, value: unknown): this {
    if (typeof value === "string" && SHA256_HEX.test(value.toLowerCase().replace(/^sha256:/, ""))) this.payload[key] = value.toLowerCase().replace(/^sha256:/, "");
    return this;
  }

  constant(key: string, value: Json): this {
    this.payload[key] = value;
    return this;
  }

  leftOut(field: string, reason: string): this {
    this.omitted.push({ field, reason });
    return this;
  }
}

export function isoInstant(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value.trim())) return undefined;
  const text = value.trim().replace(" ", "T");
  const time = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : text + "Z");
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

export function isoDay(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/);
  if (!match) return undefined;
  const probe = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return probe.getUTCFullYear() === Number(match[1]) && probe.getUTCMonth() === Number(match[2]) - 1 && probe.getUTCDate() === Number(match[3])
    ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

/** A plain https link on one of the publisher's own hosts, with no userinfo and no secret-bearing parameter. */
export function officialUrl(value: unknown, hosts: readonly string[]): string | undefined {
  if (typeof value !== "string" || value.length > 1500) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || !hosts.includes(url.hostname.toLowerCase())) return undefined;
  if (/[?&#](key|api_?key|token|access_token|auth|signature|sig|secret|password|pwd|session|sid|jwt)=/i.test(url.search + url.hash)) return undefined;
  return url.toString();
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Characters as Unicode code points, the unit the upstream store counts in. */
export function codePoints(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export async function textDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The source's reading of a text the project does not keep: present or not, its digest and its length. */
export interface TextWitness {
  sha256?: string;
  chars?: number;
}

export async function witnessText(value: unknown): Promise<TextWitness> {
  if (typeof value !== "string" || value.trim() === "") return {};
  return { sha256: await textDigest(value), chars: codePoints(value) };
}

export interface BuiltRecord {
  external_record_id: string;
  record_kind: string;
  source_url: string;
  source_published_at?: string;
  source_date_text?: string;
  safe_payload: Payload;
  omitted_fields: OmittedField[];
}

export async function toIngestRecord(built: BuiltRecord, retrievedAt: string, originalContentHash?: string): Promise<IngestRecord> {
  return {
    external_record_id: built.external_record_id,
    record_kind: built.record_kind,
    content_hash: await contentHash(built.record_kind, PARLIAMENT_PROJECTION_VERSION, built.safe_payload),
    original_content_hash: originalContentHash,
    source_url: built.source_url,
    source_published_at: built.source_published_at,
    source_date_text: built.source_date_text,
    retrieved_at: retrievedAt,
    projection_version: PARLIAMENT_PROJECTION_VERSION,
    safe_payload: built.safe_payload,
    omitted_fields: built.omitted_fields,
  };
}

/** The ledger accepts only a narrow alphabet for the publisher's date text; anything else is left out. */
export function dateText(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9 ,:+./()-]{1,80}$/.test(value.trim()) ? value.trim() : undefined;
}

export class UnusableRecord extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableRecord";
  }
}

// P24 written questions ---------------------------------------------------------------------------------

export interface WrittenQuestionFields {
  id: unknown;
  title?: unknown;
  questionNumber?: unknown;
  questionYear?: unknown;
  parliamentNumber?: unknown;
  documentRef?: unknown;
  questionReleasedDate?: unknown;
  lastModified?: unknown;
  memberId?: unknown;
  ministerName?: unknown;
  ministerialDisplayName?: unknown;
  portfolioRef?: unknown;
  roleRef?: unknown;
  statusId?: unknown;
  attachmentId?: unknown;
  attachmentSize?: unknown;
  question: TextWitness;
  reply: TextWitness;
}

const QUESTION_TITLE = /^\d+ \(\d{4}\)\. (.+?) to the (.+)$/;

export function buildWrittenQuestion(f: WrittenQuestionFields): BuiltRecord {
  if (!isUuid(f.id)) throw new UnusableRecord("written question lacks a publisher id");
  const id = f.id.toLowerCase();
  const page = QUESTION_PUBLIC_BASE + id;
  const d = new PayloadDraft();
  d.text("title", f.title)
    .integer("question_number", f.questionNumber, 1)
    .integer("question_year", f.questionYear, 1990, 2100)
    .integer("parliament_number", f.parliamentNumber, 1, 200)
    .ref("document_ref", f.documentRef)
    .day("question_released_on", f.questionReleasedDate)
    .instant("source_last_modified_at", f.lastModified)
    .ref("asker_member_ref", f.memberId);
  // The asker's name is taken only from the publisher's own title pattern. No other inference is made.
  const title = d.payload.title;
  const match = typeof title === "string" ? title.match(QUESTION_TITLE) : null;
  if (match) d.text("asker_name_at_source", match[1], 200);
  d.text("minister_name", f.ministerName, 200)
    .text("ministerial_title", f.ministerialDisplayName, 300)
    .ref("portfolio_ref", f.portfolioRef)
    .ref("role_ref", f.roleRef)
    .integer("status_ref", f.statusId, 0, 1000)
    .constant("reply_present", f.reply.sha256 !== undefined)
    .digest("question_text_sha256", f.question.sha256)
    .integer("question_text_chars", f.question.chars, 1)
    .digest("reply_text_sha256", f.reply.sha256)
    .integer("reply_text_chars", f.reply.chars, 1)
    .constant("attachment_present", isUuid(f.attachmentId))
    .ref("attachment_ref", isUuid(f.attachmentId) ? f.attachmentId.toLowerCase() : undefined)
    .integer("attachment_bytes", f.attachmentSize, 1)
    .constant("public_page_url", page)
    .constant("metadata_only", true);
  d.leftOut("questionText", "question and reply text are not stored; link, identifiers, people and official metadata only (R6)")
    .leftOut("replyText", "question and reply text are not stored; link, identifiers, people and official metadata only (R6)")
    .leftOut("attachmentName", "file name not stored");
  return {
    external_record_id: id, record_kind: "written_question", source_url: page,
    source_published_at: isoInstant(f.questionReleasedDate), source_date_text: dateText(f.questionReleasedDate),
    safe_payload: d.payload, omitted_fields: d.omitted,
  };
}

// P07 committee report index ------------------------------------------------------------------------------

export interface CommitteeReportFields {
  id: unknown;
  title?: unknown;
  subtitle?: unknown;
  itemType?: unknown;
  documentType?: unknown;
  selectCommittee?: unknown;
  parliamentNumber?: unknown;
  publicationDate?: unknown;
  lastModified?: unknown;
  attachmentId?: unknown;
  status?: unknown;
}

export function buildCommitteeReport(f: CommitteeReportFields): BuiltRecord {
  if (!isUuid(f.id)) throw new UnusableRecord("committee report lacks a publisher id");
  const id = f.id.toLowerCase();
  const page = COMMITTEE_PUBLIC_BASE + id;
  const d = new PayloadDraft();
  d.text("title", f.title).text("subtitle", f.subtitle, 300).text("report_type", f.itemType, 120).text("document_type", f.documentType, 80)
    .text("select_committee", f.selectCommittee, 200).integer("parliament_number", f.parliamentNumber, 1, 200)
    .instant("publication_date", f.publicationDate).instant("source_last_modified_at", f.lastModified)
    .ref("attachment_ref", isUuid(f.attachmentId) ? f.attachmentId.toLowerCase() : undefined)
    .text("status_label", f.status, 120).constant("public_page_url", page).constant("metadata_only", true);
  d.leftOut("report_text_and_attachments", "metadata and link only (R6)").leftOut("attachmentName", "file name not stored");
  return {
    external_record_id: id, record_kind: "committee_report", source_url: page,
    source_published_at: isoInstant(f.publicationDate), source_date_text: dateText(f.publicationDate),
    safe_payload: d.payload, omitted_fields: d.omitted,
  };
}

// P06 committee report files: what the publisher's attachment IS, never what it says -----------------------------

export interface CommitteeReportFileFields {
  attachmentId: unknown;
  parentReportId?: unknown;
  title?: unknown;
  selectCommittee?: unknown;
  publicationDate?: unknown;
  downloadUrl?: unknown;
  mediaType?: unknown;
  fileSha256?: unknown;
  fileBytes?: unknown;
  textExtraction?: unknown;
  text: TextWitness;
}

const EXTRACTION_STATES = ["extracted", "image_only", "failed", "not_attempted", "empty"];

export function buildCommitteeReportFile(f: CommitteeReportFileFields): BuiltRecord {
  if (!isUuid(f.attachmentId)) throw new UnusableRecord("committee report file lacks a publisher attachment id");
  const id = f.attachmentId.toLowerCase();
  const download = COMMITTEE_DOWNLOAD_BASE + id;
  const d = new PayloadDraft();
  d.constant("attachment_ref", id)
    .ref("parent_report_ref", isUuid(f.parentReportId) ? f.parentReportId.toLowerCase() : undefined)
    .text("title", f.title).text("select_committee", f.selectCommittee, 200).instant("publication_date", f.publicationDate)
    .text("media_type", f.mediaType, 100).digest("file_sha256", f.fileSha256).integer("file_bytes", f.fileBytes, 1);
  if (typeof f.textExtraction === "string" && EXTRACTION_STATES.includes(f.textExtraction)) d.constant("text_extraction_status", f.textExtraction);
  d.digest("extracted_text_sha256", f.text.sha256).integer("extracted_text_chars", f.text.chars, 1)
    .constant("official_download_url", download).constant("public_page_url", download).constant("metadata_only", true);
  if (officialUrl(f.downloadUrl, ["selectcommittees.parliament.nz"]) !== download) {
    d.leftOut("final_url", "the collected download link was not the publisher's attachment link; the link is rebuilt from the publisher attachment id");
  }
  d.leftOut("extracted_text", "report text is not stored; a digest and a length only (R6)")
    .leftOut("content_disposition", "file name not stored").leftOut("stored_copy_location", "never published");
  return {
    external_record_id: id, record_kind: "committee_report_file", source_url: download,
    source_published_at: isoInstant(f.publicationDate), source_date_text: dateText(f.publicationDate),
    safe_payload: d.payload, omitted_fields: d.omitted,
  };
}

// P05 committee business -------------------------------------------------------------------------------------

export interface CommitteeBusinessFields {
  id: unknown;
  title?: unknown;
  subtitle?: unknown;
  documentType?: unknown;
  itemType?: unknown;
  selectCommittee?: unknown;
  parliamentNumber?: unknown;
  publicationDate?: unknown;
  lastModified?: unknown;
  attachmentId?: unknown;
  publicPageUrl?: unknown;
}

export function buildCommitteeBusinessItem(f: CommitteeBusinessFields): BuiltRecord {
  if (!isUuid(f.id)) throw new UnusableRecord("committee business item lacks a publisher id");
  const id = f.id.toLowerCase();
  // The publisher's page path differs by item type; a link the source route recorded wins over the default pattern.
  const page = officialUrl(f.publicPageUrl, ["selectcommittees.parliament.nz"]) ?? COMMITTEE_PUBLIC_BASE + id;
  const d = new PayloadDraft();
  d.text("title", f.title).text("subtitle", f.subtitle, 300).text("document_type", f.documentType, 120).text("item_type", f.itemType, 120)
    .text("select_committee", f.selectCommittee, 200).integer("parliament_number", f.parliamentNumber, 1, 200)
    .instant("publication_date", f.publicationDate).instant("source_last_modified_at", f.lastModified)
    .ref("attachment_ref", isUuid(f.attachmentId) ? f.attachmentId.toLowerCase() : undefined)
    .constant("public_page_url", page).constant("metadata_only", true);
  d.leftOut("item_text_and_attachments", "metadata and link only (R6)");
  return {
    external_record_id: id, record_kind: "committee_business_item", source_url: page,
    source_published_at: isoInstant(f.publicationDate), source_date_text: dateText(f.publicationDate),
    safe_payload: d.payload, omitted_fields: d.omitted,
  };
}

// P02 bill publications --------------------------------------------------------------------------------------

const LEGISLATION_HOSTS = ["www.legislation.govt.nz", "legislation.govt.nz"];

export interface BillPublicationFields {
  revisionId: unknown;
  billId?: unknown;
  billNumber?: unknown;
  billTitle?: unknown;
  parliamentNumber?: unknown;
  versionToken?: unknown;
  pdfUrl?: unknown;
  versionIndexUrl?: unknown;
  pdfSha256?: unknown;
  pdfBytes?: unknown;
  text: TextWitness;
}

export function publicationRecordId(revisionId: string): string {
  return revisionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 200);
}

export function buildBillPublication(f: BillPublicationFields): BuiltRecord {
  if (typeof f.revisionId !== "string" || !/^bill\/[a-z]+\/\d{4}\/\d+\/[a-z]{2}\/[0-9A-Za-z._-]+$/.test(f.revisionId)) {
    throw new UnusableRecord("bill publication lacks a publisher revision id");
  }
  const pdf = officialUrl(f.pdfUrl, LEGISLATION_HOSTS);
  if (!pdf) throw new UnusableRecord("bill publication lacks an official link");
  const d = new PayloadDraft();
  d.ref("bill_ref", isUuid(f.billId) ? f.billId.toLowerCase() : undefined).text("bill_number", f.billNumber, 40).text("bill_title", f.billTitle)
    .integer("parliament_number", f.parliamentNumber, 1, 200).constant("revision_ref", f.revisionId).day("version_date", f.versionToken)
    .constant("official_pdf_url", pdf).url("version_index_url", f.versionIndexUrl, LEGISLATION_HOSTS)
    .digest("file_sha256", f.pdfSha256).integer("file_bytes", f.pdfBytes, 1)
    .digest("extracted_text_sha256", f.text.sha256).integer("extracted_text_chars", f.text.chars, 1)
    .constant("public_page_url", pdf).constant("metadata_only", true);
  d.leftOut("bill_text_and_attachments", "metadata and link only (R6); proposed bill text is not enacted law")
    .leftOut("stored_copy_location", "never published");
  const day = isoDay(f.versionToken);
  return {
    external_record_id: publicationRecordId(f.revisionId), record_kind: "bill_publication", source_url: pdf,
    // The version token is the publisher's own date for the revision.
    source_published_at: day ? day + "T00:00:00.000Z" : undefined, source_date_text: day,
    safe_payload: d.payload, omitted_fields: d.omitted,
  };
}

export interface BillPublicationSetFields {
  billId: unknown;
  billNumber?: unknown;
  title?: unknown;
  currentStage?: unknown;
  status?: unknown;
  parliamentNumber?: unknown;
  legislationUrl?: unknown;
  /** Number of revisions the publisher's index listed. Undefined when the index was not read: unknown, not zero. */
  revisionCount?: unknown;
  indexUnavailable?: boolean;
}

export function buildBillPublicationSet(f: BillPublicationSetFields): BuiltRecord {
  if (!isUuid(f.billId)) throw new UnusableRecord("bill publication set lacks a publisher bill id");
  const id = f.billId.toLowerCase();
  const legislation = officialUrl(f.legislationUrl, LEGISLATION_HOSTS);
  const page = legislation ?? BILL_PUBLIC_BASE + id;
  const d = new PayloadDraft();
  d.constant("bill_ref", id).text("bill_number", f.billNumber, 40).text("title", f.title).text("current_stage", f.currentStage, 120)
    .text("status_label", f.status, 120).integer("parliament_number", f.parliamentNumber, 1, 200);
  if (legislation) d.constant("legislation_url", legislation);
  if (f.indexUnavailable) d.constant("publication_index_status", "unavailable");
  else d.integer("publication_revision_count", f.revisionCount, 0, 10000);
  d.constant("public_page_url", page).constant("metadata_only", true);
  d.leftOut("bill_text_and_attachments", "metadata and link only (R6)").leftOut("stored_copy_location", "never published");
  return { external_record_id: id, record_kind: "bill_publication_set", source_url: page, safe_payload: d.payload, omitted_fields: d.omitted };
}

// P03 bills (same keys as the existing current-bills adapter, so one bill content gives one hash on either route) --

export interface BillFields {
  id: unknown;
  title?: unknown;
  billNumber?: unknown;
  billType?: unknown;
  currentStage?: unknown;
  selectCommittee?: unknown;
  parliamentNumber?: unknown;
  lastActivity?: unknown;
  memberName?: unknown;
  partyLabel?: unknown;
}

/** Mirrors supabase/functions/_shared/adapters/bills.ts exactly, including its nulls, so hashes agree across routes. */
export function buildBill(f: BillFields): BuiltRecord {
  if (!isUuid(f.id)) throw new UnusableRecord("bill lacks a publisher id");
  const id = f.id.toLowerCase();
  const text = (value: unknown, max = 500): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  const title = text(f.title, 600);
  if (!title) throw new UnusableRecord("bill lacks a title");
  const lastActivity = text(f.lastActivity, 40);
  const parliament = Number(f.parliamentNumber);
  const payload: Payload = {
    title, bill_number: text(f.billNumber, 40), bill_type: text(f.billType, 80), current_stage: text(f.currentStage, 120),
    select_committee: text(f.selectCommittee, 200), parliament_number: Number.isInteger(parliament) && parliament > 0 ? parliament : null,
    last_activity_at: lastActivity, member_name: text(f.memberName, 200), party_label: text(f.partyLabel, 200),
    public_page_url: BILL_PUBLIC_BASE + id, metadata_only: true,
  };
  return {
    external_record_id: id, record_kind: "bill", source_url: BILL_PUBLIC_BASE + id,
    source_published_at: lastActivity ? isoInstant(lastActivity) : undefined, source_date_text: dateText(lastActivity),
    safe_payload: payload, omitted_fields: [{ field: "bill_text_and_attachments", reason: "metadata and link only (R6)" }],
  };
}

// P03 extension: the publisher's bill register across Parliaments, with dated stages ---------------------------------

export interface BillStageFields {
  stageName?: unknown;
  stageCode?: unknown;
  stageDate?: unknown;
  outcomeName?: unknown;
}

export interface BillRegisterFields {
  id: unknown;
  title?: unknown;
  billNumber?: unknown;
  billType?: unknown;
  status?: unknown;
  currentStage?: unknown;
  parliamentNumber?: unknown;
  introducedDate?: unknown;
  lastUpdatedDate?: unknown;
  selectCommittee?: unknown;
  legislationUrl?: unknown;
  memberNames?: unknown;
  stages?: BillStageFields[];
}

export const MAX_REGISTER_STAGES = 40;

export function buildBillRegisterEntry(f: BillRegisterFields): BuiltRecord {
  if (!isUuid(f.id)) throw new UnusableRecord("bill register entry lacks a publisher id");
  const id = f.id.toLowerCase();
  const page = BILL_PUBLIC_BASE + id;
  const d = new PayloadDraft();
  d.text("title", f.title).text("bill_number", f.billNumber, 40).text("bill_type", f.billType, 80).text("status_label", f.status, 120)
    .text("current_stage", f.currentStage, 120).integer("parliament_number", f.parliamentNumber, 1, 200)
    .instant("introduced_at", f.introducedDate).instant("source_last_updated_at", f.lastUpdatedDate)
    .text("select_committee", f.selectCommittee, 200).url("legislation_url", f.legislationUrl, LEGISLATION_HOSTS);
  if (Array.isArray(f.memberNames)) {
    const names = f.memberNames.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim().slice(0, 200)).slice(0, 12);
    if (names.length) d.constant("member_names_at_source", names);
  }
  const stages: Json[] = [];
  for (const stage of (f.stages ?? []).slice(0, MAX_REGISTER_STAGES)) {
    const s = new PayloadDraft();
    s.text("stage_name", stage.stageName, 120).ref("stage_code", stage.stageCode, 40).instant("stage_date", stage.stageDate);
    // The publisher writes "Unknown" when it records no outcome. That is kept as absent, not as a value.
    if (typeof stage.outcomeName === "string" && stage.outcomeName.trim().toLowerCase() !== "unknown") s.text("outcome_label", stage.outcomeName, 120);
    if (Object.keys(s.payload).length) stages.push(s.payload);
  }
  if (f.stages) {
    d.constant("stages", stages).constant("stage_count", f.stages.length);
    if (f.stages.length > MAX_REGISTER_STAGES) d.leftOut("stages", `only the first ${MAX_REGISTER_STAGES} stages are listed; stage_count gives the publisher's number`);
  }
  d.constant("public_page_url", page).constant("metadata_only", true);
  d.leftOut("description", "publisher summary text not stored; metadata and link only (R6)")
    .leftOut("bill_text_and_attachments", "metadata and link only (R6)");
  return {
    external_record_id: id, record_kind: "bill_register_entry", source_url: page,
    source_published_at: isoInstant(f.introducedDate), source_date_text: dateText(f.introducedDate),
    safe_payload: d.payload, omitted_fields: d.omitted,
  };
}

// P01 releases ---------------------------------------------------------------------------------------------------

export interface ReleaseFields {
  url: unknown;
  title?: unknown;
  publishedAt?: unknown;
  publisherItemId?: unknown;
  pageSha256?: unknown;
  pageBytes?: unknown;
  textChars?: unknown;
  captureMode?: unknown;
}

export function releaseRecordId(url: string): string {
  const path = decodeURIComponent(new URL(url).pathname).replace(/^\/release\//, "");
  return ("release-url-" + path.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "_")).slice(0, 172);
}

export function buildRelease(f: ReleaseFields): BuiltRecord {
  const url = officialUrl(f.url, ["www.beehive.govt.nz"]);
  if (!url) throw new UnusableRecord("release lacks an official link");
  const d = new PayloadDraft();
  d.text("title", f.title).constant("public_page_url", url).ref("publisher_item_id", f.publisherItemId)
    .instant("published_at", f.publishedAt).digest("page_sha256", f.pageSha256).integer("page_bytes", f.pageBytes, 1)
    .integer("release_text_chars", f.textChars, 1);
  if (f.captureMode === "genuine_browser") d.constant("collection_method", "person_operated_browser_capture");
  d.constant("metadata_only", true);
  d.leftOut("release_text", "release text is not stored; link-only rights posture (R6)").leftOut("stored_copy_location", "never published");
  return {
    external_record_id: releaseRecordId(url), record_kind: "release", source_url: url,
    source_published_at: isoInstant(f.publishedAt), source_date_text: dateText(f.publishedAt),
    safe_payload: d.payload, omitted_fields: d.omitted,
  };
}

export interface ReleaseAttributionFields {
  url: unknown;
  title?: unknown;
  contentKind?: unknown;
  publisherItemId?: unknown;
  sourceLastModified?: unknown;
  publishedAtText?: unknown;
  ministerNames?: unknown;
  ministerUrls?: unknown;
  portfolioNames?: unknown;
  portfolioUrls?: unknown;
}

const BEEHIVE_KINDS = ["article", "speech", "feature", "publication"];

function labels(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.replace(/\s+/g, " ").trim().slice(0, 200)).slice(0, max);
}

/** Who the publisher names on an item, and under which portfolios it files it. Naming a minister is attribution by the publisher, nothing more. */
export function buildReleaseAttribution(f: ReleaseAttributionFields): BuiltRecord {
  const url = officialUrl(f.url, ["www.beehive.govt.nz"]);
  if (!url) throw new UnusableRecord("item lacks an official link");
  const d = new PayloadDraft();
  d.text("title", f.title).constant("public_page_url", url).ref("publisher_item_id", f.publisherItemId);
  if (typeof f.contentKind === "string" && BEEHIVE_KINDS.includes(f.contentKind)) d.constant("content_kind", f.contentKind);
  d.instant("source_last_modified_at", f.sourceLastModified).text("published_at_text", f.publishedAtText, 80);
  const ministers = labels(f.ministerNames, 20);
  const portfolios = labels(f.portfolioNames, 30);
  if (ministers.length) d.constant("minister_names_at_source", ministers);
  if (portfolios.length) d.constant("portfolio_names_at_source", portfolios);
  const ministerPages = labels(f.ministerUrls, 20).map((u) => officialUrl(u, ["www.beehive.govt.nz"])).filter((u): u is string => Boolean(u));
  const portfolioPages = labels(f.portfolioUrls, 30).map((u) => officialUrl(u, ["www.beehive.govt.nz"])).filter((u): u is string => Boolean(u));
  if (ministerPages.length) d.constant("minister_page_urls", ministerPages);
  if (portfolioPages.length) d.constant("portfolio_page_urls", portfolioPages);
  d.constant("metadata_only", true);
  d.leftOut("item_text", "item text is not stored; link-only rights posture (R6)").leftOut("stored_copy_location", "never published");
  return {
    external_record_id: releaseRecordId(url), record_kind: "release_attribution", source_url: url,
    source_date_text: dateText(f.publishedAtText), safe_payload: d.payload, omitted_fields: d.omitted,
  };
}

// P10 extension: members' terms and ministerial roles from official open data -------------------------------------------

/** Upstream ids are built from publisher labels, so they may carry macrons; never whitespace, quotes or a scheme. */
const UPSTREAM_ID = /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{2,200}$/u;
const OPEN_DATA_HOSTS = ["catalogue.data.govt.nz", "www.beehive.govt.nz", "www3.parliament.nz", "www.parliament.nz"];

export interface MemberTermFields {
  mandateId: unknown;
  personRef?: unknown;
  personName?: unknown;
  partyName?: unknown;
  electorateName?: unknown;
  representationType?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
  sourceUrl: unknown;
}

export function buildMemberTerm(f: MemberTermFields): BuiltRecord {
  if (typeof f.mandateId !== "string" || !UPSTREAM_ID.test(f.mandateId)) throw new UnusableRecord("member term lacks an upstream id");
  const url = officialUrl(f.sourceUrl, OPEN_DATA_HOSTS);
  if (!url) throw new UnusableRecord("member term lacks an official link");
  const d = new PayloadDraft();
  d.ref("person_ref", f.personRef).text("person_name_at_source", f.personName, 200).text("party_label", f.partyName, 200);
  const representation = f.representationType === "electorate" || f.representationType === "list" ? f.representationType : undefined;
  if (representation) d.constant("representation", representation);
  if (representation === "electorate") d.text("electorate_label", f.electorateName, 200);
  // Dates only as the official file states them. An empty cell stays absent: the start of service is then unknown here.
  d.day("valid_from", f.validFrom).day("valid_to", f.validTo);
  d.constant("date_basis", d.payload.valid_from || d.payload.valid_to ? "stated_in_official_open_data_file" : "not_stated_by_source")
    .constant("public_page_url", url).constant("metadata_only", true);
  d.leftOut("parliament_email", "contact details are never stored").leftOut("source_record_json", "upstream row copy not imported");
  return { external_record_id: f.mandateId, record_kind: "member_service_term", source_url: url, safe_payload: d.payload, omitted_fields: d.omitted };
}

export interface MinisterRoleFields {
  roleId: unknown;
  personRef?: unknown;
  personName?: unknown;
  roleType?: unknown;
  roleName?: unknown;
  portfolioName?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
  sourceUrl: unknown;
}

export function buildMinisterRole(f: MinisterRoleFields): BuiltRecord {
  if (typeof f.roleId !== "string" || !UPSTREAM_ID.test(f.roleId)) throw new UnusableRecord("role lacks an upstream id");
  const url = officialUrl(f.sourceUrl, OPEN_DATA_HOSTS);
  if (!url) throw new UnusableRecord("role lacks an official link");
  const d = new PayloadDraft();
  d.ref("person_ref", f.personRef).text("person_name_at_source", f.personName, 200).text("role_type_at_source", f.roleType, 80)
    .text("role_name", f.roleName, 200).text("portfolio_name", f.portfolioName, 200).day("valid_from", f.validFrom).day("valid_to", f.validTo);
  // A minister's profile page shows who holds a portfolio when it was read. It states no appointment date.
  d.constant("date_basis", d.payload.valid_from || d.payload.valid_to ? "stated_by_source" : "not_stated_by_source")
    .constant("public_page_url", url).constant("metadata_only", true);
  d.leftOut("source_record_json", "upstream row copy not imported");
  return { external_record_id: f.roleId, record_kind: "minister_role", source_url: url, safe_payload: d.payload, omitted_fields: d.omitted };
}
