// Regression tests for the PR 8 review of the fetch guard: body-read deadline, header handling on
// cross-origin redirects, per-host pacing, robots.txt. Scripted publisher only; no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSafeFetch, evaluateRobots, parseRobots, robotsPatternMatches, USER_AGENT } from "../../supabase/functions/_shared/http.ts";
import { type FetchLogEntry, IngestError, SourceUnavailableError } from "../../supabase/functions/_shared/types.ts";

const HOSTS = ["a.example.govt.nz", "b.example.govt.nz"];
const ALLOW_ALL = "User-agent: *\nAllow: /\n";

interface Call { url: string; headers: Record<string, string>; method: string }
function publisher(handler: (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>, robots: string | Response = ALLOW_ALL) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), method: init?.method ?? "GET" };
    calls.push(call);
    if (new URL(call.url).pathname === "/robots.txt") return typeof robots === "string" ? new Response(robots, { status: 200 }) : robots.clone();
    return handler(call, init?.signal ?? undefined);
  }) as typeof fetch;
  return { impl, calls, pages: () => calls.filter((c) => !c.url.endsWith("/robots.txt")) };
}

/** A body that sends one byte and then stalls until cancelled. Records whether the stream was cancelled. */
function slowDrip(state: { cancelled: boolean }): Response {
  // The stream itself ignores the abort signal, like a publisher that keeps a socket open: only the
  // client cancelling the reader can end it.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("x")); },
    cancel() { state.cancelled = true; },
  });
  return new Response(stream, { status: 200 });
}

test("review 1: a slow-drip BODY is cut off by the request timeout, the stream is cancelled, and it is logged as a timeout", async () => {
  const state = { cancelled: false };
  const log: FetchLogEntry[] = [];
  const pub = publisher(() => slowDrip(state));
  const safeFetch = createSafeFetch({ allowedHosts: HOSTS, log, deadline: Date.now() + 60_000, timeoutMs: 1000, maxAttempts: 1, minIntervalMs: 0, fetchImpl: pub.impl, sleep: async () => {} });
  const started = Date.now();
  await assert.rejects(safeFetch({ url: "https://a.example.govt.nz/list" }), (e: IngestError) => e.errorClass === "timeout");
  assert.ok(Date.now() - started < 4000, "returned near the timeout, not at the platform wall clock");
  assert.equal(log.at(-1)?.outcome, "timeout");
  assert.equal(state.cancelled, true, "the response stream was cancelled, not left open");
});

test("review 1: the RUN deadline bounds the body read too, even when the per-request timeout is longer", async () => {
  const state = { cancelled: false };
  const log: FetchLogEntry[] = [];
  const pub = publisher(() => slowDrip(state));
  const safeFetch = createSafeFetch({ allowedHosts: HOSTS, log, deadline: Date.now() + 1200, timeoutMs: 30_000, maxAttempts: 3, minIntervalMs: 0, fetchImpl: pub.impl, sleep: async () => {} });
  const started = Date.now();
  await assert.rejects(safeFetch({ url: "https://a.example.govt.nz/list" }), (e: IngestError) => e.errorClass === "timeout");
  assert.ok(Date.now() - started < 4000);
  assert.equal(pub.pages().length, 1, "no retry is started after the run deadline");
  assert.equal(state.cancelled, true);
});

test("review 17: adapter-supplied headers are dropped when a redirect changes origin, and kept on the same origin", async () => {
  const log: FetchLogEntry[] = [];
  const pub = publisher((call) => {
    const url = new URL(call.url);
    if (url.hostname === "a.example.govt.nz" && url.pathname === "/start") return new Response(null, { status: 302, headers: { location: "/same-origin" } });
    if (url.pathname === "/same-origin") return new Response(null, { status: 302, headers: { location: "https://b.example.govt.nz/other" } });
    return new Response("ok", { status: 200 });
  });
  const safeFetch = createSafeFetch({ allowedHosts: HOSTS, log, deadline: Date.now() + 60_000, minIntervalMs: 0, fetchImpl: pub.impl, sleep: async () => {} });
  await safeFetch({ url: "https://a.example.govt.nz/start", headers: { "X-Adapter-Token": "fixture", "Content-Type": "application/json" }, method: "POST", body: "{}" });
  const [first, second, third] = pub.pages();
  assert.equal(first!.headers["x-adapter-token"], "fixture");
  assert.equal(second!.headers["x-adapter-token"], "fixture", "same origin keeps adapter headers");
  assert.equal(third!.headers["x-adapter-token"], undefined, "a different origin gets none of them");
  assert.equal(third!.headers["content-type"], undefined);
  assert.equal(third!.headers["user-agent"], USER_AGENT, "the honest user agent is always sent");
  for (const call of pub.calls) assert.ok(!("origin" in call.headers) && !("referer" in call.headers), "no Origin or Referer is ever sent");
});

