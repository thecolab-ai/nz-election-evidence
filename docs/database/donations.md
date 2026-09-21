# Donations disclosed inside filed Electoral Commission returns (P25, P26)

Branch `feat/official-donation-records`, commit `cd99e0c`. Local only: nothing pushed, nothing deployed, and the
hosted database was not contacted. Everything below was run on an isolated, disposable stack of its own.

Until this change the store held **no donation at all**. It held the Commission's *index* of filed returns (P15,
P17) and the totals the Commission prints on its own pages (P16, and the index-page totals of P15). Migration
`20260921070100` said so in as many words: *"THERE IS NO DONOR-LEVEL RECORD IN THIS STORE TO PUBLISH"*. That was
the honest answer while nothing had ever been read from inside a return. This adds the record.

## 1. What the two products are

| Product | What it is | Records |
|---|---|---:|
| **P25** | The 2023 candidate returns — what each return discloses, part by part, and each itemised entry of a part that could be read completely | 1,340 |
| **P26** | The 2025 party annual returns — the same | 286 |

Each product has two record kinds:

* `donation_return_part` — one per part of the Commission's own form that a return fills in: the total the form
  prints for that part, how many entries it lists, and how completely those entries could be read.
* `donation_disclosure_entry` — one per itemised donation, loan or contribution, but **only** for a part whose
  entries proved complete (§3).

They are separate products from P15/P17 rather than more rows on them because they are a different publication of
the publisher: P15 is a list of documents, P25 is what those documents say. They carry their own registry products
(`candidate_return_disclosures`, `party_return_disclosures`) so an owner decision about a donor cannot reach the
document index it was read from.

## 2. Where the data comes from, and what could not be collected

**elections.nz answers this host with a bot-challenge page.** Re-checked on 2026-09-21, one attempt each, never
worked around: `elections.nz/…/donations-exceeding-20000/` → challenge; `electionresults.govt.nz` → HTTP 403;
`www.data.govt.nz` → challenge. `elections.nz/robots.txt` *is* readable and **allows** the path (crawl-delay 2), so
what refuses this project is the publisher's firewall, not its robots rules. Both disclosure products therefore
have a backfill route and **no working refresh route**, exactly as P15/P16/P17 do.

What is loaded comes through the same read-only upstream export the rest of the election family uses. The return
documents' extracted text is read there, in the exporter, and **never enters this repository or this store**: what
crosses into the store is the typed result of the reader (§3). The export was reconciled against the upstream store
on 2026-09-21; the receipt is `receipts/2026-09-21-election-donations.export.json`.

**Not collected, and not a substitute for anything:**

* The **donations over $20,000** that the Commission publishes separately during an election year (s210C notices).
  That page is challenged too. Nothing here stands in for them.
* 224 of the 492 candidate returns are **image-only scans** with no text layer.
* One party files its 2025 return as a **spreadsheet-style schedule** rather than the Commission's Part A–I form.
  The reader does not recognise it as the form and does not read it. It is counted, not guessed at.

## 3. How a return is read, and the rule that decides what is published

`ingest/src/families/election/donations.ts`. The Commission's return is a standard form with Parts A to I, so the
parts and their labels are a **closed table**, matched against what the form prints and never inferred.

### The donor's name, and the thing printed beside it

Part A's table has **one cell** headed with the donor's name and their street address together. The name is a
disclosure Parliament requires to be public. The other half is a private individual's home.

`donorName()` finds where the address *begins* — a street number, `Level 9`, `Flat 5`, `PO Box`, `C/-` — keeps what
is in front of it, and then **refuses the result** unless it holds letters, **no digit**, no word that belongs to a
postal address, and passes the store's own text guard. A cell it cannot split that way produces **no name at all**:
the entry is stored with `donor_name_status = 'not_separable'`. Never a best guess, never the whole cell.

That rule is enforced three times over, in three places that cannot drift apart without a test failing:

1. the reader refuses the value;
2. the import contract refuses every donor field name except three vetted ones
   (`donor_name_as_published`, `donor_name_status`, `donor_identity_kind`) — `address`, `street` and `postcode`
   stay refused outright, so a `donor_address` is refused twice over;
