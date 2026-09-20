# Parliament family: integration instructions and receipts

Owner of this family: catalogue products **P01** (Beehive releases, historical), **P02** (bill publications),
**P05** (committee business), **P06 / P07** (committee report files and index), **P24** (written questions), and
extended coverage for **P03** (current bills) and **P10** (members: terms and roles with source-stated dates only).

State on 2026-09-20: committed locally on `feat/import-parliament-products`; **nothing pushed, no hosted write, no
deploy, no schedule activated, the shared local stack untouched**. Every figure below comes from a run that was made,
not from a plan. Where a route does not work, it says so.

## What is here

| Path | Purpose |
|---|---|
| `payload.ts` | The one place a record's allowlisted projection is built, shared by both routes so the same publisher content gives the same content hash. |
| `contracts.ts`, `pins.json` | One typed export contract per upstream product: read-only recipe, column allowlist, what is withheld upstream and why, row mapping, and the pin (checksum, bytes, rows, distinct items) of the verified export. |
| `exporter.ts` | The reproducible exporter recipe. Read-only by construction and by check. Writes private files outside the repository, mode 0600, with a manifest. |
| `import.ts` | Importer: validates the whole pinned file before any write, replays history in ordered generations, returns a source-to-destination reconciliation receipt. |
| `live/` | Five live-fetch adapters (backfill and incremental), their source configurations and proposed schedules; `live/LIVE-NOTES.md` records what each endpoint answered. |
| `registry_fragment.ts` | **The registry fragment**: `PARLIAMENT_SOURCES`, `PARLIAMENT_REGISTRY_PRODUCTS`, `PARLIAMENT_SCHEDULES`, `PARLIAMENT_ADAPTERS`, and `mergeIntoRegistry(base)`. |
| `cli.ts` | Family CLI (`validate`, `registry-sync`, `import`, `run`), so the family runs without editing the shared CLI. |
| `supabase/migrations/20260921020100_parliament_family.sql` | Typed tables, set-based projection, projector registry, reconciliation readout, route de-duplication, grants, public-projection registers. |
| `supabase/tests/110_parliament_family.test.sql` | pgTAP: 29 assertions (all 12 files, 397 assertions, pass on the isolated stack). |
| `ingest/test/parliament_family.test.ts`, `ingest/test/parliament_live_*.test.ts` | 13 + 47 offline tests. |

No shared file was edited: not `sources.config.json`, `registry.ts`, `runner.ts`, `adapters/index.ts`, `cli.ts` or `package.json`.

## Coordinator steps

1. **Migration order.** `20260921020100_parliament_family.sql` applies after `20260920001400`. It is additive, with two
   points that touch shared objects and need a look when the three families are combined:
   - `documents_document_type_check` is dropped and re-created with one more value (`committee_business`). If another
     family also extends this constraint, the later migration must carry the union of values.
   - `project_run(uuid, uuid)` is replaced by a version that runs the three core projections unchanged and then every
     function listed in the new table `evidence_private.run_projectors`. Another family should register its projector
     with one `insert` into that table (`create table if not exists` is used, so either family may come first) rather
     than replace `project_run` again. If another family does replace it, keep the loop.
