// Invariants of the CI and Pages workflow, checked as text so no YAML dependency is needed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(new URL("../.github/workflows/explorer.yml", import.meta.url), "utf-8");
const deploy = workflow.slice(workflow.indexOf("\n  deploy:"));

test("least privilege: read-only by default, Pages scopes on the deploy job only, no secrets, no contents:write", () => {
  assert.ok(workflow.includes("permissions:\n  contents: read"));
  assert.ok(deploy.includes("pages: write") && deploy.includes("id-token: write"));
  assert.equal(workflow.split("pages: write").length - 1, 1);
  assert.ok(!workflow.includes("secrets."), "the workflow references no secret at all");
  assert.ok(!workflow.includes("contents: write") && !workflow.includes("pull_request_target"));
});

test("CI before deploy: every check job, the R10 gate, the freeze check and the owner switch", () => {
  assert.ok(deploy.includes("needs: [compliance, tooling, database, web, web-e2e, release-gate]"));
  assert.ok(workflow.includes("node tools/release_gate.ts --surface-id explorer-pages"));
  assert.ok(workflow.includes("scripts/red_lines.py --freeze-check"));
  assert.ok(deploy.includes("vars.PAGES_DEPLOY_ENABLED == 'true'"));
});

test("existing compliance checks are retained unchanged", () => {
  for (const command of ["python3 scripts/validate.py", "python3 scripts/red_lines.py --freeze-check", "python3 -m unittest discover -s tests -v"]) {
    assert.ok(workflow.includes(command), command);
  }
});

test("generated database types are checked for drift, and actions are pinned by commit", () => {
  assert.ok(workflow.includes("npm run types:check"));
  for (const use of workflow.matchAll(/uses: (\S+)/g)) assert.match(use[1], /@[0-9a-f]{40}$/, use[1]);
});

test("the workflow never touches a hosted project", () => {
  for (const forbidden of ["supabase db push", "supabase link", "functions deploy", "supabase secrets", "--linked", "activate_schedule"]) {
    assert.ok(!workflow.includes(forbidden), forbidden);
  }
});

test("no connection string or credential-shaped value in the workflow; integration tests cannot be skipped", () => {
  assert.ok(!/postgres(ql)?:\/\//.test(workflow), "connection strings belong in test/local-stack.ts, not in CI config");
  assert.ok(!workflow.includes("***"));
  assert.ok(workflow.includes('EVIDENCE_TEST_LOCAL_STACK: "1"') && workflow.includes('EVIDENCE_REQUIRE_INTEGRATION: "1"'));
});

test("build and bundle check share one base path", () => {
  const web = workflow.slice(workflow.indexOf("\n  web:"), workflow.indexOf("\n  web-e2e:"));
  assert.equal(web.split("VITE_BASE_PATH").length - 1, 1, "declared once, at job level");
  assert.ok(web.includes("npm run build") && web.includes("npm run check:bundle"));
  assert.ok(!web.includes("check-bundle.ts \""), "no separately supplied base path argument");
});

test("branch-protection recommendations name real check jobs, and keep release approval out of merge requirements", async () => {
  const doc = await readFile(new URL("../docs/database/branch-protection.md", import.meta.url), "utf-8");
  const required = doc.slice(doc.indexOf("## 1."), doc.indexOf("## 2."));
  for (const job of ["compliance", "tooling", "database", "web", "web-e2e"]) {
    const name = new RegExp(`\\n  ${job}:\\n    name: (.+)`).exec(workflow)?.[1];
    assert.ok(name && required.includes("`" + name + "`"), `required checks must list the "${job}" job by its real name`);
  }
  const table = required.slice(0, required.indexOf("**Do not**"));
  assert.ok(!table.includes("R10 release gate") && !table.includes("Deploy explorer shell"), "release and deploy jobs are not merge requirements");
  assert.ok(doc.includes("Nothing here has been applied"))
  assert.match(doc, /protection is \*\*on\*\*/, "the current state is recorded as read, not assumed");
});

test("PR 8: older workflows pin checkout by commit and keep no credentials; the copy scanner and the explicit bootstrap run in CI", async () => {
  for (const name of ["red-lines.yml", "validate.yml"]) {
    const text = await readFile(new URL("../.github/workflows/" + name, import.meta.url), "utf-8");
    for (const use of text.matchAll(/uses: (\S+)/g)) assert.match(use[1], /@[0-9a-f]{40}$/, name + ": " + use[1]);
    assert.ok(text.includes("persist-credentials: false"), name + " leaves no token in the checkout");
    assert.match(text, /permissions:\n  contents: read/, name + " is read-only");
  }
  assert.ok(workflow.includes("node ../tools/red_lines_copy.ts"), "explorer copy is scanned for R1 and R4 wording");
  const bootstrap = workflow.indexOf("node src/local_bootstrap.ts");
  assert.ok(bootstrap > 0 && bootstrap < workflow.indexOf("node --test --test-reporter=spec test/integration.test.ts"), "the login is bootstrapped explicitly, before the integration tests");
  assert.ok(!workflow.includes("seed.sql") && !/password/i.test(workflow.replace(/no password here/g, "")), "no seed path and no password in CI config");
});

test("connected release: public pair only, owner override explicit, the register never the thing that changes", async () => {
  const web = workflow.slice(workflow.indexOf("\n  web:"), workflow.indexOf("\n  web-e2e:"));
  // The only Supabase values in the whole workflow are the two PUBLIC repository variables.
  const references = [...workflow.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1] ?? "").filter((ref) => /supabase/i.test(ref));
  assert.deepEqual([...new Set(references)].sort(), ["vars.EXPLORER_SUPABASE_ANON_KEY", "vars.EXPLORER_SUPABASE_URL"]);
  assert.ok(!/service[_-]?role|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|EVIDENCE_INGEST_DB_URL|EVIDENCE_CRON_SECRET/i.test(workflow), "no privileged Supabase setting is named in CI");
  assert.ok(web.includes("npm run check:bundle -- --require-connected"), "a deployable build must prove it is connected with the public pair");
  // The override is opt-in on the command line, validated on every push, and the deploy still needs every other gate.
  assert.ok(workflow.includes("node tools/release_gate.ts --surface-id explorer-pages --allow-owner-override"));
  assert.ok(workflow.includes("node ../tools/owner_authorization.ts"));
  assert.ok(deploy.includes("vars.PAGES_DEPLOY_ENABLED == 'true'") && deploy.includes("release-gate"));
  assert.ok(workflow.includes("scripts/red_lines.py --freeze-check"), "an owner decision does not lift the election-day freeze");
  const owners = await readFile(new URL("../.github/CODEOWNERS", import.meta.url), "utf-8");
  assert.match(owners, /^\/governance\/\s+@adam91holt\s*$/m, "the owner decision file is owner-reviewed");
});
