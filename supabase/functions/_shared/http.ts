// Outbound fetch guard for ingestion.
//
//  * HTTPS only, exact-hostname allowlist per source, default port, no credentials in the URL
//  * redirects followed by hand (max 3) and every hop re-checked against the allowlist
//  * IP-literal and single-label hosts refused outright (SSRF hardening)
//  * one abort signal per exchange covers connect, headers AND body, firing at the earlier of the request
//    timeout and the run deadline; an aborted body stream is cancelled, never left open
//  * robots.txt is read once per host per run and RECORDED. By owner policy (2026-09-20) it is an advisory signal
//    for a human decision, not an automatic veto: a disallow, an unreadable file or an over-long Crawl-delay is
//    written to the fetch log and the read-only public request still goes ahead. Crawl-delay is honoured as pacing
//    up to a cap. What is collected is decided here; what is PUBLISHED is decided elsewhere (rights, gates).
//  * public, unauthenticated reads only. 401/403, a login wall, a paywall (402) or a bot challenge ends the request
//    as unavailable: never retried in a loop, never worked around, never read as "no records"
//  * every request to a host is paced, success or not; backoff is only for failures
//  * no Origin, Referer, Cookie, Authorization or API-key header is ever sent; adapter headers stay on their own origin
//  * optional DNS check: a hostname that resolves to a private, loopback or link-local address is refused
//  * bounded body size, bounded retries with exponential backoff and jitter
//  * every attempt lands in the fetch log with a body hash, not the body

import { sha256Hex } from "./canonical.ts";
import {
  type FetchLogEntry,
  type FetchOutcome,
  IngestError,
  type SafeFetch,
  type SafeFetchRequest,
  type SafeFetchResponse,
  SourceUnavailableError,
} from "./types.ts";

// Identifiable and honest: product token and version, a contact URL, and a plain statement that this is an AUTOMATED
// client. It never imitates a browser. (Wording note, 2026-09-20: a draft of this string that described what the client
// stops at used the phrase "bot challenge"; one publisher's firewall answers any user agent containing that word with
// a challenge page. The sentence was reworded - the client's identity, its declared automation and its behaviour when
// refused are unchanged, and a challenge is still final: see the 401/403/challenge handling below.)
export const USER_AGENT =
  "nz-election-evidence-ingest/1.1 (+https://github.com/thecolab-ai/nz-election-evidence; automated public-interest research client; public pages only; stops when refused)";

export interface SafeFetchOptions {
  allowedHosts: string[];
  log: FetchLogEntry[];
  deadline: number;
  timeoutMs?: number;
  maxBytes?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Minimum gap between ANY two requests to the same host in this run. robots.txt Crawl-delay can only raise it. */
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  /**
   * Resolves a hostname to its addresses (node:dns in the CLI, Deno.resolveDns in the function). When given, a host
   * that resolves to any private, loopback, link-local or otherwise non-public address is refused before a request
   * is made. A resolver that fails is not treated as "public": the request is refused as host_denied.
   */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export const DEFAULT_MIN_INTERVAL_MS = 1500;
/** Crawl-delay is honoured as pacing up to this cap; a longer one is recorded as an advisory and the cap is used. */
export const MAX_HONOURED_CRAWL_DELAY_MS = 30_000;

const CHALLENGE_MARKERS = [
  "_Incapsula_Resource",
  "SSJSConnectorObj",
  "__uzdbm_",
  "cf-chl-",
  "cf_chl_opt",
  "Request unsuccessful. Incapsula incident",
  "Attention Required! | Cloudflare",
];

export function looksLikeChallenge(body: string): boolean {
  const head = body.slice(0, 20000);
  return CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

/** A page that asks for a sign-in instead of showing content. Short pages only, so an article that mentions logging in is not caught. */
export function looksLikeLoginWall(body: string, contentType: string): boolean {
  if (!/html/i.test(contentType) && !/^\s*<(!doctype|html)/i.test(body)) return false;
  if (body.length > 60000) return false;
  return /<input[^>]+type\s*=\s*["']?password/i.test(body);
}

const LOGIN_PATH = /(^|[/_.-])(login|log-in|signin|sign-in|sso|oauth|authorize|saml|account\/login)([/_.?-]|$)/i;

/** Addresses that are never a public publisher: loopback, private, link-local, CGNAT, multicast, unspecified, ULA, mapped v4. */
export function isNonPublicAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  const v4 = mapped ? mapped[1] : a;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (m) {
    const [o1, o2] = [Number(m[1]), Number(m[2])];
    return o1 === 0 || o1 === 10 || o1 === 127 || (o1 === 100 && o2 >= 64 && o2 <= 127) || (o1 === 169 && o2 === 254) || (o1 === 172 && o2 >= 16 && o2 <= 31)
      || (o1 === 192 && o2 === 168) || (o1 === 192 && o2 === 0) || (o1 === 198 && (o2 === 18 || o2 === 19)) || o1 >= 224;
  }
  if (!a.includes(":")) return true; // not an address we understand: not public
  return a === "::" || a === "::1" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith("64:ff9b:") || a.startsWith("2001:db8:");
}

export function assertAllowedUrl(rawUrl: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new IngestError("host_denied", "not a valid URL");
  }
  if (url.protocol !== "https:") throw new IngestError("host_denied", "only https is allowed");
  if (url.username || url.password) throw new IngestError("host_denied", "credentials in URL are not allowed");
  if (url.port && url.port !== "443") throw new IngestError("host_denied", "non-default port is not allowed");
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || /^[0-9.]+$/.test(host) || host.includes(":") || host.startsWith("[")) {
    throw new IngestError("host_denied", "IP-literal and single-label hosts are not allowed");
  }
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
    throw new IngestError("host_denied", `host ${host} is not on this source's allowlist`);
  }
  return url;
}

