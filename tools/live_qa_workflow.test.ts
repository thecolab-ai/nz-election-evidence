// Invariants of the live Pages QA lane, checked as text so no YAML dependency is needed.
//
// This lane points a real browser at a LIVE deployment. That is only safe while it stays a reader:
// no credential, no write, no deploy scope, and no ability to stand in for the tests that run
// against a disposable database. Each assertion below is one of those conditions.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(new URL("../.github/workflows/live-qa.yml", import.meta.url), "utf-8");
const config = await readFile(new URL("../web/playwright.live.config.ts", import.meta.url), "utf-8");
const spec = await readFile(new URL("../web/e2e-live/live-journey.spec.ts", import.meta.url), "utf-8");

test("it runs on a GitHub-hosted ubuntu runner, never a self-hosted one", () => {
  const runners = [...workflow.matchAll(/runs-on: (.+)/g)].map((m) => (m[1] ?? "").trim());
  assert.deepEqual(runners, ["ubuntu-latest"]);
  assert.ok(!/self-hosted|runs-on:\s*\[/.test(workflow), "no self-hosted label and no runner group");
});

test("least privilege: read-only, no deploy scope, no secret, no credential left in the checkout", () => {
  assert.ok(workflow.includes("permissions:\n  contents: read"));
  assert.ok(!workflow.includes("contents: write") && !workflow.includes("pages: write") && !workflow.includes("id-token: write"));
  assert.ok(!workflow.includes("pull_request_target"), "it never runs with a writable token on a fork's code");
  assert.ok(!workflow.includes("secrets."), "the workflow references no secret at all");
  assert.ok(workflow.includes("persist-credentials: false"));
  // The published bundle already carries the public anon key. This lane supplies no key of its own,
  // public or otherwise, so it cannot be the thing that decides what the site is connected to.
  assert.ok(!/\$\{\{\s*vars\./.test(workflow), "no repository variable is read here");
  assert.ok(!/service[_-]?role|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|ANON_KEY|EVIDENCE_INGEST_DB_URL|EVIDENCE_CRON_SECRET/i.test(workflow));
});

test("it never writes, deploys or touches a hosted project", () => {
  for (const forbidden of ["supabase db push", "supabase link", "functions deploy", "supabase secrets", "--linked", "deploy-pages", "upload-pages-artifact"]) {
    assert.ok(!workflow.includes(forbidden), forbidden);
  }
  for (const forbidden of [".post(", ".patch(", ".delete(", ".insert(", ".upsert(", "signIn", "service_role"]) {
    assert.ok(!spec.includes(forbidden), `the live spec must not ${forbidden}`);
  }
});

test("actions are pinned by commit", () => {
  for (const use of workflow.matchAll(/uses: (\S+)/g)) assert.match(use[1] ?? "", /@[0-9a-f]{40}$/, use[1]);
});

test("the run produces downloadable screenshots, pass or fail, and fails loudly if it produced none", () => {
  const screenshots = workflow.slice(workflow.indexOf("live-journey-screenshots") - 400, workflow.indexOf("live-journey-traces"));
  assert.ok(screenshots.includes("if: always()"), "screenshots are uploaded whether the run passed or failed");
  assert.ok(screenshots.includes("if-no-files-found: error"), "a run that took no screenshot is not a green run");
  assert.ok(workflow.includes("web/test-results/live-screens"));
  assert.ok(spec.includes("live-screens"), "the spec writes into the directory the workflow uploads");
});

test("the live config reads a live site: no local stack, no seeding, no server of its own", () => {
  // Imports, not prose: the comments in that file explain why it shares nothing with the local-stack
  // configs, and a check that reads them as code would forbid it from saying so.
  const imports = [...config.matchAll(/from\s+'([^']+)'/g), ...spec.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? "");
  for (const module of imports) assert.ok(!/playwright\.shared|local-stack|global-setup|e2e\/support/.test(module), module);
  assert.ok(!/\bglobalSetup\b/.test(config), "nothing is seeded before a live run");
  assert.ok(!/\bwebServer\b/.test(config), "there is no server to start: the site is already published");
  assert.match(config, /https:\/\//, "the default target is an https address");
  assert.ok(config.includes("LIVE_BASE_URL"), "the target is overridable without editing a spec");
});

test("both a phone viewport and a desktop viewport are exercised", () => {
  assert.ok(config.includes("name: 'mobile'") && config.includes("name: 'desktop'"));
  assert.ok(config.includes("devices['Pixel 5']"), "a real narrow viewport with touch, not a resized desktop");
});

test("the live spec asserts the journey, not today's figures", () => {
  for (const testId of ["electorate-search", "electorate-option", "home-to-explorer", "known-unknowns", "provenance-publisher", "provenance-source-date", "provenance-retrieved", "loading-state", "data-row"]) {
    assert.ok(spec.includes(testId), testId);
  }
  // A live suite that named a real electorate, party or count would fail the day the store changed,
  // and would be asserting the data rather than the product. The name it uses is read off the page.
  assert.ok(spec.includes("firstElectorate"), "the electorate under test is discovered at run time");
});

test("the local-stack browser lane is untouched: this lane adds to it and replaces none of it", async () => {
  const explorer = await readFile(new URL("../.github/workflows/explorer.yml", import.meta.url), "utf-8");
  for (const command of ["npm run e2e\n", "npm run e2e:pages", "npm run e2e:journey"]) {
    assert.ok(explorer.includes(command), `explorer.yml still runs ${command.trim()}`);
  }
  assert.ok(!explorer.includes("e2e:live"), "the live lane is never a step of the deployment workflow");
  const pkg = JSON.parse(await readFile(new URL("../web/package.json", import.meta.url), "utf-8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["e2e:live"], "playwright test --config playwright.live.config.ts");
  assert.equal(pkg.scripts["e2e"], "playwright test --config playwright.config.ts");
  // The live spec lives outside e2e/, so no local-stack config can pick it up and try to run it
  // without a database - and no change to their testIgnore lists was needed to keep it out.
  assert.ok(config.includes("testDir: './e2e-live'"));
});
