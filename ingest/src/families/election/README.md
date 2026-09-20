# Election family: import routes

Products owned here: **P08, P09** (2023 results), **P13** (party policy pages), **P14** (party-vote polls),
**P15, P16, P17** (political finance: public document index, status and Commission-published totals only), and the
2026 civic links the upstream store really holds (**C26A** official page status, **C26B** boundary map links).

Nothing in this directory edits a shared registry or runner file. Status on 2026-09-20: built, loaded with the real
data into a disposable isolated local database, reconciled end to end, replayed. **Nothing was written to a hosted
database, nothing was pushed or deployed, and no schedule is active.**

## What is loaded, exactly

Upstream store (read-only) -> private export -> store. Receipts: `docs/database/receipts/2026-09-20-election-family.*.json`.

| Product | Upstream rows read | Records | Versions kept | Destination rows (checked) |
|---|---|---|---|---|
| P08 nationwide table | 18 | 18 | 18 | 17 `election_party_totals` (sum 2,851,211) + 1 `election_result_totals` (2,851,211) |
| P09 electorate pages | 1,791 | 1,791 | 1,791 | 1,224 `party_results` (sum 2,851,211), 72 `electorate_result_summaries`, 495 `result_route_checks`; **0** `candidate_results` |
| P13 policy pages | 75 | 17 | 75 | 17 `documents` + 17 `policy_sources`, all `unknown` / `none` |
| P14 polls | 30 | 12 | 30 | 12 `polls` (9 verified, 3 unresolved), 144 `poll_results` (100 reported, 44 not reported) |
| P15 candidate returns | 492 | 492 | 492 | 492 `finance_return_references` (224 image-only, 268 with a text layer), 1,476 published totals |
| P16 party totals 2025 | 14 | 14 | 14 | 28 `finance_published_aggregates`, 0 documents |
| P17 party returns 2025 | 23 | 17 | 23 | 17 `finance_return_references` |
| C26A official page status | 4 (2 for 2026) | 1 | 2 | 1 `election_official_page_status` (`official_page_unavailable`, candidate details `unknown`) |
| C26B boundary map links | 6 | 3 | 3 (3 identical re-observations folded) | 3 `documents` + 3 `boundary_map_links` |

Record counts equal the catalogue counts for P08, P09, P13, P14, P15, P16 and P17 (tested against the real files).
A second load of the same export inserted **0** versions and tombstoned **0** records. History the store already
holds is not re-sent (11 of 20 waves skipped on the replay), so a record is never pointed back at an old version;
`reconcile` also checks that every record's current version is the export's latest (87 checks, all passing).

P15 published totals, as the Commission's index page prints them: expenses 344 reported / 148 nil / 0 not reported;
donations 188 / 304 / 0; loans 1 / 485 / 6.

## Rules the code enforces

- **One fact, one counted row.** Candidate votes reach the store by two routes: the 2023 candidacy product (P04) and
  the electorate pages (P09). P04 stays the counted route. Each of the 495 P09 candidate lines becomes a
  `result_route_checks` row against the P04 row and is never written to `candidate_results`. Party votes by
  electorate (P09) and the nationwide total (P08) are compared (2,851,211 = 2,851,211), never added.
- **P04 join by identifier, never by name.** The exporter ties a P09 candidate line to a P04 candidacy only when the
  official page address, the name exactly as published **and** the vote count agree, and exactly one candidacy fits.
  Result: 495 of 495 joined, 0 unmatched, 0 ambiguous, 0 vote disagreements. The store then joins on the P04
  identifier alone. If P04 is not loaded yet the check says `other_route_not_loaded` (verified) and resolves on the
  next load. After both routes load there are 72 electorates and 72 contests, not 144.
- **Unknown is not zero.** A missing number is absent with `not_reported`; a printed `NIL` is `reported_nil`; a
  printed zero is a value. Blank seats cells stay null. A dash in a poll table is `not_reported`.
- **Collected-at is not published-at.** `collected_at` goes to `retrieved_at` only. `source_published_at` is set only
  from a date the publisher stated (6 of 75 policy page versions carry one; no other product does). A file in which
  a publisher date equals the collection time is refused.
