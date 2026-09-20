import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { authorizationProblems, deployAuthorization, FORBIDDEN_FIELD, MAX_DAYS_IN_FORCE, type RegisteredSource, scopesInForce, STATISTICAL_FACT_FIELDS, type AuthorizationFile } from "./owner_authorization.ts";
import { gate, gateWithOwnerOverride, registerRows, unparsedRegisterLines } from "./release_gate.ts";

const root = new URL("../", import.meta.url);
const HEADER = "| Date | Surface | Reviewed by | Red lines checked | Outcome | Notes |\n|---|---|---|---|---|---|\n";
const row = (surface: string, by: string, outcome: string, date = "2026-09-20") => `| ${date} | \`${surface}\` — x | ${by} | R1–R10 | ${outcome} | x |\n`;
const PENDING = HEADER + row("explorer-pages", "Not appointed", "**PENDING — NOT REVIEWED**") + row("evidence-store", "Not appointed", "**PENDING — NOT REVIEWED**");

function fixture(patch: (file: AuthorizationFile) => void = () => {}): AuthorizationFile {
  const file: AuthorizationFile = {
    schema_version: 1,
    notice: "TEST FIXTURE. Owner decisions only: not an R10 review, not an R8 acceptance and not a licence from any publisher.",
    authorizations: [{
      authorization_id: "OWNER-AUTH-2026-09-20-01",
      status: "active",
      decided_on: "2026-09-20",
      expires_on: "2026-11-06",
      decided_by: "Fixture Owner",
      decided_by_role: "repository owner",
      request_source: "TEST FIXTURE: owner request over a messaging app, relayed",
      statement: "TEST FIXTURE: the owner authorizes deployment and listed fields ahead of the reviews.",
      departs_from: ["TEST FIXTURE: a departure from R10 as written; no review exists.", "TEST FIXTURE: a departure from R8 as written; nobody accepted the role."],
      scopes: [
        { scope: "pages_deploy", surface_id: "explorer-pages" },
        { scope: "public_rows", surface_id: "evidence-store" },
        { scope: "source_fields", source_id: "fixture_source", rights_id: "RIGHTS-13", fields: ["name_at_source", "party_label"], basis: "TEST FIXTURE: name and party as listed by the publisher, with the link." },
      ],
      not_claimed: ["No independent legal review exists (R10) for this.", "Nobody has accepted the R8 accountable role.", "No publisher licence or permission is claimed."],
      never_in_scope: ["bodies", "contact details"],
    }],
  };
  patch(file);
  return file;
}

test("the committed owner file is valid, is the owner's decision, and approves nothing in either register", async () => {
  const doc = JSON.parse(await readFile(new URL("governance/owner-authorizations.json", root), "utf-8")) as AuthorizationFile;
  assert.deepEqual(authorizationProblems(doc), []);
  // Each entry says how the owner's request reached the build, and that the message itself is not held here.
  for (const a of doc.authorizations) assert.match(a.request_source, /(Telegram|relayed).*not held in this repository/s);

  // The review register is untouched: every row pending, nobody appointed, and the plain gate stays closed.
  const register = await readFile(new URL("REVIEW-REGISTER.md", root), "utf-8");
  for (const r of registerRows(register)) {
    assert.match(r.outcome, /PENDING — NOT REVIEWED/);
    assert.equal(r.reviewedBy, "Not appointed");
  }
  assert.equal(gate(register, "explorer-pages").open, false);

  // The rights register is untouched: every row an owner field decision sits beside is still pending and link-only.
  const rights = JSON.parse(await readFile(new URL("catalogue/rights-register.json", root), "utf-8")) as { rights_id: string; review_status: string; default_release: string; reviewed_on: string }[];
  assert.ok(rights.every((r) => r.review_status === "pending" && r.default_release === "link-only" && r.reviewed_on === ""));
  const sources = JSON.parse(await readFile(new URL("supabase/functions/_shared/sources.config.json", root), "utf-8")) as { sources: { source_id: string; rights_id?: string }[] };
  for (const a of doc.authorizations) {
    for (const s of a.scopes) {
      if (s.scope !== "source_fields") continue;
      const source = sources.sources.find((x) => x.source_id === s.source_id);
      assert.ok(source, `${s.source_id} is a configured source`);
      assert.equal(source.rights_id, s.rights_id, `${s.source_id} names its real rights row`);
    }
  }
});

