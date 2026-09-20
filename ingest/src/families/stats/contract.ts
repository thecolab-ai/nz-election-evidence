// Statistics family: the typed artifact contract.
//
// Both routes into the store produce the SAME artifact: the backfill (a read-only export of the upstream
// collection) and the incremental route (a fresh anonymous fetch of the publisher's file). The loader is the
// only writer and it accepts nothing but these row shapes. There is no free-form payload: every key is named
// here, every other upstream field is dropped by the mappers.
//
// Numbers are decimal TEXT end to end. A value never passes through a binary float on its way to numeric(38,12).
// A withheld, confidential, missing or not-applicable value is null with a status. It is never zero.
// `retrieved_at` is when the file was collected. It is never presented as when the publisher updated it:
// `released_on` is set only from a date the publisher states.

import { createHash } from "node:crypto";
import { canonicalJson } from "../../../../supabase/functions/_shared/canonical.ts";
import { textViolation as sharedTextViolation } from "../../../../supabase/functions/_shared/text_guard.ts";
import type { Json } from "../../../../supabase/functions/_shared/types.ts";

export const ARTIFACT_VERSION = 1;
export const OBSERVATIONS_PER_FILE = 20000;

export type Route = "dedicated_census" | "dedicated_series" | "operational";
export const ROUTES: readonly Route[] = ["dedicated_census", "dedicated_series", "operational"];

/** `flag_marker`: the publisher printed a marker symbol in a flag column (no number exists to withhold). */
export type ValueStatus = "reported" | "provisional" | "suppressed" | "confidential" | "missing" | "not_applicable" | "flag_marker";
export const VALUE_STATUSES: readonly ValueStatus[] = ["reported", "provisional", "suppressed", "confidential", "missing", "not_applicable", "flag_marker"];
export type ParseStatus = "parsed" | "unparsed_symbol" | "rejected";

export type ReleasedOnBasis = "publisher_stated_date" | "publisher_label_only" | "not_stated";
export type CodeBasis = "publisher_code" | "publisher_name_only";
export type EntryKind = "catalogue_link" | "file_metadata" | "dataset_metadata" | "product_metadata";
export const ENTRY_KINDS: readonly EntryKind[] = ["catalogue_link", "file_metadata", "dataset_metadata", "product_metadata"];

export interface RouteRow {
  kind: "route";
  observation_family: string;
  canonical_route: Route;
  overlapping_routes: Route[];
  /** Upstream row counts per route, as read. Overlapping routes are reported side by side, never added. */
  upstream_rows_by_route: { [route: string]: number };
  decision_note: string;
}

export interface DatasetRow {
  kind: "dataset";
  source_id: string;
  dataset_key: string;
  title: string;
  publisher: string;
  official_url: string;
  route: Route;
  /** True for an edition the publisher has since superseded (an earlier census, a closed release). */
  historical: boolean;
  coverage_note: string | null;
}

export interface ReleaseRow {
  kind: "release";
  dataset_key: string;
  /** Release vintage. Overlapping vintages stay separate rows; they are never merged or summed. */
  release_key: string;
  vintage_label: string | null;
  released_on: string | null;
  released_on_basis: ReleasedOnBasis;
  source_url: string;
  source_file_sha256: string | null;
  source_bytes: number | null;
  /** Collected-at (UTC). The earliest capture of this exact file. Not a publisher date. */
  retrieved_at: string;
  /** The publisher's HTTP Last-Modified header, verbatim, where the capture kept it. */
  publisher_last_modified: string | null;
  boundary_edition: string | null;
  /** How many upstream captures held this identical file. Captures are history of collection, not versions. */
  capture_count: number;
}

export interface SeriesRow {
  kind: "series";
  dataset_key: string;
  series_key: string;
  title: string | null;
  unit: string | null;
  magnitude: string | null;
  seasonal_adjustment: string | null;
  frequency: string | null;
  dimensions: { [name: string]: string };
}

export interface GeographyRow {
  kind: "geography";
  source_id: string;
  scheme: string;
  edition: string;
  code: string;
  name: string | null;
  code_basis: CodeBasis;
}

