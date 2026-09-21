// Reading the Electoral Commission's own return forms: what a party or candidate DISCLOSED, part by part.
//
// The Commission publishes two things about political money. It prints per-party and per-candidate TOTALS on its
// own index pages (already held as P15/P16/P17), and it publishes the filed RETURN DOCUMENTS themselves. This
// module reads the second: the official form's own parts, their printed totals, and - where and only where the
// form's own arithmetic proves the reading is complete - the itemised entries inside a part.
//
// WHAT IS TAKEN, AND WHAT IS NEVER TAKEN. The form's Part A table has one cell headed "Donor's name and street
// address". The name is a disclosure the law requires; the street address is the donor's home. This module
// separates them by finding where the address BEGINS and keeping only what is in front of it, and it then proves
// the result is not an address before letting it out (`donorName`). A cell it cannot split is reported as
// `not_separable` and NO name is produced - never a best guess, never the whole cell. Nothing downstream of this
// file ever sees the address half: it is not returned, not hashed into an id, and not counted.
//
// WHY THE ARITHMETIC GATE. A column-positional PDF text layer can silently drop a row at a page break, or cut an
// amount in half ("$ 50," is a real example from a 2025 return). Neither is visible in the output. So itemised
// entries are published only when ALL of these hold for that part:
//   * the form printed a total for the part;
//   * every entry carries exactly one readable amount in the amount column;
//   * the entry numbers run 1..N with no gap;
//   * the entries sum EXACTLY to the printed total.
// Otherwise the part keeps its printed total, reports how many entries were seen, and publishes no entry at all.
// A part that does not reconcile is a measurement, not a failure: `itemisation_status` says which rule stopped it.
//
// ON DOUBLE COUNTING. Part A of an annual return for a general-election year also carries the donations over
// $20,000 that were already notified separately under s210C during that year (the form says so in its own
// instructions). The reporting year is therefore carried on every row and `overlaps_election_year_notices` marks
// the years where the two publications describe the same money, so nothing adds a notice to an annual return.

import { textViolation } from "../../../../supabase/functions/_shared/text_guard.ts";

export const DONATION_PARSER_VERSION = "ec-return-parts-1";

export type PartLetter = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I";
export type FormKind = "party_annual_return" | "candidate_election_return";

/** What a part is about. A donation, a loan and an expense are never added together. */
export type DisclosureKind = "donation" | "loan" | "expense";

/**
 * Who the form says the money came from. `protected_from_disclosure` and `anonymous` are the law's own categories:
 * the identity is withheld BY THE PUBLISHER, and this project keeps it that way.
 */
export type DonorIdentityKind = "named" | "anonymous" | "protected_from_disclosure" | "overseas" | "not_itemised";

export type ItemisationStatus =
  | "reconciled"          // entries published: they sum to the form's own printed total
  | "not_itemised"        // the form asks only for a count and a total here (Part G), so there is nothing to itemise
  | "no_entries"          // the part total is nil and the table is empty
  | "no_table"            // the document does not contain this part's table (a summary-only transcription)
  | "not_reconciled";     // a table was read but did not prove complete; see itemisation_note

/** Closed vocabulary. A note never carries free text. */
export type ItemisationNote =
  | "entries_sum_equals_printed_total"
  | "no_printed_total_for_part"
  | "an_entry_has_no_readable_amount"
  | "an_entry_has_more_than_one_amount"
  | "entry_numbers_are_not_consecutive"
  | "entries_do_not_sum_to_printed_total"
  | "part_is_a_count_and_total_only"
  | "part_table_not_present"
  | "part_total_is_nil";

export interface PartDefinition {
  part: PartLetter;
  /** The label the Commission prints, normalised to single spaces. Matched, never guessed. */
  label: string;
  disclosure_kind: DisclosureKind;
  donor_identity_kind: DonorIdentityKind;
  /** False where the form itself asks for a count and a total rather than a list (Part G). */
  itemised: boolean;
}

