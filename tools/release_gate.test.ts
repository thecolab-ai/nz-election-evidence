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