export interface ObservationRow {
  kind: "observation";
  dataset_key: string;
  release_key: string;
  series_key: string;
  geography: { scheme: string; edition: string; code: string } | null;
  period_label: string;
  period_start: string | null;
  period_end: string | null;
  /** Exact decimal text that fits numeric(38,12), or null. */
  value: string | null;
  /** Only when the published number cannot be held exactly in numeric(38,12). */
  value_double: number | null;
  /** The publisher's cell text, verbatim, where the upstream collection kept it. */
  raw_value: string | null;
  value_status: ValueStatus;
  parse_status: ParseStatus;
  /** Publisher status flag verbatim (FINAL, REVISED, P, C ...). */
  source_status: string | null;
  /** Publisher symbol printed in place of a number (..C, x, NA ...). */
  source_symbol: string | null;
  /** The upstream collection's own status word, kept so the mapping can be audited. */
  upstream_status: string;
  /** Quality measures the publisher prints beside the value: standard error, confidence bounds, flags. */
  qualifiers: { [name: string]: string };
  /** File member and row/cell of the value in the publisher's file. */
  row_locator: string;
  content_hash: string;
}

export interface CatalogueEntryRow {
  kind: "catalogue_entry";
  source_id: string;
  entry_key: string;
  entry_kind: EntryKind;
  title: string;
  url: string;
  found_on_url: string;
  format: string | null;
  /** SHA-256 of the publisher's file as captured, when the capture fetched the file itself. */
  file_sha256: string | null;
  /** The publisher's own modified/page date, verbatim. Null when the publisher states none. */
  publisher_modified_text: string | null;
  attributes: { [name: string]: Json };
  observed_first_at: string;
  observed_last_at: string;
  observation_count: number;
  content_hash: string;
}

export type MetaRow = RouteRow | DatasetRow | ReleaseRow | SeriesRow | GeographyRow | CatalogueEntryRow;
export type ArtifactRow = MetaRow | ObservationRow;

export interface ArtifactFile { name: string; sha256: string; bytes: number; rows: number }

export interface ArtifactManifest {
  artifact_version: number;
  source_id: string;
  producer: { route: "warehouse_export" | "fresh_fetch"; exporter_version: string; recipe_sha256: string };
  /** Collected-at range of the underlying captures. */
  collected_from: string | null;
  collected_to: string | null;
  files: ArtifactFile[];
  counts: {
    routes: number; datasets: number; releases: number; series: number; geographies: number;
    observations: number; catalogue_entries: number;
    observations_by_status: { [status: string]: number };
    observations_by_dataset: { [datasetKey: string]: number };
  };
  /** Source-to-artifact reconciliation: what was read upstream, what was written, and every difference explained. */
  reconciliation: ReconciliationLine[];
  findings: string[];
}

export interface ReconciliationLine {
  what: string;
  upstream_rows: number;
  artifact_rows: number;
  difference: number;
  explanation: string;
}

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

// Decimal text ----------------------------------------------------------------------------------------------

const DECIMAL = /^-?\d+(\.\d+)?$/;

export interface ParsedNumber { value: string | null; value_double: number | null }

/**
 * Normalises publisher number text without changing its value. Thousands separators are removed; nothing is rounded.
 * A number with more than 12 fractional digits or more than 26 integer digits cannot be held exactly in
 * numeric(38,12): it is carried as a double and the verbatim text stays in raw_value.
 */
export function parseDecimal(text: string): ParsedNumber | null {
  let t = text.trim();
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  if (/^-?\.\d+$/.test(t)) t = t.replace(".", "0.");
  if (!DECIMAL.test(t)) {
    // Some publisher files print exponent notation ("107e3"). Moving the decimal point is exact; no float is involved.
    const expanded = expandExponent(t);
    if (expanded === null) return null;
    t = expanded;
  }
  const [whole, fraction = ""] = t.replace(/^-/, "").split(".");
  if (whole.replace(/^0+(?=\d)/, "").length > 26 || fraction.length > 12) {
    const n = Number(t);
    return Number.isFinite(n) ? { value: null, value_double: n } : null;
  }
  const negative = t.startsWith("-");
  const cleanWhole = whole.replace(/^0+(?=\d)/, "");
  const body = fraction ? `${cleanWhole}.${fraction}` : cleanWhole;
  const isZero = /^0(\.0+)?$/.test(body);
  return { value: (negative && !isZero ? "-" : "") + body, value_double: null };
}

/** "107e3" -> "107000", "1.5e-2" -> "0.015". Pure digit shifting; null when the text is not exponent notation. */
export function expandExponent(text: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([-+]?\d{1,3})$/.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = "", exponentText] = match;
  const exponent = Number(exponentText);
  const digits = whole + fraction;
  const point = whole.length + exponent;
  let body: string;
  if (point <= 0) body = "0." + "0".repeat(-point) + digits;
  else if (point >= digits.length) body = digits + "0".repeat(point - digits.length);
  else body = digits.slice(0, point) + "." + digits.slice(point);
  if (body.includes(".")) body = body.replace(/0+$/, "").replace(/\.$/, "");
  return sign + body;
}

