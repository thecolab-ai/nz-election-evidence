// Statistics family: the incremental route. A fresh, anonymous, public GET of the publisher's own page or file,
// parsed into the SAME typed artifact the backfill writes (producer.route = "fresh_fetch").
//
//  * Every request goes through the shared fetch guard: per-source host allowlist, public-address check, pacing,
//    robots.txt recorded as an advisory, and no cookie, credential, key or custom user agent, ever.
//  * A bot challenge, login wall, paywall, 401 or 403 ends the run as status "blocked". That is an availability
//    fact about the publisher. It is never worked around, never retried here, and never read as "no records".
//  * No page or file body is kept: only the parsed, allowlisted fields reach the artifact, and the summary holds
//    hashes and counts. Collection time (`retrieved_at`) is never presented as a publisher date, and the shared
//    client does not expose response headers, so `publisher_last_modified` is always null on this route.
//  * A fresh-fetch artifact is written under the sibling root `<artifact root>/fresh/<source_id>`, because opening
//    an artifact directory replaces it and the backfill artifact of the same source must survive. Nothing is
//    written unless every fetch and every parse succeeded, so a blocked or failed run leaves earlier output alone.

import { createHash } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createSafeFetch } from "../../../../supabase/functions/_shared/http.ts";
import { type FetchLogEntry, IngestError, SourceUnavailableError } from "../../../../supabase/functions/_shared/types.ts";
import { resolveHost as nodeResolveHost } from "../../resolve_host.ts";
import { ArtifactWriter } from "./artifact.ts";
import { type ArtifactManifest, ContractError, type MetaRow, type ObservationRow, type ReconciliationLine, type RouteRow, sha256Text } from "./contract.ts";
import {
  type CatalogueVersion, type FileContext, type LinkListing, listingEntries, parseCkanPackages, parseEmbeddedDocuments, parseLinkListing,
  type ParsedFile, parseStatsNzSeriesCsv, parseTenancyRegionCsv, pickSelectedPriceIndexes,
} from "./live_parsers.ts";
import { foldCatalogueVersions, type MetaCollector } from "./mappers.ts";
import type { StatsSourcePlan } from "./routes.ts";

export const LIVE_VERSION = "1.0.0";
/** Fresh-fetch artifacts live beside, never over, the backfill artifacts. */
export const FRESH_ROOT_SUFFIX = "fresh";

export const LIVE_URLS = {
  stats_rbnz_catalogue: "https://catalogue.data.govt.nz/api/3/action/package_search?fq=organization%3Areserve-bank-of-new-zealand&rows=100",
  stats_nz_csv_catalogue: "https://www.stats.govt.nz/large-datasets/csv-files-for-download/",
  stats_nz_selected_series: "https://www.stats.govt.nz/large-datasets/csv-files-for-download/",
  stats_tenancy_rental_bonds: "https://www.tenancy.govt.nz/about-tenancy-services/data-and-statistics/rental-bond-data/",
  stats_healthnz_data: "https://www.healthnz.govt.nz/about-us/health-data/data-sets-and-collections",
  stats_msd_benefits: "https://www.msd.govt.nz/about-msd-and-our-work/publications-resources/statistics/benefit/index.html",
} as const;

export interface LiveFetchOptions {
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  resolveHost?: (hostname: string) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
}

export interface LiveFetchRecord { url: string; outcome: string; http_status: number | null; bytes: number | null; body_sha256: string | null; retrieved_at: string }

export interface LiveFetchSummary {
  source_id: string;
  status: "ok" | "blocked" | "failed" | "no_incremental_route";
  reason?: string;
  error_class?: string;
  error_detail?: string;
  /** Where the artifact was written, as a path-free fact: `<artifact root>/<suffix>/<source_id>`. */
  artifact_root_suffix?: string;
  counts?: ArtifactManifest["counts"];
  reconciliation?: ReconciliationLine[];
  findings?: string[];
  /** Every request and every robots.txt advisory of the run: address, outcome, size and body hash. Never a body. */
  fetches?: LiveFetchRecord[];
}

interface Fetched { text: string; retrievedAt: string; bytes: number | null; url: string }
type Get = (url: string, accept?: string) => Promise<Fetched>;