test("narrow override: opens only the named surface, only with the flag's function, and says it is not a review", () => {
  const open = gateWithOwnerOverride(PENDING, "explorer-pages", fixture(), "2026-09-21");
  assert.equal(open.open, true);
  assert.equal(open.basis, "owner_override");
  assert.match(open.reason, /still PENDING/);
  assert.doesNotMatch(open.reason, /approved/i);
  // The plain gate, which is what runs without --allow-owner-override, is unmoved by the owner file.
  assert.equal(gate(PENDING, "explorer-pages").open, false);
  // No other surface is opened by this decision. public_rows is a database scope, never a deployment.
  for (const other of ["evidence-store", "evidence-atlas", "catalogue-readme", "not-a-surface"]) {
    assert.equal(gateWithOwnerOverride(PENDING + row("evidence-atlas", "Not appointed", "**PENDING — NOT REVIEWED**") + row("catalogue-readme", "Not appointed", "**PENDING — NOT REVIEWED**"), other, fixture(), "2026-09-21").open, false, other);
  }
});

test("absent authorization: no file, no scope, not yet in force, lapsed, or revoked all stay closed", () => {
  const closed = (file: unknown, today = "2026-09-21") => gateWithOwnerOverride(PENDING, "explorer-pages", file, today);
  assert.equal(closed(null).open, false);
  assert.match(closed(null).reason, /no owner authorization file/);
  assert.equal(closed({}).open, false);
  assert.equal(closed(fixture((f) => { f.authorizations = []; })).open, false);
  assert.equal(closed(fixture((f) => { f.authorizations[0]!.scopes = f.authorizations[0]!.scopes.filter((s) => s.scope !== "pages_deploy"); })).open, false);
  assert.equal(closed(fixture(), "2026-09-19").open, false, "before the decision date");
  assert.equal(closed(fixture(), "2026-11-07").open, false, "after expiry");
  assert.equal(closed(fixture(), "2026-11-06").open, true, "last day in force");
  assert.equal(closed(fixture((f) => { Object.assign(f.authorizations[0]!, { status: "revoked", revoked_on: "2026-09-21", revoked_reason: "TEST FIXTURE: owner withdrew it" }); })).open, false);
  assert.equal(closed(fixture(), "not-a-date").open, false);
});

test("a review always wins: an owner override cannot stand against REJECTED, WITHDRAWN, a missing row or a malformed register", () => {
  for (const outcome of ["**REJECTED**", "**WITHDRAWN**"]) {
    const text = PENDING + row("explorer-pages", "Fixture Reviewer", outcome, "2026-09-25");
    const result = gateWithOwnerOverride(text, "explorer-pages", fixture(), "2026-09-26");
    assert.equal(result.open, false, outcome);
    assert.match(result.reason, /cannot stand against/);
  }
  assert.equal(gateWithOwnerOverride(HEADER, "explorer-pages", fixture(), "2026-09-21").open, false, "no row at all");
  assert.equal(gateWithOwnerOverride(PENDING + row("explorer-pages", "x", "**APPROVED BY OWNER**"), "explorer-pages", fixture(), "2026-09-21").open, false, "unknown outcome");
  assert.equal(gateWithOwnerOverride(PENDING + "| 2026-09-20 | no id | x | R1 | **PENDING — NOT REVIEWED** | x |\n", "explorer-pages", fixture(), "2026-09-21").open, false);
  // A genuine approval is reported as a review, not as an override.
  const approved = gateWithOwnerOverride(PENDING + row("explorer-pages", "Fixture Reviewer", "**APPROVED**", "2026-10-01"), "explorer-pages", null, "2026-10-02");
  assert.deepEqual([approved.open, approved.basis], [true, "review_approved"]);
});