2. **Shared guard change (needs a reviewer's eye).** The migration replaces `evidence_private.text_violation(text)`
   with a copy that differs in one test only: before the phone-number pattern is applied, UUIDs and 64-character
   hexadecimal digests are taken out of the text. Reason, measured on the real exports: the old test refused
   **1,380 of 187,956** written questions, 4 releases, 3 bills and 2 report files, because a publisher id or a
   SHA-256 digest held a digit run and the title held "tel", "ph", "call" or "mob". Every other test in the function
   still sees the whole text, and a phone number beside an identifier is still refused (pgTAP assertions 1 to 5).
   The other families' records carry identifiers and digests too, so they are likely to meet the same refusals.
3. **Registry.** Merge the fragment: either call `mergeIntoRegistry(file)` where the shared CLI and the Edge Function
   load `sources.config.json`, or copy the objects of `PARLIAMENT_SOURCES`, `PARLIAMENT_REGISTRY_PRODUCTS` and
   `PARLIAMENT_SCHEDULES` into that JSON file, and add `PARLIAMENT_ADAPTERS` to `LIVE_ADAPTERS`. The merged file passes
   `validateSourcesFile` with no clash (tested). The existing disabled probe `nz_parliament_written_questions` can
   then be removed: `nz_parliament_written_questions_recent` and `_backfill` replace it.
   For the Edge Function bundle the live adapters and `payload.ts` must sit under `supabase/functions/`; they import
   only `_shared` files by relative path, so moving `payload.ts` and `live/` to `_shared/adapters/parliament/` is a
   change of import prefixes and nothing else. The export importer stays CLI-only.
4. **Do not use the generic `import` command for these export sources.** Their `adapter_name` is
   `parliament_family_export`; history needs the generation replay in `import.ts`. Either dispatch on that adapter name
   in the shared CLI or keep using `node src/families/parliament/cli.ts import`.
5. **Load** (operator, after the migration is on the target and with the scoped worker login in `EVIDENCE_INGEST_DB_URL`):

   ```
   cd ingest
   export EVIDENCE_EXPORT_DIR=<private directory holding the eleven export files and manifests>
   node src/families/parliament/exporter.ts verify all          # files still match manifest and pin
   node src/families/parliament/cli.ts registry-sync
   node src/families/parliament/cli.ts import all --receipt-dir <private receipts directory>
   ```

   Exit code 2 means a product did not reconcile; its receipt says which check failed. A re-run is safe: every
   generation then reports `versions_inserted: 0`. Always let an import run through its last generation, because the
   last generation is what leaves each record pointing at its newest content.
6. **Re-making the exports** needs read access to the private upstream store. Set `EVIDENCE_UPSTREAM_QUERY_COMMAND`
   to a command that reads one query on standard input and answers on standard output through a session the store
   itself holds read-only; the exporter checks that setting first and stops if the session could write. It sends its
   own `SELECT` recipes and nothing else. `export all --write-pins` rewrites `pins.json`; a changed pin is a reviewed
   change. On 2026-09-20 four products were exported twice and gave byte-identical files.

## Exact counts: upstream store to export to destination

Exports were made on 2026-09-20 from the private upstream store through a read-only session (no upstream write of any
kind). "Observations" are upstream rows (one per content the upstream collection saw); "items" are distinct publisher
items. The destination figures are from a full load into an **isolated, disposable local stack** started from a copy
of this branch on its own ports, never the shared local stack and never a hosted project.

| Source | Product | Upstream observations / items | Export rows / items | Destination records | Destination versions | Generations | Collapsed rows | Refused | Reconciled |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| `parliament_export_releases_history` | P01 | 4,745 / 4,735 | 4,745 / 4,735 | 4,735 | 4,745 | 2 | 0 | 0 | yes |
| `parliament_export_release_attributions` | P01 | 536 / 530 | 536 / 530 | 530 | 536 | 2 | 0 | 0 | yes |
| `parliament_export_bill_publications` | P02 | 201 / 201 | 201 / 201 | 201 | 201 | 1 | 0 | 0 | yes |
| `parliament_export_current_bills_history` | P03 | 582 / 101 | 582 / 101 | 101 | 113 | 3 | 469 | 0 | yes |
| `parliament_export_bill_register` | P03 | 3,533 / 3,533 | 3,533 / 3,533 | 3,533 | 3,533 | 1 | 0 | 0 | yes |
| `parliament_export_committee_business` | P05 | 124 / 123 | 124 / 123 | 123 | 124 | 2 | 0 | 0 | yes |
| `parliament_export_committee_report_files` | P06 | 1,285 / 1,285 | 1,285 / 1,285 | 1,285 | 1,285 | 1 | 0 | 0 | yes |
| `parliament_export_committee_reports` | P07 | 1,536 / 1,286 | 1,536 / 1,286 | 1,286 | 1,286 | 1 | 250 | 0 | yes |
| `parliament_export_member_terms` | P10 | 122 / 122 | 122 / 122 | 122 | 122 | 1 | 0 | 0 | yes |
| `parliament_export_minister_roles` | P10 | 111 / 111 | 111 / 111 | 111 | 111 | 1 | 0 | 0 | yes |
| `parliament_export_written_questions` | P24 | 225,322 / 187,956 | 225,322 / 187,956 | 187,956 | 187,956 | 1 | 37,366 | 0 | yes |

Reading the table:

- For every product, export rows equal upstream observations and export items equal upstream items, counted by a
  separate upstream query (recorded in each manifest).
- **Rows replayed + collapsed rows = export rows**, for every product. A collapsed row is an upstream observation whose
  allowlisted projection is identical to the same item's previous one: upstream recorded a new version because a field
  this project does not keep had changed (its paging bookkeeping, mostly). 37,366 written-question observations, 250
  report observations and 469 current-bill observations are of that kind. They are counted, not lost: the text digests
  are part of the projection, so a changed question or reply text would have made a new version.
- The catalogue's published counts are reproduced exactly as distinct items: P01 4,735; P02 201 (115 revisions + 86
  sets); P03 101; P05 123; P06 1,285; P07 1,286; P24 187,956.
