// Statistics family, incremental route: the pure parsers and the fetch-to-artifact run.
//
// Every input here is a SYNTHETIC, hand-written sample in the publisher's column or markup layout
// (test/fixtures/stats/*.synthetic.*, and the inline strings below). Series references, locations, titles and
// numbers are invented. None of it is publisher data, none of it is evidence, and no test contacts a publisher:
// the transport is always an injected double.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openArtifact, readObservations } from "../src/families/stats/artifact.ts";
import { ContractError, type ObservationRow, validateRow } from "../src/families/stats/contract.ts";
import { fetchSource, fileIdentity, FRESH_ROOT_SUFFIX, LIVE_URLS } from "../src/families/stats/live.ts";
import {
  type FileContext, listingEntries, parseCkanPackages, parseCsv, parseEmbeddedDocuments, parseLinkListing, parseStatsNzSeriesCsv,
  parseTenancyRegionCsv, pickSelectedPriceIndexes, SELECTED_PRICE_INDEXES_DATASET, TENANCY_DATASET,
} from "../src/families/stats/live_parsers.ts";
import { foldCatalogueVersions, type MapContext, mapSelectedSeries, mapTenancy, MetaCollector } from "../src/families/stats/mappers.ts";
import { planFor } from "../src/families/stats/routes.ts";

const fixtureText = async (name: string) => readFile(new URL("./fixtures/stats/" + name, import.meta.url), "utf-8");
/** CSV fixtures open with `# TEST FIXTURE` lines, which no publisher file has; they are removed before parsing. */
const fixtureCsv = async (name: string) => (await fixtureText(name)).split("\n").filter((line) => !line.startsWith("# ")).join("\n");

const AT = "2031-09-01T00:00:00.000Z";
const STATS_PAGE = LIVE_URLS.stats_nz_selected_series;
const SPI_URL = "https://www.stats.govt.nz/assets/Uploads/Selected-price-indexes/Selected-price-indexes-August-2031/Download-data/selected-price-indexes-august-2031.csv";
const TENANCY_PAGE = LIVE_URLS.stats_tenancy_rental_bonds;
const REGION_URL = "https://www.tenancy.govt.nz/assets/Uploads/Tenancy/Rental-bond-data/detailed-monthly-region-tenancy-fixture.csv?m=bbbb2222";

function context(sourceId: string, pageUrl: string, fileUrl: string): FileContext {
  return {
    sourceId, publisher: "Fixture publisher", officialUrl: pageUrl, sourceUrl: fileUrl, vintageLabel: "Fixture link text", releaseKey: "file-0123456789abcdef",
    fileSha256: "0123456789abcdef".repeat(4), sourceBytes: 100, retrievedAt: AT,
  };
}

const identity = (row: ObservationRow) => [row.dataset_key, row.series_key, row.geography?.scheme ?? null, row.geography?.edition ?? null, row.geography?.code ?? null, row.period_label, row.period_start, row.period_end];

// CSV ---------------------------------------------------------------------------------------------------------

test("parseCsv: quoted fields, embedded commas, quotes and line breaks, CRLF, byte order mark", () => {
  const text = "\uFEFFa,b,c\r\n\"x, y\",\"say \"\"hi\"\"\",\"line\r\nbreak\"\r\n,,\r\nlast,1,2";
  assert.deepEqual(parseCsv(text), [["a", "b", "c"], ["x, y", 'say "hi"', "line\r\nbreak"], ["", "", ""], ["last", "1", "2"]]);
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]], "no empty record after the final line break");
  assert.deepEqual(parseCsv("a\n\nb\n"), [["a"], [""], ["b"]], "a blank line keeps its place so row numbers stay the publisher's");
  assert.deepEqual(parseCsv("a,\"\"\n"), [["a", ""]]);
  assert.deepEqual(parseCsv(""), []);
  assert.throws(() => parseCsv("a,\"unterminated\n1,2"), ContractError);
});

// Catalogue parsers -------------------------------------------------------------------------------------------

