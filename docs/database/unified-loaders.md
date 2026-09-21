# Unified data loaders: one contract for all 24 catalogue products

> **Status: integrated, and verified on an isolated disposable local database at commit `1e1184c`** (section 5: two full loads in opposite family order, a killed and resumed load, and a row-by-row content comparison in which **all 85 tables are identical**). **Not hosted, not published, not reviewed, not security signed off.** Nothing here was pushed, merged, deployed or written to a hosted project, and no schedule is active. Every rights row is still **pending / link-only**, every `REVIEW-REGISTER.md` row is still **PENDING**, and the release gates are closed: a loaded row is not a published row. The figures are counts of what was read and stored on 20-21 September 2026 (UTC); they make no claim that a publisher's output is covered completely.

The three import families were built on separate branches (election `b8fc629`, parliament `69de0d2`, statistics `b91595a`). This branch integrates them: one migration union, one registry, one CLI contract, shared orchestration, and the explorer wiring. The families' own documents stay the reference for their mappings: [election](../../ingest/src/families/election/README.md), [parliament](../../ingest/src/families/parliament/INTEGRATION.md), [statistics](statistics-import.md). Their "coordinator steps" are done here.

## 1. The contract

One CLI, `ingest/src/cli.ts`, registry-driven. Every source of every family is reached through the same six commands and answers with the same receipt.

| Command | What it does | Database | Network |
|---|---|---|---|
| `plan TARGET` | What would be read and written, from the registry and the private inputs | no | no |
| `validate [TARGET]` | The merged registry, rights rows and route coverage; with a target, the private inputs too: re-hashed against their pins and checked row by row against their closed contracts | no | no |
| `dry-run TARGET` | The whole import path short of a write: preflight, waves or generations, batches | no | no |
| `import TARGET` | Backfill: private artifact to store. Replay-safe, checkpointed, resumable | worker login | no |
| `refresh TARGET [--dry-run] [--backfill]` | Current-refresh route: fresh anonymous fetch to store. **`--dry-run` still contacts the publisher** (it fetches and parses, and writes nothing) | worker login | public endpoints only |
| `reconcile TARGET` | Read-only: what the store holds against what the private inputs say it should hold | worker login | no |

`TARGET` is `all`, a family (`core`, `election`, `parliament`, `statistics`), a catalogue product (`P01`..`P24`), a unit or a source id.

**A source id is an exact identity** (`selectUnits` in `cli.ts`). It is never widened to the other sources of its unit and never exchanged for another source:

