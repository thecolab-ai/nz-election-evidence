// Statistics family: pure parsers for the incremental "fresh anonymous fetch" route. No I/O happens here.
//
// Every parser turns the TEXT of one publisher page or file into rows of the typed artifact contract and nothing
// else: no page body, no unlisted field and no contact detail leaves this module. The observation parsers emit the
// SAME identity keys as the backfill mappers (dataset, series, geography, period), so a fresh fetch of a file the
// backfill already holds lands on the same identities; only the release vintage can differ.
//
// A layout the parser does not recognise is a ContractError, never a guess: a changed file needs a human look.
// A blank, withheld or symbol cell is null with a status. It is never zero. Numbers stay exact decimal text.

import { cleanText } from "../../../../supabase/functions/_shared/canonical.ts";
import type { Json } from "../../../../supabase/functions/_shared/types.ts";
import {
  type CatalogueEntryRow, ContractError, type EntryKind, observation, type ObservationRow, parseDecimal, type ReconciliationLine,
  sha256Text, textViolation, type ValueStatus,
} from "./contract.ts";
import { MetaCollector, SELECTED_SERIES_TITLES, SERIES_SHAPE } from "./mappers.ts";

export type CatalogueFields = Omit<CatalogueEntryRow, "kind" | "content_hash" | "observed_first_at" | "observed_last_at" | "observation_count">;
/** The input shape of `foldCatalogueVersions`. */
export interface CatalogueVersion { fields: CatalogueFields; observedAt: string }

// CSV --------------------------------------------------------------------------------------------------------

/**
 * RFC 4180: quoted fields, doubled quotes, commas and line breaks inside quotes, CRLF or LF, an optional UTF-8
 * byte order mark. A blank line is returned as a record of one empty field so that callers can keep counting the
 * publisher's own row numbers; the empty record after a final line break is not returned.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (ch === ",") endField();
    else if (ch === "\n") endRow();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (quoted) throw new ContractError("CSV ends inside a quoted field; the file is incomplete or not CSV");
  if (fieldStarted || field !== "" || row.length > 0) endRow();
  return rows;
}

function isBlankRecord(record: string[]): boolean {
  return record.every((cell) => cell.trim() === "");
}

// Catalogue: CKAN result set (P18) ---------------------------------------------------------------------------

/**
 * P18: the government data catalogue's package_search answer for one organisation. Catalogue metadata only.
 *
 * Entry keys: backfilled entries are keyed by the upstream collection's record ids, which a fresh fetch cannot
 * know. A fresh fetch therefore writes entries under its own key space (`ckan:<package name>`); the two key spaces
 * are reconciled by `url`, which is identical for the same catalogue dataset.
 *
 * An unsuccessful or empty answer is a fault, not an empty source: nothing may be read as "no records".
 */
export function parseCkanPackages(jsonText: string, sourceId: string, foundOnUrl: string, observedAt: string): CatalogueVersion[] {
  let body: unknown;
  try {
    body = JSON.parse(jsonText);
  } catch {
    throw new ContractError("catalogue API answer is not JSON");
  }
  const top = body as { success?: unknown; result?: { count?: unknown; results?: unknown } } | null;
  if (typeof top !== "object" || top === null || top.success !== true) throw new ContractError("catalogue API answer does not report success");
  const results = top.result?.results;
  if (!Array.isArray(results) || results.length === 0) throw new ContractError("catalogue API answer holds no result list; an empty answer is a fault, not an empty source");
  const available = top.result?.count;
  if (typeof available !== "number" || !Number.isSafeInteger(available) || available < results.length) throw new ContractError("catalogue API answer does not state a usable result count");
  const scope = {
    available_results: available, emitted_results: results.length,
    completion: results.length === available ? "complete_current_ckan_result_set" : "partial_result_set",
  };
  const seen = new Set<string>();
  return results.map((item: unknown) => {
    const p = item as { name?: unknown; title?: unknown; metadata_modified?: unknown; num_resources?: unknown; resources?: unknown } | null;
    if (typeof p !== "object" || p === null || typeof p.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(p.name)) throw new ContractError("a catalogue result has no usable package name");
    if (seen.has(p.name)) throw new ContractError("the catalogue answer lists one package name twice");
    seen.add(p.name);
    const title = typeof p.title === "string" && p.title.trim() ? p.title.trim() : p.name;
    const resourceCount = typeof p.num_resources === "number" && Number.isSafeInteger(p.num_resources) ? p.num_resources : Array.isArray(p.resources) ? p.resources.length : null;
    const attributes: { [name: string]: Json } = { topic: "finance_and_economy" };
    if (resourceCount !== null) attributes.resource_count = resourceCount;
    attributes.result_set_scope = scope;
    return {
      fields: {
        source_id: sourceId, entry_key: `ckan:${p.name}`, entry_kind: "dataset_metadata" as EntryKind, title: title.slice(0, 1000),
        url: `https://catalogue.data.govt.nz/dataset/${p.name}`, found_on_url: foundOnUrl, format: null, file_sha256: null,
        publisher_modified_text: typeof p.metadata_modified === "string" && p.metadata_modified.trim() ? p.metadata_modified.trim().slice(0, 100) : null,
        attributes,
      },
      observedAt,
    };
  });
}

