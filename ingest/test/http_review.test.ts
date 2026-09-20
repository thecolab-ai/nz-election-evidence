// Regression tests for the fetch guard: body-read deadline, header handling on cross-origin redirects, per-host
// pacing, and the owner's collection policy of 2026-09-20 (robots.txt is a recorded advisory; only public,
// unauthenticated content is collected; a sign-in, paywall, refusal or bot challenge is final). Scripted publisher only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAllowedUrl, createSafeFetch, evaluateRobots, isNonPublicAddress, parseRobots, robotsPatternMatches, USER_AGENT } from "../../supabase/functions/_shared/http.ts";
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
  await safeFetch({ url: "https://a.example.govt.nz/start", headers: { "X-Adapter-Hint": "fixture", "Content-Type": "application/json" }, method: "POST", body: "{}" });
  const [first, second, third] = pub.pages();
  assert.equal(first!.headers["x-adapter-hint"], "fixture");
  assert.equal(second!.headers["x-adapter-hint"], "fixture", "same origin keeps adapter headers");
  assert.equal(third!.headers["x-adapter-hint"], undefined, "a different origin gets none of them");
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

// Owner collection policy, 2026-09-20: robots.txt is a recorded advisory signal, not an automatic veto. These three tests
// replace the ones written for the PR 8 review, which asserted the opposite (a disallow or an unreadable file blocked).
test("policy: a robots.txt disallow ALONE does not block a public page - it is fetched once per host, recorded, and the page is collected", async () => {
  const log: FetchLogEntry[] = [];
  const pub = publisher(() => new Response("public listing", { status: 200 }), "User-agent: gsa-crawler\nDisallow: /x\n\nUser-agent: *\nDisallow: /\n");
  const safeFetch = createSafeFetch({ allowedHosts: HOSTS, log, deadline: Date.now() + 60_000, minIntervalMs: 0, fetchImpl: pub.impl, sleep: async () => {} });
  assert.equal((await safeFetch({ url: "https://a.example.govt.nz/en/members/" })).text, "public listing");
  assert.equal((await safeFetch({ url: "https://a.example.govt.nz/en/members/" })).text, "public listing");
  assert.equal(pub.calls.filter((c) => c.url.endsWith("/robots.txt")).length, 1, "robots.txt is fetched once per host per run");
  assert.deepEqual(log.map((l) => l.outcome), ["ok", "robots_advisory_disallowed", "ok", "ok"], "the signal is kept in the log, once per URL, next to the request it concerns");
  assert.ok(log[0]!.url.endsWith("/robots.txt") && log[1]!.url.endsWith("/en/members/"));
  for (const call of pub.calls) assert.equal(call.headers["user-agent"], USER_AGENT, "the client identifies itself honestly on every request");
});

test("policy: a missing or UNREADABLE robots.txt alone does not block either, and robots semantics are still evaluated correctly for the record", async () => {
  const rules = parseRobots("User-agent: nz-election-evidence-ingest\nDisallow: /private/\nAllow: /private/open\nCrawl-delay: 7\n\nUser-agent: *\nDisallow: /\n");
  assert.deepEqual(evaluateRobots(rules, "/list"), { allowed: true, crawlDelaySeconds: 7, group: "nz-election-evidence-ingest" });
  assert.equal(evaluateRobots(rules, "/private/x").allowed, false);
  assert.equal(evaluateRobots(rules, "/private/open/1").allowed, true);
  assert.equal(evaluateRobots(parseRobots("User-agent: *\nDisallow: /*?\nAllow: /\n"), "/feed?page=2").allowed, false, "wildcard patterns are evaluated");
  assert.equal(evaluateRobots(parseRobots("User-agent: *\nDisallow:\n"), "/anything").allowed, true, "an empty Disallow allows everything");
  assert.equal(evaluateRobots(parseRobots("User-agent: bingbot\nCrawl-delay: 5\n"), "/x").allowed, true, "no group for us means allowed");

  for (const [robots, expected] of [
    [new Response("not found", { status: 404 }), ["ok", "ok"]],
    [new Response("error", { status: 503 }), ["robots_advisory_unreadable", "robots_advisory_unreadable", "ok"]],
    [new Response("no", { status: 403 }), ["robots_advisory_unreadable", "robots_advisory_unreadable", "ok"]],
    [new Response("<iframe src='/_Incapsula_Resource'></iframe>", { status: 200 }), ["robots_advisory_unreadable", "robots_advisory_unreadable", "ok"]],
  ] as [Response, string[]][]) {
    const log: FetchLogEntry[] = [];
    const pub = publisher(() => new Response("ok", { status: 200 }), robots);
    const safeFetch = createSafeFetch({ allowedHosts: HOSTS, log, deadline: Date.now() + 60_000, minIntervalMs: 0, maxAttempts: 1, fetchImpl: pub.impl, sleep: async () => {} });
    assert.equal((await safeFetch({ url: "https://a.example.govt.nz/list" })).text, "ok");
    assert.deepEqual(log.map((l) => l.outcome), expected, "robots.txt HTTP " + robots.status);
    assert.equal(pub.calls.filter((c) => c.url.endsWith("/robots.txt")).length, 1, "a refused robots.txt is not retried or worked around");
  }
});