test("review 5: requests to one host are paced across the whole run, not only after a failure", async () => {
  const log: FetchLogEntry[] = [];
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const pub = publisher(() => new Response("ok", { status: 200 }));
  const safeFetch = createSafeFetch({
    allowedHosts: HOSTS, log, deadline: clock + 600_000, minIntervalMs: 1500, fetchImpl: pub.impl,
    now: () => new Date(clock), sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  for (let page = 1; page <= 3; page++) { await safeFetch({ url: `https://a.example.govt.nz/list?page=${page}` }); clock += 100; }
  await safeFetch({ url: "https://b.example.govt.nz/list" });
  // robots + 3 pages on host a: three waits of at least (1500 - elapsed); host b is paced separately.
  const hostA = sleeps.filter((ms) => ms >= 1400);
  assert.ok(hostA.length >= 3, `expected pacing waits between requests to the same host, saw ${JSON.stringify(sleeps)}`);
  assert.ok(sleeps.every((ms) => ms <= 1500));
});

test("review 6: robots.txt is fetched once per host, logged, and a disallowed path ends the run as blocked", async () => {
  const log: FetchLogEntry[] = [];
  const pub = publisher(() => new Response("never", { status: 200 }), "User-agent: gsa-crawler\nDisallow: /x\n\nUser-agent: *\nDisallow: /\n");
  const safeFetch = createSafeFetch({ allowedHosts: HOSTS, log, deadline: Date.now() + 60_000, minIntervalMs: 0, fetchImpl: pub.impl, sleep: async () => {} });
  await assert.rejects(safeFetch({ url: "https://a.example.govt.nz/en/members/" }), (e: unknown) => e instanceof SourceUnavailableError && e.errorClass === "publisher_robots_disallowed");
  await assert.rejects(safeFetch({ url: "https://a.example.govt.nz/en/other/" }), SourceUnavailableError);
  assert.equal(pub.pages().length, 0, "the disallowed page was never requested");
  assert.equal(pub.calls.filter((c) => c.url.endsWith("/robots.txt")).length, 1, "robots.txt is fetched once per host per run");
  assert.deepEqual(log.map((l) => l.outcome), ["ok", "robots_disallowed", "robots_disallowed"]);
  assert.ok(log[0]!.url.endsWith("/robots.txt"));
});

test("review 6: robots semantics - our token, wildcard, longest match, Allow beats Disallow on ties, Crawl-delay, 404 and 5xx", async () => {
  const rules = parseRobots("User-agent: nz-election-evidence-ingest\nDisallow: /private/\nAllow: /private/open\nCrawl-delay: 7\n\nUser-agent: *\nDisallow: /\n");
  assert.deepEqual(evaluateRobots(rules, "/list"), { allowed: true, crawlDelaySeconds: 7, group: "nz-election-evidence-ingest" });
  assert.equal(evaluateRobots(rules, "/private/x").allowed, false);
  assert.equal(evaluateRobots(rules, "/private/open/1").allowed, true);
  assert.equal(evaluateRobots(parseRobots("User-agent: *\nDisallow: /*?\nAllow: /\n"), "/feed?page=2").allowed, false, "wildcard patterns are honoured");
  assert.equal(evaluateRobots(parseRobots("User-agent: *\nDisallow:\n"), "/anything").allowed, true, "an empty Disallow allows everything");
  assert.equal(evaluateRobots(parseRobots("User-agent: bingbot\nCrawl-delay: 5\n"), "/x").allowed, true, "no group for us means allowed");

  const log: FetchLogEntry[] = [];
  const missing = publisher(() => new Response("ok", { status: 200 }), new Response("not found", { status: 404 }));
  const okFetch = createSafeFetch({ allowedHosts: HOSTS, log, deadline: Date.now() + 60_000, minIntervalMs: 0, fetchImpl: missing.impl, sleep: async () => {} });
  assert.equal((await okFetch({ url: "https://a.example.govt.nz/list" })).text, "ok", "no robots.txt (404) allows access");

  const broken = publisher(() => new Response("never", { status: 200 }), new Response("error", { status: 503 }));
  const closedFetch = createSafeFetch({ allowedHosts: HOSTS, log, deadline: Date.now() + 60_000, minIntervalMs: 0, maxAttempts: 1, fetchImpl: broken.impl, sleep: async () => {} });
  await assert.rejects(closedFetch({ url: "https://a.example.govt.nz/list" }), (e: unknown) => e instanceof SourceUnavailableError && e.errorClass === "publisher_robots_unavailable");
  assert.equal(broken.pages().length, 0, "an unreadable robots.txt fails closed");
});

test("review 6: Crawl-delay raises the pacing interval, and one longer than the run can afford blocks instead of being ignored", async () => {
  let clock = 5_000_000;
  const sleeps: number[] = [];
  const pub = publisher(() => new Response("ok", { status: 200 }), "User-agent: *\nCrawl-delay: 4\n");
  const safeFetch = createSafeFetch({ allowedHosts: HOSTS, log: [], deadline: clock + 600_000, minIntervalMs: 1000, fetchImpl: pub.impl, now: () => new Date(clock), sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  await safeFetch({ url: "https://a.example.govt.nz/1" });
  await safeFetch({ url: "https://a.example.govt.nz/2" });
  assert.ok(sleeps.some((ms) => ms > 3000 && ms <= 4000), `Crawl-delay of 4s should pace requests, saw ${JSON.stringify(sleeps)}`);

  const greedy = publisher(() => new Response("never", { status: 200 }), "User-agent: *\nCrawl-delay: 600\n");
  const blocked = createSafeFetch({ allowedHosts: HOSTS, log: [], deadline: Date.now() + 60_000, minIntervalMs: 0, fetchImpl: greedy.impl, sleep: async () => {} });
  await assert.rejects(blocked({ url: "https://a.example.govt.nz/1" }), (e: unknown) => e instanceof SourceUnavailableError && e.errorClass === "publisher_robots_crawl_delay_exceeds_budget");
});

test("second review: robots agent groups match our product token only, and wildcard rules match in linear time", () => {
  // A group written for some other agent must not override the publisher's rules for everyone.
  const other = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: ingest\nAllow: /\n\nUser-agent: evidence\nAllow: /\n");
  assert.equal(evaluateRobots(other, "/list").allowed, false);
  // Our token with a version, as publishers sometimes write it, is still ours.
  const versioned = parseRobots("User-agent: *\nAllow: /\n\nUser-agent: nz-election-evidence-ingest/1.0\nDisallow: /\n");
  assert.equal(evaluateRobots(versioned, "/list").allowed, false);
  const exact = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: NZ-Election-Evidence-Ingest\nAllow: /feed\n");
  assert.deepEqual([evaluateRobots(exact, "/feed").allowed, evaluateRobots(exact, "/other").allowed], [true, true], "our own group replaces *, and it only restricts what it names");

  for (const [pattern, path, want] of [
    ["/", "/anything", true], ["/a", "/b", false], ["/*?", "/list?page=2", true], ["/*?", "/list", false], ["/items/", "/items/9", true],
    ["/*.pdf$", "/x/y.pdf", true], ["/*.pdf$", "/x/y.pdf?d=1", false], ["/a*b*c", "/a1b2c3", true], ["/a*b*c$", "/a1b2c3", false], ["/a*b*c$", "/a1b2c", true],
    ["/fish$", "/fish", true], ["/fish$", "/fishing", false], ["/a**b", "/a-b", true], ["/ab$", "/a", false],
  ] as [string, string, boolean][]) assert.equal(robotsPatternMatches(pattern, path), want, pattern + " vs " + path);
  const started = Date.now();
  assert.equal(robotsPatternMatches("/" + "*a".repeat(40) + "$", "/" + "a".repeat(5000) + "b"), false);
  assert.ok(Date.now() - started < 200, "a wildcard-heavy rule cannot stall the run");
});

test("second review: waiting for our turn on a host does not eat the request's own time budget", async () => {
  // Crawl-delay 3 s, request timeout 1 s: before the fix the timer started before the pacing wait and aborted every
  // request after the first without sending it, then reported the publisher as timing out.
  let clock = 0;
  const log: FetchLogEntry[] = [];
  const sent: string[] = [];
  const safeFetch = createSafeFetch({
    allowedHosts: ["slow.fixture.example"], log, deadline: 60_000, timeoutMs: 1000, maxAttempts: 1, minIntervalMs: 1000,
    now: () => new Date(clock), sleep: async (ms) => { clock += ms; },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      sent.push(String(url));
      return new Response(String(url).endsWith("/robots.txt") ? "User-agent: *\nCrawl-delay: 3\n" : "ok", { status: 200 });
    }) as typeof fetch,
  });
  await safeFetch({ url: "https://slow.fixture.example/a" });
  await safeFetch({ url: "https://slow.fixture.example/b" });
  assert.deepEqual(sent.map((u) => new URL(u).pathname), ["/robots.txt", "/a", "/b"]);
  assert.deepEqual(log.map((e) => e.outcome), ["ok", "ok", "ok"]);
  assert.ok(clock >= 3000, "the crawl delay was honoured between the two page requests");
});