/** Reads at most maxBytes. An abort (timeout or run deadline) cancels the stream instead of leaving it open. */
async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new IngestError("too_large", `response declares ${declared} bytes; cap is ${maxBytes}`);
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new DOMException("aborted while reading the body", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new IngestError("too_large", `response exceeded ${maxBytes} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    // Whatever went wrong, the publisher's stream is released rather than held to the platform wall clock.
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// robots.txt -------------------------------------------------------------------------------------------------

/** The product token this client answers to in robots.txt, before falling back to `*`. */
export const ROBOTS_TOKEN = "nz-election-evidence-ingest";

export interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; pattern: string }[];
  crawlDelaySeconds: number | null;
}

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (!line || colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      if (value !== "") current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }
  return groups;
}

/**
 * robots.txt path pattern: `*` matches any run of characters, a trailing `$` anchors the end, otherwise prefix match.
 * Matched piece by piece with indexOf, not with a generated regular expression, so a publisher's rule full of
 * wildcards cannot make matching slow.
 */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  if (!path.startsWith(parts[0])) return false;
  let position = parts[0].length;
  if (parts.length === 1) return anchored ? position === path.length : true;
  for (let index = 1; index < parts.length; index++) {
    const part = parts[index];
    const last = index === parts.length - 1;
    if (last && anchored) return part.length <= path.length - position && path.endsWith(part);
    const found = path.indexOf(part, position);
    if (found < 0) return false;
    position = found + part.length;
  }
  return true;
}

/** RFC 9309: most specific user-agent group, longest matching rule wins, Allow wins a tie, no match allows. */
export function evaluateRobots(groups: RobotsGroup[], pathWithQuery: string): { allowed: boolean; crawlDelaySeconds: number | null; group: string | null } {
  // Our group is one that names our product token: exactly, or followed by a version ("token/1.0"). A substring test
  // would let a group written for some other agent ("ingest", "evidence") override the publisher's `*` rules.
  const mine = groups.filter((g) => g.agents.some((a) => a === ROBOTS_TOKEN || a.startsWith(ROBOTS_TOKEN + "/") || a.startsWith(ROBOTS_TOKEN + " ")));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  if (chosen.length === 0) return { allowed: true, crawlDelaySeconds: null, group: null };
  let best: { allow: boolean; length: number } | null = null;
  let crawlDelay: number | null = null;
  for (const group of chosen) {
    if (group.crawlDelaySeconds !== null) crawlDelay = Math.max(crawlDelay ?? 0, group.crawlDelaySeconds);
    for (const rule of group.rules) {
      if (!robotsPatternMatches(rule.pattern, pathWithQuery)) continue;
      if (!best || rule.pattern.length > best.length || (rule.pattern.length === best.length && rule.allow)) best = { allow: rule.allow, length: rule.pattern.length };
    }
  }
  return { allowed: best ? best.allow : true, crawlDelaySeconds: crawlDelay, group: mine.length ? ROBOTS_TOKEN : "*" };
}

export function backoffDelayMs(attempt: number, baseDelayMs: number, random: () => number, retryAfterSeconds?: number): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jittered = exponential / 2 + random() * (exponential / 2);
  const retryAfter = retryAfterSeconds && retryAfterSeconds > 0 ? Math.min(retryAfterSeconds, 30) * 1000 : 0;
  return Math.min(Math.max(jittered, retryAfter), 30000);
}

interface HostState {
  lastRequestAt: number | null;
  robots: RobotsGroup[] | "unavailable" | null;
  intervalMs: number;
}

/** What robots.txt on a host says about one URL, without requesting that URL. */
export interface RobotsVerdict {
  /** False when robots.txt could not be read (refused, challenged, failing). Recorded; not a veto. */
  readable: boolean;
  /** False when the host publishes no robots.txt (404/410) or an empty one. */
  rulesPublished: boolean;
  allowed: boolean;
  crawlDelaySeconds: number | null;
}
export type InspectingSafeFetch = SafeFetch & { inspectRobots(rawUrl: string): Promise<RobotsVerdict> };

export function createSafeFetch(options: SafeFetchOptions): InspectingSafeFetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 20000;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 750;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const hosts = new Map<string, HostState>();
  const hostState = (host: string): HostState => {
    let state = hosts.get(host);
    if (!state) {
      state = { lastRequestAt: null, robots: null, intervalMs: minIntervalMs };
      hosts.set(host, state);
    }
    return state;
  };

  /** Politeness, not only backoff: every request to a host waits out that host's interval, success or not. */
  async function pace(host: string): Promise<void> {
    const state = hostState(host);
    if (state.lastRequestAt !== null) {
      const wait = state.lastRequestAt + state.intervalMs - now().getTime();
      if (wait > 0) {
        if (now().getTime() + wait >= options.deadline) throw new IngestError("timeout", "run deadline reached while pacing requests to the publisher");
        await sleep(wait);
      }
    }
    state.lastRequestAt = now().getTime();
  }

  /**
   * One network exchange, bounded END TO END: the same abort signal covers connect, headers AND the body,
   * and it fires at the earlier of the request timeout and the run deadline.
   */
  async function exchange(url: URL, init: { method: "GET" | "POST"; headers: { [key: string]: string }; body?: string }): Promise<{ response: Response; bytes: Uint8Array | null }> {
    // Pace FIRST: waiting our turn is not the publisher being slow, so it must not eat the request's own time budget
    // (a 25 s Crawl-delay under a 20 s timeout would otherwise abort every request before it was sent).
    await pace(url.hostname.toLowerCase());
    const budget = Math.min(timeoutMs, options.deadline - now().getTime());
    if (budget <= 0) throw new IngestError("timeout", "run deadline reached before request");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const response = await fetchImpl(url.toString(), { method: init.method, headers: init.headers, body: init.body, redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        await response.body?.cancel().catch(() => undefined);
        return { response, bytes: null };
      }
      return { response, bytes: await readBounded(response, maxBytes, controller.signal) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** robots.txt, once per host per run, through the same guard and into the same log. */
  async function robotsFor(url: URL): Promise<RobotsGroup[] | "unavailable"> {
    const host = url.hostname.toLowerCase();
    const state = hostState(host);
    if (state.robots !== null) return state.robots;
    const robotsUrl = new URL("/robots.txt", url);
    await assertPublicResolution(robotsUrl);
    const started = now();
    const entry: FetchLogEntry = { method: "GET", url: robotsUrl.toString(), host, attempt: 1, outcome: "network_error", retrieved_at: started.toISOString(), duration_ms: 0 };
    try {
      const { response, bytes } = await exchange(robotsUrl, { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "text/plain,*/*;q=0.5" } });
      entry.http_status = response.status;
      const text = bytes ? new TextDecoder("utf-8").decode(bytes) : "";
      if (bytes) {
        entry.bytes = bytes.byteLength;
        entry.body_sha256 = "sha256:" + (await sha256Hex(text));
      }
      if (response.status === 404 || response.status === 410) {
        // RFC 9309: no robots.txt means no restriction.
        entry.outcome = "ok";
        state.robots = [];
      } else if (response.status >= 200 && response.status < 300 && bytes && !looksLikeChallenge(text)) {
        entry.outcome = "ok";
        state.robots = parseRobots(text);
      } else {
        // Redirected, refused, challenged or failing: the rules cannot be read. That fact is recorded as it is.
        entry.outcome = "robots_advisory_unreadable";
        state.robots = "unavailable";
      }
    } catch (error) {
      entry.outcome = error instanceof Error && error.name === "AbortError" ? "timeout" : "robots_advisory_unreadable";
      state.robots = "unavailable";
    }
    entry.duration_ms = now().getTime() - started.getTime();
    options.log.push(entry);
    return state.robots;
  }

  /**
   * robots.txt is a RECORDED ADVISORY, not a veto (owner collection policy, 2026-09-20). Whatever it says about this
   * URL is written to the fetch log once per host and path, for a person to weigh; the read-only public request
   * then proceeds. The one thing acted on automatically is Crawl-delay, as pacing, up to a cap.
   */
  const advised = new Set<string>();
  async function recordRobotsAdvisory(url: URL, method: "GET" | "POST"): Promise<void> {
    const robots = await robotsFor(url);
    const advise = (outcome: FetchOutcome) => {
      const key = outcome + " " + url.toString();
      if (advised.has(key)) return;
      advised.add(key);
      options.log.push({ method, url: url.toString(), host: url.hostname.toLowerCase(), attempt: 1, outcome, retrieved_at: now().toISOString(), duration_ms: 0 });
    };
    if (robots === "unavailable") return advise("robots_advisory_unreadable");
    const verdict = evaluateRobots(robots, url.pathname + url.search);
    if (!verdict.allowed) advise("robots_advisory_disallowed");
    if (verdict.crawlDelaySeconds !== null) {
      const delayMs = verdict.crawlDelaySeconds * 1000;
      if (delayMs > MAX_HONOURED_CRAWL_DELAY_MS) advise("robots_advisory_crawl_delay_capped");
      const state = hostState(url.hostname.toLowerCase());
      state.intervalMs = Math.max(state.intervalMs, Math.min(delayMs, MAX_HONOURED_CRAWL_DELAY_MS));
    }
  }

  /** DNS rebinding and split-horizon guard: an allowlisted NAME must still resolve to public addresses. */
  const resolved = new Set<string>();
  async function assertPublicResolution(url: URL): Promise<void> {
    if (!options.resolveHost) return;
    const host = url.hostname.toLowerCase();
    if (resolved.has(host)) return;
    let addresses: string[];
    try {
      addresses = await options.resolveHost(host);
    } catch {
      throw new IngestError("host_denied", `host ${host} could not be resolved, so it is not treated as public`);
    }
    if (addresses.length === 0 || addresses.some(isNonPublicAddress)) throw new IngestError("host_denied", `host ${host} resolves to a non-public address`);
    resolved.add(host);
  }

  async function inspectRobots(rawUrl: string): Promise<RobotsVerdict> {
    const url = assertAllowedUrl(rawUrl, options.allowedHosts);
    const robots = await robotsFor(url);
    if (robots === "unavailable") return { readable: false, rulesPublished: false, allowed: false, crawlDelaySeconds: null };
    const verdict = evaluateRobots(robots, url.pathname + url.search);
    return { readable: true, rulesPublished: robots.length > 0, allowed: verdict.allowed, crawlDelaySeconds: verdict.crawlDelaySeconds };
  }

  return Object.assign(safeFetch, { inspectRobots });

  async function safeFetch(request: SafeFetchRequest): Promise<SafeFetchResponse> {
    const method = request.method ?? "GET";
    let lastError: IngestError = new IngestError("network_error", "no attempt made");

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let currentUrl = request.url;
      const started = now();
      const entry: FetchLogEntry = { method, url: request.url, host: "", attempt, outcome: "network_error", retrieved_at: started.toISOString(), duration_ms: 0 };
      let retryAfterSeconds: number | undefined;
      let retryable = false;

      try {
        if (now().getTime() >= options.deadline) throw new IngestError("timeout", "run deadline reached before request");
        const origin = assertAllowedUrl(request.url, options.allowedHosts).origin;
        let result: { response: Response; bytes: Uint8Array | null } | undefined;
        for (let hop = 0; hop <= 3; hop++) {
          const url = assertAllowedUrl(currentUrl, options.allowedHosts);
          entry.host = url.hostname.toLowerCase();
          await assertPublicResolution(url);
          // A redirect to a sign-in address is a login wall: stop there, do not request it.
          if (hop > 0 && LOGIN_PATH.test(url.pathname)) {
            entry.outcome = "login_required";
            throw new SourceUnavailableError("login_required", "publisher redirected to a sign-in page; only public pages are collected");
          }
          await recordRobotsAdvisory(url, hop === 0 ? method : "GET");
          // Adapter-supplied headers and the body belong to the origin the adapter addressed. A redirect to any
          // other origin, even an allowlisted one, gets the honest user agent and an Accept header, nothing else.
          const sameOrigin = url.origin === origin;
          const headers: { [key: string]: string } = {
            ...(sameOrigin ? stripForbiddenHeaders(request.headers ?? {}) : {}),
            "User-Agent": USER_AGENT,
            Accept: request.accept ?? "text/html,application/json,application/xml;q=0.9,*/*;q=0.5",
          };
          result = await exchange(url, { method: hop === 0 ? method : "GET", headers, body: hop === 0 && method === "POST" ? request.body : undefined });
          if (result.bytes === null) {
            if (hop === 3) throw new IngestError("http_error", "too many redirects");
            currentUrl = new URL(result.response.headers.get("location") as string, url).toString();
            continue;
          }
          break;
        }
        if (!result || result.bytes === null) throw new IngestError("network_error", "no response");
        const { response, bytes } = result;

        entry.http_status = response.status;
        entry.bytes = bytes.byteLength;
        const text = new TextDecoder("utf-8").decode(bytes);
        entry.body_sha256 = "sha256:" + (await sha256Hex(text));

        // Public, unauthenticated content only. Each of these ends the request as unavailable: no retry, no other
        // header set, no other route tried.
        if (response.status === 401 || response.status === 407 || response.headers.get("www-authenticate")) {
          entry.outcome = "login_required";
          throw new SourceUnavailableError("login_required", `publisher asked for authentication (HTTP ${response.status}); only public pages are collected`);
        }
        if (response.status === 402) {
          entry.outcome = "paywall";
          throw new SourceUnavailableError("paywall", "publisher answered HTTP 402; nothing behind a paywall is collected");
        }
        if (response.status === 403) {
          entry.outcome = looksLikeChallenge(text) ? "challenge" : "blocked";
          throw new SourceUnavailableError(entry.outcome, `publisher answered HTTP ${response.status}`);
        }
        if (response.status === 429 || response.status >= 500) {
          entry.outcome = "http_error";
          retryable = true;
          retryAfterSeconds = Number(response.headers.get("retry-after") ?? "") || undefined;
          throw new IngestError("http_error", `publisher answered HTTP ${response.status}`);
        }
        if (response.status < 200 || response.status >= 300) {
          entry.outcome = "http_error";
          throw new IngestError("http_error", `publisher answered HTTP ${response.status}`);
        }
        if (looksLikeChallenge(text) && text.length < 20000) {
          entry.outcome = "challenge";
          throw new SourceUnavailableError("challenge", "publisher answered with a bot-challenge page instead of content");
        }
        if (looksLikeLoginWall(text, response.headers.get("content-type") ?? "")) {
          entry.outcome = "login_required";
          throw new SourceUnavailableError("login_required", "publisher answered with a sign-in page instead of content; only public pages are collected");
        }

        entry.outcome = "ok";
        entry.duration_ms = now().getTime() - started.getTime();
        options.log.push(entry);
        return { status: response.status, text, bodySha256: entry.body_sha256, retrievedAt: entry.retrieved_at, finalUrl: currentUrl };
      } catch (error) {
        let ingestError: IngestError;
        if (error instanceof IngestError) {
          ingestError = error;
          if (!(error instanceof SourceUnavailableError) && entry.outcome === "network_error") {
            entry.outcome = (["host_denied", "too_large", "timeout", "http_error"].includes(error.errorClass) ? error.errorClass : "network_error") as FetchOutcome;
          }
        } else if (error instanceof Error && error.name === "AbortError") {
          entry.outcome = "timeout";
          // A timeout caused by the run deadline is final; only a per-request timeout may be retried.
          retryable = now().getTime() < options.deadline;
          ingestError = new IngestError("timeout", "request timed out before the response was fully read");
        } else {
          entry.outcome = "network_error";
          retryable = true;
          ingestError = new IngestError("network_error", "network failure contacting publisher");
        }
        entry.duration_ms = now().getTime() - started.getTime();
        options.log.push(entry);
        lastError = ingestError;

        if (!retryable || attempt === maxAttempts) throw ingestError;
        const delay = backoffDelayMs(attempt, baseDelayMs, random, retryAfterSeconds);
        if (now().getTime() + delay >= options.deadline) throw ingestError;
        await sleep(delay);
      }
    }
    throw lastError;
  }
}

/**
 * Headers an adapter may never set. Some would misstate who is calling or where the call came from; the rest carry
 * credentials, and this client only ever makes anonymous requests.
 */
const FORBIDDEN_REQUEST_HEADERS = new Set(["origin", "referer", "user-agent", "cookie", "authorization", "proxy-authorization", "host", "x-forwarded-for",
  "forwarded", "x-api-key", "api-key", "x-auth-token", "x-csrf-token", "x-xsrf-token", "x-requested-with"]);
const CREDENTIAL_HEADER = /(^|-)(auth|token|key|secret|session|cookie|credential|password)s?(-|$)/i;

export function stripForbiddenHeaders(headers: { [key: string]: string }): { [key: string]: string } {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase()) && !CREDENTIAL_HEADER.test(name)));
}