test("CKAN result set: dataset metadata entries under their own key space; an empty or failed answer is a fault", async () => {
  const url = LIVE_URLS.stats_rbnz_catalogue;
  const versions = parseCkanPackages(await fixtureText("ckan-package-search.synthetic.json"), "stats_rbnz_catalogue", url, AT);
  assert.equal(versions.length, 3);
  assert.deepEqual(versions[0].fields, {
    source_id: "stats_rbnz_catalogue", entry_key: "ckan:fixture-interest-rates", entry_kind: "dataset_metadata", title: "Fixture interest rates",
    url: "https://catalogue.data.govt.nz/dataset/fixture-interest-rates", found_on_url: url, format: null, file_sha256: null, publisher_modified_text: "2020-01-02T03:04:05.000001",
    attributes: { topic: "finance_and_economy", resource_count: 3, result_set_scope: { available_results: 3, emitted_results: 3, completion: "complete_current_ckan_result_set" } },
  });
  assert.equal(versions[1].fields.attributes.resource_count, 2, "falls back to the length of the resource list");
  assert.equal(versions[2].fields.title, "fixture_untitled");
  assert.equal(versions[2].fields.publisher_modified_text, null);
  assert.ok(!JSON.stringify(versions).includes("never-read"), "fields outside the allowlist are dropped");
  for (const entry of foldCatalogueVersions(versions)) validateRow(entry);

  const partial = parseCkanPackages(JSON.stringify({ success: true, result: { count: 40, results: [{ name: "fixture-a", title: "A" }] } }), "stats_rbnz_catalogue", url, AT);
  assert.deepEqual(partial[0].fields.attributes.result_set_scope, { available_results: 40, emitted_results: 1, completion: "partial_result_set" });
  assert.throws(() => parseCkanPackages(JSON.stringify({ success: false }), "stats_rbnz_catalogue", url, AT), ContractError);
  assert.throws(() => parseCkanPackages(JSON.stringify({ success: true, result: { count: 0, results: [] } }), "stats_rbnz_catalogue", url, AT), /empty answer is a fault/);
  assert.throws(() => parseCkanPackages(JSON.stringify({ success: true, result: { count: 1, results: "x" } }), "stats_rbnz_catalogue", url, AT), ContractError);
  assert.throws(() => parseCkanPackages("<html>not json</html>", "stats_rbnz_catalogue", url, AT), ContractError);
  assert.throws(() => parseCkanPackages(JSON.stringify({ success: true, result: { count: 1, results: [{ name: "../x" }] } }), "stats_rbnz_catalogue", url, AT), ContractError);
});

test("link listing: relative links resolved, other hosts and non-matching paths left out, de-duplicated, query kept", async () => {
  const listing = parseLinkListing(await fixtureText("tenancy-rental-bond-page.synthetic.html"), TENANCY_PAGE, { hosts: ["www.tenancy.govt.nz"], include: /\.(csv|zip|xlsx)$/i });
  assert.equal(listing.refused, 0);
  assert.deepEqual(listing.links.map((l) => l.url), [
    "https://www.tenancy.govt.nz/assets/Uploads/Tenancy/Rental-bond-data/detailed-monthly-tla-tenancy-fixture.csv?m=aaaa1111",
    REGION_URL,
    "https://www.tenancy.govt.nz/assets/Uploads/Tenancy/Rental-bond-data/detailed-quarterly-fixture.zip?m=cccc3333",
  ]);
  assert.equal(listing.links[1].text, "By region, February 1993 to July 2031 [CSV, 1 KB]", "first link text wins; markup inside the link is cleaned");
  const entries = foldCatalogueVersions(listingEntries(listing.links, {
    sourceId: "stats_tenancy_rental_bonds", foundOnUrl: TENANCY_PAGE, entryKind: "catalogue_link", withFormat: false, attributes: { topic: "housing_affordability" }, publisherModifiedText: null, observedAt: AT,
  }));
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    validateRow(entry);
    assert.match(entry.entry_key, /^listing:[0-9a-f]{24}$/);
    assert.equal(entry.file_sha256, null, "a listing never yields a file hash");
    assert.equal(entry.format, null);
    assert.deepEqual([entry.observed_first_at, entry.observed_last_at, entry.observation_count], [AT, AT, 1]);
  }
});

test("link listing: credential-like addresses and contact-like link text are never stored, and are counted", () => {
  const page = "https://www.msd.govt.nz/about-msd-and-our-work/publications-resources/statistics/benefit/index.html";
  const html = `<!-- TEST FIXTURE: synthetic -->
    <a href="archive-2030.html">2030 Fixture archive</a>
    <a href='/documents/about-msd-and-our-work/publications-resources/statistics/benefit/2031/fixture-tables.xlsx'>National fixture tables &amp; notes (Excel 9KB)</a>
    <a href="/about-msd-and-our-work/publications-resources/statistics/benefit/secret.html?token=abc">Tokened</a>
    <a href="/about-msd-and-our-work/publications-resources/statistics/benefit/who.html">Ask fixture.person@fixture.example</a>
    <a href="index.html">This page</a> <a href="#top">Top</a> <a href="http://www.msd.govt.nz/about-msd-and-our-work/publications-resources/statistics/benefit/plain-http.html">not https</a>
    <a href="/about-msd-and-our-work/newsroom/">Elsewhere on the site</a>`;
  const listing = parseLinkListing(html, page, { hosts: ["www.msd.govt.nz"], include: /^(\/documents)?\/about-msd-and-our-work\/publications-resources\/statistics\/benefit\/[^/]/ });
  assert.deepEqual(listing.links.map((l) => [new URL(l.url).pathname.split("/").pop(), l.text]), [
    ["archive-2030.html", "2030 Fixture archive"], ["fixture-tables.xlsx", "National fixture tables & notes (Excel 9KB)"], ["who.html", "who.html"],
  ]);
  assert.equal(listing.refused, 2, "the tokened address and the contact-like link text");
  assert.ok(!JSON.stringify(listing).includes("fixture.person"));
});

