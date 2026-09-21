// The donation parser, against synthetic forms laid out the way the real ones are.
//
// EVERY donor name, address and amount in this file is invented. The real captured returns are private and never
// enter this repository; what is reproduced here is the SHAPE of the Commission's form - its column positions, its
// printed EXAMPLE row, its wrapped addresses, its repeated page renderings and its page-break damage - because the
// shape is what the parser has to survive.

import assert from "node:assert/strict";
import test from "node:test";
import {
  amount, donorName, DONATION_PARSER_VERSION, ELECTION_YEARS, isoFromPrinted, PART_DEFINITIONS, parseReturn,
} from "../src/families/election/donations.ts";
import { mapDonationRows } from "../src/families/election/donation_export.ts";
import type { WarehouseRow } from "../src/families/election/mapping.ts";

/** Lays a row out in columns the way `pdftotext -layout` does: text at the given character positions. */
function columns(...cells: [number, string][]): string {
  let line = "";
  for (const [at, text] of cells) {
    if (line.length > at) line += " ";
    line = line.padEnd(at, " ") + text;
  }
  return line;
}

const PARTY_HEADING = [
  "                                             Party Donations and Loans Return for",
  "                                             the year ending 31 December 2025",
  "",
  "1.   Party name:",
  "     Example Party of New Zealand",
];

/** The summary page: every part with the amount the party entered beside it. */
function partySummary(totals: { [part: string]: string }): string[] {
  const labels: { [part: string]: string } = {
    A: "Party donations of more than $5,000", C: "Anonymous party donations of more than $1,500",
    D: "Overseas party donations of more than $50", F: "Donations protected from disclosure",
    G: "Other party donations up to $5,000", H: "Party loans exceeding $15,000",
  };
  return Object.entries(labels).map(([part, label]) => columns([5, `Part ${part}: ${label}`], [80, totals[part] ?? "$0.00"]));
}

/** One Part A page: the banner, the printed total, the column header cluster, then the rows. */
function partyPartAPage(total: string, rows: string[]): string[] {
  return [
    "PART A: PARTY DONATIONS OF MORE THAN $5,000",
    "",
    columns([100, "TOTAL FOR PART A"], [140, total]),
    "",
    columns([19, "Donor's name and street address"], [80, "Date donation received"], [120, "Contributions?"], [150, "Amount"]),
    columns([80, "dd/mm/yyyy"], [120, "Enter YES or NO"], [150, "$0.00"]),
    "",
    ...rows,
  ];
}

/** A row as the form prints it: name and address in one cell, dates in the middle, the amount on the right. */
function partyRow(n: number, cell: string, dates: string, value: string, wrapped?: string): string[] {
  const out = [columns([0, `${n} ${cell}`], [80, dates]), columns([120, "NO"], [150, value])];
  if (wrapped !== undefined) out.push(columns([5, wrapped]));
  out.push("");
  return out;
}

test("a party return: the parts, their printed totals, and entries that sum to Part A's own total", () => {
  const document = [
    ...PARTY_HEADING,
    ...partySummary({ A: "$26,500.00", G: "$ 1,200.00" }),
    ...partyPartAPage("$26,500.00", [
      ...partyRow(1, "Kahu Whitiwhiti, 12 Example Road, Sampleton, Testville 1010", "01/03/2025", "$ 15,000.00"),
      ...partyRow(2, "Fictional Holdings Limited, Level 9, 3 Placeholder Street,", "02/04/2025, 03/05/2025", "$  8,000.00", "Sampleton 1011"),
      ...partyRow(3, "Te Rangi Pouaka", "04/06/2025", "$  3,500.00"),
    ]),
  ].join("\n");

  const parsed = parseReturn(document);
  assert.equal(parsed.document_status, "read");
  assert.equal(parsed.form, "party_annual_return");

  const partA = parsed.parts.find((p) => p.part === "A")!;
  assert.equal(partA.total_nzd, 26500);
  assert.equal(partA.total_status, "reported");
  assert.equal(partA.itemisation_status, "reconciled");
  assert.equal(partA.itemisation_note, "entries_sum_equals_printed_total");
  assert.equal(partA.entries.length, 3);
  assert.deepEqual(partA.entries.map((e) => e.donor_name_as_published),
    ["Kahu Whitiwhiti", "Fictional Holdings Limited", "Te Rangi Pouaka"],
    "the name is kept and the street address that follows it in the same cell is not");
  assert.deepEqual(partA.entries.map((e) => e.amount_nzd), [15000, 8000, 3500]);
  assert.deepEqual(partA.entries[1].donation_dates, ["2025-04-02", "2025-05-03"]);
  assert.equal(partA.entries[1].date_disclosure, "several_dates");
  assert.equal(partA.entries[0].date_disclosure, "single_date");

  const partG = parsed.parts.find((p) => p.part === "G")!;
  assert.equal(partG.total_nzd, 1200);
  assert.equal(partG.itemisation_status, "not_itemised", "the form asks only for a count and a total in Part G");
  assert.equal(partG.entries.length, 0);

  const partC = parsed.parts.find((p) => p.part === "C")!;
  assert.equal(partC.total_nzd, 0);
  assert.equal(partC.total_status, "reported_nil");
  assert.equal(partC.donor_identity_kind, "anonymous");
});