3. the **column itself** carries a CHECK refusing any value holding a digit or a street word.

There is no address column anywhere in either new table. Measured on the loaded store: **4,942 public text values,
0 holding a digit, 0 holding a street word.**

### The arithmetic gate

A column-positional PDF text layer can silently drop a row at a page break or cut an amount in half. One 2025
return really does render an amount as `$ 50,`. Neither is visible in the output. So an itemised entry is published
**only** when all of these hold for its part:

* the form printed a total for that part;
* every entry carries exactly one readable amount in the amount column;
* the printed row numbers, where the form prints them, run 1..N with no gap;
* the entries sum **exactly** to the printed total, compared in whole cents.

Otherwise the part keeps its printed total, reports how many entries it declares, and publishes **no entry at all**.
`itemisation_status` and `itemisation_note` say which rule stopped it. A part that did not reconcile is a
measurement, not a failure.

### Checked against the publisher's own other publication

The Commission publishes the same money twice: inside the return, and as a total on its index page. The exporter
compares them and **never adds them**:

| Check | Result |
|---|---|
| Candidate returns whose Parts A + C + D are all present, compared with the Commission's published donations total | **153 of 153 agree exactly**, 0 disagree, 18 publish only some of their parts and are not compared |
| Party returns whose Parts A + C + D + F + G are all present, compared with the published party total | **3 of 3 agree exactly**, 0 disagree, 7 publish only some of their parts and are not compared |

### Double counting

Part A of an annual return **for a general-election year** also carries that year's separately published $20,000
notices — the form's own instructions say so. Every row therefore carries `overlaps_election_year_notices`, and no
view adds one publication to the other. 2025 is not an election year, so nothing held today overlaps; 63 rows (the
2023 candidate returns) are marked because their reporting year is one.

### What the law withholds

Parts C and F are the law's own categories for an anonymous donation and a donation protected from disclosure.
Their entries are stored with **no name** and `donor_name_status = 'withheld_by_publisher'`, and their **amounts are
published all the same**: what the law withholds is the identity, not the money. A constraint refuses a name on such
a row. Nothing anywhere tries to work out who they were.

### Identities are never merged

A donor is the words the return prints. Two entries carrying the same words are two entries; nothing here asserts
they are the same person or organisation, and no donor total across returns is computed. The loaded data really
does contain a pair like that - two returns, filed by different parties, printing the same person's name in the two
orders their forms use. They stay separate rows, because deciding they are one person is a judgement this project
has not made and has no evidence for.

## 4. Coverage, stated exactly

| | P25 (2023 candidate) | P26 (2025 party) |
|---|---:|---:|
| Return document versions offered | 492 | 23 |
| Read as the Commission's form | **171** | **10** |
| Not recognised as the form | 315 | 9 |
| Recognised but with no part summary | 6 | 4 |
| Part disclosures published | 1,277 | 58 |
| Parts whose entries reconciled | 30 | 3 |
| Itemised entries published | 63 | 228 |
| Donors named | 63 | 224 |
| Donors not separable (no name kept) | 0 | 4 |

Loaded totals: **1,335 part disclosures, 291 entries, 287 of them naming a donor.** This is a small part of
political donation in New Zealand and the explorer says so on the page itself.

## 5. The owner decision

`OWNER-AUTH-2026-09-21-03` in `governance/owner-authorizations.json`. Publishing a donor's name is an **owner
decision**, not a rights review and not compliance. It is mirrored by a new scope kind, `published_donation_facts`,
which:

* names a closed list of eight tokens (the donor name, its status, the identity kind, the entry amount, the part
  total, the total status, and the basis) — nothing on it can hold a location, a contact or a document;
* is accepted **only** for a source registered as one of the two return-disclosure products — never for the document
  indexes those disclosures were read from;
* is re-checked where the release tier is actually read (`evidence_private.source_release`), so a decision cannot
  survive a change to the source it names.

Every rights row stays **pending / link-only**. Every REVIEW-REGISTER row stays PENDING. `release_basis` still
reports `owner_override`. A publisher's recorded refusal or restriction still beats the decision — pgTAP proves it:
marking the rights row `restricted` hides every donor name at once.

