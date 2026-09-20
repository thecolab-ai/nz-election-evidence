// Shared ingestion types. Erasable TypeScript only: runs unchanged in Deno (Edge Functions)
// and in Node 24 (CLI and tests) without a build step.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ViewScope =
  | "primary_2026"
  | "baseline_2023"
  | "finance_2025"
  | "current_parliament"
  | "statistics"
  | "general";

export type SnapshotSemantics = "complete_snapshot" | "rolling_window" | "append_only_feed";

export interface FieldRule {
  /** Key in the upstream export row. */
  from: string;
  /** Key in safe_payload. */
  to: string;
  type: "string" | "integer" | "number" | "boolean" | "https_url";
  maxLength?: number;
}

export interface ExportContract {
  /** Environment variable that names the export file. The path itself never enters git. */
  fileEnv: string;
  recordKind: string;
  idField: string;
  sourceUrlField: string;
  observedAtField: string;
  originalHashField?: string;
  allowedFields: FieldRule[];
  /** Upstream fields that are always dropped, with the reason recorded in omitted_fields. */
  droppedFields: { field: string; reason: string }[];
  /** Count the exporter must report so reconciliation is explicit. */
  expectedRowsNote: string;
  /** Pins the one validated upstream product this contract was written for. Any other file fails closed. */
  expectedInput?: { sha256: string; rows: number };
  /** Variable naming the upstream manifest; its recorded checksum and count must agree with the file. */
  manifestEnv?: string;
  manifestChecksumPath?: string[];
  manifestRowsPath?: string[];
  /** Every row must carry exactly this value. */
  requiredValues?: { field: string; equals: string }[];
  /** Closed upstream vocabularies. A value outside the map fails the whole import before any write. */
  enumMaps?: EnumMap[];
  /** Numbers kept only when the captured source passage shows them. */
  evidencedNumbers?: EvidencedNumber[];
}

export interface EnumMap {
  from: string;
  to: string;
  map: { [upstreamValue: string]: string };
  /** Payload key that keeps the upstream value beside the normalised one. */
  keepUpstreamAs?: string;
}

export interface EvidencedNumber {
  from: string;
  to: string;
  /** Upstream field holding the captured source text. Read in memory to check the number; never stored. */
  passageField: string;
  /** The number only means something for rows where this normalised field has this value. */
  onlyWhen: { field: string; equals: string };
  /** Omission reason for rows outside onlyWhen (an upstream default, not a source value). */
  notApplicableReason: string;
  /** Group whose members all showing zero is reported as an ambiguity, never resolved. */
  allZeroGroupField?: string;
}

export interface SourceConfig {
  source_id: string;
  registry_key?: string;
  title: string;
  publisher: string;
  official_url: string;
  adapter_kind: "live_fetch" | "export_import";
  adapter_name: string;
  allowed_hosts: string[];
  rights_id?: string;
  view_scope: ViewScope;
  expected_cadence_seconds?: number;
  snapshot_semantics: SnapshotSemantics;
  enabled: boolean;
  blocked_reason?: string;
  catalogue_products?: { product_id: string; mapping_note: string }[];
  adapter_options?: { [key: string]: Json };
  export_contract?: ExportContract;
}

export interface ScheduleConfig {
  schedule_key: string;
  source_id: string;
  cron_expr: string;
  function_slug: "ingest-run";
  max_runtime_seconds: number;
  max_records: number;
}

export interface SourcesFile {
  config_version: number;
  registry_products: { registry_key: string; title: string; domain: string; notes?: string }[];
  sources: SourceConfig[];
  schedules: ScheduleConfig[];
}

export interface OmittedField {
  field: string;
  reason: string;
}

export interface IngestRecord {
  external_record_id: string;
  record_kind: string;
  content_hash: string;
  original_content_hash?: string;
  source_url: string;
  /** Publisher-stated date, ISO 8601. Absent when the source states none; never invented. */
  source_published_at?: string;
  source_date_text?: string;
  /** When this project retrieved the content. Independent of the publisher date. */
  retrieved_at: string;
  projection_version: number;
  safe_payload: { [key: string]: Json };
  omitted_fields: OmittedField[];
}

export type FetchOutcome =
  | "ok"
  | "not_modified"
  | "blocked"
  | "challenge"
  | "http_error"
  | "network_error"
  | "timeout"
  | "too_large"
  | "host_denied"
  | "parse_error";

export interface FetchLogEntry {
  method: "GET" | "POST";
  url: string;
  host: string;
  attempt: number;
  outcome: FetchOutcome;
  http_status?: number;
  bytes?: number;
  body_sha256?: string;
  retrieved_at: string;
  duration_ms: number;
}

export interface AdapterPage {
  records: IngestRecord[];
  /** Opaque resume position written to the checkpoint after this page is stored. */
  cursor: Json;
  done: boolean;
  /** True only when the adapter has now seen the publisher's entire current list. */
  completeSnapshot?: boolean;
  watermark?: string;
}

export interface AdapterContext {
  source: SourceConfig;
  fetch: SafeFetch;
  resumeCursor: Json | null;
  maxRecords: number;
  deadline: number;
  now: () => Date;
}

export interface Adapter {
  name: string;
  version: string;
  pages(ctx: AdapterContext): AsyncGenerator<AdapterPage>;
}

export interface SafeFetchRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: { [key: string]: string };
  body?: string;
  accept?: string;
}

export interface SafeFetchResponse {
  status: number;
  text: string;
  bodySha256: string;
  retrievedAt: string;
  finalUrl: string;
}

export type SafeFetch = (request: SafeFetchRequest) => Promise<SafeFetchResponse>;

export class IngestError extends Error {
  errorClass: string;
  constructor(errorClass: string, message: string) {
    super(message);
    this.name = "IngestError";
    this.errorClass = errorClass;
  }
}

/** The publisher refused or challenged the request. An availability fact, not evidence of absence. */
export class SourceUnavailableError extends IngestError {
  outcome: FetchOutcome;
  constructor(outcome: FetchOutcome, message: string) {
    super(outcome === "challenge" ? "publisher_challenge" : "publisher_" + outcome, message);
    this.name = "SourceUnavailableError";
    this.outcome = outcome;
  }
}
