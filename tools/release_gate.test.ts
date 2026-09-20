import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gate, normaliseSurfaceId, registerRows, rowSurfaceId } from "./release_gate.ts";

const root = new URL("../", import.meta.url);
const HEADER = "| Date | Surface | Reviewed by | Red lines checked | Outcome | Notes |\n|---|---|---|---|---|---|\n";
const row = (date: string, surface: string, by: string, outcome: string) => `| ${date} | ${surface} | ${by} | R1–R10 | ${outcome} | x |\n`;

test("the live register keeps every new surface closed", async () => {
  const text = await readFile(new URL("REVIEW-REGISTER.md", root), "utf-8");
  assert.ok(registerRows(text).length >= 4);
  for (const surface of ["explorer-pages", "evidence-store", "evidence-atlas", "catalogue-readme"]) {
    const result = gate(text, surface);
    assert.equal(result.open, false, surface);
    assert.match(result.reason, /not approved/);
  }
});

test("missing, pending, unnamed and undated rows fail closed", () => {
  assert.equal(gate(HEADER, "explorer-pages").open, false);
  assert.equal(gate(HEADER + row("2026-09-20", "`explorer-pages` — Evidence explorer", "Not appointed", "**PENDING — NOT REVIEWED**"), "explorer-pages").open, false);
  assert.equal(gate(HEADER + row("2026-10-01", "`explorer-pages` — Evidence explorer", "Not appointed", "**APPROVED**"), "explorer-pages").open, false);
  assert.equal(gate(HEADER + row("soon", "`explorer-pages` — Evidence explorer", "Fixture Reviewer", "**APPROVED**"), "explorer-pages").open, false);
});

test("the latest row wins, so a later withdrawal closes the gate", () => {
  const text = HEADER + row("2026-10-01", "`explorer-pages` — Evidence explorer", "Fixture Reviewer", "**APPROVED**") + row("2026-10-02", "`explorer-pages` — Evidence explorer", "Fixture Reviewer", "**WITHDRAWN**");
  assert.equal(gate(text, "explorer-pages").open, false);
});

test("a named, dated approval opens only its own surface", () => {
  const text = HEADER + row("2026-10-01", "`explorer-pages` — Evidence explorer", "Fixture Reviewer", "**APPROVED**");
  assert.deepEqual(gate(text, "explorer-pages"), { open: true, reason: "approved on 2026-10-01 by Fixture Reviewer" });
  assert.equal(gate(text, "evidence-atlas").open, false);
});

test("only the exact outcome APPROVED opens the gate; near misses and unknown outcomes fail closed", () => {
  for (const outcome of ["**APPROVED WITH CONDITIONS**", "APPROVED?", "Approved", "approved", "**APPROVED** pending legal sign-off", "APPROVED — NOT REVIEWED", "NOT APPROVED", "APPROVEDISH", " "]) {
    const result = gate(HEADER + row("2026-10-01", "`explorer-pages` — Evidence explorer", "Fixture Reviewer", outcome), "explorer-pages");
    assert.equal(result.open, false, outcome);
  }
  assert.equal(gate(HEADER + row("2026-10-01", "`explorer-pages` — Evidence explorer", "Fixture Reviewer", "**APPROVED**"), "explorer-pages").open, true);
  // An unknown outcome anywhere in the register closes every gate until it is corrected.
  const mixed = HEADER + row("2026-10-01", "`evidence-atlas` — Evidence atlas", "Fixture Reviewer", "SORT OF OK") + row("2026-10-01", "`explorer-pages` — Evidence explorer", "Fixture Reviewer", "**APPROVED**");
  assert.equal(gate(mixed, "explorer-pages").open, false);
});

test("the files that decide a release are owner-reviewed (CODEOWNERS)", async () => {
  const owners = await readFile(new URL(".github/CODEOWNERS", root), "utf-8");
  for (const path of ["/REVIEW-REGISTER.md", "/RED-LINES.md", "/catalogue/rights-register.json", "/catalogue/rights-register.csv", "/supabase/migrations/", "/supabase/config.toml", "/supabase/functions/", "/tools/", "/scripts/db/", "/scripts/red_lines.py", "/scripts/validate.py", "/.github/workflows/", "/.github/CODEOWNERS", "/web/scripts/",
    "/web/", "/web/src/lib/database.types.ts", "/web/package.json", "/web/package-lock.json", "/ingest/", "/ingest/package.json", "/ingest/package-lock.json",
    "/supabase/functions/deno.json", "/supabase/functions/deno.lock", "/tools/package.json", "/docs/database/"]) {
    assert.match(owners, new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s+@adam91holt\\s*$`, "m"), path);
  }
});

test("surface matching is normalised EXACT equality on a stable id: no substring, prefix or description matching", () => {
  const approved = (surface: string) => HEADER + row("2026-10-01", surface, "Fixture Reviewer", "**APPROVED**");
  // The reviewed bug: a row that merely mentions the surface used to open its gate.
  for (const surface of [
    "`evidence-atlas` — Evidence atlas (not the Evidence explorer, not explorer-pages)",
    "`explorer-pages-v2` — a different surface whose id starts the same way",
    "`my-explorer-pages` — a different surface whose id ends the same way",
    "`explorer` — a prefix of the id",
    "Evidence explorer explorer-pages (no code-formatted id at all)",
    "see `explorer-pages` (id is not the first token)",
  ]) {
    assert.equal(gate(approved(surface) + row("2026-09-20", "`explorer-pages` — Evidence explorer", "Not appointed", "**PENDING — NOT REVIEWED**"), "explorer-pages").open, false, surface);
  }
  assert.equal(gate(approved("`explorer-pages` — Evidence explorer"), "explorer-pages").open, true);
  assert.equal(gate(approved("` Explorer-Pages ` — case and spacing are normalised"), "EXPLORER-PAGES").open, true);
  assert.equal(normaliseSurfaceId("ｅｘｐｌｏｒｅｒ－ｐａｇｅｓ"), "explorer-pages", "compatibility forms are folded before comparison");
  assert.equal(normaliseSurfaceId("explorer pages"), null);
  assert.equal(rowSurfaceId({ date: "", surface: "Evidence explorer", reviewedBy: "", redLines: "", outcome: "", notes: "" }), null);
});

test("an unknown surface id, or any register row without an id, fails closed", () => {
  const good = HEADER + row("2026-10-01", "`explorer-pages` — Evidence explorer", "Fixture Reviewer", "**APPROVED**");
  assert.equal(gate(good, "Evidence explorer").open, false, "a description is not an id");
  assert.equal(gate(good, "anything-else").open, false);
  assert.equal(gate(good + row("2026-10-01", "A row someone added without an id", "Fixture Reviewer", "**APPROVED**"), "explorer-pages").open, false);
});