/**
 * THE CLOSED TABLE OF PARTS, taken from the forms themselves (2025 party annual return, 2023 candidate election
 * return). A part label this table does not hold is not read. Widening it means reading a form and adding a line.
 */
export const PART_DEFINITIONS: { [form in FormKind]: PartDefinition[] } = {
  party_annual_return: [
    { part: "A", label: "Party donations of more than $5,000", disclosure_kind: "donation", donor_identity_kind: "named", itemised: true },
    { part: "B", label: "Contributions of more than $5,000", disclosure_kind: "donation", donor_identity_kind: "named", itemised: true },
    { part: "C", label: "Anonymous party donations of more than $1,500", disclosure_kind: "donation", donor_identity_kind: "anonymous", itemised: true },
    { part: "D", label: "Overseas party donations of more than $50", disclosure_kind: "donation", donor_identity_kind: "overseas", itemised: true },
    { part: "E", label: "Contributions from overseas person of more than $50", disclosure_kind: "donation", donor_identity_kind: "overseas", itemised: true },
    { part: "F", label: "Donations protected from disclosure", disclosure_kind: "donation", donor_identity_kind: "protected_from_disclosure", itemised: false },
    { part: "G", label: "Other party donations up to $5,000", disclosure_kind: "donation", donor_identity_kind: "not_itemised", itemised: false },
    { part: "H", label: "Party loans exceeding $15,000", disclosure_kind: "loan", donor_identity_kind: "named", itemised: true },
    { part: "I", label: "Party loans between $1,500 - $15,000", disclosure_kind: "loan", donor_identity_kind: "not_itemised", itemised: false },
  ],
  candidate_election_return: [
    { part: "A", label: "Candidate donations of more than $1,500", disclosure_kind: "donation", donor_identity_kind: "named", itemised: true },
    { part: "B", label: "Contributions of more than $1,500", disclosure_kind: "donation", donor_identity_kind: "named", itemised: true },
    { part: "C", label: "Anonymous candidate donations of more than $1,500", disclosure_kind: "donation", donor_identity_kind: "anonymous", itemised: true },
    { part: "D", label: "Overseas candidate donations of more than $50", disclosure_kind: "donation", donor_identity_kind: "overseas", itemised: true },
    { part: "E", label: "Candidate donations protected from disclosure", disclosure_kind: "donation", donor_identity_kind: "protected_from_disclosure", itemised: false },
    { part: "F", label: "Candidate only election advertising", disclosure_kind: "expense", donor_identity_kind: "not_itemised", itemised: false },
    { part: "G", label: "Election advertisements shared with the party or other candidates", disclosure_kind: "expense", donor_identity_kind: "not_itemised", itemised: false },
    { part: "H", label: "Candidate loans", disclosure_kind: "loan", donor_identity_kind: "named", itemised: true },
  ],
};

/**
 * The general-election years. An annual return for one of these carries, inside Part A, the same donations over
 * $20,000 that were already published as separate s210C notices during the year. Rows for these years are marked
 * so the two publications are never added together.
 */
export const ELECTION_YEARS = [2011, 2014, 2017, 2020, 2023, 2026];

/**
 * How a document says which form it is. The title is the first choice. A document that holds only the numbered
 * pages of one part - the Commission publishes some returns that way - names the form in its own part banner
 * instead ("PART A: PARTY DONATIONS OF MORE THAN $5,000"). Both are the publisher's own words.
 */
