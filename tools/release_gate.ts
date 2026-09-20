#!/usr/bin/env node
// R10 release gate for deployable surfaces. Exit 0 only when the LATEST row carrying that surface's stable id in
// REVIEW-REGISTER.md is approved, dated and names a reviewer. A PENDING row, a missing row, a later
// withdrawal or an unnamed reviewer all fail closed. CI runs this before any Pages deployment;
// passing CI never substitutes for the review.
//
// OWNER OVERRIDE (only with --allow-owner-override). The repository owner may decide to deploy ahead of the review.
// That is a separate, dated, expiring decision recorded in governance/owner-authorizations.json. It does not edit,
// satisfy or stand in for the register: the row stays PENDING, the output says so, and the result carries
// basis "owner_override", never "review_approved". It applies only while the latest register row is PENDING:
// a REJECTED or WITHDRAWN review, an unknown outcome or a malformed register stays closed whatever the owner file says.
//
//   node tools/release_gate.ts --surface-id explorer-pages
//   node tools/release_gate.ts --surface-id explorer-pages --allow-owner-override

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizationProblems, deployAuthorization, readAuthorizationFile, todayUtc } from "./owner_authorization.ts";

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

/** The deployable surfaces this repository knows. A gate can only be asked about one of these ids. */
export const SURFACE_IDS = ["catalogue-readme", "evidence-atlas", "explorer-pages", "evidence-store"] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];

const ID_SHAPE = /^[a-z][a-z0-9-]{2,40}$/;

/** NFKC, lower case, trimmed. Anything that is not then a plain id is no id at all. */
export function normaliseSurfaceId(value: string): string | null {
  const id = value.normalize("NFKC").trim().toLowerCase();
  return ID_SHAPE.test(id) ? id : null;
}

/**
 * The stable id of a register row: the FIRST code-formatted token of the Surface cell, e.g.
 * "`explorer-pages` — Evidence explorer (...)". The human description after it is never used for matching,
 * so a row cannot open a gate by mentioning another surface's name. A row without an id matches nothing.
 */
export function rowSurfaceId(row: RegisterRow): string | null {
  const match = /^\s*`([^`]+)`/.exec(row.surface);
  return match ? normaliseSurfaceId(match[1] ?? "") : null;
}

export function gate(text: string, surfaceId: string): { open: boolean; reason: string } {
  const wanted = normaliseSurfaceId(surfaceId);
  if (!wanted || !(SURFACE_IDS as readonly string[]).includes(wanted)) return { open: false, reason: `'${surfaceId}' is not a known surface id (${SURFACE_IDS.join(", ")})` };
  const unknown = unknownOutcomes(text);
  if (unknown.length) return { open: false, reason: `REVIEW-REGISTER.md uses an outcome outside the allowed set: ${unknown.join(" | ")}` };
  const rows = registerRows(text);
  const unidentified = rows.filter((row) => rowSurfaceId(row) === null);
  if (unidentified.length) return { open: false, reason: `${unidentified.length} REVIEW-REGISTER.md row(s) carry no stable surface id; every row needs one` };
  // Normalised EXACT equality on the id. No substring, prefix or description matching.
  const latest = rows.filter((row) => rowSurfaceId(row) === wanted).at(-1);
  if (!latest) return { open: false, reason: `no REVIEW-REGISTER.md row for surface id '${wanted}'` };
  // Exact outcome only. "APPROVED WITH CONDITIONS", "APPROVED?", "Approved pending sign-off" and the like stay closed.
  if (plain(latest.outcome) !== APPROVED_OUTCOME) return { open: false, reason: `latest row for '${wanted}' is not approved: ${latest.outcome}` };
  if (UNNAMED.has(plain(latest.reviewedBy).toLowerCase())) return { open: false, reason: `latest row for '${wanted}' names no reviewer` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(latest.date)) return { open: false, reason: `latest row for '${wanted}' has no ISO date` };
  return { open: true, reason: `approved on ${latest.date} by ${plain(latest.reviewedBy)}` };
}

export const PENDING_OUTCOME = "PENDING — NOT REVIEWED";

export interface GateDecision {
  open: boolean;
  /** How the gate opened. An owner override is never reported as a review. */
  basis: "review_approved" | "owner_override" | "none";
  reason: string;
}

/**
 * The gate with the owner override considered. The register is asked first and wins whenever it is approved.
 * Otherwise the override applies only if: the register is well formed, the latest row for this surface exists and is
 * exactly PENDING, and the owner file is valid and holds a pages_deploy scope for exactly this surface in force today.
 */
export function gateWithOwnerOverride(registerText: string, surfaceId: string, ownerFile: unknown, today: string): GateDecision {
  const review = gate(registerText, surfaceId);
  if (review.open) return { open: true, basis: "review_approved", reason: review.reason };
  const closed = (reason: string): GateDecision => ({ open: false, basis: "none", reason });
  const wanted = normaliseSurfaceId(surfaceId);
  if (!wanted || !(SURFACE_IDS as readonly string[]).includes(wanted)) return closed(review.reason);
  if (unknownOutcomes(registerText).length) return closed(review.reason);
  const rows = registerRows(registerText);
  if (rows.some((row) => rowSurfaceId(row) === null)) return closed(review.reason);
  const latest = rows.filter((row) => rowSurfaceId(row) === wanted).at(-1);
  if (!latest) return closed(review.reason);
  if (plain(latest.outcome) !== PENDING_OUTCOME) return closed(`${review.reason}; an owner override cannot stand against a recorded ${plain(latest.outcome)} review`);
  if (ownerFile === null || ownerFile === undefined) return closed(`${review.reason}; no owner authorization file`);
  const problems = authorizationProblems(ownerFile);
  if (problems.length) return closed(`${review.reason}; owner authorization file is invalid (${problems[0]})`);
  const authorization = deployAuthorization(ownerFile, wanted, today);
  if (!authorization) return closed(`${review.reason}; no owner authorization in force today for pages_deploy of '${wanted}'`);
  return {
    open: true,
    basis: "owner_override",
    reason: `owner decision ${authorization.authorization_id} of ${authorization.decided_on} (in force until ${authorization.expires_on}). ` +
      `The independent review of '${wanted}' is still PENDING and is not replaced by this decision`,
  };
}

async function main(argv: string[]): Promise<number> {
  const index = argv.indexOf("--surface-id");
  const surface = index >= 0 ? argv[index + 1] : undefined;
  if (!surface) {
    console.error(`usage: node tools/release_gate.ts --surface-id <${SURFACE_IDS.join("|")}> [--allow-owner-override]`);
    return 2;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const register = await readFile(resolve(root, "REVIEW-REGISTER.md"), "utf-8");
  if (!argv.includes("--allow-owner-override")) {
    const result = gate(register, surface);
    (result.open ? console.log : console.error)((result.open ? "RELEASE GATE OPEN: " : "RELEASE GATE CLOSED: ") + result.reason);
    return result.open ? 0 : 1;
  }
  const decision = gateWithOwnerOverride(register, surface, await readAuthorizationFile(root), todayUtc());
  const head = !decision.open ? "RELEASE GATE CLOSED: " : decision.basis === "owner_override" ? "RELEASE GATE OPEN BY OWNER OVERRIDE (NOT A REVIEW): " : "RELEASE GATE OPEN: ";
  (decision.open ? console.log : console.error)(head + decision.reason);
  return decision.open ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
