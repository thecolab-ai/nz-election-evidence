// Parliament family: typed, allowlisted export contracts.
//
// One contract per upstream product. Each names
//   - the read-only RECIPE that produces the export (a SELECT of allowlisted expressions only, so question, reply,
//     report, bill and release text, contact details and stored-copy locations never leave the upstream store: where a
//     text matters, its SHA-256 and character count are computed upstream and only those travel);
//   - the COLUMNS the export may carry. A file with any other column is refused whole;
//   - what was WITHHELD upstream and why;
//   - the mapping of one export row onto the shared payload builders (payload.ts);
//   - the PIN: checksum, row count and distinct-record count of the one export this contract was verified against.
//
// Every export row is one upstream OBSERVATION: the same publisher item may appear several times, once per content the
// upstream collection saw. observed_at is when the upstream collection retrieved it. It is never used as a publisher date.

import {
  type BuiltRecord, buildBill, buildBillPublication, buildBillPublicationSet, buildBillRegisterEntry, buildCommitteeBusinessItem,
  buildCommitteeReport, buildCommitteeReportFile, buildMemberTerm, buildMinisterRole, buildRelease, buildReleaseAttribution,
  buildWrittenQuestion, type BillStageFields, UnusableRecord,
} from "./payload.ts";
import pins from "./pins.json" with { type: "json" };

export type ExportRow = { [column: string]: unknown };

export interface ExportColumn {
  name: string;
  type: "string" | "integer" | "boolean" | "string_array" | "tuple_array";
  note: string;
}

export interface ExportPin {
  sha256: string;
  bytes: number;
  rows: number;
  distinct_records: number;
}

export interface FamilyExportContract {
  source_id: string;
  product_ids: string[];
  title: string;
  record_kinds: string[];
  /** Variables naming the export file and its manifest. Locations never enter git. */
  fileEnv: string;
  manifestEnv: string;
  recipe: {
    /** Produces the export, one JSON object per line, in a total order (so the same upstream state gives the same bytes). */
    exportSql: string;
    /** Counted independently of the export query: what the upstream store says it holds for this product. */
    reconcileSql: string;
  };
  columns: ExportColumn[];
  withheld_upstream: { field: string; reason: string }[];
  toRecord(row: ExportRow): BuiltRecord;
  /** Null until a real export has been verified; an unpinned contract cannot be imported. */
  pin: ExportPin | null;
}

const ENVELOPE: ExportColumn[] = [
  { name: "upstream_content_hash", type: "string", note: "upstream digest of its own payload; carried as original_content_hash, not recomputed here" },
  { name: "observed_at", type: "string", note: "when the upstream collection retrieved this content (UTC). Not a publisher date" },
];

const WITHHELD_ALWAYS = [
  { field: "raw_record_json", reason: "upstream copy of the publisher response; never exported" },
  { field: "run_id", reason: "upstream operational identifier" },
  { field: "loaded_at", reason: "upstream load time; not evidence about the source" },
];

const OBSERVED = "concat(replaceOne(toString(observed_at), ' ', 'T'), 'Z') AS observed_at";
const s = (key: string, as: string) => `JSONExtract(payload_json, '${key}', 'Nullable(String)') AS ${as}`;
const n = (key: string, as: string) => `JSONExtract(payload_json, '${key}', 'Nullable(Int64)') AS ${as}`;
/** Digest and length of a text that stays upstream. Whitespace-only counts as absent, as in payload.ts. */
const witness = (key: string, as: string) =>
  `if(match(JSONExtractString(payload_json, '${key}'), '\\\\S'), lower(hex(SHA256(JSONExtractString(payload_json, '${key}')))), NULL) AS ${as}_sha256, ` +
  `if(match(JSONExtractString(payload_json, '${key}'), '\\\\S'), lengthUTF8(JSONExtractString(payload_json, '${key}')), NULL) AS ${as}_chars`;

function operational(sourceId: string, select: string[], idExpr: string, where = ""): FamilyExportContract["recipe"] {
  const filter = `source_id = '${sourceId}'${where ? " AND " + where : ""}`;
  return {
    exportSql:
      `SELECT content_hash AS upstream_content_hash, ${OBSERVED}, ${select.join(", ")} ` +
      `FROM operational_source_records FINAL WHERE ${filter} ` +
      `ORDER BY ${idExpr}, operational_source_records.observed_at, loaded_at, content_hash FORMAT JSONEachRow`,
    reconcileSql:
      `SELECT count() AS rows, uniqExact(${idExpr}) AS distinct_records, uniqExact(record_id) AS distinct_upstream_records, ` +
      `concat(replaceOne(toString(min(observed_at)), ' ', 'T'), 'Z') AS observed_min, concat(replaceOne(toString(max(observed_at)), ' ', 'T'), 'Z') AS observed_max ` +
      `FROM operational_source_records FINAL WHERE ${filter} FORMAT JSONEachRow`,
  };
}