test("embedded document listing: the page's own JSON file list, its page date, and the newest price index file by stated month", async () => {
  const html = await fixtureText("statsnz-csv-listing.synthetic.html");
  const opts = { hosts: ["www.stats.govt.nz"], include: /\.(csv|zip)$/i };
  const listing = parseEmbeddedDocuments(html, STATS_PAGE, opts);
  assert.equal(listing.pageDateText, "2025-01-17 10:45:00");
  assert.deepEqual(listing.links.map((l) => l.url.split("/").pop()), ["fixture-text-block-file.zip", "selected-price-indexes-april-2031.csv", "selected-price-indexes-august-2031.csv", "Fixture-Survey-2030.ZIP"]);
  assert.equal(listing.links[2].text, "Selected price indexes: August 2031 – CSV");
  assert.equal(parseLinkListing(html, STATS_PAGE, opts).links.length, 0, "the page prints no plain anchors for its files");
  const entries = foldCatalogueVersions(listingEntries(listing.links, {
    sourceId: "stats_nz_csv_catalogue", foundOnUrl: STATS_PAGE, entryKind: "file_metadata", withFormat: true, attributes: { catalogue_title: "CSV files for download" }, publisherModifiedText: listing.pageDateText, observedAt: AT,
  }));
  for (const entry of entries) validateRow(entry);
  assert.deepEqual(entries.map((e) => e.format).sort(), ["csv", "csv", "zip", "zip"]);

  const pick = pickSelectedPriceIndexes(listing.links);
  assert.equal(pick?.link.url, SPI_URL, "August 2031 is newer than April 2031 although April is listed first");
  assert.equal(pick?.basis, "month_and_year_in_link_text");
  assert.equal(pickSelectedPriceIndexes([{ url: "https://www.stats.govt.nz/a/other.csv", text: "Other" }]), null);
  const undated = pickSelectedPriceIndexes([{ url: "https://www.stats.govt.nz/a/selected-price-indexes-one.csv", text: "One" }, { url: "https://www.stats.govt.nz/a/selected-price-indexes-two.csv", text: "Two" }]);
  assert.deepEqual([undated?.link.text, undated?.basis], ["One", "listing_order"]);
});

// Observation parsers -----------------------------------------------------------------------------------------

test("selected price indexes: values, statuses, withheld cells, period form, geography and reconciliation", async () => {
  const parsed = parseStatsNzSeriesCsv(await fixtureCsv("selected-price-indexes.synthetic.csv"), context("stats_nz_selected_series", STATS_PAGE, SPI_URL));
  for (const row of parsed.observations) validateRow(row);
  const meta = [...parsed.collector.datasets.values(), ...parsed.collector.releases.values(), ...parsed.collector.series.values(), ...parsed.collector.geographies.values()];
  for (const row of meta) validateRow(row);
  assert.deepEqual(parsed.reconciliation, {
    what: "publisher file data rows -> observations", upstream_rows: 9, artifact_rows: 8, difference: -1, explanation: "not written, counted by reason: 1 rows without a period",
  });
  const by = (series: string, period: string) => parsed.observations.find((o) => o.series_key === series && o.period_label === period)!;

  const reported = by("FIXM.SE901", "2031-07");
  assert.deepEqual(
    [reported.value, reported.raw_value, reported.value_status, reported.parse_status, reported.source_status, reported.source_symbol, reported.upstream_status, reported.row_locator],
    ["1012.5", "1012.5", "reported", "parsed", "FINAL", null, "fresh_fetch", "selected-price-indexes-august-2031.csv row 2"],
  );
  assert.deepEqual([reported.period_start, reported.period_end, reported.qualifiers], ["2031-07-01", "2031-07-31", { source_period_text: "2031.07" }]);
  assert.deepEqual(reported.geography, { scheme: "stats_nz_selected_series:national", edition: "not_stated_by_source", code: "NZ" });
  assert.equal(by("FIXM.SE901", "2031-08").value_status, "provisional");
  assert.deepEqual([by("FIXM.SAP01", "2031-07").value, by("FIXM.SAP01", "2031-07").raw_value], ["4.70", "4.70"], "exact decimal text, never a float");

  const na = by("FIXM.SAP01", "2031-08");
  assert.deepEqual([na.value, na.value_double, na.raw_value, na.value_status, na.parse_status, na.source_symbol], [null, null, "NA", "missing", "unparsed_symbol", "NA"]);
  const blank = by("FIXM.SAP02", "2031-08");
  assert.deepEqual([blank.value, blank.raw_value, blank.value_status, blank.parse_status, blank.source_status, blank.source_symbol], [null, null, "confidential", "parsed", "C", null]);
  assert.deepEqual([by("FIXM.SAP03", "2031-08").value_status, by("FIXM.SAP03", "2031-08").source_symbol], ["suppressed", ".."]);
  const zero = by("FIXQ.SE9", "2031-06");
  assert.deepEqual([zero.value, zero.value_status, zero.period_start], ["0", "reported", null], "a published zero is a number; a non-monthly series gets no month bounds");
  assert.equal(by("FIXM.SE1041", "2031-08").geography, null, "a sub-national group is not labelled national");

  const series = parsed.collector.series.get(SELECTED_PRICE_INDEXES_DATASET + "\u0000FIXM.SAP01")!;
  assert.deepEqual([series.title, series.unit, series.magnitude, series.frequency], ['Oranges, 1kg / Fresh, "loose"', "Dollars", null, "monthly"]);
  assert.deepEqual(series.dimensions, { series_group: "Fixture Selected Monthly Weighted Average Prices for New Zealand", subject: "Fixture Price Index - FPI" });
  const release = [...parsed.collector.releases.values()][0];
  assert.deepEqual([release.release_key, release.vintage_label, release.released_on, release.released_on_basis, release.publisher_last_modified, release.retrieved_at, release.capture_count],
    ["file-0123456789abcdef", "Fixture link text", null, "publisher_label_only", null, AT, 1]);
  assert.ok(parsed.findings.some((f) => /refuses a conflicting series definition/.test(f)));
  assert.ok(parsed.findings.some((f) => /carry no geography/.test(f) && /Broad Regions/.test(f)));
});

