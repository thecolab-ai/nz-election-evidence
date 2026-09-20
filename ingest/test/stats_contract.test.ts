// Statistics family: contract, mappers and recipe. Offline; no database, no network.
// Every upstream-shaped row below is a SYNTHETIC test input written by hand in the upstream column layout.
// None of it is imported data and none of it describes a real statistic.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contentHashOf, ContractError, observation, parseDecimal, parseStoredDouble, textViolation, upstreamUtc, validateRow,
} from "../src/families/stats/contract.ts";
import {
  foldCatalogueVersions, mapCatalogueRecord, mapCensus, mapDedicatedSeries, type MapContext, mapSelectedSeries, mapTenancy, MetaCollector,
} from "../src/families/stats/mappers.ts";
import { fragmentFile } from "../src/families/stats/registry_fragment.ts";
import { STATS_SOURCES } from "../src/families/stats/routes.ts";
import { assertReadOnly, RECIPES } from "../src/families/stats/upstream.ts";
import { validateSourcesFile } from "../../supabase/functions/_shared/registry.ts";

const ctx: MapContext = { sourceId: "stats_fixture", publisher: "Fixture Statistics Office", officialUrl: "https://fixture.example/stats", historical: false };
const record = { record_id: "fixture:1", source_url: "https://fixture.example/files/fixture.csv", observed_at: "2026-01-02 03:04:05.678" };
const SHA = "ab".repeat(32);

test("decimal text is kept exact and never rounded", () => {
  assert.deepEqual(parseDecimal("841.666666666667"), { value: "841.666666666667", value_double: null });
  assert.deepEqual(parseDecimal("3,378,357"), { value: "3378357", value_double: null });
  assert.deepEqual(parseDecimal("-0.50"), { value: "-0.50", value_double: null });
  assert.deepEqual(parseDecimal("-0.0"), { value: "0.0", value_double: null });
  assert.deepEqual(parseDecimal("007"), { value: "7", value_double: null });
  // More than 12 fractional digits cannot be held exactly in numeric(38,12): carried as a double beside the verbatim text.
  assert.deepEqual(parseDecimal("1.0000000000001"), { value: null, value_double: 1.0000000000001 });
  // Exponent notation printed by a publisher is expanded by moving the point: exact, no float involved.
  assert.deepEqual(parseDecimal("107e3"), { value: "107000", value_double: null });
  assert.deepEqual(parseDecimal("-1.5e-2"), { value: "-0.015", value_double: null });
  assert.deepEqual(parseDecimal("1.250E1"), { value: "12.5", value_double: null });
  for (const symbol of ["..C", "NA", "", "x", "12a", "1,23", "--1", "e3", "1e"]) assert.equal(parseDecimal(symbol), null, symbol);
  assert.deepEqual(parseStoredDouble(7881), { value: "7881", value_double: null });
  assert.deepEqual(parseStoredDouble(-3.2), { value: "-3.2", value_double: null });
  assert.equal(parseStoredDouble(Number.NaN), null);
});

test("a withheld value is null with a status, never zero; a reported value must carry its number", () => {
  const base = {
    dataset_key: "d", release_key: "r", series_key: "s", geography: null, period_label: "2024", period_start: null, period_end: null, value_double: null, raw_value: "..C",
    parse_status: "unparsed_symbol" as const, source_status: null, source_symbol: "..C", upstream_status: "confidentialised", qualifiers: {}, row_locator: "fixture.csv row 2",
  };
  assert.doesNotThrow(() => validateRow(observation({ ...base, value: null, value_status: "confidential" })));
  assert.throws(() => validateRow(observation({ ...base, value: "0", value_status: "confidential" })), /a number exists only for reported or provisional/);
  assert.throws(() => validateRow(observation({ ...base, value: null, value_status: "reported", parse_status: "parsed" })), /a number exists only for reported or provisional/);
  assert.throws(() => validateRow(observation({ ...base, value: "1e3", value_status: "reported", parse_status: "parsed" })), /exact decimal text/);
  // A real published zero is a number and stays one.
  assert.doesNotThrow(() => validateRow(observation({ ...base, raw_value: "0", source_symbol: null, value: "0", value_status: "reported", parse_status: "parsed" })));
});