function snapshot(table: string, select: string[], idExpr: string, from?: string, tableIdExpr = idExpr): FamilyExportContract["recipe"] {
  const source = from ?? `${table} FINAL`;
  return {
    exportSql:
      `SELECT '' AS upstream_content_hash, concat(replaceOne(toString(captured_at), ' ', 'T'), 'Z') AS observed_at, ${select.join(", ")} ` +
      `FROM ${source} ORDER BY ${idExpr}, captured_at FORMAT JSONEachRow`,
    reconcileSql:
      `SELECT count() AS rows, uniqExact(${tableIdExpr}) AS distinct_records, uniqExact(${tableIdExpr}) AS distinct_upstream_records, ` +
      `concat(replaceOne(toString(min(captured_at)), ' ', 'T'), 'Z') AS observed_min, concat(replaceOne(toString(max(captured_at)), ' ', 'T'), 'Z') AS observed_max ` +
      `FROM ${table} FINAL FORMAT JSONEachRow`,
  };
}

const str = (name: string, note: string): ExportColumn => ({ name, type: "string", note });
const int = (name: string, note: string): ExportColumn => ({ name, type: "integer", note });

// P24 ---------------------------------------------------------------------------------------------------------------

const writtenQuestions: FamilyExportContract = {
  source_id: "parliament_export_written_questions",
  product_ids: ["P24"],
  title: "Written parliamentary questions, 54th Parliament (reviewed upstream export; identifiers, people, official metadata and links)",
  record_kinds: ["written_question"],
  fileEnv: "EVIDENCE_EXPORT_PARLIAMENT_WRITTEN_QUESTIONS",
  manifestEnv: "EVIDENCE_EXPORT_PARLIAMENT_WRITTEN_QUESTIONS_MANIFEST",
  recipe: operational("nz_parliament_current_written_questions", [
    s("id", "id"), s("title", "title"), n("questionNumber", "question_number"), n("questionYear", "question_year"),
    n("parliamentNumber", "parliament_number"), s("writtenQuestionsDocumentId", "document_ref"), s("questionReleasedDate", "question_released_date"),
    s("lastModified", "last_modified"), s("memberId", "member_ref"), s("ministerName", "minister_name"),
    s("ministerialDisplayName", "ministerial_title"), s("portfolioId_PortfolioMinister", "portfolio_ref"), s("roleId", "role_ref"),
    n("statusId", "status_ref"), s("attachmentId", "attachment_ref"), n("attachmentSize", "attachment_bytes"),
    witness("questionText", "question_text"), witness("replyText", "reply_text"),
  ], "JSONExtractString(payload_json, 'id')"),
  columns: [
    ...ENVELOPE, str("id", "publisher question id"), str("title", "publisher title line"), int("question_number", ""), int("question_year", ""),
    int("parliament_number", ""), str("document_ref", "publisher document reference"), str("question_released_date", "publisher release date; not a lodgement date"),
    str("last_modified", "publisher modification time; not an answer date"), str("member_ref", "publisher id of the asking member"),
    str("minister_name", "responsible minister as the record names them"), str("ministerial_title", ""), str("portfolio_ref", ""), str("role_ref", ""),
    int("status_ref", "publisher status code; its vocabulary is not claimed"), str("attachment_ref", ""), int("attachment_bytes", ""),
    str("question_text_sha256", "digest computed upstream; the text stays upstream"), int("question_text_chars", ""),
    str("reply_text_sha256", "digest computed upstream; the text stays upstream"), int("reply_text_chars", ""),
  ],
  withheld_upstream: [
    { field: "questionText", reason: "question text is not exported; digest and length only (R6)" },
    { field: "replyText", reason: "reply text is not exported; digest and length only (R6)" },
    { field: "attachmentName", reason: "file name not exported" },
    { field: "result_set_scope", reason: "upstream paging bookkeeping; changes between collections without the question changing" },
    ...WITHHELD_ALWAYS,
  ],
  toRecord: (r) => buildWrittenQuestion({
    id: r.id, title: r.title, questionNumber: r.question_number, questionYear: r.question_year, parliamentNumber: r.parliament_number,
    documentRef: r.document_ref, questionReleasedDate: r.question_released_date, lastModified: r.last_modified, memberId: r.member_ref,
    ministerName: r.minister_name, ministerialDisplayName: r.ministerial_title, portfolioRef: r.portfolio_ref, roleRef: r.role_ref,
    statusId: r.status_ref, attachmentId: r.attachment_ref, attachmentSize: r.attachment_bytes,
    question: witnessOf(r.question_text_sha256, r.question_text_chars), reply: witnessOf(r.reply_text_sha256, r.reply_text_chars),
  }),
  pin: null, // filled from pins.json below
};

