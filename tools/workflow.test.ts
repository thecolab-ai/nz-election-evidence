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
  assert.ok(workflow.includes('node tools/release_gate.ts --surface "Evidence explorer"'));
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