/** A binary double the upstream collection stored (it kept no cell text). Shortest round-trip text, never rounded. */
export function parseStoredDouble(n: number): ParsedNumber | null {
  if (!Number.isFinite(n)) return null;
  return parseDecimal(String(n)) ?? { value: null, value_double: n };
}

// Hashing ---------------------------------------------------------------------------------------------------

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Hash of the evidential content of a row. Collection times are excluded, so a re-capture of an unchanged file hashes the same. */
export function contentHashOf(row: { [key: string]: Json | undefined }): string {
  const copy: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined || key === "content_hash" || key === "observed_first_at" || key === "observed_last_at" || key === "observation_count") continue;
    copy[key] = value;
  }
  return "sha256:" + sha256Text(canonicalJson(copy));
}

// Validation ------------------------------------------------------------------------------------------------

const KEY = /^[^\s\u0000-\u001f][^\u0000-\u001f]{0,399}$/;
const SOURCE_ID = /^[a-z][a-z0-9_]{2,62}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[0-9a-f]{64}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(\/[^\s]*)?$/;
const SECRET_QUERY = /[?&#](key|api_?key|token|access_token|auth|sig|signature|secret|password|session)=/i;
/** The shared mirror of evidence_private.text_violation: one copy for every family (see _shared/text_guard.ts). */
export function textViolation(text: string | null | undefined): string | null {
  return sharedTextViolation(text);
}

function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ContractError(message);
}

function isIso(text: unknown): boolean {
  return typeof text === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(text) && !Number.isNaN(Date.parse(text));
}

function cleanUrl(url: unknown, what: string): void {
  need(typeof url === "string" && HTTPS.test(url) && url.length <= 2000, `${what} is not a plain https URL`);
  need(!SECRET_QUERY.test(url as string) && !/^https:\/\/[^/]*@/.test(url as string), `${what} carries a credential-like part`);
}

function plainMap(value: unknown, what: string, maxKeys: number): void {
  need(typeof value === "object" && value !== null && !Array.isArray(value), `${what} must be an object`);
  const entries = Object.entries(value as object);
  need(entries.length <= maxKeys, `${what} has too many keys`);
  for (const [key, item] of entries) {
    need(/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(key), `${what} key is not a plain name`);
    need(typeof item === "string" && item.length <= 1000, `${what}.${key} must be short text`);
    need(!textViolation(item as string), `${what}.${key} holds a value that is never stored (${textViolation(item as string)})`);
  }
}

const EXACT_KEYS: { [kind: string]: string[] } = {
  route: ["kind", "observation_family", "canonical_route", "overlapping_routes", "upstream_rows_by_route", "decision_note"],
  dataset: ["kind", "source_id", "dataset_key", "title", "publisher", "official_url", "route", "historical", "coverage_note"],
  release: ["kind", "dataset_key", "release_key", "vintage_label", "released_on", "released_on_basis", "source_url", "source_file_sha256", "source_bytes", "retrieved_at", "publisher_last_modified", "boundary_edition", "capture_count"],
  series: ["kind", "dataset_key", "series_key", "title", "unit", "magnitude", "seasonal_adjustment", "frequency", "dimensions"],
  geography: ["kind", "source_id", "scheme", "edition", "code", "name", "code_basis"],
  observation: ["kind", "dataset_key", "release_key", "series_key", "geography", "period_label", "period_start", "period_end", "value", "value_double", "raw_value", "value_status", "parse_status", "source_status", "source_symbol", "upstream_status", "qualifiers", "row_locator", "content_hash"],
  catalogue_entry: ["kind", "source_id", "entry_key", "entry_kind", "title", "url", "found_on_url", "format", "file_sha256", "publisher_modified_text", "attributes", "observed_first_at", "observed_last_at", "observation_count", "content_hash"],
};

/** Allowlisted attribute names of a catalogue entry. Anything else is refused, not dropped silently. */
export const CATALOGUE_ATTRIBUTES: readonly string[] = [
  "topic", "resource_count", "result_set_scope", "file_size_label", "catalogue_title", "platform", "release_date_text",
  "themes", "subjects", "variables", "geographic_levels", "statistical_unit", "scope", "excluded_scope",
  "release_vintage_label", "period_start", "period_end", "reviewed_series", "available_reviewed_fact_rows",
  "emitted_fact_rows", "complete_workbook_normalization", "upstream_dataset_key",
];