function witnessOf(sha256: unknown, chars: unknown): { sha256?: string; chars?: number } {
  return typeof sha256 === "string" && /^[0-9a-f]{64}$/.test(sha256) ? { sha256, chars: typeof chars === "number" ? chars : Number(chars) || undefined } : {};
}

// P07 ---------------------------------------------------------------------------------------------------------------

const committeeReports: FamilyExportContract = {
  source_id: "parliament_export_committee_reports",
  product_ids: ["P07"],
  title: "Select committee report index, 54th Parliament (reviewed upstream export; metadata and links)",
  record_kinds: ["committee_report"],
  fileEnv: "EVIDENCE_EXPORT_PARLIAMENT_COMMITTEE_REPORTS",
  manifestEnv: "EVIDENCE_EXPORT_PARLIAMENT_COMMITTEE_REPORTS_MANIFEST",
  recipe: operational("nz_parliament_54_select_committee_reports", [
    s("id", "id"), s("title", "title"), s("subtitle", "subtitle"), s("itemType", "item_type"), s("documentType", "document_type"),
    s("selectCommittee", "select_committee"), n("parliamentNumber", "parliament_number"), s("publicationDate", "publication_date"),
    s("lastModified", "last_modified"), s("attachmentId", "attachment_ref"), s("status", "status_label"),
  ], "JSONExtractString(payload_json, 'id')"),
  columns: [
    ...ENVELOPE, str("id", "publisher report id"), str("title", ""), str("subtitle", ""), str("item_type", ""), str("document_type", ""),
    str("select_committee", ""), int("parliament_number", ""), str("publication_date", "publisher publication date"),
    str("last_modified", "publisher modification time"), str("attachment_ref", ""), str("status_label", ""),
  ],
  withheld_upstream: [
    { field: "attachmentName", reason: "file name not exported" },
    { field: "result_set_scope", reason: "upstream paging bookkeeping" }, ...WITHHELD_ALWAYS,
  ],
  toRecord: (r) => buildCommitteeReport({
    id: r.id, title: r.title, subtitle: r.subtitle, itemType: r.item_type, documentType: r.document_type, selectCommittee: r.select_committee,
    parliamentNumber: r.parliament_number, publicationDate: r.publication_date, lastModified: r.last_modified, attachmentId: r.attachment_ref, status: r.status_label,
  }),
  pin: null, // filled from pins.json below
};

// P06 ---------------------------------------------------------------------------------------------------------------

const committeeReportFiles: FamilyExportContract = {
  source_id: "parliament_export_committee_report_files",
  product_ids: ["P06"],
  title: "Select committee report files, 54th Parliament (reviewed upstream export; file metadata and official download links, never report text)",
  record_kinds: ["committee_report_file"],
  fileEnv: "EVIDENCE_EXPORT_PARLIAMENT_COMMITTEE_REPORT_FILES",
  manifestEnv: "EVIDENCE_EXPORT_PARLIAMENT_COMMITTEE_REPORT_FILES_MANIFEST",
  recipe: operational("nz_parliament_54_select_committee_report_bodies", [
    s("attachment_id", "attachment_ref"), s("parent_report_id", "parent_report_ref"), s("title", "title"), s("select_committee", "select_committee"),
    s("publication_date", "publication_date"), s("final_url", "download_url"), s("media_type", "media_type"),
    "replaceOne(JSONExtractString(payload_json, 'pdf_sha256'), 'sha256:', '') AS file_sha256", n("pdf_bytes", "file_bytes"),
    s("text_extraction", "text_extraction"), witness("extracted_text", "extracted_text"),
  ], "JSONExtractString(payload_json, 'attachment_id')"),
  columns: [
    ...ENVELOPE, str("attachment_ref", "publisher attachment id"), str("parent_report_ref", "publisher id of the report the file belongs to"),
    str("title", ""), str("select_committee", ""), str("publication_date", ""), str("download_url", "publisher download link"),
    str("media_type", ""), str("file_sha256", "digest of the publisher's file"), int("file_bytes", ""), str("text_extraction", "upstream extraction outcome"),
    str("extracted_text_sha256", "digest computed upstream; the text stays upstream"), int("extracted_text_chars", ""),
  ],
  withheld_upstream: [
    { field: "extracted_text", reason: "report text is not exported; digest and length only (R6)" },
    { field: "content_disposition", reason: "file name not exported" },
    { field: "raw_path", reason: "stored-copy location; never exported" }, { field: "text_path", reason: "stored-copy location; never exported" },
    { field: "provenance", reason: "upstream capture bookkeeping; the file digest and the collection time are carried instead" },
    { field: "text_extraction_error", reason: "operational free text" }, ...WITHHELD_ALWAYS,
  ],
  toRecord: (r) => buildCommitteeReportFile({
    attachmentId: r.attachment_ref, parentReportId: r.parent_report_ref, title: r.title, selectCommittee: r.select_committee,
    publicationDate: r.publication_date, downloadUrl: r.download_url, mediaType: r.media_type, fileSha256: r.file_sha256, fileBytes: r.file_bytes,
    textExtraction: r.text_extraction, text: witnessOf(r.extracted_text_sha256, r.extracted_text_chars),
  }),
  pin: null, // filled from pins.json below
};