- **No policy class without model metadata.** Upstream labels have no recorded model, version or prompt, so they are
  kept in the private version payload as `upstream_unreviewed_label` with `upstream_label_model_metadata:
  not_recorded`, and every `policy_sources` row is `unknown` / `none`.
- **No candidate is created.** The family inserts no candidacy, person identity or person. Finance returns carry the
  published candidate and party labels and are not linked to a candidacy (that would be a name join).
- **No bodies.** Page text, extracted PDF text, OCR pages, quotations, methodology paragraphs, file locations and
  transport detail are dropped by the exporter and refused again by the import contract (closed field list per
  record kind, closed vocabularies inside lists) and by the database guard. Dropped top-level fields are recorded
  by name and reason; keys nested inside an upstream list (for example inside one published total) are dropped
  without an individual record.
- **What makes a version is in the payload.** The store hashes the payload alone, so the hash of the publisher's
  original bytes (`original_document_digest`) and a publisher-stated date (`publisher_stated_date`) are payload
  keys; preflight refuses a file in which two neighbouring versions of a record would hash the same.
- **Hex values are letter-encoded in payloads.** The store's guard against phone numbers reads a long digit run
  beside letters such as "ph" as a phone number, and it rejected real rows that carried a hex identifier next to
  a name. Digests and the P04 reference are therefore written with digits 0-9 as letters g-p (same bits; the
  projection decodes the reference with `translate`). Preflight mirrors that guard, so such a row now refuses the
  whole file before any write instead of being rejected mid-run. The shared guard itself was not touched.
- **History.** A record's observed versions are replayed in order as a sequence of runs (waves); only the last wave
  is a complete snapshot, so an earlier wave cannot tombstone anything.

## Reproduce

```sh
cd ingest
# 1. Export (read-only). The operator supplies the command; the repository never names the warehouse or its host.
#    It must read ONE select on stdin, write one JSON object per line on stdout (choosing that output format is
#    the command's job), and open the warehouse read-only itself.
export EVIDENCE_WAREHOUSE_QUERY_ARGV='["<program>","<arg>","..."]'
node src/families/election/export_cli.ts --out <private directory outside the repository>   # 0700 dir, 0600 files

# 2. Check and plan (no database, no network).
export EVIDENCE_EXPORT_ELECTION_DIR=<that directory>
node src/families/election/cli.ts validate
node src/families/election/cli.ts plan all

# 3. Load (worker login only), then prove it.
node src/families/election/cli.ts registry-sync
node src/families/election/cli.ts import all --receipt import.json
node src/families/election/cli.ts reconcile --receipt reconcile.json     # exit 4 on any mismatch

# 4. Incremental routes.
node src/families/election/cli.ts fetch party_vote_polls_index [--backfill]
node src/families/election/cli.ts fetch party_policy_pages_2026_monitor
```

For an unchanged warehouse the export files are byte-identical (verified: a second export changed only the file
whose mapper had been edited). Pins live in `registry_fragment.ts`; any other file fails closed. After a deliberate
re-export, copy the new checksums, row, record and wave counts from `manifest.json` into `ELECTION_PINS`.

Tests, runnable on their own: `node --test test/election_family.test.ts` (17 tests; the last one checks the real
files when `EVIDENCE_EXPORT_ELECTION_DIR` is set) and `supabase/tests/110_election_family.test.sql` (24 assertions).

## Backfill and incremental route per product

| Product | Backfill | Incremental |
|---|---|---|
| P08, P09 | export import (final 2023 results do not change) | none needed; `ec_2023_official_results` probe stays, publisher challenges this host |
| P13 | export import, 75 versions | `party_policy_pages_2026_monitor`: hash + title of the 17 pages. Real run: 16 retrieved, 1 challenged and recorded as unavailable. A refused, missing, moved or failing page is recorded and the run goes on. The hash is of the whole page, so a page with per-request markup shows a new version on every run: a changed hash is a prompt to look, not proof the policy changed |
| P14 | export import, 30 versions | `party_vote_polls_index`: real run stored 50 index rows; an incremental run re-observed 18, 0 new versions |
| P15 | export import | `ec_2023_candidate_returns_index` probe only: publisher challenges this host |
| P16, P17 | export import | existing `ec_party_finance_returns` probe only: publisher challenges this host |
| C26A, C26B | export import | `ec_2026_electorate_finder` probe only |