test("selected price indexes: column aliases in any order are read; a missing key column or a changed period form is a fault", () => {
  const aliased = "MAGNTUDE,DATA_VAL,TIME_REF,SER_REF,Extra\n6,12.5,2031.03,FIXM.A1,x\n";
  const parsed = parseStatsNzSeriesCsv(aliased, context("stats_nz_selected_series", STATS_PAGE, SPI_URL));
  assert.deepEqual([parsed.observations[0].series_key, parsed.observations[0].period_label, parsed.observations[0].value, parsed.observations[0].source_status], ["FIXM.A1", "2031-03", "12.5", null]);
  assert.equal([...parsed.collector.series.values()][0].magnitude, "6");
  assert.ok(parsed.findings.some((f) => f.includes("not read: Extra")));
  const ctx = context("stats_nz_selected_series", STATS_PAGE, SPI_URL);
  assert.throws(() => parseStatsNzSeriesCsv("Series_reference,Period,Amount\nFIXM.A1,2031.03,1\n", ctx), /layout needs a human look/);
  assert.throws(() => parseStatsNzSeriesCsv("Series_reference,Period,Data_value\nFIXM.A1,March 2031,1\n", ctx), /YYYY\.MM/);
  assert.throws(() => parseStatsNzSeriesCsv("Series_reference,Period,Data_value\nFIXM.A1,2031.03\n", ctx), /number of cells/);
  assert.throws(() => parseStatsNzSeriesCsv("Series_reference,Period,Data_value\n", ctx), /fault, not an empty source/);
  assert.throws(() => parseStatsNzSeriesCsv("Series_reference,Period,Data_value\nFIXM.A1,2031.03,1\nFIXM.A1,2031.03,2\n", ctx), /share one observation identity/);
  assert.throws(() => parseStatsNzSeriesCsv("Series_reference,Period,Data_value,UNITS\nFIXM.A1,2031.03,1,Index\nFIXM.A1,2031.04,2,Dollars\n", ctx), /series key is not a function of its definition/);
});

test("selected price indexes: a fresh row has the identity the backfill mapper gives the same datum", () => {
  const ctx: MapContext = { sourceId: "stats_nz_selected_series", publisher: "Fixture publisher", officialUrl: STATS_PAGE, historical: false };
  const backfilled = mapSelectedSeries(ctx, new MetaCollector(), { source_url: SPI_URL, observed_at: "2031-09-01 00:00:00" }, {
    dataset: SELECTED_PRICE_INDEXES_DATASET, edition: "2031-08", series_id: "FIXM.SE901", frequency: "monthly", reference_period: "2031-07", geography_level: "national",
    geography_code: "NZ", geography_label: "New Zealand", value_status: "reported", value_decimal: "1012.5", value_raw: "1012.5", source_status: "FINAL", source_record_number: 1, unit: "index",
  });
  const fresh = parseStatsNzSeriesCsv("Series_reference,Period,Data_value,STATUS,UNITS,Group\nFIXM.SE901,2031.07,1012.5,FINAL,Index,Fixture Index for New Zealand\n", context("stats_nz_selected_series", STATS_PAGE, SPI_URL)).observations[0];
  assert.deepEqual(identity(fresh), identity(backfilled));
  assert.deepEqual([fresh.value, fresh.value_status, fresh.source_status], [backfilled.value, backfilled.value_status, backfilled.source_status]);
  assert.notEqual(fresh.release_key, backfilled.release_key, "only the release vintage differs");
});