// P05 ---------------------------------------------------------------------------------------------------------------

const committeeBusiness: FamilyExportContract = {
  source_id: "parliament_export_committee_business",
  product_ids: ["P05"],
  title: "Business before select committees, 54th Parliament (reviewed upstream export; metadata and links)",
  record_kinds: ["committee_business_item"],
  fileEnv: "EVIDENCE_EXPORT_PARLIAMENT_COMMITTEE_BUSINESS",
  manifestEnv: "EVIDENCE_EXPORT_PARLIAMENT_COMMITTEE_BUSINESS_MANIFEST",
  recipe: operational("nz_parliament_54_current_committee_business", [
    s("item_id", "id"), s("title", "title"), s("subtitle", "subtitle"), s("document_type", "document_type"), s("item_type", "item_type"),
    s("select_committee", "select_committee"), n("parliament_number", "parliament_number"), s("publication_date", "publication_date"),
    s("last_modified", "last_modified"), s("attachment_id", "attachment_ref"), s("public_page_url", "public_page_url"),
  ], "JSONExtractString(payload_json, 'item_id')"),
  columns: [
    ...ENVELOPE, str("id", "publisher item id"), str("title", ""), str("subtitle", ""), str("document_type", ""), str("item_type", ""),
    str("select_committee", ""), int("parliament_number", ""), str("publication_date", ""), str("last_modified", ""), str("attachment_ref", ""),
    str("public_page_url", "publisher page link recorded by the collection"),
  ],
  withheld_upstream: [{ field: "result_set_scope", reason: "upstream paging bookkeeping" }, ...WITHHELD_ALWAYS],
  toRecord: (r) => buildCommitteeBusinessItem({
    id: r.id, title: r.title, subtitle: r.subtitle, documentType: r.document_type, itemType: r.item_type, selectCommittee: r.select_committee,
    parliamentNumber: r.parliament_number, publicationDate: r.publication_date, lastModified: r.last_modified, attachmentId: r.attachment_ref,
    publicPageUrl: r.public_page_url,
  }),
  pin: null, // filled from pins.json below
};

// P02 ---------------------------------------------------------------------------------------------------------------