interface Collected {
  parsed: ParsedFile | null;
  catalogue: CatalogueVersion[];
  reconciliation: ReconciliationLine[];
  findings: string[];
}

function listingLine(what: string, listing: LinkListing, entries: number): ReconciliationLine {
  const matched = listing.links.length + listing.refused;
  return {
    what, upstream_rows: matched, artifact_rows: entries, difference: entries - matched,
    explanation: entries === matched
      ? "every listed link that matches this source's rule became exactly one catalogue entry"
      : `${listing.refused} matching link(s) are never stored (a credential-like query, an over-long address or contact-like link text) and were counted, not written`,
  };
}

function needLinks(listing: LinkListing, what: string): void {
  // A listing page that yields no link is a changed page or a partial answer. It is not an empty catalogue.
  if (listing.links.length === 0) throw new ContractError(`${what} yielded no matching link; an empty listing is a fault, not an empty source. The page layout needs a human look`);
}

/**
 * The SHA-256 of the FILE, derived from the decoded text the shared client returns. The client decodes UTF-8 and the
 * decoder drops a leading byte order mark, so the text's hash is not always the file's hash. The logged byte count
 * says which case applies: equal to the text's byte length (the text is the file), three more (a byte order mark
 * was dropped: it is put back before hashing), anything else (the bytes were not clean UTF-8; no file hash is
 * claimed and the release is keyed by the text's own hash instead).
 */
export function fileIdentity(text: string, loggedBytes: number | null): { fileSha256: string | null; releaseKey: string; note: string | null } {
  const textBytes = Buffer.byteLength(text, "utf-8");
  if (loggedBytes === null || loggedBytes === textBytes) {
    const sha = sha256Text(text);
    return { fileSha256: sha, releaseKey: `file-${sha.slice(0, 16)}`, note: null };
  }
  if (loggedBytes === textBytes + 3) {
    const sha = createHash("sha256").update(Buffer.from([0xef, 0xbb, 0xbf])).update(text, "utf-8").digest("hex");
    return { fileSha256: sha, releaseKey: `file-${sha.slice(0, 16)}`, note: "The file starts with a UTF-8 byte order mark, which the decoder drops; the file hash was computed with the mark put back, so it is the hash of the publisher's bytes." };
  }
  return {
    fileSha256: null, releaseKey: `body-${sha256Text(text).slice(0, 16)}`,
    note: "The file's bytes are not the UTF-8 encoding of the decoded text, so the file's own SHA-256 cannot be derived here; no file hash is claimed and the release is keyed by the hash of the decoded text.",
  };
}

function fileContext(plan: StatsSourcePlan, pageUrl: string, fileUrl: string, label: string | null, file: Fetched, findings: string[]): FileContext {
  const identity = fileIdentity(file.text, file.bytes);
  if (identity.note) findings.push(identity.note);
  return {
    sourceId: plan.source_id, publisher: plan.publisher, officialUrl: pageUrl, sourceUrl: fileUrl, vintageLabel: label, releaseKey: identity.releaseKey,
    fileSha256: identity.fileSha256, sourceBytes: file.bytes ?? Buffer.byteLength(file.text, "utf-8"), retrievedAt: file.retrievedAt,
  };
}

const CSV_ACCEPT = "text/csv,text/plain;q=0.9,*/*;q=0.5";