/** Validates one artifact row against the contract. Throws ContractError; messages never echo row content. */
export function validateRow(row: unknown): ArtifactRow {
  need(typeof row === "object" && row !== null && !Array.isArray(row), "row is not an object");
  const r = row as { [key: string]: unknown };
  const kind = String(r.kind);
  const keys = EXACT_KEYS[kind];
  need(keys, "row kind is not part of the contract");
  const present = Object.keys(r).sort().join(",");
  need(present === [...keys].sort().join(","), `${kind} row does not carry exactly the contract's keys`);
  const text = (name: string, max: number, nullable = false): void => {
    const v = r[name];
    if (nullable && v === null) return;
    need(typeof v === "string" && v.length > 0 && v.length <= max, `${kind}.${name} must be text of at most ${max} characters`);
    need(!textViolation(v as string), `${kind}.${name} holds a value that is never stored (${textViolation(v as string)})`);
  };
  switch (kind) {
    case "route":
      text("observation_family", 400); text("decision_note", 1000);
      need(ROUTES.includes(r.canonical_route as Route), "route.canonical_route is not a known route");
      need(Array.isArray(r.overlapping_routes) && (r.overlapping_routes as unknown[]).every((x) => ROUTES.includes(x as Route) && x !== r.canonical_route), "route.overlapping_routes is not a list of other routes");
      need(typeof r.upstream_rows_by_route === "object" && r.upstream_rows_by_route !== null
        && Object.entries(r.upstream_rows_by_route).every(([k, v]) => ROUTES.includes(k as Route) && Number.isSafeInteger(v) && (v as number) >= 0), "route.upstream_rows_by_route must map routes to counts");
      break;
    case "dataset":
      need(SOURCE_ID.test(String(r.source_id)), "dataset.source_id is not a source id");
      text("dataset_key", 400); text("title", 500); text("publisher", 300); text("coverage_note", 1000, true);
      cleanUrl(r.official_url, "dataset.official_url");
      need(ROUTES.includes(r.route as Route), "dataset.route is not a known route");
      need(typeof r.historical === "boolean", "dataset.historical must be a boolean");
      break;
    case "release":
      text("dataset_key", 400); text("release_key", 400); text("vintage_label", 500, true);
      text("publisher_last_modified", 100, true); text("boundary_edition", 500, true);
      cleanUrl(r.source_url, "release.source_url");
      need(r.released_on === null || DATE.test(String(r.released_on)), "release.released_on must be a date or null");
      need(["publisher_stated_date", "publisher_label_only", "not_stated"].includes(String(r.released_on_basis)), "release.released_on_basis is unknown");
      need((r.released_on !== null) === (r.released_on_basis === "publisher_stated_date"), "release.released_on is set only from a publisher-stated date");
      need(r.source_file_sha256 === null || SHA.test(String(r.source_file_sha256)), "release.source_file_sha256 must be a SHA-256");
      need(r.source_bytes === null || (Number.isSafeInteger(r.source_bytes) && (r.source_bytes as number) > 0), "release.source_bytes must be a positive integer or null");
      need(isIso(r.retrieved_at), "release.retrieved_at must be a UTC timestamp");
      need(Number.isSafeInteger(r.capture_count) && (r.capture_count as number) >= 1, "release.capture_count must be at least 1");
      break;
    case "series":
      text("dataset_key", 400); text("series_key", 400); text("title", 1000, true); text("unit", 200, true);
      text("magnitude", 40, true); text("seasonal_adjustment", 100, true); text("frequency", 60, true);
      plainMap(r.dimensions, "series.dimensions", 30);
      break;
    case "geography":
      need(SOURCE_ID.test(String(r.source_id)), "geography.source_id is not a source id");
      text("scheme", 200); text("edition", 500); text("code", 400); text("name", 500, true);
      need(r.code_basis === "publisher_code" || r.code_basis === "publisher_name_only", "geography.code_basis is unknown");
      break;
    case "observation": {
      text("dataset_key", 400); text("release_key", 400); text("series_key", 400); text("period_label", 200);
      text("raw_value", 200, true); text("source_status", 60, true); text("source_symbol", 60, true);
      text("upstream_status", 60); text("row_locator", 400);
      need(KEY.test(String(r.series_key)), "observation.series_key is unusable");
      if (r.geography !== null) {
        const g = r.geography as { [key: string]: unknown };
        need(typeof g === "object" && Object.keys(g).sort().join(",") === "code,edition,scheme"
          && [g.scheme, g.edition, g.code].every((x) => typeof x === "string" && x.length > 0 && x.length <= 500), "observation.geography must name scheme, edition and code");
      }
      for (const name of ["period_start", "period_end"]) need(r[name] === null || DATE.test(String(r[name])), `observation.${name} must be a date or null`);
      need(VALUE_STATUSES.includes(r.value_status as ValueStatus), "observation.value_status is outside the vocabulary");
      need(["parsed", "unparsed_symbol", "rejected"].includes(String(r.parse_status)), "observation.parse_status is outside the vocabulary");
      need(r.value === null || (typeof r.value === "string" && DECIMAL.test(r.value) && parseDecimal(r.value)?.value === r.value), "observation.value must be exact decimal text");
      need(r.value_double === null || (typeof r.value_double === "number" && Number.isFinite(r.value_double)), "observation.value_double must be finite");
      need(!(r.value !== null && r.value_double !== null), "observation carries one number, not two");
      const hasNumber = r.value !== null || r.value_double !== null;
      const numeric = r.value_status === "reported" || r.value_status === "provisional";
      // The rule the table enforces too: a number exists exactly when the status says one was published.
      need(hasNumber === numeric, "observation: a number exists only for reported or provisional values, and always for those");
      need(!hasNumber || r.parse_status === "parsed", "observation: a stored number must be a parsed one");
      plainMap(r.qualifiers, "observation.qualifiers", 12);
      need(HASH.test(String(r.content_hash)), "observation.content_hash is not a sha256 content hash");
      break;
    }
    case "catalogue_entry": {
      need(SOURCE_ID.test(String(r.source_id)), "catalogue_entry.source_id is not a source id");
      text("entry_key", 400); text("title", 1000); text("format", 40, true); text("publisher_modified_text", 100, true);
      need(ENTRY_KINDS.includes(r.entry_kind as EntryKind), "catalogue_entry.entry_kind is unknown");
      cleanUrl(r.url, "catalogue_entry.url"); cleanUrl(r.found_on_url, "catalogue_entry.found_on_url");
      need(r.file_sha256 === null || SHA.test(String(r.file_sha256)), "catalogue_entry.file_sha256 must be a SHA-256");
      need(typeof r.attributes === "object" && r.attributes !== null && !Array.isArray(r.attributes), "catalogue_entry.attributes must be an object");
      for (const [key, value] of Object.entries(r.attributes as object)) {
        need(CATALOGUE_ATTRIBUTES.includes(key), "catalogue_entry.attributes holds a name outside the allowlist");
        need(!textViolation(JSON.stringify(value)), "catalogue_entry.attributes holds a value that is never stored");
        need(JSON.stringify(value).length <= 4000, "catalogue_entry.attributes value is too long");
      }
      need(isIso(r.observed_first_at) && isIso(r.observed_last_at), "catalogue_entry observation times must be UTC timestamps");
      need(String(r.observed_first_at) <= String(r.observed_last_at), "catalogue_entry was last observed before it was first observed");
      need(Number.isSafeInteger(r.observation_count) && (r.observation_count as number) >= 1, "catalogue_entry.observation_count must be at least 1");
      need(HASH.test(String(r.content_hash)), "catalogue_entry.content_hash is not a sha256 content hash");
      break;
    }
  }
  return r as unknown as ArtifactRow;
}