const billPublications: FamilyExportContract = {
  source_id: "parliament_export_bill_publications",
  product_ids: ["P02"],
  title: "Bill publications for bills current in the 54th Parliament (reviewed upstream export; revision metadata and official links, never bill text)",
  record_kinds: ["bill_publication", "bill_publication_set"],
  fileEnv: "EVIDENCE_EXPORT_PARLIAMENT_BILL_PUBLICATIONS",
  manifestEnv: "EVIDENCE_EXPORT_PARLIAMENT_BILL_PUBLICATIONS_MANIFEST",
  recipe: operational("nz_parliament_54_current_bill_documents", [
    "toString(record_kind) AS upstream_kind", s("bill_id", "bill_ref"), s("bill_number", "bill_number"),
    "coalesce(JSONExtract(payload_json, 'bill_title', 'Nullable(String)'), JSONExtract(payload_json, 'title', 'Nullable(String)')) AS title",
    n("parliament", "parliament_number"), s("revision_id", "revision_ref"), s("version_token", "version_token"), s("pdf_url", "pdf_url"),
    s("version_index_url", "version_index_url"), "replaceOne(JSONExtractString(payload_json, 'pdf_sha256'), 'sha256:', '') AS file_sha256",
    n("pdf_bytes", "file_bytes"), witness("text_content", "extracted_text"), s("current_stage", "current_stage"), s("status", "status_label"),
    s("legislation_url", "legislation_url"), n("publication_revision_count", "publication_revision_count"),
  ], "record_id"),
  columns: [
    ...ENVELOPE, str("upstream_kind", "document = one published revision; catalogue = one bill's set of revisions"), str("bill_ref", "publisher bill id"),
    str("bill_number", ""), str("title", ""), int("parliament_number", ""), str("revision_ref", "publisher revision id"),
    str("version_token", "publisher date token of the revision"), str("pdf_url", "official link to the published revision"), str("version_index_url", ""),
    str("file_sha256", "digest of the publisher's file"), int("file_bytes", ""), str("extracted_text_sha256", "digest computed upstream; the text stays upstream"),
    int("extracted_text_chars", ""), str("current_stage", ""), str("status_label", ""), str("legislation_url", ""), int("publication_revision_count", ""),
  ],
  withheld_upstream: [
    { field: "text_content", reason: "bill text is not exported; digest and length only (R6)" },
    { field: "pdf_path", reason: "stored-copy location; never exported" }, { field: "text_path", reason: "stored-copy location; never exported" },
    { field: "html_path", reason: "stored-copy location; never exported" }, { field: "version_index_path", reason: "stored-copy location; never exported" },
    { field: "detail_archive_path", reason: "stored-copy location; never exported" },
    { field: "publication_revision_ids", reason: "each revision is its own record; the set keeps the count" }, ...WITHHELD_ALWAYS,
  ],
  toRecord: (r) => {
    if (r.upstream_kind === "document") {
      return buildBillPublication({
        revisionId: r.revision_ref, billId: r.bill_ref, billNumber: r.bill_number, billTitle: r.title, parliamentNumber: r.parliament_number,
        versionToken: r.version_token, pdfUrl: r.pdf_url, versionIndexUrl: r.version_index_url, pdfSha256: r.file_sha256, pdfBytes: r.file_bytes,
        text: witnessOf(r.extracted_text_sha256, r.extracted_text_chars),
      });
    }
    if (r.upstream_kind === "catalogue") {
      return buildBillPublicationSet({
        billId: r.bill_ref, billNumber: r.bill_number, title: r.title, currentStage: r.current_stage, status: r.status_label,
        parliamentNumber: r.parliament_number, legislationUrl: r.legislation_url, revisionCount: r.publication_revision_count,
      });
    }
    throw new UnusableRecord("bill publication row has an upstream kind this contract was not written for");
  },
  pin: null, // filled from pins.json below
};

// P03 history ---------------------------------------------------------------------------------------------------------

const currentBillsHistory: FamilyExportContract = {
  source_id: "parliament_export_current_bills_history",
  product_ids: ["P03"],
  title: "Current bills index, earlier observations 15-19 September 2026 (reviewed upstream export; metadata only)",
  record_kinds: ["bill"],
  fileEnv: "EVIDENCE_EXPORT_PARLIAMENT_CURRENT_BILLS_HISTORY",
  manifestEnv: "EVIDENCE_EXPORT_PARLIAMENT_CURRENT_BILLS_HISTORY_MANIFEST",
  recipe: operational("nz_parliament_current_bills", [
    s("bill_id", "id"), s("title", "title"), s("bill_number", "bill_number"), s("bill_type", "bill_type"), s("current_stage", "current_stage"),
    n("parliament", "parliament_number"), s("last_activity", "last_activity"), s("member", "member_name"), s("party", "party_label"),
  ], "JSONExtractString(payload_json, 'bill_id')"),
  columns: [
    ...ENVELOPE, str("id", "publisher bill id"), str("title", ""), str("bill_number", ""), str("bill_type", ""), str("current_stage", ""),
    int("parliament_number", ""), str("last_activity", "publisher date of the latest stage"), str("member_name", "member in charge as the source names them"),
    str("party_label", ""),
  ],
  withheld_upstream: [
    { field: "result_set_scope", reason: "upstream paging bookkeeping" },
    { field: "fact_type", reason: "upstream label; the two upstream kinds of the same bill are one record here" }, ...WITHHELD_ALWAYS,
  ],
  toRecord: (r) => buildBill({
    id: r.id, title: r.title, billNumber: r.bill_number, billType: r.bill_type, currentStage: r.current_stage, parliamentNumber: r.parliament_number,
    lastActivity: r.last_activity, memberName: r.member_name, partyLabel: r.party_label,
  }),
  pin: null, // filled from pins.json below
};

// P03 extension: bill register ------------------------------------------------------------------------------------------

