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
 * Field names a `source_fields` decision can never release, whatever the file says: contact data (R7), bodies
 * and copied text (R6), images, and figures, which belong to a figure scope and nowhere else. Kept equal to the
 * database constraint (owner_field_scope_forbidden in the migration) by a test.
 */
export const FORBIDDEN_FIELD =
  /(email|e_mail|phone|mobile|fax|address|postal|contact|twitter|facebook|instagram|linkedin|handle|body|content|html|text|passage|description|summary|excerpt|transcript|portrait|image|photo|donor|birth|gender|ethnic|vote|share|rank|seats|score|confidence|value|pct|percent|total|amount|sample|payload|external_id|external_record_id|publisher_item_id)/;

/**
 * The CLOSED list of column and payload-key names the rule above matches without being the thing it protects:
 * publisher-assigned public identifiers, a date as the publisher printed it, a kind label ('minister' or
 * 'portfolio'), a vote TYPE ('party' or 'candidate'), a sentence about what was entered from a return, and four
 * status words. Every one was read on a loaded store
 * before it was listed. Names, not prefixes. Kept equal to the same list in owner_field_scope_forbidden (tested).
 */
export const SOURCE_FIELD_EXCEPTIONS = [
  "external_id", "external_record_id", "publisher_item_id", "source_date_text",
  "content_kind", "text_extraction_status", "publisher_modified_text",
  "vote_type", "candidate_votes_evidence", "list_rank_evidence", "text_layer_status",
  "transcription_scope", "published_at_text",
] as const;

/**
 * The ONLY fields a statistical_facts scope can name: the number as stored, the number where it cannot be held exactly,
 * the cell as the publisher printed it, and the status that says whether there is a number at all. A closed list, for
 * sources registered as official statistics only. Votes, poll figures, seats and money are not statistical facts here
 * and stay outside every owner scope. Kept equal to the database constraint owner_statistical_fact_tokens (tested).
 */
export const STATISTICAL_FACT_FIELDS = ["value", "value_double", "raw_value", "value_status"] as const;

/**
 * The published figures of an official ELECTION RESULTS product: the counts, shares and seat numbers the official
 * table prints, the status that says whether a number was reported at all, and the two informal/line tallies each
 * electorate summary carries. A closed list. `approved_total` is deliberately absent everywhere: it would be a
 * number read from inside a return document. Kept equal to owner_result_figure_tokens (tested).
 */
export const RESULT_FIGURE_FIELDS = [
  "candidate_informals", "candidate_lines", "candidate_total", "candidate_votes", "candidate_votes_with_informals",
  "electorate_seats", "list_rank", "list_seats", "party_informals", "party_lines", "party_total", "party_vote_share",
  "party_votes", "party_votes_with_informals", "this_route_votes", "total_seats", "value_status", "vote_percent",
  "vote_share", "votes", "votes_counted", "votes_counted_pct", "votes_status",
] as const;

/**
 * The published totals of an official FINANCE RETURNS product: the amounts the Electoral Commission prints on its
 * own public index pages (per candidate and per party, and the list that carries a party's totals with their filing
 * dates), the recorded basis for reading them, the status of each, whether a total was read at all, and whether the
 * return document is a scan. Nothing read from INSIDE a return: no donor, no postal address, no signature, no
 * approved total. Kept equal to owner_finance_figure_tokens (tested).
 */
export const FINANCE_FIGURE_FIELDS = [
  "aggregates", "amount_nzd", "amounts_basis", "donations_as_published_nzd", "expenses_as_published_nzd",
  "is_image_only", "loans_as_published_nzd", "total_status", "value_status",
] as const;

/**
 * The published numbers of a poll, and the payload key that carries them. A closed list, for a source registered
 * as the party-vote poll product only. `methodology_status` is NOT here: it is link metadata for every source at
 * every tier, so the label that says whether a methodology was disclosed always travels with the figure.
 * Kept equal to owner_poll_figure_tokens (tested).
 */
export const POLL_FIGURE_FIELDS = ["value_pct", "value_status", "sample_size", "disclosure_sample_size", "results"] as const;

/**
 * The donation facts a filed return DISCLOSES: the name the return gives for a donor, what that name's status is,
 * which of the law's identity categories the entry falls under, the amount of the entry, and the total the form
 * prints for the part it sits in. A closed list, for a source registered as one of the two return-DISCLOSURE
 * products only - never for the document indexes those disclosures were read from. Nothing on it can hold a
 * location, a contact, a signature or a document: there is no address column in the store to name.
 * Kept equal to owner_donation_fact_tokens (tested).
 */