const HANDLERS: { [sourceId: string]: (plan: StatsSourcePlan, get: Get) => Promise<Collected> } = {
  /** P18: the catalogue API's current result set for one organisation. Catalogue metadata only, no observation. */
  stats_rbnz_catalogue: async (plan, get) => {
    const url = LIVE_URLS.stats_rbnz_catalogue;
    const page = await get(url, "application/json");
    const catalogue = parseCkanPackages(page.text, plan.source_id, url, page.retrievedAt);
    return {
      parsed: null, catalogue, findings: [],
      reconciliation: [{ what: "catalogue API results -> catalogue entries", upstream_rows: catalogue.length, artifact_rows: catalogue.length, difference: 0, explanation: "every result of the answer became exactly one catalogue entry" }],
    };
  },

  /** P20: every CSV/ZIP file the listing page names. Listing metadata only: a listing never yields a file hash or a fact. */
  stats_nz_csv_catalogue: async (plan, get) => {
    const url = LIVE_URLS.stats_nz_csv_catalogue;
    const page = await get(url);
    const opts = { hosts: ["www.stats.govt.nz"], include: /\.(csv|zip)$/i };
    const embedded = parseEmbeddedDocuments(page.text, url, opts);
    const anchors = parseLinkListing(page.text, url, opts);
    const known = new Set(embedded.links.map((l) => l.url));
    const listing: LinkListing = { links: [...embedded.links, ...anchors.links.filter((l) => !known.has(l.url))], refused: embedded.refused + anchors.refused };
    needLinks(listing, "the CSV files listing");
    const catalogue = listingEntries(listing.links, {
      sourceId: plan.source_id, foundOnUrl: url, entryKind: "file_metadata", withFormat: true, attributes: { catalogue_title: "CSV files for download" },
      publisherModifiedText: embedded.pageDateText, observedAt: page.retrievedAt,
    });
    // Nothing is left out unseen: documents the page lists in other formats (notes, dictionaries) are counted.
    const everyDocument = parseEmbeddedDocuments(page.text, url, { hosts: opts.hosts, include: /\.[A-Za-z0-9]{1,8}$/ }).links.length;
    const others = everyDocument - embedded.links.length;
    const findings = others > 0 ? [`${others} further document(s) on the listing are in other formats than .csv or .zip (for example notes and data dictionaries) and are outside this source's rule; they were counted, not written.`] : [];
    return { parsed: null, catalogue, findings, reconciliation: [listingLine("listed .csv and .zip links on the publisher's host -> catalogue entries", listing, catalogue.length)] };
  },

  /** P22: the newest "Selected price indexes" CSV named on the listing page, loaded as its own release vintage. */
  stats_nz_selected_series: async (plan, get) => {
    const url = LIVE_URLS.stats_nz_selected_series;
    const page = await get(url);
    const opts = { hosts: ["www.stats.govt.nz"], include: /\.csv$/i };
    const links = [...parseEmbeddedDocuments(page.text, url, opts).links, ...parseLinkListing(page.text, url, opts).links];
    const pick = pickSelectedPriceIndexes(links);
    if (!pick) throw new ContractError("no 'Selected price indexes' CSV link was found on the listing page; the page layout needs a human look");
    const file = await get(pick.link.url, CSV_ACCEPT);
    const findings = [`The file was chosen from ${pick.candidates} 'Selected price indexes' CSV link(s) on the listing by ${pick.basis}.`];
    const parsed = parseStatsNzSeriesCsv(file.text, fileContext(plan, url, pick.link.url, pick.link.text, file, findings));
    return { parsed, catalogue: [], reconciliation: [parsed.reconciliation], findings: [...findings, ...parsed.findings] };
  },

  /** P23: the rental bond data page's file links as catalogue entries, and the regional monthly CSV as observations. */
  stats_tenancy_rental_bonds: async (plan, get) => {
    const url = LIVE_URLS.stats_tenancy_rental_bonds;
    const page = await get(url);
    const listing = parseLinkListing(page.text, url, { hosts: ["www.tenancy.govt.nz"], include: /\.(csv|zip|xlsx)$/i });
    needLinks(listing, "the rental bond data page");
    const catalogue = listingEntries(listing.links, {
      sourceId: plan.source_id, foundOnUrl: url, entryKind: "catalogue_link", withFormat: false, attributes: { topic: "housing_affordability" },
      publisherModifiedText: null, observedAt: page.retrievedAt,
    });
    // The publisher labels the file "By region, ..." under its detailed monthly heading and names it
    // detailed-monthly-region-...csv. Exactly one such link is expected; none or several needs a human look.
    const regional = listing.links.filter((l) => {
      const path = new URL(l.url).pathname;
      return /\.csv$/i.test(path) && (/detailed-monthly-region/i.test(path) || (/detailed monthly/i.test(l.text) && /region/i.test(l.text)));
    });
    if (regional.length !== 1) throw new ContractError(`${regional.length} links on the rental bond data page look like the regional monthly CSV; exactly one is expected. The page layout needs a human look`);
    const file = await get(regional[0].url, CSV_ACCEPT);
    const findings: string[] = [];
    const parsed = parseTenancyRegionCsv(file.text, fileContext(plan, url, regional[0].url, regional[0].text, file, findings));
    return {
      parsed, catalogue, findings: [...findings, ...parsed.findings],
      reconciliation: [parsed.reconciliation, listingLine("listed .csv, .zip and .xlsx links on the publisher's host -> catalogue entries", listing, catalogue.length)],
    };
  },

  /** P11: the data sets and collections index. Links only; no fact is parsed unattended (see the plan's note). */
  stats_healthnz_data: async (plan, get) => {
    const url = LIVE_URLS.stats_healthnz_data;
    const page = await get(url);
    const listing = parseLinkListing(page.text, url, { hosts: ["www.healthnz.govt.nz"], include: /^\/about-us\/health-data\/data-sets-and-collections\/[^/]/ });
    needLinks(listing, "the health data sets index");
    const catalogue = listingEntries(listing.links, {
      sourceId: plan.source_id, foundOnUrl: url, entryKind: "catalogue_link", withFormat: false, attributes: { topic: "health_outcomes_and_access" },
      publisherModifiedText: null, observedAt: page.retrievedAt,
    });
    return { parsed: null, catalogue, findings: [plan.incremental_note], reconciliation: [listingLine("same-host links under the index page's own path -> catalogue entries", listing, catalogue.length)] };
  },

  /** P12: the benefit statistics index. Links only; no fact is parsed unattended (see the plan's note). */
  stats_msd_benefits: async (plan, get) => {
    const url = LIVE_URLS.stats_msd_benefits;
    const page = await get(url);
    // The index's own directory, and the publisher's document store for that same directory (where its workbooks live).
    const listing = parseLinkListing(page.text, url, { hosts: ["www.msd.govt.nz"], include: /^(\/documents)?\/about-msd-and-our-work\/publications-resources\/statistics\/benefit\/[^/]/ });
    needLinks(listing, "the benefit statistics index");
    const catalogue = listingEntries(listing.links, {
      sourceId: plan.source_id, foundOnUrl: url, entryKind: "catalogue_link", withFormat: false, attributes: { topic: "benefits_and_hardship" },
      publisherModifiedText: null, observedAt: page.retrievedAt,
    });
    return { parsed: null, catalogue, findings: [plan.incremental_note], reconciliation: [listingLine("same-host links under the index page's own path and its document store -> catalogue entries", listing, catalogue.length)] };
  },
};