// Catalogue: listing pages (P11, P12, P20, P23) --------------------------------------------------------------

export interface ListingLink { url: string; text: string }
export interface LinkListingOptions {
  /** Exact hostnames a listed link may point at. A link elsewhere is not part of this source's listing. */
  hosts: string[];
  /** Tested against the link's PATH (not its query), so a cache marker such as `?m=...` does not hide an extension. */
  include: RegExp;
}
export interface LinkListing {
  links: ListingLink[];
  /** Links that matched but are never stored: a credential-like query, an over-long address, contact-like link text. */
  refused: number;
}

const SECRET_QUERY = /[?&#](key|api_?key|token|access_token|auth|sig|signature|secret|password|session)=/i;
const PLAIN_HTTPS = /^https:\/\/[A-Za-z0-9.-]+(\/[^\s]*)?$/;

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function fileNameOf(url: string): string {
  const segment = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  let name = segment;
  try {
    name = decodeURIComponent(segment);
  } catch { /* keep the encoded text */ }
  return name.replace(/[\u0000-\u001f]/g, "").slice(0, 200) || "file";
}

function addLink(out: Map<string, ListingLink>, counter: { refused: number }, href: string, text: string, pageUrl: string, opts: LinkListingOptions): void {
  let url: URL;
  try {
    url = new URL(href.trim(), pageUrl);
  } catch {
    return;
  }
  url.hash = "";
  const hosts = opts.hosts.map((h) => h.toLowerCase());
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !hosts.includes(url.hostname.toLowerCase())) return;
  if (!opts.include.test(url.pathname)) return;
  const address = url.toString();
  if (address === new URL(pageUrl).toString() || out.has(address)) return;
  if (address.length > 2000 || SECRET_QUERY.test(address) || !PLAIN_HTTPS.test(address)) {
    counter.refused++;
    return;
  }
  let label = text.slice(0, 1000);
  if (!label || textViolation(label)) {
    // Contact-like or empty link text is never stored; the file name stands in for it.
    if (label) counter.refused++;
    label = fileNameOf(address);
    if (textViolation(label)) return;
  }
  out.set(address, { url: address, text: label });
}

/** `<a href>` links of a listing page: resolved against the page, https only, allowlisted hosts only, de-duplicated by address. */
export function parseLinkListing(html: string, pageUrl: string, opts: LinkListingOptions): LinkListing {
  const out = new Map<string, ListingLink>();
  const counter = { refused: 0 };
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (let match = anchor.exec(html); match; match = anchor.exec(html)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    if (!href) continue;
    const title = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[1]);
    const text = cleanText(match[2]) || (title ? cleanText(title[1] ?? title[2] ?? "") : "");
    addLink(out, counter, decodeEntities(href[1] ?? href[2] ?? href[3] ?? ""), text, pageUrl, opts);
  }
  return { links: [...out.values()], refused: counter.refused };
}