const billRegister: FamilyExportContract = {
  source_id: "parliament_export_bill_register",
  product_ids: ["P03"],
  title: "Parliament bill register with dated stages, 43rd to 54th Parliaments (reviewed upstream export; metadata only)",
  record_kinds: ["bill_register_entry"],
  fileEnv: "EVIDENCE_EXPORT_PARLIAMENT_BILL_REGISTER",
  manifestEnv: "EVIDENCE_EXPORT_PARLIAMENT_BILL_REGISTER_MANIFEST",
  recipe: snapshot("bill_details", [
    "toString(d.bill_id) AS id", "d.title AS title", "d.bill_number AS bill_number", "d.bill_type AS bill_type", "d.status AS status_label",
    "d.current_stage AS current_stage", "d.parliament AS parliament_number", "d.introduced_date AS introduced_date",
    "d.last_updated_date AS last_updated_date", "d.select_committee AS select_committee", "d.legislation_url AS legislation_url",
    "m.member_names AS member_names", "st.stages AS stages",
  ], "d.bill_id",
  "(SELECT * FROM bill_details FINAL) AS d " +
  "LEFT JOIN (SELECT bill_id, arrayMap(x -> x.2, arraySort(x -> x.1, groupArray((member_order, display_name)))) AS member_names FROM bill_members FINAL GROUP BY bill_id) AS m ON m.bill_id = d.bill_id " +
  "LEFT JOIN (SELECT bill_id, arrayMap(x -> [x.3, x.4, x.5, x.6], arraySort(x -> (x.1, x.2, x.5), groupArray((stage_order, stage_id, stage_name, stage_code, stage_date, outcome_name)))) AS stages FROM bill_stages FINAL GROUP BY bill_id) AS st ON st.bill_id = d.bill_id", "bill_id"),
  columns: [
    ...ENVELOPE, str("id", "publisher bill id"), str("title", ""), str("bill_number", ""), str("bill_type", ""), str("status_label", ""),
    str("current_stage", ""), int("parliament_number", ""), str("introduced_date", "publisher date of introduction"),
    str("last_updated_date", "publisher modification time"), str("select_committee", ""), str("legislation_url", ""),
    { name: "member_names", type: "string_array", note: "members in charge, in publisher order, as the source names them" },
    { name: "stages", type: "tuple_array", note: "[stage name, stage code, publisher stage date, outcome label] in publisher order" },
  ],
  withheld_upstream: [
    { field: "description", reason: "publisher summary text is not exported (R6)" },
    { field: "raw_detail_json", reason: "upstream copy of the publisher response; never exported" },
    { field: "normalised_json", reason: "upstream working copy; never exported" }, { field: "source_file", reason: "stored-copy location; never exported" },
    { field: "raw_member_json", reason: "upstream copy; never exported" }, { field: "raw_stage_json", reason: "upstream copy; never exported" },
    { field: "member_id", reason: "not needed for a link-only record" },
  ],
  toRecord: (r) => buildBillRegisterEntry({
    id: r.id, title: r.title, billNumber: r.bill_number, billType: r.bill_type, status: r.status_label, currentStage: r.current_stage,
    parliamentNumber: r.parliament_number, introducedDate: r.introduced_date, lastUpdatedDate: r.last_updated_date, selectCommittee: r.select_committee,
    legislationUrl: r.legislation_url, memberNames: r.member_names,
    stages: Array.isArray(r.stages)
      ? r.stages.map((t): BillStageFields => (Array.isArray(t) ? { stageName: t[0], stageCode: t[1], stageDate: t[2], outcomeName: t[3] } : {}))
      : undefined,
  }),
  pin: null, // filled from pins.json below
};

// P01 -------------------------------------------------------------------------------------------------------------------

