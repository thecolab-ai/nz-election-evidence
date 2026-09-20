#!/usr/bin/env node
// Owner authorizations (governance/owner-authorizations.json): the repository owner's own recorded decisions.
// They are a DIFFERENT THING from an R10 review row, an R8 acceptance and a publisher's rights approval, and this
// module never turns one into the other. It validates the file and answers one narrow question: is there a
// current owner decision for exactly this scope? No entry, a lapsed entry, a revoked entry, a malformed file
// or a scope that is merely similar all answer no.
//
//   node tools/owner_authorization.ts            validates the file; prints the scopes in force today

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OWNER_AUTHORIZATIONS_FILE = "governance/owner-authorizations.json";

/** A narrow override lapses. Longer than this needs a new, dated decision. */
export const MAX_DAYS_IN_FORCE = 90;
/** The only surface an owner decision can deploy, and the only product whose rows it can release. */
export const DEPLOYABLE_SURFACES = ["explorer-pages"] as const;
export const ROW_RELEASE_SURFACES = ["evidence-store"] as const;

/**
 * Field names an owner decision can never release, whatever the file says: contact data (R7), bodies and copied
 * text (R6), images, and the figures that need their own R1 look. Kept equal to the database constraint
 * (owner_field_scope_forbidden in the migration) by a test.
 */
export const FORBIDDEN_FIELD =
  /(email|e_mail|phone|mobile|fax|address|postal|contact|twitter|facebook|instagram|linkedin|handle|body|content|html|text|passage|description|summary|excerpt|transcript|portrait|image|photo|donor|birth|gender|ethnic|vote|share|rank|seats|score|confidence|payload|external_id|external_record_id|publisher_item_id)/;

const FIELD_SHAPE = /^[a-z][a-z0-9_]{1,62}$/;
const ID_SHAPE = /^OWNER-AUTH-\d{4}-\d{2}-\d{2}-\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_ID = /^[a-z][a-z0-9_]{2,80}$/;
const RIGHTS_ID = /^RIGHTS-[0-9]{2,}$/;

export type Scope =
  | { scope: "pages_deploy"; surface_id: string }
  | { scope: "public_rows"; surface_id: string }
  | { scope: "source_fields"; source_id: string; rights_id: string; fields: string[]; basis: string };

export interface Authorization {
  authorization_id: string;
  status: "active" | "revoked";
  decided_on: string;
  expires_on: string;
  decided_by: string;
  decided_by_role: string;
  request_source: string;
  statement: string;
  /** The red lines this decision does NOT comply with. Stated, never papered over. */
  departs_from: string[];
  scopes: Scope[];
  not_claimed: string[];
  never_in_scope: string[];
  revoked_on?: string;
  revoked_reason?: string;
}

export interface AuthorizationFile {
  schema_version: 1;
  notice: string;
  authorizations: Authorization[];
}

const isDate = (value: unknown): value is string => typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z"));
const text = (value: unknown, min: number): value is string => typeof value === "string" && value.trim().length >= min;
const days = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);

/** Words that would present an owner decision as something it is not. */
const MISREPRESENTS = /\b(legal(ly)? review(ed)? (complete|passed|done)|reviewed and approved|publisher[- ]approved|licen[cs]ed by|licen[cs]e granted|permission granted|rights (approved|cleared)|R10 (approved|complete|satisfied)|R8 (approved|complete|satisfied))\b/i;