- The per-product receipts (counts, digests, run ids, statuses; no payloads, no locations) are private operator files
  beside the exports. They are not committed because run ids belong to a disposable database.

## Typed rows after the full load (isolated stack, final migration)

| Destination | Rows | Notes |
|---|---:|---|
| `written_questions` | 187,956 | all with a release date; 0 with a lodgement date and 0 with an answer date (the source states neither); 185,903 with an asker name, because 2,053 titles do not follow the publisher's usual pattern and no name is guessed; 187,956 carried a reply when collected |
| `committee_reports` | 1,286 | |
| `committee_report_files` | 1,285 | all 1,285 attached to their report by the publisher's report id, in either import order |
| `committee_business_items` | 123 | |
| `bills` from the register | 3,533 | with 15,928 dated `bill_stages` |
| `bills` from the current-index history | 101 | 113 versions kept |
| `bill_publications` / `bill_publication_sets` | 115 / 86 | 114 revisions carry a publisher version date; one revision token is not a date and is stored undated |
| `releases` | 4,735 | all with the publisher's publication time |
| `release_attributions` | 530 | |
| `parliamentary_service_terms` | 122 | 115 dated from the official file, 7 undated |
| `role_terms` | 111 | all undated |
| `route_coverage`, family `bill` | 3,634 records, **3,539 distinct bills** | 95 bills are on both routes; 6 current bills were introduced after the register was collected |

Ledger refusals: 0. Tombstones: 0. A replay of three products on the loaded database inserted 0 versions. Anonymous
readers saw 0 rows of the new tables: the release gates stay closed and every rights row stays pending.

## Cross-route check made against the publisher

On 2026-09-20 the live committee-business adapter was run through the project's fetch guard as a dry run (4 requests,
all HTTP 200, a complete snapshot of 3 pages) and compared with the export route: **123 items live, 123 in the export,
123 in both, 123 with an identical content hash**, none on one route only. The two routes build the same record from
the same publisher content. The publisher's own count of written questions for the 54th Parliament that day
(187,956) equals the export's distinct items; its count of committee reports (1,286) equals the export's.

## Dates: what is stored and what is not

- `retrieved_at` / `first_retrieved_at` is the **upstream collection time** of an export row, or the fetch time of a
  live row. It is never written into `source_published_at` and is not part of the hashed content.
- `source_published_at` is set only from a date the publisher states: a release's publication time, a question's
  release date, a report's publication date, a bill's introduction date, a bill revision's version date. Member terms,
  ministerial roles, publication sets and release attributions state no such date and have none.
