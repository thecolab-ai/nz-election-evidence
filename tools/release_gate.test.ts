import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gate, registerRows } from "./release_gate.ts";

const root = new URL("../", import.meta.url);
const HEADER = "| Date | Surface | Reviewed by | Red lines checked | Outcome | Notes |\n|---|---|---|---|---|---|\n";
const row = (date: string, surface: string, by: string, outcome: string) => `| ${date} | ${surface} | ${by} | R1–R10 | ${outcome} | x |\n`;

test("the live register keeps every new surface closed", async () => {
  const text = await readFile(new URL("REVIEW-REGISTER.md", root), "utf-8");
  assert.ok(registerRows(text).length >= 4);
  for (const surface of ["Evidence explorer", "Supabase evidence store"]) {
    const result = gate(text, surface);
    assert.equal(result.open, false, surface);
    assert.match(result.reason, /not approved/);
  }
});

test("missing, pending, unnamed and undated rows fail closed", () => {
  assert.equal(gate(HEADER, "Evidence explorer").open, false);
  assert.equal(gate(HEADER + row("2026-09-20", "Evidence explorer", "Not appointed", "**PENDING — NOT REVIEWED**"), "Evidence explorer").open, false);
  assert.equal(gate(HEADER + row("2026-10-01", "Evidence explorer", "Not appointed", "**APPROVED**"), "Evidence explorer").open, false);
  assert.equal(gate(HEADER + row("soon", "Evidence explorer", "Fixture Reviewer", "**APPROVED**"), "Evidence explorer").open, false);
});

test("the latest row wins, so a later withdrawal closes the gate", () => {
  const text = HEADER + row("2026-10-01", "Evidence explorer", "Fixture Reviewer", "**APPROVED**") + row("2026-10-02", "Evidence explorer", "Fixture Reviewer", "**WITHDRAWN**");
  assert.equal(gate(text, "Evidence explorer").open, false);
});

test("a named, dated approval opens only its own surface", () => {
  const text = HEADER + row("2026-10-01", "Evidence explorer", "Fixture Reviewer", "**APPROVED**");
  assert.deepEqual(gate(text, "Evidence explorer"), { open: true, reason: "approved on 2026-10-01 by Fixture Reviewer" });
  assert.equal(gate(text, "Evidence atlas").open, false);
});

test("only the exact outcome APPROVED opens the gate; near misses and unknown outcomes fail closed", () => {
  for (const outcome of ["**APPROVED WITH CONDITIONS**", "APPROVED?", "Approved", "approved", "**APPROVED** pending legal sign-off", "APPROVED — NOT REVIEWED", "NOT APPROVED", "APPROVEDISH", " "]) {
    const result = gate(HEADER + row("2026-10-01", "Evidence explorer", "Fixture Reviewer", outcome), "Evidence explorer");
    assert.equal(result.open, false, outcome);
  }
  assert.equal(gate(HEADER + row("2026-10-01", "Evidence explorer", "Fixture Reviewer", "**APPROVED**"), "Evidence explorer").open, true);
  // An unknown outcome anywhere in the register closes every gate until it is corrected.
  const mixed = HEADER + row("2026-10-01", "Evidence atlas", "Fixture Reviewer", "SORT OF OK") + row("2026-10-01", "Evidence explorer", "Fixture Reviewer", "**APPROVED**");
  assert.equal(gate(mixed, "Evidence explorer").open, false);
});

test("the files that decide a release are owner-reviewed (CODEOWNERS)", async () => {
  const owners = await readFile(new URL(".github/CODEOWNERS", root), "utf-8");
  for (const path of ["/REVIEW-REGISTER.md", "/RED-LINES.md", "/catalogue/rights-register.json", "/catalogue/rights-register.csv", "/supabase/migrations/", "/supabase/config.toml", "/supabase/functions/", "/tools/", "/scripts/db/", "/scripts/red_lines.py", "/scripts/validate.py", "/.github/workflows/", "/.github/CODEOWNERS", "/web/scripts/"]) {
    assert.match(owners, new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s+@adam91holt\\s*$`, "m"), path);
  }
});