const FORM_TITLES: { form: FormKind; pattern: RegExp }[] = [
  { form: "party_annual_return", pattern: /Party\s+Donations\s+and\s+Loans\s+Return\s+for\s+the\s+year\s+ending/i },
  // The Commission's letterhead can land between "Expenses" and "and Loans" in an extracted text layer, so the
  // title is matched up to the point where that happens.
  { form: "candidate_election_return", pattern: /Return\s+of\s+Electorate\s+Candidate\s+Donations,\s+Expenses/i },
  { form: "party_annual_return", pattern: /PART\s+[A-I]\s*:\s*PARTY\s+(DONATIONS|LOANS)\b/ },
  // A return filed as a scan has no text layer at all; where one was transcribed page by page, the summary keeps
  // the form's own part names and that is what identifies it.
  { form: "party_annual_return", pattern: /Part\s+[A-I]\s*[-:]\s*(party donations|anonymous party donations|overseas party donations|other party donations|protected donations|party loans)\b/i },
  { form: "candidate_election_return", pattern: /PART\s+[A-I]\s*:\s*CANDIDATE\s+(DONATIONS|LOANS)\b/ },
];

export interface ParsedEntry {
  entry_index: number;
  /** Present only when the cell split cleanly AND the result proved not to be an address. */
  donor_name_as_published: string | null;
  donor_name_status: "published" | "not_separable" | "withheld_by_publisher";
  donor_identity_kind: DonorIdentityKind;
  amount_nzd: number;
  /** Dates the form prints for this entry, as ISO where each one is a complete unambiguous date. */
  donation_dates: string[];
  /** How the dates were printed: one date, several, or a description this module does not turn into dates. */
  date_disclosure: "single_date" | "several_dates" | "described_not_dated" | "no_date_printed";
}

export interface ParsedPart {
  part: PartLetter;
  label_as_published: string;
  disclosure_kind: DisclosureKind;
  donor_identity_kind: DonorIdentityKind;
  total_nzd: number | null;
  total_status: "reported" | "reported_nil" | "not_reported";
  /** Entries the form lists in this part, whether or not they could be published. */
  entries_seen: number;
  itemisation_status: ItemisationStatus;
  itemisation_note: ItemisationNote;
  /** Empty unless itemisation_status is `reconciled`. */
  entries: ParsedEntry[];
}

export interface ParsedReturn {
  form: FormKind | null;
  parts: ParsedPart[];
  /** Closed vocabulary; a document that could not be read at all says why. */
  document_status: "read" | "form_title_not_found" | "no_part_summary_found";
}

const SPACES = /[   ]/g;
const DASHES = /[‐-―]/g;
const QUOTES = /[‘’‛]/g;

/** One normalisation, used everywhere: one kind of space, one kind of dash, one kind of apostrophe. */
export function normalise(line: string): string {
  return line.replace(SPACES, " ").replace(DASHES, "-").replace(QUOTES, "'");
}

function collapse(text: string): string {
  return normalise(text).replace(/\s+/g, " ").trim();
}

/** Money as the form prints it. Returns null for anything that is not a complete amount. */
export function amount(token: string): number | null {
  const m = collapse(token).match(/^\$?\s{0,3}(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, "") + "." + m[2]);
  return Number.isFinite(value) && value >= 0 && value < 1e12 ? value : null;
}

const MONEY_IN_LINE = /\$\s{0,3}(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})/g;

/**
 * An amount with no dollar sign, which is how the candidate form prints its totals ("TOTAL FOR PART A  42,099.86").
 * Only ever used on text a known label has already been removed from, where nothing else can be a number.
 */
const BARE_MONEY = /(?:^|\s)(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})(?=\s|$)/g;

/** `NIL` and a bare `0` are how these forms write nothing; both are an amount of zero, and both are only read
 *  from text a known label has already been removed from. */
const NOTHING = /(?:^|\s)(nil|0)(?=\s|$)/gi;

function amountsIn(text: string): number[] {
  const flat = collapse(text);
  const signed = [...flat.matchAll(MONEY_IN_LINE)].map((m) => amount(m[0])).filter((v): v is number => v !== null);
  if (signed.length > 0) return signed;
  const bare = [...flat.matchAll(BARE_MONEY)].map((m) => amount(m[1] + "." + m[2])).filter((v): v is number => v !== null);
  if (bare.length > 0) return bare;
  return [...flat.matchAll(NOTHING)].map(() => 0);
}

// --- The donor cell ---------------------------------------------------------------------------------------------