test("policy: Crawl-delay is still honoured as pacing; one longer than the cap is recorded and the cap is used, not a block", async () => {
  let clock = 5_000_000;
  const sleeps: number[] = [];
  const pub = publisher(() => new Response("ok", { status: 200 }), "User-agent: *\nCrawl-delay: 4\n");
  const safeFetch = createSafeFetch({ allowedHosts: HOSTS, log: [], deadline: clock + 600_000, minIntervalMs: 1000, fetchImpl: pub.impl, now: () => new Date(clock), sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  await safeFetch({ url: "https://a.example.govt.nz/1" });
  await safeFetch({ url: "https://a.example.govt.nz/2" });
  assert.ok(sleeps.some((ms) => ms > 3000 && ms <= 4000), `Crawl-delay of 4s should pace requests, saw ${JSON.stringify(sleeps)}`);

  const waits: number[] = [];
  const log: FetchLogEntry[] = [];
  const greedy = publisher(() => new Response("ok", { status: 200 }), "User-agent: *\nCrawl-delay: 600\n");
  const capped = createSafeFetch({ allowedHosts: HOSTS, log, deadline: clock + 600_000, minIntervalMs: 0, fetchImpl: greedy.impl, now: () => new Date(clock), sleep: async (ms) => { waits.push(ms); clock += ms; } });
  await capped({ url: "https://a.example.govt.nz/1" });
  await capped({ url: "https://a.example.govt.nz/2" });
  assert.ok(log.some((l) => l.outcome === "robots_advisory_crawl_delay_capped"));
  assert.ok(Math.max(...waits) <= 30_000 && Math.max(...waits) > 29_000, "paced at the 30 s cap, not at 600 s and not at zero");
});

// What the policy did NOT change: only public, unauthenticated content is collected, and a publisher's refusal is final.
test("policy: a sign-in wall, a paywall, a refusal and a bot challenge each end the request as unavailable - one attempt, nothing worked around", async () => {
  const cases: [string, () => Response, string][] = [
    ["HTTP 401", () => new Response("sign in", { status: 401 }), "publisher_login_required"],
    ["WWW-Authenticate on a 200", () => new Response("x", { status: 200, headers: { "www-authenticate": "Basic realm=members" } }), "publisher_login_required"],
    ["a sign-in form served with 200", () => new Response("<html><form action='/session'><input name=u><input type=\"password\" name=p></form></html>", { status: 200, headers: { "content-type": "text/html" } }), "publisher_login_required"],
    ["a redirect to a sign-in address", () => new Response(null, { status: 302, headers: { location: "https://a.example.govt.nz/account/login?next=/list" } }), "publisher_login_required"],
    ["HTTP 402 paywall", () => new Response("subscribe", { status: 402 }), "publisher_paywall"],
    ["HTTP 403", () => new Response("forbidden", { status: 403 }), "publisher_blocked"],
    ["a bot challenge with 200", () => new Response("<iframe src='/_Incapsula_Resource'></iframe>", { status: 200 }), "publisher_challenge"],
    ["a bot challenge with 403", () => new Response("<iframe src='/_Incapsula_Resource'></iframe>", { status: 403 }), "publisher_challenge"],
  ];
  for (const [name, respond, errorClass] of cases) {
    const log: FetchLogEntry[] = [];
    const pub = publisher((call) => (call.url.includes("/account/login") ? new Response("never requested", { status: 200 }) : respond()));
    const safeFetch = createSafeFetch({ allowedHosts: HOSTS, log, deadline: Date.now() + 60_000, minIntervalMs: 0, maxAttempts: 3, fetchImpl: pub.impl, sleep: async () => {} });
    await assert.rejects(safeFetch({ url: "https://a.example.govt.nz/list" }), (e: unknown) => e instanceof SourceUnavailableError && e.errorClass === errorClass, name);
    assert.equal(pub.pages().length, 1, name + ": exactly one request - no retry, and a sign-in address is never requested");
    for (const call of pub.calls) assert.deepEqual(Object.keys(call.headers).filter((h) => /cookie|authorization|origin|referer|token|key/i.test(h)), [], name + ": no credential or site-impersonating header");
  }
  // an ordinary public article that merely mentions signing in is not a login wall
  const article = publisher(() => new Response("<html><p>Members can log in to the portal.</p><p>" + "Public text. ".repeat(50) + "</p></html>", { status: 200, headers: { "content-type": "text/html" } }));
  const ok = createSafeFetch({ allowedHosts: HOSTS, log: [], deadline: Date.now() + 60_000, minIntervalMs: 0, fetchImpl: article.impl, sleep: async () => {} });
  assert.equal((await ok({ url: "https://a.example.govt.nz/news" })).status, 200);
});

test("policy: requests are always anonymous - an adapter cannot send a cookie, a token, an API key or a site-impersonating header", async () => {
  const pub = publisher(() => new Response("ok", { status: 200 }));
  const safeFetch = createSafeFetch({ allowedHosts: HOSTS, log: [], deadline: Date.now() + 60_000, minIntervalMs: 0, fetchImpl: pub.impl, sleep: async () => {} });
  await safeFetch({ url: "https://a.example.govt.nz/api/search", method: "POST", body: "{}", headers: {
    "Content-Type": "application/json", Cookie: "session=abc", Authorization: "Bearer abc", "X-Api-Key": "abc", "X-Auth-Token": "abc", "X-CSRF-Token": "abc",
    "X-Session-Id": "abc", "Proxy-Authorization": "Basic abc", Origin: "https://a.example.govt.nz", Referer: "https://a.example.govt.nz/", "User-Agent": "Mozilla/5.0", "X-Requested-With": "XMLHttpRequest" } });
  const sent = pub.pages()[0]!.headers;
  assert.deepEqual(Object.keys(sent).sort(), ["accept", "content-type", "user-agent"]);
  assert.equal(sent["user-agent"], USER_AGENT);
  assert.match(USER_AGENT, /^nz-election-evidence-ingest\/[\d.]+ \(\+https:\/\/github\.com\//, "identifiable: product token, version and a contact URL");
  assert.match(USER_AGENT, /automated/, "it says it is automated");
  assert.doesNotMatch(USER_AGENT, /mozilla|chrome|safari|gecko|webkit/i, "and never imitates a browser");
  assert.throws(() => assertAllowedUrl("https://user:pw@a.example.govt.nz/list", HOSTS), /credentials in URL/);
});

test("policy: SSRF - an allowlisted NAME that resolves to a private, loopback, link-local or metadata address is refused before any request", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "not-an-address"]) assert.equal(isNonPublicAddress(address), true, address);
  for (const address of ["203.97.1.1", "1.1.1.1", "2404:6800:4006:80a::200e"]) assert.equal(isNonPublicAddress(address), false, address);
  for (const resolveHost of [async () => ["203.97.1.1", "10.0.0.5"], async () => ["169.254.169.254"], async () => [], async () => { throw new Error("SERVFAIL"); }]) {
    const log: FetchLogEntry[] = [];
    const pub = publisher(() => new Response("internal", { status: 200 }));
    const safeFetch = createSafeFetch({ allowedHosts: HOSTS, log, deadline: Date.now() + 60_000, minIntervalMs: 0, maxAttempts: 1, fetchImpl: pub.impl, sleep: async () => {}, resolveHost });
    await assert.rejects(safeFetch({ url: "https://a.example.govt.nz/list" }), (e: IngestError) => e.errorClass === "host_denied");
    assert.equal(pub.calls.length, 0, "nothing was requested, not even robots.txt");
  }
  const pub = publisher(() => new Response("ok", { status: 200 }));
  const fine = createSafeFetch({ allowedHosts: HOSTS, log: [], deadline: Date.now() + 60_000, minIntervalMs: 0, fetchImpl: pub.impl, sleep: async () => {}, resolveHost: async () => ["203.97.1.1"] });
  assert.equal((await fine({ url: "https://a.example.govt.nz/list" })).text, "ok");
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