test("rental bonds by region: one observation per measure cell; a blank cell is suppressed, never zero", async () => {
  const parsed = parseTenancyRegionCsv(await fixtureCsv("tenancy-detailed-monthly-region.synthetic.csv"), context("stats_tenancy_rental_bonds", TENANCY_PAGE, REGION_URL));
  for (const row of parsed.observations) validateRow(row);
  for (const row of [...parsed.collector.datasets.values(), ...parsed.collector.releases.values(), ...parsed.collector.series.values(), ...parsed.collector.geographies.values()]) validateRow(row);
  assert.deepEqual(parsed.reconciliation, {
    what: "publisher file data rows x 8 measure cells -> observations", upstream_rows: 40, artifact_rows: 32, difference: -8,
    explanation: "not written, counted by reason: 8 measure cells in rows without a time frame",
  });
  assert.deepEqual([...parsed.collector.series.keys()].map((k) => k.split("\u0000")[1]).sort(),
    ["ActiveBonds", "ClosedBonds", "GeometricMeanRent", "LodgedBonds", "LogStdDevWeeklyRent", "LowerQuartileRent", "MedianRent", "UpperQuartileRent"]);
  assert.deepEqual([...parsed.collector.geographies.values()].map((g) => [g.scheme, g.code, g.name, g.code_basis]), [
    ["stats_tenancy_rental_bonds:national_total", "-99", "ALL", "publisher_code"], ["stats_tenancy_rental_bonds:region", "2", "Fixture North Region", "publisher_code"],
    ["stats_tenancy_rental_bonds:region", "12", "Fixture's Bay Region", "publisher_code"], ["stats_tenancy_rental_bonds:unknown", "-1", "NA", "publisher_code"],
  ]);
  const by = (series: string, code: string) => parsed.observations.find((o) => o.series_key === series && o.geography?.code === code)!;
  const all = by("MedianRent", "-99");
  assert.deepEqual([all.period_label, all.period_start, all.period_end, all.value, all.value_status, all.qualifiers, all.row_locator, all.upstream_status, all.source_status],
    ["2031-07", "2031-07-01", "2031-07-31", "590", "reported", { source_period_text: "1/07/2031" }, "detailed-monthly-region-tenancy-fixture.csv row 2 column MedianRent", "fresh_fetch", null]);
  assert.deepEqual([by("LodgedBonds", "2").value, by("LodgedBonds", "2").raw_value], ["5592", "5,592"], "a thousands separator is removed from the number and kept in the cell text");
  assert.equal(by("LogStdDevWeeklyRent", "-99").value, "0.3833");
  const blank = by("LodgedBonds", "12");
  assert.deepEqual([blank.value, blank.value_double, blank.raw_value, blank.value_status, blank.parse_status, blank.source_symbol], [null, null, null, "suppressed", "parsed", null]);
  assert.equal(by("ActiveBonds", "12").value, "387");
  assert.equal(parsed.observations.filter((o) => o.value_status === "suppressed").length, 6);
  assert.equal(by("MedianRent", "-1").period_label, "2031-02");

  const ctx = context("stats_tenancy_rental_bonds", TENANCY_PAGE, REGION_URL);
  assert.throws(() => parseTenancyRegionCsv("TimeFrame,location_id,location,LodgedBonds\n1/07/2031,2,X,1\n", ctx), /measure column\(s\) not found: ActiveBonds/);
  assert.throws(() => parseTenancyRegionCsv("Month,location_id,location\n1/07/2031,2,X\n", ctx), /layout needs a human look/);
  const header = "Time Frame,Location_ID,Location,LodgedBonds,ActiveBonds,ClosedBonds,MedianRent,GeometricMeanRent,UpperQuartileRent,LowerQuartileRent,LogStdDevWeeklyRent\n";
  assert.throws(() => parseTenancyRegionCsv(header + "July 2031,2,X,1,2,3,4,5,6,7,8\n", ctx), /d\/mm\/yyyy/);
  assert.equal(parseTenancyRegionCsv(header + "1/07/2031,2,X,1,2,3,4,5,6,7,x\n", ctx).observations[7].value_status, "missing", "an unknown symbol is missing, with the symbol kept");
});

test("rental bonds by region: a fresh cell has the identity the backfill mapper gives the same datum", async () => {
  const ctx: MapContext = { sourceId: "stats_tenancy_rental_bonds", publisher: "Fixture publisher", officialUrl: TENANCY_PAGE, historical: false };
  const collector = new MetaCollector();
  const backfilled = mapTenancy(ctx, collector, { source_url: REGION_URL, observed_at: "2031-09-01 00:00:00" }, {
    source_sha256: "0123456789abcdef".repeat(4), measure: "MedianRent", unit: "NZD/week", adjustment: "not_stated", frequency: "monthly", statistic: "median", stock_flow: "distribution",
    rent_basis: "bond_recorded_not_asking", population: "private_sector_bonded_tenancies", quality_context: "provisional_migration_random_rounding_base3_suppression_lt5", source_column: "MedianRent",
    topic: "housing_affordability", reference_period: "2031-07", source_period_raw: "1/07/2031", geography_level: "national_total", geography_code: "-99", geography_label: "ALL",
    value_status: "reported", value_decimal: "590", value_raw: "590", source_record_number: 1, source_page_url: TENANCY_PAGE,
  });
  const parsed = parseTenancyRegionCsv(await fixtureCsv("tenancy-detailed-monthly-region.synthetic.csv"), context("stats_tenancy_rental_bonds", TENANCY_PAGE, REGION_URL));
  const fresh = parsed.observations.find((o) => o.series_key === "MedianRent" && o.geography?.code === "-99")!;
  assert.deepEqual(identity(fresh), identity(backfilled));
  assert.equal(fresh.release_key, backfilled.release_key, "the same file is the same release: file-<first 16 hex of its SHA-256>");
  assert.deepEqual([fresh.value, fresh.value_status, fresh.qualifiers], [backfilled.value, backfilled.value_status, backfilled.qualifiers]);
  // The series and dataset definitions are the backfill's, word for word, so the loader sees no conflicting definition.
  assert.deepEqual(parsed.collector.series.get(TENANCY_DATASET + "\u0000MedianRent"), collector.series.get(TENANCY_DATASET + "\u0000MedianRent"));
  assert.deepEqual([...parsed.collector.datasets.values()], [...collector.datasets.values()]);
  assert.deepEqual(parsed.collector.geographies.get("stats_tenancy_rental_bonds:national_total\u0000not_stated_by_source\u0000-99"), [...collector.geographies.values()][0]);
});

