// The import contract of the two disclosure products, and the three places that must agree about donor fields.
//
// The loader will not write a key the contract does not name, the store will not accept one either, and the
// database column will not hold a value that looks like an address. This file holds the first two equal to each
// other and to the migration, so a widening in one place cannot pass unnoticed in another.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { contractProblem, FORBIDDEN_KEY, forbiddenKey, KIND_CONTRACTS, VETTED_DONOR_FIELDS } from "../src/families/election/contracts.ts";
import { mapReturnDocument } from "../src/families/election/donation_export.ts";
import type { VersionedExportRow } from "../src/families/election/exporter.ts";
import type { WarehouseRow } from "../src/families/election/mapping.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const MIGRATION = resolve(ROOT, "supabase/migrations/20260921080100_donation_disclosures.sql");

function row(payload: Record<string, unknown>, kind: string, product = "P25"): VersionedExportRow {
  return {
    product_id: product as VersionedExportRow["product_id"], source_id: "finance_2023_candidate_return_disclosures_export",
    external_record_id: "x#part-A", record_kind: kind, official_url: "https://elections.nz/a.pdf",
    collected_at: "2026-09-19T00:00:00.000Z", upstream_content_hash: "a".repeat(64),
    payload: payload as VersionedExportRow["payload"], omitted: [],
    version_ordinal: 1, version_count: 1, upstream_versions_folded: 0, safe_digest: "d",
  };
}

const PART = {
  reporting_year: 2023, return_kind: "candidate_election_return", disclosure_part: "A",
  part_label_as_published: "Candidate donations of more than $1,500", disclosure_kind: "donation",
  donor_identity_kind: "named", disclosed_total_status: "reported", disclosed_total_nzd: 9000,
  entries_disclosed: 1, itemisation_status: "reconciled", itemisation_note: "entries_sum_equals_printed_total",
  amounts_basis: "return_document_as_filed", disclosure_reader_version: "ec-return-parts-1",
  overlaps_election_year_notices: true, amendment_labelled: false,
  candidate_name_as_published: "Sample Candidate", electorate_as_published: "Sampleton",
};

const ENTRY = {
  reporting_year: 2023, return_kind: "candidate_election_return", disclosure_part: "A",
  part_label_as_published: "Candidate donations of more than $1,500", disclosure_kind: "donation",
  donor_identity_kind: "named", entry_index: 1, donor_name_status: "published",
  donor_name_as_published: "Example Holdings Limited", disclosed_amount_nzd: 9000,
  donation_dates: ["2023-10-13"], date_disclosure: "single_date",
  amounts_basis: "return_document_as_filed", disclosure_reader_version: "ec-return-parts-1",
  overlaps_election_year_notices: true, amendment_labelled: false,
  candidate_name_as_published: "Sample Candidate", electorate_as_published: "Sampleton",
};

test("the two disclosure kinds are accepted, for either product", () => {
  assert.equal(contractProblem(row(PART, "donation_return_part")), null);
  assert.equal(contractProblem(row(ENTRY, "donation_disclosure_entry")), null);
  const { candidate_name_as_published: _c, electorate_as_published: _e, ...partyPart } = PART;
  assert.equal(contractProblem(row({ ...partyPart, return_kind: "party_annual_return", party_name_as_published: "Example Party" }, "donation_return_part", "P26")), null);
  assert.match(String(contractProblem(row(PART, "donation_return_part", "P08"))), /does not belong to this product/);
});

test("exactly three donor field names may be written, and nothing that could be a location", () => {
  assert.deepEqual([...VETTED_DONOR_FIELDS], ["donor_name_as_published", "donor_name_status", "donor_identity_kind"]);
  for (const field of VETTED_DONOR_FIELDS) {
    assert.equal(FORBIDDEN_KEY.test(field), true, `${field} still matches the pattern`);
    assert.equal(forbiddenKey(field), false, `${field} is allowed only because it is on the closed list`);
  }
  // Everything else the pattern covers stays refused, and a field that could hold a location is refused twice over.
  for (const field of ["donor_address", "donor_street", "donor_postcode", "donor_email", "donor_phone", "donor_signature",
                       "donor_bank_account", "donor_date_of_birth", "contributor_name", "contributor_address",
                       "address", "street", "postcode", "full_text", "raw_pdf_bytes", "document_text"]) {
    assert.equal(forbiddenKey(field), true, field);
    assert.match(String(contractProblem(row({ ...ENTRY, [field]: "x" }, "donation_disclosure_entry"))), /forbidden field name|outside the contract/, field);
  }
});

