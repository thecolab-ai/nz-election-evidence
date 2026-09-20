#!/usr/bin/env node
// Records what a publisher's robots.txt and terms page looked like to this client, for every live source.
//
//   node src/access_check.ts [--source <source_id>] [--receipt FILE] [--record]
//
// What this is: PROVENANCE. For each source it retrieves robots.txt (through the same fetch guard the adapters
// use, so with the same honest user agent, pacing and allowlist), evaluates the path the adapter would request,
// and retrieves the public terms page named in the rights register, keeping status, size and a body hash. Page
// bodies are never stored. Under the owner's collection policy (2026-09-20) robots.txt is a recorded advisory: what
// it says is written down here for a person to weigh, and it does not stop a read of a public page.
// What this is NOT: a legal reading, a permission, or a rights review. It fills in no review date and approves
// nothing. Whether the terms permit automated access is for a named person to read and record
// (evidence_private.publisher_terms_reviews). A missing review is reported at activation as an advisory; a recorded
// "not permitted" stops the source (RED-LINES R6).
// --record writes the rows to publisher_access_checks using EVIDENCE_INGEST_DB_URL (scoped worker login).
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { resolveHost } from "./resolve_host.ts";
import { createSafeFetch } from "../../supabase/functions/_shared/http.ts";
import type { FetchLogEntry, SourceConfig, SourcesFile } from "../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../supabase/functions/_shared/sources.config.json" with { type: "json" };

export const TOOL_VERSION = "access_check/1.0.0";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface AccessCheck {
  source_id: string;
  check_kind: "robots_txt" | "terms_page";
  checked_url: string;
  checked_host: string;
  target_path: string | null;
  outcome: "retrieved" | "not_found" | "challenge" | "blocked" | "http_error" | "network_error" | "not_attempted";
  http_status: number | null;
  response_bytes: number | null;
  body_sha256: string | null;
  finding: "path_allowed" | "path_disallowed" | "no_rules_published" | "terms_page_retrieved" | "not_retrievable" | "no_terms_url_recorded";
  crawl_delay_seconds: number | null;
  checked_at: string;
  tool_version: string;
}

export interface RightsRow { rights_id: string; licence_or_terms_url: string }

const NZ_SECOND_LEVELS = new Set(["govt.nz", "co.nz", "org.nz", "net.nz", "ac.nz", "school.nz", "geek.nz", "gen.nz", "kiwi.nz", "maori.nz", "iwi.nz", "mil.nz", "cri.nz", "health.nz"]);

/** The registrable domain of a .nz host: parliament.nz, beehive.govt.nz, elections.nz. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split(".");
  return labels.slice(NZ_SECOND_LEVELS.has(labels.slice(-2).join(".")) ? -3 : -2).join(".");
}

/** A terms page is only fetched from the publisher's own site: a host under the same registrable domain as the source. */
export function termsHostBelongsToPublisher(termsHost: string, allowedHosts: string[]): boolean {
  if (!termsHost.toLowerCase().endsWith(".nz")) return false;
  return allowedHosts.some((host) => registrableDomain(host) === registrableDomain(termsHost));
}

function outcomeOf(entry: FetchLogEntry | undefined): AccessCheck["outcome"] {
  if (!entry) return "network_error";
  if (entry.outcome === "ok") return entry.http_status === 404 || entry.http_status === 410 ? "not_found" : "retrieved";
  if (entry.outcome === "challenge") return "challenge";
  if (entry.outcome === "blocked" || entry.outcome === "login_required" || entry.outcome === "paywall") return "blocked";
  if (entry.outcome === "http_error") return entry.http_status === 404 || entry.http_status === 410 ? "not_found" : "http_error";
  return "network_error";
}

