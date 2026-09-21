// Statistics family: pure mappers from upstream rows to contract rows.
//
// Every mapper names the upstream keys it reads. Any key it does not name is dropped and the drop is counted by
// name in the artifact manifest, so nothing arrives unseen. The mappers never read a stored original record.
//
// Status mapping is closed: an upstream status word outside the documented vocabulary fails the export. A value
// the publisher withheld stays null with its symbol; an upstream parsing gap is never reported as "missing".

import { createHash } from "node:crypto";
import {
  catalogueEntry, type CatalogueEntryRow, ContractError, type DatasetRow, type EntryKind, type GeographyRow, observation,
  type ObservationRow, parseDecimal, type ParsedNumber, parseStoredDouble, type ReleaseRow, type Route, type SeriesRow,
  sha256Text, upstreamUtc, type ValueStatus,
} from "./contract.ts";
import type { Json } from "../../../../supabase/functions/_shared/types.ts";

export type Upstream = { [key: string]: unknown };

/** Collects the distinct meta rows a stream of observations refers to, and the fields that were dropped. */
export class MetaCollector {
  datasets = new Map<string, DatasetRow>();
  releases = new Map<string, ReleaseRow>();
  series = new Map<string, SeriesRow>();
  geographies = new Map<string, GeographyRow>();
  dropped = new Map<string, number>();
  private identities = new Set<string>();