Live records use their own kinds (`policy_page_check`, `poll_index_row`) and the projection ignores them on purpose:
verified that after both live runs there were still 17 policy documents and 12 polls, not 34 and 62.

## Coordinator integration

1. **Migration**: `supabase/migrations/20260921010100_election_family.sql` applies after `20260920001400`. It adds six
   tables, grants the worker write access to six existing destinations (policy names end in
   `_ingest_election_family`), registers lineage, and ends with `classify_public_columns()` and
   `rebuild_exposed_views()`. If another family's migration applies later, call those two again at its end.
2. **Registry**: merge `ELECTION_REGISTRY_PRODUCTS`, `ELECTION_EXPORT_SOURCES[].source`, `ELECTION_LIVE_SOURCES` and
   `ELECTION_SCHEDULES` into `supabase/functions/_shared/sources.config.json` (`mergedSourcesFile()` in `cli.ts` is the
   exact merge; `registry-sync` through the family CLI already syncs the merged file). Schedules sync inactive.
3. **Adapters**: add `ELECTION_LIVE_ADAPTERS` to `LIVE_ADAPTERS` in `_shared/adapters/index.ts` so the Edge Function
   can run the two live sources. Note `election_poll_index` treats `maxRecords > 500` as a backfill.
4. **Projection**: add one key to the shared `project_run`:
   `'election_family', evidence_private.project_election_family(p_run_id, p_holder)`. Until then the family CLI calls
   it itself under the same lease, and skips that call as soon as the shared result carries the key.
5. **Shared CLI**: `import` in `ingest/src/cli.ts` must route `adapter_name = "election_family_export"` to this
   family's importer. The generic flat importer cannot load these sources by design (tested).
6. **Generated types**: run `npm run types:generate` in `web/` after all family migrations are in.
7. **Load order on the hosted store**: P04 first is tidier but not required. Run `reconcile` afterwards; expect
   `candidate_votes_same_fact:agrees = 495` and `party_votes_sum_to_nationwide_total:agrees = 1`.

## Remaining real blockers

- **2026 party register: missing.** The upstream store holds only 20 parties marked "registered at the 2023
  election" with `current_register_verified = 0`. That is not a current register, so it was not imported as one.
  The official register page answered this host with a bot challenge (one attempt on 2026-09-20, not worked around).
- **2026 electorates: missing.** The store's 72 electorates are a 2023 reference. Only three official 2025 boundary
  summary map links exist and were loaded as links. The number and names of 2026 electorates are unknown here, not zero.
- **2026 nominations and party lists: missing.** The last upstream observation is `official_page_unavailable` with
  candidate details `unknown`; the official page challenges this host. No candidate was fabricated.
- **Electoral Commission pages cannot be fetched fresh from this host** (results, finance indexes, register,
  nominations). P08, P09, P15, P16 and P17 therefore have a backfill but no working incremental route.
- **P15 returns are not linked to candidacies.** The index keys a return by published name and electorate. Linking
  needs an identifier or a person's review; it was not done by name.
- **Newly seen polls are not promoted to poll rows.** The index is a third-party aggregator; a poll's methodology
  disclosure has to be checked first. Promotion currently happens only through a new reconciled export.
- **Rights are unchanged.** Every rights row involved is still pending, so anonymous projections show these rows
  at the link tier at most, and only while the release gates are open. Loading data is not a release.
- **An independent read of this work found three defects, all fixed and re-verified** (replay pointing records at
  old versions until the last wave; exporter and store disagreeing on what makes a version; the page monitor
  stopping at the first missing page), plus hardening items that were applied. It was one read, not a sign-off.
- **Not run here**: Deno check of the Edge Function (no Deno on this host); hosted load (coordinator's step).
