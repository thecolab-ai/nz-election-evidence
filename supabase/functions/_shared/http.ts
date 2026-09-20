// Outbound fetch guard for ingestion.
//
//  * HTTPS only, exact-hostname allowlist per source, default port, no credentials in the URL
//  * redirects followed by hand (max 3) and every hop re-checked against the allowlist
//  * IP-literal and single-label hosts refused outright (SSRF hardening)
//  * bounded time, bounded body size, bounded retries with exponential backoff and jitter
//  * 401/403 and bot-challenge interstitials are reported as "unavailable" and never retried
//    in a tight loop, never worked around, and never read as "no records"
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

export const USER_AGENT =
  "nz-election-evidence-ingest/1.0 (+https://github.com/thecolab-ai/nz-election-evidence; public-interest research; honours publisher blocks)";

export interface SafeFetchOptions {
  allowedHosts: string[];
  log: FetchLogEntry[];
  deadline: number;
  timeoutMs?: number;
  maxBytes?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
}

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

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new IngestError("too_large", `response declares ${declared} bytes; cap is ${maxBytes}`);
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new IngestError("too_large", `response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function backoffDelayMs(attempt: number, baseDelayMs: number, random: () => number, retryAfterSeconds?: number): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jittered = exponential / 2 + random() * (exponential / 2);
  const retryAfter = retryAfterSeconds && retryAfterSeconds > 0 ? Math.min(retryAfterSeconds, 30) * 1000 : 0;
  return Math.min(Math.max(jittered, retryAfter), 30000);
}

export function createSafeFetch(options: SafeFetchOptions): SafeFetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 20000;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 750;

  return async function safeFetch(request: SafeFetchRequest): Promise<SafeFetchResponse> {
    const method = request.method ?? "GET";
    let lastError: IngestError = new IngestError("network_error", "no attempt made");

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let currentUrl = request.url;
      const started = now();
      const entry: FetchLogEntry = {
        method,
        url: request.url,
        host: "",
        attempt,
        outcome: "network_error",
        retrieved_at: started.toISOString(),
        duration_ms: 0,
      };
      let retryAfterSeconds: number | undefined;
      let retryable = false;

      try {
        if (now().getTime() >= options.deadline) throw new IngestError("timeout", "run deadline reached before request");
        let response: Response | undefined;
        for (let hop = 0; hop <= 3; hop++) {
          const url = assertAllowedUrl(currentUrl, options.allowedHosts);
          entry.host = url.hostname.toLowerCase();
          const controller = new AbortController();
          const budget = Math.max(1000, Math.min(timeoutMs, options.deadline - now().getTime()));
          const timer = setTimeout(() => controller.abort(), budget);
          try {
            response = await fetchImpl(url.toString(), {
              method: hop === 0 ? method : "GET",
              headers: {
                "User-Agent": USER_AGENT,
                Accept: request.accept ?? "text/html,application/json,application/xml;q=0.9,*/*;q=0.5",
                ...(request.headers ?? {}),
              },
              body: hop === 0 && method === "POST" ? request.body : undefined,
              redirect: "manual",
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
            if (hop === 3) throw new IngestError("http_error", "too many redirects");
            currentUrl = new URL(response.headers.get("location") as string, url).toString();
            await response.body?.cancel();
            continue;
          }
          break;
        }
        if (!response) throw new IngestError("network_error", "no response");

        entry.http_status = response.status;
        const bytes = await readBounded(response, maxBytes);
        entry.bytes = bytes.byteLength;
        const text = new TextDecoder("utf-8").decode(bytes);
        entry.body_sha256 = "sha256:" + (await sha256Hex(text));

        if (response.status === 401 || response.status === 403) {
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

        entry.outcome = "ok";
        entry.duration_ms = now().getTime() - started.getTime();
        options.log.push(entry);
        return {
          status: response.status,
          text,
          bodySha256: entry.body_sha256,
          retrievedAt: entry.retrieved_at,
          finalUrl: currentUrl,
        };
      } catch (error) {
        let ingestError: IngestError;
        if (error instanceof IngestError) {
          ingestError = error;
          if (!(error instanceof SourceUnavailableError) && entry.outcome === "network_error") {
            entry.outcome = (["host_denied", "too_large", "timeout", "http_error"].includes(error.errorClass)
              ? error.errorClass
              : "network_error") as FetchOutcome;
          }
        } else if (error instanceof Error && error.name === "AbortError") {
          entry.outcome = "timeout";
          retryable = true;
          ingestError = new IngestError("timeout", "request timed out");
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
  };
}