- Written questions: the source gives a **release date** and a **modification time**. It gives no lodgement date and no
  answer date, so `lodged_on` and `answered_on` stay null; `answer_status` follows whether a reply was present when the
  record was collected.
- P10: 115 of 122 terms carry the start date stated in Parliament's open-data member-terms file (`basis =
  official_event`, `date_precision = day`). The other 7 came from a file that states no dates and are stored undated
  (`observed_in_directory`, `unknown`). All 111 ministerial roles are undated: minister pages state no appointment
  date. Nothing is inferred from an election date or from a collection time.

## Route de-duplication

A product can be reached by more than one route. Each route keeps its own `source_id`, records and history; nothing
is merged and **no existing source is written to** (`nz_government_releases_feed`, `nz_parliament_current_bills` and
`nz_parliament_mp_directory` are untouched). `evidence_private.record_route_keys` holds the publisher's own identity
of each item (its id; for releases its official link), and `evidence_views.route_coverage` counts items once.

- P01: the feed and the 4,735-release export overlap on the newest releases; the 530 attribution items overlap the
  export on 525. Quote `distinct_items`, never the sum.
- P03: the 101 bills of the current index are among the 3,533 of the register, and are the same bills the live source
  collects. One family, `bill`, keyed by publisher bill id.
- P06 and P07: a report file is not a second report. Files are rows of `committee_report_files` attached to their
  report by the publisher's report id; only reports are `documents`.
- P24: the export and the two live question sources share the publisher's question id.
- Known limit: the upstream current-bills collection did not keep the select-committee field, so for the same bill the
  export route and the live route can produce different content hashes. That shows as one more version on a different
  source, never as a double count.

## What is not imported, by design

Question and reply text, report text, bill text, release text, publisher summaries, file names, members' contact
details, upstream stored-copy locations, upstream copies of publisher responses. For texts, a SHA-256 and a character
count computed inside the upstream store travel instead, so a later change is visible without the text being held.
None of these ever reached the export files, and the exporter refuses a file that carries a column outside the contract.

## Remaining real blockers

1. **Beehive releases listing (P01 live backfill) is blocked.** On 2026-09-20 the public listing answered the
   project's client with a firewall challenge. One attempt, not retried, not worked around. The listing markup has
   never been observed, so that parser is unverified and the source is disabled. P01 history therefore rests on the
   export route; the existing feed remains the only working live route, and it does not reach back.
2. **P02 live route is disabled pending a person's decision**: the legislation website's robots.txt disallows the
   versions-index path (an advisory under the owner's collection policy, recorded with every run), and the rule used to
   find a bill's versions index was checked on three bills only. The catalogue's four known upstream retrieval gaps in
   P02 are not filled by the export.
3. **P24 live backfill has not been run end to end** (about 1,900 paced requests, over an hour). The adapter was
   exercised against the publisher for 100 records through the runner, and the publisher's own count for the 54th
   Parliament on 2026-09-20 was 187,956, equal to the export. The incremental route re-reads two months; it has not
   yet run on a schedule.
4. **Committee business page links**: the search endpoint gives no page address and the site is client-rendered, so
   the default public path is used for every item type without a person having checked it.
5. **P10 live route for terms and roles does not exist.** The dated terms come from an open-data file whose address
   changes with each edition; no stable machine-readable route was established, so P10's dated coverage is
   export-only and is as of the file edition upstream collected (24 November 2025) and minister pages read on
   12 September 2026. It will go stale.
6. **Hosted load not done.** Migrations have not been applied to any hosted project and nothing was imported there;
   that is the coordinator's step after integration. Rights rows for every source here remain `pending`: importing
   changes nothing about what anonymous readers may see.
7. **Generated explorer types are committed for this migration alone.** `web/src/lib/database.types.ts` was
   regenerated from the isolated stack (197 added lines, nothing removed); the explorer typechecks and its 41 unit
   tests pass. Once the three families' migrations are combined it must be regenerated again
   (`npm run types:generate`), or `types:check` fails. The explorer's end-to-end tests were not run.