// The run: fetch -> parse -> artifact -------------------------------------------------------------------------

test("file identity: the publisher's bytes are hashed, with a dropped byte order mark put back", () => {
  const text = "a,b\n1,2\n";
  const plain = fileIdentity(text, Buffer.byteLength(text));
  assert.equal(plain.fileSha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(plain.releaseKey, "file-" + plain.fileSha256!.slice(0, 16));
  const marked = fileIdentity(text, Buffer.byteLength(text) + 3);
  assert.equal(marked.fileSha256, createHash("sha256").update(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])).digest("hex"));
  assert.match(marked.note ?? "", /byte order mark/);
  const unknown = fileIdentity(text, Buffer.byteLength(text) + 1);
  assert.equal(unknown.fileSha256, null, "no file hash is claimed when the bytes cannot be reconstructed");
  assert.match(unknown.releaseKey, /^body-[0-9a-f]{16}$/);
});

type Reply = { body: string | Uint8Array; status?: number };
function transport(replies: { [url: string]: Reply }): { impl: typeof fetch; calls: string[]; headers: Headers[] } {
  const calls: string[] = [];
  const headers: Headers[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    headers.push(new Headers(init?.headers));
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    const reply = replies[url];
    if (!reply) return new Response("not found", { status: 404 });
    return new Response(reply.body as BodyInit, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls, headers };
}

const quiet = { sleep: async () => undefined, now: () => new Date(AT) };

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "stats-live-test-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a source without an incremental route makes no request and writes nothing", async () => {
  await withRoot(async (root) => {
    const { impl, calls } = transport({});
    const summary = await fetchSource(planFor("stats_nz_census_2023"), root, { ...quiet, fetchImpl: impl });
    assert.equal(summary.status, "no_incremental_route");
    assert.equal(summary.reason, planFor("stats_nz_census_2023").incremental_note);
    assert.equal(calls.length, 0);
    assert.deepEqual(await readdir(root), []);
  });
});

test("rental bonds: page -> regional CSV -> a verifiable fresh-fetch artifact beside (never over) the backfill root", async () => {
  await withRoot(async (root) => {
    const csv = await fixtureCsv("tenancy-detailed-monthly-region.synthetic.csv");
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv)]);
    const { impl, calls, headers } = transport({ [TENANCY_PAGE]: { body: await fixtureText("tenancy-rental-bond-page.synthetic.html") }, [REGION_URL]: { body: bytes } });
    const messages: string[] = [];
    const summary = await fetchSource(planFor("stats_tenancy_rental_bonds"), root, { ...quiet, fetchImpl: impl, log: (m) => messages.push(m) });
    assert.equal(summary.status, "ok", summary.error_detail ?? "");
    assert.equal(summary.artifact_root_suffix, FRESH_ROOT_SUFFIX);
    assert.deepEqual(calls, ["https://www.tenancy.govt.nz/robots.txt", TENANCY_PAGE, REGION_URL], "one request per address, nothing else contacted");
    for (const sent of headers) {
      assert.match(sent.get("user-agent") ?? "", /^nz-election-evidence-ingest\//, "the shared client's honest user agent");
      assert.equal(sent.get("cookie"), null);
      assert.equal(sent.get("authorization"), null);
    }
    assert.deepEqual([summary.counts?.observations, summary.counts?.catalogue_entries, summary.counts?.series, summary.counts?.geographies, summary.counts?.releases, summary.counts?.routes], [32, 3, 8, 4, 1, 1]);
    assert.deepEqual(summary.counts?.observations_by_status, { reported: 26, suppressed: 6 });
    assert.equal(summary.reconciliation?.[0].difference, -8);
    assert.match(summary.reconciliation?.[0].explanation ?? "", /8 measure cells in rows without a time frame/);
    assert.deepEqual(summary.fetches?.map((f) => [f.url, f.outcome, f.bytes]), [["https://www.tenancy.govt.nz/robots.txt", "ok", 0], [TENANCY_PAGE, "ok", Buffer.byteLength(await fixtureText("tenancy-rental-bond-page.synthetic.html"))], [REGION_URL, "ok", bytes.byteLength]]);
    const printed = JSON.stringify(summary) + messages.join("\n");
    assert.ok(!printed.includes(root) && !printed.includes(tmpdir()), "no location on a disk is reported");
    assert.ok(!printed.includes("Fixture North Region,"), "no file body is reported");

    const freshRoot = join(root, FRESH_ROOT_SUFFIX);
    assert.equal((await stat(freshRoot)).mode & 0o777, 0o700);
    const artifact = await openArtifact(freshRoot, "stats_tenancy_rental_bonds");
    assert.deepEqual(artifact.manifest.producer.route, "fresh_fetch");
    assert.match(artifact.manifest.producer.recipe_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual([artifact.manifest.collected_from, artifact.manifest.collected_to], [AT, AT]);
    let rows = 0;
    for (const file of artifact.observationFiles) for await (const row of readObservations(artifact, file)) rows += row.upstream_status === "fresh_fetch" ? 1 : 0;
    assert.equal(rows, 32);
    const release = artifact.meta.find((row) => row.kind === "release");
    const fileSha = createHash("sha256").update(bytes).digest("hex");
    assert.ok(release && release.kind === "release");
    assert.deepEqual([release.release_key, release.source_file_sha256, release.source_bytes, release.source_url, release.vintage_label, release.released_on, release.publisher_last_modified, release.retrieved_at],
      ["file-" + fileSha.slice(0, 16), fileSha, bytes.byteLength, REGION_URL, "By region, February 1993 to July 2031 [CSV, 1 KB]", null, null, AT]);
    const route = artifact.meta.find((row) => row.kind === "route");
    assert.ok(route && route.kind === "route");
    assert.deepEqual([route.observation_family, route.canonical_route, route.overlapping_routes, route.upstream_rows_by_route], [TENANCY_DATASET, "operational", [], { operational: 32 }]);
    assert.deepEqual(await readdir(root), [FRESH_ROOT_SUFFIX], "nothing is written at the backfill root itself");
  });
});