test("an entry whose amount the text layer cut in half refuses the WHOLE part, and keeps the printed total", () => {
  const document = [
    ...PARTY_HEADING,
    ...partySummary({ A: "$26,500.00" }),
    ...partyPartAPage("$26,500.00", [
      ...partyRow(1, "Kahu Whitiwhiti, 12 Example Road, Sampleton 1010", "01/03/2025", "$ 15,000.00"),
      ...partyRow(2, "Fictional Holdings Limited, 3 Placeholder Street, Sampleton 1011", "02/04/2025", "$ 11,"),
    ]),
  ].join("\n");

  const partA = parseReturn(document).parts.find((p) => p.part === "A")!;
  assert.equal(partA.itemisation_status, "not_reconciled");
  assert.equal(partA.itemisation_note, "an_entry_has_no_readable_amount");
  assert.equal(partA.entries.length, 0, "no entry of a part that did not prove complete is published");
  assert.equal(partA.entries_seen, 2, "how many were there is still reported");
  assert.equal(partA.total_nzd, 26500, "the Commission's own printed total is unaffected");
});

test("a wrapped street address starting with its street number is not read as the next entry", () => {
  // "9 Willow Place" under entry 1 looks exactly like entry 9. The amount column decides where an entry ends.
  const document = [
    ...PARTY_HEADING,
    ...partySummary({ A: "$12,000.00" }),
    ...partyPartAPage("$12,000.00", [
      ...partyRow(1, "Ari Templeton", "01/02/2025", "$  7,000.00", "9 Willow Place Sampleton"),
      ...partyRow(2, "Marama Kopu", "03/04/2025", "$  5,000.00", "29 Bronte Street Testville"),
    ]),
  ].join("\n");

  const partA = parseReturn(document).parts.find((p) => p.part === "A")!;
  assert.equal(partA.itemisation_status, "reconciled");
  assert.deepEqual(partA.entries.map((e) => e.donor_name_as_published), ["Ari Templeton", "Marama Kopu"]);
});

test("a document that renders the same pages several times reports each entry once", () => {
  const page = partyPartAPage("$12,000.00", [
    ...partyRow(1, "Ari Templeton, 9 Willow Place, Sampleton", "01/02/2025", "$  7,000.00"),
    ...partyRow(2, "Marama Kopu, 29 Bronte Street, Testville", "03/04/2025", "$  5,000.00"),
  ]);
  const document = [...PARTY_HEADING, ...partySummary({ A: "$12,000.00" }), ...page, ...page, ...page].join("\n");

  const partA = parseReturn(document).parts.find((p) => p.part === "A")!;
  assert.equal(partA.itemisation_status, "reconciled");
  assert.equal(partA.entries.length, 2);
  assert.deepEqual(partA.entries.map((e) => e.amount_nzd), [7000, 5000]);
});

test("two genuine entries that share a donor and an amount are both kept", () => {
  const document = [
    ...PARTY_HEADING,
    ...partySummary({ A: "$14,000.00" }),
    ...partyPartAPage("$14,000.00", [
      ...partyRow(1, "Ari Templeton, 9 Willow Place, Sampleton", "01/02/2025", "$  7,000.00"),
      ...partyRow(2, "Ari Templeton, 9 Willow Place, Sampleton", "01/02/2025", "$  7,000.00"),
    ]),
  ].join("\n");

  const partA = parseReturn(document).parts.find((p) => p.part === "A")!;
  assert.equal(partA.entries.length, 2, "identical runs are a repeated rendering only when the WHOLE list repeats");
});

