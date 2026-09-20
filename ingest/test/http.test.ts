// Fetch guard: allowlist, redirects, retries with backoff, refusal and challenge handling, size cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAllowedUrl, backoffDelayMs, createSafeFetch, looksLikeChallenge } from "../../supabase/functions/_shared/http.ts";
import { type FetchLogEntry, IngestError, SourceUnavailableError } from "../../supabase/functions/_shared/types.ts";

const ALLOWED = ["official.example.govt.nz"];
const far = () => Date.now() + 60_000;
/** Log entries for the pages under test; the robots.txt check is logged too and is asserted in http_review.test.ts. */
const pagesOf = (log: FetchLogEntry[]) => log.filter((entry) => !entry.url.endsWith("/robots.txt"));

function scripted(responses: (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    // robots.txt is answered permissively and is not part of the scripted exchange under test.
    if (new URL(String(url)).pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { status: 200 });
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

test("allowlist: only https, exact host, default port, no credentials, no IP literals", () => {
  assert.equal(assertAllowedUrl("https://official.example.govt.nz/a", ALLOWED).hostname, "official.example.govt.nz");
  for (const bad of [
    "http://official.example.govt.nz/a", "https://evil.example/a", "https://official.example.govt.nz.evil.example/a",
    "https://user:pw@official.example.govt.nz/", "https://official.example.govt.nz:8443/", "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data", "https://[::1]/", "https://localhost/", "file:///etc/hosts", "not a url",
  ]) {
    assert.throws(() => assertAllowedUrl(bad, [...ALLOWED, "127.0.0.1", "localhost", "169.254.169.254"]), IngestError, bad);
  }
});

test("a redirect to a host off the allowlist is refused and logged as host_denied", async () => {
  const log: FetchLogEntry[] = [];
  const { impl, calls } = scripted([new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x" } })]);
  const safeFetch = createSafeFetch({ allowedHosts: ALLOWED, log, deadline: far(), minIntervalMs: 0, fetchImpl: impl, sleep: async () => {} });
  await assert.rejects(safeFetch({ url: "https://official.example.govt.nz/start" }), (e: IngestError) => e.errorClass === "host_denied");
  assert.equal(calls.length, 1, "the redirect target was never contacted");
  assert.equal(pagesOf(log)[0]!.outcome, "host_denied");
});

test("a redirect inside the allowlist is followed", async () => {
  const log: FetchLogEntry[] = [];
  const { impl } = scripted([
    new Response(null, { status: 301, headers: { location: "/moved" } }),
    new Response("hello", { status: 200 }),
  ]);
  const safeFetch = createSafeFetch({ allowedHosts: ALLOWED, log, deadline: far(), minIntervalMs: 0, fetchImpl: impl, sleep: async () => {} });
  const res = await safeFetch({ url: "https://official.example.govt.nz/start" });
  assert.equal(res.text, "hello");
  assert.equal(res.finalUrl, "https://official.example.govt.nz/moved");
});

test("5xx and network failures are retried with growing, jittered, bounded delays", async () => {
  const log: FetchLogEntry[] = [];
  const sleeps: number[] = [];
  const { impl } = scripted([new Response("busy", { status: 503 }), new TypeError("socket hang up"), new Response("ok body", { status: 200 })]);
  const safeFetch = createSafeFetch({ allowedHosts: ALLOWED, log, deadline: far(), minIntervalMs: 0, fetchImpl: impl, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, baseDelayMs: 100 });
  const res = await safeFetch({ url: "https://official.example.govt.nz/a" });
  assert.equal(res.text, "ok body");
  assert.deepEqual(pagesOf(log).map((l) => [l.attempt, l.outcome]), [[1, "http_error"], [2, "network_error"], [3, "ok"]]);
  assert.deepEqual(sleeps, [75, 150]);
  assert.ok(backoffDelayMs(10, 1000, () => 1) <= 30000, "delay is capped");
  assert.equal(backoffDelayMs(1, 100, () => 0, 5), 5000, "Retry-After is honoured");
  assert.equal(backoffDelayMs(1, 100, () => 0, 9999), 30000, "Retry-After is capped");
});

test("retries stop at the attempt bound", async () => {
  const log: FetchLogEntry[] = [];
  const { impl, calls } = scripted([new Response("", { status: 500 }), new Response("", { status: 500 }), new Response("", { status: 500 }), new Response("never", { status: 200 })]);
  const safeFetch = createSafeFetch({ allowedHosts: ALLOWED, log, deadline: far(), minIntervalMs: 0, fetchImpl: impl, sleep: async () => {} });
  await assert.rejects(safeFetch({ url: "https://official.example.govt.nz/a" }), (e: IngestError) => e.errorClass === "http_error");
  assert.equal(calls.length, 3);
});

test("HTTP 403 is 'unavailable': not retried, not worked around", async () => {
  const log: FetchLogEntry[] = [];
  const { impl, calls } = scripted([new Response("<iframe src=\"/_Incapsula_Resource?x\"></iframe>", { status: 403 }), new Response("never", { status: 200 })]);
  const safeFetch = createSafeFetch({ allowedHosts: ALLOWED, log, deadline: far(), minIntervalMs: 0, fetchImpl: impl, sleep: async () => {} });
  await assert.rejects(safeFetch({ url: "https://official.example.govt.nz/a" }), (e: unknown) => e instanceof SourceUnavailableError && e.errorClass === "publisher_challenge");
  assert.equal(calls.length, 1);
  assert.equal(pagesOf(log)[0]!.outcome, "challenge");
  assert.equal(pagesOf(log)[0]!.http_status, 403);
});

test("a 200 bot-challenge page is not mistaken for content", async () => {
  const log: FetchLogEntry[] = [];
  const { impl } = scripted([new Response("<html><script>var __uzdbm_1 = 'x';</script></html>", { status: 200 })]);
  const safeFetch = createSafeFetch({ allowedHosts: ALLOWED, log, deadline: far(), minIntervalMs: 0, fetchImpl: impl, sleep: async () => {} });
  await assert.rejects(safeFetch({ url: "https://official.example.govt.nz/a" }), SourceUnavailableError);
  assert.equal(pagesOf(log)[0]!.outcome, "challenge");
  assert.equal(looksLikeChallenge("<table>ordinary listing</table>"), false);
});

test("oversized responses are refused; the log keeps a hash, never a body", async () => {
  const log: FetchLogEntry[] = [];
  const { impl } = scripted([new Response("x".repeat(5000), { status: 200 }), new Response("tiny-body-marker", { status: 200 })]);
  const safeFetch = createSafeFetch({ allowedHosts: ALLOWED, log, deadline: far(), minIntervalMs: 0, fetchImpl: impl, sleep: async () => {}, maxBytes: 1000 });
  await assert.rejects(safeFetch({ url: "https://official.example.govt.nz/big" }), (e: IngestError) => e.errorClass === "too_large");
  await safeFetch({ url: "https://official.example.govt.nz/small" });
  assert.match(pagesOf(log)[1]!.body_sha256 ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(log).includes("tiny-body-marker"));
});

test("no request is made once the run deadline has passed", async () => {
  const log: FetchLogEntry[] = [];
  const { impl, calls } = scripted([new Response("x", { status: 200 })]);
  const safeFetch = createSafeFetch({ allowedHosts: ALLOWED, log, deadline: Date.now() - 1, minIntervalMs: 0, fetchImpl: impl, sleep: async () => {} });
  await assert.rejects(safeFetch({ url: "https://official.example.govt.nz/a" }), (e: IngestError) => e.errorClass === "timeout");
  assert.equal(calls.length, 0);
});