export interface EmbeddedListing extends LinkListing {
  /** The page date the publisher states in the page's own data, verbatim. Null when none is stated. */
  pageDateText: string | null;
}

/**
 * The Stats NZ "CSV files for download" page does not print its file list as `<a href>` markup: the page carries
 * the list as JSON in a `data-value` attribute (document blocks with Title and DocumentLink) and draws it in the
 * reader's browser. That JSON is part of the public page the anonymous GET returns; reading it executes nothing
 * and requests nothing further. Only Title and DocumentLink are read, plus the page's own PageDate; text blocks
 * inside the same JSON are read for ordinary `<a href>` links.
 */
export function parseEmbeddedDocuments(html: string, pageUrl: string, opts: LinkListingOptions): EmbeddedListing {
  const out = new Map<string, ListingLink>();
  const counter = { refused: 0 };
  let pageDateText: string | null = null;
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const object = node as { [key: string]: unknown };
    if (typeof object.DocumentLink === "string" && typeof object.Title === "string") {
      addLink(out, counter, object.DocumentLink, cleanText(object.Title), pageUrl, opts);
      return;
    }
    if (typeof object.Content === "string" && object.Content.includes("<a")) {
      for (const link of parseLinkListing(object.Content, pageUrl, opts).links) if (!out.has(link.url)) out.set(link.url, link);
    }
    for (const value of Object.values(object)) walk(value, depth + 1);
  };
  const attribute = /\bdata-value\s*=\s*"([^"]*)"/gi;
  for (let match = attribute.exec(html); match; match = attribute.exec(html)) {
    const decoded = decodeEntities(match[1]).trim();
    if (!decoded.startsWith("{") && !decoded.startsWith("[")) continue;
    let data: unknown;
    try {
      data = JSON.parse(decoded);
    } catch {
      continue;
    }
    if (pageDateText === null && typeof data === "object" && data !== null && !Array.isArray(data)) {
      const date = (data as { PageDate?: unknown }).PageDate;
      if (typeof date === "string" && date.trim() && date.trim().length <= 100 && Array.isArray((data as { PageBlocks?: unknown }).PageBlocks)) pageDateText = date.trim();
    }
    walk(data, 0);
  }
  return { links: [...out.values()], refused: counter.refused, pageDateText };
}

export interface ListingEntryOptions {
  sourceId: string;
  foundOnUrl: string;
  entryKind: EntryKind;
  /** `file_metadata` entries state the file's format (its extension). A listing never yields a file hash. */
  withFormat: boolean;
  attributes: { [name: string]: Json };
  publisherModifiedText: string | null;
  observedAt: string;
}

/**
 * Listing links as catalogue entry versions. Keys are `listing:<hash of the address>`: like the CKAN keys above,
 * a fresh-fetch key space of its own, reconciled with backfilled entries by `url`.
 */