export const DONATION_FACT_FIELDS = [
  "donor_name_as_published", "donor_name_status", "donor_identity_kind",
  "disclosed_amount_nzd", "disclosed_total_nzd", "disclosed_total_status", "part_total_nzd", "amounts_basis",
] as const;

/**
 * The registry products whose sources may carry a figure scope at all. Kept equal to the literal lists in
 * the migration (owner_scope_guard and evidence_private.source_release), which are checked both when a decision
 * is recorded and every time a release tier is read. Widening this is a migration, never a file edit.
 */
export const FIGURE_REGISTRIES: Record<"official_result_figures" | "official_finance_figures" | "published_poll_figures" | "published_donation_facts", readonly string[]> = {
  official_result_figures: ["election_2023_results"],
  official_finance_figures: ["candidate_finance_returns", "party_finance_returns"],
  published_poll_figures: ["party_vote_polls"],
  published_donation_facts: ["candidate_return_disclosures", "party_return_disclosures"],
};

/** Field scopes, by kind: the closed list of tokens each may name. `source_fields` is the pattern rule instead. */
export const FIGURE_SCOPE_FIELDS: Record<string, readonly string[]> = {
  statistical_facts: STATISTICAL_FACT_FIELDS,
  official_result_figures: RESULT_FIGURE_FIELDS,
  official_finance_figures: FINANCE_FIGURE_FIELDS,
  published_poll_figures: POLL_FIGURE_FIELDS,
  published_donation_facts: DONATION_FACT_FIELDS,
};

const FIGURE_SCOPE_LABEL: Record<string, string> = {
  statistical_facts: "a statistical fact",
  official_result_figures: "an official result figure",
  official_finance_figures: "an official finance figure",
  published_poll_figures: "a published poll figure",
  published_donation_facts: "a donation fact a filed return discloses",
};

/** What the validator needs to know about a registered source to check a field decision against it. */
export interface RegisteredSource { source_id: string; rights_id?: string; view_scope: string; registry_key?: string }

/** Every scope kind that names fields of one source. */
export const FIELD_SCOPES = ["source_fields", "statistical_facts", "official_result_figures", "official_finance_figures", "published_poll_figures", "published_donation_facts"] as const;
type FieldScopeKind = (typeof FIELD_SCOPES)[number];
const isFieldScope = (value: unknown): value is FieldScopeKind => (FIELD_SCOPES as readonly string[]).includes(String(value));

const FIELD_SHAPE = /^[a-z][a-z0-9_]{1,62}$/;
const ID_SHAPE = /^OWNER-AUTH-\d{4}-\d{2}-\d{2}-\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_ID = /^[a-z][a-z0-9_]{2,80}$/;
const RIGHTS_ID = /^RIGHTS-[0-9]{2,}$/;

export type Scope =
  | { scope: "pages_deploy"; surface_id: string }
  | { scope: "public_rows"; surface_id: string }
  | { scope: FieldScopeKind; source_id: string; rights_id: string; fields: string[]; basis: string };

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

// Round trip, so 2026-02-31 (which the parser rolls into March) is not a date.
const isDate = (value: unknown): value is string => typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const text = (value: unknown, min: number): value is string => typeof value === "string" && value.trim().length >= min;
const days = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);

/** Words that would present an owner decision as something it is not. */
const MISREPRESENTS = /\b(legal(ly)? review(ed)? (complete|passed|done)|reviewed and approved|publisher[- ]approved|licen[cs]ed by|licen[cs]e granted|permission granted|rights (approved|cleared)|R10 (approved|complete|satisfied)|R8 (approved|complete|satisfied))\b/i;