/**
 * What the publisher printed, and where it belongs: the evidential content of an observation. How the row was read
 * (the upstream status word, the locator wording, the parse status) is provenance of the ROUTE and is left out, so the
 * same publisher cell hashes the same whether it arrived through the backfill or through a fresh fetch. A re-fetch of
 * a byte-identical file is then "unchanged", and a conflict always means the published content itself differs.
 */
const EVIDENTIAL_KEYS = ["dataset_key", "release_key", "series_key", "geography", "period_label", "period_start", "period_end", "value", "value_double",
  "raw_value", "value_status", "source_status", "source_symbol", "qualifiers"] as const;

/** Builds an observation row and stamps its content hash. */
export function observation(fields: Omit<ObservationRow, "kind" | "content_hash">): ObservationRow {
  const evidential: { [key: string]: Json } = { kind: "observation" };
  for (const key of EVIDENTIAL_KEYS) evidential[key] = fields[key] as Json;
  return { kind: "observation" as const, ...fields, content_hash: contentHashOf(evidential) };
}

export function catalogueEntry(fields: Omit<CatalogueEntryRow, "kind" | "content_hash">): CatalogueEntryRow {
  const row = { kind: "catalogue_entry" as const, ...fields, content_hash: "" };
  row.content_hash = contentHashOf(row as unknown as { [key: string]: Json });
  return row;
}

/** ISO timestamp from the upstream "YYYY-MM-DD HH:MM:SS[.mmm]" UTC text. */
export function upstreamUtc(text: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?Z?$/.exec(text.trim());
  if (!match) throw new ContractError("upstream timestamp is not in the expected UTC form");
  return `${match[1]}T${match[2]}${match[3] ?? ""}Z`;
}
