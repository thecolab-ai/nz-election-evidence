// The recorded robots.txt / terms-page check: what it records, and what it must never claim. Scripted publisher, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSource, registrableDomain, termsHostBelongsToPublisher } from "../src/access_check.ts";
import type { SourceConfig } from "../../supabase/functions/_shared/types.ts";

const source: SourceConfig = {
  source_id: "fixture_access", title: "TEST FIXTURE", publisher: "Fixture Publisher", official_url: "https://data.fixture.govt.nz/list?page=1",
  adapter_kind: "live_fetch", adapter_name: "fixture", allowed_hosts: ["data.fixture.govt.nz"], view_scope: "general", snapshot_semantics: "append_only_feed",
  enabled: false, rights_id: "RIGHTS-770", access_basis: "public_page", min_interval_ms: 1000,
};
const rights = { rights_id: "RIGHTS-770", licence_or_terms_url: "https://www.fixture.govt.nz/copyright" };

function publisher(routes: { [url: string]: () => Response }) {
  const requested: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    requested.push(String(url));
    const route = routes[String(url)];
    return route ? route() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, requested };
}
const run = (p: ReturnType<typeof publisher>, r: typeof rights | null = rights) => checkSource(source, r ?? undefined, { fetchImpl: p.impl, sleep: async () => {} });

test("review 7/8: robots.txt and the terms page are recorded with status, size and hash - and the source path itself is never requested", async () => {
  const p = publisher({
    "https://data.fixture.govt.nz/robots.txt": () => new Response("User-agent: *\nDisallow: /private/\nCrawl-delay: 4\n", { status: 200 }),
    "https://www.fixture.govt.nz/robots.txt": () => new Response("", { status: 404 }),
    "https://www.fixture.govt.nz/copyright": () => new Response("<html><h1>TEST FIXTURE Copyright</h1><p>Terms text.</p></html>", { status: 200 }),
  });
  const [robots, terms] = await run(p);
  assert.deepEqual([robots.check_kind, robots.outcome, robots.finding, robots.target_path, robots.crawl_delay_seconds, robots.http_status], ["robots_txt", "retrieved", "path_allowed", "/list?page=1", 4, 200]);
  assert.match(robots.body_sha256!, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual([terms.check_kind, terms.outcome, terms.finding, terms.http_status], ["terms_page", "retrieved", "terms_page_retrieved", 200]);
  assert.match(terms.body_sha256!, /^sha256:[0-9a-f]{64}$/);
  assert.ok(!p.requested.includes(source.official_url), "checking access is not a way to fetch the data");
  assert.ok(!JSON.stringify([robots, terms]).includes("Terms text"), "no page body is kept");
  assert.ok(!Object.keys(terms).some((k) => /approv|permit|review|legal/i.test(k)), "the record has no field that could pass for a legal conclusion");
});

test("review 7: a disallowed path, an unreadable robots.txt and an absent one are three different findings", async () => {
  const disallowed = await run(publisher({ "https://data.fixture.govt.nz/robots.txt": () => new Response("User-agent: *\nDisallow: /\n", { status: 200 }) }), null);
  assert.deepEqual([disallowed[0].finding, disallowed[1].finding, disallowed[1].outcome], ["path_disallowed", "no_terms_url_recorded", "not_attempted"]);
  const challenged = await run(publisher({ "https://data.fixture.govt.nz/robots.txt": () => new Response("<iframe src='/_Incapsula_Resource'></iframe>", { status: 200 }) }), null);
  assert.deepEqual([challenged[0].finding, challenged[0].outcome], ["not_retrievable", "challenge"]);
  const refused = await run(publisher({ "https://data.fixture.govt.nz/robots.txt": () => new Response("no", { status: 403 }) }), null);
  assert.deepEqual([refused[0].finding, refused[0].outcome], ["not_retrievable", "http_error"]);
  const none = await run(publisher({}), null);
  assert.deepEqual([none[0].finding, none[0].outcome], ["no_rules_published", "not_found"]);
});

test("review 8: a terms page behind a bot challenge or a robots.txt disallow is recorded as NOT retrievable, never worked around", async () => {
  const challenge = publisher({
    "https://www.fixture.govt.nz/copyright": () => new Response("<iframe src='/_Incapsula_Resource'></iframe>", { status: 200 }),
  });
  const [, a] = await run(challenge);
  assert.deepEqual([a.finding, a.outcome], ["not_retrievable", "challenge"]);
  assert.equal(challenge.requested.filter((u) => u.endsWith("/copyright")).length, 1, "one attempt, no retry");

  const robotsSaysNo = publisher({
    "https://www.fixture.govt.nz/robots.txt": () => new Response("User-agent: *\nDisallow: /\n", { status: 200 }),
    "https://www.fixture.govt.nz/copyright": () => new Response("should never be requested", { status: 200 }),
  });
  const [, b] = await run(robotsSaysNo);
  assert.deepEqual([b.finding, b.outcome], ["not_retrievable", "robots_disallowed"]);
  assert.ok(!robotsSaysNo.requested.includes("https://www.fixture.govt.nz/copyright"), "the terms page is not fetched against the host's robots.txt either");
});

test("a terms URL on somebody else's domain is not fetched at all", async () => {
  assert.equal(registrableDomain("www3.parliament.nz"), "parliament.nz");
  assert.equal(registrableDomain("www.beehive.govt.nz"), "beehive.govt.nz");
  assert.equal(termsHostBelongsToPublisher("www3.parliament.nz", ["bills.parliament.nz"]), true);
  assert.equal(termsHostBelongsToPublisher("www.dia.govt.nz", ["www.beehive.govt.nz"]), false, "govt.nz is a shared suffix, not one publisher");
  assert.equal(termsHostBelongsToPublisher("parliament.nz.attacker.example", ["www.parliament.nz"]), false);
  const p = publisher({});
  const [, terms] = await run(p, { rights_id: "RIGHTS-770", licence_or_terms_url: "https://terms.elsewhere.example/copyright" });
  assert.deepEqual([terms.finding, terms.outcome], ["no_terms_url_recorded", "not_attempted"]);
  assert.ok(!p.requested.some((u) => u.includes("elsewhere")));
});