/** Every problem with the file. An empty list means it is usable; anything else means NO authorization is in force. */
export function authorizationProblems(doc: unknown, registry?: RegisteredSource[]): string[] {
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
    for (const value of [file.notice, a.statement, a.decided_by_role, a.request_source, a.revoked_reason, ...(Array.isArray(a.departs_from) ? a.departs_from : [])]) {
      if (typeof value === "string" && MISREPRESENTS.test(value)) problems.push(`${at}: wording presents the owner decision as a review, licence or approval`);
    }
    if (!Array.isArray(a.scopes) || a.scopes.length === 0) {
      problems.push(`${at}: scopes must be a non-empty list`);
      continue;
    }
    // One set of source ids per scope kind: a source may hold a descriptive decision and a figure decision, and
    // neither may be recorded twice in one authorization.
    const seenBySource = new Map<string, Set<string>>(FIELD_SCOPES.map((kind) => [kind, new Set<string>()]));
    for (const [j, rawScope] of a.scopes.entries()) {
      const s = rawScope as Partial<Scope> & { [key: string]: unknown };
      const where = `${at}.scopes[${j}]`;
      if (s.scope === "pages_deploy") {
        if (!(DEPLOYABLE_SURFACES as readonly string[]).includes(String(s.surface_id))) problems.push(`${where}: pages_deploy applies to ${DEPLOYABLE_SURFACES.join(", ")} only`);
      } else if (isFieldScope(s.scope)) {
        const kind = s.scope;
        const closed = FIGURE_SCOPE_FIELDS[kind];
        const seen = seenBySource.get(kind) as Set<string>;
        if (typeof s.source_id !== "string" || !SOURCE_ID.test(s.source_id)) problems.push(`${where}: source_id is missing; a field decision is always for ONE source`);
        else if (seen.has(s.source_id)) problems.push(`${where}: second ${kind} decision for ${s.source_id} in one authorization`);
        else seen.add(s.source_id);
        if (typeof s.rights_id !== "string" || !RIGHTS_ID.test(s.rights_id)) problems.push(`${where}: rights_id must name the (still pending) rights row this decision sits beside`);
        if (!text(s.basis, 40)) problems.push(`${where}: basis is missing`);
        else if (MISREPRESENTS.test(String(s.basis))) problems.push(`${where}: basis presents the owner decision as a licence or approval`);
        if (!Array.isArray(s.fields) || s.fields.length === 0) problems.push(`${where}: fields must be a non-empty list; there is no wildcard`);
        else {
          for (const field of s.fields) {
            if (typeof field !== "string" || !FIELD_SHAPE.test(field)) problems.push(`${where}: '${String(field)}' is not a field name (no wildcards or patterns)`);
            else if (closed && !closed.includes(field)) problems.push(`${where}: '${field}' is not ${FIGURE_SCOPE_LABEL[kind]} column (${closed.join(", ")}); descriptive fields belong in a source_fields scope`);
            else if (!closed && !(SOURCE_FIELD_EXCEPTIONS as readonly string[]).includes(field) && FORBIDDEN_FIELD.test(field)) {
              problems.push(`${where}: '${field}' can never be released by a source_fields decision (contact data, bodies, images, figures); a figure belongs in a figure scope`);
            }
          }
          if (new Set(s.fields).size !== s.fields.length) problems.push(`${where}: duplicate field`);
        }
        // With the source registry at hand the decision is checked against the source it names.
        if (registry && typeof s.source_id === "string") {
          const source = registry.find((entry) => entry.source_id === s.source_id);
          if (!source) problems.push(`${where}: ${s.source_id} is not a registered source`);
          else {
            if (source.rights_id !== s.rights_id) problems.push(`${where}: ${s.source_id} is governed by ${source.rights_id ?? "no rights row"}, not ${String(s.rights_id)}`);
            if (kind === "statistical_facts" && (source.view_scope !== "statistics" || source.registry_key !== "statistics")) problems.push(`${where}: ${s.source_id} is not a statistics source; statistical facts can be released for official statistics only`);
            const registries = FIGURE_REGISTRIES[kind as keyof typeof FIGURE_REGISTRIES];
            if (registries && !registries.includes(source.registry_key ?? "")) {
              problems.push(`${where}: ${s.source_id} is registered as ${source.registry_key ?? "no registry product"}; ${kind} can be released only for ${registries.join(", ")}`);
            }
          }
        }
      } else if (s.scope === "public_rows") {
        if (!(ROW_RELEASE_SURFACES as readonly string[]).includes(String(s.surface_id))) problems.push(`${where}: public_rows applies to ${ROW_RELEASE_SURFACES.join(", ")} only`);
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
export function scopesInForce(doc: unknown, today: string, registry?: RegisteredSource[]): InForce[] {
  if (!isDate(today) || authorizationProblems(doc, registry).length) return [];
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
  const registry = (JSON.parse(await readFile(resolve(root, "supabase/functions/_shared/sources.config.json"), "utf-8")) as { sources: RegisteredSource[] }).sources;
  const problems = authorizationProblems(doc, registry);
  if (problems.length) {
    for (const problem of problems) console.error(`owner-authorizations: ${problem}`);
    return 1;
  }
  const inForce = scopesInForce(doc, todayUtc(), registry);
  console.log(`owner-authorizations: valid; ${inForce.length} scope(s) in force today. These are owner decisions, not reviews and not publisher licences.`);
  for (const { authorization, scope } of inForce) {
    const target = scope.scope === "pages_deploy" || scope.scope === "public_rows"
      ? scope.surface_id
      : `${scope.source_id} (${scope.fields.length} fields, beside pending ${scope.rights_id})`;
    console.log(`  ${authorization.authorization_id}  ${scope.scope}  ${target}  until ${authorization.expires_on}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
