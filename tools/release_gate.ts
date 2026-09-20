#!/usr/bin/env node
// R10 release gate for deployable surfaces. Exit 0 only when the named surface's LATEST row in
// REVIEW-REGISTER.md is approved, dated and names a reviewer. A PENDING row, a missing row, a later
// withdrawal or an unnamed reviewer all fail closed. CI runs this before any Pages deployment;
// passing CI never substitutes for the review.
//
//   node tools/release_gate.ts --surface "Evidence explorer"

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RegisterRow {
  date: string;
  surface: string;
  reviewedBy: string;
  redLines: string;
  outcome: string;
  notes: string;
}

/** The only outcomes the register may use. Exactly one of them opens the gate. */
export const APPROVED_OUTCOME = "APPROVED";
export const OUTCOMES = new Set([APPROVED_OUTCOME, "PENDING — NOT REVIEWED", "REJECTED", "WITHDRAWN"]);

const UNNAMED = new Set(["", "not appointed", "tbc", "tbd", "pending", "unknown", "n/a"]);
const plain = (cell: string) => cell.replace(/[*_`]/g, "").trim();

export function registerRows(text: string): RegisterRow[] {
  const rows: RegisterRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.length !== 6 || cells[0].toLowerCase() === "date" || cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    const [date, surface, reviewedBy, redLines, outcome, notes] = cells;
    rows.push({ date, surface, reviewedBy, redLines, outcome, notes });
  }
  return rows;
}

export function unknownOutcomes(text: string): string[] {
  return registerRows(text).map((row) => plain(row.outcome)).filter((outcome) => !OUTCOMES.has(outcome));
}

export function gate(text: string, surface: string): { open: boolean; reason: string } {
  const unknown = unknownOutcomes(text);
  if (unknown.length) return { open: false, reason: `REVIEW-REGISTER.md uses an outcome outside the allowed set: ${unknown.join(" | ")}` };
  const matches = registerRows(text).filter((row) => row.surface.toLowerCase().includes(surface.toLowerCase()));
  const latest = matches.at(-1);
  if (!latest) return { open: false, reason: `no REVIEW-REGISTER.md row for surface '${surface}'` };
  // Exact match only. "APPROVED WITH CONDITIONS", "APPROVED?", "Approved pending sign-off" and the like stay closed.
  if (plain(latest.outcome) !== APPROVED_OUTCOME) {
    return { open: false, reason: `latest row for '${surface}' is not approved: ${latest.outcome}` };
  }
  if (!OUTCOMES.has(plain(latest.outcome))) return { open: false, reason: "unknown outcome" };
  if (UNNAMED.has(plain(latest.reviewedBy).toLowerCase())) return { open: false, reason: `latest row for '${surface}' names no reviewer` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(latest.date)) return { open: false, reason: `latest row for '${surface}' has no ISO date` };
  return { open: true, reason: `approved on ${latest.date} by ${plain(latest.reviewedBy)}` };
}

async function main(argv: string[]): Promise<number> {
  const index = argv.indexOf("--surface");
  const surface = index >= 0 ? argv[index + 1] : undefined;
  if (!surface) {
    console.error('usage: node tools/release_gate.ts --surface "<surface name>"');
    return 2;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = gate(await readFile(resolve(root, "REVIEW-REGISTER.md"), "utf-8"), surface);
  (result.open ? console.log : console.error)((result.open ? "RELEASE GATE OPEN: " : "RELEASE GATE CLOSED: ") + result.reason);
  return result.open ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