const releasesHistory: FamilyExportContract = {
  source_id: "parliament_export_releases_history",
  product_ids: ["P01"],
  title: "Beehive releases since 29 November 2023 (reviewed upstream export; titles, publisher dates and links, never release text)",
  record_kinds: ["release"],
  fileEnv: "EVIDENCE_EXPORT_PARLIAMENT_RELEASES_HISTORY",
  manifestEnv: "EVIDENCE_EXPORT_PARLIAMENT_RELEASES_HISTORY_MANIFEST",
  recipe: operational("nz_beehive_release_bodies", [
    "source_url AS url", s("title", "title"), s("published_at", "published_at"),
    "replaceOne(JSONExtractString(payload_json, 'source_sha256'), 'sha256:', '') AS page_sha256", n("original_bytes", "page_bytes"),
    n("body_chars", "release_text_chars"), s("capture_mode", "capture_mode"),
  ], "source_url"),
  columns: [
    ...ENVELOPE, str("url", "official release link"), str("title", ""), str("published_at", "publisher date and time of the release"),
    str("page_sha256", "digest of the publisher page as retrieved"), int("page_bytes", ""), int("release_text_chars", "length only; the text stays upstream"),
    str("capture_mode", "how the upstream collection retrieved the page"),
  ],
  withheld_upstream: [
    { field: "body_text", reason: "release text is not exported; length only (R6)" }, { field: "raw_path", reason: "stored-copy location; never exported" },
    { field: "capture_scope", reason: "upstream paging bookkeeping" }, { field: "index_page_last", reason: "upstream paging bookkeeping" },
    { field: "archive_complete", reason: "upstream bookkeeping" }, ...WITHHELD_ALWAYS,
  ],
  toRecord: (r) => buildRelease({
    url: r.url, title: r.title, publishedAt: r.published_at, pageSha256: r.page_sha256, pageBytes: r.page_bytes, textChars: r.release_text_chars,
    captureMode: r.capture_mode,
  }),
  pin: null, // filled from pins.json below
};

const releaseAttributions: FamilyExportContract = {
  source_id: "parliament_export_release_attributions",
  product_ids: ["P01"],
  title: "Beehive items with the ministers and portfolios the publisher names on them, July to September 2026 (reviewed upstream export; names and links)",
  record_kinds: ["release_attribution"],
  fileEnv: "EVIDENCE_EXPORT_PARLIAMENT_RELEASE_ATTRIBUTIONS",
  manifestEnv: "EVIDENCE_EXPORT_PARLIAMENT_RELEASE_ATTRIBUTIONS_MANIFEST",
  recipe: {
    exportSql:
      "SELECT v.content_hash AS upstream_content_hash, v.captured_at AS observed_at, v.source_url AS url, v.title AS title, toString(v.content_kind) AS content_kind, " +
      "v.source_node_id AS publisher_item_id, v.source_lastmod AS source_last_modified, v.published_at AS published_at_text, " +
      "mi.names AS minister_names, mi.urls AS minister_urls, po.names AS portfolio_names, po.urls AS portfolio_urls " +
      "FROM (SELECT * FROM beehive_document_versions FINAL) AS v " +
      "LEFT JOIN (SELECT version_id, arraySort(groupUniqArray(minister_name)) AS names, arraySort(groupUniqArray(minister_url)) AS urls FROM beehive_document_ministers FINAL GROUP BY version_id) AS mi ON mi.version_id = v.version_id " +
      "LEFT JOIN (SELECT version_id, arraySort(groupUniqArray(portfolio_name)) AS names, arraySort(groupUniqArray(portfolio_url)) AS urls FROM beehive_document_portfolios FINAL GROUP BY version_id) AS po ON po.version_id = v.version_id " +
      "ORDER BY v.source_url, v.captured_at, v.version_id FORMAT JSONEachRow",
    reconcileSql:
      "SELECT count() AS rows, uniqExact(source_url) AS distinct_records, uniqExact(document_key) AS distinct_upstream_records, " +
      "min(captured_at) AS observed_min, max(captured_at) AS observed_max FROM beehive_document_versions FINAL FORMAT JSONEachRow",
  },
  columns: [
    ...ENVELOPE, str("url", "official link"), str("title", ""), str("content_kind", "release, speech, feature or publication, as upstream classed the publisher page"),
    str("publisher_item_id", "publisher node id"), str("source_last_modified", "publisher modification time from its sitemap"),
    str("published_at_text", "publisher date as written on the page"),
    { name: "minister_names", type: "string_array", note: "ministers the publisher names on the item" },
    { name: "minister_urls", type: "string_array", note: "official minister pages" },
    { name: "portfolio_names", type: "string_array", note: "portfolios the publisher files the item under" },
    { name: "portfolio_urls", type: "string_array", note: "official portfolio pages" },
  ],
  withheld_upstream: [
    { field: "exact_text", reason: "item text is not exported (R6)" }, { field: "raw_path", reason: "stored-copy location; never exported" },
    { field: "capture_json", reason: "upstream capture bookkeeping" }, { field: "text_hash", reason: "not needed; the upstream content digest is carried" },
    { field: "etag", reason: "transport detail" }, { field: "html_bytes", reason: "transport detail" },
  ],
  toRecord: (r) => buildReleaseAttribution({
    url: r.url, title: r.title, contentKind: r.content_kind, publisherItemId: r.publisher_item_id, sourceLastModified: r.source_last_modified,
    publishedAtText: r.published_at_text, ministerNames: r.minister_names, ministerUrls: r.minister_urls, portfolioNames: r.portfolio_names,
    portfolioUrls: r.portfolio_urls,
  }),
  pin: null, // filled from pins.json below
};