Explicitly **not claimed** (in the entry itself): no legal review, no publisher licence, no donor consent, no
completeness, no audit, no claim about any donor's motive or influence, and no substitute for the $20,000 notices.

## 6. What a reader sees

A new explorer page, **Donations** (`/donations`), reads the curated view `evidence_public.donation_disclosures`,
where the donor, the recipient, the amount, the dates, the official link to the return **and the part's own
itemisation status** are in the SAME ROW. That is deliberate: a reader can never be given a figure without being
told how complete the reading of its part was. Three notices on the page state, before the table: that this is not
a complete record; that no address, contact detail, signature or bank detail is held; and that the $20,000 notices
are not collected and must not be added to these rows.

Measured as `anon` on the loaded store:

| | |
|---|---:|
| Rows a reader receives | 291 |
| With a donor name | 287 |
| With an amount | 291 |
| With the official link to the return | 291 |
| With the part's itemisation status | 291 |
| With the part's printed total | 291 |
| With dates the return states | 234 |
| Part disclosures (`evidence_open.donation_return_parts`) | 1,335, all with total, status, label and link |

The Finance page's old notice — *"No donor data is held"* — was true and is no longer, so it now says what that page
is (the index of filed returns) and links to the Donations page. The publication notice at the top of every page
does the same: while `published_donation_facts` is in force it drops the sentence claiming this project never
collected a donation record, and states instead what a donation row holds and what it can never hold.

## 7. What was run

All on an isolated, disposable stack; the hosted database was never contacted.

| | Result |
|---|---|
| `supabase db reset` (every migration, including `20260921080100`) | applied clean |
| `supabase test db` | **20 files, 674 assertions, all pass** (new: `127_donation_disclosures.test.sql`, 31 assertions) |
| `node src/cli.ts import election` (11 units) | 4,074 ledger records, 0 rejected |
| the same command again, as a replay | **0 inserted** — every record already at its latest version |
| `node src/cli.ts reconcile election` | **11 of 11 reconciled**, every named check passed |
| node suite | 279 tests, 271 pass, 7 skipped, **1 known failure** (§8) |
| `npx vitest run` (web) | 46 pass |
| `npm run types:check`, `vite build`, `tsc --noEmit` | pass |
| `scripts/validate.py`, `scripts/red_lines.py`, `pytest tests` | pass (26 products, 353,336 records; 20 python tests) |

Every receipt pins the clean commit `cd99e0c` with `dirty: false`; the CLI was run from a clean checkout and the
stack from a clone of the same commit. Receipts:
`receipts/2026-09-21-election-donations.export.json`, `receipts/2026-09-21-election-donations.load-proof.json`.

Playwright e2e was **not** run: it seeds fixtures and opens both release gates, which would destroy the measured
state, and three other stacks were already running on this host.

## 8. Known, and not papered over

1. **The combined reconciliation manifest is stale, and was already stale before this branch.**
   `docs/database/receipts/unified/reconciliation-manifest.json` names tested commit `1e1184c`; migrations
   `20260921060100` and `20260921070100` landed after it on the parent branch. `loaders_contract.test.ts` refuses a
   manifest older than the source and therefore fails — at `8d33ea6`, before any change here, and still. This branch
   does not re-pin it: that would be asserting a proof that was not run. The two new routes are consequently
   `built_not_proven`, which is what the coverage file says. A combined load across all four families would clear
   both; that is the coordinator's run.
2. **P13's pin no longer matches the upstream store.** A fresh export cuts 76 rows where the pin says 75: the party
   policy monitor re-observed a page after the pin was taken. The pin is left alone and the load above used the
   pinned 2026-09-20 P13 file. This is upstream drift, not a defect of this branch, and re-pinning it is a decision
   for whoever re-runs that export.
3. **Coverage is small and will look disappointing.** 171 of 492 candidate returns and 10 of 23 party return
   versions could be read; 33 parts reconciled out of 1,335. Every unread document and every unreconciled part is
   counted in the receipts and reported on the page, rather than rounded away.