test("a review row the parser cannot read closes the override: a REJECTED row is never skipped into an older PENDING one", async () => {
  // A stray pipe in the notes makes seven cells; the plain parser drops the row. The override must not open past it.
  const strayPipe = PENDING + "| 2026-10-01 | `explorer-pages` — x | Fixture Reviewer | R6 | **REJECTED** | copied text | see section 3 |\n";
  assert.equal(registerRows(strayPipe).length, 2, "premise: the parser skips the malformed row");
  assert.equal(unparsedRegisterLines(strayPipe).length, 1);
  const result = gateWithOwnerOverride(strayPipe, "explorer-pages", fixture(), "2026-10-02");
  assert.equal(result.open, false);
  assert.match(result.reason, /could not be read as a row/);
  const lostPipe = PENDING + "2026-10-01 | `explorer-pages` — x | Fixture Reviewer | R6 | **REJECTED** | x |\n";
  assert.equal(gateWithOwnerOverride(lostPipe, "explorer-pages", fixture(), "2026-10-02").open, false);
  assert.deepEqual(unparsedRegisterLines(await readFile(new URL("REVIEW-REGISTER.md", root), "utf-8")), [], "the live register is fully readable");
  assert.equal(gateWithOwnerOverride(PENDING, "explorer-pages", fixture(), "2026-10-02").open, true, "control");
});

test("figures of every kind and impossible dates are refused; misrepresenting wording is checked everywhere", () => {
  for (const field of ["value_pct", "value_double", "raw_value", "approved_total", "sample_size", "amount_nzd", "percent_support"]) assert.ok(FORBIDDEN_FIELD.test(field), field);
  assert.match(authorizationProblems(fixture((f) => { f.authorizations[0]!.expires_on = "2026-09-31"; })).join("\n"), /expires_on must be an ISO date/);
  assert.match(authorizationProblems(fixture((f) => { f.notice = f.notice + " Rights cleared for every source, with permission granted by each publisher in writing."; })).join("\n"), /presents the owner decision as/);
  assert.match(authorizationProblems(fixture((f) => { f.authorizations[0]!.departs_from.push("None in practice: legal review complete as of today for R10 and R8 departure."); })).join("\n"), /presents the owner decision as/);
});

test("an invalid file authorizes nothing: no expiry, too long, no source, wildcard, wrong surface, unknown scope", () => {
  const bad: [string, (f: AuthorizationFile) => void, RegExp][] = [
    ["no expiry", (f) => { delete (f.authorizations[0] as { expires_on?: string }).expires_on; }, /always lapses/],
    ["too long", (f) => { f.authorizations[0]!.expires_on = "2027-09-20"; }, new RegExp(`limit is ${MAX_DAYS_IN_FORCE}`)],
    ["no request source", (f) => { f.authorizations[0]!.request_source = ""; }, /request_source/],
    ["not the owner", (f) => { f.authorizations[0]!.decided_by_role = "independent legal reviewer"; }, /repository owner/],
    ["deploying another surface", (f) => { f.authorizations[0]!.scopes[0] = { scope: "pages_deploy", surface_id: "evidence-atlas" }; }, /explorer-pages only/],
    ["wildcard field", (f) => { (f.authorizations[0]!.scopes[2] as { fields: string[] }).fields = ["*"]; }, /not a field name/],
    ["no fields", (f) => { (f.authorizations[0]!.scopes[2] as { fields: string[] }).fields = []; }, /no wildcard/],
    ["fields without a source", (f) => { delete (f.authorizations[0]!.scopes[2] as { source_id?: string }).source_id; }, /ONE source/],
    ["unknown scope", (f) => { f.authorizations[0]!.scopes.push({ scope: "all_sources" } as never); }, /unknown scope/],
    ["missing disclaimers", (f) => { f.authorizations[0]!.not_claimed = []; }, /not_claimed/],
    ["silent about the red lines it departs from", (f) => { f.authorizations[0]!.departs_from = []; }, /departs from R10 and R8/],
    ["claims compliance instead", (f) => { f.authorizations[0]!.departs_from = ["This decision satisfies R10 and R8 in full, as reviewed."]; }, /departs from R10 and R8/],
  ];
  for (const [name, patch, expected] of bad) {
    const file = fixture(patch);
    assert.match(authorizationProblems(file).join("\n"), expected, name);
    assert.deepEqual(scopesInForce(file, "2026-09-21"), [], name);
    assert.equal(deployAuthorization(file, "explorer-pages", "2026-09-21"), null, name);
    assert.equal(gateWithOwnerOverride(PENDING, "explorer-pages", file, "2026-09-21").open, false, name);
  }
});