/**
 * Where a postal address begins inside the "name and street address" cell. These are the openings the forms
 * actually use: a street number, or a sub-address word followed by its number.
 */
const ADDRESS_START =
  /(^|[,\-–]\s*|\s)(\d+[A-Za-z]?(?:[/-]\d+[A-Za-z]?)?\s+\p{Lu}|Level\s+\d|Floor\s+\d|Flat\s+\d|Unit\s+\d|Suite\s+\d|Apartment\s+\d|Apt\s+\d|Villa\s+\d|PO\s*Box|P\.O\.\s*Box|Private\s+Bag|C\/[-o]|RD\s*\d)/u;

/** Words that only ever appear in an address here. A candidate name holding one is refused. */
const ADDRESS_WORD =
  /\b(road|rd|street|st|avenue|ave|drive|dr|lane|place|pl|terrace|crescent|quay|parade|highway|way|close|grove|court|rise|esplanade|boulevard|mews|heights|bay|flat|level|floor|unit|suite|apartment|box|postcode)\b/i;

/**
 * The name half of a donor cell, or null when this module cannot prove it has one.
 *
 * It takes what is in front of where the address begins, then REFUSES the result unless it looks like a name and
 * nothing else: it must hold letters, must hold no digit, must hold no address word, must not be a date, and must
 * pass the store's own text guard. A refusal is the normal outcome for an unusual cell, and it costs a name, never
 * a whole entry.
 */
export function donorName(cell: string): string | null {
  const text = collapse(cell);
  if (text === "") return null;
  const found = text.match(ADDRESS_START);
  let head = found && found.index !== undefined ? text.slice(0, found.index + (found[1] === "" ? 0 : found[1].length)) : text;
  head = head.replace(/[\s,;:\-–]+$/, "").trim();
  if (head.length < 2 || head.length > 200) return null;
  if (!/\p{L}{2}/u.test(head)) return null;         // a name has letters
  if (/\d/.test(head)) return null;                 // ... and no number of any kind
  if (ADDRESS_WORD.test(head)) return null;         // ... and no word that belongs to an address
  if (/^(date|amount|total|donor|name|yes|no)$/i.test(head)) return null;   // a header cell, not a donor
  if (textViolation(head)) return null;
  return head;
}

// --- Dates ------------------------------------------------------------------------------------------------------

const DATE_IN_LINE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g;