function routeRows(collector: MetaCollector, observations: ObservationRow[]): RouteRow[] {
  const byDataset = new Map<string, number>();
  for (const row of observations) byDataset.set(row.dataset_key, (byDataset.get(row.dataset_key) ?? 0) + 1);
  return [...collector.datasets.values()].map((dataset) => ({
    kind: "route" as const, observation_family: dataset.dataset_key, canonical_route: "operational" as const, overlapping_routes: [],
    upstream_rows_by_route: { operational: byDataset.get(dataset.dataset_key) ?? 0 },
    decision_note: "Fresh anonymous fetch of the publisher's own file, loaded as its own release vintage. No other route was read in this run; the count is this file's observations and is never added to a backfilled vintage.",
  }));
}

/** No location on a disk and no connection string ever leaves in an error summary. */
function sanitize(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]")
    .replace(/(^|[\s"'(=:,])(?:~|[A-Za-z]:)?[\\/](?:[^\s\\/]+[\\/])+[^\s]*/g, "$1[path]")
    .slice(0, 300);
}

function records(log: FetchLogEntry[]): LiveFetchRecord[] {
  return log.map((entry) => ({
    url: entry.url, outcome: entry.outcome, http_status: entry.http_status ?? null, bytes: entry.bytes ?? null, body_sha256: entry.body_sha256 ?? null, retrieved_at: entry.retrieved_at,
  }));
}

export async function fetchSource(plan: StatsSourcePlan, root: string, opts: LiveFetchOptions = {}): Promise<LiveFetchSummary> {
  const say = opts.log ?? (() => undefined);
  const handler = HANDLERS[plan.source_id];
  if (plan.incremental === "none" || !handler || plan.live_hosts.length === 0) {
    return { source_id: plan.source_id, status: "no_incremental_route", reason: plan.incremental_note };
  }
  const now = opts.now ?? (() => new Date());
  const log: FetchLogEntry[] = [];
  const safeFetch = createSafeFetch({
    allowedHosts: plan.live_hosts, log, deadline: now().getTime() + 240_000, timeoutMs: 120_000, minIntervalMs: 2000, maxBytes: 64 * 1024 * 1024,
    // One attempt per address: this route does not re-ask a publisher that did not answer. The operator decides about a re-run.
    maxAttempts: 1, fetchImpl: opts.fetchImpl, now, sleep: opts.sleep,
    // The public-address check uses the real resolver unless the transport itself is a test double.
    resolveHost: opts.resolveHost ?? (opts.fetchImpl ? undefined : nodeResolveHost),
  });
  const collectedAt: string[] = [];
  const get: Get = async (url, accept) => {
    const response = await safeFetch({ url, accept });
    const entry = [...log].reverse().find((e) => e.outcome === "ok" && e.body_sha256 === response.bodySha256 && e.retrieved_at === response.retrievedAt);
    collectedAt.push(response.retrievedAt);
    say(`${plan.source_id}: GET ${url} -> ok, ${entry?.bytes ?? "?"} bytes`);
    return { text: response.text, retrievedAt: response.retrievedAt, bytes: entry?.bytes ?? null, url };
  };

  let collected: Collected;
  try {
    collected = await handler(plan, get);
  } catch (error) {
    if (error instanceof SourceUnavailableError) {
      say(`${plan.source_id}: publisher unavailable (${error.outcome}); nothing was written and nothing is inferred about its records`);
      return { source_id: plan.source_id, status: "blocked", error_class: error.errorClass, error_detail: `${error.outcome}: ${sanitize(error.message)}`, fetches: records(log) };
    }
    const errorClass = error instanceof IngestError ? error.errorClass : error instanceof ContractError ? "contract_error" : "unexpected_error";
    say(`${plan.source_id}: failed (${errorClass}); nothing was written`);
    return { source_id: plan.source_id, status: "failed", error_class: errorClass, error_detail: sanitize(error instanceof Error ? error.message : String(error)), fetches: records(log) };
  }

  const freshRoot = join(root, FRESH_ROOT_SUFFIX);
  try {
    await mkdir(freshRoot, { recursive: true, mode: 0o700 });
    await chmod(freshRoot, 0o700);
    const writer = await ArtifactWriter.open(freshRoot, plan.source_id);
    const observations = collected.parsed?.observations ?? [];
    for (const row of observations) await writer.observation(row);
    const collector = collected.parsed?.collector ?? null;
    const meta: MetaRow[] = [
      ...(collector ? routeRows(collector, observations) : []), ...(collector ? collector.datasets.values() : []), ...(collector ? collector.releases.values() : []),
      ...(collector ? collector.series.values() : []), ...(collector ? collector.geographies.values() : []), ...foldCatalogueVersions(collected.catalogue),
    ];
    const times = [...collectedAt].sort();
    const manifest = await writer.finish(meta, {
      source_id: plan.source_id,
      producer: { route: "fresh_fetch", exporter_version: LIVE_VERSION, recipe_sha256: sha256Text(JSON.stringify({ version: LIVE_VERSION, source_id: plan.source_id, url: LIVE_URLS[plan.source_id as keyof typeof LIVE_URLS] })) },
      collected_from: times[0] ?? null, collected_to: times[times.length - 1] ?? null,
      reconciliation: collected.reconciliation, findings: collected.findings,
    });
    say(`${plan.source_id}: wrote a fresh-fetch artifact (${manifest.counts.observations} observations, ${manifest.counts.catalogue_entries} catalogue entries)`);
    return {
      source_id: plan.source_id, status: "ok", artifact_root_suffix: FRESH_ROOT_SUFFIX, counts: manifest.counts, reconciliation: manifest.reconciliation,
      findings: manifest.findings, fetches: records(log),
    };
  } catch (error) {
    // A partial artifact is worse than none: it is removed and the run reports the failure.
    await rm(join(freshRoot, plan.source_id), { recursive: true, force: true }).catch(() => undefined);
    const errorClass = error instanceof ContractError ? "contract_error" : "artifact_write_error";
    say(`${plan.source_id}: failed while writing (${errorClass}); the partial artifact was removed`);
    return { source_id: plan.source_id, status: "failed", error_class: errorClass, error_detail: sanitize(error instanceof Error ? error.message : String(error)), fetches: records(log) };
  }
}