test("a challenge, a refusal or a sign-in wall is 'blocked': one attempt, no artifact, earlier output left alone", async () => {
  await withRoot(async (root) => {
    const page = await fixtureText("tenancy-rental-bond-page.synthetic.html");
    const good = transport({ [TENANCY_PAGE]: { body: page }, [REGION_URL]: { body: await fixtureCsv("tenancy-detailed-monthly-region.synthetic.csv") } });
    assert.equal((await fetchSource(planFor("stats_tenancy_rental_bonds"), root, { ...quiet, fetchImpl: good.impl })).status, "ok");
    const before = (await openArtifact(join(root, FRESH_ROOT_SUFFIX), "stats_tenancy_rental_bonds")).digest;

    const challenged = transport({ [TENANCY_PAGE]: { body: page }, [REGION_URL]: { body: "<html><script src=\"/_Incapsula_Resource?x\"></script></html>", status: 403 } });
    const summary = await fetchSource(planFor("stats_tenancy_rental_bonds"), root, { ...quiet, fetchImpl: challenged.impl });
    assert.deepEqual([summary.status, summary.error_class], ["blocked", "publisher_challenge"]);
    assert.match(summary.error_detail ?? "", /^challenge: /);
    assert.equal(summary.counts, undefined, "a blocked run reports no counts: it says nothing about the publisher's records");
    assert.equal(challenged.calls.filter((url) => url === REGION_URL).length, 1, "not retried");
    assert.deepEqual(summary.fetches?.at(-1), { url: REGION_URL, outcome: "challenge", http_status: 403, bytes: summary.fetches?.at(-1)?.bytes ?? null, body_sha256: summary.fetches?.at(-1)?.body_sha256 ?? null, retrieved_at: AT });
    assert.equal((await openArtifact(join(root, FRESH_ROOT_SUFFIX), "stats_tenancy_rental_bonds")).digest, before, "the earlier artifact is untouched");

    const refused = await fetchSource(planFor("stats_rbnz_catalogue"), root, { ...quiet, fetchImpl: transport({ [LIVE_URLS.stats_rbnz_catalogue]: { body: "no", status: 401 } }).impl });
    assert.deepEqual([refused.status, refused.error_class], ["blocked", "publisher_login_required"]);
    await assert.rejects(openArtifact(join(root, FRESH_ROOT_SUFFIX), "stats_rbnz_catalogue"), ContractError);
  });
});

test("a changed layout, an empty listing or a failing publisher is 'failed', never an empty artifact", async () => {
  await withRoot(async (root) => {
    const page = await fixtureText("tenancy-rental-bond-page.synthetic.html");
    const changed = await fetchSource(planFor("stats_tenancy_rental_bonds"), root, { ...quiet, fetchImpl: transport({ [TENANCY_PAGE]: { body: page }, [REGION_URL]: { body: "Month,Region,Bonds\n2031-07,X,1\n" } }).impl });
    assert.deepEqual([changed.status, changed.error_class], ["failed", "contract_error"]);
    assert.match(changed.error_detail ?? "", /layout needs a human look/);
    const empty = await fetchSource(planFor("stats_nz_csv_catalogue"), root, { ...quiet, fetchImpl: transport({ [LIVE_URLS.stats_nz_csv_catalogue]: { body: "<html><body>Service notice</body></html>" } }).impl });
    assert.deepEqual([empty.status, empty.error_class], ["failed", "contract_error"]);
    assert.match(empty.error_detail ?? "", /fault, not an empty source/);
    const down = transport({ [LIVE_URLS.stats_healthnz_data]: { body: "busy", status: 503 } });
    const failing = await fetchSource(planFor("stats_healthnz_data"), root, { ...quiet, fetchImpl: down.impl });
    assert.deepEqual([failing.status, failing.error_class], ["failed", "http_error"]);
    assert.equal(down.calls.filter((url) => url === LIVE_URLS.stats_healthnz_data).length, 1, "one attempt");
    const offList = await fetchSource({ ...planFor("stats_rbnz_catalogue"), live_hosts: ["other.example.govt.nz"] }, root, { ...quiet, fetchImpl: transport({}).impl });
    assert.deepEqual([offList.status, offList.error_class], ["failed", "host_denied"]);
    assert.deepEqual(await readdir(root), [], "no artifact directory was created by any failed run");
  });
});