| Command | What runs |
|---|---|
| `refresh UNIT` | the unit's plain refresh sources |
| `refresh UNIT --backfill` | the unit's whole-history walk; an error if the named unit has none. Through `all`, a family or a product, the flag selects only the units that have a walk, and it is an error if none has |
| `refresh nz_parliament_written_questions_backfill` | exactly that walk, with or without the flag. (Before this was fixed the id resolved to its unit and the **recent** source ran instead.) The run mode follows the source that runs, not the flag |
| `refresh nz_parliament_written_questions_recent --backfill` | refused: the flag contradicts the source that was named |
| `import`, `reconcile`, `plan`, `validate`, `dry-run` with a refresh-only source id | refused: they act on the backfill input of a unit. (Before, they silently acted on the unit's export.) |
| `import UNIT --backfill` | the older runbook spelling of `import UNIT`; accepted, changes nothing |

Every receipt names the `source_ids` that really ran. `coverage` prints the route of every product; `registry-sync` upserts sources, the rights mirror and schedules (always inactive). `run SOURCE` and `import SOURCE --dry-run` still work as before.

Exit codes: `0` ok, `1` usage or configuration, `2` a run failed, `3` an input was refused, `4` not reconciled, `5` the route is blocked.

### What is shared (`ingest/src/loaders/`)

| Module | Shared rule |
|---|---|
| `contract.ts` | Statuses, a **closed** list of error codes, exit codes, the provenance block (adapter, **the commit of the checkout that produced the receipt and whether it was clean**, input digest, deterministic run manifests, collection window) and the count receipt (section 1a). A run succeeds only if every check passes, the counters obey their invariants and nothing was rejected or in conflict; a count that could not be read is not a pass. |
| `access.ts` | **Privacy:** a private input must sit outside the repository and be unreadable by group and others (0600 files in a 0700 directory); its location is never echoed. **Source access:** only endpoints served to the anonymous public; a probe, a challenged route or a route that waits on a person's decision is never contacted and answers `blocked`, never "no records". **Outputs:** every string of a receipt passes the ledger guard before it is printed. |
| `connect.ts` | One way to reach the store: a login that is a member of `evidence_ingest` and nothing more; an elevated login is refused. |
| `retry.ts` | Only a transient database failure or a run that stopped at its budget is repeated. Every write path is idempotent and checkpointed, so a repeat resumes and never doubles. A refused input, a rejected row, a failed check or a blocked publisher is final. |
| `ledger.ts`, `typed.ts` | The refresh route of the ledger families, and the typed destination tally every family's reconcile uses. |
| `registry.ts`, `coverage.ts` | The one registry and the route coverage of the 24 products (sections 3 and 4). |

Leases, checkpoints, run status and tombstones stay where they were: the versioned `evidence_private` functions (`acquire_lease`, `start_run`, `save_checkpoint`, `finish_run`). Every call is one autocommit statement with no session state, so a transaction-mode pooler is fine.

### 1a. Counters: one block per population, never added across

A ledger record, a statistical observation and a catalogue entry version are different things, so a receipt (version 3) carries one `written` block **per population** (`ledger_records`, `stat_observations`, `stat_catalogue_entries`) and there is no function that adds across them. Earlier receipts added observations and catalogue entries into one block, and a union total could show more rows inserted than seen; that total no longer exists.

- Per population: `inserted + unchanged + rejected + conflicts = seen`, so `inserted <= seen`. `settle` checks it on every finished command and the manifest builder checks it again per unit; a violation is a named fault (`count invariants`), never a rounding note. `tombstoned` counts records that were *not* seen and is outside the sum.
- The statistics blocks come from what **the store reported** for each population (`ingest_stat_observations`, and `catalogue_entries_seen / _inserted / _unchanged` of `ingest_stat_meta`). A catalogue version whose observation span merely widened on a later sighting is *unchanged* (reported apart as `catalogue_entries_span_widened`), not inserted. Series, geographies, datasets and releases are definitions, not rows of either population: they stay in `family_detail.totals.meta`.
- A unit of catalogue metadata only (`stats_nz_csv_catalogue`, `stats_rbnz_catalogue`) has **no observation block at all**. A dry run offers nothing to the store and has no written block; what it read is `planned_ledger_records`.
- `input.by_population` states what the input holds per population. The manifest aggregates per population (`totals.first_pass`, `totals.replay`, `totals.input_by_population`).

### What is not shared, on purpose

Each family keeps its typed destination and its own writer. The adapters in `ingest/src/loaders/families/` wrap the families' real importers; nothing is re-implemented and nothing is flattened into a generic JSON shape.

| Family | Writer | What the adapter wraps |
|---|---|---|
| core | ledger records + registered projection | the pinned 2023 candidacy export (`export_import.ts`) and the three live sources |
| election | ledger records + `project_election_family_run` | `operations.ts`: history replayed in waves, per-kind closed contracts, identifier joins to the 2023 candidacy product |
| parliament | ledger records + `project_parliament_family` | `import.ts`: pin, manifest, whole-file contract, history replayed in ordered generations |
| statistics | **typed bulk writer** (`ingest_stat_meta`, `ingest_stat_observations`, 5,000 rows a call) | `loader.ts` and `live.ts`: typed artifact, decimal text end to end, withheld is null with a status |

## 2. Where the families collided, and what was decided

**The ledger guard (`text_violation`).** Two families met the same defect separately: the phone-number test read digit runs inside machine identifiers as phone numbers whenever the text also held "ph", "tel", "call" or "mob". The election family worked around it by writing digests with the digits 0-9 as the letters g-p; the parliament family corrected the guard for UUIDs and 64-character digests. There is now **one** copy, in `20260921000100_import_shared.sql`, with one rule: before the phone test, and only for it, *identifier tokens* are set aside: a UUID, or a whole token of 16 to 128 hexadecimal characters (digests, 16-character release keys, undashed publisher ids). A phone number is at most 12 digits, so it is never such a token, and a number printed beside an identifier is still refused. Every other test sees the whole text. The election encoding stays, because it is part of every stored content hash of that family (changing it would make a new version of every record); it holds no digit run and passes as before, and the projection still decodes the one reference it joins on. `supabase/functions/_shared/text_guard.ts` is the one TypeScript mirror (the election and statistics preflights each carried a partial one); `ingest/test/fixtures/text_guard_vectors.json` is run through both, offline and against the database. Known limit, kept on purpose: a hexadecimal-looking run *shorter* than 16 characters beside such a word is still refused.

**`project_run`.** The parliament branch replaced it with a loop over a registry of projectors; the election branch expected one key to be added by hand. `run_projectors` and the one `project_run` now live in the shared migration; each ledger family registers its projection with one insert, and nobody replaces the function. A run of one family's records leaves the other family's tables untouched, and the P04/P09 cross-route check resolves to `agrees` in either load order (pgTAP `120_unified_import.test.sql`). Statistics registers none: it has its own typed writer.

**The statistics tables enforce their own rules (`20260921030100_stats_import.sql`, section 3a).** No function in the evidence schemas may run as its owner (pgTAP 020/090), so the statistics functions are `SECURITY INVOKER` and the worker must hold table privileges for them to work, which means the same login can also send plain DML. An independent review found that those grants (`INSERT/UPDATE` with `USING (true) WITH CHECK (true)`) let plain DML bypass everything the functions checked. Taking the privileges away would stop ingestion, so the rules moved **into the tables**, where they bind every role and every path:

| Rule | How the table enforces it |
|---|---|
| Least privilege | No `DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER`. No `UPDATE` at all on observations, series or geographies. `UPDATE` by column only on the few columns an honest replay moves (dataset descriptive fields; a release's `retrieved_at`, `capture_count`; a route's note and overlap counts; a catalogue version's observation span and current flag; the summary's counts) |
| Source and run ownership | Statement-level triggers (`guard_stat_write`, set-based over the rows a statement wrote): a row may be written only while its source is a **statistics** source with a run that is `running` under a **live lease**; a row that carries a run id must name such a run of its own source; an observation's series, release and geography must all belong to that source, and its route must be the dataset's. A route row may be written only for a dataset of an open source |
| Text and privacy | `CHECK (text_violation(...) is null)` on every stored string of all seven tables (the same guard as the ledger) |
| Append-only, one-way | `guard_stat_update`: an observation, a series or a geography is never updated (this binds the table owner too); identities, sources and routes never change; `retrieved_at` only moves earlier, capture counts and observation spans only grow |
| Conflict | The identity indexes: a second row of one identity is an error, never an overwrite |
| Catalogue currency | The current version is the one observed last, and only it: neither half of demote-then-promote can be abused to hide the newest version or promote an old one |
| Reconciliation | `guard_stat_source_summary`: a summary is accepted only inside an open run of its source and only if every count equals what the tables hold at that moment |

The worker can neither alter nor disable a trigger (it owns nothing). `115_stats_table_boundary.test.sql` first loads two sources **as the worker role through the functions**, then sends 44 hostile statements as that same role (inserts, updates, deletes, truncate, trigger tampering) and asserts the SQLSTATE of each refusal; `loaders_integration.test.ts` repeats the core of it with the real bootstrapped login, which is a member of `evidence_ingest` and nothing more. **Limit, stated plainly:** the login is one principal. Anyone holding it can start a run legitimately and write rows that pass every rule; what the boundary guarantees is that every stored row belongs to a recorded, leased run of its own source and obeys the text, append-only and conflict rules, not that a particular process wrote it. The same `USING (true)` pattern remains on the *ledger families'* typed tables (election, parliament, core): those are projections rebuilt from the guarded ledger, a different risk that the review did not raise and this change did not touch; it should be looked at in the security review.

**Which version a shared civic row cites (`20260921050100_electorate_version_authority.sql`).** An electorate version is
shared: the 2023 candidacy roster and the 2023 electorate results both name the same electorate, and the single
`evidence_version_id` pointer could only hold one of them, so whichever family was loaded first won it. That is a fact
about how the coordinator drove the load, not about what a publisher said, and it was the last difference between two
stores loaded in opposite order. It is not fixed by picking a winner more cleverly but by keeping the other assertion:

- `electorate_version_attestations` records **every** version that asserts an electorate version, keyed by the
  electorate and boundary edition rather than by a surrogate id, so an assertion survives an insert that conflicted.
  Nothing is discarded and every source stays resolvable to its record and content hash (2,286 attestations over 72
  electorate versions in the real load).
- `evidence_version_id` is then chosen from those attestations by **publisher data alone**
  (`authoritative_electorate_version`): the earliest date a publisher states, then the publisher's own source id, then
  its record id, then the content hash. The same attestations give the same answer in any order, and the answer is
  always one of the recorded assertions (both are asserted by pgTAP).
- Attestations are captured by a `BEFORE INSERT` trigger, which sees the row a projection **proposes** even when that
  insert goes on to conflict, so no projection function had to change and **no already-applied migration was edited** —
  it is a new migration that backfills the attestation of every row it finds, so a store that already holds rows keeps
  the pointer it has. The promotion is a **deferred** constraint trigger: a projection's own `insert … on conflict do
  update` may not affect one row twice in a single command, and every write here is one autocommit statement, so
  "deferred" means "as soon as this write commits".

**Registry.** `sources.config.json` is now the merge of the core sources and the three fragments: 49 sources, 16 registry products, 8 schedules, config version 2. It is rebuilt by `node src/loaders/registry_build.ts --write` and held equal by test. A source id, schedule key or registry product claimed twice is **refused, not resolved**. Every source must sit under a rights row that lists its catalogue product, or under a written exception with its reason (two exist: the 2023 candidacy product stays on RIGHTS-01, and ministerial roles sit under the Government's row because they are read from the Government's pages). The 2013 Census history had been filed under the 2018 Census row; it now has its own pending row, RIGHTS-22.

**Live adapters.** The parliament and election live adapters moved under `supabase/functions/_shared/adapters/` so that a scheduled run finds them in the function bundle (`deno check` passes). Statistics fetch sources stay CLI-only (their files exceed the function budget); a schedule that names one is refused.

**Statistics semantics that were kept.** The observation hash covers what the publisher printed (identity, period, value, raw text, status, flag, symbol, qualifiers), not how or when it was read, so a byte-identical re-fetch reports every row unchanged. The 2013 meshblock history is its own source, flagged `historical`, answers no catalogue product and is never summed with anything. Overlapping routes are imported once and only counted otherwise: P19's 877 operational records are a subset of the 4,966 imported; each of nine release files was captured twice and is imported once (`capture_count = 2`).

## 3. Route coverage of the 24 products

`node src/cli.ts coverage` prints this from `ingest/src/loaders/coverage.ts`, where each state names what it rests on. **A claim that a load was done is never written by hand:** a backfill source reads `loaded_and_reconciled` only while the committed manifest (`docs/database/receipts/unified/reconciliation-manifest.json`) shows that unit imported, replayed without a single insert, and reconciled; without that it reads `built_not_proven`. A test refuses a manifest that does not cover the source as it is now (any change under `ingest/src`, `supabase/migrations` or `supabase/functions` after the commit it tested). Tests hold it equal to the registry and the catalogue: every product has a backfill route, and a product without a working refresh route says why.

| Product | Backfill route (pinned export; loaded and reconciled, section 5 and the manifest) | Refresh | State of the refresh route |
|---|---|---|---|
| P01 Beehive releases | releases history, release attributions | `nz_government_releases_feed` | **works** (scheduled). The archive listing is challenged: blocked |
| P02 Bill publications | bill publications | `nz_parliament_bill_publications` | works from the CLI, **disabled pending a person's decision** (robots.txt advisory; index rule checked on three bills) |
| P03 Current bills | current bills history, bill register | `nz_parliament_current_bills` | **works** (scheduled) |
| P04 2023 candidate roster | pinned candidacy export | none | final 2023 results do not change; the publisher challenges this host |
| P05 Committee business | committee business | `nz_parliament_committee_business` | **works** (scheduled) |
| P06 Committee report files | report files | none of its own | reached through the P07 index; no file is ever downloaded |
| P07 Committee report index | committee reports | `nz_parliament_committee_reports` | **works** (scheduled) |
| P08, P09 2023 results | nationwide table, electorate pages | none | final; publisher challenges this host |
| P10 Current members | member terms, minister roles | `nz_parliament_mp_directory` | **works** (scheduled). Dated terms are export-only and will go stale |
| P11 Health NZ, P12 MSD | typed artifacts | listing pages | **works, operator-run**; facts need a person's cell-mapping review per workbook |
| P13 Policy pages | policy pages with history | `party_policy_pages_2026_monitor` | **works** (scheduled): hash and title only |
| P14 Polls | polls with history | `party_vote_polls_index` | **works** (scheduled): a change signal, creates no poll row |
| P15, P16, P17 Political finance | document indexes and published totals | none | publisher challenges this host |
| P18 Reserve Bank, P20 Stats NZ CSV listing | catalogue entries | public catalogue API, listing page | **works, operator-run** |
| P19 2018 Census | typed artifact | none | closed release in a ZIP archive |
| P21 2023 Census | typed artifact | none | workbooks; the publisher's API needs a subscription key and is not used |
| P22 Stats NZ series | selected series, nine release files | newest selected price indexes CSV | **works, operator-run** |
| P23 Rental bonds | typed artifact | regional monthly CSV | **works, operator-run** |
| P24 Written questions | 187,956 questions | recent window (scheduled); the whole-Parliament walk is a separate source id | recent window **works**; the walk is `exercised_not_run_in_full` (about 1,900 paced requests, never run end to end: blocker 6). Naming the walk now runs the walk, not the recent window (section 1) |

**Not published for 2026 by any route, and recorded as unknown, never as zero:** nominations and party lists (the last upstream observation is `official_page_unavailable`, candidate details `unknown`); the 2026 register of political parties; the number and names of the 2026 electorates (only three official boundary summary map links are loaded, as links). No candidate, party registration or electorate was fabricated.

## 4. What the explorer shows

- **Routes and held data are kept apart.** The coverage panel takes which routes exist from a file generated from section 3 (`web/src/lib/release-coverage.json`, held equal by test) and what is **held** from the database at read time. A route that has never been loaded into the store a reader is looking at never reads as coverage.
- **Statistics sources show their observations.** They write typed observations, not ledger records, so the sources view read "0 records" beside a million observations. The loader now records a per-source summary when a load finishes (`stat_source_summary`), and the sources list and source page show observations, catalogue entries, and the cells the publisher printed no number for, counted apart.
- **Rights are never shown as approved.** The rights badge reads the register (pending). Where a field is shown on an owner decision the source row and the source page say so, and the notice on every page now also says that published figures of statistics sources are shown on that decision and that votes, poll figures and money are not.
- **Every dataset can be inspected.** Every new table has a recorded lineage, so it has a projection in the dataset browser with its columns, their release class and any withholding reason. At the link tier a reader sees identifiers, official links, dates, hashes and statuses; content is blank unless a recorded decision names the field.

### Owner scopes

The existing owner scope, `source_fields`, refuses any field whose name holds "value", "total", "amount", "vote", "pct" and so on. That is right for votes, poll figures and money, and it means the scope **cannot represent an official statistic**. Rather than loosen it, statistical facts get an explicit scope of their own, `statistical_facts`: a closed list of four columns (`value`, `value_double`, `raw_value`, `value_status`), available only to a source registered as official statistics, beside the rights row that really governs it. It is an owner decision like the others: the release tier stays `link_only`, the rights row stays pending, and a publisher's refusal still hides everything. The database constraints and `tools/owner_authorization.ts` agree (tested both ways).

`governance/owner-authorizations.json` gains `OWNER-AUTH-2026-09-20-02`, an **owner override**: descriptive official metadata of the imported Parliament, election and statistics sources (42 field decisions), and the published figures of the eight statistics sources that hold observations. **Not in it, and refused by the validator where a name would match:** votes, vote shares, seats, list ranks, poll figures, sample sizes, money (including Commission-published totals), donors, anything read from inside a return, question/report/bill/release/policy text, files, publisher and private identifiers, policy classes (no reviewed classification exists), qualifiers and standard errors, and merged identities (names stay as each source printed them). `is_image_only` was drafted and refused by the forbidden-name rule; it stays out. 

**What `-02` is, and is not.** It is the owner's own decision, recorded as an override: the file says in its own words that it departs from RED-LINES R8 and R10 rather than complying with them, at the owner's risk and ahead of the independent reviews. The owner's authorization is real; it reached this build relayed by the release coordinator (the unified-loaders brief and the resume brief of 2026-09-20), and the original message is not held in the repository, which the entry states. It is **not** a legal approval, **not** a rights clearance from any publisher, and **not** a security sign-off, and nothing in this branch records one: every rights row stays pending and link-only, every review row stays PENDING, and the scopes listed above are unchanged by this work. The entry's machine status is `active`, as `-01`'s is; it has effect on a database only once an administrator mirrors it (`sync_owner_authorizations.sql`), and an entry is immutable once mirrored, so the owner should read `-02` in full before the coordinator syncs it.


## 5. Verification

Everything below was run on an **isolated, disposable local stack** built from the full migration union: its own Supabase
project id and its own ports, with exclusive ownership recorded beside it. The shared local stack and every hosted
project were left alone; nothing was reset but this lane's own database.

**The code under test is commit `1e1184c`.** Every command was run from a **fresh clone** of that commit, and every
receipt carries the commit of the checkout that produced it together with whether that checkout was clean
(`provenance.source_revision`). The manifest builder refuses a set of receipts that does not all come from one clean,
stated commit — that refusal is exercised, not assumed. The committed manifest is
[`receipts/unified/reconciliation-manifest.json`](receipts/unified/reconciliation-manifest.json); the private receipts it
is built from stay outside the repository.

### The two loads

Each load went into a **freshly reset** database and covered **all 31 backfill units** of the four families:

| | Order A | Order B |
|---|---|---|
| Family order | core, election, parliament, statistics | statistics, parliament, election, core |
| Units imported | 31, all `succeeded` | 31, all `succeeded` |
| Replayed (import again) | 31 units, **0 rows inserted** | 31 units, **0 rows inserted** |
| Reconciled | 39 units, 282 checks, **0 failed** | 39 units, 282 checks, **0 failed** |
| Interruption | none | the written-questions load was **killed** mid-run and resumed |

What the inputs hold, and what the first pass did with it, per population (never added across populations, section 1a):

| Population | In the inputs | Seen | Inserted | Unchanged | Rejected | Conflicts |
|---|---|---|---|---|---|---|
| Ledger records | 203,311 | 182,223 | 182,023 | 200 | 0 | 0 |
| Statistical observations | 1,273,423 | 1,273,423 | 1,273,423 | 0 | 0 | 0 |
| Catalogue entry versions | 983 | 983 | 983 | 0 | 0 | 0 |

The ledger `seen` figure is **lower than the input** for one reason, and it is the interruption: the process that was
killed wrote no receipt, so the surviving receipt of that unit covers the 166,756 records the **resumed** run was
offered and not the 21,400 the killed run had already stored. What the store then holds is shown by that unit's
reconcile receipt, not by adding receipts up. By family, first pass: core 963 ledger records (the pinned 2023 candidacy
export), election 2,448, parliament 178,812, statistics 1,273,423 observations and 983 catalogue entry versions.

Two counts that are close together and are **not** the same thing, and are kept apart everywhere:
**`source_records` holds 203,311 rows** (one per distinct publisher item) while **`source_record_versions` holds 203,423
rows** (one per distinct content of an item, so an item seen with two contents has two). All 31 units pin the digest of
the private input they read; the inputs state a collection window of 2026-09-12 to 2026-09-19.

### The killed load, and what it proved

The written-questions load (187,956 questions, the largest ledger unit) was killed with `SIGKILL` after it had stored
21,200 records and 53 checkpoints. What the database held at that moment is the reason the shared `project_run` projects
a whole resume chain: **21,200 ledger versions and 0 typed rows**, because a killed run never projects. Then:

1. Re-running immediately, while the dead worker's lease was still alive, answered `skipped_lease_held` (exit 2) and
   wrote nothing: a dead worker's lease is not stolen and no row is doubled.
2. Once the lease lapsed, the same command **resumed from the checkpoint** — offered 166,756 records, the ones after the
   checkpoint — and finished `succeeded`, citing the killed run as the one it resumed (`resumed_from_run_ids`, which the
   manifest lists under `resumed_after_a_hard_stop`). The killed run is left `abandoned(21,400)` on the ledger.
3. The store then held **187,956 ledger records, 187,956 versions and 187,956 typed `written_questions`**, and that
   unit's reconcile receipt puts the export's 187,956 distinct items and 187,956 distinct contents against exactly those
   numbers.

### The two stores compared by content, not by counts

`node src/loaders/content_digest.ts` digests every row of every table of `evidence_private`, and the two stores are
compared table by table (`order_independence` in the manifest). It compares what rows **refer to**, not the ids they
refer with, because a surrogate key differs between two honest loads by construction: **85 tables compared, 62 hold
rows, 2,364,293 rows in total**, and 113 reference columns replaced by the content of the row they point at. One of those
references had to be **discovered by measurement** (`source_records.current_version_id` has no declared foreign key:
every value was verified to be an id of `source_record_versions`), and **no uuid column was left unresolved**. What is
left out is named with its reason in the digest itself: surrogate keys, columns the database clock fills, references to
the run ledger, columns that are always null, and one `jsonb` column that carries an identity's surrogate id inside its
value. The run-ledger tables (`import_runs`, `fetch_log`, `run_checkpoints`, …) are counted and never compared: how many
runs there were depends on how the load was driven. Both digests report themselves **complete** (the login reads every
table and bypasses row-level security; the worker login cannot produce evidence here, and says so).

**Result: all 85 tables are identical — same row counts and same content — and no unit reconciles differently.**

> **Where this evidence now lives.** The committed manifest was rebuilt against commit `8d33ea6` (the head of the
> public-values work) because `loaders_contract.test.ts` refuses to carry a load proof across a source change: the
> two publication migrations added after `1e1184c` invalidated the older manifest's grant. That rebuild is a
> **single-order** load — 31 units imported, replayed with zero inserts anywhere, and 39 of 39 reconciliations
> `reconciled` over 282 checks — so `order_independence` in the manifest is now `null`. The two-order comparison in
> this section is unchanged evidence about `1e1184c`, and it still describes this code: `git diff 1e1184c 8d33ea6 --
> ingest/src supabase/functions ingest/package.json ingest/package-lock.json` is **empty**, so not one byte of a
> loader, an adapter, an Edge Function or a pinned dependency differs between the commit that was compared in two
> orders and the commit the manifest now names. Only the anonymous projection changed. Re-running both orders
> against `8d33ea6` would restate the same result; it has not been done, and nothing here claims it has.

| What was compared | Result |
|---|---|
| Data tables, row counts | 85 of 85 equal |
| Data tables, content digests | **85 of 85 equal** (`identical: true`) |
| Units whose reconciliation differs | **0** of 39 |
| Units whose replay inserted anything | **0** of 31 |
| Count invariant violations | **0** |

That includes the 72 `electorate_versions` and the 2,286 `electorate_version_attestations`: loading the roster first and
loading the results first now leave byte-identical provenance, because the citation is chosen from the attestations by
publisher data (section 2) instead of by whoever arrived first. Measured before the fix: the same 72 rows cited
`baseline_2023_candidacies_export` when core was loaded first and `election_2023_electorate_results_export` when
election was; measured after it: `baseline_2023_candidacies_export` both ways, with both sources' assertions kept.

Three defects of one kind were **found by this comparison and fixed**; each was a stored value chosen by a random
surrogate key, and none of them would have been visible from row counts:

- the cross-route check compared a source's electorate party votes against a nationwide total picked by
  `order by result_set_id limit 1` (`da78f28`); it now prefers the source's own published total and otherwise takes the
  remaining totals in source order, naming the publisher of the figure it used;
- the parliament identity projection chose `person_source_identities.first_version_id` with
  `distinct on (…) order by …, version_id` (`2ecd178`) — that one differed even between two loads in the *same* order;
- the shared electorate version cited whichever family loaded first (`1e1184c`, section 2).

### Tests, on the committed code

| Check | Result |
|---|---|
| `supabase test db` (pgTAP) | **556 tests pass** — on an empty database **and** on the fully loaded 2.36M-row store. A test that only passes on an empty store hides exactly the kind of defect found here, so both states are checked |
| `npm test` (ingest, Node 24) | **267 tests pass, 0 failed, 0 skipped**, with the database-backed integration tests required (`EVIDENCE_REQUIRE_INTEGRATION=1`). The one test that used to skip needs the private exports; it was run with them and passes |
| `npm run check:deno` | passes: the Edge Function bundle type-checks with the family adapters in it |
| `npm run typecheck` (ingest and web) | passes |
| `npm test` (web, vitest) | 44 tests pass |
| `npm run types:check` (web) | the committed generated database types match the migrations, including the new attestation projection |
| `python3 scripts/validate.py` | 24 products, 351,710 records, 52 roadmap lanes, 22 rights rows |
| `python3 -m unittest discover -s tests` | 20 tests pass |
| `python3 scripts/red_lines.py --freeze-check` | no red-line breaches |

Timings on this host, for the coordinator's planning: statistics takes about 7 minutes to import and 6 to replay;
parliament about 5 minutes each way; election and core under a minute; `reconcile all` about 2.5 minutes; the content
digest about 2 minutes (two refinement rounds over 2.36M rows).

### What this does not show

Nothing here was hosted, and the proof deliberately did **not** run the refresh routes: a refresh contacts publishers
and would write new release vintages into the store, which would make the two orders incomparable. The refresh states in
section 3 rest on the runs recorded in the family documents, not on this manifest, and the manifest records no refresh
run. `--dry-run` on a refresh is not an offline operation: it fetches and parses and only skips the write.

## 6. Hosted load: exact steps for the coordinator (none of it has been run)

**The hosted project is not empty and these steps do not assume it is.** It already has the base schema
(`20260920000100` … `20260920001400`) applied and holds the rows of the initial connected release — about **1,188 ledger
records** across the MP directory, the current-bills list, the releases feed and the pinned 2023 candidacy roster — with
their projections, including `electorate_versions`. Everything below therefore **measures first and acts second**: it
applies only the migrations that are missing, and the loads it runs are idempotent by design, so a source that is already
loaded answers with `inserted: 0` rather than doubling anything.

Credentials come from the operator's shell, a password file or a hidden prompt: no value appears below, none belongs on a
command line, and the CLI never prints one. The private companion to this section (input locations, sizes, measured
timings) is an operator file kept beside the exports, outside the repository.

```bash
# 0. WHAT IS THERE ALREADY. Read this before anything else; it decides nothing but tells you what the next steps mean.
supabase migration list --linked            # which of the five 20260921* migrations are missing (expect: all five)
psql -v ON_ERROR_STOP=1 -c "select count(*) as ledger_records from evidence_private.source_records"   -c "select source_id, count(*) from evidence_private.source_records group by 1 order by 1"   -c "select count(*) as electorate_versions from evidence_private.electorate_versions"   -c "select count(*) as runs from evidence_private.import_runs"
#    Write the numbers down: step 4 compares against them, and 1,188 records is the number to expect before any load.

# 1. MIGRATIONS, as ADMINISTRATOR, once, in order. Five new files after 20260920001400:
#      20260921000100_import_shared        20260921010100_election_family
#      20260921020100_parliament_family    20260921030100_stats_import
#      20260921040100_unified_import       20260921050100_electorate_version_authority
supabase db push --dry-run                 # read it: it must list ONLY those files, and no base-schema file
supabase db push
#    Do this BEFORE any load and NEVER during one: the union's last steps rebuild the public projections under
#    exclusive locks, and a loader running at that moment deadlocks with them (seen here; the rebuild was the victim).
#    What these migrations do to rows that are ALREADY there:
#      - 20260921050100 records, for every electorate version that exists, an attestation of the version it already
#        cites, then settles each row on the authoritative citation. With one source per row that is the pointer it
#        already has, so nothing moves. Check it did what it says:
psql -c "select count(*) as attestations from evidence_private.electorate_version_attestations"      -c "select count(*) as citations_not_authoritative from evidence_private.electorate_versions ev
          where ev.evidence_version_id is distinct from
                evidence_private.authoritative_electorate_version(ev.electorate_id, ev.boundary_edition_id)"
#        attestations must equal the electorate_versions that carry a citation, and the second number must be 0.
#      - nothing else in the union touches an existing row: the statistics tables are new, the family projections only
#        add typed rows for records their own run stored, and no base-schema file is edited.

# 2. REGISTRY, as the WORKER (EVIDENCE_INGEST_DB_URL in the shell; a pooler in transaction mode is fine here)
cd ingest && npm ci
node src/cli.ts validate                   # the merged registry, rights rows and route coverage. No database
node src/cli.ts validate all               # every private input re-hashed against its pin and checked row by row
node src/cli.ts registry-sync              # upserts sources and the rights mirror; schedules arrive INACTIVE
#    registry-sync is an upsert: the four sources already there keep their rows and gain the new columns.

# 3. BACKFILL. Any unit may be run at any time and re-run after a failure; each is its own lease and its own runs.
#    Smallest first, and the three sources that are already loaded come first so you see idempotency before volume:
node src/cli.ts import core                --receipt-dir <private receipts>   # the 963-row roster: expect inserted 0
node src/cli.ts import election            --receipt-dir <private receipts>
node src/cli.ts import parliament          --receipt-dir <private receipts>
node src/cli.ts import statistics          --receipt-dir <private receipts>   # see the note on the 2013 history below
#    A unit that is already loaded reports seen = its rows and inserted = 0: that is the same code path as the replay in
#    step 4, so it is proof rather than luck. A killed or stopped unit: re-run the same command. While the dead worker's
#    lease is alive the answer is skipped_lease_held (exit 2); once it lapses the run resumes from its checkpoint.

# 4. PROVE IT on the hosted store, with the same three steps as section 5
node src/cli.ts import all                 --receipt-dir <private receipts/replay>    # must insert 0 in EVERY population
node src/cli.ts reconcile all              --receipt-dir <private receipts/reconcile> # exit 4 on any mismatch
#    Then compare what the hosted store HOLDS against what the local proof held, by content and not by counts. The login
#    must read every table of evidence_private and bypass row-level security, or the digest says it is incomplete and is
#    not evidence (the worker login cannot be used for this, and reports complete: false):
EVIDENCE_DIGEST_DB_URL=<administrator, hosted, a DIRECT connection>   node src/loaders/content_digest.ts --out <private>/hosted-content.json
#    Compare its tables against data_tables in the committed manifest for the same commit. Expect:
#      - every table that the hosted store loaded from the same artifacts to match the manifest's content_digest;
#      - the run-ledger tables NOT to match, and they are not compared: the hosted store has the initial release's runs
#        as well as yours, which is history of loading and not data;
#      - a difference in any other table to be treated as a stop: read column_checksums, which names the column.
#    The digest holds one repeatable-read snapshot open for the length of the read (about 2 minutes for 1.6M rows), so
#    point it at a direct connection, never a transaction-mode pooler.

# 5. REFRESH the routes that work (anonymous, paced; a blocked route answers blocked and is never contacted)
node src/cli.ts refresh core parliament election
node src/cli.ts refresh statistics         # operator-run: fetch, then load as its own release vintage
#    Do this AFTER step 4, not before: a refresh writes new release vintages, so the content comparison above would no
#    longer be against the same inputs. A refresh contacts publishers even with --dry-run.

# 6. OWNER DECISIONS, as ADMINISTRATOR, only after the owner has read OWNER-AUTH-2026-09-20-02 in full
node tools/owner_authorization.ts          # must print "valid"
psql -v ON_ERROR_STOP=1 -f scripts/db/sync_owner_authorizations.sql
#    An entry is immutable once mirrored. This releases nothing by itself; the release gates stay closed.
```

If the hosted project allows the CLI to point `supabase test db` at it, run the database's own tests before step 1 and
again after step 4: `115_stats_table_boundary.test.sql` is the one that proves the statistics boundary holds there too,
`116_electorate_version_authority.test.sql` the one that proves the citation rule does, and every test rolls back. The
suite passes on an empty store and on a fully loaded one (section 5), so a failure there is about the hosted schema and
not about the fixtures.

Economy: the ledger families send 200 records a call and checkpoint after every page; statistics sends 5,000
observations a call and checkpoints after every call. The whole backfill is about 1,900 ledger calls and 260 statistics
calls. The 2013 meshblock history is 69 percent of all observations and answers no catalogue product: leave it out of a
first hosted load if storage is a concern (`import statistics` can be replaced by the nine other source ids).

## 7. Remaining real blockers

1. **Nothing is hosted.** Migrations are not applied to any hosted project and nothing was imported there. That is the coordinator's step, after a readiness review. Everything in section 5 is a local, disposable database.
2. **Rights and reviews are unchanged.** Every rights row is pending, every review row is pending, no security sign-off exists. The owner decision `-02` is an owner override of R8/R10 (section 4), not an approval by anyone else; it is not mirrored to any database yet.
3. **Electoral Commission pages challenge this host** (results, finance indexes, party register, nominations, electorate finder). One attempt each, never worked around. P04, P08, P09, P15, P16 and P17 therefore have a backfill and no refresh route, and the 2026 register, electorates and nominations are not loaded by any route.
4. **Beehive archive listing is challenged**; its parser has never seen the markup. P01 history rests on the export; the feed does not reach back.
5. **P02 live route waits on a person's decision** (robots.txt advisory on the versions path; index rule checked on three bills).
6. **P24 full live backfill** (about 1,900 paced requests) has never been run end to end. History rests on the export.
7. **No unattended fact refresh for P11, P12, P19, P21** and the nine release files of P22: workbooks and ZIP archives need a person's mapping review or cannot be read by the text-only fetch client.
8. **P10 dated terms are export-only** and will go stale; P15 returns are not linked to candidacies (that would be a name join); newly seen polls are not promoted to poll rows without a methodology check.
9. ~~**The 2023 candidacy capture predates the 0600 rule**~~ — **closed after the proof.** That capture sat outside the repository but was readable by group and others, so the loader reported a finding on every run rather than refusing the input; the finding is preserved in that unit's receipts in the manifest, because it was true when the proof ran. It was deliberately left alone *during* the two loads so both orders read byte-identical inputs, and tightened immediately afterwards: the capture and its directory are now owner-only, as every other private input already was. A re-run will no longer report that finding.
10. ~~**One stored column depends on load order**~~ — **closed in `1e1184c`.** `electorate_versions.evidence_version_id` used to name whichever family was loaded first. Every asserting version is now recorded and the citation is chosen from them by publisher data alone (section 2), so both load orders leave identical provenance and no source loses its lineage. This was the last difference between the two stores: all 85 tables now match.
11. **The scheduled path was not exercised here**: the Edge Function was type-checked with the family adapters in its bundle, not deployed or invoked.