test("a candidate return: the form's printed EXAMPLE row is never read as a donation", () => {
  const document = [
    "                                         Return of Electorate Candidate Donations, Expenses",
    "                                         and Loans for the 2023 General Election",
    "1.   Candidate name:",
    "      Sample Candidate",
    columns([5, "Part A: Candidate donations of more than $1,500"], [80, "9,000.00"]),
    columns([5, "Part C: Anonymous candidate donations of more"], [80, ""]),
    columns([5, "than $1,500"], [80, "0.00"]),
    columns([5, "Part F: Candidate only election advertising"], [80, "2,500.00"], [110, "FILING THE RETURN"]),
    "",
    "PART A: CANDIDATE DONATIONS OF MORE THAN $1,500",
    "",
    columns([90, "TOTAL FOR PART A"], [130, "9,000.00"]),
    "",
    columns([16, "Donor's name and street address"], [75, "Date"], [105, "Contributions?"], [135, "Amount"]),
    columns([75, "dd/mm/yyyy"], [105, "Enter YES or NO"], [135, "$0.00"]),
    "",
    columns([4, "EXAMPLE: John Smith, Smiths Publishing"]),
    columns([4, "35 Main Street, Suburb"], [70, "1/11/2022, 10/11/2022"], [105, "Yes"], [135, "$5,000.00"]),
    columns([4, "Wellington"]),
    "",
    columns([0, "Example Party, 41 Sample Street, Testville"], [75, "13/10/2023"]),
    columns([105, "No"], [135, "$ 9,000.00"]),
    "",
  ].join("\n");

  const parsed = parseReturn(document);
  assert.equal(parsed.form, "candidate_election_return");
  const partA = parsed.parts.find((p) => p.part === "A")!;
  assert.equal(partA.total_nzd, 9000, "the candidate form prints its totals without a dollar sign");
  assert.equal(partA.itemisation_status, "reconciled");
  assert.deepEqual(partA.entries.map((e) => e.donor_name_as_published), ["Example Party"]);
  assert.equal(partA.entries.length, 1, "the blank form's printed example donor is boilerplate, not a donation");

  const partC = parsed.parts.find((p) => p.part === "C")!;
  assert.equal(partC.total_nzd, 0, "a label that wraps onto the next line still finds its amount");
  const partF = parsed.parts.find((p) => p.part === "F")!;
  assert.equal(partF.disclosure_kind, "expense", "an expense is never a donation");
  assert.equal(partF.total_nzd, 2500);
});

test("a document that is not one of the Commission's return forms is not read at all", () => {
  const parsed = parseReturn("Reasonable Assurance Report on compliance with Sections 210 and 214C of the Electoral Act 1993");
  assert.equal(parsed.document_status, "form_title_not_found");
  assert.equal(parsed.form, null);
  assert.deepEqual(parsed.parts, []);
});

test("donorName keeps a name and refuses anything that is, or might be, an address", () => {
  assert.equal(donorName("Kahu Whitiwhiti, 12 Example Road, Sampleton 1010"), "Kahu Whitiwhiti");
  assert.equal(donorName("Whitiwhiti, Kahu Aroha - 12A Example Road, Sampleton"), "Whitiwhiti, Kahu Aroha");
  assert.equal(donorName("Fictional Holdings Limited,11 Example Road, Sampleton"), "Fictional Holdings Limited");
  assert.equal(donorName("Sample Trust, Level 12, 1 Placeholder Street, Testville"), "Sample Trust");
  assert.equal(donorName("Placeholder Co Limited, PO Box 99, Sampleton"), "Placeholder Co Limited");
  assert.equal(donorName("Example Holdings Ltd, C/- Sample Accountants, Flat 5, 2 Test Road"), "Example Holdings Ltd");
  assert.equal(donorName("Te Rangi Pouaka"), "Te Rangi Pouaka");
  // Refused: a cell this module cannot prove it has split.
  assert.equal(donorName("12 Example Road, Sampleton 1010"), null, "an address alone is never a name");
  assert.equal(donorName("Sampleton 1010, New Zealand"), null, "a cell holding a number is refused whole");
  assert.equal(donorName("Willow Place Sampleton"), null, "a street with no number is still a street");
  assert.equal(donorName("Donor"), null, "a header cell is not a donor");
  assert.equal(donorName(""), null);
  assert.equal(donorName("Example Person, 1 Test Road, person@example.govt.nz"), "Example Person");
});

test("amount reads only a complete amount", () => {
  assert.equal(amount("$ 40,949.15"), 40949.15);
  assert.equal(amount("1,482,032.07"), 1482032.07);
  assert.equal(amount("$ 50,"), null, "a page break can cut an amount in half; half an amount is not an amount");
  assert.equal(amount("$40,949"), null, "cents are always printed on these forms");
  assert.equal(amount(""), null);
});

test("a printed date becomes an ISO date only when it is a real one", () => {
  assert.equal(isoFromPrinted("01", "03", "2025"), "2025-03-01");
  assert.equal(isoFromPrinted("9", "12", "25"), "2025-12-09");
  assert.equal(isoFromPrinted("31", "02", "2025"), null, "there is no 31 February");
  assert.equal(isoFromPrinted("13", "13", "2025"), null);
});