test("selected price indexes: the newest file named on the listing is fetched and loaded as its own release", async () => {
  await withRoot(async (root) => {
    const csv = await fixtureCsv("selected-price-indexes.synthetic.csv");
    const { impl, calls } = transport({ [STATS_PAGE]: { body: await fixtureText("statsnz-csv-listing.synthetic.html") }, [SPI_URL]: { body: csv } });
    const summary = await fetchSource(planFor("stats_nz_selected_series"), root, { ...quiet, fetchImpl: impl });
    assert.equal(summary.status, "ok", summary.error_detail ?? "");
    assert.deepEqual(calls, ["https://www.stats.govt.nz/robots.txt", STATS_PAGE, SPI_URL]);
    assert.deepEqual([summary.counts?.observations, summary.counts?.catalogue_entries, summary.counts?.geographies], [8, 0, 1]);
    assert.deepEqual(summary.counts?.observations_by_status, { confidential: 1, missing: 1, provisional: 1, reported: 4, suppressed: 1 });
    assert.ok(summary.findings?.some((f) => /chosen from 2 .* by month_and_year_in_link_text/.test(f)));
    const artifact = await openArtifact(join(root, FRESH_ROOT_SUFFIX), "stats_nz_selected_series");
    const release = artifact.meta.find((row) => row.kind === "release");
    assert.ok(release && release.kind === "release");
    const sha = createHash("sha256").update(csv).digest("hex");
    assert.deepEqual([release.release_key, release.vintage_label, release.source_file_sha256, release.released_on_basis], ["file-" + sha.slice(0, 16), "Selected price indexes: August 2031 – CSV", sha, "publisher_label_only"]);
  });
});

test("catalogue-only sources: listing entries, no observation and no route row", async () => {
  await withRoot(async (root) => {
    const health = `<!-- TEST FIXTURE: synthetic --><a href="/about-us/health-data/data-sets-and-collections">Index</a>
      <a href="https://www.healthnz.govt.nz/about-us/health-data/data-sets-and-collections/fixture-data"><h3>Fixture data</h3><p>Invented description.</p></a>
      <a href="/about-us/health-data/data-sets-and-collections/fixture-data#notes">Same page again</a><a href="/about-us/other/">Other</a>`;
    const msd = `<!-- TEST FIXTURE: synthetic --><a href="archive-2030.html">2030 Fixture archive</a><a href="/documents/about-msd-and-our-work/publications-resources/statistics/benefit/2031/fixture.xlsx">Fixture tables (Excel 1KB)</a>`;
    const replies = {
      [LIVE_URLS.stats_healthnz_data]: { body: health }, [LIVE_URLS.stats_msd_benefits]: { body: msd },
      [LIVE_URLS.stats_rbnz_catalogue]: { body: await fixtureText("ckan-package-search.synthetic.json") }, [LIVE_URLS.stats_nz_csv_catalogue]: { body: await fixtureText("statsnz-csv-listing.synthetic.html") },
    };
    const expected: { [sourceId: string]: [number, string] } = { stats_healthnz_data: [1, "catalogue_link"], stats_msd_benefits: [2, "catalogue_link"], stats_rbnz_catalogue: [3, "dataset_metadata"], stats_nz_csv_catalogue: [4, "file_metadata"] };
    for (const [sourceId, [count, kind]] of Object.entries(expected)) {
      const summary = await fetchSource(planFor(sourceId), root, { ...quiet, fetchImpl: transport(replies).impl });
      assert.equal(summary.status, "ok", `${sourceId}: ${summary.error_detail}`);
      assert.deepEqual([summary.counts?.observations, summary.counts?.routes, summary.counts?.catalogue_entries], [0, 0, count], sourceId);
      assert.equal(summary.reconciliation?.[0].difference, 0);
      const artifact = await openArtifact(join(root, FRESH_ROOT_SUFFIX), sourceId);
      assert.ok(artifact.meta.every((row) => row.kind === "catalogue_entry" && row.entry_kind === kind && row.observed_first_at === AT && row.file_sha256 === null), sourceId);
    }
    const listing = await openArtifact(join(root, FRESH_ROOT_SUFFIX), "stats_nz_csv_catalogue");
    assert.ok(listing.meta.every((row) => row.kind === "catalogue_entry" && row.publisher_modified_text === "2025-01-17 10:45:00"));
    assert.ok(listing.manifest.findings.some((f) => /1 further document\(s\)/.test(f)));
    const healthEntry = (await openArtifact(join(root, FRESH_ROOT_SUFFIX), "stats_healthnz_data")).meta[0];
    assert.ok(healthEntry.kind === "catalogue_entry" && healthEntry.title === "Fixture data Invented description." && healthEntry.attributes.topic === "health_outcomes_and_access");
  });
});