  addDataset(row: DatasetRow): void {
    if (!this.datasets.has(row.dataset_key)) this.datasets.set(row.dataset_key, row);
  }
  addRelease(row: ReleaseRow): void {
    const key = row.dataset_key + "\u0000" + row.release_key;
    const existing = this.releases.get(key);
    if (!existing) {
      this.releases.set(key, row);
      return;
    }
    if (existing.source_file_sha256 !== row.source_file_sha256 || existing.source_url !== row.source_url) {
      throw new ContractError(`release ${row.release_key} of ${row.dataset_key} is described by two different files`);
    }
    if (row.retrieved_at < existing.retrieved_at) existing.retrieved_at = row.retrieved_at;
  }
  addSeries(row: SeriesRow): void {
    const key = row.dataset_key + "\u0000" + row.series_key;
    const existing = this.series.get(key);
    if (!existing) {
      this.series.set(key, row);
      return;
    }
    // One series key, one definition. A unit or title that changes under the same key is a mapping fault.
    if (existing.unit !== row.unit || existing.title !== row.title || JSON.stringify(existing.dimensions) !== JSON.stringify(row.dimensions)) {
      throw new ContractError(`series key is not a function of its definition in ${row.dataset_key}`);
    }
  }
  addGeography(row: GeographyRow): void {
    const key = [row.scheme, row.edition, row.code].join("\u0000");
    const existing = this.geographies.get(key);
    if (!existing) {
      this.geographies.set(key, row);
      return;
    }
    if (existing.name !== row.name) throw new ContractError(`geography code carries two names in scheme ${row.scheme}`);
  }
  /** The store's identity: series, release, geography, period. A second row with the same identity is a fault, never a sum. */
  claim(row: ObservationRow): void {
    const g = row.geography;
    const id = [row.dataset_key, row.series_key, row.release_key, g ? g.scheme + "|" + g.edition + "|" + g.code : "", row.period_label].join("\u0000");
    // A short digest keeps the identity set small for sources with close to a million observations.
    const digest = createHash("sha256").update(id).digest("base64").slice(0, 22);
    if (this.identities.has(digest)) throw new ContractError(`two upstream rows share one observation identity in ${row.dataset_key} (${row.row_locator})`);
    this.identities.add(digest);
  }
  drop(payload: Upstream, used: ReadonlySet<string>): void {
    for (const key of Object.keys(payload)) if (!used.has(key)) this.dropped.set(key, (this.dropped.get(key) ?? 0) + 1);
  }
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function must(value: unknown, what: string): string {
  const text = str(value);
  if (text === null) throw new ContractError(`upstream row lacks ${what}`);
  return text;
}

function sha(value: unknown): string | null {
  const text = str(value);
  return text && /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function dims(pairs: { [name: string]: unknown }): { [name: string]: string } {
  const out: { [name: string]: string } = {};
  for (const [name, value] of Object.entries(pairs)) {
    const text = str(typeof value === "object" && value !== null ? JSON.stringify(value) : value);
    if (text !== null && text !== "NA") out[name] = text.slice(0, 1000);
  }
  return out;
}

function geographyOf(collector: MetaCollector, sourceId: string, level: unknown, edition: unknown, code: unknown, name: unknown): ObservationRow["geography"] {
  const levelText = str(level);
  const nameText = str(name);
  const codeText = str(code);
  if (!levelText || (!codeText && !nameText)) return null;
  const row: GeographyRow = {
    kind: "geography", source_id: sourceId, scheme: `${sourceId}:${levelText}`, edition: str(edition) ?? "not_stated_by_source",
    code: codeText ?? nameText!, name: nameText, code_basis: codeText ? "publisher_code" : "publisher_name_only",
  };
  collector.addGeography(row);
  return { scheme: row.scheme, edition: row.edition, code: row.code };
}

function monthBounds(label: string): { start: string; end: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${match[1]}-${match[2]}-01`, end: `${match[1]}-${match[2]}-${String(last).padStart(2, "0")}` };
}

function isoDate(value: unknown): string | null {
  const text = str(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/** Publisher status flags that mark a provisional figure. Everything else numeric is a reported figure. */
function provisional(sourceStatus: string | null): boolean {
  return sourceStatus !== null && /^(p|prov|provisional)$/i.test(sourceStatus);
}

interface Valued { number: ParsedNumber | null; value_status: ValueStatus; parse_status: ObservationRow["parse_status"]; source_symbol: string | null }

const WITHHELD: { [upstream: string]: ValueStatus } = {
  confidentialised: "confidential", suppressed: "suppressed", not_available: "missing", missing: "missing",
  not_applicable: "not_applicable", outside_tolerance: "flag_marker",
};
const NUMERIC_WORDS = new Set(["observed", "published", "numeric", "reported"]);

/**
 * One closed mapping for every upstream status vocabulary. A numeric status REQUIRES a parseable number and a
 * withheld status requires none: a row that breaks either rule fails the export rather than being smoothed over.
 */
function valued(upstreamStatus: string, numberText: string | null, storedDouble: number | null, sourceStatus: string | null, symbol: string | null): Valued {
  if (NUMERIC_WORDS.has(upstreamStatus)) {
    const number = numberText !== null ? parseDecimal(numberText) : storedDouble !== null ? parseStoredDouble(storedDouble) : null;
    if (!number) throw new ContractError(`upstream status ${upstreamStatus} without a parseable number`);
    return { number, value_status: provisional(sourceStatus) ? "provisional" : "reported", parse_status: "parsed", source_symbol: null };
  }
  const status = WITHHELD[upstreamStatus];
  if (!status) throw new ContractError(`upstream value status "${upstreamStatus.slice(0, 40)}" is outside the documented vocabulary`);
  if ((numberText !== null && parseDecimal(numberText)) || storedDouble !== null) throw new ContractError(`upstream status ${upstreamStatus} arrived with a number`);
  return { number: null, value_status: status, parse_status: symbol ? "unparsed_symbol" : "parsed", source_symbol: symbol };
}

function datasetRow(sourceId: string, key: string, title: string, publisher: string, url: string, route: Route, historical: boolean, note: string | null): DatasetRow {
  return { kind: "dataset", source_id: sourceId, dataset_key: key, title, publisher, official_url: url, route, historical, coverage_note: note };
}

export interface MapContext { sourceId: string; publisher: string; officialUrl: string; historical: boolean }

// Operational facts -----------------------------------------------------------------------------------------

/** Titles are the project's plain description of the upstream dataset key; an unknown key is shown as the key itself. */
export const SELECTED_SERIES_TITLES: { [datasetKey: string]: string } = {
  food_price_index_selected_price_indexes_csv: "Selected price indexes: release CSV file",
  national_population_estimates_release_broad_age_graph_csv: "National population estimates: population by broad age group, at 30 June",
};

/** P22: Stats NZ selected price indexes and national population by broad age group. */
export function mapSelectedSeries(ctx: MapContext, collector: MetaCollector, record: Upstream, p: Upstream): ObservationRow {
  const used = new Set(["dataset", "edition", "frequency", "geography_code", "geography_label", "geography_level", "measure", "reference_period",
    "series_group", "series_id", "series_title_1", "series_title_2", "series_title_3", "source_record_number", "source_sha256", "source_status",
    "topic", "unit", "value_decimal", "value_raw", "value_status", "adjustment", "population", "sex", "source_page_url"]);
  collector.drop(p, used);
  const datasetKey = must(p.dataset, "dataset");
  const releaseKey = must(p.edition, "edition");
  const seriesKey = must(p.series_id, "series_id");
  collector.addDataset(datasetRow(ctx.sourceId, datasetKey, SELECTED_SERIES_TITLES[datasetKey] ?? datasetKey, ctx.publisher, str(p.source_page_url) ?? ctx.officialUrl, "operational", ctx.historical,
    "Selected files only; each series keeps its own unit, period and vintage."));
  collector.addRelease({
    kind: "release", dataset_key: datasetKey, release_key: releaseKey, vintage_label: releaseKey, released_on: null, released_on_basis: "publisher_label_only",
    source_url: must(record.source_url, "source_url"), source_file_sha256: sha(p.source_sha256), source_bytes: null, retrieved_at: upstreamUtc(must(record.observed_at, "observed_at")),
    publisher_last_modified: null, boundary_edition: null, capture_count: 1,
  });
  const titles = [p.series_title_1, p.series_title_2, p.series_title_3].map(str).filter((t): t is string => t !== null && t !== "NA");
  collector.addSeries({
    kind: "series", dataset_key: datasetKey, series_key: seriesKey, title: titles.join(" / ") || null, unit: str(p.unit), magnitude: null,
    seasonal_adjustment: str(p.adjustment), frequency: str(p.frequency),
    dimensions: dims({ series_group: p.series_group, measure: p.measure, topic: p.topic, population: p.population, sex: p.sex }),
  });
  const period = must(p.reference_period, "reference_period");
  const bounds = str(p.frequency) === "monthly" ? monthBounds(period) : null;
  const pointInTime = isoDate(period);
  const raw = str(p.value_raw);
  const sourceStatus = str(p.source_status);
  const v = valued(must(p.value_status, "value_status"), str(p.value_decimal), null, sourceStatus, raw !== null && !parseDecimal(raw) ? raw : null);
  const row = observation({
    dataset_key: datasetKey, release_key: releaseKey, series_key: seriesKey,
    geography: geographyOf(collector, ctx.sourceId, p.geography_level, null, p.geography_code, p.geography_label),
    period_label: period, period_start: bounds?.start ?? pointInTime, period_end: bounds?.end ?? pointInTime,
    value: v.number?.value ?? null, value_double: v.number?.value_double ?? null, raw_value: raw, value_status: v.value_status, parse_status: v.parse_status,
    source_status: sourceStatus, source_symbol: v.source_symbol, upstream_status: must(p.value_status, "value_status"), qualifiers: {},
    row_locator: `record ${must(p.source_record_number, "source_record_number")}`,
  });
  collector.claim(row);
  return row;
}

/** P23: Tenancy Services detailed monthly regional rental bond measures. */
export function mapTenancy(ctx: MapContext, collector: MetaCollector, record: Upstream, p: Upstream): ObservationRow {
  const used = new Set(["adjustment", "extractor_version", "frequency", "geography_code", "geography_label", "geography_level", "measure", "population",
    "quality_context", "reference_period", "rent_basis", "source_column", "source_last_modified", "source_page_url", "source_period_raw",
    "source_record_number", "source_sha256", "statistic", "stock_flow", "topic", "unit", "value_decimal", "value_raw", "value_status"]);
  collector.drop(p, used);
  const datasetKey = "tenancy.rental_bonds.detailed_monthly_region";
  const fileSha = sha(p.source_sha256);
  if (!fileSha) throw new ContractError("tenancy row lacks the file hash that names its release");
  const releaseKey = `file-${fileSha.slice(0, 16)}`;
  collector.addDataset(datasetRow(ctx.sourceId, datasetKey, "Rental bond data: detailed monthly, by region", ctx.publisher, str(p.source_page_url) ?? ctx.officialUrl, "operational", ctx.historical,
    "Private-sector bonded tenancies. Counts are randomly rounded to base 3 and values under 5 are suppressed by the publisher; recent months are provisional."));
  const modified = str(p.source_last_modified);
  collector.addRelease({
    kind: "release", dataset_key: datasetKey, release_key: releaseKey, vintage_label: modified ? `file last modified ${modified}` : null, released_on: null,
    released_on_basis: "not_stated", source_url: must(record.source_url, "source_url"), source_file_sha256: fileSha, source_bytes: null,
    retrieved_at: upstreamUtc(must(record.observed_at, "observed_at")), publisher_last_modified: modified, boundary_edition: null, capture_count: 1,
  });
  const seriesKey = must(p.measure, "measure");
  collector.addSeries({
    kind: "series", dataset_key: datasetKey, series_key: seriesKey, title: seriesKey, unit: str(p.unit), magnitude: null, seasonal_adjustment: str(p.adjustment),
    frequency: str(p.frequency),
    dimensions: dims({ statistic: p.statistic, stock_flow: p.stock_flow, rent_basis: p.rent_basis, population: p.population, quality_context: p.quality_context, source_column: p.source_column, topic: p.topic }),
  });
  const period = must(p.reference_period, "reference_period");
  const bounds = monthBounds(period);
  const raw = str(p.value_raw);
  const v = valued(must(p.value_status, "value_status"), str(p.value_decimal), null, null, raw !== null && !parseDecimal(raw) ? raw : null);
  const row = observation({
    dataset_key: datasetKey, release_key: releaseKey, series_key: seriesKey,
    geography: geographyOf(collector, ctx.sourceId, p.geography_level, null, p.geography_code, p.geography_label),
    period_label: period, period_start: bounds?.start ?? null, period_end: bounds?.end ?? null,
    value: v.number?.value ?? null, value_double: v.number?.value_double ?? null, raw_value: raw, value_status: v.value_status, parse_status: v.parse_status,
    source_status: null, source_symbol: v.source_symbol, upstream_status: must(p.value_status, "value_status"),
    qualifiers: dims({ source_period_text: p.source_period_raw }), row_locator: `record ${must(p.source_record_number, "source_record_number")} column ${must(p.source_column, "source_column")}`,
  });
  collector.claim(row);
  return row;
}

/** P12: MSD quarterly national benefit tables (reviewed national series only). */
export function mapMsd(ctx: MapContext, collector: MetaCollector, record: Upstream, p: Upstream): ObservationRow {
  const used = new Set(["comparability_status", "complete_workbook_normalization", "dataset_id", "dimensions", "eligibility_review_status", "frequency",
    "geography_scope", "measure", "notes_reference", "parser_version", "period_end", "period_label", "period_semantics", "period_start", "raw_value",
    "release_vintage_label", "rounding", "scope", "series_id", "source_cell", "source_label_cell", "source_member", "source_period_cell", "source_sha256",
    "source_sheet", "unit", "value_decimal", "value_status"]);
  collector.drop(p, used);
  const datasetKey = must(p.dataset_id, "dataset_id");
  const releaseKey = must(p.release_vintage_label, "release_vintage_label");
  collector.addDataset(datasetRow(ctx.sourceId, datasetKey, "MSD quarterly benefit fact sheets: national level data tables", ctx.publisher, ctx.officialUrl, "operational", ctx.historical,
    "Reviewed national series only; regional, demographic and detailed sub-category tables of the workbook are not normalised. Counts are independently randomly rounded to base 3."));
  collector.addRelease({
    kind: "release", dataset_key: datasetKey, release_key: releaseKey, vintage_label: releaseKey, released_on: null, released_on_basis: "publisher_label_only",
    source_url: must(record.source_url, "source_url"), source_file_sha256: sha(p.source_sha256), source_bytes: null, retrieved_at: upstreamUtc(must(record.observed_at, "observed_at")),
    publisher_last_modified: null, boundary_edition: null, capture_count: 1,
  });
  const seriesKey = must(p.series_id, "series_id");
  const dimensionObject = typeof p.dimensions === "object" && p.dimensions !== null ? p.dimensions as { [key: string]: unknown } : {};
  collector.addSeries({
    kind: "series", dataset_key: datasetKey, series_key: seriesKey, title: [str(p.measure), ...Object.values(dimensionObject).map(str)].filter(Boolean).join(" / "),
    unit: str(p.unit), magnitude: null, seasonal_adjustment: null, frequency: str(p.frequency),
    dimensions: dims({ measure: p.measure, ...dimensionObject, period_semantics: p.period_semantics, rounding: p.rounding, comparability_status: p.comparability_status, scope: p.scope, source_sheet: p.source_sheet }),
  });
  const raw = str(p.raw_value);
  const v = valued(must(p.value_status, "value_status"), str(p.value_decimal), null, null, null);
  const row = observation({
    dataset_key: datasetKey, release_key: releaseKey, series_key: seriesKey,
    geography: geographyOf(collector, ctx.sourceId, "national", null, null, p.geography_scope),
    period_label: must(p.period_label, "period_label"), period_start: isoDate(p.period_start), period_end: isoDate(p.period_end),
    value: v.number?.value ?? null, value_double: v.number?.value_double ?? null, raw_value: raw, value_status: v.value_status, parse_status: v.parse_status,
    source_status: null, source_symbol: v.source_symbol, upstream_status: must(p.value_status, "value_status"), qualifiers: {},
    row_locator: `${must(p.source_sheet, "source_sheet")}!${must(p.source_cell, "source_cell")}`,
  });
  collector.claim(row);
  return row;
}

/** P11: Health New Zealand primary care enrolment availability (one workbook, one quarter). */
export function mapHealth(ctx: MapContext, collector: MetaCollector, record: Upstream, p: Upstream): ObservationRow {
  const used = new Set(["boundary_version", "comparability_note", "definition", "definition_source_locator", "definition_version", "geography", "geography_type",
    "indicator_id", "indicator_label", "measure_type", "period", "period_end", "period_start", "population", "provider", "provider_id", "source_locator",
    "source_row", "source_sha256", "source_value", "topic", "unit", "value", "value_decimal", "value_status"]);
  collector.drop(p, used);
  const datasetKey = "healthnz.primary_care.pho_enrolment_availability";
  const fileSha = sha(p.source_sha256);
  if (!fileSha) throw new ContractError("health row lacks the file hash that names its release");
  const releaseKey = `file-${fileSha.slice(0, 16)}`;
  collector.addDataset(datasetRow(ctx.sourceId, datasetKey, "Primary care indicators: general practice enrolment availability by PHO", ctx.publisher, ctx.officialUrl, "operational", ctx.historical,
    str(p.comparability_note)?.slice(0, 1000) ?? null));
  collector.addRelease({
    kind: "release", dataset_key: datasetKey, release_key: releaseKey, vintage_label: str(p.definition_version), released_on: null, released_on_basis: "not_stated",
    source_url: must(record.source_url, "source_url"), source_file_sha256: fileSha, source_bytes: null, retrieved_at: upstreamUtc(must(record.observed_at, "observed_at")),
    publisher_last_modified: null, boundary_edition: str(p.boundary_version), capture_count: 1,
  });
  const seriesKey = `${must(p.indicator_id, "indicator_id")}|${must(p.provider_id, "provider_id")}`;
  collector.addSeries({
    kind: "series", dataset_key: datasetKey, series_key: seriesKey, title: `${must(p.indicator_label, "indicator_label")} / ${must(p.provider, "provider")}`.slice(0, 1000),
    unit: str(p.unit), magnitude: null, seasonal_adjustment: null, frequency: null,
    dimensions: dims({ indicator_id: p.indicator_id, provider: p.provider, provider_id: p.provider_id, measure_type: p.measure_type, population: p.population, definition: p.definition, definition_locator: p.definition_source_locator, topic: p.topic }),
  });
  const raw = str(p.source_value);
  const v = valued(must(p.value_status, "value_status"), str(p.value_decimal), null, null, null);
  const row = observation({
    dataset_key: datasetKey, release_key: releaseKey, series_key: seriesKey,
    geography: geographyOf(collector, ctx.sourceId, p.geography_type, p.boundary_version, null, p.geography),
    period_label: must(p.period, "period"), period_start: isoDate(p.period_start), period_end: isoDate(p.period_end),
    value: v.number?.value ?? null, value_double: v.number?.value_double ?? null, raw_value: raw, value_status: v.value_status, parse_status: v.parse_status,
    source_status: null, source_symbol: v.source_symbol, upstream_status: must(p.value_status, "value_status"), qualifiers: {},
    row_locator: must(p.source_locator, "source_locator"),
  });
  collector.claim(row);
  return row;
}

// Census (operational 2023 and dedicated 2018/2013 share one shape) ------------------------------------------

export interface CensusDatasetInfo { title: string; coverage_note: string | null; source_bytes: number | null; retrieved_at: string | null; capture_count: number }

/**
 * P19, P21 and the 2013 history. `c` holds the census columns; `retrievedAt` is the collection time. The upstream
 * census tables store the value as a binary double and keep no cell text, so raw_value is null and the number
 * is the double's shortest exact decimal text (counts, so integers).
 */
export function mapCensus(ctx: MapContext, collector: MetaCollector, route: Route, c: Upstream, retrievedAt: string, info: CensusDatasetInfo, locatorPrefix: string): ObservationRow {
  const datasetKey = must(c.dataset_id, "dataset_id");
  const vintage = must(c.release_vintage, "release_vintage");
  const stated = isoDate(vintage);
  collector.addDataset(datasetRow(ctx.sourceId, datasetKey, info.title, ctx.publisher, ctx.officialUrl, route, ctx.historical, info.coverage_note));
  collector.addRelease({
    kind: "release", dataset_key: datasetKey, release_key: vintage, vintage_label: vintage, released_on: stated, released_on_basis: stated ? "publisher_stated_date" : "publisher_label_only",
    source_url: must(c.source_url, "source_url"), source_file_sha256: sha(c.source_sha256), source_bytes: info.source_bytes, retrieved_at: info.retrieved_at ?? retrievedAt,
    publisher_last_modified: null, boundary_edition: str(c.boundary_edition), capture_count: info.capture_count,
  });
  const member = must(c.source_file, "source_file");
  const seriesKey = [member, must(c.subject, "subject"), must(c.measure, "measure"), str(c.category_dimension) ?? "", str(c.category_code) ?? ""].join("|");
  collector.addSeries({
    kind: "series", dataset_key: datasetKey, series_key: seriesKey, title: [str(c.subject), str(c.measure), str(c.category_label)].filter(Boolean).join(" / ").slice(0, 1000),
    unit: str(c.unit), magnitude: null, seasonal_adjustment: null, frequency: "census",
    dimensions: dims({ subject: c.subject, measure: c.measure, category_dimension: c.category_dimension, category_code: c.category_code, category_label: c.category_label, source_member: member }),
  });
  const symbol = str(c.source_symbol);
  const stored = typeof c.value === "number" ? c.value : null;
  if (c.value !== null && c.value !== undefined && stored === null) throw new ContractError("census value is not a number or null");
  const v = valued(must(c.value_status, "value_status"), null, stored, null, symbol);
  const year = must(c.census_year, "census_year");
  const row = observation({
    dataset_key: datasetKey, release_key: vintage, series_key: seriesKey,
    geography: geographyOf(collector, ctx.sourceId, c.geography_level, c.boundary_edition, c.geography_code, c.geography_name),
    period_label: year, period_start: null, period_end: null,
    value: v.number?.value ?? null, value_double: v.number?.value_double ?? null, raw_value: null, value_status: v.value_status, parse_status: v.parse_status,
    source_status: null, source_symbol: v.source_symbol, upstream_status: must(c.value_status, "value_status"), qualifiers: {},
    row_locator: `${locatorPrefix}${member} row ${must(c.source_row, "source_row")}`,
  });
  collector.claim(row);
  return row;
}

export const CENSUS_2023_USED: ReadonlySet<string> = new Set(["boundary_edition", "category_code", "category_dimension", "category_label", "census_year", "coverage",
  "dataset_id", "geography_code", "geography_level", "geography_name", "measure", "release_vintage", "source_file", "source_row", "source_sha256", "source_symbol",
  "source_url", "subject", "unit", "value", "value_status"]);

// Dedicated series: the publisher's own CSV columns ---------------------------------------------------------

/**
 * How one publisher CSV layout is read. The columns are the PUBLISHER's, kept verbatim upstream, so a file whose
 * column names differ (SER_REF / TIME_REF / DATA_VAL) is read correctly even where the upstream normaliser was not.
 */
export interface SeriesShape {
  value: string[]; period: string[]; seriesRef: string[]; status: string[]; unit: string[]; magnitude: string[];
  qualifiers: string[]; titleColumns: string[];
}

export const SERIES_SHAPE: SeriesShape = {
  value: ["Data_value", "DATA_VAL", "Estimate", "estimate", "population"],
  period: ["Period", "TIME_REF", "Year", "year", "period", "year_month"],
  seriesRef: ["Series_reference", "SER_REF"],
  status: ["STATUS", "status"],
  unit: ["UNITS"],
  magnitude: ["MAGNITUDE", "MAGNTUDE", "Magnitude"],
  qualifiers: ["SE", "RSE", "LowerCIB", "UpperCIB", "standard_error", "Flag", "Suppressed", "month_of_release"],
  titleColumns: ["Series_title_1", "Series_title_2", "Series_title_3", "Series_title_4", "Series_title_5"],
};

function pick(row: Upstream, names: string[]): { name: string; text: string | null } | null {
  for (const name of names) if (Object.hasOwn(row, name)) return { name, text: str(row[name]) };
  return null;
}

/** Stats NZ period text "2007.05" is year.month; "2024.06" for an annual series is the year ended June. It is kept verbatim. */
function seriesPeriod(text: string | null): { label: string; start: string | null; end: string | null } {
  if (text === null) return { label: "not_stated_in_row", start: null, end: null };
  const point = isoDate(text);
  return { label: text, start: point, end: point };
}

export interface SeriesSourceInfo { title: string; source_url: string; release_vintage: string; retrieved_at: string; source_bytes: number | null; capture_count: number; source_sha256: string | null }

export function mapDedicatedSeries(ctx: MapContext, collector: MetaCollector, u: Upstream, info: SeriesSourceInfo, shape: SeriesShape = SERIES_SHAPE): ObservationRow {
  const datasetKey = must(u.dataset_id, "dataset_id");
  let cells: Upstream;
  try {
    cells = JSON.parse(must(u.row_json, "row_json")) as Upstream;
  } catch {
    throw new ContractError("upstream series row does not hold its publisher columns as JSON");
  }
  const member = must(u.source_file, "source_file");
  const value = pick(cells, shape.value);
  if (!value) throw new ContractError(`no value column recognised in ${member}; the layout needs a reviewed mapping`);
  const period = pick(cells, shape.period);
  const ref = pick(cells, shape.seriesRef);
  const status = pick(cells, shape.status);
  const unit = pick(cells, shape.unit);
  const magnitude = pick(cells, shape.magnitude);
  const role = new Set([value.name, period?.name, ref?.name, status?.name, unit?.name, magnitude?.name, ...shape.qualifiers].filter((n): n is string => Boolean(n)));
  // Whatever is left describes the series: titles, groups, classification codes.
  const describing: { [name: string]: unknown } = {};
  for (const [name, cell] of Object.entries(cells)) {
    if (role.has(name) || name.startsWith("__unnamed")) continue;
    describing[name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z]+/, "c_")] = cell;
  }
  const dimensions = dims({ ...describing, source_member: member, family: u.family_id, observation_kind: u.observation_kind });
  const seriesKey = ref?.text ? ref.text : `${member}|${sha256Text(JSON.stringify(Object.entries(dimensions).sort())).slice(0, 24)}`;
  collector.addDataset(datasetRow(ctx.sourceId, datasetKey, info.title.slice(0, 500), ctx.publisher, ctx.officialUrl, "dedicated_series", ctx.historical,
    "One named release file. Classification codes are the publisher's and are kept as printed; the file carries no code labels."));
  const releaseKey = info.source_sha256 ? `file-${info.source_sha256.slice(0, 16)}` : info.release_vintage;
  collector.addRelease({
    kind: "release", dataset_key: datasetKey, release_key: releaseKey, vintage_label: info.release_vintage.slice(0, 500), released_on: null, released_on_basis: "publisher_label_only",
    source_url: info.source_url, source_file_sha256: info.source_sha256, source_bytes: info.source_bytes, retrieved_at: info.retrieved_at,
    publisher_last_modified: null, boundary_edition: null, capture_count: info.capture_count,
  });
  const titles = shape.titleColumns.map((name) => str(cells[name])).filter((t): t is string => t !== null && t !== "NA");
  const adjustment = str(u.seasonal_adjustment);
  collector.addSeries({
    kind: "series", dataset_key: datasetKey, series_key: seriesKey, title: titles.join(" / ").slice(0, 1000) || null, unit: unit?.text ?? null, magnitude: magnitude?.text ?? null,
    seasonal_adjustment: adjustment, frequency: null, dimensions,
  });

  const raw = value.text;
  const sourceStatus = status?.text ?? null;
  const flag = str(cells.Flag);
  const suppressedCell = str(cells.Suppressed);
  const number = raw !== null ? parseDecimal(raw) : null;
  let valueStatus: ValueStatus;
  let symbol: string | null = null;
  if (number) {
    valueStatus = provisional(sourceStatus) ? "provisional" : "reported";
  } else {
    symbol = raw;
    // The publisher's own flag decides. An empty cell with no flag is an empty cell: missing, nothing more.
    const marker = (sourceStatus ?? "") + "|" + (flag ?? "") + "|" + (suppressedCell ?? "");
    if (/(^|\|)(C|CONFIDENTIAL|CONF)(\||$)/i.test(marker)) valueStatus = "confidential";
    else if (/(^|\|)(S|SUPPRESSED|Y)(\||$)/i.test(marker) && (flag !== null || suppressedCell !== null)) valueStatus = "suppressed";
    else valueStatus = "missing";
  }
  const qualifiers: { [name: string]: unknown } = {};
  for (const name of shape.qualifiers) if (Object.hasOwn(cells, name)) qualifiers[name] = cells[name];
  const p = seriesPeriod(period?.text ?? null);
  const row = observation({
    dataset_key: datasetKey, release_key: releaseKey, series_key: seriesKey, geography: null,
    period_label: p.label, period_start: p.start, period_end: p.end,
    value: number?.value ?? null, value_double: number?.value_double ?? null, raw_value: raw, value_status: valueStatus,
    parse_status: number ? "parsed" : raw === null ? "parsed" : "unparsed_symbol",
    source_status: sourceStatus, source_symbol: symbol, upstream_status: must(u.value_parse_status, "value_parse_status"), qualifiers: dims(qualifiers),
    row_locator: `${member} row ${must(u.source_row_number, "source_row_number")}`,
  });
  collector.claim(row);
  return row;
}

// Catalogue entries ------------------------------------------------------------------------------------------

function attributes(pairs: { [name: string]: unknown }): { [name: string]: Json } {
  const out: { [name: string]: Json } = {};
  for (const [name, value] of Object.entries(pairs)) {
    if (value === null || value === undefined || value === "") continue;
    out[name] = value as Json;
  }
  return out;
}

/**
 * One stored version of a catalogue record. A listing's recorded hash is the hash of the LISTING PAGE, not of the
 * file the entry points at, so it is never presented as the file's hash. `download_sha256` (MSD) is a file hash.
 */
export function mapCatalogueRecord(ctx: MapContext, collector: MetaCollector, record: Upstream, p: Upstream): Omit<CatalogueEntryRow, "kind" | "content_hash" | "observed_first_at" | "observed_last_at" | "observation_count"> {
  const used = new Set(["title", "topic", "url", "format", "source_sha256", "facts_asserted", "catalogue_only", "metadata_modified", "resource_count", "result_set_scope",
    "catalogue_page_date", "catalogue_title", "dataset_id", "download_url", "file_size_label", "raw_path", "available_reviewed_fact_rows", "bounded_by_max_items",
    "complete_workbook_normalization", "download_sha256", "emitted_fact_rows", "excluded_scope", "metadata_only", "notes_sha256", "period_end", "period_start",
    "release_vintage_label", "reviewed_series", "scope"]);
  collector.drop(p, used);
  if (p.facts_asserted === true) throw new ContractError("a catalogue record asserts facts; it does not belong in the catalogue route");
  let kind: EntryKind = "catalogue_link";
  if (Object.hasOwn(p, "download_url") || Object.hasOwn(p, "format")) kind = "file_metadata";
  if (Object.hasOwn(p, "resource_count") || Object.hasOwn(p, "scope")) kind = "dataset_metadata";
  return {
    source_id: ctx.sourceId, entry_key: must(record.record_id, "record_id"), entry_kind: kind, title: must(p.title, "title").slice(0, 1000),
    url: must(p.download_url ?? p.url, "url"), found_on_url: must(record.source_url, "source_url"), format: str(p.format)?.toLowerCase() ?? null,
    file_sha256: sha(p.download_sha256), publisher_modified_text: str(p.metadata_modified) ?? str(p.catalogue_page_date),
    attributes: attributes({
      topic: p.topic, resource_count: p.resource_count, result_set_scope: p.result_set_scope, file_size_label: p.file_size_label, catalogue_title: p.catalogue_title,
      upstream_dataset_key: p.dataset_id, scope: p.scope, excluded_scope: p.excluded_scope, release_vintage_label: p.release_vintage_label, period_start: p.period_start,
      period_end: p.period_end, reviewed_series: p.reviewed_series, available_reviewed_fact_rows: p.available_reviewed_fact_rows, emitted_fact_rows: p.emitted_fact_rows,
      complete_workbook_normalization: p.complete_workbook_normalization,
    }),
  };
}

/** The 2023 Census product finder: an index of products. Product metadata, never observations. */
export function mapCensusProduct(ctx: MapContext, u: Upstream): Omit<CatalogueEntryRow, "kind" | "content_hash" | "observed_first_at" | "observed_last_at" | "observation_count"> {
  return {
    source_id: ctx.sourceId, entry_key: `census-2023-product:${must(u.product_id, "product_id")}`, entry_kind: "product_metadata", title: must(u.title, "title").slice(0, 1000),
    url: must(u.product_url, "product_url"), found_on_url: must(u.source_url, "source_url"), format: null, file_sha256: null, publisher_modified_text: null,
    attributes: attributes({
      platform: u.platform, release_date_text: u.release_date, themes: u.themes, subjects: u.subjects, variables: u.variables, geographic_levels: u.geographic_levels,
      statistical_unit: u.statistical_unit, upstream_dataset_key: u.dataset_id,
    }),
  };
}

/** Collapses stored versions that project to identical content into one entry version with its observation span. */
export function foldCatalogueVersions(versions: { fields: Omit<CatalogueEntryRow, "kind" | "content_hash" | "observed_first_at" | "observed_last_at" | "observation_count">; observedAt: string }[]): CatalogueEntryRow[] {
  const byContent = new Map<string, CatalogueEntryRow>();
  for (const version of versions) {
    const draft = catalogueEntry({ ...version.fields, observed_first_at: version.observedAt, observed_last_at: version.observedAt, observation_count: 1 });
    const key = draft.source_id + "\u0000" + draft.entry_key + "\u0000" + draft.content_hash;
    const existing = byContent.get(key);
    if (!existing) {
      byContent.set(key, draft);
      continue;
    }
    existing.observation_count++;
    if (version.observedAt < existing.observed_first_at) existing.observed_first_at = version.observedAt;
    if (version.observedAt > existing.observed_last_at) existing.observed_last_at = version.observedAt;
  }
  return [...byContent.values()].sort((a, b) => a.entry_key.localeCompare(b.entry_key) || a.observed_first_at.localeCompare(b.observed_first_at) || a.content_hash.localeCompare(b.content_hash));
}