test("the closed tables say what they say", () => {
  assert.equal(DONATION_PARSER_VERSION, "ec-return-parts-1");
  for (const [form, definitions] of Object.entries(PART_DEFINITIONS)) {
    assert.equal(new Set(definitions.map((d) => d.part)).size, definitions.length, `${form} names each part once`);
    for (const d of definitions) {
      assert.ok(d.label.length > 0 && d.label.length <= 90, `${form} ${d.part} has a label`);
      if (d.donor_identity_kind === "anonymous" || d.donor_identity_kind === "protected_from_disclosure") {
        assert.equal(d.itemised && d.part === "C" || !d.itemised, true, "an identity the law withholds is never itemised into a name");
      }
    }
  }
  assert.ok(ELECTION_YEARS.includes(2023) && ELECTION_YEARS.includes(2026));
  assert.ok(!ELECTION_YEARS.includes(2025), "2025 is not a general-election year, so its annual returns hold no $20,000 notices");
});

test("an identity the publisher withholds is never given a name", () => {
  const document = [
    ...PARTY_HEADING,
    ...partySummary({ C: "$ 3,000.00" }),
    "PART C: ANONYMOUS PARTY DONATIONS OF MORE THAN $1,500",
    "",
    columns([100, "TOTAL FOR PART C"], [140, "$ 3,000.00"]),
    "",
    columns([19, "Donor's name and street address"], [80, "Date donation received"], [150, "Amount"]),
    columns([80, "dd/mm/yyyy"], [150, "$0.00"]),
    "",
    columns([0, "1 Anonymous"], [80, "01/05/2025"]),
    columns([150, "$ 3,000.00"]),
    "",
  ].join("\n");

  const partC = parseReturn(document).parts.find((p) => p.part === "C")!;
  assert.equal(partC.itemisation_status, "reconciled");
  assert.equal(partC.entries.length, 1);
  assert.equal(partC.entries[0].donor_name_as_published, null);
  assert.equal(partC.entries[0].donor_name_status, "withheld_by_publisher");
  assert.equal(partC.entries[0].donor_identity_kind, "anonymous");
  assert.equal(partC.entries[0].amount_nzd, 3000);
});

// An amendment is its own document ------------------------------------------------------------------------------
//
// A party that has already filed may file an AMENDED return, and the Commission publishes it as a separate
// document rather than replacing the first one. Both are filings and this store keeps both: which one supersedes
// the other is the publisher's statement, not this reader's inference. What must never happen is one donation
// reaching a reader as two, once from each document.

test("two documents may state the same part's total, but never itemise it twice", () => {
  const spec = {
    product: "P26" as const, source_id: "political_finance_2025_returns",
    reporting_year: 2025, return_kind: "party_annual_return" as const,
  };
  const document = (id: string, url: string, body: string[]): WarehouseRow => ({
    source_id: spec.source_id, record_id: id, record_kind: "official_party_finance_return_document",
    source_url: url, observed_at: "2026-09-19 00:00:00.000", content_hash: id.repeat(64).slice(0, 64),
    payload_json: JSON.stringify({
      reporting_year: 2025, party_name_as_published: "Example Party of New Zealand",
      amendment_labelled: url.includes("amended"), full_text: body.join("\n"),
    }),
  });
  const totalsOnly = [...PARTY_HEADING, ...partySummary({ G: "$ 1,200.00" })];
  const itemised = [
    ...PARTY_HEADING,
    ...partySummary({ A: "$6,000.00" }),
    ...partyPartAPage("$6,000.00", [...partyRow(1, "Te Rangi Pouaka", "04/06/2025", "$  6,000.00")]),
  ];

  // Two filings that state only their printed totals: the overlap is counted, both rows are kept, and no view
  // adds one document's total to the other's.
  const stated = mapDonationRows([
    document("a", "https://elections.nz/original.pdf", totalsOnly),
    document("b", "https://elections.nz/amended.pdf", totalsOnly),
  ], spec);
  assert.ok(stated.overlapping_document_parts >= 1, "a part two documents both state is counted, not hidden");
  assert.equal(stated.rows.filter((r) => r.record_kind === "donation_disclosure_entry").length, 0);

  // One document itemising on its own is ordinary.
  const alone = mapDonationRows([document("a", "https://elections.nz/original.pdf", itemised)], spec);
  assert.equal(alone.rows.filter((r) => r.record_kind === "donation_disclosure_entry").length, 1);
  assert.equal(alone.overlapping_document_parts, 0);

  // Both documents itemising the same part would show a reader one donation as two: refused outright, because
  // there is no evidence here about which filing replaced which.
  assert.throws(() => mapDonationRows([
    document("a", "https://elections.nz/original.pdf", itemised),
    document("b", "https://elections.nz/amended.pdf", itemised),
  ], spec), /both publish itemised entries/);
});