/** Every problem with the file. An empty list means it is usable; anything else means NO authorization is in force. */
export function authorizationProblems(doc: unknown): string[] {
  const problems: string[] = [];
  if (!doc || typeof doc !== "object") return ["not a JSON object"];
  const file = doc as Partial<AuthorizationFile>;
  if (file.schema_version !== 1) problems.push("schema_version must be 1");
  if (!text(file.notice, 80)) problems.push("notice is missing");
  if (!Array.isArray(file.authorizations)) return [...problems, "authorizations must be a list"];
  const seen = new Set<string>();
  for (const [i, raw] of file.authorizations.entries()) {
    const a = raw as Partial<Authorization>;
    const at = `authorizations[${i}]`;
    if (typeof a.authorization_id !== "string" || !ID_SHAPE.test(a.authorization_id)) problems.push(`${at}: authorization_id must look like OWNER-AUTH-YYYY-MM-DD-NN`);
    else if (seen.has(a.authorization_id)) problems.push(`${at}: duplicate authorization_id`);
    else seen.add(a.authorization_id);
    if (a.status !== "active" && a.status !== "revoked") problems.push(`${at}: status must be active or revoked`);
    if (a.status === "revoked" && (!isDate(a.revoked_on) || !text(a.revoked_reason, 10))) problems.push(`${at}: a revoked entry needs revoked_on and revoked_reason`);
    if (!isDate(a.decided_on)) problems.push(`${at}: decided_on must be an ISO date`);
    if (!isDate(a.expires_on)) problems.push(`${at}: expires_on must be an ISO date; an owner override always lapses`);
    if (isDate(a.decided_on) && isDate(a.expires_on)) {
      const span = days(a.decided_on, a.expires_on);
      if (span <= 0) problems.push(`${at}: expires_on must be after decided_on`);
      if (span > MAX_DAYS_IN_FORCE) problems.push(`${at}: in force for ${span} days; the limit is ${MAX_DAYS_IN_FORCE}`);
    }
    if (!text(a.decided_by, 3)) problems.push(`${at}: decided_by must name the owner`);
    if (!text(a.decided_by_role, 5) || !/owner/i.test(a.decided_by_role ?? "")) problems.push(`${at}: decided_by_role must say this is the repository owner`);
    if (!text(a.request_source, 20)) problems.push(`${at}: request_source must say where the owner's request came from`);
    if (!text(a.statement, 40)) problems.push(`${at}: statement is missing`);
    if (!Array.isArray(a.not_claimed) || a.not_claimed.length < 3 || !a.not_claimed.every((line) => text(line, 20))) {
      problems.push(`${at}: not_claimed must state what this decision is not (reviews, accountable person, publisher rights)`);
    } else {
      const joined = a.not_claimed.join(" ");
      for (const [needle, what] of [[/R10/, "the R10 review"], [/R8/, "the R8 role"], [/publisher|licen[cs]e/i, "publisher rights"]] as const) {
        if (!needle.test(joined)) problems.push(`${at}: not_claimed does not mention ${what}`);
      }
    }
    // Deploying or releasing rows ahead of the reviews is a departure from R10 and R8 as written. The file must say so.
    const needsDeparture = Array.isArray(a.scopes) && a.scopes.some((s) => (s as Partial<Scope>).scope === "pages_deploy" || (s as Partial<Scope>).scope === "public_rows");
    const departures = Array.isArray(a.departs_from) ? a.departs_from.filter((line) => text(line, 20)).join(" ") : "";
    if (needsDeparture && !(/R10/.test(departures) && /R8/.test(departures) && /departure/i.test(departures))) {
      problems.push(`${at}: departs_from must state that this decision departs from R10 and R8 as written`);
    }
    if (!Array.isArray(a.never_in_scope) || a.never_in_scope.length === 0) problems.push(`${at}: never_in_scope is missing`);
    for (const value of [a.statement, a.decided_by_role, a.request_source]) {
      if (typeof value === "string" && MISREPRESENTS.test(value)) problems.push(`${at}: wording presents the owner decision as a review, licence or approval`);
    }
    if (!Array.isArray(a.scopes) || a.scopes.length === 0) {
      problems.push(`${at}: scopes must be a non-empty list`);
      continue;
    }
    const sources = new Set<string>();
    for (const [j, rawScope] of a.scopes.entries()) {
      const s = rawScope as Partial<Scope> & { [key: string]: unknown };
      const where = `${at}.scopes[${j}]`;
      if (s.scope === "pages_deploy") {
        if (!(DEPLOYABLE_SURFACES as readonly string[]).includes(String(s.surface_id))) problems.push(`${where}: pages_deploy applies to ${DEPLOYABLE_SURFACES.join(", ")} only`);
      } else if (s.scope === "public_rows") {
        if (!(ROW_RELEASE_SURFACES as readonly string[]).includes(String(s.surface_id))) problems.push(`${where}: public_rows applies to ${ROW_RELEASE_SURFACES.join(", ")} only`);
      } else if (s.scope === "source_fields") {
        if (typeof s.source_id !== "string" || !SOURCE_ID.test(s.source_id)) problems.push(`${where}: source_id is missing; a field decision is always for ONE source`);
        else if (sources.has(s.source_id)) problems.push(`${where}: second field decision for ${s.source_id} in one authorization`);
        else sources.add(s.source_id);
        if (typeof s.rights_id !== "string" || !RIGHTS_ID.test(s.rights_id)) problems.push(`${where}: rights_id must name the (still pending) rights row this decision sits beside`);
        if (!text(s.basis, 40)) problems.push(`${where}: basis is missing`);
        else if (MISREPRESENTS.test(String(s.basis))) problems.push(`${where}: basis presents the owner decision as a licence or approval`);
        if (!Array.isArray(s.fields) || s.fields.length === 0) problems.push(`${where}: fields must be a non-empty list; there is no wildcard`);
        else {
          for (const field of s.fields) {
            if (typeof field !== "string" || !FIELD_SHAPE.test(field)) problems.push(`${where}: '${String(field)}' is not a field name (no wildcards or patterns)`);
            else if (FORBIDDEN_FIELD.test(field)) problems.push(`${where}: '${field}' can never be released by an owner decision (contact data, bodies, images, figures, publisher identifiers)`);
          }
          if (new Set(s.fields).size !== s.fields.length) problems.push(`${where}: duplicate field`);
        }
      } else {
        problems.push(`${where}: unknown scope '${String(s.scope)}'`);
      }
    }
  }
  return problems;
}