test("the same publisher cell hashes the same through either route; a different published value does not", () => {
  const cell = {
    dataset_key: "d", release_key: "file-0000000000000000", series_key: "s", geography: { scheme: "x:region", edition: "not_stated_by_source", code: "2" }, period_label: "2005-07",
    period_start: "2005-07-01", period_end: "2005-07-31", value: "717", value_double: null, raw_value: "717", value_status: "reported" as const, parse_status: "parsed" as const,
    source_status: null, source_symbol: null, qualifiers: { source_period_text: "1/07/2005" },
  };
  const backfill = observation({ ...cell, upstream_status: "reported", row_locator: "record 4544 column ClosedBonds" });
  const fresh = observation({ ...cell, upstream_status: "fresh_fetch", row_locator: "fixture.csv row 4544 column ClosedBonds" });
  assert.equal(backfill.content_hash, fresh.content_hash);
  assert.notEqual(backfill.content_hash, observation({ ...cell, value: "718", raw_value: "718", upstream_status: "reported", row_locator: "record 4544 column ClosedBonds" }).content_hash);
  assert.notEqual(backfill.content_hash, observation({ ...cell, source_status: "REVISED", upstream_status: "reported", row_locator: "record 4544 column ClosedBonds" }).content_hash);
});

test("rows outside the contract are refused: unknown keys, contact text, locations on a disk, credential-bearing links", () => {
  const good = observation({
    dataset_key: "d", release_key: "r", series_key: "s", geography: null, period_label: "2024", period_start: null, period_end: null, value: "1", value_double: null, raw_value: "1",
    value_status: "reported", parse_status: "parsed", source_status: "FINAL", source_symbol: null, upstream_status: "reported", qualifiers: {}, row_locator: "fixture.csv row 2",
  });
  assert.throws(() => validateRow({ ...good, row_json: "{}" }), /exactly the contract's keys/);
  assert.throws(() => validateRow({ ...good, row_locator: "see fixture.person@fixture.example" }), /never stored/);
  assert.equal(textViolation("kept at /" + "home/someone/file.csv"), "filesystem_location_value");
  const release = {
    kind: "release", dataset_key: "d", release_key: "r", vintage_label: "June 2026", released_on: null, released_on_basis: "publisher_label_only", source_url: "https://fixture.example/f.csv?token=abc",
    source_file_sha256: SHA, source_bytes: 10, retrieved_at: "2026-01-02T03:04:05Z", publisher_last_modified: null, boundary_edition: null, capture_count: 1,
  };
  assert.throws(() => validateRow(release), /credential-like/);
  // A collection time can never stand in for a release date: a date needs the publisher-stated basis.
  assert.throws(() => validateRow({ ...release, source_url: "https://fixture.example/f.csv", released_on: "2026-01-02" }), /only from a publisher-stated date/);
  assert.doesNotThrow(() => validateRow({ ...release, source_url: "https://fixture.example/f.csv", released_on: "2026-01-02", released_on_basis: "publisher_stated_date" }));
});

test("content hash ignores collection times, so a re-collection of unchanged content hashes the same", () => {
  const a = contentHashOf({ entry_key: "e", title: "t", observed_first_at: "2026-01-01T00:00:00Z", observed_last_at: "2026-01-01T00:00:00Z", observation_count: 1 });
  const b = contentHashOf({ entry_key: "e", title: "t", observed_first_at: "2026-02-01T00:00:00Z", observed_last_at: "2026-03-01T00:00:00Z", observation_count: 5 });
  assert.equal(a, b);
  assert.notEqual(a, contentHashOf({ entry_key: "e", title: "t2" }));
  assert.equal(upstreamUtc("2026-09-16 03:44:43.138"), "2026-09-16T03:44:43.138Z");
  assert.throws(() => upstreamUtc("16/09/2026"), ContractError);
});

function seriesPayload(overrides: { [key: string]: unknown } = {}): { [key: string]: unknown } {
  return {
    adjustment: "not_seasonally_adjusted_or_not_applicable", dataset: "fixture_dataset_csv", edition: "2026-06", frequency: "monthly", geography_code: "NZ", geography_label: "New Zealand",
    geography_level: "national", measure: "fixture_series", reference_period: "2024-02", series_group: "Fixture group", series_id: "FIX.S1", series_title_1: "Fixture item", series_title_2: "NA",
    series_title_3: "NA", source_page_url: "https://fixture.example/listing/", source_record_number: 12, source_sha256: SHA, source_status: "FINAL", topic: "fixture", unit: "dollars",
    value_decimal: "2.31", value_raw: "2.31", value_status: "reported", ...overrides,
  };
}

test("operational series: unit, period, geography, vintage and publisher status survive; collected-at is not a release date", () => {
  const collector = new MetaCollector();
  const row = mapSelectedSeries(ctx, collector, record, seriesPayload());
  validateRow(row);
  assert.equal(row.value, "2.31");
  assert.equal(row.period_label, "2024-02");
  assert.deepEqual([row.period_start, row.period_end], ["2024-02-01", "2024-02-29"]);
  assert.deepEqual(row.geography, { scheme: "stats_fixture:national", edition: "not_stated_by_source", code: "NZ" });
  const release = [...collector.releases.values()][0];
  validateRow(release);
  assert.equal(release.released_on, null);
  assert.equal(release.released_on_basis, "publisher_label_only");
  assert.equal(release.retrieved_at, "2026-01-02T03:04:05.678Z");
  assert.equal(release.source_file_sha256, SHA);
  const series = [...collector.series.values()][0];
  assert.equal(series.unit, "dollars");
  assert.equal(series.title, "Fixture item");

  const provisional = mapSelectedSeries(ctx, collector, record, seriesPayload({ reference_period: "2024-03", source_status: "P" }));
  assert.equal(provisional.value_status, "provisional");
  const missing = mapSelectedSeries(ctx, collector, record, seriesPayload({ reference_period: "2024-04", value_decimal: null, value_raw: "..", value_status: "not_available" }));
  assert.deepEqual([missing.value, missing.value_status, missing.source_symbol, missing.parse_status], [null, "missing", "..", "unparsed_symbol"]);
});

test("mapping refuses instead of smoothing over: unknown status, number under a withheld status, two rows of one identity, a key with two definitions", () => {
  const collector = new MetaCollector();
  mapSelectedSeries(ctx, collector, record, seriesPayload());
  assert.throws(() => mapSelectedSeries(ctx, collector, record, seriesPayload()), /share one observation identity/);
  assert.throws(() => mapSelectedSeries(ctx, collector, record, seriesPayload({ reference_period: "2024-05", value_status: "estimated_by_us" })), /outside the documented vocabulary/);
  assert.throws(() => mapSelectedSeries(ctx, collector, record, seriesPayload({ reference_period: "2024-06", value_status: "not_available" })), /arrived with a number/);
  assert.throws(() => mapSelectedSeries(ctx, collector, record, seriesPayload({ reference_period: "2024-07", value_decimal: null, value_raw: null })), /without a parseable number/);
  assert.throws(() => mapSelectedSeries(ctx, collector, record, seriesPayload({ reference_period: "2024-08", unit: "index" })), /not a function of its definition/);
});

test("keys outside a mapper's allowlist are dropped and counted by name", () => {
  const collector = new MetaCollector();
  mapSelectedSeries(ctx, collector, record, seriesPayload({ internal_note: "x", contact: "y" }));
  assert.deepEqual([...collector.dropped].sort(), [["contact", 1], ["internal_note", 1]]);
});

test("tenancy: the file hash names the release and the Last-Modified header is kept verbatim, apart from collected-at", () => {
  const collector = new MetaCollector();
  const row = mapTenancy(ctx, collector, record, {
    adjustment: "not_stated", extractor_version: "v", frequency: "monthly", geography_code: "-99", geography_label: "ALL", geography_level: "region", measure: "MedianRent",
    population: "fixture", quality_context: "fixture", reference_period: "2005-07", rent_basis: "fixture", source_column: "MedianRent", source_last_modified: "Wed, 01 Jan 2026 00:00:00 GMT",
    source_page_url: "https://fixture.example/page/", source_period_raw: "1/07/2005", source_record_number: 4, source_sha256: SHA, statistic: "median", stock_flow: "flow", topic: "fixture",
    unit: "NZD/week", value_decimal: "250", value_raw: "250", value_status: "reported",
  });
  validateRow(row);
  assert.equal(row.release_key, `file-${SHA.slice(0, 16)}`);
  assert.equal(row.qualifiers.source_period_text, "1/07/2005");
  const release = [...collector.releases.values()][0];
  assert.equal(release.publisher_last_modified, "Wed, 01 Jan 2026 00:00:00 GMT");
  assert.equal(release.released_on, null);
  assert.equal(release.released_on_basis, "not_stated");
});

test("census: confidential, not-available, not-applicable and flag markers stay null; a stored double becomes exact text", () => {
  const collector = new MetaCollector();
  const base = {
    dataset_id: "fixture.census", census_year: 2023, geography_level: "territorial_authority", geography_code: "", geography_name: "Fixture district", subject: "fixture subject", measure: "count",
    category_code: "c1", category_label: "Category one", category_dimension: "dim", unit: "count", release_vintage: "2024-05-29", boundary_edition: "Fixture boundaries 2023",
    source_url: "https://fixture.example/census.xlsx", source_sha256: SHA, source_file: "Table 1", source_row: 7, source_symbol: "",
  };
  const info = { title: "Fixture census", coverage_note: null, source_bytes: null, retrieved_at: null, capture_count: 1 };
  const reported = mapCensus(ctx, collector, "operational", { ...base, value: 7881, value_status: "observed" }, "2026-01-02T00:00:00Z", info, "");
  assert.deepEqual([reported.value, reported.value_status, reported.raw_value], ["7881", "reported", null]);
  // No publisher code in the file: the name is the code, and the row says so.
  assert.equal([...collector.geographies.values()][0].code_basis, "publisher_name_only");
  const release = [...collector.releases.values()][0];
  assert.deepEqual([release.released_on, release.released_on_basis], ["2024-05-29", "publisher_stated_date"]);
  const cases: [string, string, string][] = [["confidentialised", "..C", "confidential"], ["not_available", "..", "missing"], ["not_applicable", "-", "not_applicable"], ["outside_tolerance", "x", "flag_marker"]];
  for (const [index, [upstream, symbol, expected]] of cases.entries()) {
    const row = mapCensus(ctx, collector, "operational", { ...base, category_code: `w${index}`, value: null, value_status: upstream, source_symbol: symbol }, "2026-01-02T00:00:00Z", info, "");
    validateRow(row);
    assert.deepEqual([row.value, row.value_double, row.value_status, row.source_symbol], [null, null, expected, symbol]);
  }
  assert.throws(() => mapCensus(ctx, collector, "operational", { ...base, category_code: "w9", value: 0, value_status: "confidentialised", source_symbol: "..C" }, "2026-01-02T00:00:00Z", info, ""), /arrived with a number/);
});

test("dedicated series: the publisher's own columns are read, including the alias layout the upstream normaliser missed", () => {
  const collector = new MetaCollector();
  const info = { title: "Fixture release – CSV", source_url: "https://fixture.example/release.csv", release_vintage: "Fixture release: September 2023 – CSV", retrieved_at: "2026-01-02T00:00:00Z", source_bytes: 100, capture_count: 2, source_sha256: SHA };
  const upstream = (cells: object, row: number, status = "numeric") => ({
    dataset_id: "fixture.file.1", family_id: "fixture", source_file: "fixture.csv", source_row_number: row, observation_kind: "index", value_parse_status: status, seasonal_adjustment: "not_stated", row_json: JSON.stringify(cells),
  });
  const alias = mapDedicatedSeries(ctx, collector, upstream({ DATA_VAL: "1029", Group: "Fixture group", SER_REF: "FIX.A1", STATUS: "FINAL", Series_title_1: "Fixture region", Subject: "FIX", TIME_REF: "2007.05", UNITS: "Index" }, 2, "missing"), info);
  validateRow(alias);
  assert.deepEqual([alias.series_key, alias.period_label, alias.value, alias.value_status, alias.upstream_status], ["FIX.A1", "2007.05", "1029", "reported", "missing"]);
  const confidential = mapDedicatedSeries(ctx, collector, upstream({ Data_value: "", Series_reference: "FIX.A2", Period: "2007.05", STATUS: "CONFIDENTIAL", UNITS: "Dollars", MAGNITUDE: "6" }, 3, "suppressed"), info);
  assert.deepEqual([confidential.value, confidential.value_status], [null, "confidential"]);
  assert.equal([...collector.series.values()].find((s) => s.series_key === "FIX.A2")?.magnitude, "6");
  const flagged = mapDedicatedSeries(ctx, collector, upstream({ Estimate: " ", Flag: "S", MsCode: "M1", Year: "2024", SE: " " }, 4, "missing"), info);
  assert.deepEqual([flagged.value, flagged.value_status, flagged.qualifiers.Flag], [null, "suppressed", "S"]);
  const empty = mapDedicatedSeries(ctx, collector, upstream({ Estimate: "", Flag: "", MsCode: "M2", Year: "2024" }, 5, "missing"), info);
  assert.equal(empty.value_status, "missing");
  const withBounds = mapDedicatedSeries(ctx, collector, upstream({ Estimate: "39.3", Flag: " ", MsCode: "M3", Year: "2024", SE: "1.2", LowerCIB: "38.1", UpperCIB: "40.4" }, 6), info);
  assert.deepEqual(withBounds.qualifiers, { SE: "1.2", LowerCIB: "38.1", UpperCIB: "40.4" });
  assert.throws(() => mapDedicatedSeries(ctx, collector, upstream({ Amount: "1", When: "2024" }, 7), info), /no value column recognised/);
  assert.equal([...collector.releases.values()][0].capture_count, 2);
});

test("catalogue: a listing's page hash is never presented as a file hash; identical re-collections fold into one version", () => {
  const collector = new MetaCollector();
  const listing = mapCatalogueRecord(ctx, collector, { record_id: "fixture:c1", source_url: "https://fixture.example/listing/" },
    { title: "Fixture file – CSV", download_url: "https://fixture.example/files/a.csv", format: "CSV", source_sha256: SHA, facts_asserted: false, catalogue_page_date: "2025-01-17 10:45:00", catalogue_title: "Fixture listing", dataset_id: "abc", file_size_label: "", raw_path: "raw/x.html" });
  assert.equal(listing.file_sha256, null);
  assert.equal(listing.entry_kind, "file_metadata");
  assert.equal(listing.format, "csv");
  assert.equal(listing.publisher_modified_text, "2025-01-17 10:45:00");
  const reviewed = mapCatalogueRecord(ctx, collector, { record_id: "fixture:c2", source_url: "https://fixture.example/listing/" },
    { title: "Fixture workbook", url: "https://fixture.example/files/b.xlsx", topic: "fixture", scope: "fixture scope", download_sha256: SHA, metadata_only: true });
  assert.equal(reviewed.file_sha256, SHA);
  assert.equal(reviewed.entry_kind, "dataset_metadata");
  assert.throws(() => mapCatalogueRecord(ctx, collector, { record_id: "fixture:c3", source_url: "https://fixture.example/listing/" }, { title: "t", url: "https://fixture.example/x", facts_asserted: true }), /asserts facts/);

  const folded = foldCatalogueVersions([
    { fields: listing, observedAt: "2026-01-03T00:00:00Z" }, { fields: listing, observedAt: "2026-01-01T00:00:00Z" }, { fields: listing, observedAt: "2026-01-02T00:00:00Z" },
    { fields: { ...listing, title: "Fixture file – CSV (renamed)" }, observedAt: "2026-01-04T00:00:00Z" },
  ]);
  assert.equal(folded.length, 2);
  for (const entry of folded) validateRow(entry);
  const first = folded.find((f) => f.title === "Fixture file – CSV")!;
  assert.deepEqual([first.observed_first_at, first.observed_last_at, first.observation_count], ["2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z", 3]);
});

test("the export recipe is read-only by construction and never names a stored original or a location on a disk", () => {
  const statements = [RECIPES.operationalFacts("x"), RECIPES.operationalCatalogue("x"), RECIPES.operationalCounts("x"), RECIPES.censusSources(), RECIPES.censusObservations("a.b"), RECIPES.censusCounts(),
    RECIPES.censusProducts(), RECIPES.seriesSources(), RECIPES.seriesObservations("a.b", "00000000-0000-0000-0000-000000000000"), RECIPES.seriesCounts()];
  for (const sql of statements) assert.doesNotThrow(() => assertReadOnly(sql));
  for (const bad of ["INSERT INTO t SELECT 1 FORMAT JSONEachRow", "SELECT 1; DROP TABLE t FORMAT JSONEachRow", "SELECT raw_record_json FROM t FORMAT JSONEachRow", "SELECT archive_path FROM t FORMAT JSONEachRow",
    "SELECT 1 FROM t", "ALTER TABLE t DELETE WHERE 1 FORMAT JSONEachRow", "SELECT 1 FROM t INTO OUTFILE 'x' FORMAT JSONEachRow"]) {
    assert.throws(() => assertReadOnly(bad), ContractError, bad);
  }
  assert.throws(() => RECIPES.operationalFacts("x' OR 1=1 --"), /plain identifier/);
});

test("the registry fragment validates, covers the family's eight products, and enables nothing", () => {
  const file = fragmentFile();
  assert.deepEqual(validateSourcesFile(file), []);
  const products = new Set(file.sources.flatMap((s) => (s.catalogue_products ?? []).map((p) => p.product_id)));
  assert.deepEqual([...products].sort(), ["P11", "P12", "P18", "P19", "P20", "P21", "P22", "P23"]);
  assert.ok(file.sources.every((s) => s.enabled === false && s.rights_id && s.blocked_reason));
  assert.equal(file.schedules.length, 0);
  // P18 and P20 are catalogue only: they can never gain an observation route by accident.
  for (const id of ["stats_rbnz_catalogue", "stats_nz_csv_catalogue"]) assert.equal(STATS_SOURCES.find((s) => s.source_id === id)?.route, "catalogue_only");
  // The overlapping operational copy of the 2018 file is named as an overlap, never as a second import.
  const census2018 = STATS_SOURCES.find((s) => s.source_id === "stats_nz_census_2018_highlights")!;
  assert.equal(census2018.route, "dedicated_census");
  assert.equal(census2018.upstream.overlap?.route, "operational");
  assert.equal(census2018.upstream.operational_source, undefined);
});