// P10 extension -------------------------------------------------------------------------------------------------------------

const memberTerms: FamilyExportContract = {
  source_id: "parliament_export_member_terms",
  product_ids: ["P10"],
  title: "Members' current terms with the start dates stated in Parliament's open-data file (reviewed upstream export)",
  record_kinds: ["member_service_term"],
  fileEnv: "EVIDENCE_EXPORT_PARLIAMENT_MEMBER_TERMS",
  manifestEnv: "EVIDENCE_EXPORT_PARLIAMENT_MEMBER_TERMS_MANIFEST",
  recipe: snapshot("entity_person_mandates_snapshot", [
    "mandate_id", "person_id AS person_ref", "person_name", "party_name", "electorate_name", "toString(representation_type) AS representation_type",
    "valid_from", "valid_to", "source_url",
  ], "mandate_id"),
  columns: [
    ...ENVELOPE, str("mandate_id", "upstream id of the term row"), str("person_ref", "upstream id of the member; opaque"), str("person_name", ""),
    str("party_name", ""), str("electorate_name", ""), str("representation_type", "electorate or list"),
    str("valid_from", "start date as the official file states it; empty when the file the row came from states none"),
    str("valid_to", "end date as stated; empty for a sitting member"), str("source_url", "official open-data file the row came from"),
  ],
  withheld_upstream: [
    { field: "source_record_json", reason: "upstream copy of the file row (carries contact columns); never exported" },
    { field: "observation_at", reason: "collection time is carried as observed_at" },
  ],
  toRecord: (r) => buildMemberTerm({
    mandateId: r.mandate_id, personRef: r.person_ref, personName: r.person_name, partyName: r.party_name, electorateName: r.electorate_name,
    representationType: r.representation_type, validFrom: r.valid_from, validTo: r.valid_to, sourceUrl: r.source_url,
  }),
  pin: null, // filled from pins.json below
};

const ministerRoles: FamilyExportContract = {
  source_id: "parliament_export_minister_roles",
  product_ids: ["P10"],
  title: "Ministerial roles as listed on official minister pages when read on 12 September 2026 (reviewed upstream export; no appointment dates are stated)",
  record_kinds: ["minister_role"],
  fileEnv: "EVIDENCE_EXPORT_PARLIAMENT_MINISTER_ROLES",
  manifestEnv: "EVIDENCE_EXPORT_PARLIAMENT_MINISTER_ROLES_MANIFEST",
  recipe: snapshot("entity_person_roles_snapshot", [
    "role_id", "person_id AS person_ref", "person_name", "toString(role_type) AS role_type", "role_name", "portfolio_name", "valid_from", "valid_to", "source_url",
  ], "role_id"),
  columns: [
    ...ENVELOPE, str("role_id", "upstream id of the role row"), str("person_ref", ""), str("person_name", ""), str("role_type", ""), str("role_name", ""),
    str("portfolio_name", ""), str("valid_from", "as stated by the source; empty when it states none"), str("valid_to", ""), str("source_url", "official minister page"),
  ],
  withheld_upstream: [{ field: "source_record_json", reason: "upstream copy; never exported" }],
  toRecord: (r) => buildMinisterRole({
    roleId: r.role_id, personRef: r.person_ref, personName: r.person_name, roleType: r.role_type, roleName: r.role_name, portfolioName: r.portfolio_name,
    validFrom: r.valid_from, validTo: r.valid_to, sourceUrl: r.source_url,
  }),
  pin: null, // filled from pins.json below
};

export const PARLIAMENT_EXPORT_CONTRACTS: FamilyExportContract[] = [
  releasesHistory, releaseAttributions, billPublications, currentBillsHistory, billRegister, committeeBusiness, committeeReportFiles,
  committeeReports, memberTerms, ministerRoles, writtenQuestions,
];

// The pins live in one reviewed file so a re-export changes one place. An entry is written only from a verified export.
for (const contract of PARLIAMENT_EXPORT_CONTRACTS) contract.pin = (pins as { [sourceId: string]: ExportPin })[contract.source_id] ?? null;

export function contractFor(sourceId: string): FamilyExportContract {
  const found = PARLIAMENT_EXPORT_CONTRACTS.find((c) => c.source_id === sourceId);
  if (!found) throw new Error(`no parliament export contract for "${sourceId}". Known: ${PARLIAMENT_EXPORT_CONTRACTS.map((c) => c.source_id).join(", ")}`);
  return found;
}