test("private denial: contact data, bodies, images, figures and publisher identifiers can never be owner-released", () => {
  for (const field of ["email", "contact_email", "phone", "postal_address", "contact_details", "body", "release_text", "body_html", "source_passage", "description", "summary", "portrait_image", "votes", "vote_share", "list_rank", "seats_won", "safe_payload", "donor_name", "external_id", "external_record_id", "publisher_item_id", "twitter_handle"]) {
    assert.ok(FORBIDDEN_FIELD.test(field), field);
    const file = fixture((f) => { (f.authorizations[0]!.scopes[2] as { fields: string[] }).fields = ["name_at_source", field]; });
    assert.match(authorizationProblems(file).join("\n"), /can never be released/, field);
    assert.deepEqual(scopesInForce(file, "2026-09-21"), [], `${field}: the whole file is refused, not just the field`);
  }
  for (const field of ["name_at_source", "member_name", "party_label", "electorate_name_at_source", "representation", "title", "bill_number", "current_stage", "public_page_url", "candidacy_type", "identity_link_status", "relationship"]) {
    assert.equal(FORBIDDEN_FIELD.test(field), false, field);
  }
});

test("wording that passes an owner decision off as a review or a licence is refused", () => {
  for (const claim of ["Legal review complete; the owner authorizes deployment of the explorer to Pages.", "Fields are licensed by the publisher and the owner authorizes their display here.", "R10 satisfied by the owner, who authorizes deployment of the explorer to Pages."]) {
    assert.match(authorizationProblems(fixture((f) => { f.authorizations[0]!.statement = claim; })).join("\n"), /presents the owner decision as/, claim);
  }
});

test("the database constraint and this tool forbid the same field names", async () => {
  const sql = await readFile(new URL("supabase/migrations/20260920001400_owner_authorization.sql", root), "utf-8");
  const match = /owner_field_scope_forbidden check \(field_token !~ '([^']+)'\)/.exec(sql);
  assert.ok(match, "constraint present");
  assert.equal(match[1], FORBIDDEN_FIELD.source);
});

// Statistical facts: an explicit scope of its own, because the descriptive scope (rightly) cannot hold a number --------------

const STATS_SOURCE: RegisteredSource = { source_id: "fixture_stats", rights_id: "RIGHTS-18", view_scope: "statistics", registry_key: "statistics" };
const POLL_SOURCE: RegisteredSource = { source_id: "fixture_polls", rights_id: "RIGHTS-07", view_scope: "primary_2026", registry_key: "party_vote_polls" };
const FIXTURE_SOURCE: RegisteredSource = { source_id: "fixture_source", rights_id: "RIGHTS-13", view_scope: "current_parliament", registry_key: "parliament_members" };
const statistical = (patch: Partial<{ source_id: string; rights_id: string; fields: string[]; basis: string }> = {}) => fixture((f) => {
  f.authorizations[0]!.scopes.push({ scope: "statistical_facts", source_id: "fixture_stats", rights_id: "RIGHTS-18", fields: ["value", "value_status"], basis: "TEST FIXTURE: official statistics as printed by the publisher, with unit, period and status.", ...patch });
});

test("the descriptive scope still cannot release a number, so statistical facts need their own explicit scope", () => {
  for (const field of STATISTICAL_FACT_FIELDS) {
    assert.ok(FORBIDDEN_FIELD.test(field), `${field} stays forbidden in a source_fields scope`);
    const file = fixture((f) => { (f.authorizations[0]!.scopes[2] as { fields: string[] }).fields.push(field); });
    assert.match(authorizationProblems(file).join("\n"), /can never be released by a source_fields decision/, field);
  }
  assert.deepEqual(authorizationProblems(statistical(), [STATS_SOURCE, FIXTURE_SOURCE]), []);
  assert.equal(scopesInForce(statistical(), "2026-09-21", [STATS_SOURCE, FIXTURE_SOURCE]).filter((s) => s.scope.scope === "statistical_facts").length, 1);
});