export async function checkSource(source: SourceConfig, rights: RightsRow | undefined, options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date; resolveHost?: (hostname: string) => Promise<string[]> } = {}): Promise<AccessCheck[]> {
  const now = options.now ?? (() => new Date());
  const checks: AccessCheck[] = [];
  const target = new URL(source.official_url);
  const termsUrl = rights?.licence_or_terms_url ? new URL(rights.licence_or_terms_url) : null;
  const termsHostOk = termsUrl !== null && termsHostBelongsToPublisher(termsUrl.hostname, source.allowed_hosts);
  const log: FetchLogEntry[] = [];
  const safeFetch = createSafeFetch({
    allowedHosts: termsHostOk ? [...new Set([...source.allowed_hosts, termsUrl!.hostname])] : source.allowed_hosts,
    log, deadline: now().getTime() + 60_000, maxAttempts: 1, timeoutMs: 15_000, maxBytes: 2_000_000,
    minIntervalMs: source.min_interval_ms, fetchImpl: options.fetchImpl, sleep: options.sleep, resolveHost: options.resolveHost,
  });

  // 1. robots.txt for the path the adapter would request. The path itself is NOT requested.
  const verdict = await safeFetch.inspectRobots(target.toString());
  const robotsEntry = log.find((e) => e.url === new URL("/robots.txt", target).toString());
  checks.push({
    source_id: source.source_id, check_kind: "robots_txt", checked_url: new URL("/robots.txt", target).toString(), checked_host: target.hostname,
    target_path: target.pathname + target.search,
    outcome: verdict.readable ? outcomeOf(robotsEntry) : (robotsEntry?.http_status && robotsEntry.http_status >= 400 ? "http_error" : looksChallenged(robotsEntry) ? "challenge" : "network_error"),
    http_status: robotsEntry?.http_status ?? null, response_bytes: robotsEntry?.bytes ?? null, body_sha256: robotsEntry?.body_sha256 ?? null,
    finding: !verdict.readable ? "not_retrievable" : !verdict.rulesPublished ? "no_rules_published" : verdict.allowed ? "path_allowed" : "path_disallowed",
    crawl_delay_seconds: verdict.crawlDelaySeconds, checked_at: robotsEntry?.retrieved_at ?? now().toISOString(), tool_version: TOOL_VERSION,
  });

  // 2. The public terms page named in the rights register, if any. A sign-in, paywall, refusal or bot challenge ends it
  //    as not retrievable; robots.txt for that host is recorded in the log and is not a veto.
  const base = { source_id: source.source_id, check_kind: "terms_page" as const, target_path: null, crawl_delay_seconds: null, tool_version: TOOL_VERSION };
  if (!termsUrl || !termsHostOk) {
    checks.push({ ...base, checked_url: termsUrl?.toString() ?? source.official_url, checked_host: termsUrl?.hostname ?? target.hostname, outcome: "not_attempted",
      http_status: null, response_bytes: null, body_sha256: null, finding: "no_terms_url_recorded", checked_at: now().toISOString() });
    return checks;
  }
  const before = log.length;
  let retrieved = false;
  try {
    await safeFetch({ url: termsUrl.toString(), accept: "text/html,*/*;q=0.5" });
    retrieved = true;
  } catch { /* the log entry carries the outcome; nothing is retried or worked around */ }
  const entry = log.slice(before).filter((e) => e.url === termsUrl.toString() && !e.outcome.startsWith("robots_advisory")).at(-1);
  checks.push({ ...base, checked_url: termsUrl.toString(), checked_host: termsUrl.hostname, outcome: outcomeOf(entry),
    http_status: entry?.http_status ?? null, response_bytes: entry?.bytes ?? null, body_sha256: entry?.body_sha256 ?? null,
    finding: retrieved && entry?.body_sha256 ? "terms_page_retrieved" : "not_retrievable", checked_at: entry?.retrieved_at ?? now().toISOString() });
  return checks;
}

function looksChallenged(entry: FetchLogEntry | undefined): boolean {
  return entry?.http_status !== undefined && entry.http_status >= 200 && entry.http_status < 300;
}

export async function recordChecks(sql: postgres.Sql, checks: AccessCheck[]): Promise<number> {
  for (const c of checks) {
    await sql`insert into evidence_private.publisher_access_checks
      (source_id, check_kind, checked_url, checked_host, target_path, outcome, http_status, response_bytes, body_sha256, finding, crawl_delay_seconds, checked_at, tool_version)
      values (${c.source_id}, ${c.check_kind}, ${c.checked_url}, ${c.checked_host}, ${c.target_path}, ${c.outcome}, ${c.http_status}, ${c.response_bytes},
              ${c.body_sha256}, ${c.finding}, ${c.crawl_delay_seconds}, ${c.checked_at}, ${c.tool_version})`;
  }
  return checks.length;
}

async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const file = sourcesFile as unknown as SourcesFile;
  const rights = JSON.parse(await readFile(resolve(ROOT, "catalogue/rights-register.json"), "utf-8")) as RightsRow[];
  const only = flag("--source");
  const sources = file.sources.filter((s) => s.adapter_kind === "live_fetch" && (!only || s.source_id === only));
  const all: AccessCheck[] = [];
  for (const source of sources) all.push(...await checkSource(source, rights.find((r) => r.rights_id === source.rights_id), { resolveHost }));
  for (const c of all) console.log(`${c.source_id}\t${c.check_kind}\t${c.outcome}\t${c.http_status ?? "-"}\t${c.finding}\t${c.checked_url}`);
  let recorded = 0;
  if (argv.includes("--record")) {
    const url = process.env.EVIDENCE_INGEST_DB_URL;
    if (!url) throw new Error("EVIDENCE_INGEST_DB_URL is not set");
    const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
    try { recorded = await recordChecks(sql, all); } finally { await sql.end({ timeout: 5 }); }
  }
  const receiptFile = flag("--receipt");
  if (receiptFile) {
    await writeFile(receiptFile, JSON.stringify({
      receipt_version: 1, kind: "publisher_access_checks", tool_version: TOOL_VERSION, recorded_rows: recorded,
      what_this_is: "Machine provenance of robots.txt and terms-page retrievals. Not a legal reading, not a permission, not a rights review.",
      checks: all,
    }, null, 2) + "\n");
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: Error) => { console.error("failed: " + error.message.split("\n")[0]); process.exit(1); });
}