export function listingEntries(links: ListingLink[], opts: ListingEntryOptions): CatalogueVersion[] {
  return links.map((link) => {
    const extension = /\.([A-Za-z0-9]{1,8})$/.exec(new URL(link.url).pathname)?.[1]?.toLowerCase() ?? null;
    return {
      fields: {
        source_id: opts.sourceId, entry_key: "listing:" + sha256Text(link.url).slice(0, 24), entry_kind: opts.entryKind, title: link.text,
        url: link.url, found_on_url: opts.foundOnUrl, format: opts.withFormat ? extension : null, file_sha256: null,
        publisher_modified_text: opts.publisherModifiedText, attributes: { ...opts.attributes },
      },
      observedAt: opts.observedAt,
    };
  });
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * P22 discovery: the newest "Selected price indexes" CSV on the listing. The listing is grouped by topic, not by
 * date, so listing order alone is not trusted: the month and year the publisher prints in the link text decide,
 * and listing order is only the tie-break (and the fallback when no link states a month).
 */
export function pickSelectedPriceIndexes(links: ListingLink[]): { link: ListingLink; basis: string; candidates: number } | null {
  const candidates = links.filter((l) => /\.csv$/i.test(new URL(l.url).pathname) && (/^Selected price indexes: .* [–-] CSV$/i.test(l.text) || /selected-price-indexes/i.test(l.url)));
  if (candidates.length === 0) return null;
  let best: { link: ListingLink; rank: number } | null = null;
  for (const link of candidates) {
    const stated = new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{4})\\b`, "i").exec(link.text) ?? new RegExp(`\\b(${MONTHS.join("|")})-(\\d{4})\\b`, "i").exec(fileNameOf(link.url));
    const rank = stated ? Number(stated[2]) * 12 + MONTHS.indexOf(stated[1].toLowerCase()) : -1;
    if (!best || rank > best.rank) best = { link, rank };
  }
  return { link: best!.link, basis: best!.rank >= 0 ? "month_and_year_in_link_text" : "listing_order", candidates: candidates.length };
}

// Observations -----------------------------------------------------------------------------------------------

export interface FileContext {
  sourceId: string;
  publisher: string;
  /** The page the file was found on. */
  officialUrl: string;
  sourceUrl: string;
  /** Link text of the file on the listing, else its file name. A publisher label, never a date. */
  vintageLabel: string | null;
  /** Names the release: `file-<first 16 hex of the file's SHA-256>`. */
  releaseKey: string;
  /** SHA-256 of the file's bytes; null when the bytes could not be reconstructed exactly from the decoded text. */
  fileSha256: string | null;
  sourceBytes: number | null;
  /** Collection time (UTC). Never a publisher date. */
  retrievedAt: string;
}

export interface ParsedFile {
  collector: MetaCollector;
  observations: ObservationRow[];
  reconciliation: ReconciliationLine;
  findings: string[];
}

function cell(text: string | undefined): string | null {
  const trimmed = (text ?? "").trim();
  return trimmed ? trimmed : null;
}

function monthBounds(year: string, month: string): { start: string; end: string } | null {
  const m = Number(month);
  if (m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(Number(year), m, 0)).getUTCDate();
  return { start: `${year}-${month}-01`, end: `${year}-${month}-${String(last).padStart(2, "0")}` };
}

function columnIndex(header: string[], names: string[]): number {
  for (const name of names) {
    const index = header.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

function addRelease(collector: MetaCollector, datasetKey: string, ctx: FileContext): void {
  collector.addRelease({
    kind: "release", dataset_key: datasetKey, release_key: ctx.releaseKey, vintage_label: ctx.vintageLabel?.slice(0, 500) ?? null, released_on: null,
    // The label is the publisher's link text. No release DATE is stated by the file, and collection time is not one.
    released_on_basis: ctx.vintageLabel ? "publisher_label_only" : "not_stated", source_url: ctx.sourceUrl, source_file_sha256: ctx.fileSha256,
    source_bytes: ctx.sourceBytes, retrieved_at: ctx.retrievedAt, publisher_last_modified: null, boundary_edition: null, capture_count: 1,
  });
}

function reconcile(what: string, expected: number, written: number, skips: { [reason: string]: number }): ReconciliationLine {
  const reasons = Object.entries(skips).filter(([, n]) => n > 0).map(([reason, n]) => `${n} ${reason}`);
  return {
    what, upstream_rows: expected, artifact_rows: written, difference: written - expected,
    explanation: reasons.length ? `not written, counted by reason: ${reasons.join("; ")}` : "every expected value cell of the publisher file became exactly one observation",
  };
}

export const SELECTED_PRICE_INDEXES_DATASET = "food_price_index_selected_price_indexes_csv";

/**
 * P22: the Stats NZ "Selected price indexes" release CSV
 * (Series_reference, Period, Data_value, STATUS, UNITS, [MAGNITUDE], Subject, Group, Series_title_1..5 in any order).
 *
 * Identities equal `mapSelectedSeries` for the same file: series key = Series_reference, period `YYYY.MM` written
 * `YYYY-MM` (the publisher's text stays in qualifiers.source_period_text), national geography "NZ".
 *
 * Two deliberate limits, both reported in `findings`:
 *  * The backfill holds the upstream collector's SELECTION of series groups and that collector normalised unit and
 *    title wording. This parser keeps the publisher's wording verbatim, so a fresh series DEFINITION can differ from
 *    the backfilled one for the same key. The loader then REFUSES the conflicting definition instead of overwriting
 *    it. That is the designed behaviour: the difference is put in front of a person.
 *  * The national geography is attached only where the publisher's Group text names New Zealand or "National". A
 *    group of sub-national series (the region is part of the series title) is written without a geography rather
 *    than being labelled national.
 */
export function parseStatsNzSeriesCsv(csvText: string, ctx: FileContext): ParsedFile {
  const records = parseCsv(csvText);
  if (records.length < 2) throw new ContractError("the series file holds no data rows; an empty file is a fault, not an empty source");
  const header = records[0].map((name) => name.trim());
  const at = {
    ref: columnIndex(header, SERIES_SHAPE.seriesRef), period: columnIndex(header, SERIES_SHAPE.period), value: columnIndex(header, SERIES_SHAPE.value),
    status: columnIndex(header, SERIES_SHAPE.status), unit: columnIndex(header, SERIES_SHAPE.unit), magnitude: columnIndex(header, SERIES_SHAPE.magnitude),
    subject: columnIndex(header, ["Subject"]), group: columnIndex(header, ["Group"]),
  };
  if (at.ref < 0 || at.period < 0 || at.value < 0) throw new ContractError("series reference, period or value column not found; the file layout needs a human look");
  const titleColumns = SERIES_SHAPE.titleColumns.map((name) => header.indexOf(name)).filter((index) => index >= 0);
  const read = new Set([...Object.values(at), ...titleColumns].filter((index) => index >= 0));
  const unread = header.filter((_, index) => !read.has(index));

  const datasetKey = SELECTED_PRICE_INDEXES_DATASET;
  const member = fileNameOf(ctx.sourceUrl);
  const collector = new MetaCollector();
  collector.addDataset({
    kind: "dataset", source_id: ctx.sourceId, dataset_key: datasetKey, title: SELECTED_SERIES_TITLES[datasetKey], publisher: ctx.publisher, official_url: ctx.officialUrl,
    route: "operational", historical: false, coverage_note: "Selected files only; each series keeps its own unit, period and vintage.",
  });
  addRelease(collector, datasetKey, ctx);
  const scheme = `${ctx.sourceId}:national`;
  const edition = "not_stated_by_source";

  const observations: ObservationRow[] = [];
  const skips = { "rows without a series reference": 0, "rows without a period": 0 };
  let blankLines = 0;
  const withoutGeography = new Map<string, number>();
  let dataRows = 0;
  for (let r = 1; r < records.length; r++) {
    const record = records[r];
    if (isBlankRecord(record)) {
      blankLines++;
      continue;
    }
    dataRows++;
    if (record.length !== header.length) throw new ContractError(`${member} row ${r + 1} does not have the header's number of cells; the file layout needs a human look`);
    const seriesKey = cell(record[at.ref]);
    const periodText = cell(record[at.period]);
    if (seriesKey === null) {
      skips["rows without a series reference"]++;
      continue;
    }
    if (periodText === null) {
      skips["rows without a period"]++;
      continue;
    }
    const period = /^(\d{4})\.(\d{2})$/.exec(periodText);
    if (!period) throw new ContractError(`${member} row ${r + 1}: the period is not in the publisher's YYYY.MM form; the file layout needs a human look`);
    // Stats NZ series references carry their frequency as the fourth letter of the prefix (CPIM = monthly). Only a
    // monthly series gets month bounds; for anything else the label is kept and no bounds are asserted.
    const monthly = /^[A-Z]{3}M\./.test(seriesKey);
    const bounds = monthly ? monthBounds(period[1], period[2]) : null;
    if (monthly && !bounds) throw new ContractError(`${member} row ${r + 1}: the period names no calendar month`);

    const group = at.group >= 0 ? cell(record[at.group]) : null;
    const subject = at.subject >= 0 ? cell(record[at.subject]) : null;
    const dimensions: { [name: string]: string } = {};
    if (group !== null && group !== "NA") dimensions.series_group = group.slice(0, 1000);
    if (subject !== null && subject !== "NA") dimensions.subject = subject.slice(0, 1000);
    const titles = titleColumns.map((index) => cell(record[index])).filter((t): t is string => t !== null && t !== "NA");
    collector.addSeries({
      kind: "series", dataset_key: datasetKey, series_key: seriesKey, title: titles.join(" / ").slice(0, 1000) || null,
      unit: at.unit >= 0 ? cell(record[at.unit]) : null, magnitude: at.magnitude >= 0 ? cell(record[at.magnitude]) : null,
      seasonal_adjustment: null, frequency: monthly ? "monthly" : null, dimensions,
    });

    let geography: ObservationRow["geography"] = null;
    if (group === null || /\bNew Zealand\b|\bNational\b/i.test(group)) {
      collector.addGeography({ kind: "geography", source_id: ctx.sourceId, scheme, edition, code: "NZ", name: "New Zealand", code_basis: "publisher_code" });
      geography = { scheme, edition, code: "NZ" };
    } else withoutGeography.set(group, (withoutGeography.get(group) ?? 0) + 1);

    const rawCell = record[at.value];
    const raw = cell(rawCell);
    const sourceStatus = at.status >= 0 ? cell(record[at.status]) : null;
    const number = raw !== null ? parseDecimal(raw) : null;
    let valueStatus: ValueStatus;
    if (number) valueStatus = sourceStatus !== null && /^(p|prov|provisional)$/i.test(sourceStatus) ? "provisional" : "reported";
    else if (sourceStatus !== null && /^(C|CONFIDENTIAL)$/i.test(sourceStatus)) valueStatus = "confidential";
    else if (sourceStatus !== null && /^(S|SUPPRESSED)$/i.test(sourceStatus)) valueStatus = "suppressed";
    else valueStatus = "missing";
    const row = observation({
      dataset_key: datasetKey, release_key: ctx.releaseKey, series_key: seriesKey, geography,
      period_label: `${period[1]}-${period[2]}`, period_start: bounds?.start ?? null, period_end: bounds?.end ?? null,
      value: number?.value ?? null, value_double: number?.value_double ?? null, raw_value: raw, value_status: valueStatus,
      parse_status: number || raw === null ? "parsed" : "unparsed_symbol", source_status: sourceStatus, source_symbol: number ? null : raw,
      upstream_status: "fresh_fetch", qualifiers: { source_period_text: periodText }, row_locator: `${member} row ${r + 1}`,
    });
    collector.claim(row);
    observations.push(row);
  }
  if (observations.length === 0) throw new ContractError("the series file yielded no observation; an empty result is a fault, not an empty source");

  const findings = [
    "Series definitions keep the publisher's wording (UNITS verbatim, Series_title_1..5 joined, Group and Subject as dimensions). The backfilled definitions of the same series keys were normalised upstream (for example unit wording), so a definition can differ for the same key; the loader refuses a conflicting series definition rather than overwriting it, which surfaces it for a person.",
    "The backfill holds only the upstream collector's selection of series groups from this publisher file; a fresh fetch reads every row of the file.",
  ];
  if (withoutGeography.size > 0) {
    const total = [...withoutGeography.values()].reduce((a, b) => a + b, 0);
    findings.push(`${total} observations in ${withoutGeography.size} series group(s) whose publisher group text does not name New Zealand carry no geography (the area is part of the series title): ${[...withoutGeography.keys()].sort().join("; ").slice(0, 600)}`);
  }
  if (unread.length > 0) findings.push(`columns present in the file and not read: ${unread.join(", ").slice(0, 600)}`);
  if (blankLines > 0) findings.push(`${blankLines} blank line(s) in the file are not data rows and are not counted as such`);
  return { collector, observations, reconciliation: reconcile("publisher file data rows -> observations", dataRows, observations.length, skips), findings };
}

export const TENANCY_DATASET = "tenancy.rental_bonds.detailed_monthly_region";

interface TenancyMeasure { column: string; unit: string; statistic: string; stock_flow: string; rent_basis: string }

/** The eight measures of the regional monthly file, described exactly as the backfill describes them. */
export const TENANCY_MEASURES: readonly TenancyMeasure[] = [
  { column: "LodgedBonds", unit: "bonds", statistic: "count", stock_flow: "flow", rent_basis: "not_applicable" },
  { column: "ActiveBonds", unit: "bonds", statistic: "count", stock_flow: "stock", rent_basis: "not_applicable" },
  { column: "ClosedBonds", unit: "bonds", statistic: "count", stock_flow: "flow", rent_basis: "not_applicable" },
  { column: "MedianRent", unit: "NZD/week", statistic: "median", stock_flow: "distribution", rent_basis: "bond_recorded_not_asking" },
  { column: "GeometricMeanRent", unit: "NZD/week", statistic: "geometric_mean", stock_flow: "distribution", rent_basis: "bond_recorded_not_asking" },
  { column: "UpperQuartileRent", unit: "NZD/week", statistic: "upper_quartile_source_label_method_unconfirmed", stock_flow: "distribution", rent_basis: "bond_recorded_not_asking" },
  { column: "LowerQuartileRent", unit: "NZD/week", statistic: "lower_quartile_source_label_method_unconfirmed", stock_flow: "distribution", rent_basis: "bond_recorded_not_asking" },
  { column: "LogStdDevWeeklyRent", unit: "dimensionless", statistic: "log_standard_deviation", stock_flow: "distribution", rent_basis: "bond_recorded_not_asking" },
];

/**
 * P23: Tenancy Services "detailed monthly, by region" CSV. Header as published (checked against the live file):
 *   TimeFrame,location_id,location,LodgedBonds,ActiveBonds,ClosedBonds,MedianRent,GeometricMeanRent,
 *   UpperQuartileRent,LowerQuartileRent,LogStdDevWeeklyRent
 * One observation per measure cell. Identities equal `mapTenancy`: series key = the publisher's column name,
 * geography = the publisher's location id, period `YYYY-MM` from the publisher's d/mm/yyyy text, which stays in
 * qualifiers.source_period_text. The geography scheme follows the backfill (checked against its artifact): the
 * publisher's location id "-99" ("ALL") is the scheme `<source>:national_total`, "-1" ("NA", bonds the publisher
 * could not place) is `<source>:unknown`, and every other id is `<source>:region`.
 *
 * A BLANK measure cell is written as null with status `suppressed`: the publisher documents that values under 5
 * are suppressed (the dataset's coverage note), so an empty cell in this file is a withheld number, not a zero and
 * not an unexplained gap. A non-numeric symbol in a cell is `missing` with the symbol kept, unless it says suppressed.
 */
export function parseTenancyRegionCsv(csvText: string, ctx: FileContext): ParsedFile {
  const records = parseCsv(csvText);
  if (records.length < 2) throw new ContractError("the rental bond file holds no data rows; an empty file is a fault, not an empty source");
  const header = records[0].map((name) => name.trim());
  const squashed = header.map((name) => name.toLowerCase().replace(/[\s_]/g, ""));
  const at = { period: squashed.indexOf("timeframe"), code: squashed.indexOf("locationid"), name: squashed.indexOf("location") };
  if (at.period < 0 || at.code < 0 || at.name < 0) throw new ContractError("time frame, location id or location column not found; the file layout needs a human look");
  const measures = TENANCY_MEASURES.map((measure) => ({ measure, index: header.indexOf(measure.column) }));
  const absent = measures.filter((m) => m.index < 0).map((m) => m.measure.column);
  if (absent.length > 0) throw new ContractError(`measure column(s) not found: ${absent.join(", ")}; the file layout needs a human look`);
  const read = new Set([at.period, at.code, at.name, ...measures.map((m) => m.index)]);
  const unread = header.filter((_, index) => !read.has(index));

  const datasetKey = TENANCY_DATASET;
  const member = fileNameOf(ctx.sourceUrl);
  const collector = new MetaCollector();
  collector.addDataset({
    kind: "dataset", source_id: ctx.sourceId, dataset_key: datasetKey, title: "Rental bond data: detailed monthly, by region", publisher: ctx.publisher, official_url: ctx.officialUrl,
    route: "operational", historical: false,
    coverage_note: "Private-sector bonded tenancies. Counts are randomly rounded to base 3 and values under 5 are suppressed by the publisher; recent months are provisional.",
  });
  addRelease(collector, datasetKey, ctx);
  for (const { measure } of measures) {
    collector.addSeries({
      kind: "series", dataset_key: datasetKey, series_key: measure.column, title: measure.column, unit: measure.unit, magnitude: null, seasonal_adjustment: "not_stated", frequency: "monthly",
      dimensions: {
        statistic: measure.statistic, stock_flow: measure.stock_flow, rent_basis: measure.rent_basis, population: "private_sector_bonded_tenancies",
        quality_context: "provisional_migration_random_rounding_base3_suppression_lt5", source_column: measure.column, topic: "housing_affordability",
      },
    });
  }
  const schemeOf = (code: string) => `${ctx.sourceId}:${code === "-99" ? "national_total" : code === "-1" ? "unknown" : "region"}`;
  const edition = "not_stated_by_source";

  const observations: ObservationRow[] = [];
  const skips = { "measure cells in rows without a time frame": 0, "measure cells in rows without a location id": 0 };
  let dataRows = 0;
  for (let r = 1; r < records.length; r++) {
    const record = records[r];
    if (isBlankRecord(record)) continue;
    dataRows++;
    if (record.length !== header.length) throw new ContractError(`${member} row ${r + 1} does not have the header's number of cells; the file layout needs a human look`);
    const periodText = cell(record[at.period]);
    const code = cell(record[at.code]);
    if (periodText === null) {
      skips["measure cells in rows without a time frame"] += measures.length;
      continue;
    }
    if (code === null) {
      skips["measure cells in rows without a location id"] += measures.length;
      continue;
    }
    const date = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(periodText);
    const month = date ? date[2].padStart(2, "0") : "";
    const bounds = date ? monthBounds(date[3], month) : null;
    if (!date || !bounds) throw new ContractError(`${member} row ${r + 1}: the time frame is not in the publisher's d/mm/yyyy form; the file layout needs a human look`);
    const scheme = schemeOf(code);
    collector.addGeography({ kind: "geography", source_id: ctx.sourceId, scheme, edition, code, name: cell(record[at.name]), code_basis: "publisher_code" });
    for (const { measure, index } of measures) {
      const raw = cell(record[index]);
      const number = raw !== null ? parseDecimal(raw) : null;
      const valueStatus: ValueStatus = number ? "reported" : raw === null || /^(s|\.\.s|suppressed)$/i.test(raw) ? "suppressed" : "missing";
      const row = observation({
        dataset_key: datasetKey, release_key: ctx.releaseKey, series_key: measure.column, geography: { scheme, edition, code },
        period_label: `${date[3]}-${month}`, period_start: bounds.start, period_end: bounds.end,
        value: number?.value ?? null, value_double: number?.value_double ?? null, raw_value: raw, value_status: valueStatus,
        parse_status: number || raw === null ? "parsed" : "unparsed_symbol", source_status: null, source_symbol: number ? null : raw,
        upstream_status: "fresh_fetch", qualifiers: { source_period_text: periodText }, row_locator: `${member} row ${r + 1} column ${measure.column}`,
      });
      collector.claim(row);
      observations.push(row);
    }
  }
  if (observations.length === 0) throw new ContractError("the rental bond file yielded no observation; an empty result is a fault, not an empty source");
  const findings: string[] = [];
  if (unread.length > 0) findings.push(`columns present in the file and not read: ${unread.join(", ").slice(0, 600)}`);
  return {
    collector, observations, findings,
    reconciliation: reconcile("publisher file data rows x 8 measure cells -> observations", dataRows * measures.length, observations.length, skips),
  };
}