test("a statistical_facts scope names only the four fact columns: no pattern, no vote, no money, no descriptive field", () => {
  for (const field of ["votes", "party_votes", "value_pct", "amount_nzd", "approved_total", "sample_size", "list_seats", "title", "unit", "qualifiers", "*", "value*"]) {
    assert.match(authorizationProblems(statistical({ fields: ["value", field] }), [STATS_SOURCE, FIXTURE_SOURCE]).join("\n"), /is not a statistical fact column|is not a field name/, field);
  }
  assert.match(authorizationProblems(statistical({ fields: [] })).join("\n"), /non-empty list/);
  assert.match(authorizationProblems(statistical({ fields: ["value", "value"] })).join("\n"), /duplicate field/);
  assert.match(authorizationProblems(statistical({ basis: "too short" })).join("\n"), /basis is missing/);
  assert.match(authorizationProblems(statistical({ basis: "Figures are licensed by the publisher for display on this site, at length." })).join("\n"), /presents the owner decision as/);
});

test("statistical facts are for registered statistics sources only, beside the rights row that governs them", () => {
  const registry = [STATS_SOURCE, POLL_SOURCE, FIXTURE_SOURCE];
  assert.match(authorizationProblems(statistical({ source_id: "fixture_polls", rights_id: "RIGHTS-07" }), registry).join("\n"), /not a statistics source/);
  assert.match(authorizationProblems(statistical({ rights_id: "RIGHTS-17" }), registry).join("\n"), /is governed by RIGHTS-18, not RIGHTS-17/);
  assert.match(authorizationProblems(statistical({ source_id: "fixture_unknown" }), registry).join("\n"), /is not a registered source/);
  // Any problem anywhere means nothing at all is in force.
  assert.deepEqual(scopesInForce(statistical({ source_id: "fixture_polls", rights_id: "RIGHTS-07" }), "2026-09-21", registry), []);
  // One descriptive and one statistical decision per source is fine; two of a kind is not.
  const both = statistical();
  both.authorizations[0]!.scopes.push({ scope: "source_fields", source_id: "fixture_stats", rights_id: "RIGHTS-18", fields: ["title", "unit"], basis: "TEST FIXTURE: series title and unit as printed by the publisher, with the link." });
  assert.deepEqual(authorizationProblems(both, registry), []);
  both.authorizations[0]!.scopes.push({ scope: "statistical_facts", source_id: "fixture_stats", rights_id: "RIGHTS-18", fields: ["raw_value"], basis: "TEST FIXTURE: a second statistical decision for the same source in one entry." });
  assert.match(authorizationProblems(both, registry).join("\n"), /second statistical_facts decision/);
});

test("the database constraints of the unified migration and this tool agree on both field rules", async () => {
  const sql = await readFile(new URL("supabase/migrations/20260921040100_unified_import.sql", root), "utf-8");
  const forbidden = /owner_field_scope_forbidden\s+check \(scope_kind is distinct from 'source_fields' or field_token !~ '([^']+)'\)/.exec(sql);
  assert.ok(forbidden, "the forbidden-name rule still binds every source_fields row");
  assert.equal(forbidden[1], FORBIDDEN_FIELD.source);
  const allowed = /owner_statistical_fact_tokens\s+check \(scope_kind is distinct from 'statistical_facts' or field_token in \(([^)]+)\)\)/.exec(sql);
  assert.ok(allowed, "closed list present");
  assert.deepEqual(allowed[1].split(",").map((t) => t.trim().replace(/'/g, "")), [...STATISTICAL_FACT_FIELDS]);
});

test("every field decision in the committed file names a registered source under its own rights row", async () => {
  const doc = JSON.parse(await readFile(new URL("governance/owner-authorizations.json", root), "utf-8")) as AuthorizationFile;
  const registry = (JSON.parse(await readFile(new URL("supabase/functions/_shared/sources.config.json", root), "utf-8")) as { sources: RegisteredSource[] }).sources;
  assert.deepEqual(authorizationProblems(doc, registry), []);
});

test("no decision releases the title of a select committee item: petition titles name the private person who petitioned", async () => {
  const doc = JSON.parse(await readFile(new URL("governance/owner-authorizations.json", root), "utf-8")) as AuthorizationFile;
  const committee = /committee_(reports|business)/;
  for (const a of doc.authorizations) {
    for (const s of a.scopes) {
      if (s.scope !== "source_fields" || !committee.test(s.source_id) || /report_files/.test(s.source_id)) continue;
      for (const field of ["title", "label", "subtitle"]) assert.ok(!s.fields.includes(field), `${s.source_id}: ${field}`);
    }
  }
});