test("a field the contract does not name is refused even when its name is harmless", () => {
  assert.match(String(contractProblem(row({ ...ENTRY, donor_note: "x" }, "donation_disclosure_entry"))), /forbidden field name/);
  assert.match(String(contractProblem(row({ ...ENTRY, entry_colour: "blue" }, "donation_disclosure_entry"))), /outside the contract/);
  assert.match(String(contractProblem(row({ ...ENTRY, disclosure_part: "Z" }, "donation_disclosure_entry"))), /documented vocabulary/);
  assert.match(String(contractProblem(row({ ...ENTRY, donor_name_status: "guessed" }, "donation_disclosure_entry"))), /documented vocabulary/);
  assert.match(String(contractProblem(row({ ...ENTRY, donation_dates: ["2023-02-30"] }, "donation_disclosure_entry"))), /wrong shape/);
  assert.match(String(contractProblem(row({ ...ENTRY, disclosed_amount_nzd: -1 }, "donation_disclosure_entry"))), /wrong shape/);
  const { entry_index: _drop, ...noIndex } = ENTRY;
  assert.match(String(contractProblem(row(noIndex, "donation_disclosure_entry"))), /entry_index is missing/);
});

test("the loader's vetted list and the database guard name the same three fields", async () => {
  const sql = await readFile(MIGRATION, "utf-8");
  const exception = /regexp_replace\(v_text, '"\(([a-z_|]+)\)"/.exec(sql);
  assert.ok(exception, "the payload guard still takes a closed list out of the name scan");
  assert.deepEqual(exception[1].split("|"), [...VETTED_DONOR_FIELDS]);
  // The pattern itself is unchanged: it is the SAME list of names the store has always refused.
  assert.match(sql, /donor\[a-z_\]\*\|contributor\[a-z_\]\*/);
  assert.match(sql, /\|address\|street\|postcode\|/);
});

test("the database refuses a donor name that carries a number or a street word", async () => {
  const sql = await readFile(MIGRATION, "utf-8");
  assert.match(sql, /donor_name_as_published !~ '\[0-9\]'/, "a value holding a digit is refused by the column itself");
  assert.match(sql, /road\|rd\|street\|avenue/, "and so is a value holding a word that belongs to a postal address");
  // There is no column anywhere in the new tables that could hold the other half of the cell.
  const tables = sql.slice(sql.indexOf("create table evidence_private.donation_return_parts"), sql.indexOf("-- Access:"));
  for (const name of ["address", "street", "postcode", "signature", "contact", "email", "phone", "bank", "account_number"]) {
    assert.equal(new RegExp(`^\\s+\\w*${name}\\w*\\s`, "mi").test(tables), false, `no column named for ${name}`);
  }
});

test("an identity the publisher withholds is never stored with a name", () => {
  const { donor_name_as_published: _name, ...withheld } = ENTRY;
  assert.equal(contractProblem(row({ ...withheld, donor_name_status: "withheld_by_publisher", donor_identity_kind: "anonymous" }, "donation_disclosure_entry")), null);
  // The pairing rule itself lives in the database, which is what actually holds the row.
  assert.ok(KIND_CONTRACTS.donation_disclosure_entry.enums?.donor_name_status?.includes("withheld_by_publisher"));
});

test("a return document that is not the form this source files is refused, not skipped", () => {
  const warehouse = (payload: Record<string, unknown>, text: string): WarehouseRow => ({
    source_id: "political_finance_2023_candidate_returns", record_id: "r1", record_kind: "official_candidate_finance_return_document",
    source_url: "https://elections.nz/a.pdf", observed_at: "2026-09-19 00:00:00.000", content_hash: "b".repeat(64),
    payload_json: JSON.stringify({ ...payload, full_text: text }),
  });
  const spec = { product: "P25" as const, source_id: "political_finance_2023_candidate_returns", reporting_year: 2023, return_kind: "candidate_election_return" as const };

  // Not a form at all: no rows, and the outcome says which document could not be read.
  const unreadable = mapReturnDocument(warehouse({ reporting_year: 2023 }, "an assurance report about something else"), spec);
  assert.deepEqual(unreadable.rows, []);
  assert.equal(unreadable.outcome.document_status, "form_title_not_found");

  // The wrong form: refused outright rather than mapped into the wrong product.
  assert.throws(
    () => mapReturnDocument(warehouse({ reporting_year: 2023 }, "Party Donations and Loans Return for the year ending 31 December 2025\nPart A: Party donations of more than $5,000   $0.00"), spec),
    /not the form this source files|not for 2023/,
  );
});