export interface InForce {
  authorization: Authorization;
  scope: Scope;
}

/** Scopes in force on `today` (ISO date, UTC). A file with ANY problem has none in force. */
export function scopesInForce(doc: unknown, today: string): InForce[] {
  if (!isDate(today) || authorizationProblems(doc).length) return [];
  return (doc as AuthorizationFile).authorizations
    .filter((a) => a.status === "active" && a.decided_on <= today && today <= a.expires_on)
    .flatMap((authorization) => authorization.scopes.map((scope) => ({ authorization, scope })));
}

/** Exact match on scope kind AND surface id. Nothing is inferred from a neighbouring scope. */
export function deployAuthorization(doc: unknown, surfaceId: string, today: string): Authorization | null {
  return scopesInForce(doc, today).find((entry) => entry.scope.scope === "pages_deploy" && entry.scope.surface_id === surfaceId)?.authorization ?? null;
}

export const todayUtc = (now: Date = new Date()) => now.toISOString().slice(0, 10);

export async function readAuthorizationFile(root: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolve(root, OWNER_AUTHORIZATIONS_FILE), "utf-8"));
  } catch {
    return null; // absent or unreadable: no authorization
  }
}

async function main(): Promise<number> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const doc = await readAuthorizationFile(root);
  const problems = authorizationProblems(doc);
  if (problems.length) {
    for (const problem of problems) console.error(`owner-authorizations: ${problem}`);
    return 1;
  }
  const inForce = scopesInForce(doc, todayUtc());
  console.log(`owner-authorizations: valid; ${inForce.length} scope(s) in force today. These are owner decisions, not reviews and not publisher licences.`);
  for (const { authorization, scope } of inForce) {
    const target = scope.scope === "source_fields" ? `${scope.source_id} (${scope.fields.length} fields, beside pending ${scope.rights_id})` : scope.surface_id;
    console.log(`  ${authorization.authorization_id}  ${scope.scope}  ${target}  until ${authorization.expires_on}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