/** A printed d/m/y is an ISO date only when it is a real calendar date in the reporting year's era. */
export function isoFromPrinted(day: string, month: string, year: string): string | null {
  const y = year.length === 2 ? 2000 + Number(year) : Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!(y >= 1990 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

// --- Reading one document ---------------------------------------------------------------------------------------

interface Block { index: number; lines: string[] }

/** A page break or a repeated part banner ends an entry block, so one entry never absorbs the next page's amounts. */
const PAGE_BREAK = /^\s*(PART\s+[A-I]\b|Page:\s*\d+|\f)/i;
const ROW_NUMBER = /^\s{0,4}\d{1,3}\s+/;

/**
 * The header of the donor column. It has to be the header CELL and not the same words inside the form's
 * instructions ("...you need to record the name and street address of the donor..."), so the first cell of the
 * line must END with those words and be short enough to be a heading.
 */
function isColumnHeader(line: string): boolean {
  const cell = collapse(normalise(line).trimStart().split(/\s{2,}/)[0] ?? "");
  return cell.length <= 48 && /name and (street )?address$/i.test(cell);
}

function detectForm(text: string): FormKind | null {
  const flat = collapse(text);
  for (const { form, pattern } of FORM_TITLES) if (pattern.test(flat)) return form;
  return null;
}

/** The printed total of a part, from the part's own table banner ("TOTAL FOR PART A   $1,482,032.07"). */
function printedTotals(lines: string[]): Map<PartLetter, number> {
  const totals = new Map<PartLetter, number>();
  for (const raw of lines) {
    const line = normalise(raw);
    const m = line.match(/TOTAL\s+FOR\s+PART\s+([A-I])\b(.*)$/i);
    if (!m) continue;
    const values = amountsIn(m[2]);
    if (values.length !== 1) continue;              // two numbers on the banner line is not a total this module reads
    const part = m[1].toUpperCase() as PartLetter;
    const previous = totals.get(part);
    if (previous !== undefined && previous !== values[0]) { totals.delete(part); continue; }
    totals.set(part, values[0]);
  }
  return totals;
}

/**
 * The summary page prints every part with its amount beside it. The label carries a threshold ("more than $5,000"),
 * so the label is matched from the closed table FIRST and removed, and the amount is what is left. One number must
 * remain: two means the line was read wrong and nothing is taken from it.
 */
function summaryTotals(lines: string[], definitions: PartDefinition[]): Map<PartLetter, { value: number | null; nil: boolean }> {
  const out = new Map<PartLetter, { value: number | null; nil: boolean }>();
  const byPart = new Map(definitions.map((d) => [d.part, d]));
  for (let i = 0; i < lines.length; i++) {
    // The summary prints one part per line, but a long label wraps onto the next one ("Part C: Anonymous candidate
    // donations of more" / "than $1,500   $0.00"). So the line alone is tried first and the pair only after: joining
    // first would sweep in the NEXT part's amount and read two numbers where there is one.
    for (const candidate of [collapse(lines[i]), collapse(lines[i] + " " + (lines[i + 1] ?? ""))]) {
      const m = candidate.match(/^Part\s+([A-I])\s*[:\-]\s*(.+)$/i);
      if (!m) continue;
      const part = m[1].toUpperCase() as PartLetter;
      const definition = byPart.get(part);
      if (!definition || out.has(part)) continue;
      const label = collapse(definition.label);
      const alternatives = [label, label.replace(/ of more than /i, " over "), label.replace(/ between /i, " ")];
      const rest = alternatives.map((a) => matchLabel(m[2], a)).find((r) => r !== null);
      if (rest === undefined || rest === null) continue;
      const values = amountsIn(rest);
      if (values.length === 1) { out.set(part, { value: values[0], nil: false }); break; }
    }
  }
  return out;
}

/** The text after a known label, or null when the line does not open with that label. */
function matchLabel(text: string, label: string): string | null {
  const flat = collapse(text);
  const lower = flat.toLowerCase();
  const wanted = label.toLowerCase();
  if (lower.startsWith(wanted)) return flat.slice(label.length);
  // The forms also print the label with the threshold attached by a colon ("... over $5,000: $0.00").
  const colon = lower.indexOf(":");
  if (colon > 0 && lower.slice(0, colon).trim() === wanted.replace(/:$/, "")) return flat.slice(colon + 1);
  return null;
}

/**
 * Entry blocks of one part's table, delimited by the AMOUNT COLUMN.
 *
 * The two forms lay their tables out differently - a party return numbers its entries, a candidate return does not
 * - but both print exactly one amount per entry, in the rightmost column, on the entry's last line. So an entry is
 * "the lines since the previous amount, up to and including the next one". That rule needs nothing from the shape
 * of the left-hand cell, which is what varies, and it cannot mistake a wrapped street address for a new entry the
 * way a rule based on the leading number does: a real 2025 return wraps a donor's address onto its own line
 * beginning with the street number, which reads exactly like the next entry's number.
 *
 * Two things in the region are not entries and are removed before this runs: the column-header cluster, which
 * prints a `$0.00` placeholder in the amount column, and the blank form's printed EXAMPLE row, which carries an
 * invented donor and $5,000.00. Both are boilerplate on every copy of the form.
 */
function entryBlocks(lines: string[], from: number, to: number): Block[] {
  const blocks: Block[] = [];
  let pending: string[] = [];
  let index = 0;
  for (const line of contentLines(lines, from, to)) {
    if (PAGE_BREAK.test(line)) continue;
    const amounts = rightColumnAmountsOf(line);
    pending.push(line);
    if (amounts.length === 0) continue;
    blocks.push({ index: ++index, lines: pending });
    pending = [];
  }
  // An entry whose amount the text layer lost still ends the table with a DONOR in the donor column. That is
  // reported as an entry with no readable amount, which refuses the part: a part is never published as a shorter
  // list. What is left after the last entry is usually only the tail of its wrapped address, which is not a donor
  // and is not counted as one.
  // It has to look like an ENTRY and not like the page's footer: a donor the form names, and beside it either the
  // row number the table was up to or a date in the date column.
  const trailing = { index: index + 1, lines: pending };
  const pick = donorPick(trailing);
  const dated = blockDates(trailing).disclosure !== "no_date_printed";
  if (donorName(pick.cell) !== null && (pick.row_number !== null || dated)) blocks.push(trailing);
  return blocks;
}

/** The region's rows: everything after the column-header cluster, with the form's printed EXAMPLE row removed. */
function contentLines(lines: string[], from: number, to: number): string[] {
  // The header cluster is the rest of the heading: its words sit in the RIGHT-hand columns ("dd/mm/yyyy",
  // "Enter YES or NO", and a `$0.00` placeholder in the amount column). The table body begins at the first line
  // that writes in the donor column, which is the leftmost one.
  let start = from;
  while (start + 1 < to && !writesInTheDonorColumn(lines[start + 1])) start += 1;
  const out: string[] = [];
  let skippingExample = false;
  for (let i = start + 1; i < to; i++) {
    const line = normalise(lines[i]);
    // The marker is the blank form's own, printed in capitals with a colon. It is matched case-SENSITIVELY:
    // a real donor called "Example Holdings" must not switch the skip on.
    if (/^\s*EXAMPLE\s*:/.test(line)) { skippingExample = true; continue; }
    if (skippingExample) {
      // The example ends at the blank line that follows its own amount.
      if (collapse(line) === "" ) { skippingExample = false; }
      continue;
    }
    out.push(line);
  }
  return out;
}

/** The amount column sits on the right of the page; a number printed on the left is a date, an index or a threshold. */
function rightColumnAmountsOf(line: string): number[] {
  const out: number[] = [];
  const cut = Math.max(70, Math.floor(line.length * 0.55));
  for (const m of line.matchAll(MONEY_IN_LINE)) {
    if ((m.index ?? 0) < cut) continue;
    const value = amount(m[0]);
    if (value !== null) out.push(value);
  }
  return out;
}

function rightColumnAmounts(block: Block): number[] {
  return block.lines.flatMap(rightColumnAmountsOf);
}

/**
 * The cell that holds the donor: the first line of the block whose own first column carries letters, with the
 * form's row number stripped off the front. Later lines of a block are the address and the dates.
 */
/** True when a line puts words in the leftmost (donor) column rather than only in the columns to its right. */
function writesInTheDonorColumn(line: string): boolean {
  const normalised = normalise(line);
  const indent = normalised.search(/\S/);
  if (indent < 0 || indent > 40) return false;
  const head = (normalised.trimStart().replace(ROW_NUMBER, "").split(/\s{2,}/)[0] ?? "").trim();
  return /\p{L}{2}/u.test(head);
}

interface CellPick { cell: string; row_number: number | null }

/**
 * The donor cell of an entry, and the row number printed beside it.
 *
 * An entry runs NAME -> (dates, amount) -> rest of the address, so the wrapped tail of one entry's address is
 * printed under that entry's amount and therefore lands at the head of the next entry's block. The cell is
 * therefore taken by searching UP from the amount, and the nearest line whose left column reads as a name wins.
 * If no line does, the nearest left-column line is still reported so the entry can say `not_separable` rather
 * than silently claim there was nothing there.
 */
function donorPick(block: Block): CellPick {
  const candidates: CellPick[] = [];
  for (const line of block.lines) {
    if (PAGE_BREAK.test(line)) continue;
    // The donor column is the leftmost one. A line that only starts well into the page is another column - the
    // date column, or the YES/NO contribution column - and is never read as a donor.
    const indent = line.search(/\S/);
    if (indent < 0 || indent > 40) continue;
    const trimmed = line.trimStart();
    const numbered = trimmed.match(/^(\d{1,3})\s+(?=\S)/);
    const head = (trimmed.replace(ROW_NUMBER, "").split(/\s{2,}/)[0] ?? "").trim();
    if (!/\p{L}{2}/u.test(head)) continue;
    if (/^\d{1,2}\/\d{1,2}\//.test(collapse(head))) continue;
    candidates.push({ cell: head, row_number: numbered ? Number(numbered[1]) : null });
  }
  for (let i = candidates.length - 1; i >= 0; i--) if (donorName(candidates[i].cell) !== null) return candidates[i];
  return candidates.at(-1) ?? { cell: "", row_number: null };
}

function blockDates(block: Block): { dates: string[]; disclosure: ParsedEntry["date_disclosure"] } {
  const dates: string[] = [];
  let printed = 0;
  for (const line of block.lines) {
    for (const m of line.matchAll(DATE_IN_LINE)) {
      printed += 1;
      const iso = isoFromPrinted(m[1], m[2], m[3]);
      if (iso && !dates.includes(iso)) dates.push(iso);
    }
  }
  dates.sort();
  if (printed === 0) return { dates: [], disclosure: "no_date_printed" };
  if (dates.length !== printed) return { dates, disclosure: "described_not_dated" };
  return { dates, disclosure: dates.length === 1 ? "single_date" : "several_dates" };
}

/**
 * Reads one return document. `text` is the document's extracted text layer; it never leaves this function, and
 * nothing it returns carries a line of it.
 */
export function parseReturn(text: string): ParsedReturn {
  const form = detectForm(text);
  if (form === null) return { form: null, parts: [], document_status: "form_title_not_found" };
  const lines = text.split("\n");
  const definitions = PART_DEFINITIONS[form];
  const banners = printedTotals(lines);
  const summary = summaryTotals(lines, definitions);
  if (banners.size === 0 && summary.size === 0) return { form, parts: [], document_status: "no_part_summary_found" };

  // Where each part's own table starts and stops. A return repeats the part banner on every page, so one part has
  // several table regions; each runs from its column header to the NEXT banner or header, whichever comes first.
  // Bounding a region at the next marker of ANY part is what keeps one part's rows out of another part's total.
  const markers: number[] = [];
  const tables: { part: PartLetter; from: number }[] = [];
  let currentPart: PartLetter | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = normalise(lines[i]);
    const banner = line.match(/^\s*PART\s+([A-I])\s*:/);
    if (banner) { currentPart = banner[1].toUpperCase() as PartLetter; markers.push(i); continue; }
    if (currentPart && isColumnHeader(line)) { tables.push({ part: currentPart, from: i }); markers.push(i); }
  }
  markers.sort((a, b) => a - b);
  const regionEnd = (from: number): number => markers.find((m) => m > from) ?? lines.length;

  const parts: ParsedPart[] = [];
  for (const definition of definitions) {
    const printed = banners.get(definition.part);
    const fromSummary = summary.get(definition.part);
    const total = printed ?? fromSummary?.value ?? null;
    if (total === null && fromSummary === undefined) continue;   // the document says nothing about this part

    const regions = tables.filter((t) => t.part === definition.part);
    const blocks: Block[] = [];
    for (const region of regions) blocks.push(...entryBlocks(lines, region.from, regionEnd(region.from)));
    const entryBlocksFound = withoutRepeatedRenderings(blocks, regions.length).map((block, k) => ({ ...block, index: k + 1 }));

    const part: ParsedPart = {
      part: definition.part,
      label_as_published: definition.label,
      disclosure_kind: definition.disclosure_kind,
      donor_identity_kind: definition.donor_identity_kind,
      total_nzd: total,
      total_status: total === null ? "not_reported" : total === 0 ? "reported_nil" : "reported",
      entries_seen: entryBlocksFound.length,
      itemisation_status: "not_reconciled",
      itemisation_note: "part_table_not_present",
      entries: [],
    };

    if (!definition.itemised) {
      part.itemisation_status = "not_itemised";
      part.itemisation_note = "part_is_a_count_and_total_only";
    } else if (entryBlocksFound.length === 0) {
      part.itemisation_status = total === 0 ? "no_entries" : "no_table";
      part.itemisation_note = total === 0 ? "part_total_is_nil" : "part_table_not_present";
    } else {
      const problem = reconcile(entryBlocksFound, total);
      if (problem !== null) {
        part.itemisation_status = "not_reconciled";
        part.itemisation_note = problem;
      } else {
        part.itemisation_status = "reconciled";
        part.itemisation_note = "entries_sum_equals_printed_total";
        part.entries = entryBlocksFound
          .sort((a, b) => a.index - b.index)
          .map((block) => buildEntry(block, definition));
      }
    }
    parts.push(part);
  }
  return { form, parts, document_status: "read" };
}

/**
 * Some published returns render the same pages several times over. That repeats every entry, and a repeat is not a
 * second donation.
 *
 * The repetition has to be EXPLAINED by the document before it is removed: the part must have been found in
 * several table regions, and the list must divide into exactly that many identical runs. Two entries that happen
 * to share a donor and an amount inside ONE region are therefore both kept - a party may well receive two equal
 * donations from the same donor, and dropping one would understate the total.
 */
export function withoutRepeatedRenderings(blocks: Block[], regions: number): Block[] {
  if (regions < 2 || blocks.length % regions !== 0) return blocks;
  const keys = blocks.map((b) => `${rightColumnAmounts(b).join(",")}|${collapse(donorPick(b).cell).slice(0, 64)}`);
  const size = blocks.length / regions;
  for (let i = size; i < keys.length; i++) if (keys[i] !== keys[i - size]) return blocks;
  return blocks.slice(0, size);
}

/**
 * Every rule an itemised part must pass before a single entry of it is published. The printed row numbers, where
 * the form prints them, must also run 1..N: a form that numbers its rows gives a second, independent way to see
 * that the reading lost one.
 */
function reconcile(blocks: Block[], total: number | null): ItemisationNote | null {
  if (total === null) return "no_printed_total_for_part";
  let sum = 0;
  for (const block of blocks) {
    const amounts = rightColumnAmounts(block);
    if (amounts.length === 0) return "an_entry_has_no_readable_amount";
    if (amounts.length > 1) return "an_entry_has_more_than_one_amount";
    sum += amounts[0];
  }
  const printed = blocks.map((b) => donorPick(b).row_number);
  if (printed.every((n) => n !== null)) {
    for (const [k, n] of printed.entries()) if (n !== k + 1) return "entry_numbers_are_not_consecutive";
  }
  // Money, compared in whole cents: a float sum of cents is exact well past any amount a return can hold.
  if (Math.round(sum * 100) !== Math.round(total * 100)) return "entries_do_not_sum_to_printed_total";
  return null;
}

function buildEntry(block: Block, definition: PartDefinition): ParsedEntry {
  const value = rightColumnAmounts(block)[0];
  const { dates, disclosure } = blockDates(block);
  const withheld = definition.donor_identity_kind === "anonymous" || definition.donor_identity_kind === "protected_from_disclosure";
  const name = withheld ? null : donorName(donorPick(block).cell);
  return {
    entry_index: block.index,
    donor_name_as_published: name,
    donor_name_status: withheld ? "withheld_by_publisher" : name === null ? "not_separable" : "published",
    donor_identity_kind: definition.donor_identity_kind,
    amount_nzd: value,
    donation_dates: dates,
    date_disclosure: disclosure,
  };
}