4. **`not_separable` is a real gap, not an error.** Four entries in the 2025 party returns name someone the reader
   could not separate from the address printed with them, so no name is kept for them. Their amounts and dates are
   published.

## 9. Applying this to the hosted store — the exact sequence, for whoever owns that run

**Nothing below was run by this branch.** The hosted database was not contacted at all, and the import worker and
release work active there were not touched. This is the sequence, in order, with what to check between steps.

Before anything, **measure**: never assume which migrations the hosted store already has.

```sh
# 0. What is actually applied there, and how much is in it.
psql "$HOSTED_ADMIN_URL" -c "select version from supabase_migrations.schema_migrations order by version desc limit 6"
psql "$HOSTED_ADMIN_URL" -c "select count(*) from evidence_private.source_records"
```

1. **Apply only what is missing.** `20260921080100_donation_disclosures.sql` is additive: two new tables, one new
   projector registration, a redefinition of `payload_violation`, `owner_scope_guard`, `source_release`,
   `sync_owner_authorizations`, one new curated view, and a final `classify_public_columns()` +
   `rebuild_exposed_views()`. It assumes `…060100` and `…070100` are already applied; if they are not, they go
   first, in order. **Never edit an applied migration.**
   `rebuild_exposed_views()` takes exclusive locks — apply migrations while **no loader is running**, or the
   rebuild deadlocks and loses.

2. **Sync the registry**, which adds the two sources, their two registry products and the two rights-row mappings:
   `node ingest/src/cli.ts registry-sync`. Schedules always sync as inactive; both new sources are `enabled: false`
   and have no live route to enable.

3. **Mirror the owner decision**: `node tools/owner_authorization.ts` first, read its output, then
   `psql -v ON_ERROR_STOP=1 -f scripts/db/sync_owner_authorizations.sql` from the repository root. The whole file
   is carried every time. `OWNER-AUTH-2026-09-21-03` is **immutable once mirrored**: editing the JSON afterwards
   makes the next sync fail with *"differs from what was recorded"*. To change it, revoke it and record a new id.

4. **Put the two export files where the loader can read them** — outside the repository, owner-only — and name them
   by environment variable only: `EVIDENCE_EXPORT_ELECTION_P25`, `EVIDENCE_EXPORT_ELECTION_P26`. They are pinned by
   checksum, row count, record count and wave count; any other file fails closed.

5. **Validate before writing anything**: `node ingest/src/cli.ts validate P25 P26`. Both must say `valid`. This
   re-hashes each file against its pin and checks every row against its closed contract, including the donor-key
   rule, before a run exists.

6. **Import, then replay, then reconcile**, keeping the receipts:

   ```sh
   node ingest/src/cli.ts import    P25 P26 --receipt-dir <private dir>/import
   node ingest/src/cli.ts import    P25 P26 --receipt-dir <private dir>/replay     # must insert 0
   node ingest/src/cli.ts reconcile P25 P26 --receipt-dir <private dir>/reconcile
   ```

   Expected, from the load proved here: P25 1,340 records / 1,277 `donation_return_parts` + 63
   `donation_disclosures`; P26 286 records / 58 + 228. The replay must report `inserted: 0` for both, and every
   reconcile check must pass. **If the replay inserts anything, stop** — the artifact and the store disagree.

7. **Regenerate the browser types and rebuild the explorer** (the new curated view changes
   `web/src/lib/database.types.ts`): `npm run types:generate` then `npm run types:check` in `web/`.

8. **Read back what a reader gets**, as `anon`, before believing any of it:

   ```sql
   set role anon;
   select count(*) filter (where donor_name_as_published is not null) as named,
          count(*) filter (where official_url is null)                as without_a_link,
          count(*) filter (where part_itemisation_status is null)     as without_a_status
     from evidence_public.donation_disclosures;
   reset role;
   ```

   `without_a_link` and `without_a_status` must both be **0**: a reader is never shown a figure without the
   document it came from and the label that says how complete it is.

**To undo the publication without a deployment**: set `"status": "revoked"` on `OWNER-AUTH-2026-09-21-03` in the
file, commit, and run the sync again. Every donor name and amount is withheld at once. The rows stay in the store;
what changes is what the projection shows.
